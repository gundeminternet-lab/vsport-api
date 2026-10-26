import test from 'node:test';
import assert from 'node:assert/strict';

import * as admin from '../admin.js';
import { grantSubscription } from '../subscription.js';

test('jeton işlemi kaldırıldı; abonelik verme kuralları', () => {
  assert.equal(admin.validateAdjust, undefined);
  const now = Date.UTC(2026, 9, 26);
  const sub = grantSubscription(null, { plan: 'weekly', days: 7, now, by: 'adm' });
  assert.equal(sub.until, now + 7 * 86400000);
  // Aynı plan uzatılırsa bitişin üzerine eklenir
  assert.equal(grantSubscription(sub, { plan: 'weekly', days: 7, now }).until, now + 14 * 86400000);
  for (const bad of [{ plan: 'daily', days: 7 }, { plan: 'weekly', days: 0 }, { plan: 'yearly', days: 1000 }]) {
    assert.throws(() => grantSubscription(null, { ...bad, now }), (e) => e.code === 'invalid-argument');
  }
});
