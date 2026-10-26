// Google Play abonelik doğrulaması: Play yanıtını okuma, hesap bağlama, onay, yenileme ve gerçek zamanlı bildirim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { PlayBilling, subscriptionFromPlay, createTokenSource, tokenHash, billingFromEnv } from '../billing.js';
import { createApi } from '../app.js';
import { makeStore, NOW } from './helpers.js';

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const playRes = ({ productId = 'vsport_monthly', until = NOW + 30 * DAY, state = 'SUBSCRIPTION_STATE_ACTIVE', account = 'u1', ack = false, autoRenew = true } = {}) => ({
  subscriptionState: state,
  acknowledgementState: ack ? 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' : 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: account ? { obfuscatedExternalAccountId: account } : undefined,
  lineItems: [{ productId, expiryTime: iso(until), autoRenewingPlan: { autoRenewEnabled: autoRenew } }],
});

function fakeApi(responses) {
  const api = {
    acks: [],
    async get(token) {
      const r = responses[token];
      if (!r) throw Object.assign(new Error('yok'), { code: 'not-found' });
      return typeof r === 'function' ? r() : r;
    },
    async acknowledge(productId, token) {
      api.acks.push([productId, token]);
    },
  };
  return api;
}

const TOKEN = 'play-token-aaaaaaaaaaaa';

test('Play yanıtı: ürün → plan, bitiş, durum; iptal edilmiş abonelik süre bitene kadar geçerli', () => {
  const a = subscriptionFromPlay(playRes(), NOW);
  assert.deepEqual({ plan: a.plan, active: a.active, accountId: a.accountId, autoRenew: a.autoRenew }, { plan: 'monthly', active: true, accountId: 'u1', autoRenew: true });
  assert.equal(subscriptionFromPlay(playRes({ state: 'SUBSCRIPTION_STATE_CANCELED' }), NOW).active, true);
  assert.equal(subscriptionFromPlay(playRes({ state: 'SUBSCRIPTION_STATE_EXPIRED', until: NOW - 1 }), NOW).active, false);
  assert.equal(subscriptionFromPlay(playRes({ state: 'SUBSCRIPTION_STATE_ON_HOLD' }), NOW).active, false);
  assert.equal(subscriptionFromPlay(playRes({ productId: 'tokens_100' }), NOW), null);
  // Plan değişikliğinde en geç biten bilinen ürün
  const two = { ...playRes(), lineItems: [{ productId: 'vsport_weekly', expiryTime: iso(NOW + DAY) }, { productId: 'vsport_yearly', expiryTime: iso(NOW + 300 * DAY) }] };
  assert.equal(subscriptionFromPlay(two, NOW).plan, 'yearly');
});

test('doğrulama: abonelik kaydedilir, satın alma onaylanır, belge yalnızca sunucuda tutulur', async () => {
  const store = makeStore();
  const api = fakeApi({ [TOKEN]: playRes() });
  const billing = new PlayBilling({ store, packageName: 'com.x', api, now: () => NOW });
  const r = await billing.verify({ uid: 'u1', productId: 'vsport_monthly', purchaseToken: TOKEN });
  assert.deepEqual({ plan: r.plan, active: r.active }, { plan: 'monthly', active: true });
  assert.equal(store.users.u1.subscription.source, 'play');
  assert.equal(store.users.u1.subscription.until, NOW + 30 * DAY);
  assert.deepEqual(api.acks, [['vsport_monthly', TOKEN]]);
  assert.equal(store.playTokens.get(tokenHash(TOKEN)).uid, 'u1');
  assert.equal(store.users.u1.subscription.tokenHash, tokenHash(TOKEN));
  assert.ok(!JSON.stringify(store.users.u1).includes(TOKEN), 'kullanıcı belgesinde satın alma belgesi yok');
});

test('doğrulama: başka hesaba ait ya da başka hesaba bağlı satın alma reddedilir; yapılandırma yoksa hata', async () => {
  const store = makeStore();
  store.users.u2 = { subscription: null, trialUsed: 0 };
  const api = fakeApi({ [TOKEN]: playRes({ account: 'u2' }) });
  const billing = new PlayBilling({ store, packageName: 'com.x', api, now: () => NOW });
  await assert.rejects(billing.verify({ uid: 'u1', purchaseToken: TOKEN }), { code: 'permission-denied' });
  // Hesap kimliği olmayan satın alma ilk bağlanan hesaba bağlanır; ikinci hesap kullanamaz
  const api2 = fakeApi({ shared_token_123: playRes({ account: null }) });
  const b2 = new PlayBilling({ store, packageName: 'com.x', api: api2, now: () => NOW });
  await b2.verify({ uid: 'u1', purchaseToken: 'shared_token_123' });
  await assert.rejects(b2.verify({ uid: 'u2', purchaseToken: 'shared_token_123' }), { code: 'permission-denied' });
  await assert.rejects(b2.verify({ uid: 'u1', purchaseToken: 'shared_token_123', productId: 'tokens_100' }), { code: 'invalid-argument' });
  const off = new PlayBilling({ store, packageName: 'com.x', now: () => NOW });
  assert.equal(off.enabled, false);
  await assert.rejects(off.verify({ uid: 'u1', purchaseToken: TOKEN }), { code: 'unavailable' });
});

test('süresi dolan abonelik: yenilenmişse uzar, bitmişse erişim kapanır', async () => {
  const store = makeStore();
  let res = playRes({ ack: true });
  const api = fakeApi({ [TOKEN]: () => res });
  let t = NOW;
  const billing = new PlayBilling({ store, packageName: 'com.x', api, now: () => t });
  await billing.verify({ uid: 'u1', purchaseToken: TOKEN });
  assert.equal(api.acks.length, 0, 'onaylı satın alma tekrar onaylanmaz');
  t = NOW + 31 * DAY;
  res = playRes({ ack: true, until: NOW + 60 * DAY });
  assert.equal((await billing.refresh('u1')).until, NOW + 60 * DAY);
  res = playRes({ ack: true, state: 'SUBSCRIPTION_STATE_EXPIRED', until: NOW + 60 * DAY });
  const ended = await billing.refresh('u1');
  assert.ok(ended.until <= t, 'süresi dolmamış görünse de durum bitti diyorsa erişim kapanır');
  assert.equal(await billing.refresh('nobody'), null);
});

test('gerçek zamanlı bildirim: gizli anahtar şart; bilinen satın alma yeniden okunur', async () => {
  const store = makeStore();
  let res = playRes({ ack: true });
  const api = fakeApi({ [TOKEN]: () => res });
  const billing = new PlayBilling({ store, packageName: 'com.x', api, rtdnSecret: 's3cret', now: () => NOW });
  await billing.verify({ uid: 'u1', purchaseToken: TOKEN });
  const body = (token) => ({ message: { data: Buffer.from(JSON.stringify({ packageName: 'com.x', subscriptionNotification: { notificationType: 3, purchaseToken: token, subscriptionId: 'vsport_monthly' } })).toString('base64') } });
  assert.equal((await billing.handleRtdn(body(TOKEN), 'yanlis')).status, 403);
  res = playRes({ ack: true, state: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false });
  assert.equal((await billing.handleRtdn(body(TOKEN), 's3cret')).status, 204);
  assert.equal(store.users.u1.subscription.state, 'SUBSCRIPTION_STATE_CANCELED');
  assert.equal(store.users.u1.subscription.autoRenew, false);
  assert.equal((await billing.handleRtdn(body('bilinmeyen'), 's3cret')).status, 204);
  assert.equal((await billing.handleRtdn({ message: { data: 'bozuk' } }, 's3cret')).status, 204);
});

test('servis hesabı oturumu: RS256 imzalı JWT ile belge alınır ve süresi dolana kadar saklanır', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const creds = { client_email: 'play@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(init.body);
    return { ok: true, json: async () => ({ access_token: 'at-1', expires_in: 3600 }) };
  };
  const source = createTokenSource(creds, { fetchImpl, now: () => NOW });
  assert.equal(await source(), 'at-1');
  assert.equal(await source(), 'at-1');
  assert.equal(bodies.length, 1, 'belge önbellekte');
  const assertion = new URLSearchParams(bodies[0]).get('assertion');
  const [h, c, sig] = assertion.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.iss, creds.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/androidpublisher');
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')));
});

test('ortam değişkenleri: servis hesabı yoksa kapalı; paket adı varsayılanı', () => {
  const off = billingFromEnv(makeStore(), {});
  assert.equal(off.enabled, false);
  assert.equal(off.packageName, 'com.macsimulasyon.futbol_app');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const json = JSON.stringify({ client_email: 'a@b', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const on = billingFromEnv(makeStore(), { PLAY_SERVICE_ACCOUNT: Buffer.from(json).toString('base64'), PLAY_PACKAGE_NAME: 'com.vsport' });
  assert.equal(on.enabled, true);
  assert.equal(on.packageName, 'com.vsport');
});

test('API: verifyPlaySubscription ve getEntitlement uçları; /play/rtdn kimlik doğrulaması istemez ama gizli anahtar ister', async () => {
  const store = makeStore();
  const api = fakeApi({ [TOKEN]: playRes() });
  const billing = new PlayBilling({ store, packageName: 'com.x', api, rtdnSecret: 'k', now: () => NOW });
  const handler = createApi({
    verifyToken: async (t) => (t === 'ok' ? 'u1' : null),
    service: {},
    coupons: {},
    billing,
    access: { entitlement: async (uid) => ({ uid, subscribed: true }) },
    log: { error() {} },
  });
  const call = (path, body, auth = 'ok') =>
    new Promise((resolve) => {
      const chunks = [body ? JSON.stringify(body) : ''];
      const req = { method: 'POST', url: path, headers: auth ? { authorization: `Bearer ${auth}` } : {}, on: (ev, fn) => { if (ev === 'data') chunks.forEach((c) => c && fn(Buffer.from(c))); if (ev === 'end') setImmediate(fn); return req; }, destroy() {} };
      const res = { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = b ?? ''; resolve(this); } };
      handler(req, res);
    });
  const v = await call('/api/verifyPlaySubscription', { data: { productId: 'vsport_monthly', purchaseToken: TOKEN } });
  assert.equal(v.status, 200);
  assert.equal(JSON.parse(v.body).result.plan, 'monthly');
  const e = await call('/api/getEntitlement', { data: {} });
  assert.equal(JSON.parse(e.body).result.uid, 'u1');
  const msg = { message: { data: Buffer.from(JSON.stringify({ subscriptionNotification: { purchaseToken: TOKEN } })).toString('base64') } };
  assert.equal((await call('/play/rtdn?secret=k', msg, null)).status, 204);
  assert.equal((await call('/play/rtdn?secret=x', msg, null)).status, 403);
  // Abonelik gerektiren hata 402 ile döner
  const h2 = createApi({ verifyToken: async () => 'u1', service: { unlock: async () => { const { subscriptionRequired } = await import('../subscription.js'); throw subscriptionRequired(); } }, coupons: {}, log: { error() {} } });
  const r402 = await new Promise((resolve) => {
    const req = { method: 'POST', url: '/api/unlockContent', headers: { authorization: 'Bearer ok' }, on: (ev, fn) => { if (ev === 'end') setImmediate(fn); return req; }, destroy() {} };
    const res = { writeHead(s) { this.status = s; }, end(b) { this.body = b; resolve(this); } };
    h2(req, res);
  });
  assert.equal(r402.status, 402);
  assert.equal(JSON.parse(r402.body).error.code, 'subscription-required');
});
