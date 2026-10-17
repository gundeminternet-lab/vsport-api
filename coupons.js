// Editör kuponları: kupon herkese açık listede görünür (başlık, editör, maçlar, fiyat), seçimler ve oranlar
// coupons/{id}/private/picks belgesinde gizlidir. Kilidi açan kullanıcı o belgeyi Firestore kuralları sayesinde okuyabilir.
//
// store arayüzü (index.js): getCoupon(id), hasUnlockId(uid, unlockId), purchase({ uid, unlockId, price, record })

import { AppError } from './logic.js';

export const MAX_COUPON_PRICE = 1000;

export class CouponService {
  constructor({ store, now = () => Date.now() }) {
    this.store = store;
    this.now = now;
  }

  async unlock({ uid, couponId, price: expectedPrice }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (typeof couponId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(couponId)) {
      throw new AppError('invalid-argument', 'Geçersiz kupon.');
    }
    const c = await this.store.getCoupon(couponId);
    if (!c || c.deleted === true) throw new AppError('not-found', 'Kupon bulunamadı.');

    const unlockId = `coupon_${couponId}`;
    // Editör kendi kuponunu ücretsiz görür (kurallar da izin verir).
    if (c.editorUid === uid) return { couponId, charged: false, balance: null };

    const already = await this.store.hasUnlockId(uid, unlockId);
    // Kurallarla doğrulanan Firestore zaman damgası esas alınır (metin alanı yalnızca yedek).
    const first = typeof c.firstKickoffAt?.toMillis === 'function' ? c.firstKickoffAt.toMillis() : Date.parse(c.firstKickoff);
    if (!already && (!Number.isFinite(first) || first <= this.now())) {
      throw new AppError('failed-precondition', 'Kuponun ilk maçı başladı; artık satın alınamaz.');
    }
    const price = Number.isInteger(c.price) && c.price >= 0 && c.price <= MAX_COUPON_PRICE ? c.price : null;
    if (price === null) throw new AppError('failed-precondition', 'Kupon fiyatı geçersiz.');

    if (already) return { couponId, charged: false, balance: null };
    // Kullanıcı onayladıktan sonra editör fiyatı değiştirdiyse ücret alınmaz.
    if (expectedPrice !== undefined && expectedPrice !== price) {
      throw new AppError('failed-precondition', `Kupon fiyatı değişti (şimdi ${price} token). Lütfen tekrar deneyin.`);
    }
    const { charged, balance } = await this.store.purchase({
      uid,
      unlockId,
      price,
      record: { type: 'coupon', couponId, title: c.title ?? 'Kupon', editorName: c.editorName ?? '', kickoff: c.firstKickoff },
    });
    return { couponId, charged, balance, price };
  }
}
