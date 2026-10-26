// Abonelik ve erişim. Jeton (token) sistemi kaldırıldı: ücretli içerikler aboneliğe bağlıdır.
//
// Planlar (fiyatlar Google Play Console'da aynı tutarla tanımlanır; uygulama mağazanın gösterdiği fiyatı kullanır):
//   Haftalık 300 TL · Aylık 999 TL · Yıllık 1.999 TL
// Kapsam: her plan AI paketini (her maç: AI analizi, AI videosu, simülasyon, Özel Yorumlar, kadro güncellemesi),
// kupon kontrolünü ve editör kuponlarını açar. AI Asistan yalnızca aylık ve yıllık planda.
// Deneme: her kullanıcı abone olmadan TRIAL_MATCHES maçın AI paketini ücretsiz açabilir (maç başlamadan önce).
// Günlük çark (wheel.js): maç/editör hakları ve 1 günlük AI Asistan ödülü de buradaki haklara eklenir.
//
// Kayıt: users/{uid}.subscription = { plan, until (ms), source: 'play'|'admin', ... }, users/{uid}.trialUsed (sayı)
// ve users/{uid}.wheel. Hepsini yalnızca sunucu yazar (firestore.rules).

import { AppError } from './errors.js';
import { wheelStatus } from './wheel.js';

const DAY = 86400000;
export const PLANS = ['weekly', 'monthly', 'yearly'];
export const PLAN_PRICES_TL = { weekly: 300, monthly: 999, yearly: 1999 };
export const PLAN_DAYS = { weekly: 7, monthly: 30, yearly: 365 };
/** Google Play abonelik ürün kimlikleri (Play Console → Abonelikler'de aynı kimliklerle oluşturulmalı). */
export const PLAN_PRODUCTS = { weekly: 'vsport_weekly', monthly: 'vsport_monthly', yearly: 'vsport_yearly' };
export const planOfProduct = (productId) => PLANS.find((p) => PLAN_PRODUCTS[p] === productId) ?? null;
/** AI Asistan yalnızca aylık ve yıllık abonelere açıktır. */
export const ASSISTANT_PLANS = ['monthly', 'yearly'];
/** Bir aboneden günde en fazla bu kadar Asistan analizi (sunucu maliyetini sınırlar). */
export const ASSISTANT_DAILY_LIMIT = 15;
/** Abone olmadan ücretsiz açılabilecek maç sayısı (AI paketinin tamamı). */
export const TRIAL_MATCHES = 2;

/** Abonelik gerektiren işlem için hata (uygulama bu kodla abonelik ekranını açar). */
export const subscriptionRequired = (message = 'Bu içerik abonelere özel. Haftalık, aylık ya da yıllık plana geçerek açabilirsin.') =>
  new AppError('subscription-required', message);

/** Süresi dolmamış abonelik; yoksa null. */
export function activeSubscription(sub, now = Date.now()) {
  if (!sub || !PLANS.includes(sub.plan)) return null;
  const until = Number(sub.until);
  return Number.isFinite(until) && until > now ? { plan: sub.plan, until } : null;
}

export const hasAssistantAccess = (sub, now = Date.now()) => {
  const a = activeSubscription(sub, now);
  return a !== null && ASSISTANT_PLANS.includes(a.plan);
};

/**
 * Kullanıcının hakları (saf): { subscribed, plan, until, assistant, assistantVia, trialUsed, trialLeft, wheel }.
 * assistant: aylık/yıllık abonelik ya da çarktan kazanılan 1 günlük AI Asistan (assistantVia: 'plan' | 'wheel').
 */
export function entitlementOf({ subscription = null, trialUsed = 0, wheel = null } = {}, now = Date.now()) {
  const a = activeSubscription(subscription, now);
  const used = Math.max(0, Number(trialUsed) || 0);
  const w = wheelStatus(wheel, now);
  const planAssistant = a !== null && ASSISTANT_PLANS.includes(a.plan);
  return {
    subscribed: a !== null,
    plan: a?.plan ?? null,
    until: a?.until ?? null,
    assistant: planAssistant || w.assistantUntil !== null,
    assistantVia: planAssistant ? 'plan' : w.assistantUntil !== null ? 'wheel' : null,
    trialUsed: used,
    trialLeft: a ? 0 : Math.max(0, TRIAL_MATCHES - used),
    wheel: w,
  };
}

/** Yönetici aboneliği verirken yeni kayıt: hâlâ geçerli abonelik varsa süre üzerine eklenir. */
export function grantSubscription(existing, { plan, days, now = Date.now(), by = null }) {
  if (!PLANS.includes(plan)) throw new AppError('invalid-argument', 'Geçersiz abonelik planı.');
  if (!Number.isInteger(days) || days < 1 || days > 800) throw new AppError('invalid-argument', 'Gün sayısı 1 ile 800 arasında olmalı.');
  const cur = activeSubscription(existing, now);
  // Aynı planı uzatıyorsa mevcut bitişten, farklı plansa şimdiden başlar.
  const base = cur && cur.plan === plan ? cur.until : now;
  return { plan, until: base + days * DAY, source: 'admin', grantedBy: by, updatedAt: now };
}

/**
 * Erişim denetimi. store.getAccess(uid) → { subscription, trialUsed }. billing (isteğe bağlı): Google Play aboneliği
 * süresi dolmuş görünüyorsa mağazadan yeniden doğrular (otomatik yenilenen abonelikler için).
 */
export class AccessService {
  constructor({ store, now = () => Date.now(), billing = null }) {
    this.store = store;
    this.now = now;
    this.billing = billing;
    this._refreshed = new Map(); // uid → son mağaza sorgusu (ms): biten abonelik için her istekte Google'a gidilmez
  }

  async entitlement(uid) {
    if (!uid) return entitlementOf({}, this.now());
    let access = (await this.store.getAccess?.(uid)) ?? { subscription: (await this.store.getSubscription?.(uid)) ?? null, trialUsed: 0 };
    const sub = access.subscription;
    // Play aboneliği yenilenmiş olabilir: bitiş geçtiyse mağazaya sor (bildirim gecikmesine karşı).
    const last = this._refreshed.get(uid) ?? 0;
    if (sub?.source === 'play' && !activeSubscription(sub, this.now()) && this.billing?.enabled && this.now() - last > 10 * 60e3) {
      this._refreshed.set(uid, this.now());
      if (this._refreshed.size > 5000) this._refreshed.clear();
      try {
        const fresh = await this.billing.refresh(uid);
        if (fresh) access = { ...access, subscription: fresh };
      } catch {
        // mağazaya ulaşılamadı: kayıttaki durum geçerli
      }
    }
    return entitlementOf(access, this.now());
  }

  async isSubscriber(uid) {
    return (await this.entitlement(uid)).subscribed;
  }

  /** Abone değilse subscription-required hatası. */
  async requireSubscriber(uid, message) {
    const e = await this.entitlement(uid);
    if (!e.subscribed) throw subscriptionRequired(message);
    return e;
  }
}

/** Türkiye saatine göre gün anahtarı (YYYY-MM-DD). */
export const dayKeyTr = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
