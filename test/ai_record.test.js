// AI Karnesi (daily.js → recordOf) ve kupon karnesi.
import test from 'node:test';
import assert from 'node:assert/strict';

import { recordOf, RECORD_MARKETS } from '../daily.js';

const row = (key, kickoffMs, best, conf, hits, result = { status: 'done', home: 2, away: 1 }) => ({
  key,
  league: 'tur.1',
  eventId: key,
  kickoffMs,
  home: { name: 'Ev' },
  away: { name: 'Dep' },
  best,
  confidence: conf,
  markets: [
    { id: 'ms', pick: 'MS 1', pct: conf },
    { id: 'au', pick: '2.5 Üst', pct: 60 },
    { id: 'kg', pick: 'KG Var', pct: 58 },
  ],
  result,
  hits,
});

test('recordOf: en güçlü tahmine göre isabet, seri, türler, güven aralıkları', () => {
  const H = 3600e3;
  const byDay = [
    { day: '2026-11-03', rows: [row('a', 10 * H, 'ms', 78, { ms: true, au: true, kg: true }), row('p', 20 * H, 'ms', 70, {}, null)] },
    { day: '2026-11-02', rows: [row('b', 5 * H, 'ms', 66, { ms: true, au: false, kg: true }), row('c', 4 * H, 'au', 60, { ms: false, au: false, kg: false })] },
    { day: '2026-11-01', rows: [row('d', 1 * H, 'ms', 80, { ms: true, au: true, kg: false }), row('v', 2 * H, 'ms', 80, {}, { status: 'void' })] },
  ];
  const r = recordOf(byDay, 30 * H);
  assert.equal(r.settled, 4);
  assert.equal(r.hit, 3);
  assert.equal(r.rate, 75);
  assert.equal(r.streak, 2); // a, b tuttu; c tutmadı
  assert.equal(r.bestStreak, 2);
  assert.deepEqual(r.days.map((d) => d.day), ['2026-11-01', '2026-11-02', '2026-11-03']);
  assert.equal(r.yesterday.day, '2026-11-02');
  assert.equal(r.yesterday.rate, 50);
  const ms = r.markets.find((m) => m.id === 'ms');
  assert.deepEqual([ms.hit, ms.settled], [3, 4]);
  assert.equal(r.markets.length, RECORD_MARKETS.length);
  const hi = r.confidence.find((b) => b.from === 75);
  assert.deepEqual([hi.hit, hi.settled], [2, 2]);
  assert.equal(r.recent[0].key, 'a');
  assert.equal(r.recent[0].score, '2-1');
  assert.equal(r.recent[0].pick, 'MS 1');
  assert.equal(r.recent.find((x) => x.key === 'c').pick, '2.5 Üst');
});

test('recordOf: veri yoksa boş karne', () => {
  const r = recordOf([{ day: '2026-11-03', rows: [] }], 0);
  assert.equal(r.settled, 0);
  assert.equal(r.rate, null);
  assert.equal(r.streak, 0);
});
