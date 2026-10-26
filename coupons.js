// Editör kuponları: kupon herkese açık listede görünür (başlık, editör, maçlar), seçimler ve oranlar
// coupons/{id}/private/picks belgesinde gizlidir. Aboneler (her plan) açar; açılınca kilit kaydı yazılır ve kullanıcı
// o belgeyi Firestore kuralları sayesinde okuyabilir. Jeton/fiyat yoktur. Abone olmayan, günlük çarktan kazandığı
// "editör seçimi" hakkıyla bir seçimi açabilir (use: 'editor').
//
// store arayüzü: getCoupon(id), hasUnlockId(uid, unlockId), recordUnlock({ uid, unlockId, record }),
//                useWheelCredit({ uid, prize, unlockId, record, now })

import { AppError } from './errors.js';
import { AccessService } from './subscription.js';

export class CouponService {
  constructor({ store, now = () => Date.now(), access = null }) {
    this.store = store;
    this.now = now;
    this.access = access ?? new AccessService({ store, now });
  }

  async unlock({ uid, couponId, use = null }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (typeof couponId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(couponId)) {
      throw new AppError('invalid-argument', 'Geçersiz kupon.');
    }
    const c = await this.store.getCoupon(couponId);
    if (!c || c.deleted === true) throw new AppError('not-found', 'Kupon bulunamadı.');

    const unlockId = `coupon_${couponId}`;
    // Editör kendi kuponunu her zaman görür (kurallar da izin verir).
    if (c.editorUid === uid) return { couponId, opened: true };
    if (await this.store.hasUnlockId(uid, unlockId)) return { couponId, opened: true };
    const record = { type: 'coupon', couponId, title: c.title ?? 'Kupon', editorName: c.editorName ?? '', kickoff: c.firstKickoff ?? null };
    const ent = await this.access.entitlement(uid);
    if (!ent.subscribed && use === 'editor') {
      if (!(ent.wheel?.credits?.editor > 0)) throw new AppError('subscription-required', 'Editör seçimi çark hakkın yok ya da süresi doldu.');
      const { left } = await this.store.useWheelCredit({ uid, prize: 'editor', unlockId, record: { ...record, via: 'wheel', prize: 'editor' }, now: this.now() });
      return { couponId, opened: true, via: 'wheel', creditsLeft: left };
    }
    if (!ent.subscribed) throw new AppError('subscription-required', 'Editör seçimleri abonelere özel.');
    await this.store.recordUnlock({ uid, unlockId, record: { ...record, via: 'subscription' } });
    return { couponId, opened: true, via: 'subscription' };
  }
}
