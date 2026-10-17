// Ücretli içeriklerin üretimi (Firebase'den bağımsız, saf fonksiyonlar; test edilebilir).
//
//   ai   : istatistik motorunun yazdığı maç analizi (form, gol, lig, H2H, favori, öne çıkan tercih)
//   odds : kazanabilecek bahis ihtimalleri (MS, çifte şans, KG, alt/üst, İY, en olası skorlar, adil oran)
//   sim  : 60 saniyelik simülasyon; oyuncu/top konumları kare kare hazırlanır, telefon yalnızca çizer

import { scoreMatrix } from './engine/analysis.js';
import { simulateMatch } from './engine/simulator.js';
import { buildChoreography } from './engine/animation/choreography.js';
import { buildPlayers } from './engine/animation/players.js';

export const PRICES = { ai: 50, odds: 50, sim: 100 };
export const CONTENT_VERSION = 1;

const pct = (p) => Math.round(p * 100);
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------------
// Olasılıklar
// ---------------------------------------------------------------------------------------------------
function sumMatrix(m, pred) {
  let s = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (pred(i, j)) s += m[i][j];
  return s;
}

export function markets(lambdaHome, lambdaAway) {
  const ft = scoreMatrix(lambdaHome, lambdaAway);
  // İlk yarıda gollerin ~%45'i atılır.
  const ht = scoreMatrix(lambdaHome * 0.45, lambdaAway * 0.45);
  const p = {
    ms1: sumMatrix(ft, (i, j) => i > j),
    msX: sumMatrix(ft, (i, j) => i === j),
    ms2: sumMatrix(ft, (i, j) => i < j),
    kgVar: sumMatrix(ft, (i, j) => i > 0 && j > 0),
    over15: sumMatrix(ft, (i, j) => i + j >= 2),
    over25: sumMatrix(ft, (i, j) => i + j >= 3),
    over35: sumMatrix(ft, (i, j) => i + j >= 4),
    iy1: sumMatrix(ht, (i, j) => i > j),
    iyX: sumMatrix(ht, (i, j) => i === j),
    iy2: sumMatrix(ht, (i, j) => i < j),
    iyOver05: sumMatrix(ht, (i, j) => i + j >= 1),
  };
  const scores = [];
  for (let i = 0; i < ft.length; i++) for (let j = 0; j < ft[i].length; j++) scores.push({ score: `${i}-${j}`, p: ft[i][j] });
  scores.sort((a, b) => b.p - a.p);
  return { p, topScores: scores.slice(0, 6) };
}

const fairOdd = (p) => (p > 0.01 ? Math.round((1 / p) * 100) / 100 : null);

export function buildOdds(analysis) {
  const { p, topScores } = markets(analysis.lambdaHome, analysis.lambdaAway);
  const row = (key, label, prob) => ({ key, label, pct: pct(prob), fairOdd: fairOdd(prob) });
  const groups = [
    { title: 'Maç sonucu', items: [row('ms1', 'MS 1', p.ms1), row('msX', 'MS X', p.msX), row('ms2', 'MS 2', p.ms2)] },
    {
      title: 'Çifte şans',
      items: [row('cs1X', '1-X', p.ms1 + p.msX), row('cs12', '1-2', p.ms1 + p.ms2), row('csX2', 'X-2', p.msX + p.ms2)],
    },
    { title: 'Karşılıklı gol', items: [row('kgVar', 'KG Var', p.kgVar), row('kgYok', 'KG Yok', 1 - p.kgVar)] },
    {
      title: 'Toplam gol',
      items: [
        row('o15', '1.5 Üst', p.over15),
        row('u15', '1.5 Alt', 1 - p.over15),
        row('o25', '2.5 Üst', p.over25),
        row('u25', '2.5 Alt', 1 - p.over25),
        row('o35', '3.5 Üst', p.over35),
        row('u35', '3.5 Alt', 1 - p.over35),
      ],
    },
    {
      title: 'İlk yarı',
      items: [row('iy1', 'İY 1', p.iy1), row('iyX', 'İY X', p.iyX), row('iy2', 'İY 2', p.iy2), row('iyO05', 'İY 0.5 Üst', p.iyOver05)],
    },
  ];
  // Öne çıkanlar: olasılığı en az %60 olanlardan, birbirinin aynısı olmayan en güçlü 4 tercih
  const all = groups.flatMap((g) => g.items).filter((i) => i.pct >= 60 && i.pct <= 95);
  all.sort((a, b) => b.pct - a.pct);
  return {
    groups,
    highlights: all.slice(0, 4),
    topScores: topScores.map((s) => ({ score: s.score, pct: Math.round(s.p * 1000) / 10 })),
    expectedGoals: { home: r2(analysis.lambdaHome), away: r2(analysis.lambdaAway) },
    note: 'Olasılıklar istatistik modelinden hesaplanır; adil oran = 1 / olasılık. Gerçek sonucu veya kazancı garanti etmez.',
  };
}

// ---------------------------------------------------------------------------------------------------
// AI analizi (istatistik motoru)
// ---------------------------------------------------------------------------------------------------
const formWord = (pts, n) => {
  if (!n) return 'veri yok';
  const r = pts / (3 * n);
  return r >= 0.73 ? 'çok iyi' : r >= 0.53 ? 'iyi' : r >= 0.33 ? 'orta' : 'kötü';
};

export function predictedOutcome(analysis) {
  const { homeWin, draw, awayWin } = analysis.probabilities;
  if (homeWin >= draw && homeWin >= awayWin) return '1';
  if (awayWin >= draw && awayWin >= homeWin) return '2';
  return 'X';
}

export function buildAi(analysis, { editorComment = null } = {}) {
  const H = analysis.home.name;
  const A = analysis.away.name;
  const pH = analysis.home.profile;
  const pA = analysis.away.profile;
  const pr = analysis.probabilities;
  const { p } = markets(analysis.lambdaHome, analysis.lambdaAway);
  const sections = [];

  // Genel bakış
  const gap = pr.homeWin - pr.awayWin;
  const fav =
    Math.abs(gap) < 0.08
      ? `İki takım birbirine çok yakın görünüyor (1: %${pct(pr.homeWin)}, X: %${pct(pr.draw)}, 2: %${pct(pr.awayWin)}). Beraberlik ciddi bir ihtimal.`
      : `${gap > 0 ? H : A} ${Math.abs(gap) > 0.25 ? 'açık' : 'hafif'} favori: kazanma ihtimali %${pct(gap > 0 ? pr.homeWin : pr.awayWin)}, ` +
        `beraberlik %${pct(pr.draw)}, ${gap > 0 ? A : H} %${pct(gap > 0 ? pr.awayWin : pr.homeWin)}.`;
  sections.push({ title: 'Genel bakış', text: fav });

  // Form
  sections.push({
    title: 'Form durumu',
    text:
      `${H} son ${pH.form.matches} maçta ${pH.form.points} puan topladı (${pH.form.string || '-'}; ${formWord(pH.form.points, pH.form.matches)}). ` +
      `${A} ise ${pA.form.points} puan aldı (${pA.form.string || '-'}; ${formWord(pA.form.points, pA.form.matches)}).`,
  });

  // Gol profili
  sections.push({
    title: 'Gol profili',
    text:
      `${H} maç başına ${r2(pH.goalsForPerGame)} gol atıp ${r2(pH.goalsAgainstPerGame)} gol yiyor; ` +
      `${A} ${r2(pA.goalsForPerGame)} atıp ${r2(pA.goalsAgainstPerGame)} yiyor. ` +
      `Model bu maç için ${H} ${r2(analysis.lambdaHome)} – ${r2(analysis.lambdaAway)} ${A} gol bekliyor ` +
      `(2.5 üst %${pct(p.over25)}, KG var %${pct(p.kgVar)}).`,
  });

  // Lig durumu
  if (pH.rank && pA.rank) {
    sections.push({
      title: 'Lig durumu',
      text:
        `${H} ligde ${pH.rank}. sırada (maç başı ${r2(pH.ppg ?? 0)} puan), ${A} ${pA.rank}. sırada (maç başı ${r2(pA.ppg ?? 0)} puan).`,
    });
  }

  // Aralarındaki maçlar
  const h = analysis.h2h;
  sections.push({
    title: 'Aralarındaki maçlar',
    text:
      h.n > 0
        ? `Son ${h.n} karşılaşmada ${H} ${h.homeWins} galibiyet, ${h.draws} beraberlik, ${h.awayWins} mağlubiyet aldı; ` +
          `ortalama skor ${r2(h.homeGoalsAvg)}-${r2(h.awayGoalsAvg)}.`
        : 'İki takımın yakın geçmişte karşılaşması bulunamadı; tahmin form ve lig verisine dayanıyor.',
  });

  // Öne çıkan tercih
  const odds = buildOdds(analysis);
  const best = odds.highlights[0];
  sections.push({
    title: 'Öne çıkan tercih',
    text: best
      ? `Modelin en güvendiği tercih: ${best.label} (%${best.pct}). En olası skor ${odds.topScores[0].score}.`
      : `Belirgin bir tercih yok; en olası skor ${odds.topScores[0].score}.`,
  });

  const conf = analysis.dataQuality.confidence;
  sections.push({
    title: 'Veri güveni',
    text:
      `Analiz ${analysis.dataQuality.homeMatches} + ${analysis.dataQuality.awayMatches} geçmiş maça ve ${analysis.dataQuality.h2hMatches} ikili karşılaşmaya dayanıyor. ` +
      `Güven: ${conf}.`,
  });

  return {
    pick: predictedOutcome(analysis),
    probabilities: { home: pct(pr.homeWin), draw: pct(pr.draw), away: pct(pr.awayWin) },
    topScore: odds.topScores[0].score,
    confidence: conf,
    sections,
    editorComment,
  };
}

// ---------------------------------------------------------------------------------------------------
// Simülasyon paketi
// ---------------------------------------------------------------------------------------------------
export const SIM_FPS = 10;

// Konumlar 0..65535 aralığına sıkıştırılır: x,y ∈ [-0.1, 1.1], yön açısı ∈ [-π, π], top yüksekliği ∈ [0, 1].
const qPos = (v) => Math.max(0, Math.min(65535, Math.round(((v + 0.1) / 1.2) * 65535)));
const qAng = (a) => Math.max(0, Math.min(65535, Math.round(((a + Math.PI) / (2 * Math.PI)) * 65535)));
const qZ = (z) => Math.max(0, Math.min(65535, Math.round(Math.min(1, Math.max(0, z || 0)) * 65535)));

/** Bir karedeki değer sırası: top x,y,z · 11 ev sahibi (x,y,yön) · 11 deplasman (x,y,yön) · hakem x,y  = 71 değer */
export const VALUES_PER_FRAME = 3 + 11 * 3 * 2 + 2;

export function buildSim(analysis, { seed, durationSeconds = 60 } = {}) {
  const timeline = simulateMatch(analysis, { seed });
  const choreo = buildChoreography(timeline, { durationSeconds });
  const form = (l) => (l >= 1.6 ? '4-3-3' : '4-4-2');
  const players = buildPlayers(choreo, { homeFormation: form(analysis.lambdaHome), awayFormation: form(analysis.lambdaAway) });

  const frames = Math.round(durationSeconds * SIM_FPS) + 1;
  const buf = Buffer.alloc(frames * VALUES_PER_FRAME * 2);
  let o = 0;
  const put = (v) => {
    buf.writeUInt16LE(v, o);
    o += 2;
  };
  for (let f = 0; f < frames; f++) {
    const a = players.at(f / SIM_FPS);
    put(qPos(a.ball.x));
    put(qPos(a.ball.y));
    put(qZ(a.ball.z));
    for (const side of ['home', 'away']) {
      for (const pl of a[side]) {
        put(qPos(pl.x));
        put(qPos(pl.y));
        put(qAng(pl.face ?? 0));
      }
    }
    put(qPos(a.ref.x));
    put(qPos(a.ref.y));
  }

  const showInTicker = (f) => !f.skipped || /card|penalty|var|goal/.test(f.type);
  // Saat etiketleri: 0,5 sn'de bir (ekrandaki "34'" yazısı)
  const labels = [];
  for (let t = 0; t <= durationSeconds + 1e-9; t += 0.5) {
    const l = choreo.labelAt(t);
    if (!labels.length || labels[labels.length - 1].label !== l) labels.push({ t: r2(t), label: l });
  }
  const stats = [];
  for (let s = 0; s <= durationSeconds; s++) {
    const st = choreo.statsAt(s);
    if (st) stats.push({ t: s, possession: st.possession.home, home: st.home, away: st.away });
  }

  return {
    version: CONTENT_VERSION,
    fps: SIM_FPS,
    duration: durationSeconds,
    frames,
    valuesPerFrame: VALUES_PER_FRAME,
    positions: buf.toString('base64'),
    formations: { home: players.formations.home, away: players.formations.away },
    roles: {
      home: players.slots.home.map((s) => ({ role: s.role, num: s.num })),
      away: players.slots.away.map((s) => ({ role: s.role, num: s.num })),
    },
    scores: choreo.scoreChanges.map((c) => ({ t: r2(c.t), home: c.score.home, away: c.score.away })),
    labels,
    banners: choreo.fx
      .filter((f) => ['goal', 'var', 'penalty', 'halftime', 'fulltime', 'kickoff', 'red_card', 'yellow_card'].includes(f.type))
      .map((f) => ({ type: f.type, t: r2(f.t), dur: r2(f.dur), side: f.side ?? null, score: f.score ?? null })),
    feed: choreo.feed
      .filter(showInTicker)
      .map((f) => ({ t: r2(f.t), type: f.type, side: f.side ?? null, label: f.label ?? '', text: f.text ?? '' })),
    stats,
    finalScore: { ...timeline.score },
    halftimeScore: { ...timeline.halftimeScore },
  };
}

// ---------------------------------------------------------------------------------------------------
// Sonuç karşılaştırması (maç bittikten sonra, ücretsiz)
// ---------------------------------------------------------------------------------------------------
const outcomeOf = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');

export function buildReview({ ai, sim, actual }) {
  const actualOutcome = outcomeOf(actual.home, actual.away);
  const actualScore = `${actual.home}-${actual.away}`;
  const simScore = `${sim.finalScore.home}-${sim.finalScore.away}`;
  return {
    actual: { score: actualScore, outcome: actualOutcome },
    ai: {
      pick: ai.pick,
      topScore: ai.topScore,
      outcomeHit: ai.pick === actualOutcome,
      scoreHit: ai.topScore === actualScore,
    },
    sim: {
      score: simScore,
      outcome: outcomeOf(sim.finalScore.home, sim.finalScore.away),
      outcomeHit: outcomeOf(sim.finalScore.home, sim.finalScore.away) === actualOutcome,
      scoreHit: simScore === actualScore,
    },
  };
}
