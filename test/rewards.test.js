import test from 'node:test';
import assert from 'node:assert/strict';

import { dailyReward, randomCode, normalizeCode, redeemProblem, DAILY_REWARDS } from '../rewards.js';

test('günlük ödül döngüsü', () => {
  assert.equal(dailyReward(1), 5);
  assert.equal(dailyReward(7), 50);
  assert.equal(dailyReward(8), 5);
  assert.equal(dailyReward(14), 50);
  assert.equal(dailyReward(0), DAILY_REWARDS[0]);
});

test('davet kodu biçimi', () => {
  const c = randomCode();
  assert.match(c, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(normalizeCode('vsp-ab3k9q'), 'AB3K9Q');
  assert.equal(normalizeCode(' ab3 k9q '), 'AB3K9Q');
});

test('davet kodu koşulları', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  const fresh = { createdAt: now - 86400e3 };
  assert.equal(redeemProblem({ user: fresh, inviterUid: 'x', uid: 'u', nowMs: now }), null);
  assert.match(redeemProblem({ user: fresh, inviterUid: 'u', uid: 'u', nowMs: now }), /Kendi/);
  assert.match(redeemProblem({ user: { ...fresh, invitedBy: 'y' }, inviterUid: 'x', uid: 'u', nowMs: now }), /Daha önce/);
  assert.match(redeemProblem({ user: { createdAt: now - 10 * 86400e3 }, inviterUid: 'x', uid: 'u', nowMs: now }), /7 gün/);
  assert.match(redeemProblem({ user: fresh, inviterUid: null, uid: 'u', nowMs: now }), /bulunamadı/);
});
