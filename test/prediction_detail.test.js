// Tahmin detayı: bütün türler, kartla tutarlılık, gerekçeler, erişim.
import test from 'node:test';
import assert from 'node:assert/strict';

import { predictionDetail, lambdasOf, DETAIL_MARKETS } from '../prediction_detail.js';
import { dailyEntry, finalOf, liveUpdate, DailyPredictionService } from '../daily.js';
import { matchProbabilities } from '../engine/analysis.js';
import { marketLambdas } from '../engine/odds.js';
import { createApi, GUEST_ROUTES } from '../app.js';

const NOW = Date.UTC(2026, 9, 28, 9, 0);
const H = 3600e3;
const content = {
  ai: { pick: '1', probabilities: { home: 52, draw: 25, away: 23 }, sections: [] },
  model: {
    lambdaHome: 1.7,
    lambdaAway: 1.0,
    sigma: 0.12,
    homeRank: 2,
    awayRank: 9,
    homeForm: 'GGBGM',
    awayForm: 'MBGMM',
    homeFormPoints: 10,
    awayFormPoints: 4,
    h2h: { n: 4, homeWins: 2, draws: 1, awayWins: 1 },
    homeGf: 2.0,
    homeGa: 0.8,
    awayGf: 1.1,
    awayGa: 1.6,
    neutral: false,
  },
};
const match = { id: '5', league: 'tur.1', timestamp: NOW + 6 * H, homeId: '1', awayId: '2', homeName: 'Galatasaray', awayName: 'Kasımpaşa' };

test('detay: dokuz tür, seçenekler toplamı ~100, kartın beş tahmini birebir aynı', () => {
  const e = dailyEntry(match, content, NOW);
  const d = predictionDetail(e, finalOf(e), content.model);
  assert.deepEqual(d.markets.map((m) => m.id), DETAIL_MARKETS.map((m) => m.id));
  for (const m of d.markets) {
    if (m.id === 'skor') continue;
    const sum = m.options.reduce((s, o) => s + o.pct, 0);
    // Çifte şans seçenekleri örtüşür (her sonuç iki seçenekte): toplam 200
    const want = m.id === 'cs' ? 200 : 100;
    assert.ok(Math.abs(sum - want) <= 2, `${m.id} toplam ${sum}`);
    assert.ok(m.why.length >= 1, `${m.id} gerekçe`);
  }
  for (const c of e.markets) {
    const m = d.markets.find((x) => x.id === c.id);
    assert.equal(m.pick, c.pick, c.id);
    assert.equal(m.pct, c.pct, c.id);
  }
  const ms = d.markets.find((m) => m.id === 'ms');
  assert.deepEqual(ms.options.map((o) => o.label), ['1', 'X', '2']);
  assert.equal(ms.options[0].caption, 'Galatasaray');
  assert.ok(ms.why.some((w) => w.startsWith('Puan durumu — Galatasaray: 2. sıra')));
  assert.ok(ms.why.some((w) => w.includes('Son 4 karşılaşma')));
  assert.deepEqual(d.expected, { home: 1.7, away: 1 });
  // Takım adına ek getirilmez (ör. "Galatasaray'ın")
  assert.ok(!JSON.stringify(d).includes("Galatasaray'"));
  // Oran / bahis sözcükleri yok
  assert.ok(!/oran|bahis|kupon/i.test(JSON.stringify(d)));
});

test('detay: canlı güncellemede gol beklentileri birleştirilmişten, değişim gerekçede', () => {
  const e = dailyEntry(match, content, NOW);
  const p = matchProbabilities(0.9, 1.9);
  const x12 = { home: p.homeWin, draw: p.draw, away: p.awayWin, n: 3, spread: 0.01 };
  const ou = { line: 2.5, over: p.over25, under: 1 - p.over25 };
  const live = liveUpdate(e, { at: NOW, x12, ou, lambdas: marketLambdas({ x12, ou }) }, NOW);
  const moved = { ...e, live };
  assert.equal(lambdasOf(moved).live, true);
  const d = predictionDetail(moved, finalOf(moved), content.model);
  const ms = d.markets.find((m) => m.id === 'ms');
  assert.equal(ms.pick, live.markets[0].pick);
  assert.ok(ms.why[0].includes('ilk tahmin') || ms.why[0].includes('Güncel verilerle'), ms.why[0]);
});

test('detay: bitmiş maçta her türün tuttu/tutmadı bilgisi; skor ayrıca', () => {
  const e = { ...dailyEntry(match, content, NOW), result: { status: 'done', home: 2, away: 1, ht: [1, 0] } };
  const d = predictionDetail(e, finalOf(e), null);
  const by = Object.fromEntries(d.markets.map((m) => [m.id, m]));
  assert.equal(by.ms.hit, by.ms.pick === 'MS 1');
  assert.equal(by.kg.hit, by.kg.pick === 'KG Var');
  assert.equal(by.au15.hit, by.au15.pick === '1.5 Üst');
  assert.equal(by.skor.hit, by.skor.pick === '2-1');
  // İçerik modeli yoksa yalnızca gol beklentisi gerekçesi
  assert.ok(by.ms.why.every((w) => !w.startsWith('Puan durumu')));
});

test('detay: gol beklentisi olmayan eski kayıt kartın beş tahminiyle döner', () => {
  const e = { ...dailyEntry(match, content, NOW), model: undefined };
  const d = predictionDetail(e, finalOf(e), null);
  assert.equal(d.expected, null);
  assert.equal(d.markets.length, 5);
  assert.ok(d.markets.every((m) => m.options.length === 0));
});

function svc({ subscribed = false, unlocks = new Set() } = {}) {
  const rows = new Map();
  const e = dailyEntry(match, content, NOW);
  rows.set(e.key, e);
  const store = {
    getDaily: async (k) => rows.get(k) ?? null,
    hasUnlock: async (uid, key, type) => unlocks.has(`${uid}/${key}_${type}`),
  };
  const s = new DailyPredictionService({
    paid: { store: { getContent: async () => content } },
    store,
    espn: {},
    access: { entitlement: async (uid) => ({ subscribed: subscribed || uid === 'sub' }) },
    now: () => NOW,
    log: { error() {} },
  });
  return { s, key: e.key, rows };
}

test('servis: abone açık görür; abone olmayan kilitli (yalnızca güven); açılmış maç doğrulanır; misafir kilitli', async () => {
  const { s, key } = svc({ unlocks: new Set(['u2/tur_1_5_ai']) });
  const sub = await s.detail({ uid: 'sub', key });
  assert.equal(sub.open, true);
  assert.equal(sub.markets.length, 9);
  assert.ok(sub.markets.every((m) => m.pick));
  assert.equal(sub.home.name, 'Galatasaray');

  const free = await s.detail({ uid: 'u1', key });
  assert.equal(free.open, false);
  assert.ok(free.confidence > 0);
  assert.ok(free.markets.every((m) => m.pick === null && m.options.length === 0));

  // Açtığını bildirmeyen kilitli kalır; bildiren ve doğrulanan açılır
  assert.equal((await s.detail({ uid: 'u2', key })).open, false);
  assert.equal((await s.detail({ uid: 'u2', key, unlocked: true })).open, true);
  assert.equal((await s.detail({ uid: 'u1', key, unlocked: true })).open, false);
  assert.equal((await s.detail({ uid: 'anon', key, guest: true, unlocked: true })).open, false);

  await assert.rejects(s.detail({ uid: 'sub', key: '../x' }), /Geçersiz/);
  await assert.rejects(s.detail({ uid: 'sub', key: 'tur_1_999' }), /bulunamadı/);
  await assert.rejects(s.detail({ key }), /Giriş/);
});

test('servis: bitmiş maç herkese açık; uç misafire açık (okuma)', async () => {
  const { s, key, rows } = svc();
  rows.get(key).result = { status: 'done', home: 0, away: 0, ht: [0, 0] };
  const d = await s.detail({ uid: 'u1', key });
  assert.equal(d.open, true);
  assert.equal(d.locked, true);
  assert.ok(GUEST_ROUTES.has('getPredictionDetail'));
  const api = createApi({ verifyToken: async () => 'u1', service: {}, coupons: {}, daily: s, log: { error() {} } });
  assert.equal(typeof api, 'function');
});
