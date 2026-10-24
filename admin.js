// Yönetim işlemleri (yalnızca role: 'admin'): rol atama, token yükleme/düşme, hesap engelleme.
// Token ve rol istemciden değiştirilemediği için bu işlemler sunucudan yapılır ve token hareketlerine yazılır.

import { AppError } from './logic.js';
import { grantSubscription } from './subscription.js';

export const ROLES = ['user', 'editor', 'admin'];
const MAX_ADJUST = 100000;

/** Token düzeltmesi geçerli mi (saf)? */
export function validateAdjust({ delta, reason }) {
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_ADJUST) {
    throw new AppError('invalid-argument', `Miktar 1 ile ${MAX_ADJUST} arasında, sıfırdan farklı bir tam sayı olmalı.`);
  }
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 120) {
    throw new AppError('invalid-argument', 'Açıklama 3-120 karakter olmalı.');
  }
}

export function createAdminService({ db, FieldValue, auth }) {
  async function requireAdmin(uid) {
    const s = await db.doc(`users/${uid}`).get();
    if (!s.exists || s.get('role') !== 'admin') throw new AppError('permission-denied', 'Bu işlem için yönetici yetkisi gerekli.');
  }
  const target = (t) => {
    if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(t)) throw new AppError('invalid-argument', 'Geçersiz kullanıcı.');
    return db.doc(`users/${t}`);
  };

  return {
    async setRole({ uid, targetUid, role }) {
      await requireAdmin(uid);
      if (!ROLES.includes(role)) throw new AppError('invalid-argument', 'Geçersiz rol.');
      if (targetUid === uid && role !== 'admin') throw new AppError('failed-precondition', 'Kendi yönetici yetkinizi kaldıramazsınız.');
      const ref = target(targetUid);
      if (!(await ref.get()).exists) throw new AppError('not-found', 'Kullanıcı bulunamadı.');
      await ref.update({ role });
      return { role };
    },

    async adjustTokens({ uid, targetUid, delta, reason }) {
      await requireAdmin(uid);
      validateAdjust({ delta, reason });
      const ref = target(targetUid);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) throw new AppError('not-found', 'Kullanıcı bulunamadı.');
        const balance = Number(s.get('tokens') ?? 0);
        if (balance + delta < 0) throw new AppError('failed-precondition', `Bakiye eksiye düşemez (mevcut: ${balance}).`);
        tx.update(ref, { tokens: FieldValue.increment(delta) });
        tx.create(db.collection(`users/${targetUid}/token_ledger`).doc(), {
          delta,
          reason: 'admin_adjust',
          note: reason.trim(),
          by: uid,
          at: FieldValue.serverTimestamp(),
        });
        return { balance: balance + delta };
      });
    },

    /** Aboneliği ver ya da kaldır (plan: 'weekly' | 'monthly' | 'yearly' | 'none'). Mağaza faturalandırması bağlanana kadar kullanılır. */
    async setSubscription({ uid, targetUid, plan, days }) {
      await requireAdmin(uid);
      const ref = target(targetUid);
      const s = await ref.get();
      if (!s.exists) throw new AppError('not-found', 'Kullanıcı bulunamadı.');
      if (plan === 'none') {
        await ref.update({ subscription: FieldValue.delete() });
        return { plan: 'none', until: null };
      }
      const sub = grantSubscription(s.get('subscription'), { plan, days, by: uid });
      await ref.update({ subscription: sub });
      return { plan: sub.plan, until: sub.until };
    },

    async setBanned({ uid, targetUid, banned }) {
      await requireAdmin(uid);
      if (targetUid === uid) throw new AppError('failed-precondition', 'Kendinizi engelleyemezsiniz.');
      const ref = target(targetUid);
      if (!(await ref.get()).exists) throw new AppError('not-found', 'Kullanıcı bulunamadı.');
      await auth.updateUser(targetUid, { disabled: banned === true });
      if (banned === true) await auth.revokeRefreshTokens(targetUid);
      await ref.update({ banned: banned === true });
      return { banned: banned === true };
    },
  };
}
