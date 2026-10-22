import test from 'node:test';
import assert from 'node:assert/strict';

import { settleMarket, couponOutcome, applyReport, matchFacts, CouponSettler } from '../settle.js';

const f = (home, away, ht = [0, 0]) => ({ home, away, ht });

test('pazarlar', () => {
  assert.equal(settleMarket('MS 1', f(2, 1)), true);
  assert.equal(settleMarket('MS X', f(2, 1)), false);
  assert.equal(settleMarket('Çifte şans X-2', f(1, 1)), true);
  assert.equal(settleMarket('Çifte şans 1-2', f(1, 1)), false);
  assert.equal(settleMarket('KG Var', f(2, 1)), true);
  assert.equal(settleMarket('KG Yok', f(2, 0)), true);
  assert.equal(settleMarket('2.5 Üst', f(2, 1)), true);
  assert.equal(settleMarket('2.5 Alt', f(2, 1)), false);
  assert.equal(settleMarket('1.5 Alt', f(1, 0)), true);
  assert.equal(settleMarket('İY 1', f(2, 1, [1, 0])), true);
  assert.equal(settleMarket('İY 0.5 Üst', f(2, 1, [0, 0])), false);
  assert.equal(settleMarket('İY/MS 1/1', f(2, 1, [1, 0])), true);
  assert.equal(settleMarket('İY/MS X/X', f(1, 1, [1, 0])), false);
  assert.equal(settleMarket('İY 1', { home: 1, away: 0, ht: null }), null);
  assert.equal(settleMarket('Bilinmeyen', f(1, 0)), null);
});

test('düz kupon', () => {
  assert.deepEqual(couponOutcome({ odds: [1.5, 2], results: ['won', 'won'] }), { status: 'won', returnUnits: 3, profit: 2, winningCombos: 1, combos: 1 });
  assert.equal(couponOutcome({ odds: [1.5, 2], results: ['won', 'lost'] }).status, 'lost');
  assert.equal(couponOutcome({ odds: [1.5, 2], results: ['won', 'void'] }).returnUnits, 1.5);
});

test('sistem kupon: 3 maçta 2li', () => {
  // kombinasyonlar: (0,1) (0,2) (1,2) — her birine 1/3 birim
  const o = couponOutcome({ odds: [2, 2, 2], results: ['won', 'won', 'lost'], system: true, sizes: [2] });
  assert.equal(o.combos, 3);
  assert.equal(o.winningCombos, 1);
  assert.equal(o.returnUnits, 1.33);
  assert.equal(o.status, 'won');
  assert.equal(couponOutcome({ odds: [1.2, 1.2, 1.2], results: ['won', 'won', 'lost'], system: true, sizes: [2] }).status, 'partial');
});

test('karne', () => {
  let r = applyReport({}, { status: 'won', profit: 2 }, 2);
  r = applyReport(r, { status: 'won', profit: 1 }, 1.8);
  r = applyReport(r, { status: 'lost', profit: -1 }, 3);
  assert.equal(r.settled, 3);
  assert.equal(r.won, 2);
  assert.equal(r.profitUnits, 2);
  assert.equal(r.streak, 0);
  assert.equal(r.bestStreak, 2);
  assert.deepEqual(r.recent, ['W', 'W', 'L']);
});

const summary = (score, completed, ht) => ({
  header: { competitions: [{ status: { type: { state: completed ? 'post' : 'in', completed } },
    competitors: [
      { homeAway: 'home', score: String(score[0]), team: { id: '1' }, ...(ht ? { linescores: [{ value: ht[0] }] } : {}) },
      { homeAway: 'away', score: String(score[1]), team: { id: '2' }, ...(ht ? { linescores: [{ value: ht[1] }] } : {}) },
    ] }] },
  keyEvents: [{ scoringPlay: true, type: { text: 'Goal' }, clock: { displayValue: "40'" }, team: { id: '1' } }, { scoringPlay: true, type: { text: 'Goal' }, clock: { displayValue: "70'" }, team: { id: '2' } }],
});

test('maç bilgisi: İY skoru linescores ya da gollerden', () => {
  assert.deepEqual(matchFacts(summary([1, 1], true, [1, 0])).ht, [1, 0]);
  assert.deepEqual(matchFacts(summary([1, 1], true)).ht, [1, 0]);
  assert.equal(matchFacts(summary([1, 1], false)).completed, false);
});

test('sonuçlandırıcı: tüm maçlar bitince bir kez kaydeder', async () => {
  const saved = [];
  const now = Date.parse('2026-10-20T12:00:00Z');
  const s = new CouponSettler({
    now: () => now,
    log: { error() {} },
    espn: { getSummary: async (l, id) => (id === '1' ? summary([2, 0], true, [1, 0]) : summary([1, 1], true, [0, 0])) },
    store: {
      listUnsettled: async () => [{ id: 'c1', type: 'single', editorUid: 'e1', editorName: 'Ed' }],
      getPicks: async () => ({ selections: [
        { league: 'tur.1', eventId: '1', kickoff: '2026-10-19T17:00:00Z', market: 'MS 1', odd: 1.5 },
        { league: 'tur.1', eventId: '2', kickoff: '2026-10-19T19:00:00Z', market: 'KG Var', odd: 2 },
      ] }),
      saveResult: async (id, c, result, next) => saved.push({ id, result, report: next({}) }),
    },
  });
  assert.equal(await s.run(), 1);
  assert.equal(saved[0].result.status, 'won');
  assert.deepEqual(saved[0].result.results, ['won', 'won']);
  assert.equal(saved[0].report.won, 1);
});
