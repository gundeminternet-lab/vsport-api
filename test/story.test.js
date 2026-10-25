import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStory, apportion, storyForContent, STORY_SIMS, DOT_COUNT } from '../story.js';
import { matchProbabilities } from '../engine/analysis.js';

const input = { lambdaHome: 1.1, lambdaAway: 1.6, sigma: 0, homeName: 'Ev', awayName: 'Dep', seed: 'tur_1_1' };

test('aynı tohum aynı hikâyeyi verir; farklı tohum farklı örneklem', () => {
  assert.deepEqual(buildStory(input), buildStory(input));
  assert.notDeepEqual(buildStory(input).outcomes, buildStory({ ...input, seed: 'baska' }).outcomes);
});

test('toplamlar tutarlı: sonuçlar simülasyon sayısına, noktalar 1000e eşit', () => {
  const s = buildStory(input);
  assert.equal(s.sims, STORY_SIMS);
  assert.equal(s.outcomes.home + s.outcomes.draw + s.outcomes.away, STORY_SIMS);
  assert.equal(s.dots.home + s.dots.draw + s.dots.away, DOT_COUNT);
  const fg = s.firstGoal.home + s.firstGoal.away + s.firstGoal.none;
  assert.ok(fg >= 99 && fg <= 101);
});

test('simülasyon yüzdeleri analitik olasılıklara 1,5 puan içinde yakın', () => {
  const s = buildStory(input);
  const pr = matchProbabilities(input.lambdaHome, input.lambdaAway, 0);
  const near = (a, b) => Math.abs(a - b * 100) <= 1.5;
  assert.ok(near(s.pct.home, pr.homeWin), `${s.pct.home} vs ${pr.homeWin}`);
  assert.ok(near(s.pct.draw, pr.draw));
  assert.ok(near(s.pct.away, pr.awayWin));
});

test('en güçlü tahminler %50-95 arasında ve azalan sırada; deplasman favori seçilir', () => {
  const s = buildStory(input);
  assert.equal(s.pick, '2');
  assert.equal(s.coin.team, 'Dep');
  assert.ok(s.confident.length > 0 && s.confident.length <= 6);
  for (let i = 0; i < s.confident.length; i++) {
    assert.ok(s.confident[i].pct >= 50 && s.confident[i].pct <= 95);
    if (i) assert.ok(s.confident[i - 1].pct >= s.confident[i].pct);
  }
  assert.equal(s.checklist.length, 5);
  assert.equal(s.topScores.length, 3);
});

test('metinlerde bahis, oran ya da kupon sözcüğü geçmez', () => {
  const text = JSON.stringify(buildStory(input));
  assert.doesNotMatch(text, /bahis|oran|kupon/i);
});

test('apportion toplamı korur', () => {
  assert.deepEqual(apportion([1, 1, 1], 10).reduce((a, b) => a + b, 0), 10);
  assert.deepEqual(apportion([2, 1, 1], 4), [2, 1, 1]);
});

test('içerikten hikâye: model yoksa null, varsa takım adlarıyla', () => {
  assert.equal(storyForContent({ key: 'k' }), null);
  const s = storyForContent({ key: 'k', model: { lambdaHome: 1.5, lambdaAway: 1.0, sigma: 0 }, home: { name: 'A' }, away: { name: 'B' } });
  assert.equal(s.coin.team, 'A');
});
