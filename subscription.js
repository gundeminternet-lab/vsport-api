// Abonelik yetkisi. Abonelik kaydı users/{uid}.subscription alanındadır ve yalnızca sunucu yazar
// (firestore.rules kullanıcının bu alanı değiştirmesine izin vermez):
//   { plan: 'weekly'|'monthly'|'yearly', until: <bitiş, ms>, source: 'admin'|'play', updatedAt: <ms> }
//
// Mağaza (Google Play) faturalandırması bağlanana kadar abonelik yönetici tarafından verilir (admin.js → setSubscription).

import { AppError } from './logic.js';

const DAY = 86400000;
export const PLANS = ['weekly', 'monthly', 'yearly'];
/** AI Asistan yalnızca aylık ve yıllık abonelere açıktır. */
export const ASSISTANT_PLANS = ['monthly', 'yearly'];
/** Bir aboneden günde en fazla bu kadar Asistan analizi (sunucu maliyetini sınırlar). */
export const ASSISTANT_DAILY_LIMIT = 15;
export const PLAN_DAYS = { weekly: 7, monthly: 30, yearly: 365 };

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

/** Yönetici aboneliği verirken yeni kayıt: hâlâ geçerli abonelik varsa süre üzerine eklenir. */
export function grantSubscription(existing, { plan, days, now = Date.now(), by = null }) {
  if (!PLANS.includes(plan)) throw new AppError('invalid-argument', 'Geçersiz abonelik planı.');
  if (!Number.isInteger(days) || days < 1 || days > 800) throw new AppError('invalid-argument', 'Gün sayısı 1 ile 800 arasında olmalı.');
  const cur = activeSubscription(existing, now);
  // Aynı planı uzatıyorsa mevcut bitişten, farklı plansa şimdiden başlar.
  const base = cur && cur.plan === plan ? cur.until : now;
  return { plan, until: base + days * DAY, source: 'admin', grantedBy: by, updatedAt: now };
}

/** Türkiye saatine göre gün anahtarı (YYYY-MM-DD). */
export const dayKeyTr = (ms) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
