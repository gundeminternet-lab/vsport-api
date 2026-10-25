import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountService, DELETE_CONFIRM } from '../account.js';

/** Yol tabanlı küçük Firestore taklidi: belgeler "a/b/c/d" yollarıyla tutulur. */
function fakeDb(initial) {
  const docs = new Map(Object.entries(initial));
  const deleted = [];
  const ref = (path) => ({
    path,
    get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
    delete: async () => {
      docs.delete(path);
      deleted.push(path);
    },
    collection: (name) => col(`${path}/${name}`),
  });
  const col = (path) => ({ doc: (id) => ref(`${path}/${id}`) });
  return {
    docs,
    deleted,
    collection: (name) => ({
      ...col(name),
      listDocuments: async () => [...new Set([...docs.keys()].filter((k) => k.startsWith(`${name}/`)).map((k) => k.split('/').slice(0, 2).join('/')))].map(ref),
    }),
    doc: (path) => ref(path),
    recursiveDelete: async (r) => {
      for (const k of [...docs.keys()]) if (k === r.path || k.startsWith(`${r.path}/`)) docs.delete(k);
      deleted.push(`${r.path}/**`);
    },
    collectionGroup: (group) => ({
      where: (field, _op, value) => ({
        limit: () => ({
          get: async () => {
            const hits = [...docs.entries()].filter(([k, v]) => k.split('/').at(-2) === group && v?.[field] === value);
            return { empty: hits.length === 0, size: hits.length, docs: hits.map(([k]) => ({ ref: ref(k) })) };
          },
        }),
      }),
    }),
    batch: () => {
      const ops = [];
      return { delete: (r) => ops.push(r), commit: async () => { for (const r of ops) await r.delete(); } };
    },
  };
}

const seed = () => ({
  'users/u1': { username: 'Ali' },
  'users/u1/favorites/m1': { a: 1 },
  'users/u1/unlocks/x': { a: 1 },
  'users/u2': { username: 'veli' },
  'usernames/ali': { uid: 'u1' },
  'usernames/veli': { uid: 'u2' },
  'support/u1/messages/s1': { from: 'user', text: 'merhaba' },
  'support_threads/u1': { name: 'Ali' },
  'user_stats/u1': { xp: 10 },
  'leaderboards/2026-W43': { period: 'w' },
  'leaderboards/2026-W43/entries/u1': { points: 5 },
  'leaderboards/2026-W43/entries/u2': { points: 3 },
  'matches/k1/comments/c1': { uid: 'u1', text: 'gol' },
  'matches/k1/comments/c2': { uid: 'u2', text: 'yok' },
  'chats/global/messages/g1': { uid: 'u1', text: 'selam' },
});

test('onay metni olmadan ya da girişsiz silinmez', async () => {
  const db = fakeDb(seed());
  const svc = new AccountService({ db, auth: { deleteUser: async () => {} }, log: {} });
  await assert.rejects(svc.deleteAccount({ uid: 'u1', confirm: 'sil' }), { code: 'invalid-argument' });
  await assert.rejects(svc.deleteAccount({ uid: null, confirm: DELETE_CONFIRM }), { code: 'permission-denied' });
  assert.ok(db.docs.has('users/u1'));
});

test('kullanıcının bütün verisi ve giriş hesabı silinir; başka kullanıcıya dokunulmaz', async () => {
  const db = fakeDb(seed());
  const authDeleted = [];
  const svc = new AccountService({ db, auth: { deleteUser: async (uid) => authDeleted.push(uid) }, log: {} });
  const r = await svc.deleteAccount({ uid: 'u1', confirm: DELETE_CONFIRM });
  assert.deepEqual(r, { deleted: true, skipped: [] });
  for (const k of ['users/u1', 'users/u1/favorites/m1', 'users/u1/unlocks/x', 'usernames/ali', 'support/u1/messages/s1', 'support_threads/u1', 'user_stats/u1', 'leaderboards/2026-W43/entries/u1', 'matches/k1/comments/c1', 'chats/global/messages/g1']) {
    assert.ok(!db.docs.has(k), `${k} silinmeliydi`);
  }
  for (const k of ['users/u2', 'usernames/veli', 'leaderboards/2026-W43/entries/u2', 'matches/k1/comments/c2']) assert.ok(db.docs.has(k), `${k} kalmalıydı`);
  assert.deepEqual(authDeleted, ['u1']);
});

test('yardımcı adım hata verirse atlanır, asıl kayıt yine silinir', async () => {
  const db = fakeDb(seed());
  db.collectionGroup = () => { throw new Error('dizin yok'); };
  const svc = new AccountService({ db, auth: { deleteUser: async () => {} }, log: {} });
  const r = await svc.deleteAccount({ uid: 'u1', confirm: DELETE_CONFIRM });
  assert.deepEqual(r.skipped, ['comments', 'chat']);
  assert.ok(!db.docs.has('users/u1'));
});

test('giriş hesabı zaten yoksa hata sayılmaz', async () => {
  const db = fakeDb(seed());
  const svc = new AccountService({ db, auth: { deleteUser: async () => { throw Object.assign(new Error('yok'), { code: 'auth/user-not-found' }); } }, log: {} });
  const r = await svc.deleteAccount({ uid: 'u1', confirm: DELETE_CONFIRM });
  assert.equal(r.deleted, true);
});
