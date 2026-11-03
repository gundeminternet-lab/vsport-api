// Ekran görüntüsü kilidi: yönetici muafiyeti ve kilit kaldırma (capture.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CaptureLocks } from '../capture.js';

function memStore() {
  const docs = new Map();
  return {
    docs,
    async get(uid) {
      return docs.get(uid) ?? null;
    },
    async add(uid, keys, area, now) {
      const d = docs.get(uid) ?? { keys: {} };
      for (const k of keys) d.keys[k] = { at: now, area };
      docs.set(uid, d);
    },
    async clear(uid) {
      docs.delete(uid);
    },
  };
}

test('yönetici kilitlenmez; yönetici başkasının kilidini kaldırır', async () => {
  const store = memStore();
  const cap = new CaptureLocks({ store, log: {}, isExempt: async (uid) => uid === 'adm' });
  const a = await cap.report({ uid: 'adm', keys: ['tur_1_1'], area: 'ask' });
  assert.deepEqual(a.locked, []);
  assert.equal(a.exempt, true);
  assert.equal(await cap.isLocked('adm', 'tur_1_1'), false);

  await cap.report({ uid: 'u1abcd', keys: ['tur_1_1', 'tur_1_2'], area: 'ask' });
  assert.equal(await cap.isLocked('u1abcd', 'tur_1_1'), true);
  await assert.rejects(cap.clear({ uid: 'u1abcd', target: 'u1abcd' }), (e) => e.code === 'permission-denied');
  await cap.clear({ uid: 'adm', target: 'u1abcd' });
  assert.equal(await cap.isLocked('u1abcd', 'tur_1_1'), false);
});
