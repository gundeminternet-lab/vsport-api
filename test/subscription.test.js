import test from 'node:test';
import assert from 'node:assert/strict';

import { activeSubscription, hasAssistantAccess, grantSubscription, dayKeyTr, PLAN_DAYS } from '../subscription.js';

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
