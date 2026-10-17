// Maç simülatörü: analizden gelen beklenen gol (λ) değerlerini dakika dakika bir maça dönüştürür.
//
// Mantık: her takımın maç başı şut sayısı = λ / ortalama_xG. Her şutun kendi xG değeri vardır ve
// gol olma olasılığı o xG'dir. Böylece toplam beklenen gol tam olarak λ'ya eşit kalır, ama maçın
// akışı (şutlar, kurtarışlar, kornerler, kartlar, penaltılar, VAR) gerçeğe benzer. Skora göre
// tempo değişir: geride kalan takım üstüne gider, öndeki takım geri çekilir.

import { createRng } from './rng.js';
import { SIM } from './config.js';

const SIDES = ['home', 'away'];
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// xG dağılımı: çoğu şut düşük kaliteli, az sayıda büyük fırsat. Ortalaması MEAN_XG.
const XG_MIN = 0.01;
const XG_SPAN = 0.62;
const XG_EXP = 6;
export const MEAN_XG = XG_MIN + XG_SPAN / (XG_EXP + 1);
const sampleXg = (rng) => XG_MIN + XG_SPAN * rng.next() ** XG_EXP;

// Maç saati: uzatma dakikaları dahil. c = 0'dan başlayan "saat dakikası".
function buildClock(rng, fixed = null) {
  const s1 = fixed ? fixed.s1 : rng.pickWeighted([1, 2, 3, 4], [0.3, 0.4, 0.2, 0.1]);
  const s2 = fixed ? fixed.s2 : rng.pickWeighted([2, 3, 4, 5, 6, 7], [0.15, 0.25, 0.25, 0.15, 0.12, 0.08]);
  const firstHalfClock = 45 + s1;
  const total = firstHalfClock + 45 + s2;
  const slots = [];
  for (let c = 0; c < total; c++) {
    let minute;
    let extra = 0;
    if (c < 45) minute = c + 1;
    else if (c < firstHalfClock) {
      minute = 45;
      extra = c - 44;
    } else if (c < firstHalfClock + 45) minute = c - firstHalfClock + 46;
    else {
      minute = 90;
      extra = c - (firstHalfClock + 44);
    }
    slots.push({ c, minute, extra, half: c < firstHalfClock ? 1 : 2, label: extra ? `${minute}+${extra}'` : `${minute}'` });
  }
  return { slots, total, firstHalfClock };
}

function tempoOf(slot) {
  if (slot.half === 1) {
    if (slot.minute <= 10 && !slot.extra) return 0.88;
    if (slot.minute >= 38) return 1.05;
    return 1;
  }
  if (slot.extra || slot.minute >= 85) return 1.16;
  if (slot.minute >= 75) return 1.1;
  return 1.02;
}

function cardTempoOf(slot) {
  if (slot.half === 1) return slot.minute <= 15 && !slot.extra ? 0.6 : 0.95;
  return 1.25;
}

const normalise = (arr) => {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.map((x) => x / mean);
};

// Skora göre tempo: geride kalan zorlar, öndeki geri çekilir (net etkisi yaklaşık sıfır)
function stateFactor(goalDiff, slot) {
  if (goalDiff < 0) {
    const late = slot.half === 2 && slot.minute >= 70 ? 0.8 : 0;
    return 1 + 0.07 * Math.min(-goalDiff, 3) * (1 + late);
  }
  if (goalDiff > 0) return 1 - 0.05 * Math.min(goalDiff, 3);
  return 1;
}

// Skora göre tempo değişimi (geride kalan baskı yapar, öndeki geri çekilir) takımların toplam gol
// beklentisini λ'dan saptırır: zayıf takım çoğu zaman geride olduğu için hep "baskı" çarpanı alır.
// Bunu, skor farkı durumlarını dakika dakika olasılıksal yürüterek hesaplar ve her takıma bir
// ölçek katsayısı atarız; böylece oynanan maçların ortalaması λ'ya geri oturur. Sonuç önbelleğe alınır.
const scaleCache = new Map();

function calibrateScales(lam) {
  const key = `${lam.home}|${lam.away}`;
  const hit = scaleCache.get(key);
  if (hit) return hit;

  const { slots, total } = buildClock(null, { s1: 2, s2: 4 }); // ortalama uzatma düzeni
  const tempo = normalise(slots.map(tempoOf));
  const pois = (g) => {
    const p = [Math.exp(-g)];
    p.push(p[0] * g, (p[0] * g * g) / 2); // 0, 1, 2 gol (3+ ihmal edilebilir)
    return p;
  };

  const scale = { home: 1, away: 1 };
  for (let iter = 0; iter < 4; iter++) {
    let dist = new Map([[0, 1]]);
    const expected = { home: 0, away: 0 };
    for (let i = 0; i < total; i++) {
      const next = new Map();
      for (const [d, p] of dist) {
        const gH = (lam.home / total) * tempo[i] * stateFactor(d, slots[i]) * scale.home;
        const gA = (lam.away / total) * tempo[i] * stateFactor(-d, slots[i]) * scale.away;
        expected.home += p * gH;
        expected.away += p * gA;
        const pH = pois(gH);
        const pA = pois(gA);
        for (let a = 0; a <= 2; a++) {
          for (let b = 0; b <= 2; b++) {
            const nd = clamp(d + a - b, -9, 9);
            next.set(nd, (next.get(nd) ?? 0) + p * pH[a] * pA[b]);
          }
        }
      }
      dist = next;
    }
    scale.home *= lam.home / expected.home;
    scale.away *= lam.away / expected.away;
  }

  if (scaleCache.size > 500) scaleCache.clear();
  scaleCache.set(key, scale);
  return scale;
}

export function simulateMatch(analysis, { seed, rng: external } = {}) {
  const rng = external ?? createRng(seed);
  const names = { home: analysis.home.name, away: analysis.away.name };
  const ids = { home: analysis.home.id, away: analysis.away.id };
  const lam = { home: analysis.lambdaHome, away: analysis.lambdaAway };

  // Penaltılardan beklenen gol ayrılır ki toplam beklenen gol λ'da kalsın
  const penRate = {};
  const shotsPerMatch = {};
  for (const s of SIDES) {
    penRate[s] = SIM.penaltyPerTeam * Math.sqrt(lam[s] / 1.35);
    const open = Math.max(0.05, lam[s] - penRate[s] * SIM.penaltyConversion);
    shotsPerMatch[s] = open / MEAN_XG;
  }

  const scale = calibrateScales(lam);
  const { slots, total, firstHalfClock } = buildClock(rng);
  const tempo = normalise(slots.map(tempoOf));
  const cardTempo = normalise(slots.map(cardTempoOf));

  const score = { home: 0, away: 0 };
  const reds = { home: 0, away: 0 };
  const mk = () => ({ shots: 0, onTarget: 0, xg: 0, corners: 0, yellow: 0, red: 0, attacks: 0, possession: 0 });
  const stats = { home: mk(), away: mk() };
  const events = [];
  const minuteStats = [];
  let halftimeScore = { home: 0, away: 0 };

  // Anlık tabloyu olaya kopyalar
  const emit = (type, side, slot, sec, importance, text, extra = {}) => {
    events.push({
      type,
      side,
      teamId: side ? ids[side] : null,
      team: side ? names[side] : null,
      clock: slot.c + sec / 60,
      minute: slot.minute,
      extra: slot.extra,
      label: slot.label,
      importance,
      text,
      score: { ...score },
      ...extra,
    });
  };

  const pBase = clamp(0.5 + 0.17 * Math.tanh(0.9 * Math.log(lam.home / lam.away)), 0.34, 0.66);
  let drift = 0;
  let possSum = 0;

  events.push({
    type: 'kickoff', side: null, teamId: null, team: null, clock: 0, minute: 0, extra: 0, label: "0'",
    importance: 1, text: `Maç başladı: ${names.home} - ${names.away}`, score: { home: 0, away: 0 },
  });

  for (let i = 0; i < total; i++) {
    const slot = slots[i];
    const cands = [];
    const slotShots = { home: 0, away: 0 };

    for (const side of SIDES) {
      const opp = side === 'home' ? 'away' : 'home';
      const d = score[side] - score[opp];
      const redDiff = reds[side] - reds[opp];
      const men = redDiff > 0 ? Math.max(0.55, 1 - 0.2 * redDiff) : redDiff < 0 ? 1 + 0.15 * -redDiff : 1;
      const mult = tempo[i] * stateFactor(d, slot) * men * scale[side];
      const shotRate = (shotsPerMatch[side] / total) * mult;

      const nShots = rng.poisson(shotRate);
      slotShots[side] = nShots;
      for (let n = 0; n < nShots; n++) cands.push({ kind: 'shot', side, sec: rng.next() * 60 });
      for (let n = rng.poisson(shotRate * SIM.cornersPerShot); n > 0; n--) cands.push({ kind: 'corner', side, sec: rng.next() * 60 });
      for (let n = rng.poisson((penRate[side] / total) * mult); n > 0; n--) cands.push({ kind: 'penalty', side, sec: rng.next() * 60 });
      for (let n = rng.poisson((SIM.yellowPerTeam / total) * cardTempo[i]); n > 0; n--) cands.push({ kind: 'yellow', side, sec: rng.next() * 60 });
      if (reds[side] < 1) for (let n = rng.poisson(SIM.redPerTeam / total); n > 0; n--) cands.push({ kind: 'red', side, sec: rng.next() * 60 });
      stats[side].attacks += rng.poisson(shotRate * 3.4);
    }

    cands.sort((a, b) => a.sec - b.sec);

    for (const c of cands) {
      const side = c.side;
      const team = names[side];
      const scoreLine = () => `${names.home} ${score.home}-${score.away} ${names.away}`;

      if (c.kind === 'shot') {
        const xg = sampleXg(rng);
        stats[side].shots++;
        stats[side].xg += xg;
        // VAR iptallerini telafi etmek için gol denemesi biraz yükseltilir; beklenen gol korunur
        const goalChance = Math.min(0.97, xg / (1 - SIM.varDisallowChance));
        if (rng.chance(goalChance)) {
          stats[side].onTarget++;
          if (rng.chance(SIM.varDisallowChance)) {
            emit('var_goal_disallowed', side, slot, c.sec, 3, `VAR incelemesi: ${team} golü iptal edildi`, { xg });
          } else {
            score[side]++;
            emit('goal', side, slot, c.sec, 3, `GOL! ${team} — ${scoreLine()}`, { kind: 'open_play', xg });
          }
        } else {
          const r = rng.next();
          if (r < 0.26) {
            stats[side].onTarget++;
            emit('shot', side, slot, c.sec, 2, `${team} şut çekti, kaleci kurtardı`, { outcome: 'saved', xg });
          } else if (r < 0.5) {
            emit('shot', side, slot, c.sec, 1, `${team} şutu savunmadan döndü`, { outcome: 'blocked', xg });
          } else {
            emit('shot', side, slot, c.sec, 1, `${team} şutu auta gitti`, { outcome: 'off_target', xg });
          }
        }
      } else if (c.kind === 'corner') {
        stats[side].corners++;
        emit('corner', side, slot, c.sec, 1, `Korner: ${team}`);
      } else if (c.kind === 'penalty') {
        stats[side].shots++;
        stats[side].xg += SIM.penaltyConversion;
        emit('penalty_awarded', side, slot, c.sec, 3, `Penaltı! ${team}`);
        if (rng.chance(SIM.penaltyConversion)) {
          stats[side].onTarget++;
          score[side]++;
          emit('goal', side, slot, c.sec + 0.4, 3, `GOL! ${team} penaltıdan buldu — ${scoreLine()}`, { kind: 'penalty', xg: SIM.penaltyConversion });
        } else {
          const saved = rng.chance(0.6);
          if (saved) stats[side].onTarget++;
          emit('penalty_missed', side, slot, c.sec + 0.4, 3, saved ? `Penaltı kurtarıldı! ${team}` : `Penaltı kaçtı! ${team}`, { saved });
        }
      } else if (c.kind === 'yellow') {
        stats[side].yellow++;
        emit('yellow_card', side, slot, c.sec, 2, `Sarı kart: ${team}`);
      } else if (c.kind === 'red') {
        if (reds[side] >= 1) continue;
        reds[side]++;
        stats[side].red++;
        emit('red_card', side, slot, c.sec, 3, `Kırmızı kart! ${team} 10 kişi kaldı`);
      }
    }

    // Top hakimiyeti ve baskı (animasyonlu saha için "pressure": -1 deplasman, +1 ev sahibi baskısı)
    drift = 0.8 * drift + (rng.next() - 0.5) * 0.05;
    const dScore = score.home - score.away;
    const poss = clamp(pBase + drift - 0.01 * clamp(dScore, -3, 3), 0.3, 0.7);
    possSum += poss;
    const pressure = clamp((poss - 0.5) * 3.2 + (slotShots.home - slotShots.away) * 0.25, -1, 1);

    if (i === firstHalfClock - 1) halftimeScore = { ...score };

    const snap = (s) => ({
      shots: stats[s].shots,
      onTarget: stats[s].onTarget,
      xg: Math.round(stats[s].xg * 100) / 100,
      corners: stats[s].corners,
      attacks: stats[s].attacks,
    });
    minuteStats.push({
      clock: i + 1,
      label: slot.label,
      score: { ...score },
      possession: { home: Math.round(poss * 100), away: 100 - Math.round(poss * 100) },
      pressure: Math.round(pressure * 100) / 100,
      home: snap('home'),
      away: snap('away'),
    });
  }

  const endSlot = slots[total - 1];
  const halfSlot = slots[firstHalfClock - 1];
  events.push({
    type: 'halftime', side: null, teamId: null, team: null, clock: firstHalfClock, minute: 45, extra: halfSlot.extra,
    label: 'DA', importance: 2, text: `Devre arası: ${names.home} ${halftimeScore.home}-${halftimeScore.away} ${names.away}`,
    score: halftimeScore,
  });
  events.push({
    type: 'fulltime', side: null, teamId: null, team: null, clock: total, minute: 90, extra: endSlot.extra,
    label: 'MS', importance: 3, text: `Maç bitti: ${names.home} ${score.home}-${score.away} ${names.away}`,
    score: { ...score },
  });

  // Aynı anda olan olaylarda sıra: devre arası, bitiş en sonda/başta doğru yerleşsin
  const order = { kickoff: 0, halftime: 1, fulltime: 9 };
  events.sort((a, b) => a.clock - b.clock || (order[a.type] ?? 5) - (order[b.type] ?? 5));

  const poss = possSum / total;
  stats.home.possession = Math.round(poss * 100);
  stats.away.possession = 100 - stats.home.possession;
  for (const s of SIDES) stats[s].xg = Math.round(stats[s].xg * 100) / 100;

  return {
    seed: rng.seed,
    homeId: ids.home,
    awayId: ids.away,
    homeName: names.home,
    awayName: names.away,
    firstHalfClock,
    totalClock: total,
    events,
    minuteStats,
    halftimeScore,
    score: { ...score },
    stats,
    expected: { home: lam.home, away: lam.away },
  };
}

// Aynı analizle çok sayıda maç oynatıp dağılımı özetler (güven aralığı / kalibrasyon için)
export function simulateMany(analysis, n = 2000, seed = 'monte-carlo') {
  const rng = createRng(seed);
  let gh = 0;
  let ga = 0;
  let hw = 0;
  let dr = 0;
  let aw = 0;
  let over25 = 0;
  let btts = 0;
  const freq = new Map();
  for (let i = 0; i < n; i++) {
    const { score } = simulateMatch(analysis, { rng });
    gh += score.home;
    ga += score.away;
    if (score.home > score.away) hw++;
    else if (score.home === score.away) dr++;
    else aw++;
    if (score.home + score.away >= 3) over25++;
    if (score.home > 0 && score.away > 0) btts++;
    const key = `${score.home}-${score.away}`;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const topScores = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([s, c]) => ({ score: s, p: Math.round((c / n) * 1000) / 1000 }));
  return {
    n,
    avgHome: gh / n,
    avgAway: ga / n,
    homeWin: hw / n,
    draw: dr / n,
    awayWin: aw / n,
    over25: over25 / n,
    btts: btts / n,
    topScores,
  };
}
