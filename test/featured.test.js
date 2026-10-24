// Günün Maçı: editör yetkisi, gün anahtarı ve doğrulama.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PaidContentService } from '../logic.js';
import { createFeaturedService, featuredDoc } from '../featured.js';
import { createAdminService } from '../admin.js';
import { NOW, FUTURE, makeEspn, makeStore, fixture, finished } from './helpers.js';

function fakeDb(users) {
  const docs = new Map(Object.entries(users).map(([id, d]) => [`users/${id}`, d]));
  const ref = (path) => ({
    path,
    async get() {
      const d = docs.get(path);
      return { exists: d !== undefined, get: (k) => d?.[k], data: () => d };
    },
    async set(v) { docs.set(path, v); },
    async update(v) {
      const cur = { ...(docs.get(path) ?? {}) };
      for (const [k, x] of Object.entries(v)) {
        if (x && x.__delete) delete cur[k];
        else cur[k] = x;
      }
      docs.set(path, cur);
    },
    async delete() { docs.delete(path); },
  });
  return { docs, doc: ref };
}

const FieldValue = { serverTimestamp: () => 'ts', delete: () => ({ __delete: true }) };
const Timestamp = { fromMillis: (ms) => ({ ms }) };

function setup(users, { now = NOW } = {}) {
  const db = fakeDb(users);
  const paid = new PaidContentService({ leagues: ['demo.1'], store: makeStore(), espn: makeEspn(), now: () => now });
  return { db, featured: createFeaturedService({ db, FieldValue, Timestamp, paid, now: () => now }) };
}

test('editör günün maçını belirler; belge maçın Türkiye günüyle kaydedilir', async () => {
  const { db, featured } = setup({ ed: { role: 'editor', username: 'Mehmet' }, u: { role: 'user' } });
  const r = await featured.set({ uid: 'ed', ...fixture, note: '  Derbi   havası  ' });
  assert.equal(r.dayKey, '2026-10-19');
  const doc = db.docs.get('featured/2026-10-19');
  assert.equal(doc.home.name, 'Demo Ev FK');
  assert.equal(doc.note, 'Derbi havası');
  assert.equal(doc.editorName, 'Mehmet');
  assert.deepEqual(doc.kickoffAt, { ms: FUTURE });
  assert.equal(doc.league, 'demo.1');

  // Aynı güne ikinci seçim üzerine yazar
  await featured.set({ uid: 'ed', ...fixture, note: 'Yeni not' });
  assert.equal(db.docs.get('featured/2026-10-19').note, 'Yeni not');

  await featured.clear({ uid: 'ed', dayKey: '2026-10-19' });
  assert.equal(db.docs.has('featured/2026-10-19'), false);
});

test('sıradan kullanıcı, girişsiz kullanıcı, biten maç ve uzak tarih reddedilir', async () => {
  const { featured } = setup({ ed: { role: 'editor' }, u: { role: 'user' } });
  await assert.rejects(featured.set({ uid: 'u', ...fixture }), (e) => e.code === 'permission-denied');
  await assert.rejects(featured.set({ uid: null, ...fixture }), (e) => e.code === 'permission-denied');
  await assert.rejects(featured.clear({ uid: 'u', dayKey: '2026-10-19' }), (e) => e.code === 'permission-denied');
  await assert.rejects(featured.set({ uid: 'ed', ...finished }), (e) => e.code === 'failed-precondition');
  await assert.rejects(featured.clear({ uid: 'ed', dayKey: '../x' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(featured.set({ uid: 'ed', ...fixture, note: 'x'.repeat(141) }), (e) => e.code === 'invalid-argument');
  const far = setup({ ed: { role: 'editor' } }, { now: NOW - 20 * 86400000 });
  await assert.rejects(far.featured.set({ uid: 'ed', ...fixture }), (e) => e.code === 'failed-precondition');
});

test('belge üretici: boş not null olur', () => {
  const d = featuredDoc({ id: '1', league: 'tur.1', timestamp: FUTURE, homeId: 'a', awayId: 'b', homeName: 'A', awayName: 'B' }, { editorUid: 'e', editorName: null, note: '   ', now: NOW });
  assert.equal(d.note, null);
  assert.equal(d.editorName, 'Editör');
  assert.equal(d.home.logo, null);
});

test('yönetici abonelik verir ve kaldırır; yönetici olmayan veremez', async () => {
  const db = fakeDb({ adm: { role: 'admin' }, user_one: { role: 'user', tokens: 0 }, ed: { role: 'editor' } });
  const admin = createAdminService({ db, FieldValue, auth: {} });
  await assert.rejects(admin.setSubscription({ uid: 'ed', targetUid: 'user_one', plan: 'monthly', days: 30 }), (e) => e.code === 'permission-denied');
  const r = await admin.setSubscription({ uid: 'adm', targetUid: 'user_one', plan: 'monthly', days: 30 });
  assert.equal(r.plan, 'monthly');
  assert.ok(r.until > Date.now());
  assert.equal(db.docs.get('users/user_one').subscription.source, 'admin');
  await assert.rejects(admin.setSubscription({ uid: 'adm', targetUid: 'user_one', plan: 'altın', days: 30 }), (e) => e.code === 'invalid-argument');
  await assert.rejects(admin.setSubscription({ uid: 'adm', targetUid: 'yokyokyok', plan: 'monthly', days: 30 }), (e) => e.code === 'not-found');
  const off = await admin.setSubscription({ uid: 'adm', targetUid: 'user_one', plan: 'none' });
  assert.equal(off.plan, 'none');
  assert.equal(db.docs.get('users/user_one').subscription, undefined);
});
