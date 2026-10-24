// HTTP API testleri: gerçek bir yerel sunucu açılır, sahte kimlik doğrulama ve sahte servislerle istek atılır.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApi } from '../app.js';
import { AppError } from '../logic.js';

async function start(overrides = {}) {
  const calls = [];
  const api = createApi({
    verifyToken: async (t) => {
      if (t === 'iyi') return 'u1';
      throw new Error('geçersiz');
    },
    service: {
      unlock: async (d) => (calls.push(['unlock', d]), { ok: true, type: d.type }),
      get: async () => {
        throw new AppError('permission-denied', 'Bu içerik kilitli.');
      },
      review: async () => {
        throw new Error('beklenmeyen');
      },
    },
    coupons: { unlock: async (d) => ({ couponId: d.couponId }) },
    log: { error() {} },
    rateLimit: 3,
    ...overrides,
  });
  const server = http.createServer(api);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token = 'iyi') =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  return { base, post, calls, close: () => new Promise((r) => server.close(r)) };
}

test('sağlık kontrolü', async () => {
  const s = await start();
  const r = await fetch(`${s.base}/health`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
  await s.close();
});

test('geçerli oturumla istek: uid doğrulanmış belgeden gelir, istemcinin uid\'i yok sayılır', async () => {
  const s = await start();
  const r = await s.post('/api/unlockContent', { data: { type: 'sim', uid: 'baskasi' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.result, { ok: true, type: 'sim' });
  assert.equal(s.calls[0][1].uid, 'u1');
  await s.close();
});

test('oturum yoksa ya da geçersizse 401', async () => {
  const s = await start();
  assert.equal((await s.post('/api/unlockContent', { data: {} }, null)).status, 401);
  const bad = await s.post('/api/unlockContent', { data: {} }, 'sahte');
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'unauthenticated');
  assert.equal(s.calls.length, 0);
  await s.close();
});

test('iş kuralı hataları kod ve mesajla döner; beklenmeyen hata ayrıntı sızdırmaz', async () => {
  const s = await start();
  const denied = await s.post('/api/getContent', { data: {} });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.message, 'Bu içerik kilitli.');
  const boom = await s.post('/api/getReview', { data: {} });
  assert.equal(boom.status, 500);
  assert.equal(boom.json.error.code, 'internal');
  assert.ok(!JSON.stringify(boom.json).includes('beklenmeyen'));
  await s.close();
});

test('bilinmeyen yol 404, bozuk JSON 400, hız sınırı 429', async () => {
  const s = await start();
  assert.equal((await s.post('/api/silHerSeyi', { data: {} })).status, 404);
  assert.equal((await s.post('/api/unlockCoupon', '{bozuk')).status, 400);
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await s.post('/api/unlockCoupon', { data: { couponId: 'c1' } })).status);
  assert.ok(codes.includes(429), `hız sınırı devreye girmeli: ${codes}`);
  await s.close();
});

test('Özel Yorum, Asistan, Günün Maçı ve abonelik uçları yönlendirilir; uid doğrulanmış belgeden gelir', async () => {
  const s = await start({
    service: {
      unlockSpecial: async (d) => ({ topics: d.topics, uid: d.uid }),
      getSpecial: async (d) => ({ uid: d.uid }),
    },
    assistant: { analyze: async (d) => ({ uid: d.uid, question: d.question }) },
    featured: { set: async (d) => ({ dayKey: '2026-10-24', uid: d.uid }), clear: async (d) => ({ dayKey: d.dayKey }) },
    admin: { setSubscription: async (d) => ({ plan: d.plan, target: d.targetUid }) },
    rateLimit: 100,
  });
  const a = await s.post('/api/unlockSpecial', { data: { topics: ['corners'], uid: 'baskasi' } });
  assert.deepEqual(a.json.result, { topics: ['corners'], uid: 'u1' });
  assert.equal((await s.post('/api/getSpecial', { data: {} })).json.result.uid, 'u1');
  assert.deepEqual((await s.post('/api/assistantAnalyze', { data: { question: 'korner' } })).json.result, { uid: 'u1', question: 'korner' });
  assert.equal((await s.post('/api/setFeatured', { data: {} })).json.result.dayKey, '2026-10-24');
  assert.equal((await s.post('/api/clearFeatured', { data: { dayKey: '2026-10-24' } })).json.result.dayKey, '2026-10-24');
  assert.deepEqual((await s.post('/api/adminSetSubscription', { data: { plan: 'monthly', targetUid: 'x' } })).json.result, { plan: 'monthly', target: 'x' });
  await s.close();
});

test('Asistan ve Günün Maçı servisleri verilmezse uçlar yoktur', async () => {
  const s = await start();
  assert.equal((await s.post('/api/assistantAnalyze', { data: {} })).status, 404);
  assert.equal((await s.post('/api/setFeatured', { data: {} })).status, 404);
  assert.equal((await s.post('/api/adminSetSubscription', { data: {} })).status, 404);
  await s.close();
});
