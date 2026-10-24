import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCorners, nbPmf, cornerDistribution, expectedCorners, modelCorners, collectCornerSamples } from '../engine/corners.js';

const summary = (a, b) => ({
  boxscore: {
    teams: [
      { team: { id: '1' }, statistics: [{ name: 'wonCorners', displayValue: String(a) }] },
      { team: { id: '2' }, statistics: [{ name: 'wonCorners', displayValue: String(b) }] },
    ],
  },
});

test('maç özetinden korner sayıları okunur; eksik ya da bozuk veri null döner', () => {
  assert.deepEqual(parseCorners(summary(6, 3)), { 1: 6, 2: 3 });
  assert.equal(parseCorners({}), null);
  assert.equal(parseCorners({ boxscore: { teams: [{ team: { id: '1' }, statistics: [{ name: 'wonCorners', displayValue: 'x' }] }] } }), null);
  assert.equal(parseCorners(summary(99, 3)), null, 'olağan dışı değer reddedilir');
});

test('negatif binom: toplam 1, ortalama beklentiye yakın', () => {
  const p = nbPmf(5);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const mean = p.reduce((s, x, k) => s + x * k, 0);
  assert.ok(Math.abs(mean - 5) < 0.05, `ortalama ${mean}`);
  // Poisson'a göre daha geniş: varyans > ortalama
  const variance = p.reduce((s, x, k) => s + x * (k - mean) ** 2, 0);
  assert.ok(variance > 5);
});

test('korner dağılımı: çizgiler azalan, alt+üst=1, takım karşılaştırması tutarlı', () => {
  const d = cornerDistribution(6, 4);
  for (let i = 1; i < d.lines.length; i++) assert.ok(d.lines[i].over < d.lines[i - 1].over);
  for (const l of d.lines) assert.ok(Math.abs(l.over + l.under - 1) < 1e-9);
  assert.ok(Math.abs(d.homeMore + d.equal + d.awayMore - 1) < 1e-9);
  assert.ok(d.homeMore > d.awayMore);
  assert.ok(d.range.p > 0.25 && d.range.to - d.range.from === 2);
  // Ortalama toplam 10 → 9,5 üst %50 civarı
  const l95 = cornerDistribution(5, 5).lines.find((l) => l.line === 9.5);
  assert.ok(l95.over > 0.4 && l95.over < 0.6);
});

test('model korneri: üstün taraf daha çok korner kullanır, toplam makul', () => {
  const m = modelCorners(2.2, 0.8);
  assert.ok(m.home > m.away);
  const even = modelCorners(1.45, 1.15);
  assert.ok(Math.abs(even.home + even.away - 10) < 0.5);
});

test('beklenti: yeterli örnek yoksa model, varsa veri ağırlıklı', () => {
  const none = expectedCorners({ lambdaHome: 1.5, lambdaAway: 1.1 });
  assert.equal(none.source, 'model');
  const few = expectedCorners({ lambdaHome: 1.5, lambdaAway: 1.1, homeSamples: [{ for: 8, against: 2 }], awaySamples: [] });
  assert.equal(few.source, 'model');

  const many = (f, a) => Array.from({ length: 8 }, () => ({ for: f, against: a }));
  const data = expectedCorners({ lambdaHome: 1.5, lambdaAway: 1.1, homeSamples: many(8, 3), awaySamples: many(3, 7) });
  assert.equal(data.source, 'data');
  assert.ok(data.home > none.home, 'çok korner kullanan ev sahibi beklentiyi yükseltir');
  assert.ok(data.home > data.away);
});

test('korner örnekleri toplanır; özeti alınamayan maç atlanır', async () => {
  const matches = [
    { id: 'm3', league: 'x.1', homeId: '1', awayId: '2', timestamp: 3000 },
    { id: 'm2', league: 'x.1', homeId: '2', awayId: '1', timestamp: 2000 },
    { id: 'm1', league: 'x.1', homeId: '1', awayId: '3', timestamp: 1000 },
    { id: 'm9', league: 'x.1', homeId: '1', awayId: '2', timestamp: 9000 }, // kapanıştan sonra → kullanılmaz
  ];
  const espn = {
    getSummary: async (_l, id) => {
      if (id === 'm1') throw new Error('ESPN yok');
      return id === 'm3' ? summary(7, 2) : summary(1, 5); // takım 1 hep ilk değer: m2'de deplasmanda 1 korner kullandı, rakip 5
    },
  };
  const s = await collectCornerSamples({ espn, teamId: '1', matches, before: 5000 });
  assert.deepEqual(s, [{ for: 7, against: 2 }, { for: 1, against: 5 }]);
});
