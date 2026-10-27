// Analiz motoru: takımların geçmiş maçları, form, lig durumu, gol ortalamaları ve H2H verisinden
// iki takımın bu maçtaki "beklenen gol" (λ) değerlerini ve sonuç olasılıklarını hesaplar.

import { MODEL, LEAGUES } from './config.js';
import { ratingLambdas, crossRatingLambdas } from './ratings.js';

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
      const ha = MODEL.homeAdvantage;
      // Evde atılan goller ev avantajıyla şişiktir; ağırlıklı ortalamalar tarafsız sahaya çevrilir.
      const f = !MODEL.venueAdjust ? 1 : isHome ? 1 + ha : 1 - ha;
      const gf = isHome ? m.homeGoals : m.awayGoals;
      const ga = isHome ? m.awayGoals : m.homeGoals;
      return {
        id: m.id,
        timestamp: m.timestamp,
        isHome,
        gf,
        ga,
        nGf: gf / f,
        nGa: ga / (2 - f),
      };
    });

  // Yakın tarihli ve son oynanan maçlar daha ağır basar
  let sw = 0;
  let sgf = 0;
  let sga = 0;
  let rgf = 0;
  let rga = 0;
  perspective.forEach((m, i) => {
    const ageDays = Math.max(0, (now - m.timestamp) / DAY);
    const w = 0.5 ** (i / MODEL.halfLifeMatches) * 0.5 ** (ageDays / MODEL.halfLifeDays);
    sw += w;
    sgf += w * m.nGf;
    sga += w * m.nGa;
    rgf += w * m.gf;
    rga += w * m.ga;
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
    // Ekranda gösterilen (ham) ağırlıklı ortalamalar; model ise sahaya göre düzeltilmiş değerleri kullanır
    goalsForPerGame: (rgf + k * leagueAvg) / (sw + k),
    goalsAgainstPerGame: (rga + k * leagueAvg) / (sw + k),
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

// Belirsizlik karışımı için 5 noktalı Gauss-Hermite düğümleri (standart normal)
const GH = [
  [-2.856970013872805, 0.011257411327720],
  [-1.355626179974266, 0.222075922005613],
  [0, 0.533333333333333],
  [1.355626179974266, 0.222075922005613],
  [2.856970013872805, 0.011257411327720],
];

/**
 * Skor olasılık tablosu. sigma > 0 ise güç farkındaki belirsizlik hesaba katılır: ev sahibi beklentisi e^(sigma*z),
 * deplasman beklentisi e^(-sigma*z) ile çarpılıp (z ~ N(0,1)) tablolar ortalanır. Ortalama beklenen gol değişmez,
 * ama kuyruk (büyük farklı skorlar, sürpriz sonuçlar) gerçekçi biçimde kalınlaşır.
 */
export function scoreMatrix(lh, la, rho = MODEL.dcRho, maxG = 10, sigma = 0) {
  if (!(sigma > 0)) return baseMatrix(lh, la, rho, maxG);
  const norm = Math.exp(-(sigma * sigma) / 2);
  let out = null;
  for (const [z, w] of GH) {
    const m = baseMatrix(lh * norm * Math.exp(sigma * z), la * norm * Math.exp(-sigma * z), rho, maxG);
    if (!out) out = m.map((row) => row.map(() => 0));
    for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) out[i][j] += w * m[i][j];
  }
  return out;
}

/**
 * Belirsizlik karışımının düğümleri: her biri { w, lh, la } (ağırlıklar toplamı 1). Yarılar gibi birleşik olasılıklar
 * hesaplanırken aynı güç farkı senaryosu iki yarıda da kullanılsın diye dışarıya açılır. sigma 0 ise tek düğüm döner.
 */
export function mixtureNodes(lh, la, sigma = 0) {
  if (!(sigma > 0)) return [{ w: 1, lh, la }];
  const norm = Math.exp(-(sigma * sigma) / 2);
  return GH.map(([z, w]) => ({ w, lh: lh * norm * Math.exp(sigma * z), la: la * norm * Math.exp(-sigma * z) }));
}

export function baseMatrix(lh, la, rho, maxG) {
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

export function matchProbabilities(lh, la, sigma = 0) {
  const m = scoreMatrix(lh, la, MODEL.dcRho, 10, sigma);
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

const outcomeOfScore = (i, j) => (i > j ? '1' : i < j ? '2' : 'X');

/**
 * Tahmin edilen sonuçla (1/X/2) uyumlu skor adayları, olasılığa göre sıralı. "En olası skor" tüm tablonun zirvesi değil,
 * tahminle çelişmeyen en olası skordur: model "ev sahibi kazanır" derken "1-1" demek tutarsızlıktır.
 */
export function scoresForOutcome(matrix, outcome) {
  const list = [];
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      if (outcomeOfScore(i, j) === outcome) list.push({ home: i, away: j, score: `${i}-${j}`, p: matrix[i][j] });
    }
  }
  return list.sort((a, b) => b.p - a.p);
}

/**
 * Toplam gol beklentisini ligin ortalamasına doğru çeker (totalK < 1) ve iki takım arasındaki farkı biraz açar
 * (supK > 1); log ölçeğinde. Geriye dönük testte (2017-2026, 15 lig, ~36 bin maç, haftalık yeniden kurulum) takım bazlı
 * toplam gol farkları gerçekte görülenden abartılı, güç farkı ise biraz çekingen çıktı. base: ligin bu sahadaki maç
 * başı toplam gol beklentisi.
 */
export function shapeLambdas(lh, la, base, totalK = MODEL.ratingTotalK ?? 1, supK = MODEL.ratingSupK ?? 1) {
  if (!(base > 0) || !(lh > 0) || !(la > 0) || (totalK === 1 && supK === 1)) return [lh, la];
  const total = base * ((lh + la) / base) ** totalK;
  const s = Math.log(lh / la) * supK;
  const a = total / (1 + Math.exp(s));
  return [total - a, a];
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
  ratings = null, // fitRatings() çıktısı: aynı ligdeki iki takım için lig geneli güç
  // Farklı liglerin takımları (Avrupa kupası, ulusal kupa): { home: { ratings, id, strength, league, form? }, away: {...} }
  // Her takım kendi liginin güç tablosundan değerlendirilir; lig farkı güç katsayısıyla eklenir.
  cross = null,
  neutral = false,
  uncertainty = true, // false: belirsizlik katmanı kapalı (karşılaştırma/deney için)
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

  // Aynı ligdeki iki takım: lig geneli (rakibe göre düzeltilmiş) güç varsa o kullanılır.
  // Farklı liglerin takımları: her biri kendi liginin gücüyle (cross).
  const rl = cross ? crossRatingLambdas(cross.home, cross.away, { neutral }) : ratingLambdas(ratings, home.id, away.id, { neutral });
  let lambdaHome;
  let lambdaAway;
  let factors;
  if (rl) {
    // Form: ligler arası maçta takımın kendi ligindeki son maçları (kupa maçları az ve seyrek)
    const fm = (idx) => 1 + MODEL.ratingFormWeight * ((Number.isFinite(idx) ? idx : MODEL.formNeutral) - MODEL.formNeutral);
    lambdaHome = rl.lh * fm(cross?.home?.form ?? pH.form.index);
    lambdaAway = rl.la * fm(cross?.away?.form ?? pA.form.index);
    factors = { model: cross ? 'ligler-arası' : 'lig-gücü', base: round(rl.base / 2, 3), homeAdvantage: round(rl.homeAdvantage, 3), attackHome: round(rl.home.attack, 3), defenseHome: round(rl.home.defense, 3), attackAway: round(rl.away.attack, 3), defenseAway: round(rl.away.defense, 3) };
    if (rl.newHome) factors.newHome = true;
    if (rl.newAway) factors.newAway = true;
    if (cross) {
      factors.homeLeague = cross.home.league ?? null;
      factors.awayLeague = cross.away.league ?? null;
      factors.crossKind = cross.kind ?? null;
      // Toplam gol ve güç farkı biçimlendirmesi lig farkından önce (aynı ligdeymiş gibi) uygulanır
      [lambdaHome, lambdaAway] = shapeLambdas(lambdaHome, lambdaAway, rl.base);
      lambdaHome *= rl.leagueRatio;
      lambdaAway /= rl.leagueRatio;
      factors.leagueRatio = round(rl.leagueRatio, 3);
    }
  } else {
    const ha = neutral ? 0 : MODEL.homeAdvantage;
    lambdaHome = base * (1 + ha) * attH * defA;
    lambdaAway = base * (1 - ha) * attA * defH;
    factors = { model: 'takım-geçmişi', base, homeAdvantage: ha };

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
    const w = Math.min(rl ? MODEL.ratingH2hMaxWeight : MODEL.h2hMaxWeight, MODEL.h2hWeightPerMatch * h2h.n);
    lambdaHome = (1 - w) * lambdaHome + w * h2h.homeGoalsAvg;
    lambdaAway = (1 - w) * lambdaAway + w * h2h.awayGoalsAvg;
    factors.h2hWeight = round(w, 3);
  }

  // Aynı lig: toplam gol ligin ortalamasına çekilir, güç farkı biraz açılır (geriye dönük testle ayarlı)
  if (rl && !cross) [lambdaHome, lambdaAway] = shapeLambdas(lambdaHome, lambdaAway, rl.base);

  lambdaHome = clamp(lambdaHome, MODEL.lambdaMin, MODEL.lambdaMax);
  lambdaAway = clamp(lambdaAway, MODEL.lambdaMin, MODEL.lambdaMax);

  // Güç farkı belirsizliği: etkin maç sayısı azaldıkça artar
  const effective = rl ? Math.min(rl.effHome, rl.effAway) : Math.min(pH.matchesUsed, pA.matchesUsed) * 0.55;
  // Lig geneli güç zaten ön bilgiyle düzenlenmiş: aynı ligde belirsizlik katmanı küçük tutulur (test: tam katman
  // olasılıkları gereğinden fazla ortaya çekiyordu). Ligler arası maçta lig katsayısı belirsizliği de var: tam katman.
  const uncMul = rl && !cross ? MODEL.ratingUncMul ?? 1 : 1;
  const sigma = !uncertainty ? 0 : uncMul * clamp(MODEL.uncBase + MODEL.uncScale / Math.sqrt(effective + 2), MODEL.uncMin, MODEL.uncMax);
  factors.sigma = round(sigma, 3);

  const probabilities = matchProbabilities(lambdaHome, lambdaAway, sigma);

  const minMatches = rl ? Math.min(rl.effHome, rl.effAway) : Math.min(pH.matchesUsed, pA.matchesUsed);
  const confidence = minMatches >= 12 ? 'yüksek' : minMatches >= 5 ? 'orta' : 'düşük';

  const insights = buildInsights({ home, away, pH, pA, h2h, lambdaHome, lambdaAway, probabilities, neutral });

  return {
    home: { id: String(home.id), name: home.name, profile: pH },
    away: { id: String(away.id), name: away.name, profile: pA },
    lambdaHome: round(lambdaHome, 3),
    lambdaAway: round(lambdaAway, 3),
    sigma: round(sigma, 3),
    neutral: Boolean(neutral),
    probabilities,
    h2h,
    factors,
    insights,
    dataQuality: {
      homeMatches: rl ? Math.round(rl.effHome) : pH.matchesUsed,
      awayMatches: rl ? Math.round(rl.effAway) : pA.matchesUsed,
      model: factors.model,
      h2hMatches: h2h.n,
      tableAvailable: Boolean(homeTable && awayTable),
      tableTeams: homeTable?.teamCount ?? null,
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
