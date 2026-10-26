// vSport Cloud Functions (Firebase Functions v2, Node 22).
//
//   unlockContent  { league, eventId, kickoff, type: 'ai'|'sim' }   abone ya da deneme hakkı: içerik döner
//   getContent     { league, eventId, kickoff, type }               açılmış içerik (maç bittiyse ücretsiz)
//   getReview      { league, eventId, kickoff }                     biten maçta tahmin ↔ sonuç karşılaştırması
//   unlockCoupon   { couponId }                                     editör kuponu (abonelere)
//
// Asıl sunucu server.js'tir (Render); bu dosya Cloud Functions ile çalıştırmak isteyenler içindir.
// Abonelik ve deneme sayacı yalnızca sunucuda (Admin SDK) değişir; firestore.rules istemcinin değiştirmesini engeller.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';

import { EspnClient } from './engine/espn.js';
import { PaidContentService, AppError } from './logic.js';
import { CouponService } from './coupons.js';
import { createStore } from './store.js';

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const espn = new EspnClient(); // örnek ömrü boyunca 5 dk önbellek

const store = createStore(db, FieldValue);

const service = new PaidContentService({ store, espn });
const coupons = new CouponService({ store });

// AppError → istemcinin anlayacağı HttpsError
function wrap(fn) {
  return async (request) => {
    try {
      return await fn({ ...(request.data ?? {}), uid: request.auth?.uid ?? null });
    } catch (e) {
      // 'subscription-required' Firebase'in hata kodlarında yok: izin hatası olarak, ayrıntıda gerçek kodla döner
      if (e instanceof AppError) throw new HttpsError(e.code === 'subscription-required' ? 'permission-denied' : e.code, e.message, { reason: e.code });
      console.error(e);
      throw new HttpsError('internal', 'İşlem tamamlanamadı, lütfen tekrar deneyin.');
    }
  };
}

const opts = { timeoutSeconds: 60, memory: '512MiB' };

export const unlockContent = onCall(opts, wrap((d) => service.unlock(d)));
export const getContent = onCall(opts, wrap((d) => service.get(d)));
export const getReview = onCall(opts, wrap((d) => service.review(d)));
export const unlockCoupon = onCall({ timeoutSeconds: 20 }, wrap((d) => coupons.unlock(d)));
