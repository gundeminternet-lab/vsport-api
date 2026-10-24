// Kupon ekran görüntüsünden seçim okuma. Model YALNIZCA okur: maç adı, tahmin ve (varsa) sayı çıkarır.
// Olasılıklar ve yorum motordan gelir (check.js). Görüntü saklanmaz; istek bittiğinde bellekten gider.
//
// Güvenlik: model çıktısı JSON olarak ayrıştırılır ve her alan doğrulanır. Tanınmayan tahmin, geçersiz sayı ve
// fazla satır atılır. Kabul edilen tahminler CHECK_MARKETS listesinde olmak zorundadır.

import { AppError } from './logic.js';
import { CHECK_MARKETS } from './check.js';

export const READ_MIME = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // base64 öncesi ham boyut sınırı
export const MAX_PICKS = 10;

const SYSTEM = [
  'Bir bahis kuponu ekran görüntüsünden seçimleri oku.',
  'Yalnızca JSON döndür, başka metin yazma. Biçim: {"picks":[{"home":"ev sahibi","away":"deplasman","market":"tahmin","odd":1.85}]}',
  `market alanı şu listeden biri olmalı: ${CHECK_MARKETS.join(', ')}.`,
  'odd yoksa null yaz. Okunamayan satırları atla; emin olmadığın şeyi uydurma.',
].join(' ');

/** Model metnini güvenli biçimde ayrıştırır ve her seçimi doğrular. Bozuk yanıt boş liste döner. */
export function parseVisionJson(text) {
  const start = String(text ?? '').indexOf('{');
  const end = String(text ?? '').lastIndexOf('}');
  if (start < 0 || end <= start) return { picks: [], dropped: 0 };
  let data;
  try {
    data = JSON.parse(String(text).slice(start, end + 1));
  } catch {
    return { picks: [], dropped: 0 };
  }
  const raw = Array.isArray(data?.picks) ? data.picks : [];
  const picks = [];
  let dropped = 0;
  for (const p of raw) {
    const home = typeof p?.home === 'string' ? p.home.trim().slice(0, 60) : '';
    const away = typeof p?.away === 'string' ? p.away.trim().slice(0, 60) : '';
    const market = typeof p?.market === 'string' ? p.market.trim() : '';
    const odd = p?.odd === null || p?.odd === undefined ? null : Number(p.odd);
    const oddOk = odd === null || (Number.isFinite(odd) && odd >= 1.01 && odd <= 100);
    if (!home || !away || !CHECK_MARKETS.includes(market) || !oddOk) {
      dropped++;
      continue;
    }
    if (picks.length >= MAX_PICKS) {
      dropped++;
      continue;
    }
    picks.push({ home, away, market, odd: odd === null ? null : Math.round(odd * 100) / 100 });
  }
  return { picks, dropped };
}

/** Anthropic Messages API'sine görüntülü istek. fetchImpl test için değiştirilebilir. */
export function visionGenerator({ apiKey, model = 'claude-haiku-5-5', fetchImpl = fetch }) {
  return async ({ system, imageBase64, mimeType, timeoutMs }) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        system,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
            { type: 'text', text: 'Bu kupon görüntüsündeki seçimleri JSON olarak oku.' },
          ],
        }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const json = await res.json();
    return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  };
}

export class CouponReader {
  /** generate yoksa okuma kapalıdır. dailyMax günlük çağrı sınırıdır (bellekte). */
  constructor({ generate = null, dailyMax = 50, timeoutMs = 20000, now = () => Date.now() } = {}) {
    this.generate = generate;
    this.dailyMax = dailyMax;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this._day = null;
    this._count = 0;
  }

  get enabled() {
    return Boolean(this.generate);
  }

  async read({ imageBase64, mimeType } = {}) {
    if (!this.generate) throw new AppError('failed-precondition', 'Görüntüden okuma şu an kapalı.');
    if (!READ_MIME.includes(mimeType)) throw new AppError('invalid-argument', 'Yalnızca JPEG, PNG veya WebP görüntü.');
    if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length * 0.75 > MAX_IMAGE_BYTES) {
      throw new AppError('invalid-argument', 'Görüntü çok büyük ya da boş.');
    }
    const day = new Date(this.now() + 3 * 3600e3).toISOString().slice(0, 10);
    if (day !== this._day) {
      this._day = day;
      this._count = 0;
    }
    if (this._count >= this.dailyMax) throw new AppError('resource-exhausted', 'Bugünlük görüntü okuma sınırına ulaşıldı; yarın tekrar deneyin.');
    this._count += 1;

    let text;
    try {
      text = await this.generate({ system: SYSTEM, imageBase64, mimeType, timeoutMs: this.timeoutMs });
    } catch {
      throw new AppError('unavailable', 'Görüntü şu an okunamadı; lütfen tekrar deneyin ya da seçimleri metin olarak yapıştırın.');
    }
    const { picks, dropped } = parseVisionJson(text);
    return { picks, dropped };
  }
}

/** Ortam değişkenlerinden okuyucu kurar. Anahtar yoksa kapalıdır. */
export function readerFromEnv(env = process.env) {
  const apiKey = env.COUPON_READER_API_KEY || env.NARRATOR_API_KEY;
  if (!apiKey) return new CouponReader();
  return new CouponReader({
    generate: visionGenerator({ apiKey, model: env.COUPON_READER_MODEL || 'claude-haiku-5-5' }),
    dailyMax: Number(env.COUPON_READER_DAILY_MAX) || 50,
  });
}
