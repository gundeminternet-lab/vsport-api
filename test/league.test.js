import test from 'node:test';
import assert from 'node:assert/strict';

import { scorePrediction, periodIds, previousWeekId } from '../league.js';

test('tahmin puanları', () => {
  const f = { home: 2, away: 1 };
  assert.deepEqual(scorePrediction({ home: 2, away: 1 }, f), { points: 5, exact: true });
  assert.equal(scorePrediction({ home: 3, away: 2 }, f).points, 3); // gol farkı
  assert.equal(scorePrediction({ home: 1, away: 0 }, f).points, 3);
  assert.equal(scorePrediction({ home: 3, away: 0 }, f).points, 2); // yalnızca sonuç
  assert.equal(scorePrediction({ home: 1, away: 1 }, f).points, 0);
  assert.equal(scorePrediction({ home: 0, away: 0 }, { home: 1, away: 1 }).points, 2); // beraberlik: fark puanı yok
  assert.equal(scorePrediction({ home: 'a', away: 1 }, f).points, 0);
});

test('dönemler Türkiye saatine göre', () => {
  // Pazar 22:30 UTC = Pazartesi 01:30 TR → yeni hafta
  assert.deepEqual(periodIds(Date.UTC(2026, 9, 25, 22, 30)), { week: 'w2026-44', month: 'm2026-10', all: 'all' });
  assert.equal(periodIds(Date.UTC(2026, 9, 25, 20, 0)).week, 'w2026-43');
  assert.equal(periodIds(Date.UTC(2026, 9, 31, 21, 30)).month, 'm2026-11');
  assert.equal(previousWeekId(Date.UTC(2026, 9, 27, 9, 0)), 'w2026-43');
});
