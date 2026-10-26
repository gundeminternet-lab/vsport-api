// Canlı maç modeli — TEK KAYNAK. Asistan, canlı AI analiz kartı ve AI yorumcu videoları aynı sayıları buradan alır.
//
// Girdi: maç öncesi model (takım gücü: lambdaHome/lambdaAway, belirsizlik sigma) + maçın o anki durumu
// (dakika, devre, skor, şut/isabetli şut, kırmızı kartlar). Kalan süre dakika dakika adımlanarak hesaplanır:
//   1) Zaman eğrisi: gol yoğunluğu maç ilerledikçe artar (ikinci yarıda ve uzatmalarda daha çok gol atılır); beklenen
//      uzatma süreleri dahildir. Kalan süre "düz doğru" sayılmaz.
//   2) Güç güncellemesi: maç öncesi güç, maçın içindeki şut kalitesiyle (isabetli şut ağırlıklı kaba xG) harmanlanır.
//      Oynanan süre arttıkça maç içi verinin ağırlığı artar (gamma-Poisson güncellemesi). Şut verisi yoksa atılan
//      goller daha düşük ağırlıkla kullanılır.
//   3) Skor etkisi: geride kalan takım daha çok atağa çıkar, önde olan geri çekilir. Etki her adımda o anki skora göre
//      uygulanır (beraberlik golünden sonra etki kalkar).
//   4) Kırmızı kart: eksik kalan takımın gol hızı düşer, rakibininki artar.
// Çıktı: 1-X-2, "skor böyle biter", sıradaki gol, en olası 3 final skoru, beklenen final, 2,5 üst, iki takım da gol.
//
// Katsayılar yayımlanmış futbol istatistiklerine göre kabaca ayarlıdır (gollerin ~%45'i ilk yarıda; 10 kişi kalan
// takımın gol hızı ~%30 düşer). Gerçek maç verisiyle yeniden ayarlanabilir: tests/live_model.test.js kalibrasyon kontrolü.

import { mixtureNodes } from './analysis.js';

export const LIVE = Object.freeze({
  ramp: 0.5, // gol yoğunluğu: r(t) = 1 + ramp·t/90 → ilk yarıda gollerin yaklaşık %45'i
  stoppage1: 2.5, // ilk yarı beklenen uzatma (dk)
  stoppage2: 5.5, // ikinci yarı beklenen uzatma (dk)
  sotXg: 0.24, // isabetli şut başına kaba gol değeri
  shotXg: 0.04, // isabetsiz / bloklanan şut başına
  priorShots: 3, // maç öncesi gücün "maç" cinsinden ağırlığı (şut verisi varken); yapay maç denemesinde en iyi 2-3
  priorGoals: 14, // şut verisi yokken goller çok gürültülü: maç öncesi güç çok daha ağır basar
  trail1: 1.12, // fark 1: geride olanın gol hızı
  lead1: 0.92, // fark 1: önde olanın gol hızı
  trail2: 1.05, // fark ≥ 2
  lead2: 0.97,
  redOwn: 0.7, // eksik oyuncu başına kendi gol hızı (en çok 2 eksik sayılır)
  redOpp: 1.3, // eksik oyuncu başına rakibin gol hızı
  maxExtra: 10, // kalan sürede takım başı en çok ek gol (dağılım kesimi)
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rate = (t) => 1 + (LIVE.ramp * t) / 90;
/** ∫ r(t) dt, a..b (normal süre içinde). */
const mass = (a, b) => (b - a) + (LIVE.ramp * (b * b - a * a)) / 180;

const HALF1 = mass(0, 45) + LIVE.stoppage1 * rate(45);
const HALF2 = mass(45, 90) + LIVE.stoppage2 * rate(90);
export const TOTAL_MASS = HALF1 + HALF2;

/**
 * Maçın neresindeyiz: oynanan dakika + devre bilgisi. ESPN "45'+2'" saatini 47 olarak verir; devre 1 ise bu ilk yarının
 * uzatmasıdır. Devre bilinmiyorsa 45'ten büyük dakika ikinci yarı sayılır.
 * Dönen: { remaining: kalan yoğunluk, played: oynanan yoğunluk, remShare: kalan pay (0..1), segments: [{ t, w }] }
 * segments: kalan sürenin dakikalık adımları (t: dakika, w: o adımın yoğunluk payı); toplamı remaining'e eşittir.
 */
export function timeline({ minute = 0, period = 0, halftime = false } = {}) {
  const m = Math.max(0, Number(minute) || 0);
  // Devre 1 ama dakika ilk yarının uzatmasına sığmıyorsa (yanlış devre bilgisi) ikinci yarı sayılır
  if (period === 1 && m > 55) period = 2;
  const segs = [];
  const push = (t, w) => {
    if (w > 0) segs.push({ t, w });
  };
  const run = (from, to, step = 1) => {
    // normal süre: dakikalık dilimler
    for (let a = from; a < to - 1e-9; a += step) {
      const b = Math.min(to, a + step);
      push(a, mass(a, b));
    }
  };
  const extra = (at, minutes, r) => {
    // uzatma: sabit yoğunluk (devrenin son dakikasındaki gibi)
    let left = minutes;
    let t = at;
    while (left > 1e-9) {
      const d = Math.min(1, left);
      push(t, d * r);
      left -= d;
      t += d;
    }
  };
  const firstHalf = !halftime && (period === 1 || (period !== 2 && m <= 45));
  if (halftime) {
    run(45, 90);
    extra(90, LIVE.stoppage2, rate(90));
  } else if (firstHalf) {
    if (m <= 45) {
      run(m, 45);
      extra(45, LIVE.stoppage1, rate(45));
    } else {
      extra(m, Math.max(LIVE.stoppage1 - (m - 45), 0.5), rate(45));
    }
    run(45, 90);
    extra(90, LIVE.stoppage2, rate(90));
  } else if (m <= 90) {
    run(Math.max(m, 45), 90);
    extra(90, LIVE.stoppage2, rate(90));
  } else {
    extra(m, Math.max(LIVE.stoppage2 - (m - 90), 1), rate(90));
  }
  const remaining = segs.reduce((s, x) => s + x.w, 0);
  const remShare = clamp(remaining / TOTAL_MASS, 0, 1);
  return { remaining, played: TOTAL_MASS - remaining, remShare, segments: segs };
}

/** Kaba xG: isabetli şut ağırlıklı. */
export function shotValue({ shots = 0, onTarget = 0 } = {}) {
  const sot = Math.max(0, Number(onTarget) || 0);
  const all = Math.max(sot, Number(shots) || 0);
  return LIVE.sotXg * sot + LIVE.shotXg * (all - sot);
}

/**
 * Maç öncesi gücü maç içi veriyle günceller (maç başı gol hızı).
 * stats: { home: { shots, onTarget }, away: {...} } ya da null (veri yok). goals: [ev, dep].
 */
export function updatedRates({ lambdaHome, lambdaAway }, { elapsed, stats, goals = [0, 0] }, P = LIVE) {
  const e = clamp(elapsed, 0, 1);
  const hasShots =
    stats && stats.home && stats.away && (e < 0.25 || (Number(stats.home.shots) || 0) + (Number(stats.away.shots) || 0) > 0);
  if (e <= 0.01) return { home: lambdaHome, away: lambdaAway, weight: 0, source: 'prematch' };
  if (hasShots) {
    const k = P.priorShots;
    return {
      home: (lambdaHome * k + shotValue(stats.home)) / (k + e),
      away: (lambdaAway * k + shotValue(stats.away)) / (k + e),
      weight: e / (k + e),
      source: 'shots',
    };
  }
  const k = P.priorGoals;
  return {
    home: (lambdaHome * k + (goals[0] || 0)) / (k + e),
    away: (lambdaAway * k + (goals[1] || 0)) / (k + e),
    weight: e / (k + e),
    source: 'goals',
  };
}

/** Skor ve kırmızı kart çarpanları: [ev, dep]. diff = ev − dep (o anki), reds = [ev eksik, dep eksik]. */
export function stateFactors(diff, reds = [0, 0]) {
  let fh = 1;
  let fa = 1;
  if (diff === 1 || diff === -1) {
    fh = diff > 0 ? LIVE.lead1 : LIVE.trail1;
    fa = diff > 0 ? LIVE.trail1 : LIVE.lead1;
  } else if (Math.abs(diff) >= 2) {
    fh = diff > 0 ? LIVE.lead2 : LIVE.trail2;
    fa = diff > 0 ? LIVE.trail2 : LIVE.lead2;
  }
  const rh = clamp(Number(reds[0]) || 0, 0, 2);
  const ra = clamp(Number(reds[1]) || 0, 0, 2);
  fh *= LIVE.redOwn ** rh * LIVE.redOpp ** ra;
  fa *= LIVE.redOwn ** ra * LIVE.redOpp ** rh;
  return [fh, fa];
}

/**
 * Kalan sürenin skor dağılımı (ek goller) ve sıradaki gol: dakika dakika ilerleyen Markov zinciri.
 * Her adımda gol olasılıkları o anki skora göre değişir (skor etkisi). rates: maç başı gol hızı.
 * Dönen: { m: (ek ev × ek dep) olasılık tablosu, next: [ev, dep, yok] }
 */
export function remainingDistribution({ rateHome, rateAway, segments, home = 0, away = 0, reds = [0, 0] }) {
  const N = LIVE.maxExtra;
  let p = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
  p[0][0] = 1;
  let none = 1; // henüz hiç ek gol yok
  let nextH = 0;
  let nextA = 0;
  for (const { w } of segments) {
    const share = w / TOTAL_MASS;
    const q = Array.from({ length: N + 1 }, () => new Float64Array(N + 1));
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const v = p[i][j];
        if (v < 1e-14) continue;
        const [fh, fa] = stateFactors(home + i - (away + j), reds);
        // Adım içinde gol sayısı Poisson; adım küçük olduğu için en çok bir gol (0, ev, dep) yeterli
        const lh = rateHome * fh * share;
        const la = rateAway * fa * share;
        const p0 = Math.exp(-(lh + la));
        const pg = 1 - p0;
        const ph = (pg * lh) / (lh + la || 1);
        const pa = pg - ph;
        q[i][j] += v * p0;
        q[Math.min(i + 1, N)][j] += v * ph;
        q[i][Math.min(j + 1, N)] += v * pa;
        if (i === 0 && j === 0) {
          nextH += none * ph;
          nextA += none * pa;
          none *= p0;
        }
      }
    }
    p = q;
  }
  return { m: p.map((r) => Array.from(r)), next: [nextH, nextA, none] };
}

/**
 * Canlı tahmin. model: { lambdaHome, lambdaAway, sigma? }.
 * live: { minute, period?, halftime?, home, away, stats?: { home:{shots,onTarget}, away:{...} } | null, reds?: [ev, dep] }
 */
export function liveForecast(model, live, params = null) {
  const P = params ? { ...LIVE, ...params } : LIVE;
  const home = Number(live.home) || 0;
  const away = Number(live.away) || 0;
  const reds = live.reds ?? [0, 0];
  const tl = timeline({ minute: live.minute ?? 0, period: live.period ?? 0, halftime: !!live.halftime });
  const elapsed = 1 - tl.remShare;
  const upd = updatedRates(model, { elapsed, stats: live.stats ?? null, goals: [home, away] }, P);
  // Güç belirsizliği maç içi veriyle azalır
  const sigma = (model.sigma ?? 0) * (1 - upd.weight);
  const nodes = mixtureNodes(upd.home, upd.away, sigma);

  const N = LIVE.maxExtra;
  const m = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
  const next = [0, 0, 0];
  for (const node of nodes) {
    const d = remainingDistribution({ rateHome: node.lh, rateAway: node.la, segments: tl.segments, home, away, reds });
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) m[i][j] += node.w * d.m[i][j];
    for (let k = 0; k < 3; k++) next[k] += node.w * d.next[k];
  }

  let p1 = 0;
  let pX = 0;
  let p2 = 0;
  let over25 = 0;
  let btts = 0;
  let expH = 0;
  let expA = 0;
  let total = 0;
  const finals = [];
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const p = m[i][j];
      if (!(p > 0)) continue;
      total += p;
      const fh = home + i;
      const fa = away + j;
      if (fh > fa) p1 += p;
      else if (fh === fa) pX += p;
      else p2 += p;
      if (fh + fa >= 3) over25 += p;
      if (fh > 0 && fa > 0) btts += p;
      expH += i * p;
      expA += j * p;
      finals.push({ score: `${fh}-${fa}`, p });
    }
  }
  const norm = total > 0 ? total : 1;
  finals.sort((a, b) => b.p - a.p);
  const topFinals = finals.slice(0, 3).map((f) => ({ score: f.score, p: f.p / norm }));
  const noMoreGoals = m[0][0] / norm;
  return {
    rem: tl.remShare,
    p1: p1 / norm,
    pX: pX / norm,
    p2: p2 / norm,
    over25: over25 / norm,
    btts: btts / norm,
    noMoreGoals,
    moreGoals: 1 - noMoreGoals,
    nextGoal: { home: next[0], away: next[1], none: next[2] },
    topFinals,
    topScore: topFinals[0]?.score ?? `${home}-${away}`,
    expected: { home: home + expH / norm, away: away + expA / norm },
    remainingGoals: { home: expH / norm, away: expA / norm },
    rates: { home: upd.home, away: upd.away, weight: upd.weight, source: upd.source },
  };
}

/** Yüzdeye çevirir; üçlü toplam 100 olur (en büyük kalanlı yuvarlama). */
export function pct3(a, b, c) {
  const raw = [a, b, c].map((x) => Math.max(0, x) * 100);
  const sum = raw.reduce((s, x) => s + x, 0);
  if (!(sum > 0)) return [0, 100, 0];
  const scaled = raw.map((x) => (x / sum) * 100);
  const floors = scaled.map(Math.floor);
  let left = 100 - floors.reduce((s, x) => s + x, 0);
  const order = scaled.map((x, i) => [x - floors[i], i]).sort((u, v) => v[0] - u[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/** Uygulamaya ve asistana giden yalın biçim (yüzdeler tam sayı). */
export function forecastView(f) {
  const [home, draw, away] = pct3(f.p1, f.pX, f.p2);
  const [nextHome, nextAway, noGoal] = pct3(f.nextGoal.home, f.nextGoal.away, f.nextGoal.none);
  const r1 = (x) => Math.round(x * 100) / 100;
  return {
    probabilities: { home, draw, away },
    stay: Math.round(f.noMoreGoals * 100),
    moreGoals: 100 - Math.round(f.noMoreGoals * 100),
    nextGoal: { home: nextHome, away: nextAway, none: noGoal },
    topFinals: f.topFinals.map((x) => ({ score: x.score, pct: Math.round(x.p * 100) })),
    expected: { home: r1(f.expected.home), away: r1(f.expected.away) },
    remainingGoals: { home: r1(f.remainingGoals.home), away: r1(f.remainingGoals.away) },
    over25: Math.round(f.over25 * 100),
    btts: Math.round(f.btts * 100),
    remaining: Math.round(f.rem * 100),
    evidence: { weight: Math.round(f.rates.weight * 100), source: f.rates.source },
  };
}
