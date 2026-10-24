import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamSplit, attackMultiplier } from '../engine/xg.js';

const matches = [
  { homeId: '1', awayId: '2', homeGoals: 2, awayGoals: 1, homeXg: 1.8, awayXg: 0.9 },
  { homeId: '3', awayId: '1', homeGoals: 0, awayGoals: 3, homeXg: 0.7, awayXg: 2.5 },
  { homeId: '1', awayId: '4', homeGoals: 1, awayGoals: 1 },
  { homeId: '5', awayId: '6', homeGoals: 4, awayGoals: 4 },
];

test('takım bakışıyla gol ve xG toplamları; xG olmayan maçlar yalnızca gole eklenir', () => {
  const s = teamSplit(matches, '1');
  assert.equal(s.goalsN, 3);
  assert.equal(s.goalsFor, 2 + 3 + 1);
  assert.equal(s.goalsAgainst, 1 + 0 + 1);
  assert.equal(s.xgN, 2);
  assert.ok(Math.abs(s.xgFor - (1.8 + 2.5)) < 1e-9);
  assert.ok(Math.abs(s.xgAgainst - (0.9 + 0.7)) < 1e-9);
});

test('maç yoksa çarpan nötr (1)', () => {
  assert.equal(attackMultiplier({ goalsFor: 0, goalsN: 0, leagueAvgGoals: 1.4 }), 1);
  assert.equal(teamSplit([], '1').goalsN, 0);
});

test('xG yoksa yalnızca gol oranı kullanılır', () => {
  const m = attackMultiplier({ goalsFor: 14, goalsN: 7, leagueAvgGoals: 1.4 });
  assert.ok(Math.abs(m - 1.42857) < 1e-4);
});

test('xG maç sayısı arttıkça ağırlığı artar', () => {
  const few = attackMultiplier({ goalsFor: 14, goalsN: 7, xgFor: 7, xgN: 1, leagueAvgGoals: 1.4, leagueAvgXg: 1.4 });
  const many = attackMultiplier({ goalsFor: 14, goalsN: 7, xgFor: 7, xgN: 40, leagueAvgGoals: 1.4, leagueAvgXg: 1.4 });
  // Gol oranı ≈ 1,43. xG oranı (7/40)/1,4 ≈ 0,125: çok maçta xG ağırlığı artınca çarpan düşer.
  assert.ok(Math.abs(few - 1.43) < Math.abs(many - 1.43));
  assert.ok(many < 1.43);
});
