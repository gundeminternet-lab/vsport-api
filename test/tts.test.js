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

import { elevenBody, elevenCacheKey, ELEVEN_MOODS } from '../tts.js';

function memDb() {
  const store = new Map();
  return {
    store,
    doc: (path) => ({
      get: async () => ({ exists: store.has(path), get: (f) => store.get(path)?.[f] }),
      set: async (v) => store.set(path, { ...(store.get(path) ?? {}), ...v }),
    }),
  };
}
const FV = { increment: (n) => n, serverTimestamp: () => 0 };

test('spiker: ElevenLabs gövdesi havaya göre; dil zorlaması yalnızca v2.5/v3 modellerinde', () => {
  const b = elevenBody(' Gol! ', 'eleven_multilingual_v2', 'excited');
  assert.equal(b.text, 'Gol!');
  assert.equal(b.model_id, 'eleven_multilingual_v2');
  assert.equal(b.voice_settings.stability, ELEVEN_MOODS.excited.stability);
  assert.equal(b.voice_settings.use_speaker_boost, true);
  assert.equal('language_code' in b, false);
  assert.equal(elevenBody('a', 'eleven_flash_v2_5').language_code, 'tr');
  assert.deepEqual(elevenBody('a', 'eleven_multilingual_v2', 'tanımsız').voice_settings, { ...ELEVEN_MOODS.warm, use_speaker_boost: true });
  assert.notEqual(elevenCacheKey('a', 'v1'), elevenCacheKey('a', 'v2'));
  assert.notEqual(elevenCacheKey('a', 'v1'), cacheKey('a', 'spiker'));
});

test('spiker: ElevenLabs ile bir kez üretir, eşzamanlı istekler tek çağrıyı bekler, sonra önbellekten', async () => {
  const db = memDb();
  const urls = [];
  const tts = createTts({
    db,
    FieldValue: FV,
    key: '',
    region: '',
    edge: false,
    elevenKey: 'xi',
    elevenVoice: 'VOICE123',
    fetchImpl: async (url, opts) => {
      urls.push(url);
      assert.equal(opts.headers['xi-api-key'], 'xi');
      assert.equal(JSON.parse(opts.body).model_id, 'eleven_multilingual_v2');
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('spiker-mp3').buffer };
    },
  });
  assert.equal(tts.enabled, true);
  assert.equal(tts.spiker, true);
  const [a, b] = await Promise.all([tts.speak({ text: 'Merhaba.', voice: 'spiker' }), tts.speak({ text: 'Merhaba.', voice: 'spiker' })]);
  const c = await tts.speak({ text: 'Merhaba.', voice: 'spiker' });
  assert.equal(urls.length, 1);
  assert.match(urls[0], /api\.elevenlabs\.io\/v1\/text-to-speech\/VOICE123\?output_format=mp3_44100_64/);
  assert.equal(Buffer.from(a.audio, 'base64').toString(), 'spiker-mp3');
  assert.equal(b.audio, a.audio);
  assert.equal(c.cached, true);
  assert.equal(db.store.get(`tts_usage/eleven_${new Date().toISOString().slice(0, 7)}`).chars, 'Merhaba.'.length);
});

test('spiker: ElevenLabs hata verirse ya da aylık sınır dolarsa Ahmet spiker ayarıyla Edge yedeği', async () => {
  const db = memDb();
  const seen = [];
  const tts = createTts({
    db,
    FieldValue: FV,
    key: '',
    region: '',
    elevenKey: 'xi',
    elevenVoice: 'V',
    elevenLimit: 5,
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'hata' }),
    edgeImpl: async (text, voice) => (seen.push(voice), Buffer.from('edge')),
  });
  const r1 = await tts.speak({ text: 'Kısa', voice: 'spiker' }); // ElevenLabs 500 → Edge
  const r2 = await tts.speak({ text: 'Uzun bir metin.', voice: 'spiker' }); // sınır aşılıyor → Edge
  assert.equal(Buffer.from(r1.audio, 'base64').toString(), 'edge');
  assert.equal(Buffer.from(r2.audio, 'base64').toString(), 'edge');
  assert.deepEqual(seen, ['spiker', 'spiker']);
  assert.match(buildSsml('Gol.', 'spiker'), /AhmetNeural.*rate="\+2%" pitch="-4%"/s);
  assert.deepEqual(edgeProsody('spiker', 'warm'), { rate: '+2%', pitch: '-8Hz' });
});

test('spiker: ElevenLabs anahtarı yoksa doğrudan Microsoft yedeği (eski sunucu davranışı)', async () => {
  const tts = createTts({ db: memDb(), FieldValue: FV, key: '', region: '', elevenKey: '', elevenVoice: '', edgeImpl: async (t, v) => Buffer.from(v) });
  assert.equal(tts.spiker, false);
  const r = await tts.speak({ text: 'Merhaba.', voice: 'spiker' });
  assert.equal(Buffer.from(r.audio, 'base64').toString(), 'spiker');
});

import { googleBody, googleCacheKey, billingMonth, GOOGLE_RATES } from '../tts.js';

test('spiker: Google Chirp gövdesi havaya göre hız alır; ay Pasifik saatine göre', () => {
  const b = googleBody(' Gol! ', 'tr-TR-Chirp3-HD-Fenrir', 'excited');
  assert.deepEqual(b, {
    input: { text: 'Gol!' },
    voice: { languageCode: 'tr-TR', name: 'tr-TR-Chirp3-HD-Fenrir' },
    audioConfig: { audioEncoding: 'MP3', speakingRate: GOOGLE_RATES.excited },
  });
  assert.equal(googleBody('a', 'tr-TR-Chirp3-HD-Orus', 'tanımsız').audioConfig.speakingRate, 1);
  assert.notEqual(googleCacheKey('a', 'tr-TR-Chirp3-HD-Fenrir'), googleCacheKey('a', 'tr-TR-Chirp3-HD-Orus'));
  assert.notEqual(googleCacheKey('a'), elevenCacheKey('a', 'v1'));
  assert.equal(billingMonth(Date.parse('2026-12-01T05:00:00Z')), '2026-11'); // Pasifik'te hâlâ kasım
  assert.equal(billingMonth(Date.parse('2026-12-01T09:00:00Z')), '2026-12');
});

test('spiker: ElevenLabs yoksa Google ile bir kez üretir, sayar ve önbelleğe alır', async () => {
  const db = memDb();
  const calls = [];
  const tts = createTts({
    db,
    FieldValue: FV,
    key: '',
    region: '',
    edge: false,
    elevenKey: '',
    elevenVoice: '',
    googleKey: 'gk',
    now: () => Date.parse('2026-11-04T12:00:00Z'),
    fetchImpl: async (url, opts) => {
      calls.push(url);
      assert.equal(opts.headers['X-Goog-Api-Key'], 'gk');
      assert.equal(JSON.parse(opts.body).voice.name, 'tr-TR-Chirp3-HD-Fenrir');
      return { ok: true, json: async () => ({ audioContent: Buffer.from('chirp').toString('base64') }) };
    },
  });
  assert.equal(tts.spiker, true);
  const [a, b] = await Promise.all([tts.speak({ text: 'Gol geldi.', voice: 'spiker' }), tts.speak({ text: 'Gol geldi.', voice: 'spiker' })]);
  const c = await tts.speak({ text: 'Gol geldi.', voice: 'spiker' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 'https://texttospeech.googleapis.com/v1/text:synthesize');
  assert.equal(Buffer.from(a.audio, 'base64').toString(), 'chirp');
  assert.equal(b.audio, a.audio);
  assert.equal(c.cached, true);
  assert.equal(db.store.get('tts_usage/google_2026-11').chars, 'Gol geldi.'.length);
  assert.equal([...db.store.values()].find((v) => v.audio)?.provider, 'google');
});

test('spiker: sıra ElevenLabs → Google → Edge; sınır dolunca ücretsiz kotada durur', async () => {
  const db = memDb();
  const seen = [];
  const edgeSeen = [];
  const tts = createTts({
    db,
    FieldValue: FV,
    key: '',
    region: '',
    elevenKey: 'xi',
    elevenVoice: 'V',
    googleKey: 'gk',
    googleLimit: 12,
    fetchImpl: async (url) => {
      seen.push(url.includes('elevenlabs') ? 'eleven' : 'google');
      if (url.includes('elevenlabs')) return { ok: false, status: 401, text: async () => 'kota' };
      return { ok: true, json: async () => ({ audioContent: Buffer.from('chirp').toString('base64') }) };
    },
    edgeImpl: async (text, voice) => (edgeSeen.push(voice), Buffer.from('edge')),
  });
  const r1 = await tts.speak({ text: 'Kısa metin.', voice: 'spiker' }); // 11 karakter: Eleven 401 → Google
  const r2 = await tts.speak({ text: 'İkinci metin.', voice: 'spiker' }); // Google sınırı aşılıyor → Edge
  assert.equal(Buffer.from(r1.audio, 'base64').toString(), 'chirp');
  assert.equal(Buffer.from(r2.audio, 'base64').toString(), 'edge');
  assert.deepEqual(seen, ['eleven', 'google', 'eleven']);
  assert.deepEqual(edgeSeen, ['spiker']);
});

test('spiker: Google hata ya da boş ses dönerse sayaç artmaz, yedeğe düşülür', async () => {
  const db = memDb();
  let n = 0;
  const tts = createTts({
    db,
    FieldValue: FV,
    key: '',
    region: '',
    elevenKey: '',
    elevenVoice: '',
    googleKey: 'gk',
    fetchImpl: async () => (++n === 1 ? { ok: false, status: 403, text: async () => 'billing' } : { ok: true, json: async () => ({}) }),
    edgeImpl: async () => Buffer.from('edge'),
  });
  assert.equal(Buffer.from((await tts.speak({ text: 'Bir.', voice: 'spiker' })).audio, 'base64').toString(), 'edge');
  assert.equal(Buffer.from((await tts.speak({ text: 'İki.', voice: 'spiker' })).audio, 'base64').toString(), 'edge');
  assert.equal([...db.store.keys()].some((k) => k.startsWith('tts_usage/google_')), false);
  // Spiker dışındaki sesler Google'a hiç gitmez
  await tts.speak({ text: 'Üç.', voice: 'female' });
  assert.equal(n, 2);
});
