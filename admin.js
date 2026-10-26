// Yönetim işlemleri (yalnızca role: 'admin'): rol atama, abonelik verme/kaldırma, hesap engelleme.
// Rol ve abonelik istemciden değiştirilemediği için bu işlemler sunucudan yapılır. (Jeton sistemi kaldırıldı.)

import { AppError } from './errors.js';
import { grantSubscription } from './subscription.js';

export const ROLES = ['user', 'editor', 'admin'];

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

    /** Aboneliği ver ya da kaldır (plan: 'weekly' | 'monthly' | 'yearly' | 'none'): hediye, destek ya da test için.
     *  Google Play aboneliği mağazadan yönetilir; burada kaldırmak Play aboneliğini iptal etmez. */
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
