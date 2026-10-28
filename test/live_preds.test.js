// Hareketli tahminler: dış tahmin verisi değiştikçe günlük tahminlerin güncellenmesi, kilit ve karne.
import test from 'node:test';
import assert from 'node:assert/strict';

import { marketWeight, blendLambdas } from '../engine/blend.js';
import { marketsFromModel, liveUpdate, finalOf, settleEntry, daySummary, dailyEntry, DailyPredictionService, LIVE_LOCK_MS } from '../daily.js';
import { matchProbabilities } from '../engine/analysis.js';
import { marketLambdas } from '../engine/odds.js';
import { MarketCollector } from '../market.js';
import { matchKey } from '../logic.js';

const NOW = Date.UTC(2026, 9, 28, 9, 0);
const H = 3600e3;
const MIN = 60e3;

/** λ'lardan piyasa görüntüsü (gerçek akıştaki gibi 1X2 + alt/üst → marketLambdas). */
function snapFor(lh, la, { at = NOW, n = 3, spread = 0.01 } = {}) {
  const p = matchProbabilities(lh, la);
  const x12 = { home: p.homeWin, draw: p.draw, away: p.awayWin, n, spread };
  const ou = { line: 2.5, over: p.over25, under: 1 - p.over25, n };
  return { at, x12, ou, lambdas: marketLambdas({ x12, ou }), n };
}

const content = {
  ai: { pick: '1', probabilities: { home: 45, draw: 28, away: 27 }, sections: [] },
  model: { lambdaHome: 1.35, lambdaAway: 1.1, sigma: 0.15 },
};
const match = (id, at) => ({ id: String(id), league: 'demo.1', timestamp: at, homeId: '1', awayId: '2', homeName: `Ev ${id}`, awayName: `Dep ${id}`, completed: false });

function store() {
  const s = {
    rows: new Map(),
    pending: new Map(),
    liveWrites: 0,
    async saveDaily(e) {
      if (s.rows.has(e.key)) return false;
      s.rows.set(e.key, structuredClone(e));
      s.pending.set(e.key, { kickoffMs: e.kickoffMs, league: e.league, eventId: e.eventId });
      return true;
    },
    async listDaily(day) {
      return [...s.rows.values()].filter((r) => r.day === day).map((r) => structuredClone(r));
    },
    async getDaily(k) {
      return s.rows.has(k) ? structuredClone(s.rows.get(k)) : null;
    },
    async saveDailyLive(k, live) {
      s.liveWrites++;
      s.rows.get(k).live = structuredClone(live);
    },
    async listDailyDue(before, limit) {
      return [...s.pending.entries()].filter(([, v]) => v.kickoffMs < before).slice(0, limit).map(([key, v]) => ({ key, ...v }));
    },
    async saveDailyResult(k, settled) {
      if (settled) Object.assign(s.rows.get(k), settled, { resolved: true });
      s.pending.delete(k);
    },
    async hasUnlock() {
      return false;
    },
  };
  return s;
}

function service({ now, fixtures, marketLatest = null }) {
  const st = store();
  const espn = { getFixtures: async (lg) => (lg === 'demo.1' ? fixtures : []), getSummary: async () => ({}) };
  const access = { entitlement: async (uid) => ({ subscribed: uid === 'sub' }) };
  const svc = new DailyPredictionService({ paid: { contentFor: async () => content }, store: st, espn, access, leagues: ['demo.1'], now, perTick: 4, log: { error() {} }, marketLatest });
  return { svc, st };
}

test('ağırlık: veri kalitesine göre azalır, eski veri kullanılmaz', () => {
  const s = snapFor(1.6, 1.0);
  assert.equal(marketWeight(s, { now: NOW }), 0.5);
  assert.equal(marketWeight({ ...s, x12: { ...s.x12, n: 1 } }, { now: NOW }), 0.4);
  assert.equal(marketWeight({ ...s, x12: { ...s.x12, spread: 0.1 } }, { now: NOW }), 0.25);
  assert.equal(marketWeight(s, { now: NOW + 13 * H }), 0.25);
  assert.equal(marketWeight(s, { now: NOW + 25 * H }), 0);
  assert.equal(marketWeight(null, { now: NOW }), 0);
  assert.equal(marketWeight({ ...s, lambdas: null }, { now: NOW }), 0);
});

test('birleşim: geometrik ortalama, belirsizlik piyasa payı kadar daralır', () => {
  const b = blendLambdas({ home: 1.2, away: 1.2, sigma: 0.2 }, { home: 1.8, away: 0.8 }, 0.5);
  assert.ok(Math.abs(b.home - Math.sqrt(1.2 * 1.8)) < 1e-9);
  assert.ok(Math.abs(b.away - Math.sqrt(1.2 * 0.8)) < 1e-9);
  assert.ok(Math.abs(b.sigma - 0.1) < 1e-9);
  assert.deepEqual(blendLambdas({ home: 1, away: 1, sigma: 0.1 }, null, 0.5), { home: 1, away: 1, sigma: 0.1, weight: 0 });
});

test('gol beklentilerinden beş tahmin, en güçlüsü ve 1X2', () => {
  const r = marketsFromModel(2.1, 0.7, 0);
  assert.deepEqual(r.markets.map((m) => m.id), ['ms', 'iy', 'au', 'kg', 'iyg']);
  assert.equal(r.markets[0].pick, 'MS 1');
  assert.equal(r.probs.home + r.probs.draw + r.probs.away >= 99, true);
  assert.equal(r.confidence, Math.max(...r.markets.map((m) => m.pct)));
  assert.equal(marketsFromModel(0.7, 2.1).markets[0].pick, 'MS 2');
});

test('canlı güncelleme: piyasa ev sahibini güçlü görünce tahmin ona doğru kayar; kilit ve değişmezlik', () => {
  const entry = dailyEntry(match(1, NOW + 5 * H), content, NOW - H);
  assert.deepEqual(entry.model, { lh: 1.35, la: 1.1, sigma: 0.15 });
  const strong = snapFor(2.2, 0.8);
  const live = liveUpdate(entry, strong, NOW);
  assert.ok(live, 'güncellendi');
  assert.equal(live.rev, 1);
  assert.ok(live.lambdas.home > 1.35 && live.lambdas.away < 1.1);
  assert.ok(live.probs.home > 45);
  assert.equal(live.weight, 0.5);
  // Aynı veriyle ikinci kez: değişiklik yok
  assert.equal(liveUpdate({ ...entry, live }, strong, NOW + MIN), null);
  // Başlamaya bir dakikadan az: kilitli
  assert.equal(liveUpdate(entry, strong, entry.kickoffMs - LIVE_LOCK_MS + 1), null);
  // Model alanı olmayan (eski) kayıt ya da sonuçlanmış maç
  assert.equal(liveUpdate({ ...entry, model: undefined }, strong, NOW), null);
  assert.equal(liveUpdate({ ...entry, result: { status: 'done' } }, strong, NOW), null);
  // Zayıf veri (ağırlık 0) dokunmaz
  assert.equal(liveUpdate(entry, { ...strong, at: NOW - 30 * H }, NOW), null);
});

test('karne kilitlenen son tahmine göre; ilk tahminin sonucu ayrıca saklanır; özet son tahmini kullanır', () => {
  const entry = dailyEntry(match(1, NOW + 5 * H), content, NOW - H);
  const live = liveUpdate(entry, snapFor(0.8, 2.2), NOW);
  assert.equal(live.markets[0].pick, 'MS 2');
  const e = { ...entry, live };
  assert.equal(finalOf(e).markets[0].pick, 'MS 2');
  const settled = settleEntry(e, { completed: true, home: 0, away: 2, ht: [0, 1] }, NOW + 8 * H);
  assert.equal(settled.hits.ms, true);
  assert.equal(settled.firstHits.ms, false, 'ilk tahmin MS 1 idi');
  const sum = daySummary([{ ...e, ...settled }]);
  assert.equal(sum.avgConfidence, live.confidence);
  // Canlı güncelleme yoksa eski davranış
  const plain = settleEntry(entry, { completed: true, home: 2, away: 0, ht: [1, 0] }, NOW + 8 * H);
  assert.equal(plain.hits.ms, true);
  assert.equal(plain.firstHits, undefined);
});

test('servis: yeni tahmin hemen güncel veriyle başlar; liste ilk tahmini, güncelleme saatini ve kilidi gösterir', async () => {
  let now = NOW;
  const m = match(7, NOW + 3 * H);
  const key = matchKey('demo.1', '7');
  const snap = snapFor(2.2, 0.8);
  const { svc, st } = service({ now: () => now, fixtures: [m], marketLatest: (k) => (k === key ? snap : null) });
  await svc.tick();
  assert.equal(st.liveWrites, 1);
  assert.equal(svc.stats.liveUpdates, 1);

  const sub = await svc.list({ uid: 'sub' });
  const it = sub.items[0];
  assert.equal(it.rev, 1);
  assert.ok(it.updatedAt);
  assert.equal(it.locked, false);
  assert.equal(it.confidenceFrom, st.rows.get(key).confidence);
  const ms = it.markets.find((x) => x.id === 'ms');
  assert.deepEqual(ms.from, { pick: 'MS 1', pct: 45 });
  assert.ok(ms.pct > 45);

  // Abone olmayan: tahminler kilitli, ilk tahmin de gönderilmez; güven hareketi görünür
  const free = await svc.list({ uid: 'u1' });
  assert.ok(free.items[0].markets.every((x) => x.pick === null && !('from' in x)));
  assert.equal(free.items[0].confidence, it.confidence);

  // Piyasa geri döner: tahmin de geri hareket eder, liste önbelleği tazelenir
  now += 10 * MIN;
  const back = await svc.applyMarket(key, snapFor(1.3, 1.15, { at: now }));
  assert.equal(back.rev, 2);
  const again = await svc.list({ uid: 'sub' });
  assert.equal(again.items[0].rev, 2);
  assert.ok(again.items[0].markets.find((x) => x.id === 'ms').pct < ms.pct);

  // Başlamadan bir dakika önce kilitlenir
  now = m.timestamp - 30e3;
  assert.equal(await svc.applyMarket(key, snapFor(2.5, 0.6, { at: now })), null);
  assert.equal((await svc.list({ uid: 'sub' })).items[0].locked, true);
  assert.deepEqual(await svc.finalLambdas(key), { home: back.lambdas.home, away: back.lambdas.away, sigma: back.sigma });
});

test('toplayıcı: görüntü değişince tahmin güncellenir; değişmeyen görüntü yeniden yazılmaz', async () => {
  let t = NOW;
  let ml = -150;
  const item = () => ({
    provider: { id: '1' },
    homeTeamOdds: { moneyLine: ml },
    awayTeamOdds: { moneyLine: 420 },
    drawOdds: { moneyLine: 280 },
    overUnder: 2.5,
    overOdds: -120,
    underOdds: 100,
  });
  const writes = [];
  const updates = [];
  const c = new MarketCollector({
    store: {
      getOdds: async () => null,
      saveOdds: async (k) => writes.push(k),
      addCoverage: async () => {},
      listCoverage: async () => [],
    },
    matches: async () => [{ id: '1', league: 'eng.1', timestamp: NOW + 30 * H }],
    sources: [{ name: 'core', fetch: async () => ({ items: [item()] }) }],
    now: () => t,
    log: { warn() {} },
    onUpdate: async (key, snap) => updates.push([key, snap.x12.home]),
  });
  await c.tick();
  assert.equal(updates.length, 1);
  assert.equal(writes.length, 1);
  assert.ok(c.latest(matchKey('eng.1', '1')).x12);
  // 3 saat sonra aynı fiyat: tahmin güncellenmez, kayıt 3 saatlik yazma aralığı dolduğu için bir kez yazılır
  t += 3 * H + MIN;
  await c.tick();
  assert.equal(updates.length, 1);
  assert.equal(writes.length, 2);
  // Fiyat değişir: güncelleme
  ml = -220;
  t += 3 * H + MIN;
  await c.tick();
  assert.equal(updates.length, 2);
  assert.ok(updates[1][1] > updates[0][1]);
  assert.equal(c.stats.updates, 2);
  // Güncelleme hatası toplayıcıyı durdurmaz
  c.onUpdate = async () => {
    throw new Error('yazılamadı');
  };
  ml = -300;
  t += 3 * H + MIN;
  await c.tick();
  assert.equal(writes.length, 4);
  assert.match(c.stats.lastError, /güncelleme/);
});
