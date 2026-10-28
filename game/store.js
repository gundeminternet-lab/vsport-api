// Oyun verisi (Firestore). İstemci kuralları: profil, kartlar ve kadrolar yalnızca sahibince okunur; puan tabloları
// herkese açık; hiçbiri istemciden yazılamaz (firestore.rules).
//
//   game_profiles/{uid}                      { credits, earnedTotal, username, photoURL, pro, bonus: { step, lastDay },
//                                              welcomeDone, region, duels: [son 10], lastSeenDay, createdAt }
//   game_profiles/{uid}/cards/{cardId}       kart (havuzdaki kompakt oyuncu + pid, tier, at)
//   game_profiles/{uid}/squads/{squadId}     { name, formation, slots, chemistry, rating, power, updatedAt }
//   game_profiles/{uid}/daily/{gün}          { bonus, photo: {...}, quiz: { plays, correct, best }, duels, packs, freePack, claimed }
//   game_daily/{gün}                         { photo: { pid } }   günün oyuncusu (herkes için aynı)
//   credit_boards/{dönem}/entries/{uid}      { earned, username, usernameLower, photoURL, pro, updatedAt }
//   photo_boards/{gün}/entries/{uid}         { ms, attempts, username, photoURL }
//   quiz_boards/{gün}/entries/{uid}          { best, username, photoURL }
//   duel_pool/{uid}                          { username, name, formation, rating, chemistry, power, lineup }
//   game_pool/{lig}                          oyuncu havuzu (pool.js)

import { AppError } from '../errors.js';

export function createGameStore(db, FieldValue) {
  const prof = (uid) => db.doc(`game_profiles/${uid}`);
  const boardEntry = (pid, uid) => db.doc(`credit_boards/${pid}/entries/${uid}`);

  return {
    async getUser(uid) {
      const s = await db.doc(`users/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async getProfile(uid) {
      const s = await prof(uid).get();
      return s.exists ? s.data() : null;
    },
    async createProfile(uid, data) {
      try {
        await prof(uid).create({ ...data, createdAt: FieldValue.serverTimestamp() });
      } catch (e) {
        if (e.code !== 6) throw e; // zaten var
      }
      return (await prof(uid).get()).data();
    },
    async updateProfile(uid, patch) {
      await prof(uid).set(patch, { merge: true });
    },
    /**
     * Krediyi atomik değiştirir. delta < 0 ve bakiye yetmezse hata. Kazanılan kredi (delta > 0, earn) puan tablolarına
     * işlenir. Döner: yeni bakiye.
     */
    async changeCredits(uid, delta, { periods = [], user = {}, earn = true } = {}) {
      const balance = await db.runTransaction(async (tx) => {
        const s = await tx.get(prof(uid));
        const cur = Number(s.get('credits') ?? 0);
        if (cur + delta < 0) throw new AppError('failed-precondition', 'Yetersiz kredi.');
        tx.set(prof(uid), { credits: cur + delta, ...(delta > 0 && earn ? { earnedTotal: FieldValue.increment(delta) } : {}) }, { merge: true });
        return cur + delta;
      });
      if (delta > 0 && earn) {
        const entry = {
          earned: FieldValue.increment(delta),
          username: user.username ?? null,
          usernameLower: user.username ? String(user.username).toLowerCase() : null,
          photoURL: user.photoURL ?? null,
          pro: user.pro === true,
          updatedAt: FieldValue.serverTimestamp(),
        };
        await Promise.all(periods.map((p) => boardEntry(p, uid).set(entry, { merge: true })));
      }
      return balance;
    },
    /** Kredi harcayıp kartları ekler (tek işlem). cost 0 olabilir. Döner: { balance, ids }. */
    async purchase(uid, cost, cards) {
      return db.runTransaction(async (tx) => {
        const s = await tx.get(prof(uid));
        const cur = Number(s.get('credits') ?? 0);
        if (cur < cost) throw new AppError('failed-precondition', 'Yetersiz kredi.');
        if (cost) tx.set(prof(uid), { credits: cur - cost }, { merge: true });
        const ids = [];
        for (const c of cards) {
          const ref = prof(uid).collection('cards').doc();
          ids.push(ref.id);
          tx.set(ref, { ...c, at: FieldValue.serverTimestamp() });
        }
        return { balance: cur - cost, ids };
      });
    },
    async getDaily(uid, day) {
      const s = await prof(uid).collection('daily').doc(day).get();
      return s.exists ? s.data() : null;
    },
    async updateDaily(uid, day, patch) {
      await prof(uid).collection('daily').doc(day).set(patch, { merge: true });
    },
    async incrementDaily(uid, day, field, by = 1) {
      // field "quiz.correct" gibi iç içe olabilir: set + merge ile iç içe harita kurulur
      const parts = field.split('.');
      const obj = {};
      let cur = obj;
      parts.forEach((k, i) => {
        if (i === parts.length - 1) cur[k] = FieldValue.increment(by);
        else cur = cur[k] = {};
      });
      await prof(uid).collection('daily').doc(day).set(obj, { merge: true });
    },
    async listCards(uid) {
      const q = await prof(uid).collection('cards').limit(1000).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async deleteCards(uid, ids) {
      const batch = db.batch();
      for (const id of ids) batch.delete(prof(uid).collection('cards').doc(id));
      await batch.commit();
    },
    async listSquads(uid) {
      const q = await prof(uid).collection('squads').limit(10).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async saveSquad(uid, id, data) {
      const ref = id ? prof(uid).collection('squads').doc(id) : prof(uid).collection('squads').doc();
      await ref.set({ ...data, updatedAt: FieldValue.serverTimestamp() });
      return ref.id;
    },
    async deleteSquad(uid, id) {
      await prof(uid).collection('squads').doc(id).delete();
    },
    async getDay(day) {
      const s = await db.doc(`game_daily/${day}`).get();
      return s.exists ? s.data() : null;
    },
    async setDay(day, data) {
      await db.doc(`game_daily/${day}`).set(data, { merge: true });
    },
    async boardTop(pid, limit = 50) {
      const q = await db.collection(`credit_boards/${pid}/entries`).orderBy('earned', 'desc').limit(limit).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async boardEntry(pid, uid) {
      const s = await boardEntry(pid, uid).get();
      return s.exists ? { uid, ...s.data() } : null;
    },
    async boardRank(pid, earned) {
      const c = await db.collection(`credit_boards/${pid}/entries`).where('earned', '>', earned).count().get();
      return c.data().count + 1;
    },
    async boardSearch(prefix, limit = 10) {
      const p = String(prefix).toLowerCase();
      const q = await db
        .collection('credit_boards/all/entries')
        .where('usernameLower', '>=', p)
        .where('usernameLower', '<', `${p}`)
        .limit(limit)
        .get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async upsertDuelPool(uid, summary) {
      await db.doc(`duel_pool/${uid}`).set({ ...summary, updatedAt: FieldValue.serverTimestamp() });
    },
    async deleteDuelPool(uid) {
      await db.doc(`duel_pool/${uid}`).delete();
    },
    async queryDuelPool(min, max, limit = 20) {
      const q = await db.collection('duel_pool').where('power', '>=', min).where('power', '<=', max).limit(limit).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async addPhotoScore(day, uid, entry) {
      await db.doc(`photo_boards/${day}/entries/${uid}`).set({ ...entry, at: FieldValue.serverTimestamp() });
    },
    async topPhoto(day, limit = 20) {
      const q = await db.collection(`photo_boards/${day}/entries`).orderBy('ms').limit(limit).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async addQuizScore(day, uid, entry) {
      const ref = db.doc(`quiz_boards/${day}/entries/${uid}`);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists && Number(s.get('best') ?? 0) >= entry.best) return;
        tx.set(ref, { ...entry, at: FieldValue.serverTimestamp() });
      });
    },
    async topQuiz(day, limit = 20) {
      const q = await db.collection(`quiz_boards/${day}/entries`).orderBy('best', 'desc').limit(limit).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async getPool(league) {
      const s = await db.doc(`game_pool/${league.replace(/\./g, '_')}`).get();
      return s.exists ? s.data() : null;
    },
    async savePool(league, doc) {
      await db.doc(`game_pool/${league.replace(/\./g, '_')}`).set(doc);
    },
  };
}
