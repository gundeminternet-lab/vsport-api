// Canlı tahmin uç noktası (getLiveForecast): uygulamadaki canlı AI analiz kartı, baskı kartı ve AI yorumcu videoları
// sayıları buradan alır. Asistan da aynı modeli (engine/live_model.js) kullanır; böylece her ekranda aynı ihtimaller görünür.
//
// Maç öncesi güç (model) maç başına bir kez hesaplanıp bellekte tutulur; canlı durum (dakika, skor, şut, kart) ESPN
// özetinden en çok 15 sn'de bir okunur. Aynı maçı aynı anda soran kullanıcılar tek hesabı paylaşır.

import { AppError, matchKey } from './logic.js';
import { parseLive } from './assistant.js';
import { liveForecast, forecastView } from './engine/live_model.js';

const FORECAST_TTL = 15e3;
const MODEL_TTL = 30 * 60e3;

export class LiveForecastService {
  /** lambdasFor: async (key) → { home, away, sigma } | null — maç başında kilitlenen son tahminin gol beklentileri (daily.js). */
  constructor({ paid, now = () => Date.now(), ttlMs = FORECAST_TTL, lambdasFor = null }) {
    this.paid = paid;
    this.lambdasFor = lambdasFor;
    this.now = now;
    this.ttlMs = ttlMs;
    this._forecasts = new Map(); // key → { at, value }
    this._models = new Map(); // key → { at, model }
    this._inflight = new Map(); // key → Promise
  }

  async forecast({ uid, league, eventId, kickoff }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.paid.validate({ league, eventId, kickoff }, { needType: false });
    const key = matchKey(league, eventId);
    const hit = this._forecasts.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    if (this._inflight.has(key)) return this._inflight.get(key);
    const job = this._compute({ league, eventId, kickoff, key }).finally(() => this._inflight.delete(key));
    this._inflight.set(key, job);
    return job;
  }

  async _compute({ league, eventId, kickoff, key }) {
    const match = await this.paid.findMatch({ league, eventId, kickoff });
    if (match.timestamp > this.now()) throw new AppError('failed-precondition', 'Maç henüz başlamadı.');
    const info = parseLive(await this.paid.espn.getSummary(league, eventId, { maxAgeMs: 15e3 }));
    let value;
    if (!info || info.state !== 'in') {
      value = { key, available: false, state: info?.state ?? 'pre' };
    } else {
      const model = await this._model(match, key);
      const f = liveForecast(model, info);
      value = {
        key,
        available: true,
        state: 'in',
        minute: info.minute,
        period: info.period,
        halftime: info.halftime,
        score: { home: info.home, away: info.away },
        reds: info.reds,
        ...forecastView(f),
        // Maç öncesi gol beklentileri: uygulama sunucuya kısa süre ulaşamazsa (ör. gol yeni olduysa) yaklaşık hesabı
        // takım gücüne dayandırır.
        prematch: { home: Math.round(model.lambdaHome * 100) / 100, away: Math.round(model.lambdaAway * 100) / 100 },
      };
    }
    this._forecasts.set(key, { at: this.now(), value });
    if (this._forecasts.size > 500) this._forecasts.clear();
    return value;
  }

  /** Maç öncesi güç: maç başlamadan bir dakika öncesine kadarki veriyle (canlı skor modele sızmaz). */
  async _model(match, key) {
    const hit = this._models.get(key);
    if (hit && this.now() - hit.at < MODEL_TTL) return hit.model;
    const opts = { asOf: match.timestamp - 60000 };
    const content = await this.paid.contentFor(match, opts);
    let model = await this.paid.modelFor(match, content, opts);
    // Tahmin maç başına kadar dış veriyle güncellendiyse canlı model o son (kilitli) gol beklentileriyle başlar
    const fin = this.lambdasFor ? await this.lambdasFor(key).catch(() => null) : null;
    if (fin && Number.isFinite(fin.home) && Number.isFinite(fin.away)) {
      model = { ...model, lambdaHome: fin.home, lambdaAway: fin.away, ...(Number.isFinite(fin.sigma) ? { sigma: fin.sigma } : {}) };
    }
    this._models.set(key, { at: this.now(), model });
    if (this._models.size > 300) this._models.clear();
    return model;
  }
}
