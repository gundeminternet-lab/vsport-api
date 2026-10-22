// Günlük giriş ödülü ve davet kodu.
//   Günlük ödül: seri gününe göre token (7 günlük döngü), giriş kaydıyla aynı işlemde verilir (progress.js checkIn).
//   Davet: invite_codes/{KOD} → { uid }. Yeni kullanıcı (hesabı 7 günden yeni) bir kez kod girer; ikisi de ödül alır.

import { AppError } from './logic.js';

export const DAILY_REWARDS = [5, 5, 10, 10, 15, 15, 50];
export const INVITE_REWARD = 25;
export const INVITE_MAX = 50; // bir kullanıcının ödül alabileceği en fazla davet
export const INVITE_WINDOW_DAYS = 7;

/** Serinin kaçıncı günü → token (7. gün büyük ödül, sonra döngü başa döner). */
export function dailyReward(streak) {
  if (!Number.isFinite(streak) || streak < 1) return DAILY_REWARDS[0];
  return DAILY_REWARDS[(streak - 1) % DAILY_REWARDS.length];
}

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
  const ledger = (tx, uid, delta, reason, key) =>
    tx.create(db.collection(`users/${uid}/token_ledger`).doc(), { delta, reason, key, at: FieldValue.serverTimestamp() });

  return {
    /** Günlük ödülü giriş işleminin içinde verir (tx: aynı işlem). */
    grantDaily(tx, uid, streak, day) {
      const amount = dailyReward(streak);
      tx.update(db.doc(`users/${uid}`), { tokens: FieldValue.increment(amount) });
      ledger(tx, uid, amount, 'daily_reward', day);
      return amount;
    },

    /** Kullanıcının davet kodu (yoksa üretir) ve davet sayısı. */
    async myInviteCode({ uid }) {
      const userRef = db.doc(`users/${uid}`);
      const user = await userRef.get();
      if (!user.exists) throw new AppError('failed-precondition', 'Profil bulunamadı.');
      const existing = user.get('inviteCode');
      if (existing) return { code: existing, invites: user.get('invites') ?? 0, reward: INVITE_REWARD };
      for (let i = 0; i < 6; i++) {
        const code = randomCode();
        try {
          await db.runTransaction(async (tx) => {
            const u = await tx.get(userRef);
            if (u.get('inviteCode')) throw Object.assign(new Error('exists'), { existing: u.get('inviteCode') });
            tx.create(db.doc(`invite_codes/${code}`), { uid, createdAt: FieldValue.serverTimestamp() });
            tx.update(userRef, { inviteCode: code });
          });
          return { code, invites: 0, reward: INVITE_REWARD };
        } catch (e) {
          if (e.existing) return { code: e.existing, invites: user.get('invites') ?? 0, reward: INVITE_REWARD };
          if (e.code !== 6) throw e; // 6: kod zaten var → yeni kod dene
        }
      }
      throw new AppError('internal', 'Davet kodu oluşturulamadı, tekrar deneyin.');
    },

    /** Davet kodu kullan: iki tarafa da ödül (davet edenin ödülü en fazla INVITE_MAX kez). */
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
        tx.update(userRef, { invitedBy: inviterUid, tokens: FieldValue.increment(INVITE_REWARD) });
        ledger(tx, uid, INVITE_REWARD, 'invite_welcome', c);
        const invites = Number(inviterSnap.get('invites') ?? 0);
        const inviterRewarded = invites < INVITE_MAX;
        tx.update(inviterRef, { invites: FieldValue.increment(1), ...(inviterRewarded ? { tokens: FieldValue.increment(INVITE_REWARD) } : {}) });
        if (inviterRewarded) ledger(tx, inviterUid, INVITE_REWARD, 'invite_bonus', uid);
        return { reward: INVITE_REWARD, inviter: inviterSnap.get('username') ?? null };
      });
    },
  };
}
