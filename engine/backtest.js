// Geriye dönük deneme: modeli geçmiş maçlarda, her maçtan ÖNCE bilinenlerle çalıştırır ve gerçek sonuçla kıyaslar.
// Ölçüler (hepsinde düşük = iyi): RPS (sıralı 1-X-2 olasılık hatası), log kaybı, Brier.
// Ayrıca: tahmin isabeti, beraberlik oranı kalibrasyonu ve "en olası skor"un tahminle tutarlılığı.

import { MODEL } from './config.js';
import { analyzeMatch, matchProbabilities, scoresForOutcome, scoreMatrix } from './analysis.js';
import { fitRatings } from './ratings.js';
import { createRng } from './rng.js';

const DAY = 86400000;

function gauss(rng) {
  const u = 1 - rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
}

/** Gerçek gücü bilinen yapay bir lig: modelin gücü ne kadar doğru bulduğunu ölçmek için. */
export function makeSyntheticLeague({ seed = 'lig', teams = 20, seasons = 2, mu = 1.35, attSd = 0.25, defSd = 0.2, homeF = 1.17, awayF = 0.9, start = Date.UTC(2024, 7, 10) } = {}) {
  const rng = createRng(seed);
  const truth = [];
  for (let i = 0; i < teams; i++) truth.push({ id: String(100 + i), att: Math.exp(attSd * gauss(rng)), def: Math.exp(defSd * gauss(rng)) });
  const matches = [];
  let id = 1;
  for (let season = 0; season < seasons; season++) {
    const ids = truth.map((t) => t.id);
    const n = ids.length;
    const rounds = [];
    const arr = [...ids];
    for (let r = 0; r < n - 1; r++) {
      const pairs = [];
      for (let i = 0; i < n / 2; i++) pairs.push([arr[i], arr[n - 1 - i]]);
      rounds.push(pairs);
      arr.splice(1, 0, arr.pop());
    }
    const all = [...rounds, ...rounds.map((r) => r.map(([a, b]) => [b, a]))];
    all.forEach((pairs, r) => {
      const ts = start + season * 365 * DAY + r * 7 * DAY;
      for (const [h, a] of pairs) {
        const H = truth.find((t) => t.id === h);
        const A = truth.find((t) => t.id === a);
        const lh = mu * homeF * H.att * A.def;
        const la = mu * awayF * A.att * H.def;
        matches.push({ id: String(id++), timestamp: ts, homeId: h, awayId: a, homeGoals: rng.poisson(lh), awayGoals: rng.poisson(la), trueLh: lh, trueLa: la, completed: true });
      }
    });
  }
  return { matches, truth };
}

const outcomeIdx = (m) => (m.homeGoals > m.awayGoals ? 0 : m.homeGoals === m.awayGoals ? 1 : 2);

export function scoreForecast(p, actual) {
  const probs = [p.homeWin, p.draw, p.awayWin];
  const o = [0, 0, 0];
  o[actual] = 1;
  const cp = [probs[0], probs[0] + probs[1]];
  const co = [o[0], o[0] + o[1]];
  const rps = ((cp[0] - co[0]) ** 2 + (cp[1] - co[1]) ** 2) / 2;
  const logLoss = -Math.log(Math.max(1e-9, probs[actual]));
  const brier = probs.reduce((s, x, i) => s + (x - o[i]) ** 2, 0);
  return { rps, logLoss, brier };
}

/**
 * Yürüyen deneme. variants: { ad: { ratings: bool, uncertainty: bool, venueAdjust: bool } }
 * from: bu zamandan sonraki maçlar değerlendirilir; öncesi yalnızca geçmiş olarak kullanılır.
 */
export function walkForward(matches, { from, variants, refitEveryDays = 6 }) {
  const sorted = [...matches].sort((a, b) => a.timestamp - b.timestamp);
  const test = sorted.filter((m) => m.timestamp >= from);
  const results = Object.fromEntries(Object.keys(variants).map((k) => [k, { n: 0, rps: 0, logLoss: 0, brier: 0, hit: 0, drawPred: 0, scoreHit: 0, scoreConsistent: 0, favBins: Array.from({ length: 5 }, () => ({ n: 0, p: 0, win: 0 })) }]));
  let ratings = null;
  let ratingsAt = -Infinity;
  const saved = { venueAdjust: MODEL.venueAdjust };

  for (const m of test) {
    const history = sorted.filter((h) => h.timestamp < m.timestamp);
    if (history.length < 60) continue;
    if (m.timestamp - ratingsAt >= refitEveryDays * DAY) {
      ratings = fitRatings(history, { now: m.timestamp });
      ratingsAt = m.timestamp;
    }
    const lgAvg = history.reduce((s, h) => s + h.homeGoals + h.awayGoals, 0) / (2 * history.length);
    const table = { leagueAvgGoals: lgAvg, entries: new Map() };
    const mine = (id) => history.filter((h) => h.homeId === id || h.awayId === id);
    const actual = outcomeIdx(m);

    for (const [name, v] of Object.entries(variants)) {
      MODEL.venueAdjust = v.venueAdjust !== false;
      const a = analyzeMatch({
        home: { id: m.homeId, name: m.homeId },
        away: { id: m.awayId, name: m.awayId },
        homeMatches: mine(m.homeId),
        awayMatches: mine(m.awayId),
        h2hMatches: history.filter((h) => (h.homeId === m.homeId && h.awayId === m.awayId) || (h.homeId === m.awayId && h.awayId === m.homeId)),
        homeTable: table,
        awayTable: table,
        ratings: v.ratings ? ratings : null,
        uncertainty: v.uncertainty !== false,
        now: m.timestamp,
      });
      const r = results[name];
      const sc = scoreForecast(a.probabilities, actual);
      r.n++;
      r.rps += sc.rps;
      r.logLoss += sc.logLoss;
      r.brier += sc.brier;
      const pr = a.probabilities;
      const pick = pr.homeWin >= pr.draw && pr.homeWin >= pr.awayWin ? 0 : pr.awayWin >= pr.draw && pr.awayWin >= pr.homeWin ? 2 : 1;
      if (pick === actual) r.hit++;
      r.drawPred += pr.draw;
      // "En olası skor": eski yöntem tablonun zirvesi, yeni yöntem tahminle uyumlu skor
      const mat = scoreMatrix(a.lambdaHome, a.lambdaAway, MODEL.dcRho, 10, a.sigma);
      const outcome = ['1', 'X', '2'][pick];
      const top = v.consistentScore ? scoresForOutcome(mat, outcome)[0] : (() => {
        let best = { p: -1 };
        for (let i = 0; i < mat.length; i++) for (let j = 0; j < mat[i].length; j++) if (mat[i][j] > best.p) best = { home: i, away: j, p: mat[i][j] };
        return best;
      })();
      const topOutcome = top.home > top.away ? 0 : top.home === top.away ? 1 : 2;
      if (topOutcome === pick) r.scoreConsistent++;
      if (top.home === m.homeGoals && top.away === m.awayGoals) r.scoreHit++;
      // Favori güveni kalibrasyonu
      const fav = Math.max(pr.homeWin, pr.awayWin);
      const bin = r.favBins[Math.min(4, Math.max(0, Math.floor((fav - 0.3) / 0.1)))];
      bin.n++;
      bin.p += fav;
      bin.win += (pr.homeWin >= pr.awayWin ? actual === 0 : actual === 2) ? 1 : 0;
    }
  }
  MODEL.venueAdjust = saved.venueAdjust;

  for (const r of Object.values(results)) {
    const n = r.n || 1;
    r.rps /= n;
    r.logLoss /= n;
    r.brier /= n;
    r.hit /= n;
    r.drawPred /= n;
    r.scoreHit /= n;
    r.scoreConsistent /= n;
  }
  const drawActual = test.filter((m) => outcomeIdx(m) === 1).length / (test.length || 1);
  return { results, drawActual, tested: test.length };
}

export function format(report) {
  const f = (x, d = 3) => x.toFixed(d);
  const lines = [`Değerlendirilen maç: ${report.tested} · gerçekleşen beraberlik oranı: %${Math.round(report.drawActual * 100)}`, ''];
  lines.push('model'.padEnd(34) + 'RPS'.padStart(8) + 'LogKayıp'.padStart(10) + 'Brier'.padStart(8) + 'İsabet'.padStart(8) + 'X tahmin'.padStart(10) + 'Skor tutarlı'.padStart(14) + 'Skor isabet'.padStart(13));
  for (const [name, r] of Object.entries(report.results)) {
    lines.push(
      name.padEnd(34) + f(r.rps).padStart(8) + f(r.logLoss).padStart(10) + f(r.brier).padStart(8) + `%${Math.round(r.hit * 100)}`.padStart(8) + `%${Math.round(r.drawPred * 100)}`.padStart(10) + `%${Math.round(r.scoreConsistent * 100)}`.padStart(14) + `%${(r.scoreHit * 100).toFixed(1)}`.padStart(13),
    );
  }
  lines.push('', 'Favori güveni kalibrasyonu (tahmin edilen → gerçekleşen kazanma oranı):');
  for (const [name, r] of Object.entries(report.results)) {
    const cells = r.favBins
      .map((b, i) => (b.n >= 8 ? `${30 + i * 10}-${40 + i * 10}%: %${Math.round((b.p / b.n) * 100)}→%${Math.round((b.win / b.n) * 100)} (n=${b.n})` : null))
      .filter(Boolean);
    lines.push(`  ${name}: ${cells.join(' | ')}`);
  }
  return lines.join('\n');
}
