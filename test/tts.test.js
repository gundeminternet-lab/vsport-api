import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSsml, cacheKey, createTts } from '../tts.js';

test('SSML: kaçış ve cümle araları', () => {
  const s = buildSsml('Merhaba! A & B <test>. Tahmin: 2-1.', 'male');
  assert.match(s, /tr-TR-AhmetNeural/);
  assert.match(s, /A &amp; B &lt;test&gt;\.<break time="320ms"\/>/);
  assert.match(s, /Tahmin:<break time="180ms"\/>/);
});

test('önbellek anahtarı ses ve metne bağlı', () => {
  assert.notEqual(cacheKey('a', 'female'), cacheKey('a', 'male'));
  assert.equal(cacheKey(' a ', 'female'), cacheKey('a', 'female'));
});

test('anahtar yoksa kapalı; varsa bir kez üretir, sonra önbellekten', async () => {
  assert.equal(createTts({ db: {}, FieldValue: {}, key: '', region: '', edge: false }).enabled, false);
  const store = new Map();
  const db = {
    doc: (path) => ({
      get: async () => ({ exists: store.has(path), get: (f) => store.get(path)?.[f] }),
      set: async (v) => store.set(path, { ...(store.get(path) ?? {}), ...v }),
    }),
  };
  let calls = 0;
  const tts = createTts({
    db,
    FieldValue: { increment: (n) => n, serverTimestamp: () => 0 },
    key: 'k',
    region: 'westeurope',
    fetchImpl: async (url, opts) => {
      calls++;
      assert.match(url, /westeurope\.tts\.speech\.microsoft\.com/);
      assert.match(opts.body, /EmelNeural/);
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('mp3').buffer };
    },
  });
  const a = await tts.speak({ text: 'Merhaba.' });
  const b = await tts.speak({ text: 'Merhaba.' });
  assert.equal(calls, 1);
  assert.equal(a.audio, b.audio);
  assert.equal(b.cached, true);
});

import { secMsGec, audioFromBinary, ssmlMessage } from '../edge_tts.js';

test('edge: jeton, ses ayrıştırma ve SSML', () => {
  const t = secMsGec(Date.UTC(2026, 9, 22, 12, 0, 0));
  assert.match(t, /^[0-9A-F]{64}$/);
  assert.equal(secMsGec(Date.UTC(2026, 9, 22, 12, 2, 0)), t); // 5 dakikalık pencere
  const header = Buffer.from('X-RequestId:1\r\nPath:audio\r\n');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(header.length);
  assert.equal(audioFromBinary(Buffer.concat([len, header, Buffer.from('mp3')])).toString(), 'mp3');
  assert.match(ssmlMessage('A & B', 'male'), /AhmetNeural.*A &amp; B/s);
});

test('anahtar yoksa Edge sesi kullanılır ve önbelleğe alınır', async () => {
  const store = new Map();
  const db = {
    doc: (path) => ({
      get: async () => ({ exists: store.has(path), get: (f) => store.get(path)?.[f] }),
      set: async (v) => store.set(path, { ...(store.get(path) ?? {}), ...v }),
    }),
  };
  let calls = 0;
  const tts = createTts({
    db,
    FieldValue: { increment: (n) => n, serverTimestamp: () => 0 },
    key: '',
    region: '',
    edgeImpl: async (text, voice) => (calls++, Buffer.from(`ses:${voice}`)),
  });
  assert.equal(tts.enabled, true);
  const a = await tts.speak({ text: 'Merhaba.', voice: 'male' });
  await tts.speak({ text: 'Merhaba.', voice: 'male' });
  assert.equal(calls, 1);
  assert.equal(Buffer.from(a.audio, 'base64').toString(), 'ses:male');
});
