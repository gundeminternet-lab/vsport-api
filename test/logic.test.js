// Sunucu mantığı testleri: Firebase olmadan, demo ESPN verisi ve bellekte çalışan sahte veri katmanıyla.
import test from 'node:test';
import assert from 'node:assert/strict';

import { DemoEspn } from '../engine/demo.js';
import { PaidContentService, AppError, matchKey, LEAGUES } from '../logic.js';
import { VALUES_PER_FRAME, markets, buildReview } from '../content.js';
import { makeStore, subscribed } from './helpers.js';
import { TRIAL_MATCHES } from '../subscription.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0);
const FUTURE = NOW + 2 * 86400000; // 19 Ekim 12:00
const PAST = NOW - 3 * 86400000;

function makeEspn() {
  const espn = new DemoEspn({ now: NOW });
  const fixtures = [
    { id: '9001', timestamp: FUTURE, date: new Date(FUTURE).toISOString(), league: 'demo.1', homeId: '1001', awayId: '1002', homeName: 'Demo Ev FK', awayName: 'Demo Dep SK', completed: false },
    { id: '9002', timestamp: PAST, date: new Date(PAST).toISOString(), league: 'demo.1', homeId: '1003', awayId: '1004', homeName: 'Demo Takım 3', awayName: 'Demo Takım 4', completed: true, homeGoals: 2, awayGoals: 1 },
  ];
  espn.fixtureCalls = 0;
  espn.getFixtures = async (league, from) => {
    espn.fixtureCalls++;
    const day = from.toISOString().slice(0, 10);
    return fixtures.filter((f) => f.league === league && new Date(f.timestamp).toISOString().slice(0, 10) === day);
  };
  return espn;
}

const fixture = { league: 'demo.1', eventId: '9001', kickoff: new Date(FUTURE).toISOString() };
const finished = { league: 'demo.1', eventId: '9002', kickoff: new Date(PAST).toISOString() };

test('anahtar uygulamadaki MatchItem.key ile aynı', () => {
  assert.equal(matchKey('tur.1', '401888391'), 'tur_1_401888391');
});

test('abone: her içerik ücretsiz açılır, açılanlar geçmişe yazılır, içerik maç başına bir kez üretilir', async () => {
  const store = makeStore({ subscription: subscribed('weekly') });
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW });

  const sim = await svc.unlock({ uid: 'u1', ...fixture, type: 'sim' });
  assert.equal(sim.via, 'subscription');
  assert.ok(sim.data.positions.length > 1000);

  const ai = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  assert.equal(ai.via, 'subscription');
  assert.ok(['1', 'X', '2'].includes(ai.data.pick));
  assert.ok(ai.data.sections.length >= 5);
  assert.equal(store.saves, 1, 'içerik maç başına bir kez üretilir');
  assert.equal(store.records.get('u1/demo_1_9001_ai').via, 'subscription');
  assert.equal(store.users.u1.trialUsed, 0, 'abone deneme hakkı harcamaz');
});

test('abone değil: deneme hakkıyla AI paketi açılır (simülasyon dahil); aynı maç tekrar hak harcamaz', async () => {
  const store = makeStore();
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW });
  // Deneme yalnızca AI paketiyle başlar
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'sim' }), (e) => e.code === 'subscription-required');
  const ai = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  assert.equal(ai.via, 'trial');
  assert.equal(ai.trialLeft, TRIAL_MATCHES - 1);
  assert.equal(store.users.u1.trialUsed, 1);
  const again = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  assert.equal(again.via, 'unlock');
  assert.equal(store.users.u1.trialUsed, 1, 'aynı maç ikinci kez hak harcamaz');
  const sim = await svc.unlock({ uid: 'u1', ...fixture, type: 'sim' });
  assert.equal(sim.via, 'unlock', 'AI paketi simülasyonu kapsar');
  const got = await svc.get({ uid: 'u1', ...fixture, type: 'sim' });
  assert.ok(got.data.finalScore);
});

test('deneme hakları bitince abonelik gerekir; içerik üretimi tetiklenmez', async () => {
  const store = makeStore({ trialUsed: TRIAL_MATCHES });
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'ai' }), (e) => e.code === 'subscription-required');
  assert.equal(store.saves, 0);
  // Süresi dolmuş abonelik de abonelik sayılmaz
  const expired = makeStore({ trialUsed: TRIAL_MATCHES, subscription: { plan: 'yearly', until: NOW - 1 } });
  const svc2 = new PaidContentService({ leagues: ['demo.1'], store: expired, espn: makeEspn(), now: () => NOW });
  await assert.rejects(svc2.unlock({ uid: 'u1', ...fixture, type: 'ai' }), (e) => e.code === 'subscription-required');
});

test('maç başladıktan sonra deneme kullanılamaz, abone açabilir; giriş yapmadan hiçbiri', async () => {
  const later = () => FUTURE + 60000;
  const free = makeStore();
  const svc = new PaidContentService({ leagues: ['demo.1'], store: free, espn: makeEspn(), now: later });
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'ai' }), (e) => e.code === 'failed-precondition');
  assert.equal(free.users.u1.trialUsed, 0);
  await assert.rejects(svc.unlock({ uid: null, ...fixture, type: 'ai' }), (e) => e.code === 'permission-denied');
  const sub = makeStore({ subscription: subscribed('monthly', FUTURE) });
  const svc2 = new PaidContentService({ leagues: ['demo.1'], store: sub, espn: makeEspn(), now: later });
  const r = await svc2.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  assert.equal(r.via, 'subscription');
});

test('geçersiz girdiler reddedilir, bilinmeyen maç bulunamaz', async () => {
  const svc = new PaidContentService({ leagues: ['demo.1'], store: makeStore(), espn: makeEspn(), now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'free' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, league: '../x', type: 'ai' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, league: 'bra.1', type: 'ai' }), (e) => e.code === 'invalid-argument', 'listede olmayan lig');
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, eventId: '1234', type: 'ai' }), (e) => e.code === 'not-found');
});

test('kilitli içerik abonelik olmadan alınamaz; biten maçta ücretsiz', async () => {
  const svc = new PaidContentService({ leagues: ['demo.1'], store: makeStore(), espn: makeEspn(), now: () => NOW });
  await assert.rejects(svc.get({ uid: 'u1', ...fixture, type: 'sim' }), (e) => e.code === 'subscription-required');
  const after = await svc.get({ uid: 'u1', ...finished, type: 'ai' });
  assert.ok(after.data.sections.length > 0);
});

test('biten maç karşılaştırması: tahmin maç öncesi veriyle üretilir', async () => {
  const svc = new PaidContentService({ leagues: ['demo.1'], store: makeStore(), espn: makeEspn(), now: () => NOW });
  const r = await svc.review({ uid: 'u1', ...finished });
  assert.equal(r.review.actual.score, '2-1');
  assert.equal(r.review.actual.outcome, '1');
  assert.equal(r.generatedBeforeKickoff, false);
  assert.equal(typeof r.review.ai.outcomeHit, 'boolean');
  assert.equal(typeof r.review.sim.scoreHit, 'boolean');
  await assert.rejects(svc.review({ uid: 'u1', ...fixture }), (e) => e.code === 'failed-precondition');
});

test('simülasyon paketi: kare sayısı, boyut, değer aralığı; skor tabelası son skorla uyumlu', async () => {
  const svc = new PaidContentService({ leagues: ['demo.1'], store: makeStore({ subscription: subscribed() }), espn: makeEspn(), now: () => NOW });
  const { data } = await svc.unlock({ uid: 'u1', ...fixture, type: 'sim' });
  const bytes = Buffer.from(data.positions, 'base64');
  assert.equal(data.frames, 601);
  assert.equal(bytes.length, data.frames * VALUES_PER_FRAME * 2);
  const json = JSON.stringify(data).length;
  assert.ok(json < 400_000, `paket boyutu ${json} bayt (Firestore belge sınırı 1 MB)`);
  const last = data.scores[data.scores.length - 1];
  assert.deepEqual({ home: last.home, away: last.away }, data.finalScore);
  assert.equal(data.labels[data.labels.length - 1].label, 'MS');
  console.log(`    simülasyon paketi ${Math.round(json / 1024)} KB, son skor ${data.finalScore.home}-${data.finalScore.away}`);
});

test('bahis olasılıkları tutarlı: 1+X+2 = 1, çifte şanslar doğru', async () => {
  const { p, topScores } = markets(1.6, 1.1);
  assert.ok(Math.abs(p.ms1 + p.msX + p.ms2 - 1) < 1e-9);
  assert.ok(p.ms1 > p.ms2);
  assert.ok(p.over15 > p.over25 && p.over25 > p.over35);
  assert.ok(p.iyX > p.msX, 'ilk yarıda beraberlik daha olası');
  assert.ok(topScores[0].p >= topScores[1].p);

  // Bahis ihtimalleri artık sunulmuyor: aboneye de açılmaz.
  const store = makeStore({ subscription: subscribed() });
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'odds' }), (e) => e.code === 'failed-precondition');
});

test('karşılaştırma kuralları', () => {
  const r = buildReview({ ai: { pick: '1', topScore: '1-0' }, sim: { finalScore: { home: 1, away: 1 } }, actual: { home: 1, away: 0 } });
  assert.equal(r.ai.outcomeHit, true);
  assert.equal(r.ai.scoreHit, true);
  assert.equal(r.sim.outcomeHit, false);
});

test('lig listesi: yinelenen yok, kodlar geçerli ve Firestore kuralındaki 30 karakter sınırı içinde', () => {
  assert.equal(new Set(LEAGUES).size, LEAGUES.length);
  for (const code of LEAGUES) {
    assert.match(code, /^[a-z0-9]+(\.[a-z0-9_]+)+$/, code);
    assert.ok(code.length <= 30, code);
    // Firestore belge kimliği ve izleme anahtarı güvenli olmalı
    assert.match(matchKey(code, '401888391'), /^[A-Za-z0-9_]{3,80}$/);
  }
  for (const code of ['tur.1', 'uefa.champions', 'uefa.europa', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'por.1', 'ned.1']) {
    assert.ok(LEAGUES.includes(code), `${code} eski listede vardı, kaybolmamalı`);
  }
});

test('genişletilmiş ligler sunucuda geçerli sayılır (içerik isteği "Geçersiz lig" ile reddedilmez)', () => {
  const svc = new PaidContentService({ store: {}, espn: makeEspn() });
  for (const code of ['eng.2', 'usa.1', 'conmebol.libertadores', 'uefa.europa.conf', 'ksa.1', 'eng.fa']) {
    assert.ok(svc.leagues.has(code), code);
  }
  assert.ok(!svc.leagues.has('xyz.9'));
});

test('AI analizi yanıtı tahminin dayandığı sayıları da taşır (ekrandaki "Sayılarla maç")', async () => {
  const store = makeStore({ subscription: subscribed('monthly') });
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW });
  const r = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  const m = r.data.model;
  assert.ok(m, 'model alanı');
  assert.ok(Number.isFinite(m.lambdaHome) && Number.isFinite(m.lambdaAway));
  assert.match(m.homeForm, /^[GBM]{0,5}$/);
  assert.ok(m.h2h && Number.isInteger(m.h2h.n));
});
