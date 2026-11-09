import test from 'node:test';
import assert from 'node:assert/strict';
import { speechText } from '../speech_text.js';
import { createTts } from '../tts.js';

test('sesli okuma: maç kısaltmaları Türkçe söylenir (milattan sonra, kilogram, Roma rakamı yok)', () => {
  const cases = [
    ['AI seninle aynı yönde: MS 1 ihtimali yüzde 52.', 'AI seninle aynı yönde: maç sonu bir ihtimali yüzde 52.'],
    ['Seçimin MS X, AI tercihi MS 2.', 'Seçimin maç sonu beraberlik, AI tercihi maç sonu iki.'],
    ['AI bu türde İY/MS 2/1 tarafında (%7).', 'AI bu türde ilk yarı iki, maç sonu bir tarafında (yüzde 7).'],
    ['İY X ve İY 1', 'ilk yarı beraberlik ve ilk yarı bir'],
    ['Çifte şans 1-X · Çifte şans X-2 · Çifte şans 1-2', 'Çifte şans bir ya da beraberlik · Çifte şans beraberlik ya da iki · Çifte şans bir ya da iki'],
    ['KG Var ihtimali %61; KG Yok', 'karşılıklı gol var ihtimali yüzde 61; karşılıklı gol yok'],
    ['İY 0,5 Üst, 2.5 Üst ve 1.5 Alt', 'ilk yarı 0 buçuk Üst, 2 buçuk Üst ve 1 buçuk Alt'],
    ['ortalama 1.85 gol attı, 0.9 yedi', 'ortalama 1,85 gol attı, 0,9 yedi'],
    ['Skor 2-1 ihtimali; 1-0 önde', 'Skor 2 1 ihtimali; 1 0 önde'],
    ["Hücuma oyuncu girdi: Kaan (63'), 90+3' gol, 63'te", 'Hücuma oyuncu girdi: Kaan (63. dakika), 90 artı 3. dakika gol, 63\'te'],
    ["Maç 20.45'te başlıyor; son 10 dk", "Maç 20:45'te başlıyor; son 10 dakika"],
    ['xG 1.4', 'gol beklentisi 1,4'],
  ];
  for (const [input, want] of cases) assert.equal(speechText(input), want, input);
});

test('sesli okuma: kelime içindeki harflere ve takım adlarına dokunulmaz; iki kez uygulanabilir', () => {
  for (const t of ['MSX FK ile Roma', 'Kasımpaşa', 'Atletico Madrid', '2023-26 sezonları', 'Bu maçta İYİ bir oyun']) assert.equal(speechText(t), t);
  const once = speechText('İY/MS 2/1 %52 2.5 Üst KG Var MS X');
  assert.equal(speechText(once), once);
  assert.equal(speechText(''), '');
  assert.equal(speechText(null), null);
});

test('insansı ses: sağlayıcıya düzeltilmiş metin gider, önbellek de onunla tutulur', async () => {
  const store = new Map();
  const db = {
    doc: (path) => ({
      get: async () => ({ exists: store.has(path), get: (f) => store.get(path)?.[f] }),
      set: async (v) => store.set(path, { ...(store.get(path) ?? {}), ...v }),
    }),
  };
  const sent = [];
  const tts = createTts({
    db,
    FieldValue: { increment: (n) => n, serverTimestamp: () => 0 },
    key: '',
    region: '',
    elevenKey: '',
    elevenVoice: '',
    edgeImpl: async (text) => {
      sent.push(text);
      return Buffer.from('mp3');
    },
  });
  await tts.speak({ text: 'MS 1 ihtimali %52, KG Var.', voice: 'female' });
  assert.deepEqual(sent, ['maç sonu bir ihtimali yüzde 52, karşılıklı gol var.']);
  // Aynı söyleniş: önbellekten (ikinci üretim yok)
  const again = await tts.speak({ text: 'MS 1 ihtimali %52, KG Var.', voice: 'female' });
  assert.equal(again.cached, true);
  assert.equal(sent.length, 1);
});
