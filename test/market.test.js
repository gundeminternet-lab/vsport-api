// Dış tahmin verisi toplayıcı: zamanlama, açılış/son/kapanış, kaynak yedeği, kapsama.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketCollector, refreshEvery, CLOSE_WINDOW } from '../market.js';
import { matchKey } from '../logic.js';

const MIN = 60e3;
const HOUR = 60 * MIN;

function fakeStore() {
  const docs = new Map();
  const cov = new Map();
  return {
    docs,
    cov,
    writes: 0,
    async getOdds(key) {
      return docs.has(key) ? structuredClone(docs.get(key)) : null;
    },
    async saveOdds(key, doc) {
      this.writes++;
      docs.set(key, structuredClone(doc));
    },
    async addCoverage(day, league, inc) {
      const d = cov.get(day) ?? { day, leagues: {} };
      const l = (d.leagues[league] ??= {});
      for (const [k, v] of Object.entries(inc)) l[k] = (l[k] ?? 0) + v;
      cov.set(day, d);
    },
    async listCoverage(days) {
      return days.filter((d) => cov.has(d)).map((d) => cov.get(d));
    },
  };
}

const item = (home, draw, away, extra = {}) => ({
  provider: { id: '1', name: 'K' },
  homeTeamOdds: { moneyLine: home },
  awayTeamOdds: { moneyLine: away },
  drawOdds: { moneyLine: draw },
  overUnder: 2.5,
  overOdds: -120,
  underOdds: 100,
  ...extra,
});

function setup({ matches, core, summary = async () => ({ pickcenter: [] }), t0 = Date.UTC(2026, 9, 28, 9) } = {}) {
  const clock = { t: t0 };
  const store = fakeStore();
  const calls = { core: 0, summary: 0 };
  const sources = [
    { name: 'core', fetch: async (m) => (calls.core++, core(m, clock.t)) },
    { name: 'summary', fetch: async (m) => (calls.summary++, summary(m, clock.t)) },
  ];
  const c = new MarketCollector({ store, matches: async () => matches(clock.t), sources, now: () => clock.t, log: { warn() {} }, isAdmin: async (uid) => uid === 'admin' });
  return { c, store, clock, calls };
}

test('yenileme aralığı başlama saatine yaklaştıkça kısalır', () => {
  assert.equal(refreshEvery(40 * HOUR), 6 * HOUR);
  assert.equal(refreshEvery(10 * HOUR), 3 * HOUR);
  assert.equal(refreshEvery(3 * HOUR), HOUR);
  assert.equal(refreshEvery(30 * MIN), 20 * MIN);
});

test('açılış korunur, son güncellenir, kapanış başlama saatinde alınır ve kapsama sayılır', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const kickoff = t0 + 5 * HOUR;
  const m = { id: '701', league: 'eng.1', timestamp: kickoff, homeName: 'Ev', awayName: 'Dep' };
  let price = -150;
  const { c, store, clock } = setup({ t0, matches: () => [m], core: async () => ({ items: [item(price, 280, 420)] }) });
  const key = matchKey('eng.1', '701');

  assert.equal(await c.tick(), 1);
  const d1 = store.docs.get(key);
  assert.equal(d1.hasOdds, true);
  assert.equal(d1.open.from, 'first');
  assert.equal(d1.source, 'core');
  const openHome = d1.open.x12.home;
  assert.ok(d1.last.lambdas.home > d1.last.lambdas.away, 'favori ev sahibi');
  assert.equal(d1.history.length, 1);

  // Bir saat dolmadan yeniden okunmaz
  clock.t += 30 * MIN;
  assert.equal(await c.tick(), 0);

  // Fiyat değişir: son güncellenir, açılış aynı kalır
  price = -200;
  clock.t += 31 * MIN;
  assert.equal(await c.tick(), 1);
  const d2 = store.docs.get(key);
  assert.equal(d2.open.x12.home, openHome);
  assert.ok(d2.last.x12.home > openHome);
  assert.equal(d2.history.length, 2);
  assert.equal(d2.closed, false);

  // Kapanış penceresine kadar ilerlenir
  while (clock.t < kickoff - 5 * MIN) {
    clock.t += MIN;
    await c.tick();
  }
  const d3 = store.docs.get(key);
  assert.equal(d3.closed, true);
  assert.equal(d3.close.from, 'fetch');
  assert.ok(d3.close.at >= kickoff - CLOSE_WINDOW.before);
  const day = [...store.cov.keys()][0];
  assert.deepEqual(store.cov.get(day).leagues['eng.1'], { matches: 1, withOdds: 1, withX12: 1, withOu: 1, withClose: 1 });

  // Kapanmış maç yeniden okunmaz
  const before = store.writes;
  clock.t += 2 * MIN;
  assert.equal(await c.tick(), 0);
  assert.equal(store.writes, before);
});

test('kaynağın bildirdiği açılış fiyatı ilk görülen değerin yerine geçer', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const m = { id: '9', league: 'esp.1', timestamp: t0 + 20 * HOUR };
  const nested = item(-120, 260, 330, {
    homeTeamOdds: { moneyLine: -120, open: { moneyLine: { american: '+110' } } },
    awayTeamOdds: { moneyLine: 330, open: { moneyLine: { american: '+220' } } },
    drawOdds: { moneyLine: 260, open: { moneyLine: { american: '+240' } } },
  });
  const { c, store } = setup({ t0, matches: () => [m], core: async () => ({ items: [nested] }) });
  await c.tick();
  const d = store.docs.get(matchKey('esp.1', '9'));
  assert.equal(d.open.from, 'source');
  assert.ok(d.open.x12.home < d.last.x12.home, 'açılışta ev sahibi daha az favori');
});

test('core veri vermezse özet kaynağı denenir ve o lig için öne alınır', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const ms = [
    { id: '1', league: 'tur.1', timestamp: t0 + 30 * HOUR },
    { id: '2', league: 'tur.1', timestamp: t0 + 31 * HOUR },
  ];
  const { c, store, calls } = setup({
    t0,
    matches: () => ms,
    core: async () => ({ items: [] }),
    summary: async () => ({ pickcenter: [item(110, 230, 240)] }),
  });
  assert.equal(await c.tick(), 2);
  assert.equal(store.docs.get(matchKey('tur.1', '1')).source, 'summary');
  assert.equal(store.docs.get(matchKey('tur.1', '2')).source, 'summary');
  assert.equal(calls.core, 1, 'ikinci maçta özet doğrudan denenir');
  assert.equal(calls.summary, 2);
});

test('veri yoksa sayılır; kapanışta kapsamaya "verisiz" yazılır; hiç veri vermeyen ligde aralık uzar', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const ms = Array.from({ length: 7 }, (_, i) => ({ id: String(100 + i), league: 'tur.2', timestamp: t0 + (30 + i) * HOUR }));
  const { c, clock, calls } = setup({ t0, matches: () => ms, core: async () => ({ items: [] }) });
  await c.tick();
  assert.equal(c.windowStatus().leagues['tur.2'].checked, 7);
  assert.equal(c.windowStatus().leagues['tur.2'].withOdds, 0);
  assert.equal(calls.summary, 1, 'yedek kaynak lig başına 6 saatte bir');
  // İlk 5 maç lig henüz "verisiz" sayılmadan okunduğu için 6 saat sonra yeniden okunur; sonra aralık 4 katına çıkar
  const before = calls.core;
  clock.t += 6 * HOUR + MIN;
  await c.tick();
  assert.equal(calls.core, before + 5);
  clock.t += 6 * HOUR + MIN;
  await c.tick();
  assert.equal(calls.core, before + 5);
  // Maçlar bitip listeden düşünce kapsamaya verisiz olarak yazılır
  clock.t = ms[6].timestamp + HOUR;
  const store = c.store;
  ms.length = 0;
  await c.tick();
  const rows = [...store.cov.values()].flatMap((d) => Object.entries(d.leagues));
  const sum = rows.reduce((a, [, l]) => ({ matches: a.matches + l.matches, withOdds: a.withOdds + l.withOdds }), { matches: 0, withOdds: 0 });
  assert.deepEqual(sum, { matches: 7, withOdds: 0 });
});

test('kapanış penceresi kaçarsa son değer kullanılır (en fazla 3 saat eskiyse); bitince listeden düşen maç kapanır', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const m = { id: '5', league: 'ita.1', timestamp: t0 + 2 * HOUR };
  let list = [m];
  const { c, store, clock } = setup({ t0, matches: () => list, core: async () => ({ items: [item(-110, 250, 300)] }) });
  await c.tick();
  // Sunucu uyudu: başlama saatinden 1 saat sonra uyanır, maç listeden düşmüş
  clock.t = m.timestamp + HOUR;
  list = [];
  await c.tick();
  const d = store.docs.get(matchKey('ita.1', '5'));
  assert.equal(d.closed, true);
  assert.equal(d.close.from, 'last');
});

test('kaynak hata verirse 15 dk sonra yeniden denenir, hata sayılır', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  let fail = true;
  const m = { id: '8', league: 'ger.1', timestamp: t0 + 30 * HOUR };
  const { c, store, clock } = setup({
    t0,
    matches: () => [m],
    core: async () => {
      if (fail) throw new Error('ağ');
      return { items: [item(120, 240, 210)] };
    },
    summary: async () => {
      throw new Error('ağ');
    },
  });
  await c.tick();
  assert.equal(c.stats.errors, 1);
  assert.equal(store.docs.size, 0);
  fail = false;
  clock.t += 10 * MIN;
  assert.equal(await c.tick(), 0);
  clock.t += 6 * MIN;
  assert.equal(await c.tick(), 1);
  assert.equal(store.docs.get(matchKey('ger.1', '8')).hasOdds, true);
});

test('yeniden başlatmada kayıt okunur: açılış ve kontrol sayısı korunur, kapanmış maç atlanır', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const m1 = { id: '11', league: 'fra.1', timestamp: t0 + 20 * HOUR };
  const m2 = { id: '12', league: 'fra.1', timestamp: t0 + 21 * HOUR };
  const { c, store } = setup({ t0, matches: () => [m1, m2], core: async () => ({ items: [item(-130, 260, 350)] }) });
  const k1 = matchKey('fra.1', '11');
  const k2 = matchKey('fra.1', '12');
  store.docs.set(k1, { key: k1, league: 'fra.1', checks: 3, misses: 0, hasOdds: true, open: { at: 1, x12: { home: 0.4, draw: 0.3, away: 0.3 }, from: 'first' }, history: [], closed: false });
  store.docs.set(k2, { key: k2, closed: true });
  await c.tick();
  const d1 = store.docs.get(k1);
  assert.equal(d1.checks, 4);
  assert.equal(d1.open.x12.home, 0.4);
  assert.equal(store.docs.get(k2).closed, true);
  assert.equal(c.windowStatus().matches, 1);
});

test('yönetici durumu: yetki kontrolü, pencere ve 7 günlük lig kapsaması; kaynak adı yok', async () => {
  const t0 = Date.UTC(2026, 9, 28, 9);
  const m = { id: '21', league: 'eng.1', timestamp: t0 + 3 * MIN };
  const { c } = setup({ t0, matches: () => [m], core: async () => ({ items: [item(-110, 250, 300)] }) });
  await c.tick();
  await assert.rejects(c.adminStatus({ uid: 'u1' }), /yönetici/);
  const s = await c.adminStatus({ uid: 'admin' });
  assert.equal(s.closed, 1);
  assert.equal(s.week.total.matches, 1);
  assert.equal(s.week.total.withOdds, 1);
  assert.equal(s.week.leagues['eng.1'].withClose, 1);
  assert.ok(!JSON.stringify(s).includes('"K"'), 'sağlayıcı adı durumda yer almaz');
  const v = c.status();
  assert.equal(typeof v.fetches, 'number');
  assert.ok(!('windowLeagues' in v));
});

test('ESPN istemcisi: $ref öğeleri izlenir, 404 veri yok sayılır, sonuç önbelleğe yazılmaz', async () => {
  const { EspnClient } = await import('../engine/espn.js');
  const { espnSources } = await import('../market.js');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/events/404/')) return { ok: false, status: 404, json: async () => ({}) };
    if (url.includes('/odds/58')) return { ok: true, status: 200, json: async () => item(-150, 280, 400) };
    if (url.includes('/odds?')) return { ok: true, status: 200, json: async () => ({ count: 2, items: [{ $ref: 'http://sports.core.api.espn.com/v2/x/odds/58' }, item(-140, 270, 390, { provider: { id: '2' } })] }) };
    return { ok: true, status: 200, json: async () => ({ pickcenter: [item(110, 230, 240)], odds: [] }) };
  };
  const espn = new EspnClient({ fetchImpl, retries: 0 });
  const [core, summary] = espnSources(espn);
  const raw = await core.fetch({ league: 'eng.1', id: '77' });
  assert.equal(raw.items.length, 2);
  assert.ok(urls.some((u) => u.startsWith('https://sports.core.api.espn.com/v2/x/odds/58')), 'http → https');
  assert.deepEqual(await core.fetch({ league: 'eng.1', id: '404' }), { items: [] });
  assert.equal((await summary.fetch({ league: 'eng.1', id: '77' })).pickcenter.length, 1);
  assert.equal(espn.cache.size, 0);
});
