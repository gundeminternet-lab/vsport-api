// Hesap silme (Google Play zorunluluğu: uygulama içinden hesap silinebilmeli).
//
// Silinenler: kullanıcı belgesi ve bütün alt koleksiyonları (favoriler, takipler, kilitler, token geçmişi, asistan
// kullanımı), kullanıcı adı kaydı, destek konuşması, istatistikler, sıralama girişleri, maç yorumları ve sohbet
// mesajları; en son Firebase Authentication hesabı.
// Kalanlar: maç tahmin/oy belgeleri (yalnızca kullanıcı kimliğiyle anahtarlıdır, kişisel bilgi içermez; hesap silinince
// sahipsiz kalır). Satın alma kayıtları kullanıcı belgesinin altında olduğu için onlar da silinir.
//
// Yardımcı adımlar (yorum, sohbet, sıralama...) hata verirse kaydedilir ve atlanır; asıl kayıt ve giriş hesabı yine silinir.
// Yorum ve sohbet silme, Firestore'da "comments.uid" ve "messages.uid" için koleksiyon grubu dizini ister (README).

import { AppError } from './logic.js';

export const DELETE_CONFIRM = 'SİL';
const BATCH = 400;

export class AccountService {
  constructor({ db, auth, log = console }) {
    this.db = db;
    this.auth = auth;
    this.log = log;
  }

  async deleteAccount({ uid, confirm } = {}) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (confirm !== DELETE_CONFIRM) throw new AppError('invalid-argument', `Onay için "${DELETE_CONFIRM}" yazılmalı.`);

    const skipped = [];
    const step = async (name, fn) => {
      try {
        await fn();
      } catch (e) {
        skipped.push(name);
        this.log.warn?.(`[account] ${uid} ${name} atlandı: ${e?.message ?? e}`);
      }
    };

    const userRef = this.db.collection('users').doc(uid);
    const snap = await userRef.get();
    const username = snap.exists ? snap.data()?.username : null;

    await step('comments', () => this._deleteWhereUid('comments', uid));
    await step('chat', () => this._deleteWhereUid('messages', uid));
    await step('leaderboards', async () => {
      const boards = await this.db.collection('leaderboards').listDocuments();
      for (const b of boards) await b.collection('entries').doc(uid).delete();
    });
    await step('stats', () => Promise.all([this.db.doc(`user_stats/${uid}`).delete(), this.db.doc(`editor_stats/${uid}`).delete()]));
    await step('support', async () => {
      await this.db.recursiveDelete(this.db.doc(`support/${uid}`));
      await this.db.doc(`support_threads/${uid}`).delete();
    });
    if (username) await step('username', () => this.db.doc(`usernames/${String(username).replaceAll('@', '').toLowerCase()}`).delete());

    // Asıl kayıt ve giriş hesabı: bunlar başarısız olursa hata kullanıcıya döner (tekrar denenebilir).
    await this.db.recursiveDelete(userRef);
    try {
      await this.auth.deleteUser(uid);
    } catch (e) {
      if (e?.code !== 'auth/user-not-found') throw e;
    }
    this.log.info?.(`[account] ${uid} silindi${skipped.length ? ` (atlanan: ${skipped.join(', ')})` : ''}`);
    return { deleted: true, skipped };
  }

  /** Koleksiyon grubunda uid alanı eşleşen belgeleri parça parça siler. */
  async _deleteWhereUid(group, uid) {
    for (;;) {
      const q = await this.db.collectionGroup(group).where('uid', '==', uid).limit(BATCH).get();
      if (q.empty) return;
      const batch = this.db.batch();
      for (const d of q.docs) batch.delete(d.ref);
      await batch.commit();
      if (q.size < BATCH) return;
    }
  }
}
