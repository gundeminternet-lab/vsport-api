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
    async getEditorComment(key) {
      const s = await db.doc(`editor_comments/${key}`).get();
      return s.exists ? (s.data().text ?? null) : null;
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
