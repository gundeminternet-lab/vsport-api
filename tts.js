// İnsansı (nöral) AI sesi: Türkçe metni MP3'e çevirir.
//   Sağlayıcı sırası:
//     1) Azure Konuşma hizmeti — AZURE_SPEECH_KEY ve AZURE_SPEECH_REGION tanımlıysa (resmi, aylık 0,5M karakter ücretsiz)
//     2) Edge "Sesli oku" (edge_tts.js) — anahtar gerekmez; TTS_PROVIDER=off ile kapatılabilir
//   İkisi de olmazsa uygulama telefonun kendi sesine döner.
//   Aynı metin ve ses için üretilen ses Firestore'da saklanır (tts_cache): herkes aynı analizi dinlediği için
//   aylık ücretsiz kota (0,5 milyon karakter) çok daha geç dolar. Aylık kullanım tts_usage/{YYYY-MM}.

import crypto from 'node:crypto';
import { AppError } from './logic.js';
import { edgeSynthesize } from './edge_tts.js';

export const VOICES = {
  female: { name: 'tr-TR-EmelNeural', rate: '-4%', pitch: '+0%' },
  male: { name: 'tr-TR-AhmetNeural', rate: '-6%', pitch: '-2%' },
};
export const MAX_CHARS = 1500;
export const MONTHLY_LIMIT = 480000; // ücretsiz kotanın (500.000) biraz altı

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Metni sıcak ve doğal bir anlatıma uygun SSML'e çevirir: cümle aralarında kısa nefes payları. */
export function buildSsml(text, voiceKey = 'female') {
  const v = VOICES[voiceKey] ?? VOICES.female;
  const body = xml(text.trim())
    // Cümle sonlarında kısa duraklama (doğal nefes)
    .replace(/([.!?])\s+/g, '$1<break time="320ms"/> ')
    .replace(/:\s+/g, ':<break time="180ms"/> ');
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="tr-TR">` +
    `<voice name="${v.name}"><prosody rate="${v.rate}" pitch="${v.pitch}">${body}</prosody></voice></speak>`
  );
}

export function cacheKey(text, voiceKey) {
  return crypto.createHash('sha1').update(`${voiceKey}|${VOICES[voiceKey]?.name}|${text.trim()}`).digest('hex');
}

export const EDGE_DAILY_LIMIT = 300000; // günlük karakter: hizmeti yormamak için

export function createTts({
  db,
  FieldValue,
  key = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  edge = process.env.TTS_PROVIDER !== 'off',
  edgeImpl = edgeSynthesize,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  const azure = Boolean(key && region);
  const memory = new Map(); // son kullanılanlar bellekte
  const remember = (k, v) => {
    memory.delete(k);
    memory.set(k, v);
    while (memory.size > 60) memory.delete(memory.keys().next().value);
  };

  return {
    enabled: azure || edge,

    async speak({ text, voice = 'female' }) {
      if (!azure && !edge) throw new AppError('unavailable', 'İnsansı ses şu an kullanılamıyor.');
      if (typeof text !== 'string' || !text.trim()) throw new AppError('invalid-argument', 'Metin boş.');
      if (text.length > MAX_CHARS) throw new AppError('invalid-argument', `Metin en fazla ${MAX_CHARS} karakter olabilir.`);
      const voiceKey = VOICES[voice] ? voice : 'female';
      const k = cacheKey(text, voiceKey);
      if (memory.has(k)) return { audio: memory.get(k), format: 'mp3', cached: true };

      const ref = db.doc(`tts_cache/${k}`);
      const hit = await ref.get();
      if (hit.exists && hit.get('audio')) {
        remember(k, hit.get('audio'));
        return { audio: hit.get('audio'), format: 'mp3', cached: true };
      }

      let bytes = null;
      // 1) Azure (aylık kota korumalı)
      if (azure) {
        const month = new Date(now()).toISOString().slice(0, 7);
        const usageRef = db.doc(`tts_usage/${month}`);
        const used = (await usageRef.get()).get?.('chars') ?? 0;
        if (used + text.length <= MONTHLY_LIMIT) {
          const res = await fetchImpl(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
            method: 'POST',
            headers: {
              'Ocp-Apim-Subscription-Key': key,
              'Content-Type': 'application/ssml+xml',
              'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
              'User-Agent': 'vsport-api',
            },
            body: buildSsml(text, voiceKey),
          });
          if (res.ok) {
            bytes = Buffer.from(await res.arrayBuffer());
            await usageRef.set({ chars: FieldValue.increment(text.length) }, { merge: true });
          }
        }
      }
      // 2) Edge (anahtarsız, günlük sınırlı)
      if (!bytes && edge) {
        const day = new Date(now()).toISOString().slice(0, 10);
        const dayRef = db.doc(`tts_usage/edge_${day}`);
        const used = (await dayRef.get()).get?.('chars') ?? 0;
        if (used + text.length > EDGE_DAILY_LIMIT) throw new AppError('resource-exhausted', 'Bugünkü insansı ses sınırı doldu; telefon sesi kullanılacak.');
        try {
          bytes = await edgeImpl(text, voiceKey);
          await dayRef.set({ chars: FieldValue.increment(text.length) }, { merge: true });
        } catch (e) {
          console.error('[tts] edge:', e?.message ?? e);
          bytes = null;
        }
      }
      if (!bytes?.length) throw new AppError('unavailable', 'İnsansı ses şu an üretilemedi; telefon sesi kullanılacak.');
      const audio = bytes.toString('base64');
      // Firestore belge sınırı 1 MB: büyük sesler yalnızca bellekte tutulur
      if (audio.length < 900000) await ref.set({ audio, voice: voiceKey, chars: text.length, createdAt: FieldValue.serverTimestamp() });
      remember(k, audio);
      return { audio, format: 'mp3', cached: false };
    },
  };
}
