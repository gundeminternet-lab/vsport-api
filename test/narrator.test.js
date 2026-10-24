import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Narrator, acceptable, numbersIn, anthropicGenerator } from '../narrator.js';
import { narrationFacts } from '../assistant.js';

const draft = 'Ev %52, beraberlik %25, Dep %23. Model Ev kazanır diyor.';
const facts = 'home: Ev\nprobabilities: 52 / 25 / 23';

test('rakamları virgüllü kümeye çevirir', () => {
  assert.deepEqual([...numbersIn('%52 ve 1.6')].sort(), ['1,6', '52']);
});

test('yeni rakam, yasaklı sözcük ya da aşırı uzunluk reddedilir', () => {
  assert.equal(acceptable('Ev %52 ihtimalle kazanır.', { draft, facts }), true);
  assert.equal(acceptable('Ev %61 ihtimalle kazanır.', { draft, facts }), false);
  assert.equal(acceptable('Bu maçta oran yüksek.', { draft, facts }), false);
  assert.equal(acceptable('', { draft, facts }), false);
  assert.equal(acceptable('x'.repeat(900), { draft, facts }), false);
});

test('model kapalıysa taslak aynen döner', async () => {
  const n = new Narrator();
  assert.equal(n.enabled, false);
  const r = await n.rewrite({ draft, facts: { home: 'Ev' } });
  assert.deepEqual(r, { text: draft, source: 'template' });
});

test('kabul edilen yeniden yazım kullanılır; önbellek ikinci çağrıyı önler', async () => {
  let calls = 0;
  const n = new Narrator({
    generate: async () => {
      calls += 1;
      return 'Ev sahibi %52 ile önde.';
    },
  });
  const a = await n.rewrite({ draft, facts: { home: 'Ev', probabilities: '52 / 25 / 23' } });
  const b = await n.rewrite({ draft, facts: { home: 'Ev', probabilities: '52 / 25 / 23' } });
  assert.equal(a.source, 'model');
  assert.equal(b.text, 'Ev sahibi %52 ile önde.');
  assert.equal(calls, 1);
});

test('uydurma rakam içeren yanıt taslağa düşer', async () => {
  const n = new Narrator({ generate: async () => 'Ev %99 ihtimalle kazanır.' });
  const r = await n.rewrite({ draft, facts: { home: 'Ev' } });
  assert.deepEqual(r, { text: draft, source: 'template' });
});

test('hata ya da zaman aşımı taslağa düşer ve asla fırlatmaz', async () => {
  const n = new Narrator({ generate: async () => { throw new Error('ağ'); } });
  const r = await n.rewrite({ draft, facts: {} });
  assert.equal(r.source, 'template');
  assert.equal(r.text, draft);
});

test('günlük sınır aşılınca model çağrılmaz', async () => {
  let calls = 0;
  let t = Date.parse('2026-10-24T10:00:00Z');
  const n = new Narrator({
    dailyMax: 2,
    now: () => t,
    generate: async () => { calls += 1; return "Ev %52 ihtimalle önde."; },
  });
  await n.rewrite({ draft, facts: { k: 1 } });
  await n.rewrite({ draft, facts: { k: 2 } });
  const third = await n.rewrite({ draft, facts: { k: 3 } });
  assert.equal(third.source, 'template');
  assert.equal(calls, 2);
  t += 2 * 24 * 3600e3;
  const next = await n.rewrite({ draft, facts: { k: 4 } });
  assert.equal(next.source, 'model');
});

test('anthropicGenerator doğru istek biçimini kurar ve metni çıkarır', async () => {
  let seen = null;
  const gen = anthropicGenerator({
    apiKey: 'test-key',
    model: 'claude-haiku-5-5',
    fetchImpl: async (url, opts) => {
      seen = { url, opts, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Merhaba' }] }) };
    },
  });
  const out = await gen({ system: 'sys', user: 'u', timeoutMs: 1000 });
  assert.equal(out, 'Merhaba');
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.opts.headers['x-api-key'], 'test-key');
  assert.equal(seen.body.model, 'claude-haiku-5-5');
  assert.equal(seen.body.messages[0].content, 'u');
});

test('anlatıcı verisi motordan gelir; canlı maçta skor ve dakika eklenir', () => {
  const f = narrationFacts({
    match: { homeName: 'Ev', awayName: 'Dep' },
    state: 'live',
    live: { home: 1, away: 0, minute: 34 },
    content: { ai: { probabilities: { home: 52, draw: 25, away: 23 }, topScore: '2-1' } },
    model: { lambdaHome: 1.64, lambdaAway: 1.12 },
    importance: { label: 'Yüksek', score: 72 },
  });
  assert.equal(f.beklenenGol, '1,6 / 1,1');
  assert.equal(f.canlı, '1-0, 34. dakika');
  assert.equal(f.tahminiSkor, '2-1');
  const pre = narrationFacts({
    match: { homeName: 'Ev', awayName: 'Dep' }, state: 'pre', live: null,
    content: { ai: { probabilities: { home: 1, draw: 2, away: 3 }, topScore: '1-0' } },
    model: { lambdaHome: 1, lambdaAway: 1 }, importance: { label: 'Orta', score: 40 },
  });
  assert.equal(pre.canlı, undefined);
});
