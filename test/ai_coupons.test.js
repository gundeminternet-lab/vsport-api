// AI günlük kuponlar (ai_coupons.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pricesOf,
  marketOdds,
  marketProb,
  candidatesOf,
  buildCoupons,
  couponView,
  selectionStatus,
  couponStatus,
  AiCouponService,
  COUPON_KINDS,
} from '../ai_coupons.js';
import { settleMarket } from '../settle.js';
import { trDay } from '../progress.js';

const H = 3600e3;
// 2026-11-03 10:00 TR (07:00 UTC)
const NOW = Date.UTC(2026, 10, 3, 7, 0, 0);
const DAYKEY = trDay(NOW);

const LAMBDAS = [
  [2.4, 0.7], [1.9, 1.0], [1.5, 1.3], [1.2, 1.2], [0.9, 1.8], [2.1, 1.6], [1.4, 0.8], [1.1, 1.0],
  [1.7, 1.5], [2.8, 1.1], [1.0, 2.2], [1.6, 1.9], [1.3, 0.9], [2.0, 2.0],
];
const entries = LAMBDAS.map(([lh, la], i) => ({
  key: `demo_1_${9000 + i}`,
  league: 'demo.1',
  eventId: String(9000 + i),
  kickoffMs: NOW + (2 + (i % 8)) * H,
  home: { id: `h${i}`, name: `Ev${i} Spor` },
  away: { id: `a${i}`, name: `Dep${i} Spor` },
  model: { lh, la, sigma: 0.1 },
}));

const providerDoc = (h, d, a, total = 2.5, over = 1.9, under = 1.9, open = null) => ({
  last: { at: NOW - 10 * 60e3, x12: { home: 1 / h / (1 / h + 1 / d + 1 / a), draw: 1 / d / (1 / h + 1 / d + 1 / a), away: 1 / a / (1 / h + 1 / d + 1 / a) }, ou: { line: total, over: 0.5, under: 0.5 } },
  providers: [
    { current: { home: h, draw: d, away: a, total, over, under }, open: open ?? { home: h, draw: d, away: a, total, over, under } },
    { current: { home: h + 0.04, draw: d + 0.1, away: a - 0.05, total, over: over + 0.02, under: under - 0.02 }, open: null },
    { current: { home: h - 0.02, draw: d, away: a + 0.05, total: 3.5, over: 2.8, under: 1.4 }, open: null },
  ],
});

test('oranlar: sağlayıcılar arası ortanca, gol çizgisi en sık görülen; çifte şans 1-X-2 fiyatlarından', () => {
  const pr = pricesOf(providerDoc(1.5, 4.2, 6.5));
  assert.equal(pr.current.home, 1.5);
  assert.equal(pr.current.total, 2.5);
  assert.ok(Math.abs(pr.current.over - 1.91) < 1e-9);
  assert.equal(marketOdds('MS 1', pr.current), 1.5);
  assert.equal(marketOdds('MS X', pr.current), 4.2);
  assert.ok(Math.abs(marketOdds('Çifte şans 1-X', pr.current) - 1 / (1 / 1.5 + 1 / 4.2)) < 1e-9);
  assert.ok(marketOdds('2.5 Üst', pr.current) > 1.8);
  assert.equal(marketOdds('3.5 Üst', pr.current), null, 'kaynaktaki çizgi 2,5');
  assert.equal(marketOdds('KG Var', pr.current), null);
  assert.ok(marketProb('MS 1', pr) > 0.6);
  assert.equal(pricesOf(null).current, null);
});

test('adaylar: bütün türler; piyasa oranı yoksa AI oranı = 1/ihtimal', () => {
  const pr = pricesOf(providerDoc(1.45, 4.5, 7));
  const list = candidatesOf(entries[0], pr);
  const ids = list.map((c) => c.market);
  for (const m of ['MS 1', 'MS X', 'MS 2', 'Çifte şans 1-X', '2.5 Üst', '1.5 Üst', 'KG Var', 'İY 0.5 Üst', 'İY KG Var', 'İY/MS 1/2', 'İY/MS 2/1']) assert.ok(ids.includes(m), m);
  const ms1 = list.find((c) => c.market === 'MS 1');
  assert.equal(ms1.source, 'market');
  assert.equal(ms1.odds, 1.45);
  const kg = list.find((c) => c.market === 'KG Var');
  assert.equal(kg.source, 'ai');
  assert.ok(Math.abs(kg.odds - Math.round((1 / kg.p) * 100) / 100) < 1e-9);
  const noOdds = candidatesOf(entries[0], null);
  assert.ok(noOdds.every((c) => c.source === 'ai'));
  // İhtimaller tutarlı
  const p = (m) => list.find((c) => c.market === m).p;
  assert.ok(Math.abs(p('MS 1') + p('MS X') + p('MS 2') - 1) < 1e-6);
  assert.ok(p('İY KG Var') < p('KG Var'));
  assert.ok(p('İY/MS 2/1') < 0.2);
});

test('günün kuponları: Banko / İdeal / Sürpriz 3 maç, İY KG Var 4 maç, İY/MS 3 kupon × 2 maç', () => {
  const pool = entries.map((e, i) => ({ entry: e, candidates: candidatesOf(e, i % 2 ? pricesOf(providerDoc(1.6 + i * 0.2, 3.8, 5 - i * 0.2)) : null) }));
  const coupons = buildCoupons(DAYKEY, pool);
  const by = (k) => coupons.filter((c) => c.kind === k);
  assert.equal(by('banko').length, 1);
  assert.equal(by('ideal').length, 1);
  assert.equal(by('surpriz').length, 1);
  assert.equal(by('iykg').length, 1);
  assert.equal(by('iyms').length, 3);
  assert.equal(by('banko')[0].selections.length, 3);
  assert.equal(by('iykg')[0].selections.length, 4);
  for (const c of by('iyms')) {
    assert.equal(c.selections.length, 2);
    for (const s of c.selections) assert.match(s.market, /^İY\/MS (1\/2|2\/1)$/);
  }
  for (const s of by('iykg')[0].selections) assert.equal(s.market, 'İY KG Var');
  // Ana kuponlarda maç tekrarlanmaz; İY/MS kuponları da kendi arasında
  const main = ['banko', 'ideal', 'surpriz'].flatMap((k) => by(k)[0].selections.map((s) => s.key));
  assert.equal(new Set(main).size, main.length);
  const rev = by('iyms').flatMap((c) => c.selections.map((s) => s.key));
  assert.equal(new Set(rev).size, rev.length);
  // Banko ihtimali en yüksek, Sürpriz oranı en yüksek
  assert.ok(by('banko')[0].chance > by('ideal')[0].chance && by('ideal')[0].chance > by('surpriz')[0].chance);
  assert.ok(by('surpriz')[0].totalOdds > by('banko')[0].totalOdds);
  for (const s of by('banko')[0].selections) assert.ok(s.p >= 0.66);
  for (const c of coupons) {
    const prod = Math.round(c.selections.reduce((a, s) => a * s.odds, 1) * 100) / 100;
    assert.equal(c.totalOdds, prod);
    for (const s of c.selections) {
      assert.ok(!/undefined|NaN|null/.test(`${s.short} ${s.label}`), `${s.short} ${s.label}`);
      assert.ok(!/(Ev\d+ Spor|Dep\d+ Spor)('|’)/.test(s.label));
    }
  }
  assert.deepEqual(COUPON_KINDS.map((k) => k.id), ['banko', 'ideal', 'surpriz', 'iykg', 'iyms']);
});

test('ilk yarı KG var sonucu ve kupon durumu', () => {
  assert.equal(settleMarket('İY KG Var', { home: 2, away: 1, ht: [1, 1] }), true);
  assert.equal(settleMarket('İY KG Var', { home: 2, away: 1, ht: [1, 0] }), false);
  assert.equal(settleMarket('İY KG Var', { home: 2, away: 1, ht: null }), null);
  assert.equal(settleMarket('İY/MS 1/2', { home: 1, away: 2, ht: [1, 0] }), true);
  const sel = { market: 'MS 1', kickoffMs: NOW - 3 * H };
  assert.equal(selectionStatus(sel, { result: { status: 'done', home: 2, away: 0, ht: [1, 0] } }, NOW), 'won');
  assert.equal(selectionStatus(sel, { result: { status: 'void' } }, NOW), 'void');
  assert.equal(selectionStatus(sel, {}, NOW), 'live');
  assert.equal(selectionStatus({ ...sel, kickoffMs: NOW + H }, {}, NOW), 'pending');
  assert.equal(couponStatus(['won', 'lost', 'pending']), 'lost');
  assert.equal(couponStatus(['won', 'void']), 'won');
  assert.equal(couponStatus(['won', 'pending']), 'live');
  assert.equal(couponStatus(['pending', 'pending']), 'pending');
});

test('kupon görünümü: oran hareketi bilgisi, AI oranı notu, kilitli ve ekran görüntüsü kilitli seçimler', () => {
  const e = entries[0];
  const pr0 = pricesOf(providerDoc(1.5, 4.2, 6.5));
  const cands = candidatesOf(e, pr0);
  const ms1 = cands.find((c) => c.market === 'MS 1');
  const kg = cands.find((c) => c.market === 'KG Var');
  const coupon = {
    id: 'x',
    kind: 'banko',
    title: 'Banko',
    note: '',
    totalOdds: 2,
    chance: 0.5,
    selections: [
      { key: e.key, league: e.league, eventId: e.eventId, kickoffMs: e.kickoffMs, home: e.home, away: e.away, market: 'MS 1', short: 'MS 1', label: 'x', p: ms1.p, odds: 1.5, source: 'market', openOdds: 1.55, marketP: 0.6 },
      { key: entries[1].key, league: 'demo.1', eventId: entries[1].eventId, kickoffMs: entries[1].kickoffMs, home: entries[1].home, away: entries[1].away, market: 'KG Var', short: 'KG Var', label: 'y', p: kg.p, odds: kg.odds, source: 'ai', openOdds: null, marketP: null },
    ],
  };
  const moved = pricesOf(providerDoc(1.38, 4.6, 7.5));
  const v = couponView(coupon, { entries: new Map(), pricesFor: (k) => (k === e.key ? moved : null), now: NOW, open: true });
  assert.equal(v.selections[0].current, 1.38);
  assert.equal(v.selections[0].move, 'down');
  assert.ok(v.notes.some((n) => /MS 1 .*oran 1,50 → 1,38, düştü/.test(n)), v.notes.join(' | '));
  assert.ok(v.notes.some((n) => /AI oranı/.test(n)));
  assert.equal(v.currentOdds, Math.round(1.38 * kg.odds * 100) / 100);
  assert.equal(v.status, 'pending');
  // Abone değil: seçim ve oran yok, maçlar ve ihtimal var
  const lockedView = couponView(coupon, { entries: new Map(), pricesFor: () => null, now: NOW, open: false });
  assert.equal(lockedView.selections[0].market, undefined);
  assert.equal(lockedView.totalOdds, undefined);
  assert.equal(lockedView.chance, 50);
  assert.equal(lockedView.selections[0].home.name, e.home.name);
  // Ekran görüntüsü kilidi
  const cap = couponView(coupon, { entries: new Map(), pricesFor: () => null, now: NOW, open: true, locked: new Set([e.key]) });
  assert.equal(cap.selections[0].captureLocked, true);
  assert.equal(cap.selections[0].market, undefined);
  assert.equal(cap.selections[1].market, 'KG Var');
});

test('servis: 09:00 öncesi kurulmaz; sonra bir kez kurulur; abone tümünü, abone olmayan kilitli görür', async () => {
  let now = Date.UTC(2026, 10, 3, 4, 0, 0); // 07:00 TR
  const saved = new Map();
  const subs = new Set(['pro']);
  const rowsDay = entries.map((e) => ({ ...e, kickoffMs: Date.UTC(2026, 10, 3, 13 + (Number(e.eventId) % 7), 0, 0) }));
  const svc = new AiCouponService({
    store: { getCoupons: async (d) => saved.get(d) ?? null, saveCoupons: async (d, doc) => saved.set(d, doc) },
    rows: async () => rowsDay,
    odds: async (key) => (Number(key.slice(-1)) % 2 ? providerDoc(1.7, 3.6, 4.8) : null),
    access: { entitlement: async (uid) => ({ subscribed: subs.has(uid) }) },
    now: () => now,
    cacheMs: 0,
    log: {},
  });
  assert.equal(await svc.tick(), 0);
  const early = await svc.list({ uid: 'u' });
  assert.equal(early.coupons.length, 0);
  assert.match(early.message, /09:00/);
  now = Date.UTC(2026, 10, 3, 7, 0, 0); // 10:00 TR
  const n = await svc.tick();
  assert.ok(n >= 7, `kupon sayısı ${n}`);
  assert.equal(await svc.tick(), 0, 'ikinci kez kurulmaz');
  const pro = await svc.list({ uid: 'pro' });
  assert.equal(pro.subscribed, true);
  assert.ok(pro.coupons.every((c) => c.open && c.selections.every((s) => s.market)));
  assert.ok(pro.coupons.some((c) => c.selections.some((s) => s.source === 'market')));
  const free = await svc.list({ uid: 'free' });
  assert.ok(free.coupons.every((c) => !c.open && c.selections.every((s) => s.market === undefined)));
  assert.ok(svc.focusKeys().size >= 6);
  await assert.rejects(svc.list({ uid: 'pro', day: '2026-12-01' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.list({ uid: '' }), (e) => e.code === 'permission-denied');
});
