// AI günlük kuponlar. Her gün (Türkiye saatiyle 09:00'dan sonra) günün başlamamış maçlarından AI kendisi kurar:
//   banko   : 3 maç, en yüksek gerçekleşme ihtimali
//   ideal   : 3 maç, ihtimal ile oran dengesi (piyasa oranı AI ihtimaline göre değerliyse öne alınır)
//   surpriz : 3 maç, yüksek oran; AI ihtimali piyasanın verdiğinden yüksek olan seçimler
//   iykg    : 4 maç, ilk yarıda karşılıklı gol (İY KG Var) ihtimali en yüksek maçlar
//   iyms    : 3 kupon × 2 maç, ilk yarı / maç sonu dönüşü (1/2 ya da 2/1) ihtimali en yüksek maçlar
//
// Oranlar: dış kaynaktan toplanan fiyatlar (market.js → odds/{matchKey}.providers), sağlayıcılar arası ortanca.
// Kaynakta yalnızca maç sonucu (1-X-2) ve gol çizgisi (alt/üst) vardır; çifte şans 1-X-2 fiyatlarından türetilir.
// Kaynakta karşılığı olmayan seçimlerde (KG, ilk yarı, İY/MS, başka çizgi) oran AI ihtimalinden hesaplanır ve
// "AI oranı" diye işaretlenir. Sağlayıcı adı ya da bağlantısı uygulamaya gönderilmez.
//
// Kupon yayınlandıktan sonra seçimler değişmez (karne şeffaf); oranlar ise maç başlayana kadar izlenir: her okumada
// yayın oranı, açılış oranı ve güncel oran karşılaştırılır, kuponun altında bilgi olarak verilir.
//
// Kayıt (yalnızca sunucu): ai_coupons/{gün} = { day, version, builtAt, pool, coupons: [...] }
// Sonuç: günlük tahmin kayıtlarındaki maç sonucundan (daily_preds → result) okunurken hesaplanır.

import { markets } from './content.js';
import { halfModel } from './special.js';
import { settleMarket } from './settle.js';
import { trDay } from './progress.js';
import { AppError } from './errors.js';

export const AI_COUPON_VERSION = 1;
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Kupon türleri (uygulamadaki sıra). */
export const COUPON_KINDS = [
  { id: 'banko', title: 'Banko', size: 3, count: 1, note: 'Gerçekleşme ihtimali en yüksek seçimler' },
  { id: 'ideal', title: 'İdeal', size: 3, count: 1, note: 'İhtimal ile oran dengesi' },
  { id: 'surpriz', title: 'Sürpriz', size: 3, count: 1, note: 'Yüksek oran; AI ihtimali piyasadan yüksek' },
  { id: 'iykg', title: 'İlk yarı KG Var', size: 4, count: 1, note: 'İlk yarıda iki takımın da gol atma ihtimali en yüksek maçlar' },
  { id: 'iyms', title: 'İY/MS dönüş', size: 2, count: 3, note: 'İlk yarıyı kaybeden maçı kazanır (1/2 · 2/1)' },
];

/** Kuponlar bu saatten sonra kurulur (TR); bu saatten sonra maç az olsa da kurulur. */
export const BUILD_FROM_HOUR = 9;
export const BUILD_ANYWAY_HOUR = 12;
/** Başlamasına bundan az kalan maç kupona girmez. */
const MIN_LEAD_MS = 30 * MIN;
/** Oran değişimi bu kadar ya da fazlaysa "değişti" sayılır. */
export const MOVE_MIN = 0.03;

const r2 = (x) => Math.round(x * 100) / 100;
const okDec = (d) => typeof d === 'number' && Number.isFinite(d) && d > 1.01 && d < 100;
const median = (xs) => {
  const v = xs.filter(okDec).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const trHour = (ms) => new Date(ms + 3 * HOUR).getUTCHours();
const lineText = (l) => String(l).replace('.', ',');
export const oddsText = (d) => (okDec(d) ? d.toFixed(2).replace('.', ',') : '-');

// -----------------------------------------------------------------------------------------------------------------
// Oranlar
// -----------------------------------------------------------------------------------------------------------------

/**
 * odds/{key} kaydından fiyatlar (saf): her an (current/open/close) için sağlayıcılar arası ortanca ondalık oran.
 * Alt/üst fiyatı yalnızca en sık görülen çizgide ortalanır. Döner: { current, open, close, at } (alanlar eksik olabilir).
 */
export function pricesOf(doc) {
  const list = Array.isArray(doc?.providers) ? doc.providers : [];
  const phase = (ph) => {
    const snaps = list.map((p) => p?.[ph]).filter(Boolean);
    if (!snaps.length) return null;
    const counts = new Map();
    for (const s of snaps) if (Number.isFinite(s.total)) counts.set(s.total, (counts.get(s.total) ?? 0) + 1);
    const total = counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5))[0][0] : null;
    const onLine = snaps.filter((s) => s.total === total);
    const out = {
      home: median(snaps.map((s) => s.home)),
      draw: median(snaps.map((s) => s.draw)),
      away: median(snaps.map((s) => s.away)),
      total,
      over: total === null ? null : median(onLine.map((s) => s.over)),
      under: total === null ? null : median(onLine.map((s) => s.under)),
    };
    return Object.values(out).some((v) => v !== null) ? out : null;
  };
  return {
    current: phase('current'),
    open: phase('open'),
    close: phase('close'),
    at: doc?.last?.at ?? doc?.updatedAt ?? null,
    x12: doc?.last?.x12 ?? null,
    ou: doc?.last?.ou ?? null,
  };
}

/** Bir seçimin o andaki piyasa oranı (saf). Yoksa null. Çifte şans 1-X-2 fiyatlarından türetilir. */
export function marketOdds(market, snap) {
  if (!snap) return null;
  const dc = (a, b) => (okDec(a) && okDec(b) ? 1 / (1 / a + 1 / b) : null);
  let x;
  if ((x = /^MS ([1X2])$/.exec(market))) return okDec(snap[{ '1': 'home', X: 'draw', '2': 'away' }[x[1]]]) ? snap[{ '1': 'home', X: 'draw', '2': 'away' }[x[1]]] : null;
  if (market === 'Çifte şans 1-X') return dc(snap.home, snap.draw);
  if (market === 'Çifte şans 1-2') return dc(snap.home, snap.away);
  if (market === 'Çifte şans X-2') return dc(snap.draw, snap.away);
  if ((x = /^(\d\.5) (Üst|Alt)$/.exec(market))) {
    if (Number(x[1]) !== snap.total) return null;
    const v = x[2] === 'Üst' ? snap.over : snap.under;
    return okDec(v) ? v : null;
  }
  return null;
}

/** Piyasanın (pay temizlenmiş) ihtimali: yalnızca 1-X-2, çifte şans ve kaynaktaki çizgi için (saf). */
export function marketProb(market, prices) {
  const x12 = prices?.x12;
  const ou = prices?.ou;
  let x;
  if (x12 && (x = /^MS ([1X2])$/.exec(market))) return x12[{ '1': 'home', X: 'draw', '2': 'away' }[x[1]]] ?? null;
  if (x12 && market === 'Çifte şans 1-X') return x12.home + x12.draw;
  if (x12 && market === 'Çifte şans 1-2') return x12.home + x12.away;
  if (x12 && market === 'Çifte şans X-2') return x12.draw + x12.away;
  if (ou && (x = /^(\d\.5) (Üst|Alt)$/.exec(market)) && Number(x[1]) === ou.line) return x[2] === 'Üst' ? ou.over : ou.under;
  return null;
}

// -----------------------------------------------------------------------------------------------------------------
// Adaylar
// -----------------------------------------------------------------------------------------------------------------

/** Günlük tahmin kaydının son gol beklentileri (canlı güncelleme varsa o). */
export function lambdasOf(entry) {
  const l = entry?.live?.lambdas;
  if (l && Number.isFinite(l.home) && Number.isFinite(l.away)) return { lambdaHome: l.home, lambdaAway: l.away, sigma: entry.live.sigma ?? entry.model?.sigma ?? 0 };
  const m = entry?.model;
  if (m && Number.isFinite(m.lh) && Number.isFinite(m.la)) return { lambdaHome: m.lh, lambdaAway: m.la, sigma: m.sigma ?? 0 };
  return null;
}

/** Seçimin kısa adı ve okunur hâli (takım adlarına ek getirilmez). */
export function pickText(market, H, A) {
  let x;
  if ((x = /^MS ([1X2])$/.exec(market))) return { short: market, label: x[1] === 'X' ? 'Beraberlik' : `${x[1] === '1' ? H : A} kazanır` };
  if ((x = /^Çifte şans ([1X2])-([1X2])$/.exec(market))) {
    const k = `${x[1]}-${x[2]}`;
    return { short: `ÇŞ ${k}`, label: k === '1-X' ? `${H} kaybetmez` : k === 'X-2' ? `${A} kaybetmez` : 'Beraberlik çıkmaz' };
  }
  if ((x = /^İY (\d\.5) (Üst|Alt)$/.exec(market))) return { short: `İY ${lineText(x[1])} ${x[2]}`, label: x[2] === 'Üst' ? 'İlk yarıda gol olur' : 'İlk yarı golsüz biter' };
  if ((x = /^(\d\.5) (Üst|Alt)$/.exec(market))) {
    const l = Number(x[1]);
    return { short: `${lineText(x[1])} ${x[2]}`, label: x[2] === 'Üst' ? `En az ${Math.ceil(l)} gol` : `En çok ${Math.floor(l)} gol` };
  }
  if (market === 'KG Var') return { short: 'KG Var', label: 'İki takım da gol atar' };
  if (market === 'KG Yok') return { short: 'KG Yok', label: 'En az bir takım gol atamaz' };
  if (market === 'İY KG Var') return { short: 'İY KG Var', label: 'İlk yarıda iki takım da gol atar' };
  if ((x = /^İY\/MS ([1X2])\/([1X2])$/.exec(market))) {
    const w = { '1': H, X: 'beraberlik', '2': A };
    return { short: `İY/MS ${x[1]}/${x[2]}`, label: `İlk yarı ${w[x[1]]}, maç sonu ${w[x[2]]}` };
  }
  if ((x = /^İY ([1X2])$/.exec(market))) return { short: market, label: x[1] === 'X' ? 'İlk yarı berabere' : `İlk yarıda önde: ${x[1] === '1' ? H : A}` };
  return { short: market, label: market };
}

/**
 * Bir maçın aday seçimleri (saf): AI ihtimali, oran (piyasa ya da AI), açılış oranı, piyasa ihtimali.
 * group: 'main' (Banko/İdeal/Sürpriz), 'iykg', 'iyms'.
 */
export function candidatesOf(entry, prices) {
  const lam = lambdasOf(entry);
  if (!lam) return [];
  const { p } = markets(lam.lambdaHome, lam.lambdaAway, lam.sigma);
  const half = halfModel(lam);
  const grid = Object.fromEntries(half.grid.map((g) => [g.key, g.p]));
  const H = entry.home?.name ?? '';
  const A = entry.away?.name ?? '';
  const out = [];
  const add = (market, prob, group = 'main') => {
    if (!(prob > 0 && prob < 1)) return;
    const live = marketOdds(market, prices?.current);
    const odds = live ?? Math.max(1.01, 1 / prob);
    out.push({
      market,
      ...pickText(market, H, A),
      group,
      p: prob,
      odds: r2(odds),
      source: live ? 'market' : 'ai',
      openOdds: live ? (r2(marketOdds(market, prices?.open) ?? live)) : null,
      marketP: live ? marketProb(market, prices) : null,
    });
  };
  add('MS 1', p.ms1);
  add('MS X', p.msX);
  add('MS 2', p.ms2);
  add('Çifte şans 1-X', p.ms1 + p.msX);
  add('Çifte şans 1-2', p.ms1 + p.ms2);
  add('Çifte şans X-2', p.msX + p.ms2);
  for (const [l, v] of [[1.5, p.over15], [2.5, p.over25], [3.5, p.over35]]) {
    add(`${l} Üst`, v);
    add(`${l} Alt`, 1 - v);
  }
  add('KG Var', p.kgVar);
  add('KG Yok', 1 - p.kgVar);
  add('İY 0.5 Üst', p.iyOver05);
  add('İY KG Var', half.bttsHt, 'iykg');
  add('İY/MS 1/2', grid['1/2'], 'iyms');
  add('İY/MS 2/1', grid['2/1'], 'iyms');
  return out;
}

// -----------------------------------------------------------------------------------------------------------------
// Kuponlar
// -----------------------------------------------------------------------------------------------------------------

/** Ana kuponların seçim kuralı: ihtimal ve oran aralığı, puan (büyük iyi). */
const RULES = {
  banko: { pMin: 0.66, pMax: 1, oMin: 1.25, oMax: 1.75, score: (c) => c.p + (c.source === 'market' ? 0.03 : 0) },
  ideal: { pMin: 0.5, pMax: 0.72, oMin: 1.4, oMax: 2.4, score: (c) => (c.source === 'market' ? c.p * c.odds : 0.97) + c.p * 0.2 },
  surpriz: { pMin: 0.25, pMax: 0.52, oMin: 2, oMax: 6.5, score: (c) => (c.source === 'market' ? c.p * c.odds : 0.9) + c.p * 0.1 },
};

const selectionOf = (m, c) => ({
  key: m.entry.key,
  league: m.entry.league,
  eventId: m.entry.eventId,
  kickoffMs: m.entry.kickoffMs,
  home: { id: m.entry.home?.id ?? '', name: m.entry.home?.name ?? '', logo: m.entry.home?.logo ?? null },
  away: { id: m.entry.away?.id ?? '', name: m.entry.away?.name ?? '', logo: m.entry.away?.logo ?? null },
  market: c.market,
  short: c.short,
  label: c.label,
  p: Math.round(c.p * 1e4) / 1e4,
  odds: c.odds,
  source: c.source,
  openOdds: c.openOdds,
  marketP: c.marketP === null ? null : Math.round(c.marketP * 1e4) / 1e4,
});

const couponOf = (day, kind, n, selections) => {
  const k = COUPON_KINDS.find((x) => x.id === kind);
  return {
    id: `${day}_${kind}${k.count > 1 ? `_${n + 1}` : ''}`,
    kind,
    title: k.count > 1 ? `${k.title} ${n + 1}` : k.title,
    note: k.note,
    selections,
    totalOdds: r2(selections.reduce((a, s) => a * s.odds, 1)),
    chance: Math.round(selections.reduce((a, s) => a * s.p, 1) * 1e4) / 1e4,
  };
};

/**
 * Günün kuponları (saf). pool: [{ entry, candidates }] (başlamamış maçlar). Ana kuponlarda bir maç yalnız bir kupona
 * girer; İY KG Var ve İY/MS kuponları kendi aralarında maç tekrarlamaz.
 */
export function buildCoupons(day, pool) {
  const coupons = [];
  const used = new Set();
  for (const kind of ['banko', 'ideal', 'surpriz']) {
    const rule = RULES[kind];
    const size = COUPON_KINDS.find((k) => k.id === kind).size;
    const best = [];
    for (const m of pool) {
      if (used.has(m.entry.key)) continue;
      const ok = m.candidates.filter((c) => c.group === 'main' && c.p >= rule.pMin && c.p < rule.pMax && c.odds >= rule.oMin && c.odds <= rule.oMax);
      if (!ok.length) continue;
      const top = ok.reduce((a, b) => (rule.score(b) > rule.score(a) ? b : a));
      best.push({ m, c: top, s: rule.score(top) });
    }
    best.sort((a, b) => b.s - a.s || a.m.entry.kickoffMs - b.m.entry.kickoffMs);
    const take = best.slice(0, size);
    if (take.length < Math.min(size, 2)) continue;
    for (const t of take) used.add(t.m.entry.key);
    coupons.push(couponOf(day, kind, 0, take.sort((a, b) => a.m.entry.kickoffMs - b.m.entry.kickoffMs).map((t) => selectionOf(t.m, t.c))));
  }
  // İlk yarı KG Var: 4 maç
  const kg = pool
    .map((m) => ({ m, c: m.candidates.find((c) => c.market === 'İY KG Var') }))
    .filter((x) => x.c && x.c.p >= 0.06)
    .sort((a, b) => b.c.p - a.c.p)
    .slice(0, 4);
  if (kg.length >= 2) coupons.push(couponOf(day, 'iykg', 0, kg.sort((a, b) => a.m.entry.kickoffMs - b.m.entry.kickoffMs).map((x) => selectionOf(x.m, x.c))));
  // İY/MS dönüş: en olası 6 maç, ikişerli 3 kupon
  const kgKeys = new Set(kg.map((x) => x.m.entry.key));
  const rev = pool
    .map((m) => {
      const opts = m.candidates.filter((c) => c.group === 'iyms');
      return opts.length ? { m, c: opts.reduce((a, b) => (b.p > a.p ? b : a)) } : null;
    })
    .filter((x) => x && x.c.p >= 0.02)
    .sort((a, b) => (kgKeys.has(a.m.entry.key) ? 1 : 0) - (kgKeys.has(b.m.entry.key) ? 1 : 0) || b.c.p - a.c.p)
    .slice(0, 6)
    .sort((a, b) => b.c.p - a.c.p);
  for (let i = 0; i + 1 < rev.length && i < 6; i += 2) {
    const pair = [rev[i], rev[i + 1]].sort((a, b) => a.m.entry.kickoffMs - b.m.entry.kickoffMs);
    coupons.push(couponOf(day, 'iyms', i / 2, pair.map((x) => selectionOf(x.m, x.c))));
  }
  return coupons;
}

// -----------------------------------------------------------------------------------------------------------------
// Görünüm: sonuç, oran hareketi, erişim
// -----------------------------------------------------------------------------------------------------------------

/** Seçimin sonucu (saf): 'won' | 'lost' | 'void' | 'live' | 'pending'. */
export function selectionStatus(sel, entry, now) {
  const r = entry?.result;
  if (r?.status === 'void') return 'void';
  if (r?.status === 'done') {
    const hit = settleMarket(sel.market, { home: r.home, away: r.away, ht: r.ht ?? null });
    return hit === true ? 'won' : hit === false ? 'lost' : 'pending';
  }
  return sel.kickoffMs <= now ? 'live' : 'pending';
}

/** Kuponun durumu (saf): bir seçim kaybettiyse 'lost'; hepsi kazandı/ertelendiyse 'won'; biri sürüyorsa 'live'. */
export function couponStatus(statuses) {
  if (statuses.includes('lost')) return 'lost';
  if (statuses.length && statuses.every((s) => s === 'won' || s === 'void')) return statuses.every((s) => s === 'void') ? 'void' : 'won';
  if (statuses.includes('live') || statuses.includes('won')) return 'live';
  return 'pending';
}

/**
 * Kuponun uygulamaya giden hâli (saf). open: seçimler görünür mü (abone ya da kupon sonuçlandı).
 * pricesFor(key) → pricesOf çıktısı ya da null (maç başladıysa kapanış fiyatı kullanılır).
 */
export function couponView(c, { entries, pricesFor, now, open, locked = new Set() }) {
  const statuses = [];
  const notes = [];
  let nowTotal = 1;
  const selections = c.selections.map((s) => {
    const st = selectionStatus(s, entries.get(s.key), now);
    statuses.push(st);
    let current = null;
    if (s.source === 'market') {
      const pr = pricesFor(s.key);
      const snap = s.kickoffMs <= now ? (pr?.close ?? pr?.current) : pr?.current;
      current = marketOdds(s.market, snap);
      current = current ? r2(current) : null;
    }
    const shown = current ?? s.odds;
    nowTotal *= st === 'void' ? 1 : shown;
    const move = current !== null && Math.abs(current - s.odds) >= MOVE_MIN ? (current > s.odds ? 'up' : 'down') : null;
    if (move) notes.push(`${s.short} (${s.home.name} - ${s.away.name}): oran ${oddsText(s.odds)} → ${oddsText(current)}, ${move === 'up' ? 'yükseldi' : 'düştü'}`);
    const base = {
      key: s.key,
      league: s.league,
      eventId: s.eventId,
      kickoff: new Date(s.kickoffMs).toISOString(),
      home: s.home,
      away: s.away,
      status: st,
      result: entries.get(s.key)?.result?.status === 'done' ? { home: entries.get(s.key).result.home, away: entries.get(s.key).result.away, ht: entries.get(s.key).result.ht ?? null } : null,
    };
    if (locked.has(s.key)) return { ...base, captureLocked: true };
    if (!open) return base;
    return {
      ...base,
      market: s.market,
      short: s.short,
      label: s.label,
      pct: Math.round(s.p * 100),
      odds: s.odds,
      current,
      open: s.openOdds,
      move,
      source: s.source,
      marketPct: s.marketP === null ? null : Math.round(s.marketP * 100),
    };
  });
  const status = couponStatus(statuses);
  const aiOnly = c.selections.filter((s) => s.source === 'ai').length;
  if (open) {
    if (!notes.length && c.selections.some((s) => s.source === 'market')) notes.push('Piyasa oranları yayından beri belirgin değişmedi.');
    if (aiOnly) notes.push(aiOnly === c.selections.length ? 'Bu seçimlerin piyasa oranı kaynakta yok; oranlar AI ihtimalinden hesaplandı (AI oranı).' : `${aiOnly} seçimde piyasa oranı yok; AI ihtimalinden hesaplanan AI oranı gösteriliyor.`);
  }
  const chance = c.chance * 100;
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    note: c.note,
    size: c.selections.length,
    status,
    open,
    chance: chance >= 10 ? Math.round(chance) : Math.round(chance * 10) / 10,
    ...(open ? { totalOdds: c.totalOdds, currentOdds: r2(nowTotal), notes } : {}),
    selections,
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * store: { getCoupons(day) → doc | null, saveCoupons(day, doc) }
 * rows(day) → günlük tahmin kayıtları (daily.js → _rows). odds(key) → odds/{key} kaydı (bellekte ya da Firestore).
 */
export class AiCouponService {
  constructor({ store, rows, odds, access, capture = null, now = () => Date.now(), log = console, cacheMs = 60e3 }) {
    this.store = store;
    this.rows = rows;
    this.odds = odds;
    this.access = access;
    this.capture = capture;
    this.now = now;
    this.log = log;
    this.cacheMs = cacheMs;
    this._days = new Map(); // gün → { at, doc }
    this._prices = new Map(); // key → { at, prices }
    this._building = null;
    this.stats = { builds: 0, lastBuildAt: null, lastError: null };
  }

  async _doc(day, { fresh = false } = {}) {
    const hit = this._days.get(day);
    if (!fresh && hit && this.now() - hit.at < this.cacheMs) return hit.doc;
    const doc = await this.store.getCoupons(day);
    this._days.set(day, { at: this.now(), doc });
    if (this._days.size > 10) this._days.delete(this._days.keys().next().value);
    return doc;
  }

  async _pricesFor(key, maxAgeMs = 2 * MIN) {
    const hit = this._prices.get(key);
    if (hit && this.now() - hit.at < maxAgeMs) return hit.prices;
    let prices = null;
    try {
      const doc = await this.odds(key);
      prices = doc ? pricesOf(doc) : null;
    } catch (e) {
      this.log.warn?.('[ai-coupons] oran okunamadı', key, e?.message ?? e);
      prices = hit?.prices ?? null;
    }
    this._prices.set(key, { at: this.now(), prices });
    if (this._prices.size > 600) this._prices.delete(this._prices.keys().next().value);
    return prices;
  }

  /** Bugünün kuponlarındaki maçlar (oran toplayıcı bu maçları daha sık okur). */
  focusKeys() {
    const doc = this._days.get(trDay(this.now()))?.doc;
    return new Set((doc?.coupons ?? []).flatMap((c) => c.selections.map((s) => s.key)));
  }

  /** Günün kuponlarını kurar (zaten varsa dokunmaz). force: saat beklenmez (yönetici / test). */
  async build({ day = null, force = false } = {}) {
    const now = this.now();
    const d = day ?? trDay(now);
    if (this._building) return this._building;
    this._building = (async () => {
      try {
        const existing = await this._doc(d, { fresh: true });
        if (existing?.coupons) return existing;
        const hour = trHour(now);
        if (!force && d === trDay(now) && hour < BUILD_FROM_HOUR) return null;
        const rows = (await this.rows(d)).filter((e) => !e.result && !e.resolved && e.kickoffMs - now >= MIN_LEAD_MS && trDay(e.kickoffMs) === d);
        if (!force && rows.length < 6 && hour < BUILD_ANYWAY_HOUR) return null;
        if (!rows.length) return null;
        const pool = [];
        for (const entry of rows) {
          const prices = await this._pricesFor(entry.key, 0);
          const candidates = candidatesOf(entry, prices);
          if (candidates.length) pool.push({ entry, candidates });
        }
        const coupons = buildCoupons(d, pool);
        if (!coupons.length) return null;
        const doc = { day: d, version: AI_COUPON_VERSION, builtAt: now, pool: pool.length, coupons };
        await this.store.saveCoupons(d, doc);
        this._days.set(d, { at: now, doc });
        this.stats.builds++;
        this.stats.lastBuildAt = new Date(now).toISOString();
        this.log.info?.(`[ai-coupons] ${d}: ${coupons.length} kupon (${pool.length} maç)`);
        return doc;
      } catch (e) {
        this.stats.lastError = String(e?.message ?? e).slice(0, 200);
        throw e;
      } finally {
        this._building = null;
      }
    })();
    return this._building;
  }

  /** Dakikada bir: bugünün kuponları yoksa kurmayı dener. */
  async tick() {
    const before = this.stats.builds;
    const doc = await this.build().catch((e) => {
      this.log.warn?.('[ai-coupons]', e?.message ?? e);
      return null;
    });
    return this.stats.builds > before ? (doc?.coupons?.length ?? 0) : 0;
  }

  /**
   * Uygulamaya: günün kuponları. day: bugünden 7 gün öncesine kadar. Abone her seçimi ve oranı görür; abone
   * olmayan maçları ve gerçekleşme ihtimalini görür, seçimler kilitlidir (kupon sonuçlanınca herkese açılır).
   */
  async list({ uid, day = null }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const now = this.now();
    const today = trDay(now);
    const d = day ?? today;
    if (!DAY_RE.test(d) || d > today || d < trDay(now - 7 * DAY)) throw new AppError('invalid-argument', 'Geçersiz gün.');
    let doc = await this._doc(d);
    if (!doc && d === today) doc = await this.build().catch(() => null);
    const ent = await this.access.entitlement(uid);
    const subscribed = ent.subscribed === true;
    const base = { day: d, subscribed, kinds: COUPON_KINDS.map(({ id, title, size, count, note }) => ({ id, title, size, count, note })) };
    if (!doc?.coupons?.length) {
      const hour = trHour(now);
      return { ...base, builtAt: null, coupons: [], message: d === today && hour < BUILD_FROM_HOUR ? `Bugünün AI kuponları ${String(BUILD_FROM_HOUR).padStart(2, '0')}:00'da hazırlanır.` : 'Bu gün için AI kuponu yok.' };
    }
    const entries = new Map((await this.rows(d)).map((e) => [e.key, e]));
    const keys = [...new Set(doc.coupons.flatMap((c) => c.selections.map((s) => s.key)))];
    const prices = new Map();
    await Promise.all(
      keys.map(async (k) => {
        const kickoff = entries.get(k)?.kickoffMs ?? 0;
        // Başlamamış maçın oranı 2 dakikada bir, başlamış maçınki bir kez okunur
        prices.set(k, await this._pricesFor(k, kickoff > now ? 2 * MIN : 6 * HOUR));
      }),
    );
    const locked = this.capture ? await this.capture.keysOf(uid) : new Set();
    const coupons = doc.coupons.map((c) => {
      const settled = c.selections.every((s) => {
        const st = selectionStatus(s, entries.get(s.key), now);
        return st === 'won' || st === 'lost' || st === 'void';
      });
      return couponView(c, { entries, pricesFor: (k) => prices.get(k) ?? null, now, open: subscribed || settled, locked });
    });
    const done = coupons.filter((c) => c.status === 'won' || c.status === 'lost');
    return {
      ...base,
      builtAt: new Date(doc.builtAt).toISOString(),
      updatedAt: new Date(now).toISOString(),
      coupons,
      summary: { total: coupons.length, won: done.filter((c) => c.status === 'won').length, lost: done.filter((c) => c.status === 'lost').length },
    };
  }

  status() {
    return { ...this.stats };
  }
}

export function createAiCouponStore(db) {
  return {
    async getCoupons(day) {
      const s = await db.doc(`ai_coupons/${day}`).get();
      return s.exists ? s.data() : null;
    },
    async saveCoupons(day, doc) {
      await db.doc(`ai_coupons/${day}`).set(doc);
    },
  };
}
