// Gizli ikililer: bazı oyuncu çiftleri aynı kadroda oynayınca uyum yakalar (+güç). Kimin kimle uyumlu olduğu bilinmez;
// birlikte maça çıkınca keşfedilir ve kulübün "ikililer" listesine yazılır. Uyum oyuncu kimliğinden sabit hesaplanır.

import { hashStr } from './staff.js';

export const DUO = { mod: 41, power: 0.6, max: 3 };

const NEAR = { KL: ['DEF'], DEF: ['KL', 'DEF', 'OS'], OS: ['DEF', 'OS', 'FV'], FV: ['OS', 'FV'] };
export const duoKey = (a, b) => [String(a), String(b)].sort().join('|');
export const isDuo = (a, b) => a != null && b != null && String(a) !== String(b) && hashStr(`duo:${duoKey(a, b)}`) % DUO.mod === 0;
const idOf = (c) => String(c?.pid ?? c?.id ?? '');

/** Kadrodaki ikililer (yan yana oynayabilecek mevkilerden). lineup: yuva → kart. */
export function findDuos(lineup) {
  const cards = Object.values(lineup ?? {}).filter(Boolean);
  const out = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i];
      const b = cards[j];
      if (!(NEAR[a.g] ?? []).includes(b.g)) continue;
      if (!isDuo(idOf(a), idOf(b))) continue;
      out.push({ key: duoKey(idOf(a), idOf(b)), a: String(a.s ?? a.n ?? ''), b: String(b.s ?? b.n ?? '') });
    }
  }
  return out.slice(0, DUO.max);
}

export const duoPower = (duos) => Math.round(Math.min(DUO.max, duos.length) * DUO.power * 10) / 10;
