import test from 'node:test';
import assert from 'node:assert/strict';

import * as rewards from '../rewards.js';

const { randomCode, normalizeCode, redeemProblem } = rewards;

test('jeton ödülleri kaldırıldı: günlük ödül ve davet ödülü yok', () => {
  assert.equal(rewards.dailyReward, undefined);
  assert.equal(rewards.DAILY_REWARDS, undefined);
  assert.equal(rewards.INVITE_REWARD, undefined);
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
