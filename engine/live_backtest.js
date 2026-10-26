// Canlı model için yapay maçlarla karşılaştırma. Gerçek maç verisi (dakikalık şut ve gol akışı) olmadan yapılabilen
// en iyi kontrol budur; sonuçlar "yapay maçlarda" diye okunmalıdır.
//
// Üretici: her maçın GERÇEK gücü bilinir; maç öncesi model bu gücü hatalı tahmin eder (gürültü). Maç dakika dakika
// oynatılır: gol yoğunluğu zamanla artar, uzatma süresi rastgeledir, skor durumu ve kırmızı kartlar gol hızını değiştirir,
// şutlar gerçek güce göre üretilir. 30', devre arası, 60' ve 75'te üç model tahmin yapar ve maç sonucu ile ölçülür:
//   - yeni:   engine/live_model.js (tek canlı model)
//   - eski1:  asistandaki eski hesap (maç öncesi güç × kalan süre / 90, düz doğru)
//   - eski2:  canlı karttaki eski hesap (lig ortalaması 2,7 gol, şut payına göre bölünür)
// "Varsayımsız" üretici (zaman eğrisi, skor etkisi ve kırmızı kart yok) yeni modelin varsayımları tutmadığında ne
// kadar kaybettiğini gösterir.

import { createRng } from './rng.js';
import { scoreMatrix } from './analysis.js';
import { MODEL } from './config.js';
import { liveForecast, LIVE } from './live_model.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function gauss(rng) {
  const u = 1 - rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/** Eski asistan hesabı (düz kalan süre). */
export function legacyLinear(model, { minute, home, away }) {
  const rem = clamp((90 - Math.min(minute ?? 0, 90)) / 90, 0.03, 1);
  const m = scoreMatrix(model.lambdaHome * rem, model.lambdaAway * rem, MODEL.dcRho, 8, model.sigma ?? 0);
  let p1 = 0;
  let pX = 0;
  let p2 = 0;
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      const fh = home + i;
      const fa = away + j;
      if (fh > fa) p1 += m[i][j];
      else if (fh === fa) pX += m[i][j];
      else p2 += m[i][j];
    }
  }
  const s = p1 + pX + p2;
  return { p1: p1 / s, pX: pX / s, p2: p2 / s, stay: m[0][0] / s };
}

/** Eski canlı kart hesabı (lib/models/momentum.dart LiveOdds.compute). */
export function legacyCard({ minute, home, away, stats }) {
  const remaining = Math.max(0, 93 - Math.min(minute, 89)) / 90;
  const total = 2.7 * remaining;
  const hs = stats?.home ?? { shots: 0, onTarget: 0 };
  const as = stats?.away ?? { shots: 0, onTarget: 0 };
  const hw = hs.onTarget * 2 + hs.shots + 1;
  const aw = as.onTarget * 2 + as.shots + 1;
  const share = hw / (hw + aw);
  const split = clamp(0.5 + 0.6 * (share - 0.5), 0.15, 0.85);
  const lh = total * split;
  const la = total * (1 - split);
  const pmf = (l, k) => {
    let f = 1;
    for (let i = 2; i <= k; i++) f *= i;
    return (Math.exp(-l) * l ** k) / f;
  };
  let p1 = 0;
  let pX = 0;
  let p2 = 0;
  let s = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      const p = pmf(lh, i) * pmf(la, j);
      s += p;
      const fh = home + i;
      const fa = away + j;
      if (fh > fa) p1 += p;
      else if (fh === fa) pX += p;
      else p2 += p;
    }
  }
  return { p1: p1 / s, pX: pX / s, p2: p2 / s, stay: Math.exp(-total) };
}

/**
 * Bir maçı dakika dakika oynatır; checkpoints dakikalarında durumu kaydeder.
 * assume: true ise zaman eğrisi, skor etkisi ve kırmızı kart gerçekte de vardır.
 */
function playMatch(rng, truth, { assume = true, checkpoints = [30, 'HT', 60, 75] } = {}) {
  const ramp = assume ? LIVE.ramp : 0;
  const r = (t) => 1 + (ramp * t) / 90;
  const s1 = clamp(Math.round(LIVE.stoppage1 + gauss(rng) * 1.2), 0, 7);
  const s2 = clamp(Math.round(LIVE.stoppage2 + gauss(rng) * 1.8), 1, 12);
  const totalMass = 45 + (ramp * 2025) / 180 + s1 * r(45) + 45 + (ramp * (8100 - 2025)) / 180 + s2 * r(90);
  const st = { home: 0, away: 0, reds: [0, 0], shots: { home: { shots: 0, onTarget: 0 }, away: { shots: 0, onTarget: 0 } } };
  const snaps = [];
  const factors = (diff) => {
    if (!assume) return [1, 1];
    let fh = 1;
    let fa = 1;
    if (Math.abs(diff) === 1) {
      fh = diff > 0 ? LIVE.lead1 : LIVE.trail1;
      fa = diff > 0 ? LIVE.trail1 : LIVE.lead1;
    } else if (Math.abs(diff) >= 2) {
      fh = diff > 0 ? LIVE.lead2 : LIVE.trail2;
      fa = diff > 0 ? LIVE.trail2 : LIVE.lead2;
    }
    fh *= LIVE.redOwn ** Math.min(st.reds[0], 2) * LIVE.redOpp ** Math.min(st.reds[1], 2);
    fa *= LIVE.redOwn ** Math.min(st.reds[1], 2) * LIVE.redOpp ** Math.min(st.reds[0], 2);
    return [fh, fa];
  };
  const step = (t, w) => {
    const share = w / totalMass;
    const [fh, fa] = factors(st.home - st.away);
    for (const [side, lam] of [['home', truth.lh * fh * share], ['away', truth.la * fa * share]]) {
      // Şut sayısı gol hızıyla orantılı (şut başına ~0,11 gol); isabet ~%35
      const shots = rng.poisson(lam * 9);
      let sot = 0;
      for (let k = 0; k < shots; k++) if (rng.chance(0.35)) sot++;
      st.shots[side].shots += shots;
      st.shots[side].onTarget += sot;
      st[side] += rng.poisson(lam);
    }
    if (assume) {
      for (const i of [0, 1]) if (rng.chance(0.09 / 95)) st.reds[i] += 1;
    }
  };
  const snap = (label, minute, period, halftime) => {
    if (checkpoints.includes(label)) {
      snaps.push({
        label,
        minute,
        period,
        halftime,
        home: st.home,
        away: st.away,
        reds: [...st.reds],
        stats: { home: { ...st.shots.home }, away: { ...st.shots.away } },
      });
    }
  };
  for (let t = 0; t < 45; t++) {
    snap(t, t, 1, false);
    step(t, 1 + (ramp * (2 * t + 1)) / 180);
  }
  for (let k = 0; k < s1; k++) step(45 + k, r(45));
  snap('HT', 45, 1, true);
  for (let t = 45; t < 90; t++) {
    snap(t, t, 2, false);
    step(t, 1 + (ramp * (2 * t + 1)) / 180);
  }
  for (let k = 0; k < s2; k++) step(90 + k, r(90));
  return { final: [st.home, st.away], snaps };
}

const outcome = ([h, a]) => (h > a ? 0 : h === a ? 1 : 2);

/** Karşılaştırma: { label: { yeni, eski1, eski2 } } log kaybı (1-X-2) ve "skor değişmez" Brier skoru. */
export function runLiveBacktest({ n = 1500, seed = 'canli', assume = true, modelNoise = 0.2, params = null, legacy = true } = {}) {
  const rng = createRng(seed);
  const keys = ['yeni', 'eski1', 'eski2'];
  const acc = {};
  for (let g = 0; g < n; g++) {
    const lh = 1.45 * Math.exp(0.3 * gauss(rng));
    const la = 1.1 * Math.exp(0.3 * gauss(rng));
    const model = { lambdaHome: lh * Math.exp(modelNoise * gauss(rng)), lambdaAway: la * Math.exp(modelNoise * gauss(rng)), sigma: 0.15 };
    const { final, snaps } = playMatch(rng, { lh, la }, { assume });
    const y = outcome(final);
    for (const s of snaps) {
      const stayed = final[0] === s.home && final[1] === s.away ? 1 : 0;
      const f = liveForecast(model, s, params);
      const preds = {
        yeni: { p: [f.p1, f.pX, f.p2], stay: f.noMoreGoals },
        eski1: !legacy ? null : (() => {
          const o = legacyLinear(model, s);
          return { p: [o.p1, o.pX, o.p2], stay: o.stay };
        })(),
        eski2: !legacy ? null : (() => {
          const o = legacyCard(s);
          return { p: [o.p1, o.pX, o.p2], stay: o.stay };
        })(),
      };
      acc[s.label] ??= Object.fromEntries(keys.map((k) => [k, { logLoss: 0, brierStay: 0, n: 0 }]));
      for (const k of keys) {
        if (!preds[k]) continue;
        const a = acc[s.label][k];
        a.logLoss += -Math.log(clamp(preds[k].p[y], 1e-6, 1));
        a.brierStay += (preds[k].stay - stayed) ** 2;
        a.n += 1;
      }
    }
  }
  const out = {};
  for (const [label, byModel] of Object.entries(acc)) {
    out[label] = Object.fromEntries(
      Object.entries(byModel).filter(([, a]) => a.n > 0).map(([k, a]) => [k, { logLoss: a.logLoss / a.n, brierStay: a.brierStay / a.n }]),
    );
  }
  return out;
}
