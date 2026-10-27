import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentOf, followUpAnswer, reviewOf, swingText, scenarioOf, suggestionsFor } from '../chat.js';
import { liveProbabilities } from '../assistant.js';

const model = { lambdaHome: 1.6, lambdaAway: 1.1, sigma: 0 };
const content = { ai: { pick: '1', probabilities: { home: 52, draw: 25, away: 23 }, topScore: '2-1' } };
const importance = { label: 'Yüksek', score: 72, reasons: [] };
const base = { H: 'Galatasaray', A: 'Fenerbahçe', model, content, importance, probAt: (s) => liveProbabilities(model, s) };

test('niyet sırası: değerlendirme ve senaryo "neden" ve "gol"den önce gelir', () => {
  assert.equal(intentOf('Neden tutmadı?'), 'review');
  assert.equal(intentOf('Tahmin tuttu mu?'), 'review');
  assert.equal(intentOf('Ev sahibi gol atarsa?'), 'whatif');
  assert.equal(intentOf('1-1 olursa ne olur'), 'whatif');
  assert.equal(intentOf('neden?'), 'why');
});

test('değerlendirme: tutan tahmin ve tutan skor', () => {
  const r = reviewOf({ H: 'Ev', A: 'Dep', model, content, homeGoals: 2, awayGoals: 1 });
  assert.equal(r.hit, true);
  assert.equal(r.scoreHit, true);
  assert.match(r.text, /Maç 2-1 bitti/);
  assert.match(r.text, /sonuç tahmini tuttu, skor tahmini de tuttu/);
  assert.doesNotMatch(r.text, /ihtimali/);
});

test('değerlendirme: tutmayan tahminde sürpriz düzeyi ve gol farkı açıklanır', () => {
  const r = reviewOf({ H: 'Ev', A: 'Dep', model, content, homeGoals: 0, awayGoals: 3 });
  assert.equal(r.hit, false);
  assert.match(r.text, /sonuç tahmini tutmadı/);
  assert.match(r.text, /Ev beklenenden az attı \(0\)/);
  assert.match(r.text, /Dep beklenenden fazla attı \(3\)/);
  assert.match(r.text, /maç öncesi ihtimali %23 idi; sürpriz sayılır/);
});

test('bitmiş maçta "neden?" değerlendirmeye yönlenir; bitmemiş maçta değerlendirme beklemeye alınır', () => {
  const post = followUpAnswer({ ...base, intent: 'why', state: 'post', homeGoals: 1, awayGoals: 1 });
  assert.match(post.answer, /Maç 1-1 bitti/);
  const pre = followUpAnswer({ ...base, intent: 'review', state: 'pre' });
  assert.match(pre.answer, /henüz bitmedi/);
});

test('senaryo: maç öncesi ev sahibi gol atarsa ev ihtimali artar', () => {
  const r = followUpAnswer({ ...base, intent: 'whatif', question: 'Ev sahibi gol atarsa?', state: 'pre', live: null });
  assert.match(r.answer, /^Galatasaray gol atarsa \(maçın başında\)/);
  const [, before, after] = r.answer.match(/Galatasaray %(\d+) → %(\d+)/);
  assert.ok(Number(after) > Number(before));
});

test('senaryo: canlı maçta takım adıyla, "gol yerse" rakibin golü sayılır', () => {
  const live = { minute: 60, home: 0, away: 0, halftime: false };
  const r = followUpAnswer({ ...base, intent: 'whatif', question: 'Fenerbahçe gol yerse?', state: 'live', live });
  assert.match(r.answer, /^Galatasaray gol atarsa \(60\. dakikada\)/);
});

test('senaryo: açık skor ve geri giden skor', () => {
  assert.deepEqual(scenarioOf('1-1 olursa', { H: 'A', A: 'B', base: { minute: 30, home: 0, away: 0 } }), { minute: 30, home: 1, away: 1, label: 'Skor 1-1 olursa' });
  assert.equal(scenarioOf('0-0 olursa', { H: 'A', A: 'B', base: { minute: 30, home: 1, away: 0 } }), null);
});

test('senaryo: takım belirsizse açıklama istenir; bitmiş maçta senaryo yanıtlanmaz', () => {
  const vague = followUpAnswer({ ...base, intent: 'whatif', question: 'gol olursa?', state: 'pre', live: null });
  assert.match(vague.answer, /Hangi takımın gol attığını/);
  const post = followUpAnswer({ ...base, intent: 'whatif', question: 'ev sahibi gol atarsa', state: 'post' });
  assert.match(post.answer, /Maç bitti/);
});

test('canlı olasılık değişimi: belirgin değişim söylenir, küçük değişim "yakın" denir', () => {
  const big = swingText({ H: 'Ev', A: 'Dep', content, live: { probs: { p1: 0.8, pX: 0.15, p2: 0.05 } } });
  assert.match(big, /Maç öncesi Ev için %52 olan kazanma ihtimali şimdi %80/);
  const small = swingText({ H: 'Ev', A: 'Dep', content, live: { probs: { p1: 0.54, pX: 0.24, p2: 0.22 } } });
  assert.match(small, /maç öncesi tahmine yakın/);
  assert.equal(swingText({ H: 'Ev', A: 'Dep', content, live: null }), '');
});

test('öneriler maçın durumuna göre değişir', () => {
  assert.ok(suggestionsFor('post').includes('Tahmin tuttu mu?'));
  assert.ok(suggestionsFor('live').includes('Ev sahibi gol atarsa?'));
  assert.ok(suggestionsFor('pre').includes('Korner beklentisi?'));
});

test('ilk yarı sorusu: devre sonucu olasılıkları ve tahmini devre skoru', async () => {
  const { intentOf: io, followUpAnswer: fu } = await import('../chat.js');
  assert.equal(io('İlk yarı kim önde?'), 'first');
  assert.equal(io('devreyi kim önde kapatır'), 'first');
  assert.equal(io('ikinci yarı nasıl'), 'second');
  const r = fu({ intent: 'first', H: 'Ev', A: 'Dep', model: { lambdaHome: 2.1, lambdaAway: 0.8, sigma: 0.1 }, content: { ai: { pick: '1', probabilities: { home: 60, draw: 22, away: 18 }, topScore: '2-0' } }, importance: { label: 'Orta', score: 50, reasons: [] }, state: 'pre', live: null });
  assert.match(r.answer, /^İlk yarı: Ev önde %\d+, beraberlik %\d+, Dep önde %\d+; tahmini devre skoru 1-0/);
});

test('neden yanıtı tahmini destekleyen etkenleri sıralar, karşı etkeni de söyler', async () => {
  const { whyAnswer } = await import('../chat.js');
  const text = whyAnswer({
    H: 'Ev',
    A: 'Dep',
    model: { lambdaHome: 1.9, lambdaAway: 0.9, homePpg: 2.2, awayPpg: 1.1, homeRank: 2, awayRank: 14, homeGf: 2.0, homeGa: 0.8, awayGf: 1.0, awayGa: 1.6, homeFormPoints: 4, homeFormMatches: 5, awayFormPoints: 12, awayFormMatches: 5, h2h: { n: 0 } },
    content: { ai: { pick: '1', probabilities: { home: 62, draw: 22, away: 16 } } },
    importance: { reasons: [] },
  });
  assert.match(text, /^Model Ev kazanır diyor/);
  assert.match(text, /gol beklentisi Ev 1,9, Dep 0,9/);
  assert.match(text, /puan ortalaması Ev 2,2, Dep 1,1 \(Ev 2\., Dep 14\.\)/);
  assert.match(text, /Karşı yönde: son maçlar: Ev 4\/15, Dep 12\/15 puan/);
});

test('neden: tarafsız sahada ev sahibi avantajı söylenmez; farklı liglerde lig gücü gerekçe olur', async () => {
  const { whyAnswer } = await import('../chat.js');
  const base = { lambdaHome: 1.0, lambdaAway: 1.9, h2h: { n: 0 }, neutral: true, leagueRatio: 0.62, homeLeague: 'tur.1', awayLeague: 'eng.1' };
  const text = whyAnswer({ H: 'Ev', A: 'Dep', model: base, content: { ai: { pick: '2', probabilities: { home: 22, draw: 24, away: 54 } } }, importance: { reasons: [] } });
  assert.doesNotMatch(text, /ev sahibi avantajı\)/);
  assert.match(text, /lig gücü: Dep daha güçlü bir ligden \(Ev: Süper Lig, Dep: Premier League\)/);
});

test('senaryo: dakika ve skor birlikte; skorun parçası dakika sayılmaz', async () => {
  const { scenarioOf: so } = await import('../chat.js');
  const base = { minute: 30, home: 0, away: 0 };
  assert.deepEqual(so('75. dakikada ev sahibi gol atarsa?', { H: 'Ev', A: 'Dep', base }), { minute: 75, home: 1, away: 0, label: 'Ev gol atarsa' });
  assert.deepEqual(so("2-1'de biterse? 2-1 olursa", { H: 'Ev', A: 'Dep', base }), { minute: 30, home: 2, away: 1, label: 'Skor 2-1 olursa' });
  // göreli dakika ("10 dk sonra") ve geçmiş dakika (şimdiki dakika kullanılır)
  assert.equal(so('10 dk sonra deplasman gol atarsa', { H: 'Ev', A: 'Dep', base }).minute, 40);
  assert.equal(so('20. dakikada deplasman gol atarsa', { H: 'Ev', A: 'Dep', base }).minute, 30);
});
