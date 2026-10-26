// Firestore veri katmanı (Admin SDK). Hem Cloud Functions (index.js) hem bağımsız HTTP sunucusu (server.js) kullanır.
// db: getFirestore() sonucu, FieldValue: firebase-admin/firestore'dan.

import { AppError } from './errors.js';
import { takeCredit, countCredits } from './wheel.js';

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
    // ---- Erişim: abonelik ve deneme hakkı (yalnızca sunucu yazar) ----
    async getAccess(uid) {
      const s = await db.doc(`users/${uid}`).get();
      if (!s.exists) return { subscription: null, trialUsed: 0, wheel: null };
      return { subscription: s.get('subscription') ?? null, trialUsed: Number(s.get('trialUsed') ?? 0), wheel: s.get('wheel') ?? null };
    },
    // ---- Günlük çark (users/{uid}.wheel; wheel.js) ----
    // Bugün çevrildiyse hata; değilse apply(önceki) tek işlemde yazılır.
    async spinWheel({ uid, day, apply }) {
      const userRef = db.doc(`users/${uid}`);
      return db.runTransaction(async (tx) => {
        const user = await tx.get(userRef);
        if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
        const prev = user.get('wheel') ?? null;
        if (prev?.day === day) throw new AppError('failed-precondition', 'Bugünkü çark hakkını kullandın. Yeni hak gece 00:00\'da.');
        const wheel = apply(prev);
        tx.update(userRef, { wheel });
        return { wheel };
      });
    },
    // Çark hakkı: tek işlemde hak düşülür + kilit kaydı yazılır. Kilit zaten varsa hak harcanmaz.
    async useWheelCredit({ uid, prize, unlockId, record, now }) {
      return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const unlockRef = db.doc(`users/${uid}/unlocks/${unlockId}`);
        const [user, unlock] = await Promise.all([tx.get(userRef), tx.get(unlockRef)]);
        if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
        const prev = user.get('wheel') ?? null;
        if (unlock.exists) return { used: false, left: countCredits(prev, prize, now) };
        const taken = takeCredit(prev, prize, now);
        if (!taken) throw new AppError('subscription-required', 'Bu çark ödülü hakkın yok ya da süresi doldu.');
        tx.update(userRef, { wheel: taken.wheel });
        tx.set(unlockRef, { ...record, at: FieldValue.serverTimestamp() });
        return { used: true, left: countCredits(taken.wheel, prize, now) };
      });
    },
    async setSubscription(uid, subscription) {
      await db.doc(`users/${uid}`).set({ subscription }, { merge: true });
    },
    // Abonenin açtığı içerik: geçmiş için kilit kaydı (ücret yok). Zaten varsa dokunulmaz.
    async recordUnlock({ uid, unlockId, record }) {
      const ref = db.doc(`users/${uid}/unlocks/${unlockId}`);
      try {
        await ref.create({ ...record, at: FieldValue.serverTimestamp() });
        return { created: true };
      } catch (e) {
        if (e.code === 6 /* ALREADY_EXISTS */) return { created: false };
        throw e;
      }
    },
    // Deneme hakkı: tek işlemde sayaç kontrolü + artış + kilit kaydı. Kilit zaten varsa hak harcanmaz.
    async useTrial({ uid, unlockId, record, limit }) {
      return db.runTransaction(async (tx) => {
        const userRef = db.doc(`users/${uid}`);
        const unlockRef = db.doc(`users/${uid}/unlocks/${unlockId}`);
        const [user, unlock] = await Promise.all([tx.get(userRef), tx.get(unlockRef)]);
        if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
        const used = Number(user.get('trialUsed') ?? 0);
        if (unlock.exists) return { used: false, trialLeft: Math.max(0, limit - used) };
        if (used >= limit) throw new AppError('subscription-required', 'Ücretsiz deneme hakların bitti. Devam etmek için abone olabilirsin.');
        tx.update(userRef, { trialUsed: FieldValue.increment(1) });
        tx.set(unlockRef, { ...record, at: FieldValue.serverTimestamp() });
        return { used: true, trialLeft: Math.max(0, limit - used - 1) };
      });
    },
    // ---- Google Play abonelikleri: satın alma belgesi (purchaseToken) yalnızca sunucuda tutulur ----
    // play_tokens/{sha256(token)} → { uid, token, productId }. Aynı satın alma iki hesaba bağlanamaz.
    async linkPlayToken({ hash, uid, token, productId }) {
      const ref = db.doc(`play_tokens/${hash}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists && s.get('uid') !== uid) return { ok: false, owner: s.get('uid') };
        tx.set(ref, { uid, token, productId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        tx.set(db.doc(`billing/${uid}`), { tokenHash: hash, productId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { ok: true };
      });
    },
    async getPlayToken(hash) {
      const s = await db.doc(`play_tokens/${hash}`).get();
      return s.exists ? s.data() : null;
    },
    async getBilling(uid) {
      const s = await db.doc(`billing/${uid}`).get();
      return s.exists ? s.data() : null;
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
  };
  
  return store;
}
