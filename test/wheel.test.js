// Günlük hediye çarkı: ihtimaller, günde bir çevirme, haklar (7 gün), hakların içerik/editör seçimi/Asistan için kullanımı.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WHEEL_WEIGHTS, WHEEL_PRIZES, WHEEL_SLICES, TOTAL_WEIGHT, CREDIT_PRIZES, CREDIT_DAYS, XP_PRIZE,
  pickPrize, sliceOf, nextMidnightTr, applySpin, takeCredit, validCredits, wheelStatus, WheelService,
} from '../wheel.js';
import { entitlementOf, AccessService } from '../subscription.js';
import { PaidContentService } from '../logic.js';
import { CouponService } from '../coupons.js';
import { AssistantService } from '../assistant.js';
import { NOW, FUTURE, makeEspn, makeStore, fixture, subscribed, wheelWith } from './helpers.js';

const DAY = 86400000;
const HOUR = 3600e3;

test('ihtimaller: toplam 1000, büyük ödül (AI Asistan) en zoru, her ödül çarkta var', () => {
  assert.equal(TOTAL_WEIGHT, 1000);
  assert.deepEqual(WHEEL_WEIGHTS, { xp: 640, sim: 150, commentator: 110, editor: 60, full: 30, assistant: 10 });
  const min = Math.min(...Object.values(WHEEL_WEIGHTS));
  assert.equal(WHEEL_WEIGHTS.assistant, min);
  assert.ok(WHEEL_WEIGHTS.full < WHEEL_WEIGHTS.editor && WHEEL_WEIGHTS.editor < WHEEL_WEIGHTS.commentator && WHEEL_WEIGHTS.commentator < WHEEL_WEIGHTS.sim);
  for (const p of WHEEL_PRIZES) assert.ok(WHEEL_SLICES.includes(p), p);
  assert.equal(WHEEL_SLICES.length, 8);
  // Her sonuç tam ağırlığı kadar çıkar (0..999 taranır)
  const counts = {};
  for (let r = 0; r < TOTAL_WEIGHT; r++) counts[pickPrize(r)] = (counts[pickPrize(r)] ?? 0) + 1;
  assert.deepEqual(counts, WHEEL_WEIGHTS);
  assert.equal(pickPrize(0), 'xp');
  assert.equal(pickPrize(999), 'assistant');
});

test('dilim: ödülün dilimine düşer; XP üç dilimden birine', () => {
  for (const p of WHEEL_PRIZES) for (let r = 0; r < 6; r++) assert.equal(WHEEL_SLICES[sliceOf(p, r)], p);
  const xpSlices = new Set([0, 1, 2].map((r) => sliceOf('xp', r)));
  assert.equal(xpSlices.size, 3);
});

test('yeni hak Türkiye saatiyle gece yarısı', () => {
  // 26 Ekim 09:49 TSİ → 27 Ekim 00:00 TSİ (26 Ekim 21:00 UTC)
  assert.equal(nextMidnightTr(Date.UTC(2026, 9, 26, 6, 49)), Date.UTC(2026, 9, 26, 21, 0));
  // 23:30 TSİ → yarım saat sonra
  assert.equal(nextMidnightTr(Date.UTC(2026, 9, 26, 20, 30)), Date.UTC(2026, 9, 26, 21, 0));
});

test('kayıt: maç/editör hakkı 7 gün saklanır, süresi geçen düşer; Asistan ödülü 24 saat (üst üste eklenir)', () => {
  let w = applySpin(null, { prize: 'sim', slice: 2, now: NOW, id: 'a' });
  assert.equal(w.credits.length, 1);
  assert.equal(w.credits[0].until, NOW + CREDIT_DAYS * DAY);
  assert.equal(w.last.prize, 'sim');
  w = applySpin(w, { prize: 'xp', slice: 1, now: NOW + DAY, id: 'b' });
  assert.equal(w.credits.length, 1, 'XP hak olarak saklanmaz');
  assert.equal(validCredits(w, NOW + CREDIT_DAYS * DAY + 1).length, 0, '7 gün sonra geçersiz');
  const later = applySpin(w, { prize: 'editor', slice: 5, now: NOW + 8 * DAY, id: 'c' });
  assert.deepEqual(later.credits.map((c) => c.prize), ['editor'], 'süresi geçen kayıttan silinir');

  const a1 = applySpin(null, { prize: 'assistant', slice: 0, now: NOW, id: 'x' });
  assert.equal(a1.assistantUntil, NOW + 24 * HOUR);
  const a2 = applySpin(a1, { prize: 'assistant', slice: 0, now: NOW + 2 * HOUR, id: 'y' });
  assert.equal(a2.assistantUntil, NOW + 48 * HOUR);
  assert.equal(wheelStatus(a2, NOW + 49 * HOUR).assistantUntil, null);
});

test('hak düşme: süresi en yakın olan kullanılır; olmayan hak null', () => {
  const w = { credits: [
    { id: '1', prize: 'full', at: NOW, until: NOW + 5 * DAY },
    { id: '2', prize: 'full', at: NOW, until: NOW + 2 * DAY },
    { id: '3', prize: 'sim', at: NOW, until: NOW + 6 * DAY },
    { id: '4', prize: 'gold', at: NOW, until: NOW + 6 * DAY },
  ] };
  const t = takeCredit(w, 'full', NOW);
  assert.equal(t.credit.id, '2');
  assert.deepEqual(t.wheel.credits.map((c) => c.id), ['1', '3'], 'bilinmeyen ödül atılır');
  assert.equal(takeCredit(w, 'editor', NOW), null);
  assert.equal(takeCredit(w, 'full', NOW + 6 * DAY), null, 'süresi geçmiş');
  const st = wheelStatus(w, NOW);
  assert.deepEqual(st.credits, { sim: 1, commentator: 0, editor: 0, full: 2 });
  assert.deepEqual(CREDIT_PRIZES, ['sim', 'commentator', 'editor', 'full']);
});

function rolls(...values) {
  const q = [...values];
  return () => (q.length ? q.shift() : 0);
}

test('çevirme: günde bir kez (TSİ); ertesi gün yeniden; XP ödülü seviyeye işlenir', async () => {
  const store = makeStore();
  const added = [];
  let now = Date.UTC(2026, 9, 26, 6, 49); // 09:49 TSİ
  const svc = new WheelService({ store, now: () => now, random: rolls(10, 1), progress: { add: async (uid, d) => added.push([uid, d]) } });
  const r = await svc.spin({ uid: 'u1' });
  assert.equal(r.prize, 'xp');
  assert.equal(WHEEL_SLICES[r.slice], 'xp');
  assert.equal(r.canSpin, false);
  assert.equal(r.nextSpinAt, Date.UTC(2026, 9, 26, 21, 0));
  assert.deepEqual(added, [['u1', { xp: XP_PRIZE }]]);
  await assert.rejects(svc.spin({ uid: 'u1' }), (e) => e.code === 'failed-precondition' && /Bugünkü çark/.test(e.message));
  now = Date.UTC(2026, 9, 26, 20, 59); // 23:59 TSİ: hâlâ aynı gün
  await assert.rejects(svc.spin({ uid: 'u1' }), (e) => e.code === 'failed-precondition');
  now = Date.UTC(2026, 9, 26, 21, 0); // 00:00 TSİ
  svc.random = rolls(700, 0); // sim
  const r2 = await svc.spin({ uid: 'u1' });
  assert.equal(r2.prize, 'sim');
  assert.equal(r2.credits.sim, 1);
  assert.equal((await svc.status({ uid: 'u1' })).canSpin, false);
  await assert.rejects(svc.spin({ uid: null }), (e) => e.code === 'permission-denied');
});

test('büyük ödül: 24 saat AI Asistan (haftalık aboneye de); Asistan çalışır', async () => {
  const store = makeStore();
  const svc = new WheelService({ store, now: () => NOW, random: rolls(999, 0) });
  const r = await svc.spin({ uid: 'u1' });
  assert.equal(r.prize, 'assistant');
  assert.equal(r.assistantUntil, NOW + 24 * HOUR);
  const ent = entitlementOf(await store.getAccess('u1'), NOW + HOUR);
  assert.deepEqual({ a: ent.assistant, via: ent.assistantVia, s: ent.subscribed }, { a: true, via: 'wheel', s: false });
  assert.equal(entitlementOf(await store.getAccess('u1'), NOW + 25 * HOUR).assistant, false);
  // Haftalık abone + çark ödülü
  const weekly = entitlementOf({ subscription: { plan: 'weekly', until: NOW + DAY }, wheel: { assistantUntil: NOW + HOUR } }, NOW);
  assert.equal(weekly.assistant, true);
  assert.equal(entitlementOf({ subscription: subscribed('monthly') }, NOW).assistantVia, 'plan');

  const paid = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW + HOUR });
  const assistant = new AssistantService({ paid, store, now: () => NOW + HOUR });
  const reply = await assistant.analyze({ uid: 'u1', ...fixture });
  assert.ok(reply);
  const expired = new AssistantService({ paid, store, now: () => NOW + 25 * HOUR, access: new AccessService({ store, now: () => NOW + 25 * HOUR }) });
  await assert.rejects(expired.analyze({ uid: 'u1', ...fixture }), (e) => e.code === 'subscription-required');
});

const paidWith = (prizes, { now = NOW, subscription = null } = {}) => {
  const store = makeStore({ subscription, wheel: wheelWith(prizes, NOW) });
  return { store, svc: new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => now }) };
};

test('"Tüm özellikler" hakkı: maçın AI paketini açar (simülasyon ve Özel Yorumlar dahil), hak düşer', async () => {
  const { store, svc } = paidWith(['full', 'full']);
  const r = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'full' });
  assert.deepEqual({ via: r.via, use: r.use, left: r.creditsLeft }, { via: 'wheel', use: 'full', left: 1 });
  assert.ok(store.unlocks.has(`u1/demo_1_9001_ai`));
  assert.equal(store.records.get('u1/demo_1_9001_ai').prize, 'full');
  assert.equal((await svc.get({ uid: 'u1', ...fixture, type: 'sim' })).data.finalScore !== undefined, true);
  const sp = await svc.unlockSpecial({ uid: 'u1', ...fixture, topics: 'all' });
  assert.equal(sp.topics.length, 4);
  // Aynı maç ikinci kez hak harcamaz
  const again = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'full' });
  assert.equal(again.via, 'unlock');
  assert.equal(store.users.u1.wheel.credits.length, 1);
  assert.equal(store.users.u1.trialUsed, 0, 'deneme hakkı harcanmaz');
});

test('"AI Yorumcu" hakkı: AI analizi ve videosu açılır; simülasyon ve Özel Yorumlar kapalı kalır', async () => {
  const { store, svc } = paidWith(['commentator', 'full']);
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'sim', use: 'commentator' }), (e) => e.code === 'subscription-required');
  const r = await svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'commentator' });
  assert.equal(r.via, 'wheel');
  assert.ok(r.data.story, 'AI videosu verisi');
  assert.ok(store.unlocks.has('u1/demo_1_9001_aic'));
  assert.ok((await svc.get({ uid: 'u1', ...fixture, type: 'ai' })).data.sections.length > 0);
  assert.equal(await svc.covers('u1', 'demo_1_9001', 'ai'), true, 'kadro güncellemesi ve maç sonu karnesi AI analizine bağlı');
  await assert.rejects(svc.get({ uid: 'u1', ...fixture, type: 'sim' }), (e) => e.code === 'subscription-required');
  await assert.rejects(svc.unlockSpecial({ uid: 'u1', ...fixture, topics: 'all' }), (e) => e.code === 'subscription-required');
  // Sonradan "tüm özellikler" ile paket tamamlanır
  const up = await svc.unlock({ uid: 'u1', ...fixture, type: 'sim', use: 'full' });
  assert.equal(up.via, 'wheel');
  assert.equal(await svc.covers('u1', 'demo_1_9001', 'sp_corners'), true);
  assert.equal(store.users.u1.wheel.credits.length, 0);
});

test('"Simülasyon" hakkı: yalnızca simülasyon', async () => {
  const { store, svc } = paidWith(['sim']);
  await assert.rejects(svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'sim' }), (e) => e.code === 'subscription-required');
  const r = await svc.unlock({ uid: 'u1', ...fixture, type: 'sim', use: 'sim' });
  assert.equal(r.via, 'wheel');
  assert.ok(store.unlocks.has('u1/demo_1_9001_sim'));
  assert.ok((await svc.get({ uid: 'u1', ...fixture, type: 'sim' })).data.finalScore);
  await assert.rejects(svc.get({ uid: 'u1', ...fixture, type: 'ai' }), (e) => e.code === 'subscription-required');
});

test('çark hakkı: maç başladıysa, hak yoksa ya da süresi geçtiyse kullanılamaz; hiçbir şey harcanmaz', async () => {
  const late = paidWith(['full'], { now: FUTURE + 60000 });
  await assert.rejects(late.svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'full' }), (e) => e.code === 'failed-precondition' && /çark ödülleri/.test(e.message));
  assert.equal(late.store.users.u1.wheel.credits.length, 1);

  const none = paidWith([]);
  await assert.rejects(none.svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'commentator' }), (e) => e.code === 'subscription-required');
  assert.equal(none.store.saves, 0, 'içerik üretilmez');

  const old = paidWith(['full'], { now: NOW + 8 * DAY });
  // Maç saati bu testte geçmiş olur; önce hak kontrolü yapılır
  await assert.rejects(old.svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'full' }), (e) => e.code === 'subscription-required');

  await assert.rejects(paidWith(['full']).svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'gold' }), (e) => e.code === 'invalid-argument');
});

test('abone çark hakkı harcamaz; deneme hakkı açıkça istenebilir', async () => {
  const sub = paidWith(['full'], { subscription: subscribed('weekly') });
  const r = await sub.svc.unlock({ uid: 'u1', ...fixture, type: 'ai', use: 'full' });
  assert.equal(r.via, 'subscription');
  assert.equal(sub.store.users.u1.wheel.credits.length, 1);

  const trial = paidWith(['full']);
  const t = await trial.svc.unlock({ uid: 'u1', ...fixture, type: 'sim', use: 'trial' });
  assert.equal(t.via, 'trial');
  assert.equal(trial.store.users.u1.trialUsed, 1);
  assert.equal(trial.store.users.u1.wheel.credits.length, 1, 'çark hakkı duruyor');
});

function couponStore(opts) {
  const s = makeStore(opts);
  s.users.ed = { subscription: null, trialUsed: 0, wheel: null };
  s.coupons = { c1: { editorUid: 'ed', title: '3 maçlık seçim', firstKickoff: new Date(NOW + HOUR).toISOString() } };
  s.getCoupon = async (id) => s.coupons[id] ?? null;
  return s;
}

test('editör seçimi hakkı: abone olmayan bir seçimi açar; hak yoksa abonelik gerekir; abone hak harcamaz', async () => {
  const st = couponStore({ wheel: wheelWith(['editor']) });
  const svc = new CouponService({ store: st, now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'c1' }), (e) => e.code === 'subscription-required', 'use verilmeden hak harcanmaz');
  const r = await svc.unlock({ uid: 'u1', couponId: 'c1', use: 'editor' });
  assert.deepEqual({ opened: r.opened, via: r.via, left: r.creditsLeft }, { opened: true, via: 'wheel', left: 0 });
  assert.equal(st.records.get('u1/coupon_c1').via, 'wheel');
  assert.equal((await svc.unlock({ uid: 'u1', couponId: 'c1', use: 'editor' })).opened, true, 'açık seçim tekrar hak istemez');

  const empty = new CouponService({ store: couponStore(), now: () => NOW });
  await assert.rejects(empty.unlock({ uid: 'u1', couponId: 'c1', use: 'editor' }), (e) => e.code === 'subscription-required');

  const subSt = couponStore({ subscription: subscribed('weekly'), wheel: wheelWith(['editor']) });
  const sub = await new CouponService({ store: subSt, now: () => NOW }).unlock({ uid: 'u1', couponId: 'c1', use: 'editor' });
  assert.equal(sub.via, 'subscription');
  assert.equal(subSt.users.u1.wheel.credits.length, 1);
});

test('haklar özeti: uygulamaya giden çark durumu', () => {
  const ent = entitlementOf({ wheel: wheelWith(['sim', 'full'], NOW, { day: '2026-10-17', nextAt: NOW + HOUR }) }, NOW);
  assert.equal(ent.wheel.canSpin, false);
  assert.equal(ent.wheel.nextSpinAt, NOW + HOUR);
  assert.deepEqual(ent.wheel.credits, { sim: 1, commentator: 0, editor: 0, full: 1 });
  assert.equal(entitlementOf({}, NOW).wheel.canSpin, true);
});
