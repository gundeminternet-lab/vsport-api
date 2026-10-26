// Davet kodu. Jeton ödülleri kaldırıldı (günlük giriş serisi, XP ve rozetler progress.js'te sürer).
//   Davet: invite_codes/{KOD} → { uid }. Yeni kullanıcı (hesabı 7 günden yeni) bir kez kod girer; davet eden
//   kişinin davet sayısı artar (profilde görünür). Ödül verilmez.

import { AppError } from './errors.js';

export const INVITE_WINDOW_DAYS = 7;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // karışan harfler (0/O, 1/I) yok
export function randomCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return s;
}

export function normalizeCode(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^VSP/, '');
}

/** Kod kullanma koşulları (saf): hata mesajı ya da null. */
export function redeemProblem({ user, inviterUid, uid, nowMs }) {
  if (!user) return 'Profil bulunamadı.';
  if (user.invitedBy) return 'Daha önce bir davet kodu kullandınız.';
  if (!inviterUid) return 'Davet kodu bulunamadı.';
  if (inviterUid === uid) return 'Kendi davet kodunuzu kullanamazsınız.';
  const created = user.createdAt?.toMillis?.() ?? (typeof user.createdAt === 'number' ? user.createdAt : null);
  if (created && nowMs - created > INVITE_WINDOW_DAYS * 86400e3) return `Davet kodu yalnızca ilk ${INVITE_WINDOW_DAYS} gün içinde kullanılabilir.`;
  return null;
}

export function createRewardStore(db, FieldValue, now = () => Date.now()) {
  return {

    /** Kullanıcının davet kodu (yoksa üretir) ve davet sayısı. */
    async myInviteCode({ uid }) {
      const userRef = db.doc(`users/${uid}`);
      const user = await userRef.get();
      if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
      const existing = user.get('inviteCode');
      if (existing) return { code: existing, invites: user.get('invites') ?? 0 };
      for (let i = 0; i < 6; i++) {
        const code = randomCode();
        try {
          await db.runTransaction(async (tx) => {
            const u = await tx.get(userRef);
            if (u.get('inviteCode')) throw Object.assign(new Error('exists'), { existing: u.get('inviteCode') });
            tx.create(db.doc(`invite_codes/${code}`), { uid, createdAt: FieldValue.serverTimestamp() });
            tx.update(userRef, { inviteCode: code });
          });
          return { code, invites: 0 };
        } catch (e) {
          if (e.existing) return { code: e.existing, invites: user.get('invites') ?? 0 };
          if (e.code !== 6) throw e; // 6: kod zaten var → yeni kod dene
        }
      }
      throw new AppError('internal', 'Davet kodu oluşturulamadı, tekrar deneyin.');
    },

    /** Davet kodu kullan: davet eden kaydedilir, davet edenin sayacı artar. */
    async redeemInvite({ uid, code }) {
      const c = normalizeCode(code);
      if (!/^[A-Z0-9]{6}$/.test(c)) throw new AppError('invalid-argument', 'Geçersiz davet kodu.');
      return db.runTransaction(async (tx) => {
        const codeSnap = await tx.get(db.doc(`invite_codes/${c}`));
        const inviterUid = codeSnap.exists ? codeSnap.get('uid') : null;
        const userRef = db.doc(`users/${uid}`);
        const userSnap = await tx.get(userRef);
        const inviterRef = inviterUid ? db.doc(`users/${inviterUid}`) : null;
        const inviterSnap = inviterRef ? await tx.get(inviterRef) : null;
        const problem = redeemProblem({ user: userSnap.exists ? userSnap.data() : null, inviterUid: inviterSnap?.exists ? inviterUid : null, uid, nowMs: now() });
        if (problem) throw new AppError('failed-precondition', problem);
        tx.update(userRef, { invitedBy: inviterUid });
        tx.update(inviterRef, { invites: FieldValue.increment(1) });
        return { inviter: inviterSnap.get('username') ?? null };
      });
    },
  };
}
