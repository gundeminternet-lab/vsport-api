import test from 'node:test';
import assert from 'node:assert/strict';

import { levelOf, applyProgress, checkInDelta, trDay } from '../progress.js';

test('seviye eşikleri', () => {
  assert.deepEqual(levelOf(0), { level: 1, from: 0, to: 100 });
  assert.equal(levelOf(99).level, 1);
  assert.equal(levelOf(100).level, 2);
  assert.equal(levelOf(300).level, 3);
  assert.equal(levelOf(4500).level, 10);
});

test('rozetler bir kez kazanılır', () => {
  let r = applyProgress({}, { predictions: 1, xp: 5 });
  assert.deepEqual(r.earned, ['first_prediction']);
  r = applyProgress(r.stats, { predictions: 1, xp: 5 });
  assert.deepEqual(r.earned, []);
  r = applyProgress({ ...r.stats, exact: 9 }, { exact: 1 });
  assert.deepEqual(r.earned, ['sharp_10']);
  assert.ok(r.stats.badges.includes('first_prediction'));
  // bilinmeyen alanlar yok sayılır
  r = applyProgress(r.stats, { tokens: 1000, xp: 'çok' });
  assert.equal(r.stats.tokens, undefined);
});

test('günlük giriş serisi', () => {
  const day = Date.UTC(2026, 9, 22, 9);
  let c = checkInDelta({}, day);
  assert.equal(c.streak, 1);
  assert.equal(checkInDelta({ lastDay: trDay(day), streak: 1 }, day + 3600e3), null); // aynı gün
  c = checkInDelta({ lastDay: trDay(day), streak: 6 }, day + 86400e3);
  assert.equal(c.streak, 7);
  assert.equal(c.delta.xp, 30); // 10 + 7. gün bonusu 20
  assert.equal(c.delta.streak, 1);
  c = checkInDelta({ lastDay: trDay(day), streak: 6 }, day + 3 * 86400e3);
  assert.equal(c.streak, 1);
  assert.equal(c.delta.streak, -5);
  const { stats } = applyProgress({ streak: 6, bestStreak: 6 }, { streak: 1 });
  assert.equal(stats.bestStreak, 7);
});
