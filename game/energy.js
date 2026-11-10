// Enerji: günlük maç sınırının yerine. Her maç enerji harcar, enerji zamanla dolar; mağazadan oyun kredisiyle enerji
// alınır (krediler yalnızca oyunla kazanılır, satın alınmaz). Günün Meydan Okuması enerjisizdir (günde bir kez).
//
//   game_profiles/{uid}.energy = { v, at }   v: son hesaptaki enerji, at: o andan itibaren dolum sayacı (ms)
//   Dolum: her ENERGY.regenMinutes dakikada +1, ENERGY.max'a kadar. Mağazadan alınan enerji max'ı aşabilir (cap'e dek);
//   max'ın üstündeyken dolum durur.

import { AppError } from '../errors.js';

export const ENERGY = {
  start: 100,
  max: 100,
  cap: 200,
  regenMinutes: 6,
  /** Maç başına enerji. */
  cost: { normal: 20, season: 25, boss: 0 },
  /** Mağaza: her alımda o günün fiyatları priceStep kadar artar (gün sonunda sıfırlanır). */
  shop: [
    { id: 'icecek', name: 'Enerji içeceği', amount: 25, cost: 400 },
    { id: 'paket', name: 'Enerji paketi', amount: 60, cost: 900 },
    { id: 'dolum', name: 'Tam depo', amount: 100, cost: 1400 },
  ],
  priceStep: 0.5,
};

const REGEN_MS = ENERGY.regenMinutes * 60e3;

/** Şu anki enerji (saf): { v, at } — dolum işlenmiş hali. */
export function energyNow(e, now) {
  if (!e || !Number.isFinite(Number(e.v))) return { v: ENERGY.start, at: now };
  const v = Math.max(0, Math.round(Number(e.v)));
  const at = Number(e.at ?? now);
  if (v >= ENERGY.max) return { v, at: now };
  const pts = Math.max(0, Math.floor((now - at) / REGEN_MS));
  const v2 = Math.min(ENERGY.max, v + pts);
  return { v: v2, at: v2 >= ENERGY.max ? now : at + pts * REGEN_MS };
}

/** Bir sonraki puana ve tam dolmaya kalan süre (ms). */
export function energyTimes(cur, now) {
  if (cur.v >= ENERGY.max) return { nextInMs: 0, fullInMs: 0 };
  const nextInMs = Math.max(0, cur.at + REGEN_MS - now);
  return { nextInMs, fullInMs: nextInMs + (ENERGY.max - cur.v - 1) * REGEN_MS };
}

/** Enerji harca (saf): yetmezse hata. Döner: yeni kayıt. */
export function spendEnergy(e, cost, now) {
  const cur = energyNow(e, now);
  if (cur.v < cost) {
    const { nextInMs } = energyTimes(cur, now);
    const wait = Math.ceil(((cost - cur.v - 1) * REGEN_MS + nextInMs) / 60e3);
    throw new AppError('resource-exhausted', `Enerjin yetmiyor (${cur.v}/${cost}). Mağazadan enerji al ya da ${wait} dakika bekle.`);
  }
  const v = cur.v - cost;
  // Depo doluyken (dolum durmuşken) harcanınca sayaç şimdi başlar
  return { v, at: cur.v >= ENERGY.max ? now : cur.at };
}

/** Mağaza fiyatı (bugünkü alım sayısına göre). */
export const energyPrice = (item, bought) => Math.round((item.cost * (1 + ENERGY.priceStep * Math.max(0, Number(bought) || 0))) / 10) * 10;

/** Enerji ekle (saf, cap'e kadar). */
export function addEnergy(e, amount, now) {
  const cur = energyNow(e, now);
  const v = Math.min(ENERGY.cap, cur.v + amount);
  return { v, at: v >= ENERGY.max ? now : cur.at };
}

/** Uygulamaya giden görünüm. */
export function energyView(e, now, bought = 0) {
  const cur = energyNow(e, now);
  const t = energyTimes(cur, now);
  return {
    value: cur.v,
    max: ENERGY.max,
    cap: ENERGY.cap,
    regenMinutes: ENERGY.regenMinutes,
    nextInMs: t.nextInMs,
    fullInMs: t.fullInMs,
    cost: ENERGY.cost,
    bought: Number(bought) || 0,
    shop: ENERGY.shop.map((x) => ({ id: x.id, name: x.name, amount: x.amount, cost: energyPrice(x, bought), base: x.cost })),
  };
}

/** Kaç maçlık enerji var. */
export const matchesLeft = (e, now, mode = 'normal') => {
  const c = ENERGY.cost[mode] ?? ENERGY.cost.normal;
  return c ? Math.floor(energyNow(e, now).v / c) : 1;
};
