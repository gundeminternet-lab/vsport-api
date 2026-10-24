import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CouponReader, parseVisionJson, visionGenerator } from '../coupon_vision.js';

const good = '{"picks":[{"home":"Galatasaray","away":"Fenerbahçe","market":"MS 1","odd":1.85},{"home":"A","away":"B","market":"KG Var","odd":null}]}';

test('geçerli yanıt okunur; sayılar yuvarlanır', () => {
  const r = parseVisionJson(good);
  assert.equal(r.picks.length, 2);
  assert.equal(r.picks[0].market, 'MS 1');
  assert.equal(r.picks[0].odd, 1.85);
  assert.equal(r.picks[1].odd, null);
  assert.equal(r.dropped, 0);
});

test('metin içinde JSON bloğu bulunur; bozuk yanıt boş döner', () => {
  assert.equal(parseVisionJson('Okuduğum:\n' + good + '\nTeşekkürler').picks.length, 2);
  assert.deepEqual(parseVisionJson('bu bir JSON değil'), { picks: [], dropped: 0 });
  assert.deepEqual(parseVisionJson('{"picks": oops}'), { picks: [], dropped: 0 });
});

test('tanınmayan tahmin, eksik takım, aralık dışı sayı atılır', () => {
  const text = JSON.stringify({ picks: [
    { home: 'A', away: 'B', market: 'korner', odd: 1.5 },
    { home: '', away: 'B', market: 'MS 1', odd: 1.5 },
    { home: 'A', away: 'B', market: 'MS 1', odd: 500 },
    { home: 'A', away: 'B', market: 'MS 2', odd: 2.2 },
  ] });
  const r = parseVisionJson(text);
  assert.equal(r.picks.length, 1);
  assert.equal(r.dropped, 3);
});

test('en fazla 10 seçim kabul edilir', () => {
  const picks = Array.from({ length: 12 }, (_, i) => ({ home: `H${i}`, away: 'X', market: 'MS 1', odd: null }));
  const r = parseVisionJson(JSON.stringify({ picks }));
  assert.equal(r.picks.length, 10);
  assert.equal(r.dropped, 2);
});

test('okuma kapalıysa açık hata verir', async () => {
  await assert.rejects(new CouponReader().read({ imageBase64: 'abc', mimeType: 'image/png' }), { code: 'failed-precondition' });
});

test('mime ve boyut doğrulanır', async () => {
  const r = new CouponReader({ generate: async () => good });
  await assert.rejects(r.read({ imageBase64: 'abc', mimeType: 'image/gif' }), { code: 'invalid-argument' });
  await assert.rejects(r.read({ imageBase64: 'a'.repeat(5 * 1024 * 1024), mimeType: 'image/png' }), { code: 'invalid-argument' });
});

test('günlük sınır aşılınca reddedilir; model hatası kullanıcıya anlaşılır hata verir', async () => {
  let t = Date.parse('2026-10-24T10:00:00Z');
  const r = new CouponReader({ generate: async () => good, dailyMax: 1, now: () => t });
  const ok = await r.read({ imageBase64: 'abc', mimeType: 'image/png' });
  assert.equal(ok.picks.length, 2);
  await assert.rejects(r.read({ imageBase64: 'abc', mimeType: 'image/png' }), { code: 'resource-exhausted' });
  t += 2 * 24 * 3600e3;
  await r.read({ imageBase64: 'abc', mimeType: 'image/png' });

  const failing = new CouponReader({ generate: async () => { throw new Error('ağ'); } });
  await assert.rejects(failing.read({ imageBase64: 'abc', mimeType: 'image/png' }), { code: 'unavailable' });
});

test('visionGenerator görüntü içeren doğru istek biçimini kurar', async () => {
  let body = null;
  const gen = visionGenerator({
    apiKey: 'k',
    fetchImpl: async (u, o) => {
      body = JSON.parse(o.body);
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    },
  });
  const out = await gen({ system: 's', imageBase64: 'QUJD', mimeType: 'image/png', timeoutMs: 1000 });
  assert.equal(out, 'ok');
  assert.equal(body.messages[0].content[0].type, 'image');
  assert.equal(body.messages[0].content[0].source.media_type, 'image/png');
});
