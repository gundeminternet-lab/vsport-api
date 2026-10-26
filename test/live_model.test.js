// Tek canlı model: zaman eğrisi, uzatmalar, skor ve kırmızı kart etkisi, maç içi veri, gösterim biçimi.
import test from 'node:test';
import assert from 'node:assert/strict';

import { liveForecast, forecastView, timeline, remainingDistribution, stateFactors, updatedRates, pct3, LIVE } from '../engine/live_model.js';
import { runLiveBacktest } from '../engine/live_backtest.js';
import { createRng } from '../engine/rng.js';

const model = { lambdaHome: 1.5, lambdaAway: 1.1, sigma: 0.15 };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≈ ${b}`);

test('zaman eğrisi: gollerin yaklaşık %45\'i ilk yarıda; kalan pay dakikayla azalır; uzatma hesaba katılır', () => {
  near(timeline({ minute: 0, period: 1 }).remShare, 1, 1e-9);
  const ht = timeline({ halftime: true }).remShare;
  near(1 - ht, 0.45, 0.02, 'ilk yarı payı');
  let last = 1;
  for (const [minute, period] of [[10, 1], [30, 1], [45, 1], [46, 2], [60, 2], [75, 2], [90, 2], [94, 2]]) {
    const r = timeline({ minute, period }).remShare;
    assert.ok(r <= last + 1e-9, `${minute}'`);
    last = r;
  }
  // 45+2: ilk yarının uzatması (devre 1) — ikinci yarının tamamı hâlâ önde
  assert.ok(timeline({ minute: 47, period: 1 }).remShare > ht);
  assert.ok(timeline({ minute: 47, period: 2 }).remShare < ht);
  // 90+ dakikada da az da olsa süre kalır
  assert.ok(timeline({ minute: 93, period: 2 }).remShare > 0);
  // Devre bilinmiyorsa 45'ten büyük dakika ikinci yarı sayılır
  assert.equal(timeline({ minute: 60 }).remShare, timeline({ minute: 60, period: 2 }).remShare);
});

test('60. dakika 1-0: tek en olası skor 1-0 ama "en az bir gol daha" ihtimali de gösterilir', () => {
  const f = liveForecast(model, { minute: 60, period: 2, home: 1, away: 0 });
  const v = forecastView(f);
  assert.equal(f.topFinals[0].score, '1-0');
  assert.equal(v.topFinals.length, 3);
  assert.ok(v.topFinals[0].pct >= v.topFinals[1].pct && v.topFinals[1].pct >= v.topFinals[2].pct);
  assert.ok(v.stay < 50, `skor böyle biter %${v.stay}`);
  assert.equal(v.moreGoals, 100 - v.stay);
  assert.equal(v.probabilities.home + v.probabilities.draw + v.probabilities.away, 100);
  assert.equal(v.nextGoal.home + v.nextGoal.away + v.nextGoal.none, 100);
  near(f.nextGoal.none, f.noMoreGoals, 1e-9, 'sıradaki gol "yok" = skor değişmez');
  near(f.p1 + f.pX + f.p2, 1, 1e-9);
  assert.ok(f.expected.home > 1 && f.expected.away > 0);
});

test('eşit güç, 0-0, ilk dakika: iki taraf eşit; skor etkisi simetrik', () => {
  const f = liveForecast({ lambdaHome: 1.3, lambdaAway: 1.3, sigma: 0.15 }, { minute: 0, period: 1, home: 0, away: 0 });
  near(f.p1, f.p2, 1e-9);
  near(f.nextGoal.home, f.nextGoal.away, 1e-9);
  assert.deepEqual(stateFactors(1), [LIVE.lead1, LIVE.trail1]);
  assert.deepEqual(stateFactors(-1), [LIVE.trail1, LIVE.lead1]);
});

test('geride kalan takım sıradaki golde daha şanslı; kırmızı kart gören takımın ihtimali düşer', () => {
  const eq = { lambdaHome: 1.3, lambdaAway: 1.3, sigma: 0 };
  const level = liveForecast(eq, { minute: 60, period: 2, home: 0, away: 0 });
  const behind = liveForecast(eq, { minute: 60, period: 2, home: 1, away: 0 });
  assert.ok(behind.nextGoal.away / (behind.nextGoal.away + behind.nextGoal.home) > 0.5);
  near(level.nextGoal.home, level.nextGoal.away, 1e-9);
  const full = liveForecast(model, { minute: 50, period: 2, home: 0, away: 0 });
  const red = liveForecast(model, { minute: 50, period: 2, home: 0, away: 0, reds: [1, 0] });
  assert.ok(red.p1 < full.p1 - 0.05, `${red.p1} < ${full.p1}`);
  assert.ok(red.p2 > full.p2);
});

test('maç içi veri: baskın şut üstünlüğü ihtimali artırır; veri yoksa goller az ağırlıkla sayılır', () => {
  const base = liveForecast(model, { minute: 60, period: 2, home: 0, away: 0, stats: { home: { shots: 7, onTarget: 2 }, away: { shots: 6, onTarget: 2 } } });
  const press = liveForecast(model, { minute: 60, period: 2, home: 0, away: 0, stats: { home: { shots: 16, onTarget: 8 }, away: { shots: 2, onTarget: 0 } } });
  assert.ok(press.p1 > base.p1 + 0.05);
  assert.equal(press.rates.source, 'shots');
  const goals = updatedRates(model, { elapsed: 0.5, stats: null, goals: [3, 0] });
  assert.equal(goals.source, 'goals');
  assert.ok(goals.home > model.lambdaHome && goals.home < model.lambdaHome * 1.2, 'üç gol gücü az artırır');
  // İlk dakikada güç maç öncesiyle aynı
  const start = updatedRates(model, { elapsed: 0, stats: { home: { shots: 0, onTarget: 0 }, away: { shots: 0, onTarget: 0 } } });
  assert.equal(start.home, model.lambdaHome);
  // İstatistik hiç gelmiyorsa (60. dakikada sıfır şut) şut verisi yok sayılır
  assert.equal(updatedRates(model, { elapsed: 0.6, stats: { home: { shots: 0, onTarget: 0 }, away: { shots: 0, onTarget: 0 } } }).source, 'goals');
});

test('son dakikalar: 93. dakikada 1-0 önde olan neredeyse kesin, ama süre tamamen bitmiş sayılmaz', () => {
  const f = liveForecast(model, { minute: 93, period: 2, home: 1, away: 0 });
  assert.ok(f.p1 > 0.9 && f.p1 < 1);
  assert.ok(f.noMoreGoals > 0.85 && f.noMoreGoals < 1);
});

test('dağılım doğrulaması: Markov hesabı aynı süreçten yapılan simülasyonla örtüşür', () => {
  const tl = timeline({ minute: 55, period: 2 });
  const start = { home: 1, away: 0, reds: [0, 0] };
  const d = remainingDistribution({ rateHome: 1.4, rateAway: 1.2, segments: tl.segments, ...start });
  const rng = createRng('markov');
  const total = tl.segments.reduce((s, x) => s + x.w, 0) / tl.remShare; // TOTAL_MASS
  const n = 20000;
  let stay = 0;
  let homeWins = 0;
  for (let k = 0; k < n; k++) {
    let h = start.home;
    let a = start.away;
    for (const { w } of tl.segments) {
      const [fh, fa] = stateFactors(h - a);
      const lh = 1.4 * fh * (w / total);
      const la = 1.2 * fa * (w / total);
      const u = rng.next();
      const p0 = Math.exp(-(lh + la));
      if (u >= p0) {
        if (rng.next() < lh / (lh + la)) h++;
        else a++;
      }
    }
    if (h === start.home && a === start.away) stay++;
    if (h > a) homeWins++;
  }
  near(d.m[0][0], stay / n, 0.012, 'skor değişmez');
  let p1 = 0;
  d.m.forEach((row, i) => row.forEach((p, j) => {
    if (start.home + i > start.away + j) p1 += p;
  }));
  near(p1, homeWins / n, 0.012, 'ev sahibi kazanır');
});

test('yüzde yuvarlama: üçlü toplam her zaman 100', () => {
  assert.equal(pct3(1 / 3, 1 / 3, 1 / 3).reduce((s, x) => s + x, 0), 100);
  assert.deepEqual(pct3(0.456, 0.274, 0.27), [46, 27, 27]);
  assert.deepEqual(pct3(0, 0, 0), [0, 100, 0]);
});

test('yapay maçlarda karşılaştırma: yeni model eski canlı kart hesabından iyi', () => {
  const r = runLiveBacktest({ n: 250, seed: 'test' });
  for (const label of [60, 75]) {
    assert.ok(r[label].yeni.logLoss < r[label].eski2.logLoss, `${label}: ${r[label].yeni.logLoss} < ${r[label].eski2.logLoss}`);
    assert.ok(r[label].yeni.brierStay < r[label].eski1.brierStay, `${label} skor değişmez Brier`);
  }
});
