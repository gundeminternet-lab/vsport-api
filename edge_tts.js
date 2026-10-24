// Ücretsiz nöral Türkçe ses: Microsoft Edge tarayıcısının "Sesli oku" hizmeti (hesap/anahtar gerekmez).
// Emel ve Ahmet nöral sesleri. Resmi bir API değildir: Microsoft değiştirirse çalışmayabilir; o durumda
// uygulama kendiliğinden telefonun sesine döner. Protokol açık kaynak edge-tts projesindekiyle aynıdır.

import crypto from 'node:crypto';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = process.env.EDGE_TTS_VERSION || '130.0.2849.68';
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0];
const WSS = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

export const EDGE_VOICES = {
  female: 'Microsoft Server Speech Text to Speech Voice (tr-TR, EmelNeural)',
  male: 'Microsoft Server Speech Text to Speech Voice (tr-TR, AhmetNeural)',
};

/** Sec-MS-GEC: Windows dosya zamanı (5 dakikaya yuvarlanmış) + istemci jetonu → SHA-256 (büyük harf). */
export function secMsGec(nowMs = Date.now()) {
  let ticks = Math.floor(nowMs / 1000) + 11644473600;
  ticks -= ticks % 300;
  const value = `${BigInt(ticks) * 10000000n}${TRUSTED_CLIENT_TOKEN}`;
  return crypto.createHash('sha256').update(value, 'ascii').digest('hex').toUpperCase();
}

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const stamp = () => new Date().toString().replace(/\(.*\)$/, '').trim();

export function speechConfigMessage() {
  return (
    `X-Timestamp:${stamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},' +
    '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
  );
}

export function ssmlMessage(text, voiceKey = 'female', { rate = '-6%', pitch = '+0Hz' } = {}) {
  const voice = EDGE_VOICES[voiceKey] ?? EDGE_VOICES.female;
  const id = crypto.randomUUID().replace(/-/g, '');
  const ssml =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='tr-TR'>` +
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${xml(text.trim())}</prosody></voice></speak>`;
  return `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
}

/** Edge için hız/ton: tts.js'teki hava tablosundan (döngüsel içe aktarmayı önlemek için burada yerel kopya). */
const EDGE_BASE = { female: { rate: -4, pitch: 0 }, male: { rate: -6, pitch: -2 } };
const EDGE_MOOD = { warm: [0, 0], calm: [-3, -1], excited: [7, 4], serious: [-6, -3] };
export function edgeProsody(voiceKey = 'female', mood = 'warm') {
  const b = EDGE_BASE[voiceKey] ?? EDGE_BASE.female;
  const [r, p] = EDGE_MOOD[mood] ?? EDGE_MOOD.warm;
  const rate = b.rate + r;
  const pitch = Math.round((b.pitch + p) * 2);
  return { rate: `${rate >= 0 ? '+' : ''}${rate}%`, pitch: `${pitch >= 0 ? '+' : ''}${pitch}Hz` };
}

/** İkili mesaj: ilk 2 bayt başlık uzunluğu (big-endian), sonra başlık, sonra ses. Ses değilse null. */
export function audioFromBinary(buf) {
  if (buf.length < 2) return null;
  const headerLen = buf.readUInt16BE(0);
  const header = buf.subarray(2, 2 + headerLen).toString('utf8');
  if (!/Path:\s*audio/i.test(header)) return null;
  return buf.subarray(2 + headerLen);
}

/** Metni MP3'e çevirir (Buffer). ws paketi gerekir (package.json). */
export async function edgeSynthesize(text, voiceKey = 'female', { timeoutMs = 20000, WebSocketImpl, mood = 'warm' } = {}) {
  const WS = WebSocketImpl ?? (await import('ws')).default;
  const url =
    `${WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=1-${CHROMIUM_FULL_VERSION}&ConnectionId=${crypto.randomUUID().replace(/-/g, '')}`;
  const ws = new WS(url, {
    headers: {
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`,
    },
  });
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => {
      ws.terminate?.();
      reject(new Error('edge-tts zaman aşımı'));
    }, timeoutMs);
    const done = (err, value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(value);
    };
    ws.on('open', () => {
      ws.send(speechConfigMessage());
      ws.send(ssmlMessage(text, voiceKey, edgeProsody(voiceKey, mood)));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const audio = audioFromBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
        if (audio?.length) chunks.push(audio);
        return;
      }
      if (/Path:\s*turn\.end/i.test(data.toString())) {
        const all = Buffer.concat(chunks);
        all.length ? done(null, all) : done(new Error('edge-tts ses döndürmedi'));
      }
    });
    ws.on('error', (e) => done(e));
    ws.on('unexpected-response', (_req, res) => done(new Error(`edge-tts HTTP ${res.statusCode}`)));
    ws.on('close', () => {
      if (chunks.length) done(null, Buffer.concat(chunks));
    });
  });
}
