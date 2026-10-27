// Günlük toplu tahminler: beş tahmin, kayıt, sonuç, erişim (abone / abone olmayan / misafir / açılmış maç), plan.
import test from 'node:test';
import assert from 'node:assert/strict';

import { marketsFromContent, dailyEntry, settleEntry, daySummary, DailyPredictionService, MARKET_IDS } from '../daily.js';
import { markets } from '../content.js';
import { createApi, GUEST_ROUTES } from '../app.js';

const NOW = Date.UTC(2026, 9, 26, 9, 0); // 12:00 TSİ
const H = 3600e3;

const content = {
  ai: {
    pick: '1',
    probabilities: { home: 52, draw: 26, away: 22 },
    sections: [{ title: 'Genel bakış', text: 'Genel.' }, { title: 'Maçın anahtarı', text: 'İlk golü atan maçı kontrol eder.' }],
  },
  model: { lambdaHome: 1.7, lambdaAway: 0.9, sigma: 0 },
};
const match = (id, at, extra = {}) => ({
  id: String(id),
  league: 'demo.1',
  timestamp: at,
  homeId: '1',
  awayId: '2',
  homeName: `Ev ${id}`,
  awayName: `Dep ${id}`,
  homeLogo: 'h.png',
  awayLogo: null,
  completed: false,
  ...extra,
});

function dailyStore() {
  const s = {
    rows: new Map(),
    pending: new Map(),
    unlocks: new Set(),
    async saveDaily(e) {
      if (s.rows.has(e.key)) return false;
      s.rows.set(e.key, JSON.parse(JSON.stringify(e)));
      s.pending.set(e.key, { kickoffMs: e.kickoffMs, league: e.league, eventId: e.eventId });
      return true;
    },
    async listDaily(day) { return [...s.rows.values()].filter((r) => r.day === day).map((r) => JSON.parse(JSON.stringify(r))); },
    async getDaily(k) { return s.rows.get(k) ?? null; },
    async listDailyDue(before, limit) {
      return [...s.pending.entries()].filter(([, v]) => v.kickoffMs < before).slice(0, limit).map(([key, v]) => ({ key, ...v }));
    },
    async saveDailyResult(k, settled) {
      if (settled) Object.assign(s.rows.get(k), settled, { resolved: true });
      s.pending.delete(k);
    },
    async hasUnlock(uid, key, type) { return s.unlocks.has(`${uid}/${key}_${type}`); },
  };
  return s;
}

const summaryJson = ({ home, away, ht = null, completed = true, state = 'post' }) => ({
  header: {
    competitions: [
      {
        status: { type: { state, completed, name: 'STATUS_FULL_TIME' } },
        competitors: [
          { homeAway: 'home', score: String(home), team: { id: '1' }, linescores: ht ? [{ value: ht[0] }] : undefined },
          { homeAway: 'away', score: String(away), team: { id: '2' }, linescores: ht ? [{ value: ht[1] }] : undefined },
        ],
      },
    ],
  },
});

function service({ fixtures = [], now = () => NOW, store = dailyStore(), paid = { contentFor: async () => content } } = {}) {
  const espn = {
    calls: 0,
    async getFixtures(league) {
      espn.calls++;
      return league === 'demo.1' ? fixtures : [];
    },
    summaries: new Map(),
    async getSummary(league, id) {
      const j = espn.summaries.get(id);
      if (!j) throw new Error('yok');
      return j;
    },
  };
  const access = { entitlement: async (uid) => ({ subscribed: uid === 'sub' }) };
  const svc = new DailyPredictionService({ paid, store, espn, access, leagues: ['demo.1', 'demo.2'], now, perTick: 2, log: { error() {} } });
  return { svc, store, espn };
}

test('beş tahmin: MS AI tahminiyle aynı, diğerleri modelin olasılıklarından; oran yok', () => {
  const list = marketsFromContent(content);
  assert.deepEqual(list.map((m) => m.id), MARKET_IDS);
  assert.deepEqual(list[0], { id: 'ms', pick: 'MS 1', pct: 52 });
  const { p } = markets(1.7, 0.9, 0);
  const au = list.find((m) => m.id === 'au');
  assert.equal(au.pick, p.over25 >= 0.5 ? '2.5 Üst' : '2.5 Alt');
  assert.equal(au.pct, Math.round(Math.max(p.over25, 1 - p.over25) * 100));
  for (const m of list) {
    assert.ok(m.pct >= 33 && m.pct <= 100, `${m.id} ${m.pct}`);
    assert.doesNotMatch(m.pick, /oran|bahis/i);
  }
  assert.match(list.find((m) => m.id === 'iyg').pick, /^İY 0\.5 (Üst|Alt)$/);
  assert.equal(marketsFromContent({ ai: content.ai }), null, 'model yoksa hesaplanmaz');
});

test('gerekçe: "Maçın anahtarı" bölümü, uzunsa cümle sonunda kısaltılır', async () => {
  const { reasonOf } = await import('../daily.js');
  assert.equal(reasonOf(content), 'İlk golü atan maçı kontrol eder.');
  const long = 'Bir. '.repeat(80);
  const r = reasonOf({ ai: { sections: [{ title: 'Maçın anahtarı', text: long }] } });
  assert.ok(r.length <= 221 && r.endsWith('.'));
  assert.equal(reasonOf({ ai: { sections: [] } }), null);
});

test('kayıt: Türkiye günü, en güçlü tahmin ve güven', () => {
  const e = dailyEntry(match(5, Date.UTC(2026, 9, 26, 21, 30)), content, NOW); // 27 Ekim 00:30 TSİ
  assert.equal(e.day, '2026-10-27');
  assert.equal(e.key, 'demo_1_5');
  const best = e.markets.reduce((a, b) => (b.pct > a.pct ? b : a));
  assert.equal(e.best, best.id);
  assert.equal(e.confidence, best.pct);
  assert.equal(e.home.logo, 'h.png');
});

test('sonuç: her tahmin tuttu/tutmadı; ertelenen maç geçersiz; bitmemiş maç bekler', () => {
  const e = dailyEntry(match(5, NOW), content, NOW);
  const done = settleEntry(e, { completed: true, postponed: false, home: 2, away: 1, ht: [1, 0] }, NOW + 3 * H);
  assert.equal(done.result.status, 'done');
  assert.equal(done.hits.ms, true);
  assert.equal(done.hits.kg, e.markets.find((m) => m.id === 'kg').pick === 'KG Var');
  assert.equal(done.hits.iy, e.markets.find((m) => m.id === 'iy').pick === 'İY 1');
  const noHt = settleEntry(e, { completed: true, postponed: false, home: 0, away: 0, ht: null }, NOW + 3 * H);
  assert.equal(noHt.hits.iy, null, 'İY skoru bilinmiyorsa karar yok');
  assert.equal(settleEntry(e, { completed: false, postponed: true }, NOW).result.status, 'void');
  assert.equal(settleEntry(e, { completed: false, postponed: false }, NOW + 3 * H), null);
  assert.equal(settleEntry(e, { completed: false, postponed: false }, NOW + 4 * 86400e3).result.status, 'void');
});

test('günün özeti: en güçlü tahminin isabeti, ortalama güven (geçersizler hariç)', () => {
  const rows = [
    { best: 'ms', confidence: 70, result: { status: 'done' }, hits: { ms: true } },
    { best: 'kg', confidence: 60, result: { status: 'done' }, hits: { kg: false } },
    { best: 'au', confidence: 80 },
    { best: 'ms', confidence: 10, result: { status: 'void' } },
  ];
  assert.deepEqual(daySummary(rows), { total: 3, settled: 2, hit: 1, miss: 1, rate: 50, avgConfidence: 70 });
  assert.equal(daySummary([]).rate, null);
});

test('plan: bugün ve yarının maçları; dakikada en fazla perTick; başlamak üzere olan ya da kayıtlı maç atlanır', async () => {
  const fixtures = [
    match(1, NOW + 2 * H),
    match(2, NOW + 3 * H),
    match(3, NOW + 26 * H), // yarın
    match(4, NOW + 2 * 60e3), // 2 dk sonra başlıyor: geç
    match(5, NOW + 4 * 86400e3), // 4 gün sonra: planda yok
    match(6, NOW - H, { completed: true }),
  ];
  const { svc, store, espn } = service({ fixtures });
  assert.equal(await svc.tick(), 2);
  assert.deepEqual([...store.rows.keys()], ['demo_1_1', 'demo_1_2']);
  assert.equal(await svc.tick(), 1);
  assert.ok(store.rows.has('demo_1_3'));
  assert.equal(await svc.tick(), 0);
  assert.equal(espn.calls, 2, 'fikstür lig başına bir kez (plan saklanır)');
});

test('içerik hatası olan maç 30 dakika beklenir, diğerleri sürer', async () => {
  let n = 0;
  const paid = {
    async contentFor(m) {
      n++;
      if (m.id === '1') throw new Error('veri yok');
      return content;
    },
  };
  const { svc, store } = service({ fixtures: [match(1, NOW + 2 * H), match(2, NOW + 3 * H)], paid });
  assert.equal(await svc.tick(), 1);
  assert.ok(store.rows.has('demo_1_2'));
  assert.equal(await svc.tick(), 0);
  assert.equal(n, 2, 'hatalı maç hemen yeniden denenmez');
});

test('sonuç işleme: biten maçlar sonuçlanır, bekleyenden çıkar; liste önbelleği tazelenir', async () => {
  let now = NOW;
  const { svc, store, espn } = service({ fixtures: [match(1, NOW + H), match(2, NOW + 2 * H)], now: () => now });
  await svc.tick();
  const before = await svc.list({ uid: 'sub' });
  assert.equal(before.items.length, 2);
  now = NOW + 4 * H;
  espn.summaries.set('1', summaryJson({ home: 2, away: 1, ht: [1, 0] }));
  espn.summaries.set('2', summaryJson({ home: 0, away: 0, completed: false, state: 'in' }));
  assert.equal(await svc.resolveDue(), 1);
  assert.equal(store.pending.size, 1);
  const after = await svc.list({ uid: 'sub', day: '2026-10-26' });
  const m1 = after.items.find((i) => i.key === 'demo_1_1');
  assert.equal(m1.result.status, 'done');
  assert.equal(m1.markets.find((m) => m.id === 'ms').hit, true);
  assert.equal(after.summary.settled, 1);
});

test('erişim: abone her şeyi görür; abone olmayan ve misafir kilitli; biten maç ve açılmış maç herkese açık', async () => {
  let now = NOW;
  const { svc, store, espn } = service({ fixtures: [match(1, NOW + H), match(2, NOW + 2 * H), match(3, NOW + 3 * H)], now: () => now });
  await svc.tick();
  await svc.tick();
  const sub = await svc.list({ uid: 'sub' });
  assert.equal(sub.subscribed, true);
  assert.ok(sub.items.every((i) => i.open && i.markets.every((m) => m.pick && m.pct)));
  assert.equal(sub.items[0].reason, 'İlk golü atan maçı kontrol eder.');

  const free = await svc.list({ uid: 'u1' });
  assert.ok(free.items.every((i) => !i.open && i.reason === null && i.markets.every((m) => m.pick === null && m.pct === null)));
  assert.ok(free.items.every((i) => i.confidence > 0 && MARKET_IDS.includes(i.best)), 'güven ve en güçlü kutu görünür');

  // Deneme/çark hakkıyla açılmış maç: yalnızca doğrulanan anahtar açılır
  store.unlocks.add('u1/demo_1_2_ai');
  const claimed = await svc.list({ uid: 'u1', unlocked: ['demo_1_2', 'demo_1_3', 'baska_maç'] });
  assert.deepEqual(claimed.items.filter((i) => i.open).map((i) => i.key), ['demo_1_2']);

  // Misafir: bildirse de açılmaz
  const guest = await svc.list({ uid: 'anon', guest: true, unlocked: ['demo_1_2'] });
  assert.ok(guest.items.every((i) => !i.open));

  // Biten maç herkese açılır (karne şeffaf)
  now = NOW + 4 * H;
  espn.summaries.set('1', summaryJson({ home: 1, away: 1, ht: [0, 0] }));
  await svc.resolveDue();
  const later = await svc.list({ uid: 'u1', day: '2026-10-26' });
  assert.equal(later.items.find((i) => i.key === 'demo_1_1').open, true);
  assert.equal(later.items.find((i) => i.key === 'demo_1_3').open, false);
});

test('tarih denetimi: biçim ve aralık; giriş şart', async () => {
  const { svc } = service();
  await assert.rejects(svc.list({ uid: 'u1', day: '26.10.2026' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.list({ uid: 'u1', day: '2026-09-01' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.list({ uid: null }), (e) => e.code === 'permission-denied');
  const empty = await svc.list({ uid: 'u1', day: '2026-10-27' });
  assert.deepEqual(empty.items, []);
});

test('misafir (anonim oturum) yalnızca okuma uçlarını kullanır', async () => {
  const calls = [];
  const api = createApi({
    verifyToken: async (t) => ({ uid: t, anonymous: t === 'anon' }),
    service: { unlock: async (d) => (calls.push(['unlock', d]), { ok: true }), get: async (d) => (calls.push(['get', d]), { ok: true }) },
    coupons: {},
    daily: { list: async (d) => (calls.push(['daily', d]), { items: [] }) },
    log: { error() {} },
  });
  const call = (name, token) =>
    new Promise((resolve) => {
      const req = new (class extends EventTarget {})();
      const chunks = [Buffer.from(JSON.stringify({ data: { league: 'x' } }))];
      Object.assign(req, {
        method: 'POST',
        url: `/api/${name}`,
        headers: { authorization: `Bearer ${token}` },
        on(ev, fn) {
          if (ev === 'data') chunks.forEach((c) => fn(c));
          if (ev === 'end') setImmediate(fn);
          return req;
        },
        destroy() {},
      });
      const res = {
        status: 0,
        writeHead(s) { this.status = s; },
        end(body) { resolve({ status: this.status, body: body ? JSON.parse(body) : null }); },
      };
      api(req, res);
    });
  assert.equal((await call('getDailyPredictions', 'anon')).status, 200);
  assert.equal(calls.at(-1)[1].guest, true, 'misafir bilgisi sunucudan');
  const blocked = await call('unlockContent', 'anon');
  assert.equal(blocked.status, 401);
  assert.match(blocked.body.error.message, /giriş/);
  assert.equal((await call('unlockContent', 'u1')).status, 200);
  assert.equal(calls.at(-1)[1].guest, undefined, 'üyeye misafir bayrağı eklenmez');
  for (const r of ['unlockContent', 'spinWheel', 'assistantAnalyze', 'verifyPlaySubscription', 'unlockCoupon', 'checkIn', 'tts']) {
    assert.equal(GUEST_ROUTES.has(r), false, r);
  }
});

test('takılan maç hesabı hattı durdurmaz; durum özeti hata ve sayıları gösterir', async () => {
  const tomorrow = NOW + 20 * 3600e3;
  const fixtures = [
    { id: '1', league: 'demo.1', timestamp: tomorrow, homeId: 'a', awayId: 'b', homeName: 'A', awayName: 'B', completed: false },
    { id: '2', league: 'demo.1', timestamp: tomorrow + 3600e3, homeId: 'c', awayId: 'd', homeName: 'C', awayName: 'D', completed: false },
  ];
  // Eski önbellek içeriği: model alanı yok → modelFor ile tamamlanır
  const paid = {
    async contentFor(m) {
      if (m.id === '1') throw new Error('ESPN yok');
      return { ...content, model: undefined };
    },
    async modelFor() {
      return content.model;
    },
  };
  const { svc, store } = service({ fixtures, paid });
  assert.equal(await svc.tick(), 1);
  const st = svc.status();
  assert.equal(st.ticks, 1);
  assert.equal(st.made, 1);
  assert.equal(st.failed, 1);
  assert.match(st.lastError, /demo_1_1: ESPN yok/);
  assert.equal(st.busy, false);
  assert.equal(store.rows.size, 1);
});

test('skor tablosu küçültülünce parseEvents aynı maçları verir', async () => {
  const { slimScoreboard, parseEvents } = await import('../engine/espn.js');
  const ev = (id, state, completed, hs, as) => ({
    id,
    uid: 'x',
    date: '2026-10-27T19:45Z',
    name: 'Ev vs Dep',
    season: { year: 2026 },
    status: { clock: 0, type: { state, completed, name: 'STATUS' } },
    links: [{ href: 'https://example.com', text: 'Gamecast' }],
    competitions: [
      {
        id,
        date: '2026-10-27T19:45Z',
        venue: { fullName: 'Stad' },
        broadcasts: [{ names: ['TV'] }],
        details: [{ type: { text: 'Goal' } }],
        status: { type: { state, completed, name: 'STATUS' } },
        competitors: [
          { id: '10', homeAway: 'home', score: hs, statistics: [{ name: 'possessionPct', displayValue: '55' }], team: { id: '10', displayName: 'Ev FK', name: 'Ev', logo: 'https://l/10.png', logos: [{ href: 'https://l/10b.png' }, { href: 'x' }], links: [] } },
          { id: '20', homeAway: 'away', score: as, team: { id: '20', displayName: 'Dep SK', logo: 'https://l/20.png' } },
        ],
      },
    ],
  });
  const json = { leagues: [{ name: 'Lig' }], events: [ev('1', 'post', true, '2', '1'), ev('2', 'pre', false, '0', '0'), { id: 'bozuk' }] };
  const slim = slimScoreboard(json);
  for (const includeUpcoming of [false, true]) {
    assert.deepEqual(parseEvents(slim, { league: 'demo.1', includeUpcoming }), parseEvents(json, { league: 'demo.1', includeUpcoming }));
  }
  assert.ok(JSON.stringify(slim).length < JSON.stringify(json).length);
});
