// AI Asistan: abonelik koşulu, günlük sınır, canlı olasılıklar ve sahne akışı.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PaidContentService } from '../logic.js';
import { AssistantService, buildAssistantReply, focusOf, liveProbabilities, parseLive } from '../assistant.js';
import { SPECIAL_TOPICS } from '../special.js';
import { NOW, FUTURE, makeEspn, makeStore, fixture, finished } from './helpers.js';

const DAY = 86400000;
const monthly = { plan: 'monthly', until: NOW + 20 * DAY };

function make({ subscription = monthly, now = NOW, espn = makeEspn(), limit = 15 } = {}) {
  const store = makeStore({ tokens: 0, subscription });
  const paid = new PaidContentService({ leagues: ['demo.1'], store, espn, now: () => now });
  return { store, paid, assistant: new AssistantService({ paid, store, now: () => now, dailyLimit: limit }) };
}

const liveSummary = (minute, home, away, state = 'in', name = 'STATUS_FIRST_HALF') => ({
  header: {
    competitions: [
      {
        status: { displayClock: `${minute}'`, type: { state, name } },
        competitors: [
          { homeAway: 'home', score: String(home) },
          { homeAway: 'away', score: String(away) },
        ],
      },
    ],
  },
});

test('abonelik yoksa, haftalıksa ya da süresi dolmuşsa reddedilir; hak harcanmaz', async () => {
  for (const subscription of [null, { plan: 'weekly', until: NOW + DAY }, { plan: 'monthly', until: NOW - 1 }]) {
    const { assistant, store } = make({ subscription });
    await assert.rejects(assistant.analyze({ uid: 'u1', ...fixture }), (e) => e.code === 'permission-denied');
    assert.equal(store.usage.size, 0);
  }
  const { assistant } = make();
  await assert.rejects(assistant.analyze({ uid: null, ...fixture }), (e) => e.code === 'permission-denied');
});

test('aylık abone için maç öncesi analiz: önem, sahneler ve kullanım sayacı', async () => {
  const { assistant, store } = make();
  const r = await assistant.analyze({ uid: 'u1', ...fixture });
  assert.equal(r.state, 'pre');
  assert.equal(r.headline, 'Demo Ev FK - Demo Dep SK');
  assert.ok(r.importance.score >= 5 && r.importance.score <= 100);
  assert.deepEqual(r.usage, { used: 1, limit: 15 });
  assert.equal(store.usage.size, 1);

  const kinds = r.scenes.map((s) => s.kind);
  assert.equal(kinds[0], 'intro');
  assert.equal(kinds.at(-1), 'outro');
  for (const k of ['section', 'dominance', 'probabilities', 'forecast', 'plan']) assert.ok(kinds.includes(k), k);
  // Dört Özel Yorum başlığı da sahne olarak gelir
  const titles = r.scenes.map((s) => s.title);
  for (const t of ['Korner beklentisi', 'İlk yarı skoru', 'İY/MS sürprizleri', 'KG var senaryoları']) assert.ok(titles.includes(t), t);
  assert.ok(r.scenes.filter((s) => s.kind === 'forecast').length >= 5);

  for (const s of r.scenes) {
    assert.ok(s.speech.trim().length > 10, s.title);
    assert.ok(['calm', 'warm', 'excited', 'serious'].includes(s.mood), s.title);
    const all = [s.title, s.speech, s.body ?? ''].join(' ');
    assert.ok(!/\{\w+\}|undefined|NaN|null/.test(all), all);
    assert.ok(!/\b(bahis|kupon)\b/i.test(all), all);
    assert.ok(!/%/.test(s.speech), `seste yüzde işareti: ${s.speech}`);
    assert.ok(!/\d\s*-\s*\d/.test(s.speech), `seste rakam-çizgi-rakam: ${s.speech}`);
  }
  const probs = r.scenes.find((s) => s.kind === 'probabilities').probs;
  assert.equal(probs.length, 3);
  assert.ok(Math.abs(probs.reduce((a, p) => a + p[2], 0) - 100) <= 2);
  assert.match(r.answer, /Maçın önemi/);
});

test('aynı maç sorulursa aynı sahneler gelir (kararlı anlatım)', async () => {
  const { assistant } = make();
  const a = await assistant.analyze({ uid: 'u1', ...fixture });
  const b = await assistant.analyze({ uid: 'u1', ...fixture });
  assert.deepEqual(a.scenes, b.scenes);
  assert.equal(b.usage.used, 2);
});

test('günlük sınır dolunca durur', async () => {
  const { assistant } = make({ limit: 2 });
  await assistant.analyze({ uid: 'u1', ...fixture });
  await assistant.analyze({ uid: 'u1', ...fixture });
  await assert.rejects(assistant.analyze({ uid: 'u1', ...fixture }), (e) => e.code === 'resource-exhausted');
});

test('soru konusu öne çıkar: korner sorulunca korner sahnesi ilk özel sahne olur', async () => {
  const { assistant } = make();
  const r = await assistant.analyze({ uid: 'u1', ...fixture, question: 'Bu maçta kaç korner olur?' });
  assert.deepEqual(r.focus, ['corners']);
  assert.match(r.answer, /^Korner beklentisi:/);
  const titles = r.scenes.map((s) => s.title);
  assert.ok(titles.indexOf('Korner beklentisi') < titles.indexOf('İlk yarı skoru'));
  await assert.rejects(assistant.analyze({ uid: 'u1', ...fixture, question: 'x'.repeat(201) }), (e) => e.code === 'invalid-argument');
});

test('soru ayrıştırma', () => {
  assert.deepEqual(focusOf('korner kaç olur'), ['corners']);
  assert.deepEqual(focusOf('İY/MS sürpriz var mı'), ['htft']);
  assert.deepEqual(focusOf('ilk yarı skoru ne olur'), ['htscore']);
  assert.deepEqual(focusOf('iki takım da gol atar mı, KG var mı'), ['btts']);
  assert.deepEqual(focusOf('korner ve ilk yarı skor'), ['corners', 'htscore']);
  assert.deepEqual(focusOf(''), []);
  assert.deepEqual(focusOf('merhaba'), []);
});

test('canlı ayrıştırma ve olasılıklar: önde olan takım avantajlı, süre azaldıkça kesinleşir', () => {
  const live = parseLive(liveSummary(63, 1, 0));
  assert.deepEqual({ state: live.state, home: live.home, away: live.away, minute: live.minute }, { state: 'in', home: 1, away: 0, minute: 63 });
  assert.equal(parseLive(liveSummary(45, 0, 0, 'in', 'STATUS_HALFTIME')).halftime, true);
  assert.equal(parseLive({ header: { competitions: [{ status: { displayClock: "90'+4'", type: { state: 'in' } }, competitors: [] }] } }).minute, 94);
  assert.equal(parseLive({}), null);

  const model = { lambdaHome: 1.4, lambdaAway: 1.4, sigma: 0.15 };
  const early = liveProbabilities(model, { minute: 10, home: 1, away: 0 });
  const late = liveProbabilities(model, { minute: 85, home: 1, away: 0 });
  assert.ok(Math.abs(early.p1 + early.pX + early.p2 - 1) < 1e-6);
  assert.ok(early.p1 > early.p2);
  assert.ok(late.p1 > early.p1, 'geç dakikada 1-0 önde olmak daha değerli');
  assert.equal(late.topScore, '1-0');
  const level = liveProbabilities(model, { minute: 0, home: 0, away: 0 });
  assert.ok(Math.abs(level.p1 - level.p2) < 1e-6, 'eşit güç, eşit olasılık');
});

test('maç sürerken: canlı sahne, güncel olasılıklar ve maç öncesi İY başlıkları atlanır', async () => {
  const now = FUTURE + 63 * 60000;
  const espn = makeEspn();
  espn.getSummary = async () => liveSummary(63, 1, 0);
  const { assistant } = make({ now, espn });
  const r = await assistant.analyze({ uid: 'u1', ...fixture });
  assert.equal(r.state, 'live');
  assert.deepEqual(r.live, { minute: 63, home: 1, away: 0, halftime: false });
  const first = r.scenes[1];
  assert.equal(first.title, 'Maçta son durum');
  assert.equal(first.big, '1 - 0');
  assert.match(first.kicker, /CANLI · 63/);
  const titles = r.scenes.map((s) => s.title);
  assert.ok(!titles.includes('İlk yarı skoru') && !titles.includes('İY/MS sürprizleri'));
  assert.ok(titles.includes('Korner beklentisi'));
  assert.match(r.answer, /1-0/);
});

test('canlı veri alınamazsa maç öncesi görünüm sunulur', async () => {
  const espn = makeEspn();
  espn.getSummary = async () => {
    throw new Error('ESPN yok');
  };
  const { assistant } = make({ now: FUTURE + 30 * 60000, espn });
  const r = await assistant.analyze({ uid: 'u1', ...fixture });
  assert.equal(r.state, 'pre');
  assert.equal(r.live, null);
});

test('biten maç: sonuç ve tahmin karşılaştırması', async () => {
  const { assistant } = make();
  const r = await assistant.analyze({ uid: 'u1', ...finished });
  assert.equal(r.state, 'post');
  const s = r.scenes.find((x) => x.title === 'Maç bitti');
  assert.equal(s.big, '2 - 1');
  assert.ok(['Tuttu', 'Tutmadı'].includes(s.chips[1][1]));
  assert.ok(!r.scenes.some((x) => x.title === 'İlk yarı skoru'));
});

test('sahne üretici tek başına: odak başlığı öne alır, eksik veriyle de çökmez', () => {
  const match = { homeName: 'A', awayName: 'B', homeGoals: null, awayGoals: null };
  const content = { ai: { pick: '1', topScore: '2-1', confidence: 'orta', probabilities: { home: 50, draw: 25, away: 25 } } };
  const model = { lambdaHome: 1.6, lambdaAway: 1.0, sigma: 0.1, homePpg: null, awayPpg: null, homeGf: null, homeGa: null, awayGf: null, awayGa: null, homeForm: '', awayForm: '', homeFormMatches: 0, awayFormMatches: 0 };
  const importance = { score: 40, label: 'Düşük', level: 'low', reasons: ['Standart bir karşılaşma.'], tags: [] };
  const r = buildAssistantReply({ match, content, model, specials: null, importance, live: null, focus: [], seed: 's', state: 'pre' });
  assert.ok(r.scenes.length >= 6);
  assert.ok(!r.scenes.some((s) => s.kind === 'stats'), 'veri yoksa kıyas sahnesi atlanır');
  for (const s of r.scenes) assert.ok(!/NaN|undefined/.test(JSON.stringify(s)), s.title);
});
