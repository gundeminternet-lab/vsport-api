// Günlük hediye çarkı. Her kullanıcı (abone olsun olmasın) Türkiye saatiyle günde bir kez ücretsiz çevirir.
// Sonuç sunucuda belirlenir (crypto.randomInt); uygulama çarkı yalnızca sunucunun söylediği dilime döndürür.
//
// Ödüller ve ihtimaller (1000 üzerinden; büyük ödül en zoru):
//   xp           +10 XP (teselli)                       %64
//   sim          1 maç simülasyon                         %15
//   commentator  1 maç AI Yorumcu (AI analizi + video)    %11   simülasyon ve Özel Yorumlar hariç
//   editor       1 editör seçimi                          %6
//   full         1 maç tüm özellikler (AI paketi)         %3
//   assistant    1 gün AI Asistan — BÜYÜK ÖDÜL            %1
//
// Maç ve editör hakları kazanıldıktan sonra CREDIT_DAYS gün geçerli; maç hakları yalnızca maç başlamadan kullanılır.
// AI Asistan ödülü kazanıldığı an başlar, ASSISTANT_PRIZE_HOURS saat sürer.
//
// Kayıt (yalnızca sunucu yazar; firestore.rules):
//   users/{uid}.wheel = { day, nextAt, last: { prize, slice, at }, credits: [{ id, prize, at, until }], assistantUntil }

import { randomInt } from 'node:crypto';

import { AppError } from './errors.js';
import { trDay } from './progress.js';

const DAY = 86400000;

/** Ödül kimliği → ağırlık (toplam 1000). Uygulamadaki lib/models/wheel.dart ile aynı olmalı. */
export const WHEEL_WEIGHTS = { xp: 640, sim: 150, commentator: 110, editor: 60, full: 30, assistant: 10 };
export const WHEEL_PRIZES = Object.keys(WHEEL_WEIGHTS);
export const TOTAL_WEIGHT = Object.values(WHEEL_WEIGHTS).reduce((a, b) => a + b, 0);
/** Çarktaki dilimler (saat yönünde, üstten başlayarak). Uygulama aynı sırayla çizer. */
export const WHEEL_SLICES = ['assistant', 'xp', 'sim', 'commentator', 'xp', 'editor', 'full', 'xp'];
/** Kullanılmak üzere saklanan ödüller (hak). */
export const CREDIT_PRIZES = ['sim', 'commentator', 'editor', 'full'];
export const CREDIT_DAYS = 7;
export const ASSISTANT_PRIZE_HOURS = 24;
export const XP_PRIZE = 10;
const MAX_CREDITS = 40;

/** Türkiye saatiyle bir sonraki gece yarısı (yeni çevirme hakkı). */
export function nextMidnightTr(now) {
  return Date.parse(`${trDay(now)}T00:00:00+03:00`) + DAY;
}

/** 0 ≤ roll < TOTAL_WEIGHT → ödül. */
export function pickPrize(roll) {
  let acc = 0;
  for (const p of WHEEL_PRIZES) {
    acc += WHEEL_WEIGHTS[p];
    if (roll < acc) return p;
  }
  return 'xp';
}

/** Ödülün çarktaki dilimi (aynı ödülden birden çok dilim varsa roll ile seçilir). */
export function sliceOf(prize, roll = 0) {
  const idx = WHEEL_SLICES.map((p, i) => (p === prize ? i : -1)).filter((i) => i >= 0);
  return idx[Math.abs(Math.trunc(roll)) % idx.length];
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Süresi geçmemiş haklar (bozuk kayıtlar atlanır). */
export function validCredits(wheel, now) {
  const list = Array.isArray(wheel?.credits) ? wheel.credits : [];
  return list
    .filter((c) => c && CREDIT_PRIZES.includes(c.prize) && num(c.until) > now)
    .map((c) => ({ id: String(c.id ?? ''), prize: c.prize, at: num(c.at), until: num(c.until) }));
}

export const canSpin = (wheel, now) => !wheel || wheel.day !== trDay(now);

/** Çevirme sonucunu kayda işler (saf). */
export function applySpin(prev, { prize, slice, now, id }) {
  let credits = validCredits(prev, now);
  const prevAssistant = num(prev?.assistantUntil);
  let assistantUntil = prevAssistant > now ? prevAssistant : null;
  if (CREDIT_PRIZES.includes(prize)) {
    credits = [...credits, { id, prize, at: now, until: now + CREDIT_DAYS * DAY }].slice(-MAX_CREDITS);
  }
  if (prize === 'assistant') assistantUntil = Math.max(assistantUntil ?? 0, now) + ASSISTANT_PRIZE_HOURS * 3600e3;
  return { day: trDay(now), nextAt: nextMidnightTr(now), last: { prize, slice, at: now }, credits, assistantUntil };
}

/** Hakkı düşer (saf): süresi en yakın olan kullanılır. Yoksa null. */
export function takeCredit(prev, prize, now) {
  const credits = validCredits(prev, now);
  const mine = credits.filter((c) => c.prize === prize).sort((a, b) => a.until - b.until);
  if (!mine.length) return null;
  const used = mine[0];
  return { credit: used, wheel: { ...(prev ?? {}), credits: credits.filter((c) => c !== used) } };
}

export const countCredits = (wheel, prize, now) => validCredits(wheel, now).filter((c) => c.prize === prize).length;

/** Uygulamaya ve hak denetimine giden özet. */
export function wheelStatus(wheel, now) {
  const credits = validCredits(wheel, now);
  const counts = Object.fromEntries(CREDIT_PRIZES.map((p) => [p, credits.filter((c) => c.prize === p).length]));
  const assistantUntil = num(wheel?.assistantUntil) > now ? num(wheel.assistantUntil) : null;
  const spin = canSpin(wheel, now);
  return {
    canSpin: spin,
    nextSpinAt: spin ? null : num(wheel?.nextAt) || nextMidnightTr(now),
    last: wheel?.last ?? null,
    credits: counts,
    items: credits.map((c) => ({ prize: c.prize, until: c.until })),
    assistantUntil,
  };
}

/**
 * store arayüzü:
 *   spinWheel({ uid, day, apply }) -> { wheel }   tek işlemde: bugün çevrildiyse hata, değilse apply(önceki) yazılır
 *   getAccess(uid) -> { wheel, ... }
 */
export class WheelService {
  constructor({ store, now = () => Date.now(), random = (n) => randomInt(0, n), progress = null }) {
    this.store = store;
    this.now = now;
    this.random = random;
    this.progress = progress;
  }

  async spin({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const now = this.now();
    // Sonuç işlemden önce belirlenir: işlem tekrar denenirse ödül değişmez.
    const prize = pickPrize(this.random(TOTAL_WEIGHT));
    const slice = sliceOf(prize, this.random(1000));
    const id = `${now.toString(36)}${this.random(1679616).toString(36)}`;
    const { wheel } = await this.store.spinWheel({ uid, day: trDay(now), apply: (prev) => applySpin(prev, { prize, slice, now, id }) });
    if (prize === 'xp' && this.progress) this.progress.add(uid, { xp: XP_PRIZE }).catch(() => {});
    return { prize, slice, ...wheelStatus(wheel, now) };
  }

  async status({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const access = (await this.store.getAccess(uid)) ?? {};
    return wheelStatus(access.wheel ?? null, this.now());
  }
}

/** Çark hakkıyla açılan içerik: hangi kilit kaydı yazılır. full ve deneme AI paketinin tamamını açar. */
export const CREDIT_TARGET = { full: 'ai', commentator: 'aic', sim: 'sim' };
/** Hak hangi içerik isteğiyle kullanılabilir. */
export const CREDIT_TYPES = { full: ['ai', 'sim'], commentator: ['ai'], sim: ['sim'], trial: ['ai', 'sim'] };
