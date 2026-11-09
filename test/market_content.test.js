// AI içeriği (analiz, simülasyon, Özel Yorum) günlük tahminle aynı birleşik modeli kullanır; maç başlamadan önce dış
// tahmin verisi belirgin değişirse içerik yeniden üretilir. Tek senaryo: analizin skoru = simülasyonun son skoru.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DemoEspn } from '../engine/demo.js';
import { PaidContentService, matchKey } from '../logic.js';
import { makeStore } from './helpers.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0);
const KICKOFF = NOW + 2 * 86400000;
const MIN = 60e3;

const match = { id: '9001', timestamp: KICKOFF, date: new Date(KICKOFF).toISOString(), league: 'demo.1', homeId: '1001', awayId: '1002', homeName: 'Demo Ev FK', awayName: 'Demo Dep SK', completed: false };
const KEY = matchKey('demo.1', '9001');

function setup() {
  const clock = { now: NOW };
  const espn = new DemoEspn({ now: NOW });
  espn.getFixtures = async () => [];
  const store = makeStore();
  store.replaces = 0;
  store.replaceContent = async (k, c) => {
    store.replaces++;
    store.contents.set(k, JSON.parse(JSON.stringify(c)));
    return store.contents.get(k);
  };
  const feed = { snap: null };
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn, now: () => clock.now, market: (k) => (k === KEY ? feed.snap : null) });
  return { svc, store, feed, clock };
}

const snapOf = (home, away, at) => ({ at, x12: { n: 3, spread: 0.01 }, lambdas: { home, away, error: 0.005 } });

test('dış tahmin verisi varsa içerik birleşik modelle üretilir; taban model ayrıca saklanır', async () => {
  const { svc, feed, clock } = setup();
  feed.snap = snapOf(2.4, 0.7, clock.now - 10 * MIN);
  const c = await svc.contentFor(match);
  const m = c.model;
  assert.ok(m.base && Number.isFinite(m.base.lambdaHome), 'taban (yalnızca model) değerler saklanır');
  assert.ok(m.marketWeight > 0.7 && m.marketWeight <= 0.9, `ağırlık ${m.marketWeight}`);
  // Geometrik karışım: sonuç taban ile piyasa arasında, piyasaya yakın
  const between = (x, a, b) => x >= Math.min(a, b) - 1e-6 && x <= Math.max(a, b) + 1e-6;
  assert.ok(between(m.lambdaHome, m.base.lambdaHome, 2.4));
  assert.ok(between(m.lambdaAway, m.base.lambdaAway, 0.7));
  assert.ok(Math.abs(Math.log(m.lambdaHome / 2.4)) < Math.abs(Math.log(m.base.lambdaHome / 2.4)) + 1e-9);
  // Tek senaryo: AI analizinin skoru, simülasyonun son skoru
  assert.equal(c.ai.topScore, `${c.sim.finalScore.home}-${c.sim.finalScore.away}`);
});

test('piyasa belirgin değişirse maç öncesi içerik yeniden üretilir; küçük ya da çok yeni değişim içeriği bozmaz', async () => {
  const { svc, store, feed, clock } = setup();
  feed.snap = snapOf(1.4, 1.2, clock.now - 5 * MIN);
  const first = await svc.contentFor(match);
  assert.equal(store.saves, 1);

  // 10 dk sonra büyük değişim: en sık 30 dk'da bir yenilenir
  clock.now += 10 * MIN;
  feed.snap = snapOf(2.6, 0.6, clock.now);
  assert.equal((await svc.contentFor(match)).createdAt, first.createdAt);
  assert.equal(store.replaces, 0);

  // 40 dk sonra yeni görüntüde aynı değişim: yeniden üretilir
  clock.now += 30 * MIN;
  feed.snap = snapOf(2.6, 0.6, clock.now);
  const second = await svc.contentFor(match);
  assert.equal(store.replaces, 1);
  assert.notEqual(second.createdAt, first.createdAt);
  assert.ok(second.model.lambdaHome > first.model.lambdaHome);

  // Neredeyse aynı piyasa: yenilenmez
  clock.now += 40 * MIN;
  feed.snap = snapOf(2.61, 0.6, clock.now);
  await svc.contentFor(match);
  assert.equal(store.replaces, 1);

  // Maç başladıktan sonra içerik değişmez
  clock.now = KICKOFF + 5 * MIN;
  feed.snap = snapOf(0.5, 3, clock.now);
  const after = await svc.contentFor(match);
  assert.equal(after.createdAt, second.createdAt);
  assert.equal(store.replaces, 1);
});

test('dış tahmin verisi yoksa ya da bayatsa içerik yalnızca modelle üretilir', async () => {
  const { svc, feed, clock } = setup();
  feed.snap = snapOf(2.4, 0.7, clock.now - 30 * 3600e3);
  const c = await svc.contentFor(match);
  assert.equal(c.model.marketWeight, 0);
  assert.equal(c.model.lambdaHome, c.model.base.lambdaHome);
});
