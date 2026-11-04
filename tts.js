// İnsansı (nöral) AI sesi: Türkçe metni MP3'e çevirir.
//   "spiker" (vSport Spiker, uygulamanın kendi sesi) sırayla:
//     0) ElevenLabs — ELEVENLABS_API_KEY ve ELEVENLABS_VOICE_ID tanımlıysa (ücretli, isteğe bağlı). ELEVENLABS_MODEL,
//        ELEVENLABS_MONTHLY_LIMIT (aylık karakter, varsayılan 110.000) ve ELEVENLABS_FORMAT ile ayarlanır.
//     1) Google Cloud Chirp 3 HD — GOOGLE_TTS_API_KEY tanımlıysa. Aylık 1 milyon karakter ücretsizdir; sunucu
//        GOOGLE_TTS_MONTHLY_LIMIT (varsayılan 950.000) karakterde durur, böylece ücret çıkmaz. Ses GOOGLE_TTS_VOICE
//        (varsayılan tr-TR-Chirp3-HD-Fenrir). Ay, Google faturasıyla aynı olsun diye Pasifik saatine göre sayılır.
//     Sınır dolarsa ya da hizmet yanıt vermezse aşağıdakilere düşülür.
//   Bütün sesler için:
//     2) Azure Konuşma hizmeti — AZURE_SPEECH_KEY ve AZURE_SPEECH_REGION tanımlıysa (resmi, aylık 0,5M karakter ücretsiz)
//     3) Edge "Sesli oku" (edge_tts.js) — anahtar gerekmez; TTS_PROVIDER=off ile kapatılabilir
//   Hiçbiri olmazsa uygulama telefonun kendi sesine döner.
//   Aynı metin ve ses için üretilen ses Firestore'da saklanır (tts_cache): herkes aynı analizi dinlediği için
//   aylık ücretsiz kotalar çok daha geç dolar. Aylık kullanım tts_usage/{YYYY-MM}, tts_usage/google_{YYYY-MM}.

import crypto from 'node:crypto';
import { AppError } from './logic.js';
import { edgeSynthesize } from './edge_tts.js';

export const VOICES = {
  // vSport Spiker: ElevenLabs yoksa Ahmet sesi spiker ayarıyla (biraz hızlı, daha kalın)
  spiker: { name: 'tr-TR-AhmetNeural', rate: '+2%', pitch: '-4%' },
  female: { name: 'tr-TR-EmelNeural', rate: '-4%', pitch: '+0%' },
  male: { name: 'tr-TR-AhmetNeural', rate: '-6%', pitch: '-2%' },
};
/**
 * Sahnenin havası: anlatım hızı ve ses tonu temel değerin üstüne yüzde olarak eklenir; nefes payı da değişir.
 * "warm" eski davranışla birebir aynıdır (önbellekteki sesler geçerli kalır).
 */
export const MOODS = {
  warm: { rate: 0, pitch: 0, pause: 320 },
  calm: { rate: -3, pitch: -1, pause: 380 },
  excited: { rate: 7, pitch: 4, pause: 240 },
  serious: { rate: -6, pitch: -3, pause: 440 },
};
export const moodOf = (mood) => (MOODS[mood] ? mood : 'warm');

const pctNum = (s) => Number.parseFloat(String(s)) || 0;
const signed = (n, unit) => `${n >= 0 ? '+' : ''}${n}${unit}`;

/** Sesin temel değerine havanın payını ekler. Azure: yüzde; Edge: tek <prosody> olduğu için Hz (yaklaşık 2 Hz ≈ %1). */
export function prosodyFor(voiceKey = 'female', mood = 'warm') {
  const v = VOICES[voiceKey] ?? VOICES.female;
  const m = MOODS[moodOf(mood)];
  const rate = pctNum(v.rate) + m.rate;
  const pitch = pctNum(v.pitch) + m.pitch;
  return {
    rate: signed(rate, '%'),
    pitch: signed(pitch, '%'),
    edgeRate: signed(rate, '%'),
    edgePitch: signed(Math.round(pitch * 2), 'Hz'),
    pause: m.pause,
  };
}
export const MAX_CHARS = 1500;
export const MONTHLY_LIMIT = 480000; // ücretsiz kotanın (500.000) biraz altı

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Metni sıcak ve doğal bir anlatıma uygun SSML'e çevirir: cümle aralarında kısa nefes payları. */
export function buildSsml(text, voiceKey = 'female', mood = 'warm') {
  const v = VOICES[voiceKey] ?? VOICES.female;
  const pr = prosodyFor(voiceKey, mood);
  const body = xml(text.trim())
    // Cümle sonlarında kısa duraklama (doğal nefes); havaya göre kısalır ya da uzar
    .replace(/([.!?])\s+/g, `$1<break time="${pr.pause}ms"/> `)
    .replace(/:\s+/g, ':<break time="180ms"/> ');
  // Eski değerlerle birebir uyum: "warm" için rate/pitch temel değerlerdir ("-4%", "+0%")
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="tr-TR">` +
    `<voice name="${v.name}"><prosody rate="${pr.rate}" pitch="${pr.pitch}">${body}</prosody></voice></speak>`
  );
}

/** Önbellek anahtarı: "warm" eski anahtarla aynıdır; diğer havalar ayrı ses üretir. */
export function cacheKey(text, voiceKey, mood = 'warm') {
  const m = moodOf(mood);
  const tail = m === 'warm' ? '' : `|${m}`;
  return crypto.createHash('sha1').update(`${voiceKey}|${VOICES[voiceKey]?.name}|${text.trim()}${tail}`).digest('hex');
}

export const EDGE_DAILY_LIMIT = 300000; // günlük karakter: hizmeti yormamak için

// ---- vSport Spiker (ElevenLabs) ----

/**
 * Havaya göre ses ayarı: düşük "stability" daha canlı ve değişken, yüksek "style" daha vurgulu anlatım, "speed" hız.
 * Maç anı (excited) hızlı ve coşkulu; ciddi anlar (serious) ağır ve sakin.
 */
export const ELEVEN_MOODS = {
  warm: { stability: 0.45, similarity_boost: 0.8, style: 0.3, speed: 1.0 },
  calm: { stability: 0.55, similarity_boost: 0.8, style: 0.2, speed: 0.97 },
  excited: { stability: 0.3, similarity_boost: 0.8, style: 0.55, speed: 1.07 },
  serious: { stability: 0.6, similarity_boost: 0.8, style: 0.15, speed: 0.95 },
};
export const ELEVEN_MODEL = 'eleven_multilingual_v2';
export const ELEVEN_FORMAT = 'mp3_44100_64';
export const ELEVEN_MONTHLY_LIMIT = 110000; // Creator planının aylık kredisinin (≈121.000) biraz altı; multilingual v2: 1 kredi/karakter

/** İstek gövdesi. Dil zorlama yalnızca destekleyen modellerde (v2.5 ve v3) gönderilir; diğerleri hata verir. */
export function elevenBody(text, model = ELEVEN_MODEL, mood = 'warm') {
  return {
    text: text.trim(),
    model_id: model,
    voice_settings: { ...ELEVEN_MOODS[moodOf(mood)], use_speaker_boost: true },
    ...(/v2_5|v3/.test(model) ? { language_code: 'tr' } : {}),
  };
}

/** Spiker önbellek anahtarı: ses kimliği ya da model değişince yeniden üretilir; Microsoft yedeğinden ayrıdır. */
export function elevenCacheKey(text, voiceId, model = ELEVEN_MODEL, mood = 'warm') {
  return crypto.createHash('sha1').update(`eleven|${voiceId}|${model}|${moodOf(mood)}|${text.trim()}`).digest('hex');
}

// ---- vSport Spiker (Google Cloud Chirp 3 HD, ücretsiz kota) ----

export const GOOGLE_VOICE = 'tr-TR-Chirp3-HD-Fenrir';
export const GOOGLE_MONTHLY_LIMIT = 950000; // ücretsiz kotanın (1.000.000) biraz altı
/** Havaya göre anlatım hızı (Chirp 3 HD ton ayarı almaz; hız alır). */
export const GOOGLE_RATES = { warm: 1.0, calm: 0.96, excited: 1.1, serious: 0.94 };

export function googleBody(text, voice = GOOGLE_VOICE, mood = 'warm') {
  const lang = /^[a-z]{2,3}-[A-Z]{2}/.exec(voice)?.[0] ?? 'tr-TR';
  return {
    input: { text: text.trim() },
    voice: { languageCode: lang, name: voice },
    audioConfig: { audioEncoding: 'MP3', speakingRate: GOOGLE_RATES[moodOf(mood)] },
  };
}

export function googleCacheKey(text, voice = GOOGLE_VOICE, mood = 'warm') {
  return crypto.createHash('sha1').update(`google|${voice}|${moodOf(mood)}|${text.trim()}`).digest('hex');
}

const pacificMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' });
/** Google faturası ayı Pasifik saatine göre başlatır; sayaç da aynı ayı kullanır. */
export const billingMonth = (ms) => pacificMonth.format(new Date(ms));

export function createTts({
  db,
  FieldValue,
  key = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  edge = process.env.TTS_PROVIDER !== 'off',
  elevenKey = process.env.ELEVENLABS_API_KEY,
  elevenVoice = process.env.ELEVENLABS_VOICE_ID,
  elevenModel = process.env.ELEVENLABS_MODEL || ELEVEN_MODEL,
  elevenFormat = process.env.ELEVENLABS_FORMAT || ELEVEN_FORMAT,
  elevenLimit = Number(process.env.ELEVENLABS_MONTHLY_LIMIT) || ELEVEN_MONTHLY_LIMIT,
  googleKey = process.env.GOOGLE_TTS_API_KEY,
  googleVoice = process.env.GOOGLE_TTS_VOICE || GOOGLE_VOICE,
  googleLimit = Number(process.env.GOOGLE_TTS_MONTHLY_LIMIT) || GOOGLE_MONTHLY_LIMIT,
  edgeImpl = edgeSynthesize,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  const azure = Boolean(key && region);
  const eleven = Boolean(elevenKey && elevenVoice);
  const google = Boolean(googleKey);
  const memory = new Map(); // son kullanılanlar bellekte
  const remember = (k, v) => {
    memory.delete(k);
    memory.set(k, v);
    while (memory.size > 60) memory.delete(memory.keys().next().value);
  };

  /** Saklanan ses (bellek, sonra Firestore). */
  async function cached(k) {
    if (memory.has(k)) return memory.get(k);
    const hit = await db.doc(`tts_cache/${k}`).get();
    if (hit.exists && hit.get('audio')) {
      remember(k, hit.get('audio'));
      return hit.get('audio');
    }
    return null;
  }

  async function store(k, audio, meta) {
    // Firestore belge sınırı 1 MB: büyük sesler yalnızca bellekte tutulur
    if (audio.length < 900000) await db.doc(`tts_cache/${k}`).set({ audio, ...meta, createdAt: FieldValue.serverTimestamp() });
    remember(k, audio);
  }

  /** Spiker sağlayıcıları (sırayla). synth: base64 MP3 ya da null. */
  const providers = [];
  if (eleven) {
    providers.push({
      id: 'elevenlabs',
      key: (text, mood) => elevenCacheKey(text, elevenVoice, elevenModel, mood),
      usage: () => `tts_usage/eleven_${new Date(now()).toISOString().slice(0, 7)}`,
      limit: elevenLimit,
      async synth(text, mood) {
        const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenVoice)}?output_format=${elevenFormat}`, {
          method: 'POST',
          headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify(elevenBody(text, elevenModel, mood)),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          console.error('[tts] elevenlabs:', res.status, (await res.text?.().catch(() => '')) ?? '');
          return null;
        }
        const bytes = Buffer.from(await res.arrayBuffer());
        return bytes.length ? bytes.toString('base64') : null;
      },
    });
  }
  if (google) {
    providers.push({
      id: 'google',
      key: (text, mood) => googleCacheKey(text, googleVoice, mood),
      usage: () => `tts_usage/google_${billingMonth(now())}`,
      limit: googleLimit,
      async synth(text, mood) {
        const res = await fetchImpl('https://texttospeech.googleapis.com/v1/text:synthesize', {
          method: 'POST',
          headers: { 'X-Goog-Api-Key': googleKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(googleBody(text, googleVoice, mood)),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          console.error('[tts] google:', res.status, (await res.text?.().catch(() => '')) ?? '');
          return null;
        }
        const audio = (await res.json())?.audioContent;
        return typeof audio === 'string' && audio.length ? audio : null;
      },
    });
  }

  // Aynı metin için eşzamanlı istekler tek üretimi bekler (aynı ses iki kez sayılmaz)
  const pending = new Map();
  function fromProvider(p, text, moodKey) {
    const k = p.key(text, moodKey);
    if (!pending.has(k)) pending.set(k, fresh(p, k, text, moodKey).finally(() => pending.delete(k)));
    return pending.get(k);
  }

  /** Tek sağlayıcıdan spiker sesi. Aylık sınır dolduysa ya da hizmet yanıt vermezse null (sıradakine geçilir). */
  async function fresh(p, k, text, moodKey) {
    const hit = await cached(k);
    if (hit) return { audio: hit, cached: true };
    const usageRef = db.doc(p.usage());
    const used = (await usageRef.get()).get?.('chars') ?? 0;
    if (used + text.length > p.limit) {
      console.warn(`[tts] ${p.id}: aylık sınır doldu, sıradaki sese geçiliyor`);
      return null;
    }
    try {
      const audio = await p.synth(text, moodKey);
      if (!audio) return null;
      await usageRef.set({ chars: FieldValue.increment(text.length) }, { merge: true });
      await store(k, audio, { voice: 'spiker', provider: p.id, mood: moodKey, chars: text.length });
      return { audio, cached: false };
    } catch (e) {
      console.error(`[tts] ${p.id}:`, e?.message ?? e);
      return null;
    }
  }

  async function spiker(text, moodKey) {
    for (const p of providers) {
      const r = await fromProvider(p, text, moodKey);
      if (r) return r;
    }
    return null;
  }

  return {
    enabled: azure || edge || providers.length > 0,
    spiker: providers.length > 0,

    async speak({ text, voice = 'female', mood = 'warm' }) {
      if (!azure && !edge && !providers.length) throw new AppError('unavailable', 'İnsansı ses şu an kullanılamıyor.');
      if (typeof text !== 'string' || !text.trim()) throw new AppError('invalid-argument', 'Metin boş.');
      if (text.length > MAX_CHARS) throw new AppError('invalid-argument', `Metin en fazla ${MAX_CHARS} karakter olabilir.`);
      const voiceKey = VOICES[voice] ? voice : 'female';
      const moodKey = moodOf(mood);
      if (voiceKey === 'spiker' && providers.length) {
        const r = await spiker(text, moodKey);
        if (r) return { audio: r.audio, format: 'mp3', cached: r.cached, voice: 'spiker' };
        if (!azure && !edge) throw new AppError('unavailable', 'İnsansı ses şu an üretilemedi; telefon sesi kullanılacak.');
      }
      const k = cacheKey(text, voiceKey, moodKey);
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
            body: buildSsml(text, voiceKey, moodKey),
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
          bytes = await edgeImpl(text, voiceKey, { mood: moodKey });
          await dayRef.set({ chars: FieldValue.increment(text.length) }, { merge: true });
        } catch (e) {
          console.error('[tts] edge:', e?.message ?? e);
          bytes = null;
        }
      }
      if (!bytes?.length) throw new AppError('unavailable', 'İnsansı ses şu an üretilemedi; telefon sesi kullanılacak.');
      const audio = bytes.toString('base64');
      await store(k, audio, { voice: voiceKey, mood: moodKey, chars: text.length });
      return { audio, format: 'mp3', cached: false };
    },
  };
}
