// AI analiz metninin dili: çeşitlilik, kararlılık, doldurulmamış yer tutucu olmaması, seri yorumları.
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchProbabilities } from '../engine/analysis.js';
import { buildAi, phraser, streakOf, CONTENT_VERSION } from '../content.js';

function analysisFor(lh, la, { formH = 'GGGBG', formA = 'MMBMB', h2h = { n: 0 }, ranks = [null, null] } = {}) {
  const sigma = 0.18;
  const pts = (f) => [...f].reduce((s, c) => s + (c === 'G' ? 3 : c === 'B' ? 1 : 0), 0);
  const mk = (n, id, form, rank) => ({
    id,
    name: n,
    profile: {
      form: { string: form, points: pts(form), matches: form.length, index: pts(form) / (form.length * 3) },
      goalsForPerGame: 1.6,
      goalsAgainstPerGame: 1.0,
      attack: 1.3,
      defense: 0.75,
      rank,
      ppg: rank ? 1.8 : null,
    },
  });
  return {
    home: mk('Ev Takımı', '1', formH, ranks[0]),
    away: mk('Dep Takımı', '2', formA, ranks[1]),
    lambdaHome: lh,
    lambdaAway: la,
    sigma,
    probabilities: matchProbabilities(lh, la, sigma),
    h2h,
    dataQuality: { homeMatches: 20, awayMatches: 20, h2hMatches: h2h.n, confidence: 'yüksek' },
  };
}

const allText = (ai) => ai.sections.map((s) => s.text).join('\n');

test('içerik sürümü: yeni anlatım eski kayıtların yerine geçer', () => {
  assert.ok(CONTENT_VERSION >= 3);
});

test('aynı tohum aynı metni verir (kararlı), farklı tohumlar farklı kalıplar seçer', () => {
  const a = analysisFor(1.8, 0.9);
  assert.equal(allText(buildAi(a, { seed: 'maç-1' })), allText(buildAi(a, { seed: 'maç-1' })));
  const variants = new Set();
  for (let i = 0; i < 40; i++) variants.add(allText(buildAi(a, { seed: `maç-${i}` })));
  assert.ok(variants.size >= 20, `en az 20 farklı metin beklenir, ${variants.size} bulundu`);
  const openings = new Set();
  for (let i = 0; i < 40; i++) openings.add(buildAi(a, { seed: `x-${i}` }).sections[0].text.split(':')[0]);
  assert.ok(openings.size >= 3, 'genel bakış açılışı da değişmeli');
});

test('doldurulmamış yer tutucu, undefined, NaN ya da "null" metne sızmaz', () => {
  const cases = [
    analysisFor(1.8, 0.9),
    analysisFor(1.0, 1.0),
    analysisFor(0.7, 2.1, { formH: '', formA: 'GGGGG' }),
    analysisFor(1.4, 1.3, { h2h: { n: 5, homeWins: 3, draws: 1, awayWins: 1, homeGoalsAvg: 1.8, awayGoalsAvg: 1.2 }, ranks: [2, 14] }),
  ];
  for (const a of cases) {
    for (let i = 0; i < 25; i++) {
      const t = allText(buildAi(a, { seed: `s${i}` }));
      assert.doesNotMatch(t, /\{\w+\}|undefined|NaN|\bnull\b|Infinity/, t);
    }
  }
});

test('bölümler: "Maçın anahtarı" var, tercih düz Türkçe, ham anahtar (ms1, o25) metinde yok', () => {
  const ai = buildAi(analysisFor(1.9, 0.8), { seed: 'k' });
  const titles = ai.sections.map((s) => s.title);
  assert.ok(titles.includes('Maçın anahtarı'));
  assert.ok(titles.includes('Öne çıkan tercih'));
  const pick = ai.sections.find((s) => s.title === 'Öne çıkan tercih').text;
  assert.doesNotMatch(pick, /\b(ms1|msX|ms2|cs1X|csX2|cs12|kgVar|kgYok|o15|o25|o35|u15|u25|u35|iy1|iy2|iyX|iyO05)\b/);
  assert.match(pick, new RegExp(`Tahmin edilen skor ${ai.topScore}`));
});

test('seri yorumları: galibiyet, yenilmezlik, mağlubiyet ve kazanamama serileri', () => {
  assert.deepEqual(streakOf('MGGGG'), { last: 'G', run: 4, unbeaten: 4, winless: 0 });
  assert.equal(streakOf('GGBBM').last, 'M');
  assert.equal(streakOf(''), null);

  const win = allText(buildAi(analysisFor(1.5, 1.2, { formH: 'MGGGG' }), { seed: 'a' }));
  assert.match(win, /(üst üste 4 galibiyet|son 4 maçını da kazandı|4 maçlık galibiyet serisinde)/);
  const loss = allText(buildAi(analysisFor(1.5, 1.2, { formA: 'GGBMM' }), { seed: 'a' }));
  assert.match(loss, /(son 2 maçını kaybetti|2 maçlık mağlubiyet serisinde)/);
});

test('takım adlarına ek getirilmez (Türkçe ek hatası olmasın)', () => {
  const a = analysisFor(1.7, 1.1);
  for (let i = 0; i < 30; i++) {
    const t = allText(buildAi(a, { seed: `e${i}` }));
    assert.doesNotMatch(t, /(Ev Takımı|Dep Takımı)['’]?(nın|nin|nun|nün|ın|in|un|ün|yı|yi|yu|yü|ya|ye|da|de|ta|te|dan|den|tan|ten)\b/, t);
  }
});

test('phraser: yer tutucuları doldurur, eksik değişkeni olduğu gibi bırakır, aynı anahtar aynı seçimi verir', () => {
  const say = phraser('t');
  assert.equal(say('k', ['Merhaba {x}.'], { x: 'dünya' }), 'Merhaba dünya.');
  assert.equal(say('k', ['Merhaba {y}.'], {}), 'Merhaba {y}.');
  const opts = ['bir', 'iki', 'üç', 'dört'];
  assert.equal(say('anahtar', opts), say('anahtar', opts));
});
