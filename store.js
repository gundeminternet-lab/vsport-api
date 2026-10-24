// Firestore veri katmanı (Admin SDK). Hem Cloud Functions (index.js) hem bağımsız HTTP sunucusu (server.js) kullanır.
// db: getFirestore() sonucu, FieldValue: firebase-admin/firestore'dan.

import { AppError } from './logic.js';

export function createStore(db, FieldValue) {
  const store = {
    async getContent(key) {
      const s = await db.doc(`match_content/${key}`).get();
      return s.exists ? s.data() : null;
    },
    async saveContent(key, content) {
      const ref = db.doc(`match_content/${key}`);
      try {
        await ref.create(content);
        return content;
      } catch (e) {
        // Aynı anda başka bir istek oluşturduysa onunkini kullan (herkes aynı içeriği görsün).
        if (e.code === 6 /* ALREADY_EXISTS */) {
          const s = await ref.get();
          if (s.exists && s.data().version === content.version) return s.data();
          await ref.set(content);
          return content;
        }
        throw e;
      }
    },
    // ---- Canlı bildirim takibi (watched/{matchKey}) ----
    async listWatched(from, to) {
      const q = await db.collection('watched').where('kickoffAt', '>=', from).where('kickoffAt', '<=', to).limit(300).get();
      return q.docs.map((d) => ({ key: d.id, league: d.get('league'), eventId: String(d.get('eventId') ?? ''), state: d.get('state') ?? null }));
    },
    async saveWatchState(key, state) {
      await db.doc(`watched/${key}`).update({ state, checkedAt: FieldValue.serverTimestamp() });
    },
    // Maçın editör yorumları: eski tekli belge (editor_comments/{key}) + editör başına belgeler ({key}_{uid}).
    async getEditorComment(key) {
      const [legacy, q] = await Promise.all([
        db.doc(`editor_comments/${key}`).get(),
        db.collection('editor_comments').where('matchKey', '==', key).limit(10).get(),
      ]);
      const parts = [];
      if (legacy.exists && legacy.get('text')) parts.push({ name: legacy.get('editorName'), text: legacy.get('text') });
      for (const d of q.docs) if (d.get('text')) parts.push({ name: d.get('editorName'), text: d.get('text') });
      if (!parts.length) return null;
      if (parts.length === 1) return parts[0].text;
      return parts.map((p) => `${p.name ?? 'Editör'}: ${p.text}`).join('\n\n');
    },
    async getTokens(uid) {
      const s = await db.doc(`users/${uid}`).get();
      return s.exists ? (s.data().tokens ?? 0) : 0;
    },
    async hasUnlock(uid, key, type) {
      return (await db.doc(`users/${uid}/unlocks/${key}_${type}`).get()).exists;
    },
    async hasUnlockId(uid, unlockId) {
      return (await db.doc(`users/${uid}/unlocks/${unlockId}`).get()).exists;
    },
    // ---- Özel Yorum (match_special/{key}): başlıklar maç başına bir kez üretilir ve eklenir ----
    async getSpecial(key) {
      const s = await db.doc(`match_special/${key}`).get();
      return s.exists ? s.data() : null;
    },
    async saveSpecial(key, patch) {
      // topics alanı iç içe birleştirilir: aynı anda iki başlık üretilirse biri diğerini silmez.
      await db.doc(`match_special/${key}`).set(patch, { merge: true });
    },
    // Birden çok kilidi tek işlemde aç: eksik olanlar için priceFor(eksikSayısı) kadar düşer.
    async purchaseBundle({ uid, items, priceFor }) {
      return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const refs = items.map((i) => db.doc(`users/${uid}/unlocks/${i.unlockId}`));
        const [user, ...unlocks] = await Promise.all([tx.get(userRef), ...refs.map((r) => tx.get(r))]);
        if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
        const tokens = user.data().tokens ?? 0;
        const missing = items.filter((_, i) => !unlocks[i].exists);
        if (!missing.length) return { charged: false, balance: tokens };
        const price = priceFor(missing.length);
        if (tokens < price) throw new AppError('failed-precondition', `Yetersiz token: ${tokens} var, ${price} gerekli.`);
        if (price > 0) tx.update(userRef, { tokens: FieldValue.increment(-price) });
        for (const it of missing) {
          tx.set(db.doc(`users/${uid}/unlocks/${it.unlockId}`), { ...it.record, price: price / missing.length, at: FieldValue.serverTimestamp() });
        }
        if (price > 0) {
          tx.create(db.collection(`users/${uid}/token_ledger`).doc(), {
            delta: -price,
            reason: 'unlock_special',
            key: missing.map((m) => m.unlockId).join(','),
            at: FieldValue.serverTimestamp(),
          });
        }
        return { charged: price > 0, balance: tokens - price };
      });
    },
    // ---- Abonelik ve Asistan kullanımı ----
    async getSubscription(uid) {
      const s = await db.doc(`users/${uid}`).get();
      return s.exists ? (s.get('subscription') ?? null) : null;
    },
    async getAssistantUsage(uid, dayKey) {
      const s = await db.doc(`users/${uid}/assistant_usage/${dayKey}`).get();
      return s.exists ? (s.get('count') ?? 0) : 0;
    },
    // Günlük kullanım sayacı (yalnızca sunucu yazar). Limit aşılırsa false döner, sayaç artmaz.
    async bumpAssistantUsage(uid, dayKey, limit) {
      const ref = db.doc(`users/${uid}/assistant_usage/${dayKey}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const n = s.exists ? (s.get('count') ?? 0) : 0;
        if (n >= limit) return { ok: false, used: n };
        tx.set(ref, { count: n + 1, at: FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true, used: n + 1 };
      });
    },
    async getCoupon(id) {
      const s = await db.doc(`coupons/${id}`).get();
      return s.exists ? s.data() : null;
    },
    // Tek işlemde: kilit zaten varsa ücret alınmaz; bakiye yetmezse hata; yoksa düş + kilit + hareket kaydı.
    async purchase({ uid, unlockId, price, record }) {
      return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const unlockRef = db.doc(`users/${uid}/unlocks/${unlockId}`);
        const [user, unlock] = await Promise.all([tx.get(userRef), tx.get(unlockRef)]);
        if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
        const tokens = user.data().tokens ?? 0;
        if (unlock.exists) return { charged: false, balance: tokens };
        if (tokens < price) throw new AppError('failed-precondition', `Yetersiz token: ${tokens} var, ${price} gerekli.`);
        if (price > 0) tx.update(userRef, { tokens: FieldValue.increment(-price) });
        tx.set(unlockRef, { ...record, price, at: FieldValue.serverTimestamp() });
        if (price > 0) {
          tx.create(db.collection(`users/${uid}/token_ledger`).doc(), {
            delta: -price,
            reason: `unlock_${record.type ?? 'item'}`,
            key: unlockId,
            at: FieldValue.serverTimestamp(),
          });
        }
        return { charged: price > 0, balance: tokens - price };
      });
    },
  };
  
  return store;
}
