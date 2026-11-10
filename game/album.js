// Koleksiyon albümü ve takas görevleri.
//
// Albüm: oyuncu havuzundaki her kulüp ve ülke bir sayfa. Sayfada sahip olunan farklı oyuncu sayısı kademelere ulaşınca
// ödül (bir kez). Takas görevleri: her hafta 4 görev; şartı sağlayan kartlar verilir (silinir), karşılığında paket jetonu
// ya da kredi. Kadrolarda oynayan kartlar takasa verilemez.

import { createRng } from '../engine/rng.js';
import { tierOf as cardTier } from './pool.js';

export const ALBUM = {
  club: { tiers: [3, 7, 11], rewards: [{ type: 'credits', amount: 300 }, { type: 'credits', amount: 800 }, { type: 'token', pack: 'altin', amount: 1 }] },
  nation: { tiers: [5, 11, 20], rewards: [{ type: 'credits', amount: 400 }, { type: 'token', pack: 'gumus', amount: 1 }, { type: 'token', pack: 'altin', amount: 1 }] },
};

/** Sayfa anahtarı veritabanı alanı olarak (nokta, boşluk, eğik çizgi alan adında kullanılamaz). */
export const safeKey = (k) => String(k).replace(/[.\s/]/g, '_');

/** Albüm sayfaları (saf). poolPlayers: havuz, cards: kullanıcının kartları, claimed: { 'club:<safeKey>': kademe } */
export function albumPages(kind, poolPlayers, cards, claimed = {}) {
  const field = kind === 'nation' ? 'na' : 'ci';
  const conf = ALBUM[kind];
  const pages = new Map();
  for (const p of poolPlayers) {
    const key = String(p[field] ?? '');
    if (!key || key === 'null') continue;
    const page = pages.get(key) ?? { key, name: kind === 'nation' ? p.na : p.c, logo: kind === 'club' ? p.cl ?? null : null, iso: kind === 'nation' ? p.ni ?? null : null, league: p.l ?? null, total: 0, owned: 0, ids: new Set() };
    page.total++;
    pages.set(key, page);
  }
  const owned = new Set(cards.map((c) => String(c.pid ?? c.id)));
  for (const p of poolPlayers) {
    const page = pages.get(String(p[field] ?? ''));
    if (page && owned.has(String(p.id)) && !page.ids.has(String(p.id))) {
      page.ids.add(String(p.id));
      page.owned++;
    }
  }
  return [...pages.values()]
    .map((pg) => {
      const tiers = conf.tiers.filter((t) => t <= pg.total);
      const got = Number(claimed[`${kind}:${safeKey(pg.key)}`] ?? 0);
      return {
        kind,
        key: pg.key,
        name: pg.name,
        logo: pg.logo,
        iso: pg.iso,
        league: pg.league,
        total: pg.total,
        owned: pg.owned,
        tiers: tiers.map((t, i) => ({ need: t, reward: conf.rewards[i], done: pg.owned >= t, claimed: got > i })),
      };
    })
    .sort((a, b) => b.owned - a.owned || a.name.localeCompare(b.name, 'tr'));
}

// ---------------------------------------------------------------------------------------------------------------
// Takas görevleri
// ---------------------------------------------------------------------------------------------------------------
const POOL = [
  { id: 'bronz5', title: '5 bronz kart ver', need: { count: 5, tier: 'bronze' }, reward: { type: 'token', pack: 'bronz', amount: 1 } },
  { id: 'gumus3', title: '3 gümüş kart ver', need: { count: 3, tier: 'silver' }, reward: { type: 'token', pack: 'gumus', amount: 1 } },
  { id: 'altin2', title: '2 altın kart ver', need: { count: 2, tier: 'gold' }, reward: { type: 'token', pack: 'genc', amount: 1 } },
  { id: 'ulke4', title: 'Aynı ülkeden 4 kart ver (65+)', need: { count: 4, sameNation: true, minR: 65 }, reward: { type: 'token', pack: 'mevki', amount: 1 } },
  { id: 'kulup3', title: 'Aynı kulüpten 3 kart ver', need: { count: 3, sameClub: true }, reward: { type: 'credits', amount: 1200 } },
  { id: 'ort11', title: 'Ortalaması 72+ olan 11 kart ver', need: { count: 11, avgMin: 72 }, reward: { type: 'token', pack: 'altin', amount: 1 } },
  { id: 'forvet4', title: '4 forvet kartı ver (68+)', need: { count: 4, group: 'FV', minR: 68 }, reward: { type: 'credits', amount: 1500 } },
  { id: 'defans5', title: '5 defans kartı ver', need: { count: 5, group: 'DEF' }, reward: { type: 'token', pack: 'gumus', amount: 1 } },
];

/** Haftanın 4 takas görevi (tohumla sabit). */
export function weeklyExchanges(week) {
  const rng = createRng(`takas:${week}`);
  const list = [...POOL];
  const out = [];
  while (out.length < 4 && list.length) out.push(list.splice(rng.int(0, list.length - 1), 1)[0]);
  return out;
}

/** Verilen kartlar görevi karşılıyor mu (saf). Döner: null (uygun) ya da hata metni. */
export function checkExchange(ex, cards) {
  const n = ex.need;
  if (cards.length !== n.count) return `Bu görev için tam ${n.count} kart seç.`;
  if (n.tier && cards.some((c) => cardTier(Number(c.r)) !== n.tier)) return 'Seçilen kartların katmanı uymuyor.';
  if (n.group && cards.some((c) => c.g !== n.group)) return 'Seçilen kartların mevkisi uymuyor.';
  if (n.minR && cards.some((c) => Number(c.r) < n.minR)) return `Kartlar en az ${n.minR} güçte olmalı.`;
  if (n.sameNation && new Set(cards.map((c) => c.na)).size !== 1) return 'Kartlar aynı ülkeden olmalı.';
  if (n.sameClub && new Set(cards.map((c) => c.ci ?? c.c)).size !== 1) return 'Kartlar aynı kulüpten olmalı.';
  if (n.avgMin && cards.reduce((s, c) => s + Number(c.r), 0) / cards.length < n.avgMin) return `Ortalama güç en az ${n.avgMin} olmalı.`;
  return null;
}
