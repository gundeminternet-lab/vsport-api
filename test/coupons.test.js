import test from 'node:test';
import assert from 'node:assert/strict';

import { CouponService } from '../coupons.js';
import { AppError } from '../logic.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0);

function store(tokens = 200) {
  const s = {
    tokens: { u1: tokens, ed: 0 },
    unlocks: new Set(),
    coupons: {
      c1: { editorUid: 'ed', title: '3 maçlık kupon', price: 75, firstKickoff: new Date(NOW + 3600e3).toISOString() },
      old: { editorUid: 'ed', title: 'Eski', price: 20, firstKickoff: new Date(NOW - 60e3).toISOString() },
      bad: { editorUid: 'ed', title: 'Hatalı', price: 99999, firstKickoff: new Date(NOW + 3600e3).toISOString() },
      gone: { editorUid: 'ed', deleted: true, price: 10, firstKickoff: new Date(NOW + 3600e3).toISOString() },
    },
    async getCoupon(id) { return s.coupons[id] ?? null; },
    async hasUnlockId(uid, id) { return s.unlocks.has(`${uid}/${id}`); },
    async purchase({ uid, unlockId, price }) {
      if (s.unlocks.has(`${uid}/${unlockId}`)) return { charged: false, balance: s.tokens[uid] };
      if (s.tokens[uid] < price) throw new AppError('failed-precondition', 'Yetersiz token');
      s.tokens[uid] -= price;
      s.unlocks.add(`${uid}/${unlockId}`);
      return { charged: true, balance: s.tokens[uid] };
    },
  };
  return s;
}

test('kupon: editörün fiyatı düşer, ikinci kez ücret alınmaz', async () => {
  const st = store(200);
  const svc = new CouponService({ store: st, now: () => NOW });
  const r = await svc.unlock({ uid: 'u1', couponId: 'c1' });
  assert.equal(r.charged, true);
  assert.equal(st.tokens.u1, 125);
  const again = await svc.unlock({ uid: 'u1', couponId: 'c1' });
  assert.equal(again.charged, false);
  assert.equal(st.tokens.u1, 125);
});

test('kupon: onaydan sonra fiyat değiştiyse ücret alınmaz; zaman damgası esas alınır', async () => {
  const st = store(200);
  const svc = new CouponService({ store: st, now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'c1', price: 50 }), (e) => e.code === 'failed-precondition');
  assert.equal(st.tokens.u1, 200);
  // metin alanı geleceği gösterse de zaman damgası geçmişse satılmaz
  st.coupons.fake = { editorUid: 'ed', price: 10, firstKickoff: new Date(NOW + 3600e3).toISOString(), firstKickoffAt: { toMillis: () => NOW - 1000 } };
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'fake' }), (e) => e.code === 'failed-precondition');
  const ok = await svc.unlock({ uid: 'u1', couponId: 'c1', price: 75 });
  assert.equal(ok.charged, true);
});

test('kupon: editör kendi kuponu için ödemez', async () => {
  const st = store();
  const r = await new CouponService({ store: st, now: () => NOW }).unlock({ uid: 'ed', couponId: 'c1' });
  assert.equal(r.charged, false);
  assert.equal(st.tokens.ed, 0);
});

test('kupon: ilk maç başladıysa, fiyat geçersizse, silinmişse, bakiye yetmezse satın alınamaz', async () => {
  const svc = new CouponService({ store: store(50), now: () => NOW });
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'old' }), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'bad' }), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'gone' }), (e) => e.code === 'not-found');
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: 'c1' }), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc.unlock({ uid: 'u1', couponId: '../x' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.unlock({ uid: null, couponId: 'c1' }), (e) => e.code === 'permission-denied');
});
