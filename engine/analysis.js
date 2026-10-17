// Analiz motoru: takımların geçmiş maçları, form, lig durumu, gol ortalamaları ve H2H verisinden
// iki takımın bu maçtaki "beklenen gol" (λ) değerlerini ve sonuç olasılıklarını hesaplar.

import { MODEL, LEAGUES } from './config.js';

const DAY = 86400000;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function leagueStrength(slug) {
  return LEAGUES[slug]?.strength ?? MODEL.unknownLeagueStrength;
}

const letter = (gf, ga) => (gf > ga ? 'G' : gf === ga ? 'B' : 'M');
const points = (gf, ga) => (gf > ga ? 3 : gf === ga ? 1 : 0);

// ---------------------------------------------------------------------------
// Takım profili: hücum/savunma gücü (1.00 = lig ortalaması), form, puan ortalaması
// ---------------------------------------------------------------------------
export function buildTeamProfile({ teamId, matches = [], tableEntry = null, leagueAvg, now = Date.now() }) {
  const k = MODEL.shrinkMatches;
  const id = String(teamId);

  const perspective = matches
    .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.timestamp <= now)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MODEL.maxMatches)
    .map((m) => {
      const isHome = String(m.homeId) === id;
      return {
        id: m.id,
        timestamp: m.timestamp,
        isHome,
        gf: isHome ? m.homeGoals : m.awayGoals,
        ga: isHome ? m.awayGoals : m.homeGoals,
      };
    });

  // Yakın tarihli ve son oynanan maçlar daha ağır basar
  let sw = 0;
  let sgf = 0;
  let sga = 0;
  perspective.forEach((m, i) => {
    const ageDays = Math.max(0, (now - m.timestamp) / DAY);
    const w = 0.5 ** (i / MODEL.halfLifeMatches) * 0.5 ** (ageDays / MODEL.halfLifeDays);
    sw += w;
    sgf += w * m.gf;
    sga += w * m.ga;
  });

  // Az maç varsa lig ortalamasına doğru çek (6-0'lık tek maç yıldız yapmasın)
  let att = (sgf + k * leagueAvg) / (sw + k);
  let def = (sga + k * leagueAvg) / (sw + k);

  if (tableEntry && tableEntry.played >= 3) {
    const tAtt = (tableEntry.gf + k * leagueAvg) / (tableEntry.played + k);
    const tDef = (tableEntry.ga + k * leagueAvg) / (tableEntry.played + k);
    const wT = perspective.length === 0 ? 1 : perspective.length < 5 ? 0.5 : MODEL.tableWeight;
    att = (1 - wT) * att + wT * tAtt;
    def = (1 - wT) * def + wT * tDef;
  }

  // Form: son 5 maç (en eskiden en yeniye)
  const last5 = perspective.slice(0, 5).reverse();
  const formPoints = last5.reduce((s, m) => s + points(m.gf, m.ga), 0);
  const formIndex = last5.length >= 3 ? formPoints / (3 * last5.length) : MODEL.formNeutral;

  const ppg =
    tableEntry && tableEntry.played >= 3
      ? tableEntry.ppg
      : perspective.length >= 3
        ? perspective.slice(0, 10).reduce((s, m) => s + points(m.gf, m.ga), 0) / Math.min(10, perspective.length)
        : null;

  return {
    id,
    attack: att / leagueAvg,
    defense: def / leagueAvg, // 1'den büyük = rakibe fazla gol verir
    goalsForPerGame: att,
    goalsAgainstPerGame: def,
    form: {
      string: last5.map((m) => letter(m.gf, m.ga)).join(''),
      points: formPoints,
      matches: last5.length,
      index: formIndex,
    },
    ppg,
    rank: tableEntry?.rank ?? null,
    played: tableEntry?.played ?? null,
    matchesUsed: perspective.length,
  };
}

// ---------------------------------------------------------------------------
// İkili geçmiş (H2H): ev sahibi takım gözünden özet
// ---------------------------------------------------------------------------
export function summarizeHeadToHead(matches = [], homeId, now = Date.now()) {
  const hid = String(homeId);
  const list = matches
    .filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals) && m.timestamp <= now)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MODEL.h2hMax);

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let sw = 0;
  let sh = 0;
  let sa = 0;
  list.forEach((m, i) => {
    const homeIsHome = String(m.homeId) === hid;
    const hg = homeIsHome ? m.homeGoals : m.awayGoals; // şu anki ev sahibinin attığı
    const ag = homeIsHome ? m.awayGoals : m.homeGoals;
    if (hg > ag) homeWins++;
    else if (hg === ag) draws++;
    else awayWins++;
    const w = 0.5 ** (i / 4);
    sw += w;
    sh += w * hg;
    sa += w * ag;
  });

  return {
    n: list.length,
    homeWins,
    draws,
    awayWins,
    homeGoalsAvg: sw > 0 ? sh / sw : null,
    awayGoalsAvg: sw > 0 ? sa / sw : null,
  };
}

// ---------------------------------------------------------------------------
// Skor olasılıkları (Poisson + Dixon-Coles düşük skor düzeltmesi)
// ---------------------------------------------------------------------------
function pmf(lambda, maxG) {
  const p = [Math.exp(-lambda)];
  for (let k = 1; k <= maxG; k++) p.push((p[k - 1] * lambda) / k);
  return p;
}

export function scoreMatrix(lh, la, rho = MODEL.dcRho, maxG = 10) {
  const ph = pmf(lh, maxG);
  const pa = pmf(la, maxG);
  const m = [];
  let total = 0;
  for (let i = 0; i <= maxG; i++) {
    m.push([]);
    for (let j = 0; j <= maxG; j++) {
      let tau = 1;
      if (i === 0 && j === 0) tau = 1 - lh * la * rho;
      else if (i === 0 && j === 1) tau = 1 + lh * rho;
      else if (i === 1 && j === 0) tau = 1 + la * rho;
      else if (i === 1 && j === 1) tau = 1 - rho;
      const p = ph[i] * pa[j] * tau;
      m[i].push(p);
      total += p;
    }
  }
  for (const row of m) for (let j = 0; j < row.length; j++) row[j] /= total;
  return m;
}

export function matchProbabilities(lh, la) {
  const m = scoreMatrix(lh, la);
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over15 = 0;
  let over25 = 0;
  let btts = 0;
  const scores = [];
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m[i].length; j++) {
      const p = m[i][j];
      if (i > j) homeWin += p;
      else if (i === j) draw += p;
      else awayWin += p;
      if (i + j >= 2) over15 += p;
      if (i + j >= 3) over25 += p;
      if (i > 0 && j > 0) btts += p;
      scores.push({ score: `${i}-${j}`, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return {
    homeWin,
    draw,
    awayWin,
    over15,
    over25,
    btts,
    topScores: scores.slice(0, 5).map((s) => ({ score: s.score, p: round(s.p, 3) })),
  };
}

// ---------------------------------------------------------------------------
// Ana fonksiyon
// ---------------------------------------------------------------------------
export function analyzeMatch({
  home, // { id, name }
  away,
  homeMatches = [],
  awayMatches = [],
  h2hMatches = [],
  homeTable = null, // parseStandings() çıktısı
  awayTable = null,
  homeLeague = null,
  awayLeague = null,
  elo = null, // { home: 1650, away: 1580 } isteğe bağlı
  neutral = false,
  now = Date.now(),
}) {
  const lgH = homeTable?.leagueAvgGoals ?? MODEL.defaultLeagueAvg;
  const lgA = awayTable?.leagueAvgGoals ?? MODEL.defaultLeagueAvg;
  const base = (lgH + lgA) / 2;

  const pH = buildTeamProfile({
    teamId: home.id,
    matches: homeMatches,
    tableEntry: homeTable?.entries.get(String(home.id)) ?? null,
    leagueAvg: lgH,
    now,
  });
  const pA = buildTeamProfile({
    teamId: away.id,
    matches: awayMatches,
    tableEntry: awayTable?.entries.get(String(away.id)) ?? null,
    leagueAvg: lgA,
    now,
  });

  // Form çarpanı: iyi formdaki takım biraz daha çok atar, biraz daha az yer
  const formMult = (p) => 1 + MODEL.formWeight * (p.form.index - MODEL.formNeutral);
  const attH = pH.attack * formMult(pH) ** MODEL.formAttackExp;
  const defH = pH.defense * formMult(pH) ** MODEL.formDefenseExp;
  const attA = pA.attack * formMult(pA) ** MODEL.formAttackExp;
  const defA = pA.defense * formMult(pA) ** MODEL.formDefenseExp;

  const ha = neutral ? 0 : MODEL.homeAdvantage;
  let lambdaHome = base * (1 + ha) * attH * defA;
  let lambdaAway = base * (1 - ha) * attA * defH;
  const factors = { base, homeAdvantage: ha };

  // Puan durumu eğilimi (puan ortalaması farkı)
  if (pH.ppg !== null && pA.ppg !== null) {
    const tilt = clamp(MODEL.tableTilt * (pH.ppg - pA.ppg), -MODEL.tableTiltMax, MODEL.tableTiltMax);
    lambdaHome *= 1 + tilt;
    lambdaAway *= 1 - tilt;
    factors.tableTilt = round(tilt, 3);
  }

  // Farklı ligler: lig gücü oranı
  if (homeLeague && awayLeague && homeLeague !== awayLeague) {
    const ratio = (leagueStrength(homeLeague) / leagueStrength(awayLeague)) ** MODEL.leagueStrengthExp;
    lambdaHome *= ratio;
    lambdaAway /= ratio;
    factors.leagueRatio = round(ratio, 3);
  }

  // İsteğe bağlı Elo
  if (elo && Number.isFinite(elo.home) && Number.isFinite(elo.away)) {
    const d = elo.home - elo.away;
    lambdaHome *= Math.exp(MODEL.eloK * d);
    lambdaAway *= Math.exp(-MODEL.eloK * d);
    factors.eloDiff = d;
  }

  // H2H: az ağırlıkla karıştır (gol ortalamalarına doğru hafifçe çek)
  const h2h = summarizeHeadToHead(h2hMatches, home.id, now);
  if (h2h.n > 0) {
    const w = Math.min(MODEL.h2hMaxWeight, MODEL.h2hWeightPerMatch * h2h.n);
    lambdaHome = (1 - w) * lambdaHome + w * h2h.homeGoalsAvg;
    lambdaAway = (1 - w) * lambdaAway + w * h2h.awayGoalsAvg;
    factors.h2hWeight = round(w, 3);
  }

  lambdaHome = clamp(lambdaHome, MODEL.lambdaMin, MODEL.lambdaMax);
  lambdaAway = clamp(lambdaAway, MODEL.lambdaMin, MODEL.lambdaMax);

  const probabilities = matchProbabilities(lambdaHome, lambdaAway);

  const minMatches = Math.min(pH.matchesUsed, pA.matchesUsed);
  const confidence = minMatches >= 12 ? 'yüksek' : minMatches >= 5 ? 'orta' : 'düşük';

  const insights = buildInsights({ home, away, pH, pA, h2h, lambdaHome, lambdaAway, probabilities, neutral });

  return {
    home: { id: String(home.id), name: home.name, profile: pH },
    away: { id: String(away.id), name: away.name, profile: pA },
    lambdaHome: round(lambdaHome, 3),
    lambdaAway: round(lambdaAway, 3),
    probabilities,
    h2h,
    factors,
    insights,
    dataQuality: {
      homeMatches: pH.matchesUsed,
      awayMatches: pA.matchesUsed,
      h2hMatches: h2h.n,
      tableAvailable: Boolean(homeTable && awayTable),
      confidence,
    },
  };
}

function buildInsights({ home, away, pH, pA, h2h, lambdaHome, lambdaAway, probabilities: pr, neutral }) {
  const out = [];
  const pct = (x) => `%${Math.round(x * 100)}`;
  const form = (p) => (p.form.matches ? `${p.form.string} (${p.form.points}/${p.form.matches * 3} puan)` : 'veri yok');

  out.push(`Form — ${home.name}: ${form(pH)} | ${away.name}: ${form(pA)}`);
  out.push(
    `Gol ortalaması (ağırlıklı) — ${home.name}: attığı ${round(pH.goalsForPerGame)} / yediği ${round(pH.goalsAgainstPerGame)} | ` +
      `${away.name}: attığı ${round(pA.goalsForPerGame)} / yediği ${round(pA.goalsAgainstPerGame)}`,
  );
  if (pH.rank && pA.rank) out.push(`Lig sırası — ${home.name}: ${pH.rank}. | ${away.name}: ${pA.rank}.`);
  if (h2h.n > 0) {
    out.push(
      `Son ${h2h.n} karşılaşma — ${home.name} ${h2h.homeWins} G, ${h2h.draws} B, ${h2h.awayWins} M ` +
        `(ortalama skor ${round(h2h.homeGoalsAvg, 1)}-${round(h2h.awayGoalsAvg, 1)})`,
    );
  } else {
    out.push('İkili geçmiş verisi bulunamadı; tahmin form ve lig verisine dayanıyor.');
  }
  if (!neutral) out.push('Ev sahibi avantajı uygulandı.');
  out.push(
    `Beklenen gol: ${home.name} ${round(lambdaHome)} – ${round(lambdaAway)} ${away.name} | ` +
      `1: ${pct(pr.homeWin)}  X: ${pct(pr.draw)}  2: ${pct(pr.awayWin)}  | 2.5 üst: ${pct(pr.over25)}  KG var: ${pct(pr.btts)}`,
  );
  return out;
}
