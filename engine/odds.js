// Dış tahmin kaynaklarından gelen sayıların (oran) ayrıştırılması ve olasılığa çevrilmesi. Ağdan bağımsız saf
// fonksiyonlardır. Bu sayılar YALNIZCA sunucuda model girdisi ve karşılaştırma için kullanılır; uygulamada oran,
// kaynak adı ya da bağlantı gösterilmez.
//
// Biçimler (ESPN core .../competitions/{id}/odds öğeleri ve summary yanıtındaki pickcenter/odds dizileri):
//   homeTeamOdds.moneyLine = -165 (Amerikan)            homeTeamOdds.current.moneyLine = { decimal, american, ... }
//   drawOdds.moneyLine = 290                             overUnder = 2.5, overOdds = -150, underOdds = 120
//   open / close / current: aynı alanların açılış, kapanış ve güncel değerleri (varsa)
// Biçim liglere ve sağlayıcılara göre değişebildiği için her alan isteğe bağlıdır; okunamayan pazar atlanır.

import { baseMatrix } from './analysis.js';
import { MODEL } from './config.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Amerikan oran → ondalık (+140 → 2.40, -165 → 1.606). Geçersizse NaN. */
export function americanToDecimal(ml) {
  const n = typeof ml === 'string' ? Number(ml.trim().replace(/^\+/, '')) : ml;
  if (!isNum(n) || Math.abs(n) < 100) return NaN;
  return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
}

/** Ondalık → Amerikan (2.40 → 140, 1.606 → -165). */
export function decimalToAmerican(d) {
  if (!isNum(d) || d <= 1) return NaN;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

const okDecimal = (d) => isNum(d) && d > 1.01 && d < 200;

/**
 * Tek bir fiyatı ondalığa çevirir. Kabul edilenler: Amerikan sayı (|x| ≥ 100), ondalık sayı (1 < x < 100),
 * "+140" / "-165" / "EVEN" / "7/4" / "1.61" metinleri ve { decimal | american | alternateDisplayValue | value } nesneleri.
 */
export function toDecimal(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'object') {
    if (v.decimal !== undefined) {
      const d = toDecimal(Number(v.decimal));
      if (okDecimal(d)) return d;
    }
    for (const k of ['american', 'alternateDisplayValue', 'value', 'displayValue']) {
      if (v[k] === undefined) continue;
      const d = toDecimal(v[k]);
      if (okDecimal(d)) return d;
    }
    return NaN;
  }
  if (typeof v === 'string') {
    const s = v.trim().toUpperCase();
    if (s === 'EVEN' || s === 'EV' || s === 'EVS') return 2;
    const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(s);
    if (frac) return Number(frac[2]) > 0 ? 1 + Number(frac[1]) / Number(frac[2]) : NaN;
    if (/^[+-]\d{3,}$/.test(s)) return americanToDecimal(s);
    const n = Number(s);
    return isNum(n) ? toDecimal(n) : NaN;
  }
  if (!isNum(v)) return NaN;
  if (Math.abs(v) >= 100) return americanToDecimal(v);
  return v > 1 ? v : NaN;
}

/** Toplam gol çizgisi (0.5'in ya da 0.25'in katı, 0.5-8). */
function toLine(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'object') {
    for (const k of ['american', 'alternateDisplayValue', 'line', 'value', 'displayValue']) {
      const n = toLine(v[k]);
      if (isNum(n)) return n;
    }
    return NaN;
  }
  const n = typeof v === 'string' ? Number(v.trim().replace(/^[OoUu]\s*/, '')) : v;
  return isNum(n) && n >= 0.5 && n <= 8 && Number.isInteger(n * 4) ? n : NaN;
}

const priceOf = (v) => {
  const d = toDecimal(v);
  return okDecimal(d) ? Math.round(d * 1000) / 1000 : null;
};

/** Bir anın (güncel / açılış / kapanış) fiyatları; okunamayan alan null. */
function snapshotOf(item, phase) {
  const side = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (phase === 'current') return priceOf(o.current?.moneyLine) ?? priceOf(o.moneyLine) ?? priceOf(o.odds);
    return priceOf(o[phase]?.moneyLine);
  };
  const draw = item.drawOdds ?? item.tieOdds ?? item.drawTeamOdds;
  const block = phase === 'current' ? item.current : item[phase];
  // Gol çizgisi ve fiyatları: güncel değer düz alanlarda (overUnder/overOdds) ya da current nesnesinde
  let total = toLine(block?.total);
  // Bazı yanıtlarda open.over.value doğrudan çizgidir (fiyat alanı olmadan)
  if (!isNum(total) && block?.over && block.over.decimal === undefined && block.over.american === undefined) total = toLine(block.over.value);
  if (!isNum(total) && phase === 'current') total = toLine(item.overUnder);
  const priced = (o) => (o && (o.decimal !== undefined || o.american !== undefined || o.alternateDisplayValue !== undefined) ? priceOf(o) : null);
  let over = priced(block?.over);
  let under = priced(block?.under);
  if (phase === 'current') {
    over ??= priceOf(item.overOdds);
    under ??= priceOf(item.underOdds);
  }
  const out = {
    home: side(item.homeTeamOdds),
    draw: phase === 'current' ? (priceOf(draw?.current?.moneyLine) ?? priceOf(draw?.moneyLine) ?? priceOf(draw?.odds)) : priceOf(draw?.[phase]?.moneyLine),
    away: side(item.awayTeamOdds),
    total: isNum(total) ? total : null,
    over,
    under,
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** Tek sağlayıcı kaydı → { provider, current, open, close }. Hiçbir fiyat okunamazsa null. */
export function parseOddsItem(item) {
  if (!item || typeof item !== 'object') return null;
  const current = snapshotOf(item, 'current');
  if (!current) return null;
  const p = item.provider ?? {};
  return {
    provider: { id: p.id === undefined ? null : String(p.id), name: p.name ?? p.displayName ?? null, priority: isNum(Number(p.priority)) ? Number(p.priority) : null },
    current,
    open: snapshotOf(item, 'open'),
    close: snapshotOf(item, 'close'),
  };
}

/** Core API yanıtı ({items}) ya da summary yanıtı ({pickcenter, odds}) → sağlayıcı listesi (yinelenenler atılır). */
export function parseOddsResponse(json) {
  const raw = [];
  if (Array.isArray(json)) raw.push(...json);
  else if (json && typeof json === 'object') {
    for (const k of ['items', 'pickcenter', 'odds']) if (Array.isArray(json[k])) raw.push(...json[k]);
  }
  const out = [];
  const seen = new Set();
  for (const it of raw) {
    const p = parseOddsItem(it);
    if (!p) continue;
    const id = p.provider.id ?? p.provider.name ?? `#${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

/**
 * Pay (marj) temizlenmiş olasılıklar. method 'power': p_i = (1/d_i)^k, Σp = 1 olacak k bulunur (favori-sürpriz
 * eğilimini orantılı yöntemden iyi düzeltir); 'proportional': p_i = (1/d_i) / Σ(1/d).
 * Döner: { probs, overround } ya da geçersizse null.
 */
export function impliedProbabilities(decimals, { method = 'power' } = {}) {
  if (!Array.isArray(decimals) || decimals.length < 2 || !decimals.every(okDecimal)) return null;
  const raw = decimals.map((d) => 1 / d);
  const overround = raw.reduce((a, b) => a + b, 0);
  let probs = raw.map((r) => r / overround);
  if (method === 'power' && Math.abs(overround - 1) > 1e-9) {
    // Σ r_i^k azalan bir fonksiyon: ikiye bölme ile Σ = 1 noktası
    let lo = 0.5;
    let hi = 3;
    for (let i = 0; i < 60; i++) {
      const k = (lo + hi) / 2;
      const s = raw.reduce((a, r) => a + r ** k, 0);
      if (s > 1) lo = k;
      else hi = k;
    }
    const k = (lo + hi) / 2;
    const p = raw.map((r) => r ** k);
    const s = p.reduce((a, b) => a + b, 0);
    probs = p.map((x) => x / s);
  }
  return { probs, overround };
}

// Makul pay aralıkları: daha düşük toplam hatalı/eksik veri (arbitraj), daha yüksek toplam güvenilmez sağlayıcı.
export const OVERROUND = { x12: [0.98, 1.3], ou: [0.98, 1.2] };

/** Tek anın pazarları → { x12: {home, draw, away, margin} | null, ou: {line, over, under, margin} | null }. */
export function marketProbabilities(snap, { method = 'power' } = {}) {
  if (!snap) return { x12: null, ou: null };
  let x12 = null;
  if (snap.home && snap.draw && snap.away) {
    const r = impliedProbabilities([snap.home, snap.draw, snap.away], { method });
    if (r && r.overround >= OVERROUND.x12[0] && r.overround <= OVERROUND.x12[1]) {
      x12 = { home: r.probs[0], draw: r.probs[1], away: r.probs[2], margin: r.overround - 1 };
    }
  }
  let ou = null;
  if (snap.total && snap.over && snap.under) {
    const r = impliedProbabilities([snap.over, snap.under], { method });
    if (r && r.overround >= OVERROUND.ou[0] && r.overround <= OVERROUND.ou[1]) ou = { line: snap.total, over: r.probs[0], under: r.probs[1], margin: r.overround - 1 };
  }
  return { x12, ou };
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Sağlayıcıların ortak görüşü (logaritmik havuz: olasılıkların geometrik ortalaması, yeniden normalleştirilir).
 * phase: 'current' | 'open' | 'close'. Gol çizgisi en çok verilen çizgidir; yalnızca o çizgideki fiyatlar birleşir.
 * Döner: { x12: {home, draw, away, n, spread}, ou: {line, over, under, n}, providers } ya da hiç pazar yoksa null.
 */
export function consensus(providers, { phase = 'current', method = 'power' } = {}) {
  const x12s = [];
  const ous = [];
  for (const p of providers ?? []) {
    const m = marketProbabilities(p?.[phase], { method });
    if (m.x12) x12s.push(m.x12);
    if (m.ou) ous.push(m.ou);
  }
  const pool = (rows, keys) => {
    const logs = keys.map((k) => rows.reduce((a, r) => a + Math.log(Math.max(r[k], 1e-6)), 0) / rows.length);
    const ex = logs.map(Math.exp);
    const s = ex.reduce((a, b) => a + b, 0);
    return Object.fromEntries(keys.map((k, i) => [k, round4(ex[i] / s)]));
  };
  let x12 = null;
  if (x12s.length) {
    const homes = x12s.map((r) => r.home);
    x12 = {
      ...pool(x12s, ['home', 'draw', 'away']),
      n: x12s.length,
      // Sağlayıcılar arası ayrışma (ev sahibi olasılığında en büyük fark): yüksekse veri şüphelidir
      spread: round4(Math.max(...homes) - Math.min(...homes)),
      margin: round4(x12s.reduce((a, r) => a + r.margin, 0) / x12s.length),
    };
  }
  let ou = null;
  if (ous.length) {
    const counts = new Map();
    for (const r of ous) counts.set(r.line, (counts.get(r.line) ?? 0) + 1);
    const line = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - 2.5) - Math.abs(b[0] - 2.5))[0][0];
    const rows = ous.filter((r) => r.line === line);
    ou = { line, ...pool(rows, ['over', 'under']), n: rows.length };
  }
  if (!x12 && !ou) return null;
  return { x12, ou, providers: (providers ?? []).length };
}

function overProb(m, line) {
  let p = 0;
  let push = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      const t = i + j;
      if (t > line) p += m[i][j];
      else if (t === line) push += m[i][j];
    }
  }
  // Tam sayı çizgide (ör. 3.0) eşitlik iade edilir: koşullu olasılık
  return push > 0 && push < 1 ? p / (1 - push) : p;
}

function outcomeProbs(m) {
  let h = 0;
  let d = 0;
  let a = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      if (i > j) h += m[i][j];
      else if (i === j) d += m[i][j];
      else a += m[i][j];
    }
  }
  return { h, d, a };
}

/**
 * Piyasa olasılıklarından ima edilen gol beklentileri (λ_ev, λ_dep): modelin Dixon-Coles matrisi bu λ'larla
 * piyasanın 1X2 (ve varsa alt/üst) olasılıklarına en yakın sonucu verir. Kaba ızgara + iki aşamalı daraltma.
 * Döner: { home, away, error } ya da x12 yoksa null.
 */
export function marketLambdas({ x12, ou = null }, { rho = MODEL.dcRho, maxG = 10 } = {}) {
  if (!x12) return null;
  const line = ou && Number.isFinite(ou.line) ? (Number.isInteger(ou.line * 2) ? ou.line : null) : null;
  const err = (lh, la) => {
    const m = baseMatrix(lh, la, rho, maxG);
    const o = outcomeProbs(m);
    let e = (o.h - x12.home) ** 2 + (o.a - x12.away) ** 2 + (o.d - x12.draw) ** 2;
    if (line !== null) e += (overProb(m, line) - ou.over) ** 2;
    return e;
  };
  let best = { lh: 1.4, la: 1.1, e: Infinity };
  const search = (lo1, hi1, lo2, hi2, step) => {
    for (let lh = lo1; lh <= hi1 + 1e-9; lh += step) {
      for (let la = lo2; la <= hi2 + 1e-9; la += step) {
        const e = err(lh, la);
        if (e < best.e) best = { lh, la, e };
      }
    }
  };
  search(0.15, 4.5, 0.15, 4.5, 0.1);
  for (const step of [0.02, 0.004]) {
    const w = step * 6;
    search(Math.max(0.05, best.lh - w), best.lh + w, Math.max(0.05, best.la - w), best.la + w, step);
  }
  return { home: Math.round(best.lh * 1000) / 1000, away: Math.round(best.la * 1000) / 1000, error: Math.sqrt(best.e) };
}
