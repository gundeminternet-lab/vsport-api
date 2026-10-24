import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intentOf, followUpAnswer, SUGGESTIONS } from '../chat.js';

const model = { lambdaHome: 1.6, lambdaAway: 1.1, sigma: 0, homePpg: 2.1, awayPpg: 1.2 };
const content = {
  ai: { pick: '1', probabilities: { home: 52, draw: 25, away: 23 }, topScore: '2-1' },
};
const importance = { label: 'Yüksek', score: 72, reasons: ['Lig sıralamasında yakın takımlar.'] };
const base = { H: 'Ev', A: 'Dep', model, content, importance, state: 'pre', live: null };

test('niyet: Türkçe ve ASCII yazımı tanır', () => {
  assert.equal(intentOf('neden?'), 'why');
  assert.equal(intentOf('Niye bu tahmin?'), 'why');
  assert.equal(intentOf('Kaç gol olur'), 'goals');
  assert.equal(intentOf('kac gol olur'), 'goals');
  assert.equal(intentOf('İkinci yarı nasıl'), 'second');
  assert.equal(intentOf('Kim kazanır'), 'winner');
  assert.equal(intentOf('skor ne olur'), 'score');
  assert.equal(intentOf('derbi mi'), 'importance');
});

test('niyet: tanınmayan soru general döner', () => {
  assert.equal(intentOf('Galatasaray Fenerbahçe'), 'general');
  assert.equal(intentOf(''), 'general');
  assert.equal(intentOf('korner'), 'general');
});

test('kazanan yanıtı yüzdeleri ve modelin tahminini verir', () => {
  const r = followUpAnswer({ ...base, intent: 'winner' });
  assert.match(r.answer, /Ev %52, beraberlik %25, Dep %23/);
  assert.match(r.answer, /Model Ev kazanır diyor/);
  assert.deepEqual(r.suggestions, SUGGESTIONS.winner);
});

test('gol yanıtı beklenen toplamı ve üç gol ihtimalini verir', () => {
  const r = followUpAnswer({ ...base, intent: 'goals' });
  assert.match(r.answer, /Beklenen toplam gol 2,7/);
  assert.match(r.answer, /Ev 1,6, Dep 1,1/);
  assert.match(r.answer, /en az üç gol olma ihtimali %\d+/);
});

test('ikinci yarı yanıtı toplam golün %45/%55 dağılımını kullanır', () => {
  const r = followUpAnswer({ ...base, intent: 'second' });
  assert.match(r.answer, /İlk yarıda beklenen gol 1,2/);
  assert.match(r.answer, /ikinci yarıda 1,5/);
});

test('skor yanıtı en olası skoru söyler', () => {
  const r = followUpAnswer({ ...base, intent: 'score' });
  assert.match(r.answer, /En olası skor 2-1/);
});

test('bitmiş maçta takip yanıtı maç öncesi tahmine atıfta bulunur', () => {
  const r = followUpAnswer({ ...base, state: 'post', intent: 'winner' });
  assert.match(r.answer, /^Ev %52/);
  assert.match(r.answer, /Maç bitti; maç öncesi model Ev kazanır diyordu/);
});

test('önem yanıtı etiketi ve puanı verir', () => {
  const r = followUpAnswer({ ...base, intent: 'importance' });
  assert.match(r.answer, /Maçın önemi yüksek \(72\/100\)/);
});

test('general niyeti için takip yanıtı üretilmez', () => {
  assert.equal(followUpAnswer({ ...base, intent: 'general' }), null);
});
