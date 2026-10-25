// Simülasyon hikâyesi: AI yorumcu videosunun verisi. Maç, modelin skor dağılımından 50.000 kez örneklenir
// (maç anahtarıyla tohumlanır: aynı maç her zaman aynı sonuçları verir). Video yalnızca bu sayıları anlatır.
//
// Saklanmaz: içerikteki modelin beklenen gollerinden her istekte yeniden türetilir (küçük bir bellek önbelleğiyle).
// Böylece önceden üretilmiş içerik de değişmeden yeni videoyu alır.

import { scoreMatrix } from './engine/analysis.js';
import { MODEL } from './engine/config.js';
import { createRng } from './engine/rng.js';

export const STORY_SIMS = 50000;
export const DOT_COUNT = 1000; // video ızgarası: 1 nokta = 50 maç

const pct = (n, total) => Math.round((n / total) * 100);

/** Toplamı tam [total] olan tam sayılara böler (en büyük kalan yöntemi). */
export function apportion(values, total) {
  const sum = values.reduce((a, b) => a + b, 0) || 1;
  const raw = values.map((v) => (v / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]] += 1;
  return out;
}

/** Skor tablosundan N örnek: her skorun kaç kez çıktığı. */
export function simulateScores({ lambdaHome, lambdaAway, sigma = 0, sims = STORY_SIMS, seed }) {
  const m = scoreMatrix(lambdaHome, lambdaAway, MODEL.dcRho, 10, sigma);
  const cells = [];
  let acc = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) {
    acc += m[i][j];
    cells.push({ h: i, a: j, cum: acc });
  }
  const rng = createRng(`${seed}|story`);
  const counts = new Map();
  for (let n = 0; n < sims; n++) {
    const u = rng.next() * acc;
    let lo = 0;
    let hi = cells.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cells[mid].cum < u) lo = mid + 1;
      else hi = mid;
    }
    const key = `${cells[lo].h}-${cells[lo].a}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Hikâye verisi. Girdi: { lambdaHome, lambdaAway, sigma, homeName, awayName, seed, sims }.
 * Bütün yüzdeler aynı simülasyondan gelir; ilk gol ihtimali golsüz biten maç oranına göre modelden bölünür.
 */
export function buildStory({ lambdaHome, lambdaAway, sigma = 0, homeName: H, awayName: A, seed, sims = STORY_SIMS }) {
  const counts = simulateScores({ lambdaHome, lambdaAway, sigma, sims, seed });
  let home = 0;
  let draw = 0;
  let away = 0;
  let over15 = 0;
  let over25 = 0;
  let under35 = 0;
  let btts = 0;
  for (const [score, c] of counts) {
    const [h, a] = score.split('-').map(Number);
    if (h > a) home += c;
    else if (h === a) draw += c;
    else away += c;
    if (h + a >= 2) over15 += c;
    if (h + a >= 3) over25 += c;
    if (h + a <= 3) under35 += c;
    if (h > 0 && a > 0) btts += c;
  }
  const outcomes = { home, draw, away };
  const p = { home: pct(home, sims), draw: pct(draw, sims), away: pct(away, sims) };
  const pick = home >= draw && home >= away ? '1' : away >= draw && away >= home ? '2' : 'X';
  const topScores = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([score, c]) => ({ score, pct: pct(c, sims) }));

  // İlk gol: golsüz biten maçlar dışında, gol hızlarının oranıyla bölünür (Poisson süreçlerinde ilk golün sahibi).
  const none = (counts.get('0-0') ?? 0) / sims;
  const share = lambdaHome / (lambdaHome + lambdaAway || 1);
  const firstGoal = { home: Math.round((1 - none) * share * 100), away: Math.round((1 - none) * (1 - share) * 100), none: Math.round(none * 100) };

  const goals = { over15: pct(over15, sims), over25: pct(over25, sims), under35: pct(under35, sims), btts: pct(btts, sims) };
  const favHome = home >= away;
  const fav = favHome ? H : A;
  const favPct = favHome ? p.home : p.away;
  const firstFav = firstGoal.home >= firstGoal.away ? [H, firstGoal.home] : [A, firstGoal.away];

  // En güçlü tahminler: %50-95 arası, en yüksekten başlayarak.
  const candidates = [
    [`${H} kaybetmez`, p.home + p.draw],
    [`${A} kaybetmez`, p.away + p.draw],
    ['Beraberlik çıkmaz', p.home + p.away],
    ['En az 2 gol', goals.over15],
    [goals.over25 >= 50 ? 'En az 3 gol' : 'En fazla 2 gol', goals.over25 >= 50 ? goals.over25 : 100 - goals.over25],
    ['En fazla 3 gol', goals.under35],
    [goals.btts >= 50 ? 'İki takım da gol atar' : 'En az bir takım gol atamaz', goals.btts >= 50 ? goals.btts : 100 - goals.btts],
    [`İlk golü ${firstFav[0]} atar`, firstFav[1]],
    [`${fav} kazanır`, favPct],
  ];
  const confident = candidates
    .filter(([, v]) => v >= 50 && v <= 95)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([label, v]) => ({ label, pct: v }));

  const [dh, dd, da] = apportion([home, draw, away], DOT_COUNT);
  const grid = [0, 1, 2, 3].map((h) => [0, 1, 2, 3].map((a) => pct(counts.get(`${h}-${a}`) ?? 0, sims)));
  const pickLabel = pick === '1' ? `${H} kazanır` : pick === '2' ? `${A} kazanır` : 'Beraberlik';
  const pickPct = pick === '1' ? p.home : pick === '2' ? p.away : p.draw;

  return {
    sims,
    outcomes,
    pct: p,
    pick,
    topScores,
    goals,
    firstGoal,
    confident,
    dots: { home: dh, draw: dd, away: da },
    coin: { team: fav, pct: favPct, filled: Math.round(favPct / 10) },
    // Skor ısı haritası: satır ev sahibi golü (0-3), sütun deplasman golü (0-3); rest: bu kutunun dışındaki skorlar.
    grid,
    gridRest: Math.max(0, 100 - grid.flat().reduce((a, b) => a + b, 0)),
    // Sürpriz: kazanma ihtimali düşük olan taraf.
    upset: { team: favHome ? A : H, pct: favHome ? p.away : p.home, filled: Math.round((favHome ? p.away : p.home) / 10) },
    // Kontrol listesinin maç sonunda değerlendirilebilen biçimi (checklist ile aynı sırada).
    checks: [
      { type: 'result', value: pick },
      { type: 'score', value: topScores[0]?.score ?? null },
      { type: 'over25', value: goals.over25 >= 50 },
      { type: 'btts', value: goals.btts >= 50 },
      { type: 'firstGoal', value: firstGoal.home >= firstGoal.away ? 'home' : 'away' },
    ],
    checklist: [
      { label: `Sonuç: ${pickLabel}`, pct: pickPct },
      { label: `Skor: ${topScores[0]?.score ?? '-'}`, pct: topScores[0]?.pct ?? 0 },
      { label: goals.over25 >= 50 ? 'En az 3 gol' : 'En fazla 2 gol', pct: goals.over25 >= 50 ? goals.over25 : 100 - goals.over25 },
      { label: goals.btts >= 50 ? 'İki takım da gol atar' : 'En az bir takım gol atamaz', pct: goals.btts >= 50 ? goals.btts : 100 - goals.btts },
      { label: `İlk golü ${firstFav[0]} atar`, pct: firstFav[1] },
    ],
  };
}

const cache = new Map();

/** İçerikten hikâye (model yoksa null). Aynı maç için bellekte tutulur. */
export function storyForContent(content) {
  const m = content?.model;
  if (!m || !Number.isFinite(m.lambdaHome) || !Number.isFinite(m.lambdaAway)) return null;
  const key = `${content.key}|${m.lambdaHome}|${m.lambdaAway}|${m.sigma ?? 0}`;
  if (cache.has(key)) return cache.get(key);
  const story = buildStory({
    lambdaHome: m.lambdaHome,
    lambdaAway: m.lambdaAway,
    sigma: m.sigma ?? 0,
    homeName: content.home?.name ?? 'Ev sahibi',
    awayName: content.away?.name ?? 'Deplasman',
    seed: content.key,
  });
  if (cache.size > 300) cache.clear();
  cache.set(key, story);
  return story;
}

// ---------------------------------------------------------------------------------------------------
// Maç sonu karnesi
// ---------------------------------------------------------------------------------------------------

const outcomeOf = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');

/**
 * Maç öncesi kontrol maddelerini gerçek sonuçla karşılaştırır: true (tuttu), false (tutmadı), null (bilinmiyor).
 * firstGoal: 'home' | 'away' | null (bilinmiyor). Golsüz maçta "ilk golü X atar" tutmamış sayılır.
 */
export function evaluateChecks(checks, { home, away }, firstGoal = null) {
  return checks.map((c) => {
    switch (c.type) {
      case 'result': return outcomeOf(home, away) === c.value;
      case 'score': return c.value == null ? null : `${home}-${away}` === c.value;
      case 'over25': return (home + away >= 3) === c.value;
      case 'btts': return (home > 0 && away > 0) === c.value;
      case 'firstGoal':
        if (home + away === 0) return false;
        return firstGoal == null ? null : firstGoal === c.value;
      default: return null;
    }
  });
}

/** Sonucun maç öncesi ihtimaline göre sürpriz düzeyi. */
export function surpriseOf(pctBefore) {
  if (pctBefore >= 45) return { level: 'expected', label: 'Beklenen sonuç' };
  if (pctBefore >= 30) return { level: 'possible', label: 'Olası bir sonuç' };
  if (pctBefore >= 15) return { level: 'surprise', label: 'Sürpriz' };
  return { level: 'shock', label: 'Büyük sürpriz' };
}

/**
 * Maç sonu karnesi: aynı tohumla aynı 50.000 simülasyon yeniden kurulur; gerçek skorun kaç kez çıktığı,
 * skorlar arasındaki sırası, sonucun maç öncesi ihtimali ve kontrol listesinin sonucu.
 */
export function reviewStory({ lambdaHome, lambdaAway, sigma = 0, homeName, awayName, seed, sims = STORY_SIMS, actual, firstGoal = null }) {
  const story = buildStory({ lambdaHome, lambdaAway, sigma, homeName, awayName, seed, sims });
  const counts = simulateScores({ lambdaHome, lambdaAway, sigma, sims, seed });
  const score = `${actual.home}-${actual.away}`;
  const simCount = counts.get(score) ?? 0;
  const rank = 1 + [...counts.values()].filter((c) => c > simCount).length;
  const outcome = outcomeOf(actual.home, actual.away);
  const outcomePct = outcome === '1' ? story.pct.home : outcome === '2' ? story.pct.away : story.pct.draw;
  const marks = evaluateChecks(story.checks, actual, firstGoal);
  return {
    sims,
    home: homeName,
    away: awayName,
    score,
    simCount,
    simPct: Math.round((simCount / sims) * 1000) / 10,
    rank,
    outcome,
    outcomePct,
    pick: story.pick,
    pickHit: story.pick === outcome,
    surprise: surpriseOf(outcomePct),
    checklist: story.checklist.map((c, i) => ({ ...c, hit: marks[i] })),
    hits: marks.filter((m) => m === true).length,
    decided: marks.filter((m) => m !== null).length,
  };
}
