import test from 'node:test';
import assert from 'node:assert/strict';

import { activeSubscription, hasAssistantAccess, grantSubscription, dayKeyTr, PLAN_DAYS, PLAN_PRICES_TL, PLAN_PRODUCTS, planOfProduct, entitlementOf, TRIAL_MATCHES, AccessService } from '../subscription.js';

const NOW = Date.UTC(2026, 9, 24, 10, 0);
const DAY = 86400000;

test('abonelik yalnızca süresi dolmamışsa geçerli', () => {
  assert.equal(activeSubscription(null, NOW), null);
  assert.equal(activeSubscription({ plan: 'monthly', until: NOW - 1 }, NOW), null);
  assert.deepEqual(activeSubscription({ plan: 'monthly', until: NOW + 1 }, NOW), { plan: 'monthly', until: NOW + 1 });
  assert.equal(activeSubscription({ plan: 'gold', until: NOW + DAY }, NOW), null, 'bilinmeyen plan');
  assert.equal(activeSubscription({ plan: 'monthly', until: 'x' }, NOW), null);
});

test('Asistan yalnızca aylık ve yıllık abonelere açık', () => {
  assert.equal(hasAssistantAccess({ plan: 'weekly', until: NOW + DAY }, NOW), false);
  assert.equal(hasAssistantAccess({ plan: 'monthly', until: NOW + DAY }, NOW), true);
  assert.equal(hasAssistantAccess({ plan: 'yearly', until: NOW + DAY }, NOW), true);
  assert.equal(hasAssistantAccess({ plan: 'yearly', until: NOW - DAY }, NOW), false);
  assert.equal(hasAssistantAccess(undefined, NOW), false);
});

test('yönetici aboneliği: yeni kayıt, aynı planda süre eklenir, farklı planda yeniden başlar', () => {
  const a = grantSubscription(null, { plan: 'monthly', days: PLAN_DAYS.monthly, now: NOW, by: 'adm' });
  assert.equal(a.until, NOW + 30 * DAY);
  assert.equal(a.source, 'admin');
  const b = grantSubscription(a, { plan: 'monthly', days: 30, now: NOW + 10 * DAY });
  assert.equal(b.until, NOW + 60 * DAY, 'kalan süre üzerine eklenir');
  const c = grantSubscription(a, { plan: 'yearly', days: 365, now: NOW + 10 * DAY });
  assert.equal(c.until, NOW + 10 * DAY + 365 * DAY);
  assert.throws(() => grantSubscription(null, { plan: 'x', days: 5, now: NOW }), (e) => e.code === 'invalid-argument');
  assert.throws(() => grantSubscription(null, { plan: 'monthly', days: 0, now: NOW }), (e) => e.code === 'invalid-argument');
  assert.throws(() => grantSubscription(null, { plan: 'monthly', days: 1.5, now: NOW }), (e) => e.code === 'invalid-argument');
});

test('gün anahtarı Türkiye saatine göre', () => {
  assert.equal(dayKeyTr(Date.UTC(2026, 9, 24, 20, 59)), '2026-10-24');
  assert.equal(dayKeyTr(Date.UTC(2026, 9, 24, 21, 0)), '2026-10-25', '00:00 TSİ');
});

test('planlar ve fiyatlar: haftalık 300, aylık 999, yıllık 1999 TL; Play ürün kimlikleri', () => {
  assert.deepEqual(PLAN_PRICES_TL, { weekly: 300, monthly: 999, yearly: 1999 });
  for (const [plan, product] of Object.entries(PLAN_PRODUCTS)) assert.equal(planOfProduct(product), plan);
  assert.equal(planOfProduct('tokens_100'), null);
});

test('haklar: abone her şeyi açar (Asistan yalnızca aylık/yıllık); abone olmayana 2 maç deneme', () => {
  const none = entitlementOf({}, NOW);
  assert.deepEqual({ s: none.subscribed, a: none.assistant, left: none.trialLeft }, { s: false, a: false, left: TRIAL_MATCHES });
  assert.equal(TRIAL_MATCHES, 2);
  assert.equal(entitlementOf({ trialUsed: 1 }, NOW).trialLeft, 1);
  assert.equal(entitlementOf({ trialUsed: 5 }, NOW).trialLeft, 0);
  const weekly = entitlementOf({ subscription: { plan: 'weekly', until: NOW + DAY } }, NOW);
  assert.deepEqual({ s: weekly.subscribed, a: weekly.assistant, p: weekly.plan }, { s: true, a: false, p: 'weekly' });
  assert.equal(entitlementOf({ subscription: { plan: 'yearly', until: NOW + DAY } }, NOW).assistant, true);
  assert.equal(entitlementOf({ subscription: { plan: 'monthly', until: NOW - 1 }, trialUsed: 2 }, NOW).subscribed, false);
});

test('erişim: süresi geçmiş Play aboneliği mağazadan yenilenir (10 dakikada en çok bir kez)', async () => {
  let sub = { plan: 'monthly', until: NOW - 1000, source: 'play' };
  let calls = 0;
  const store = { getAccess: async () => ({ subscription: sub, trialUsed: 0 }) };
  const billing = {
    enabled: true,
    async refresh() {
      calls++;
      sub = { ...sub, until: NOW + 30 * DAY };
      return sub;
    },
  };
  let t = NOW;
  const access = new AccessService({ store, billing, now: () => t });
  assert.equal((await access.entitlement('u')).subscribed, true, 'yenilenmiş abonelik');
  assert.equal(calls, 1);
  sub = { ...sub, until: NOW - 1 };
  await access.entitlement('u');
  assert.equal(calls, 1, 'hemen tekrar sorulmaz');
  t += 11 * 60e3;
  await access.entitlement('u');
  assert.equal(calls, 2);
  // Yönetici aboneliği mağazaya sorulmaz
  sub = { plan: 'monthly', until: NOW - 1, source: 'admin' };
  t += 11 * 60e3;
  await access.entitlement('u');
  assert.equal(calls, 2);
});
