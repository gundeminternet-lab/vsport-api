// Editör kuponları: abonelere açık (jeton yok); editör kendi kuponunu her zaman görür.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CouponService } from '../coupons.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0);

function store({ subscription = null } = {}) {
  const s = {
    users: { u1: { subscription, trialUsed: 0 }, ed: { subscription: null, trialUsed: 0 } },
    unlocks: new Set(),
    records: new Map(),
    coupons: {
      c1: { editorUid: 'ed', title: '3 maçlık kupon', price: 0, firstKickoff: new Date(NOW + 3600e3).toISOString() },
      old: { editorUid: 'ed', title: 'Eski', price: 0, firstKickoff: new Date(NOW - 60e3).toISOString() },
      gone: { editorUid: 'ed', deleted: true, price: 0, firstKickoff: new Date(NOW + 3600e3).toISOString() },
    },
    async getCoupon(id) { return s.coupons[id] ?? null; },
    async hasUnlockId(uid, id) { return s.unlocks.has(`${uid}/${id}`); },
    async getAccess(uid) { return s.users[uid] ?? { subscription: null, trialUsed: 0 }; },
    async recordUnlock({ uid, unlockId, record }) {
      const id = `${uid}/${unlockId}`;
      if (s.unlocks.has(id)) return { created: false };
      s.unlocks.add(id);
      s.records.set(id, record);
      return { created: true };
    },
  };
  return s;
}

const active = { plan: 'weekly', until: NOW + 7 * 86400e3 };

test('kupon: abone açar (her plan), açılan kupon geçmişe yazılır; ikinci kez yeniden yazılmaz', async () => {
  const st = store({ subscription: active });
  const svc = new CouponService({ store: st, now: () => NOW });
  const r = await svc.unlock({ uid: 'u1', couponId: 'c1' });
  assert.equal(r.opened, true);
  assert.equal(st.records.get('u1/coupon_c1').via, 'subscription');
  await svc.unlock({ uid: 'u1', couponId: 'c1' });
  assert.equal(st.records.size, 1);
  // Abone, ilk maçı başlamış kuponu da açabilir
  assert.equal((await svc.unlock({ uid: 'u1', couponId: 'old' })).opened, true);
});

test('kupon: abone olmayan açamaz; editör kendi kuponunu her zaman görür', async () => {
  const st = store();
  const svc = new CouponService({ store: st, now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'c1' }), (e) => e.code === 'subscription-required');
  assert.equal(st.unlocks.size, 0);
  const own = await svc.unlock({ uid: 'ed', couponId: 'c1' });
  assert.equal(own.opened, true);
  // Süresi dolmuş abonelik sayılmaz
  const expired = store({ subscription: { plan: 'yearly', until: NOW - 1 } });
  await assert.rejects(new CouponService({ store: expired, now: () => NOW }).unlock({ uid: 'u1', couponId: 'c1' }), (e) => e.code === 'subscription-required');
});

test('kupon: silinmiş, geçersiz kimlik ve girişsiz kullanıcı reddedilir', async () => {
  const svc = new CouponService({ store: store({ subscription: active }), now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'gone' }), (e) => e.code === 'not-found');
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: '../x' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.unlock({ uid: null, couponId: 'c1' }), (e) => e.code === 'permission-denied');
});
