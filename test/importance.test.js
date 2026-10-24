import test from 'node:test';
import assert from 'node:assert/strict';

import { importanceOf, derbyOf } from '../importance.js';

test('derbi tanınır (Türkçe karakterler ve sıra fark etmez)', () => {
  assert.equal(derbyOf('Galatasaray', 'Fenerbahçe'), 'Dev derbi');
  assert.equal(derbyOf('Fenerbahçe', 'Beşiktaş'), 'Dev derbi');
  assert.equal(derbyOf('FC Barcelona', 'Real Madrid'), 'El Clásico');
  assert.equal(derbyOf('Kasımpaşa', 'Rizespor'), null);
});

test('lider-ikinci derbisi çok yüksek, hazırlık maçı düşük', () => {
  const big = importanceOf({ league: 'tur.1', homeName: 'Galatasaray', awayName: 'Fenerbahçe', homeRank: 1, awayRank: 2, homePlayed: 20, awayPlayed: 20, teamCount: 18 });
  assert.equal(big.level, 'mega');
  assert.ok(big.tags.includes('derbi') && big.tags.includes('sampiyonluk'));
  const friendly = importanceOf({ league: 'fifa.friendly', homeName: 'A', awayName: 'B' });
  assert.equal(friendly.level, 'low');
  assert.ok(big.score > friendly.score);
});

test('sezon sonuna doğru tablo baskısı artar', () => {
  const at = (played) => importanceOf({ league: 'eng.1', homeName: 'X', awayName: 'Y', homeRank: 18, awayRank: 19, homePlayed: played, awayPlayed: played, teamCount: 20 });
  assert.ok(at(36).score > at(6).score);
  assert.ok(at(36).tags.includes('dusme'));
});

test('tablo bilgisi yoksa yalnızca yarışma ağırlığı; skor 5-100 arasında', () => {
  const r = importanceOf({ league: 'uefa.champions', homeName: 'A', awayName: 'B' });
  assert.ok(r.score >= 60 && r.score <= 100);
  assert.ok(r.reasons.length >= 1);
  for (const league of ['tur.1', 'tur.2', 'xyz.9', 'eng.fa', 'fifa.world']) {
    const x = importanceOf({ league, homeName: 'A', awayName: 'B', homeRank: 1, awayRank: 2, homePlayed: 30, awayPlayed: 30, teamCount: 18 });
    assert.ok(x.score >= 5 && x.score <= 100, `${league}: ${x.score}`);
    assert.ok(['mega', 'high', 'medium', 'low'].includes(x.level));
  }
});
