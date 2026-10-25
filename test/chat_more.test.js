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
