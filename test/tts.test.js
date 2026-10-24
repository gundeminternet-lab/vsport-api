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

import { MOODS, moodOf, prosodyFor } from '../tts.js';
import { edgeProsody } from '../edge_tts.js';

test('hava: warm eski davranışla aynı; diğerleri hız, ton ve nefes payını değiştirir', () => {
  assert.equal(moodOf('bilinmeyen'), 'warm');
  assert.equal(cacheKey('a', 'female'), cacheKey('a', 'female', 'warm'));
  assert.notEqual(cacheKey('a', 'female', 'excited'), cacheKey('a', 'female', 'warm'));
  const warm = buildSsml('Merhaba. Selam.', 'female');
  assert.match(warm, /rate="-4%" pitch="\+0%"/);
  assert.match(warm, /<break time="320ms"\/>/);
  const hot = buildSsml('Gol. Gol.', 'female', 'excited');
  assert.match(hot, /rate="\+3%" pitch="\+4%"/);
  assert.match(hot, /<break time="240ms"\/>/);
  const grave = buildSsml('Kırmızı kart. Eksik.', 'male', 'serious');
  assert.match(grave, /rate="-12%" pitch="-5%"/);
  assert.match(grave, /<break time="440ms"\/>/);
  for (const m of Object.keys(MOODS)) {
    const p = prosodyFor('female', m);
    assert.match(p.rate, /^[+-]\d+%$/);
    assert.match(p.edgePitch, /^[+-]\d+Hz$/);
  }
});

test('edge: hava tek prosody içinde Hz ve yüzde olarak gider', () => {
  assert.deepEqual(edgeProsody('female', 'warm'), { rate: '-4%', pitch: '+0Hz' });
  assert.deepEqual(edgeProsody('female', 'excited'), { rate: '+3%', pitch: '+8Hz' });
  assert.deepEqual(edgeProsody('male', 'serious'), { rate: '-12%', pitch: '-10Hz' });
  assert.deepEqual(edgeProsody('female', 'tanımsız'), edgeProsody('female', 'warm'));
  const msg = ssmlMessage('Gol!', 'female', edgeProsody('female', 'excited'));
  assert.match(msg, /pitch='\+8Hz' rate='\+3%'/);
});

test('speak: hava hem önbellek anahtarını hem Edge çağrısını belirler', async () => {
  const store = new Map();
  const db = {
    doc: (path) => ({
      get: async () => ({ exists: store.has(path), get: (f) => store.get(path)?.[f] }),
      set: async (v) => store.set(path, { ...(store.get(path) ?? {}), ...v }),
    }),
  };
  const seen = [];
  const tts = createTts({
    db,
    FieldValue: { increment: (n) => n, serverTimestamp: () => 0 },
    key: '',
    region: '',
    edgeImpl: async (text, voice, opts) => (seen.push(opts?.mood), Buffer.from('x')),
  });
  await tts.speak({ text: 'Gol!', mood: 'excited' });
  await tts.speak({ text: 'Gol!', mood: 'excited' }); // önbellekten
  await tts.speak({ text: 'Gol!' });
  await tts.speak({ text: 'Gol!', mood: 'saçma' }); // warm'a düşer, önceki warm ile aynı anahtar
  assert.deepEqual(seen, ['excited', 'warm']);
});
