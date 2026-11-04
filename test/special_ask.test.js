// Kişiye özel yorum (special_ask.js) ve ekran görüntüsü kilidi (capture.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAsk, validChoice, ASK_MARKET_IDS, CORNER_LINES, jointHalves } from '../special_ask.js';
import { markets } from '../content.js';
import { CaptureLocks } from '../capture.js';
import { PaidContentService } from '../logic.js';
import { makeEspn, makeStore, subscribed, FUTURE, PAST } from './helpers.js';

const model = {
  lambdaHome: 1.7,
  lambdaAway: 1.05,
  sigma: 0.15,
  homeGf: 2.1,
  homeGa: 0.9,
  awayGf: 1.2,
  awayGa: 1.6,
  homeFormPoints: 12,
  homeFormMatches: 5,
  awayFormPoints: 5,
  awayFormMatches: 5,
  homeForm: 'GGBGG',
  awayForm: 'MBGMM',
  homeRank: 2,
  awayRank: 11,
  h2h: { n: 5, homeWins: 3, draws: 1, awayWins: 1 },
};
const H = 'Ev Spor';
const A = 'Dep Spor';

const CHOICES = {
  ms: ['1', 'X', '2'],
  dc: ['1X', '12', 'X2'],
  au: ['1.5 Üst', '1.5 Alt', '2.5 Üst', '2.5 Alt', '3.5 Üst', '3.5 Alt'],
  kg: ['Var', 'Yok'],
  tg: ['H1', 'H2', 'H0', 'A1', 'A2', 'A0'],
  iy: ['1', 'X', '2'],
  iyg: ['0.5 Üst', '0.5 Alt', '1.5 Üst', '1.5 Alt'],
  iyms: ['1/1', '1/X', '1/2', 'X/1', 'X/X', 'X/2', '2/1', '2/X', '2/2'],
  score: ['0-0', '1-0', '2-1', '0-2', '3-3'],
  corners: CORNER_LINES.flatMap((l) => [`${l} Üst`, `${l} Alt`]),
};

const textOf = (r) => [r.headline, r.verdict, r.risk ?? '', ...r.summary, ...r.reasons.map((x) => x.text), ...r.scenarios.map((x) => x.text), ...r.watch, ...r.options.map((o) => o.label)].join(' | ');

test('özel yorum: her tür ve seçim üretilir; metin temiz, yasak sözcük ve takım adına ek yok', () => {
  assert.deepEqual(Object.keys(CHOICES).sort(), [...ASK_MARKET_IDS].sort());
  for (const [market, list] of Object.entries(CHOICES)) {
    for (const choice of list) {
      assert.ok(validChoice(market, choice), `${market} ${choice}`);
      const r = buildAsk({ market, choice, homeName: H, awayName: A, model, seed: 'u1|k' });
      const t = textOf(r);
      assert.ok(!/\{\w+\}|undefined|NaN|null|Infinity/.test(t), `${market} ${choice}: ${t}`);
      assert.ok(!/\b(bahis|kupon|iddaa)|\boran(ı|lar)?\b/i.test(t), t);
      assert.ok(!/(Ev Spor|Dep Spor)('|’)/.test(t), `takım adına ek: ${t}`);
      assert.ok(r.pct >= 0 && r.pct <= 100);
      assert.ok(['güçlü', 'makul', 'riskli', 'zor'].includes(r.level));
      assert.equal(r.options.filter((o) => o.mine).length, 1);
      assert.equal(r.options.filter((o) => o.ai).length, 1);
      assert.equal(r.agree, r.ai.id === r.choice);
      for (const s of r.scenarios) assert.ok(s.pct >= 0 && s.pct <= 100 && Math.abs(s.delta) >= 4);
    }
  }
  assert.ok(!validChoice('ms', '3'));
  assert.ok(!validChoice('score', '9-0'));
  assert.ok(!validChoice('bahis', '1'));
});

test('özel yorum: yüzdeler uygulamanın her yerinde görülen tahmin yüzdeleriyle aynı', () => {
  const { p } = markets(model.lambdaHome, model.lambdaAway, model.sigma);
  const pct = (x) => Math.round(x * 100);
  assert.equal(buildAsk({ market: 'ms', choice: '1', homeName: H, awayName: A, model }).pct, pct(p.ms1));
  assert.equal(buildAsk({ market: 'kg', choice: 'Var', homeName: H, awayName: A, model }).pct, pct(p.kgVar));
  assert.equal(buildAsk({ market: 'au', choice: '2.5 Üst', homeName: H, awayName: A, model }).pct, pct(p.over25));
  assert.equal(buildAsk({ market: 'iyg', choice: '0.5 Üst', homeName: H, awayName: A, model }).pct, pct(p.iyOver05));
  const ms = buildAsk({ market: 'ms', choice: 'X', homeName: H, awayName: A, model });
  const total = ms.options.reduce((s, o) => s + o.pct, 0);
  assert.ok(Math.abs(total - 100) <= 1);
  // İki yarının birleşik dağılımı 1'e toplanır
  assert.ok(Math.abs(jointHalves(model).reduce((s, c) => s + c.p, 0) - 1) < 1e-9);
});

test('özel yorum: seçime göre değişir; AI ile aynı / farklı görüş, senaryolar mantıklı yönde', () => {
  const fav = buildAsk({ market: 'ms', choice: '1', homeName: H, awayName: A, model, seed: 'u1|k' });
  const dog = buildAsk({ market: 'ms', choice: '2', homeName: H, awayName: A, model, seed: 'u2|k' });
  assert.equal(fav.agree, true);
  assert.equal(dog.agree, false);
  assert.notEqual(fav.headline, dog.headline);
  assert.ok(fav.reasons.some((r) => r.kind === 'for'));
  assert.ok(dog.reasons.some((r) => r.kind === 'against'));
  // Ev sahibi kazanır: ilk golü ev sahibi atarsa ihtimal artar, deplasman atarsa düşer
  const firstHome = fav.scenarios.find((s) => s.text.startsWith(`İlk golü ${H}`));
  const firstAway = fav.scenarios.find((s) => s.text.startsWith(`İlk golü ${A}`));
  assert.ok(firstHome && firstHome.delta > 0);
  assert.ok(firstAway && firstAway.delta < 0);
  // 2,5 üst: devre 0-0 biterse ihtimal düşer
  const over = buildAsk({ market: 'au', choice: '2.5 Üst', homeName: H, awayName: A, model });
  assert.ok(over.scenarios.find((s) => s.text === 'Devre 0-0 biterse').delta < 0);
  assert.ok(over.watch.length >= 1);
  // Aynı seçimde rakamlar herkes için aynı, kalıp cümleler kullanıcıya göre değişebilir
  const u1 = buildAsk({ market: 'kg', choice: 'Var', homeName: H, awayName: A, model, seed: 'u1|k' });
  const u2 = buildAsk({ market: 'kg', choice: 'Var', homeName: H, awayName: A, model, seed: 'u9|k' });
  assert.equal(u1.pct, u2.pct);
});

test('özel yorum: biten maçta seçimin tuttuğu ya da tutmadığı', () => {
  const facts = { home: 2, away: 1, ht: [1, 0], corners: 11 };
  const r = (market, choice) => buildAsk({ market, choice, homeName: H, awayName: A, model, facts }).result.hit;
  assert.equal(r('ms', '1'), true);
  assert.equal(r('ms', 'X'), false);
  assert.equal(r('au', '2.5 Üst'), true);
  assert.equal(r('kg', 'Var'), true);
  assert.equal(r('iy', '1'), true);
  assert.equal(r('iyms', '1/1'), true);
  assert.equal(r('iyg', '1.5 Üst'), false);
  assert.equal(r('tg', 'A2'), false);
  assert.equal(r('score', '2-1'), true);
  assert.equal(r('corners', '10.5 Üst'), true);
  const noHt = buildAsk({ market: 'iy', choice: '1', homeName: H, awayName: A, model, facts: { home: 2, away: 1, ht: null } });
  assert.equal(noHt.result.hit, null);
});

test('özel yorum servisi: abonelik ya da AI paketi gerekir; maç bitince herkese açık; ekran görüntüsü kilidi içeriği kapatır', async () => {
  const fixture = { league: 'demo.1', eventId: '9001', kickoff: new Date(FUTURE).toISOString() };
  const finished = { league: 'demo.1', eventId: '9002', kickoff: new Date(PAST).toISOString() };
  const store = makeStore();
  const locks = new Map();
  const capture = new CaptureLocks({
    store: { get: async (uid) => ({ keys: Object.fromEntries((locks.get(uid) ?? []).map((k) => [k, {}])) }), add: async (uid, keys) => locks.set(uid, [...(locks.get(uid) ?? []), ...keys]) },
    cacheMs: 0,
    log: {},
  });
  const svc = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => FUTURE - 2 * 86400000, capture });
  await assert.rejects(svc.askSpecial({ uid: 'u1', ...fixture, market: 'au', choice: '2.5 Üst' }), (e) => e.code === 'subscription-required');
  await assert.rejects(svc.askSpecial({ uid: 'u1', ...fixture, market: 'au', choice: '9.5 Üst' }), (e) => e.code === 'invalid-argument');
  const done = await svc.askSpecial({ uid: 'u1', ...finished, market: 'ms', choice: '1' });
  assert.equal(done.ask.result.done, true);
  assert.equal(done.ask.result.hit, true, 'demo maç 2-1 bitti');

  const sub = makeStore({ subscription: subscribed('weekly') });
  sub.users.u2 = { subscription: subscribed('weekly'), trialUsed: 0, wheel: null };
  const svc2 = new PaidContentService({ leagues: ['demo.1'], store: sub, espn: makeEspn(), now: () => FUTURE - 2 * 86400000, capture });
  const a = await svc2.askSpecial({ uid: 'u1', ...fixture, market: 'kg', choice: 'Yok' });
  assert.equal(a.ask.market, 'kg');
  assert.equal(a.ask.result, null);
  const corners = await svc2.askSpecial({ uid: 'u1', ...fixture, market: 'corners', choice: '9.5 Üst' });
  assert.equal(corners.ask.market, 'corners');

  // Ekran görüntüsü: maç kilitlenir, AI içerikleri bu kullanıcıya kapanır
  const rep = await capture.report({ uid: 'u1', keys: [a.key, 'kötü anahtar!'], area: 'ask' });
  assert.deepEqual(rep.locked, [a.key]);
  await assert.rejects(svc2.askSpecial({ uid: 'u1', ...fixture, market: 'kg', choice: 'Var' }), (e) => e.code === 'capture-locked');
  await assert.rejects(svc2.unlock({ uid: 'u1', ...fixture, type: 'ai' }), (e) => e.code === 'capture-locked');
  await assert.rejects(svc2.get({ uid: 'u1', ...fixture, type: 'sim' }), (e) => e.code === 'capture-locked');
  // Başka kullanıcı etkilenmez
  const other = await svc2.askSpecial({ uid: 'u2', ...fixture, market: 'kg', choice: 'Var' });
  assert.equal(other.ask.market, 'kg');
  await assert.rejects(capture.report({ uid: 'u1', keys: [] }), (e) => e.code === 'invalid-argument');
});

test('özel yorum servisi: tam içerik gecikirse günlük tahmindeki modelle hemen yanıt verir (ekran takılı kalmaz)', async () => {
  const fixture = { league: 'demo.1', eventId: '9001', kickoff: new Date(FUTURE).toISOString() };
  const sub = makeStore({ subscription: subscribed('weekly') });
  let asked = 0;
  const svc = new PaidContentService({
    leagues: ['demo.1'],
    store: sub,
    espn: makeEspn(),
    now: () => FUTURE - 2 * 86400000,
    askBudgetMs: 30,
    quickModel: async () => {
      asked++;
      return { lambdaHome: 1.7, lambdaAway: 0.9, sigma: 0.1 };
    },
  });
  // İçerik hesaplaması bitmeyecek kadar uzun sürüyor
  svc.contentFor = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await svc.askSpecial({ uid: 'u1', ...fixture, market: 'ms', choice: '1' });
  assert.ok(Date.now() - t0 < 2000, 'süre sınırında yanıt');
  assert.equal(asked, 1);
  assert.equal(r.ask.market, 'ms');
  assert.ok(r.ask.pct > 0);
  // Hızlı model de yoksa anlaşılır bir hata (sonsuz bekleme değil)
  const none = new PaidContentService({ leagues: ['demo.1'], store: sub, espn: makeEspn(), now: () => FUTURE - 2 * 86400000, askBudgetMs: 30, quickModel: async () => null });
  none.contentFor = () => new Promise(() => {});
  await assert.rejects(none.askSpecial({ uid: 'u1', ...fixture, market: 'ms', choice: '1' }), (e) => e.code === 'unavailable' && /hazırlanıyor/.test(e.message));
});
