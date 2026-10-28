// Model + dış tahmin verisi birleşimi (saf). Piyasa görüşü engine/odds.js → marketLambdas ile modelin kendi
// Dixon-Coles matrisine çevrilmiş gol beklentileridir; birleşim de gol beklentisi düzeyinde yapılır, böylece bütün
// tahminler (MS, İY, alt/üst, KG, skorlar) aynı iki sayıdan tutarlı biçimde türer.

import { MODEL } from './config.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Piyasa görüşünün ağırlığı (0 = yalnızca model). snap: market.js anlık görüntüsü { at, x12: {n, spread}, lambdas: {home, away, error} }.
 */
export function marketWeight(snap, { now = Date.now(), cfg = MODEL.marketBlend } = {}) {
  if (!snap?.x12 || !fin(snap.lambdas?.home) || !fin(snap.lambdas?.away) || !fin(snap.at)) return 0;
  let w = cfg.weight;
  if ((snap.x12.n ?? 1) < 2) w *= cfg.singleSource;
  if (fin(snap.x12.spread) && snap.x12.spread > cfg.spreadMax) w *= 0.5;
  if (fin(snap.lambdas.error) && snap.lambdas.error > cfg.fitErrorMax) w *= 0.5;
  const ageH = (now - snap.at) / 3600e3;
  if (ageH > 2 * cfg.staleHours) return 0;
  if (ageH > cfg.staleHours) w *= 0.5;
  return clamp(w, 0, cfg.max);
}

/**
 * Gol beklentilerinin geometrik ağırlıklı ortalaması. Belirsizlik (sigma) piyasa payı kadar daralır: piyasa görüşü
 * güç farkının belirsizliğini zaten içerir.
 * model: { home, away, sigma }  market: { home, away }  → { home, away, sigma, weight }
 */
export function blendLambdas(model, market, weight) {
  const sigma = fin(model.sigma) ? model.sigma : 0;
  if (!(weight > 0) || !fin(market?.home) || !fin(market?.away) || market.home <= 0 || market.away <= 0) {
    return { home: model.home, away: model.away, sigma, weight: 0 };
  }
  const w = clamp(weight, 0, 1);
  const g = (a, b) => Math.exp((1 - w) * Math.log(a) + w * Math.log(b));
  return { home: g(model.home, market.home), away: g(model.away, market.away), sigma: sigma * (1 - w), weight: w };
}
