// Kapışma maçı (saf): iki kadro stadyumda izlenen gerçek bir maç gibi oynar.
//
// Maç motoru (engine/simulator.js) gol beklentisinden dakika dakika maç üretir: şut, kurtarış, korner, kart, penaltı,
// VAR. Koreografi ve oyuncu hareketi (engine/animation) 22 oyuncunun ve topun konumunu kare kare kurar; uygulama bunu
// ücretli maç simülasyonundaki stadyumda oynatır. Golü atan, şutu çeken ve kartı gören oyuncu ANİMASYONDAKİ oyuncudur:
// ekranda topu ağlara gönderen kimse olay akışında da onun adı yazar.
//
// Taktikler gol beklentisini değiştirir (hücum > savunma > kontra > hücum). İkinci yarı farklı taktikle oynanabilir;
// motorun ilk yarı çekilişleri ikinci yarıdan bağımsız olduğundan aynı tohumla ilk yarı (skor, olaylar) birebir aynı kalır.

import { simulateMatch } from '../engine/simulator.js';
import { buildChoreography } from '../engine/animation/choreography.js';
import { buildPlayers } from '../engine/animation/players.js';
import { createRng } from '../engine/rng.js';
import { slotsOf } from './squad.js';

/** Maçın ekrandaki süresi (sn), kare hızı ve devre arası (sn). */
export const DUEL_SECONDS = 70;
export const DUEL_FPS = 10;
export const DUEL_HALFTIME = 2;

/**
 * Taktikler. att: kendi gol beklentisi çarpanı, open: rakibin gol beklentisine etkisi (savunmada açık verme).
 * Üstünlük: TACTIC_BEATS[a] === b ise a taktiği b'ye karşı gol beklentisini TACTIC_EDGE kadar artırır.
 */
export const TACTICS = {
  dengeli: { id: 'dengeli', name: 'Dengeli', att: 1, open: 1 },
  hucum: { id: 'hucum', name: 'Hücum', att: 1.22, open: 1.15 },
  kontra: { id: 'kontra', name: 'Kontra', att: 0.95, open: 0.88 },
  savunma: { id: 'savunma', name: 'Savunma', att: 0.76, open: 0.72 },
};
export const TACTIC_BEATS = { hucum: 'savunma', savunma: 'kontra', kontra: 'hucum' };
export const TACTIC_EDGE = 1.15;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

export const tacticOf = (id) => TACTICS[id] ?? TACTICS.dengeli;

/** Bir kadronun (a) rakibe (b) karşı gol beklentisi: güç farkı + taktikler. */
function lambdaOf(pa, pb, ta, tb) {
  const base = clamp(1.35 * Math.exp(0.07 * (pa - pb)), 0.25, 4);
  const edge = TACTIC_BEATS[ta] === tb ? TACTIC_EDGE : 1;
  return clamp(base * tacticOf(ta).att * tacticOf(tb).open * edge, 0.2, 4.2);
}

export function duelLambdas(pHome, pAway, tHome, tAway) {
  return { home: lambdaOf(pHome, pAway, tHome, tAway), away: lambdaOf(pAway, pHome, tAway, tHome) };
}

/** Rakibin (bot ya da başka kullanıcının kadrosu) ilk yarı taktiği. */
export function pickTactic(rng) {
  return rng.pickWeighted(['dengeli', 'hucum', 'kontra', 'savunma'], [0.4, 0.26, 0.2, 0.14]);
}

/** Rakip devre arasında skora göre plan değiştirir: geride hücum, bir farkla önde kontra, iki farkla önde savunma. */
export function adaptTactic(current, ownGoals, otherGoals) {
  const d = ownGoals - otherGoals;
  if (d < 0) return 'hucum';
  if (d >= 2) return 'savunma';
  if (d === 1) return 'kontra';
  return current;
}

// -----------------------------------------------------------------------------------------------------------------
// Diziliş: Benim 11'im yuvaları (s0..s10) animasyondaki oyunculara aynı sırayla eşlenir
// -----------------------------------------------------------------------------------------------------------------
const LINE_Y = { 1: [0.5], 2: [0.62, 0.38], 3: [0.78, 0.5, 0.22], 4: [0.86, 0.62, 0.38, 0.14], 5: [0.9, 0.7, 0.5, 0.3, 0.1] };
const BACK3_Y = [0.7, 0.5, 0.3];
const ROLE = { KL: 'GK', DEF: 'DF', OS: 'MF', FV: 'FW' };
const XA_TWEAK = { DOS: -0.04, OOS: 0.03, SLB: 0.02, SĞB: 0.02 };
const NUMS = {
  KL: [1],
  SĞB: [2],
  SLB: [3],
  STP: [4, 5, 6, 15],
  DOS: [6, 16, 5],
  MOS: [8, 10, 14, 18],
  OOS: [10, 8],
  SLO: [11, 17],
  SĞO: [7, 17],
  SLK: [11, 17],
  SĞK: [7, 17],
  SNT: [9, 19, 20],
};

/** Animasyon dizilişi: { name, slots: [{ role, xa, ya, num, pos }] } (yuva sırası kadroyla aynı). */
export function animFormation(formation) {
  const slots = slotsOf(formation) ?? slotsOf('4-4-2');
  const name = slotsOf(formation) ? formation : '4-4-2';
  const lines = name.split('-').map(Number);
  const used = new Set([1]);
  const out = [{ role: 'GK', xa: 0.04, ya: 0.5, num: 1, pos: 'KL' }];
  let k = 1;
  lines.forEach((n, li) => {
    const xa = 0.19 + (lines.length === 1 ? 0 : (li / (lines.length - 1)) * 0.45);
    const ys = li === 0 && n === 3 ? BACK3_Y : (LINE_Y[n] ?? LINE_Y[4]);
    for (let j = 0; j < n; j++, k++) {
      const s = slots[k];
      const wing = li === 0 && n === 5 && (s.pos === 'SLB' || s.pos === 'SĞB') ? 0.05 : 0;
      let num = (NUMS[s.pos] ?? []).find((x) => !used.has(x));
      for (let c = 12; num == null; c++) if (!used.has(c)) num = c;
      used.add(num);
      out.push({ role: ROLE[s.g], xa: r2(xa + (XA_TWEAK[s.pos] ?? 0) + wing), ya: ys[j] ?? 0.5, num, pos: s.pos });
    }
  });
  return { name, slots: out };
}

/** Kartın maçta saklanan kısa hâli (ad, mevki grubu, puan, kulüp, uyruk, lig, fotoğraf). */
export function compactCard(c) {
  if (!c) return null;
  return { s: c.s ?? c.n ?? '', n: c.n ?? c.s ?? '', g: c.g, r: Number(c.r ?? 60), ci: c.ci ?? c.c ?? null, na: c.na ?? null, l: c.l ?? null, ph: c.ph ?? null };
}

// -----------------------------------------------------------------------------------------------------------------
// Maç
// -----------------------------------------------------------------------------------------------------------------

/**
 * me / opp: { name, formation, power, lineup: { s0: kart, ... } }. tactics: { me1, opp1, me2?, opp2? } (2: ikinci yarı).
 * Döner: { timeline, choreo, players, feed (adlı), goals, reds, stats, ratings, motm, breakAt }.
 */
export function playDuel({ me, opp, seed, tactics, durationSeconds = DUEL_SECONDS }) {
  const l1 = duelLambdas(me.power, opp.power, tactics.me1, tactics.opp1);
  const l2 = duelLambdas(me.power, opp.power, tactics.me2 ?? tactics.me1, tactics.opp2 ?? tactics.opp1);
  const analysis = {
    home: { id: 'me', name: me.name },
    away: { id: 'opp', name: opp.name },
    lambdaHome: l1.home,
    lambdaAway: l1.away,
    secondHalf: { lambdaHome: l2.home, lambdaAway: l2.away },
  };
  const timeline = simulateMatch(analysis, { seed });
  const choreo = buildChoreography(timeline, { durationSeconds, halftimeSeconds: DUEL_HALFTIME, seed: `${seed}|anim` });
  const forms = { home: animFormation(me.formation), away: animFormation(opp.formation) };
  const players = buildPlayers(choreo, { homeFormation: forms.home, awayFormation: forms.away });

  const lineups = {
    home: slotsOf(forms.home.name).map((s) => me.lineup?.[s.key] ?? null),
    away: slotsOf(forms.away.name).map((s) => opp.lineup?.[s.key] ?? null),
  };
  const teamName = { home: me.name, away: opp.name };
  const other = (s) => (s === 'home' ? 'away' : 'home');
  const nameOf = (side, idx) => {
    const c = idx == null ? null : lineups[side][idx];
    return c ? String(c.s || c.n || '') : '';
  };

  // Oyuncu başına maç verisi (not hesabı için)
  const line = { home: lineups.home.map(() => ({ goals: 0, shots: 0, onTarget: 0, saves: 0, yellow: 0, red: 0 })), away: lineups.away.map(() => ({ goals: 0, shots: 0, onTarget: 0, saves: 0, yellow: 0, red: 0 })) };
  const near = (a, b) => Math.abs(a - b) < 0.03;
  const shotMoment = (side, t) => choreo.moments.find((m) => (m.kind === 'shot' || m.kind === 'penalty') && m.side === side && near(m.tC, t));
  const cardMoment = (side, t) => choreo.moments.find((m) => m.kind === 'card' && m.side === side && near(m.tC, t));
  const shooterOf = (side, t) => {
    const m = shotMoment(side, t);
    const idx = m?.shooter?.side === side ? m.shooter.idx : null;
    return { m, idx };
  };

  const goals = [];
  const reds = [];
  const cardRng = createRng(`${seed}|kart`);
  for (const f of choreo.feed) {
    const side = f.side;
    if (side !== 'home' && side !== 'away') continue;
    const team = teamName[side];
    const sc = f.score ? `${f.score.home}-${f.score.away}` : '';
    switch (f.type) {
      case 'goal': {
        const { m, idx } = shooterOf(side, f.t);
        const who = nameOf(side, idx);
        const pen = m?.kind === 'penalty';
        if (idx != null) {
          line[side][idx].goals++;
          line[side][idx].shots++;
          line[side][idx].onTarget++;
        }
        f.player = who || null;
        f.text = who ? `GOL! ${who}${pen ? ' (penaltı)' : ''} · ${sc}` : `GOL! ${team} · ${sc}`;
        goals.push({ side, t: r2(f.t), label: f.label, name: who || team, pen, score: f.score ? [f.score.home, f.score.away] : null });
        break;
      }
      case 'shot': {
        const { m, idx } = shooterOf(side, f.t);
        const who = nameOf(side, idx);
        const outcome = m?.outcome ?? 'off_target';
        if (idx != null) {
          line[side][idx].shots++;
          if (outcome === 'saved') line[side][idx].onTarget++;
        }
        if (outcome === 'saved') line[other(side)][0].saves++;
        if (who) {
          f.player = who;
          f.text = outcome === 'saved' ? `Kurtarış! ${who} şut çekti, kaleci çıkardı` : outcome === 'blocked' ? `${who} şut çekti, savunma engelledi` : `${who} şut çekti, top dışarıda`;
        }
        break;
      }
      case 'var_goal_disallowed': {
        const { idx } = shooterOf(side, f.t);
        const who = nameOf(side, idx);
        f.text = who ? `VAR kararı: gol iptal (${who})` : `VAR kararı: ${team} golü iptal`;
        break;
      }
      case 'penalty_missed': {
        const { idx } = shooterOf(side, f.t);
        const who = nameOf(side, idx);
        const saved = /kurtar/i.test(f.text ?? '');
        if (idx != null) line[side][idx].shots++;
        if (saved) line[other(side)][0].saves++;
        if (who) {
          f.player = who;
          f.text = saved ? `Penaltı kurtarıldı! Atan: ${who}` : `Penaltı kaçtı! Atan: ${who}`;
        }
        break;
      }
      case 'yellow_card':
      case 'red_card': {
        const m = cardMoment(side, f.t);
        // Animasyonda gösterilmeyen (sıkışık anda atlanan) kartta kartı gören rastgele bir saha oyuncusu
        const idx = m?.carded?.side === side ? m.carded.idx : cardRng.int(1, 10);
        const who = nameOf(side, idx);
        const red = f.type === 'red_card';
        if (idx != null) line[side][idx][red ? 'red' : 'yellow']++;
        if (who) {
          f.player = who;
          f.text = red ? `Kırmızı kart: ${who} · ${team} 10 kişi` : `Sarı kart: ${who} (${team})`;
        }
        if (red) reds.push({ side, t: r2(f.t), label: f.label, name: who || team });
        break;
      }
      default:
        break;
    }
  }
  // Gol bandına atan oyuncunun adı
  for (const b of choreo.fx) {
    if (b.type !== 'goal') continue;
    const g = choreo.feed.find((f) => f.type === 'goal' && f.side === b.side && near(f.t, b.t));
    if (g?.player) b.player = g.player;
  }

  // Oyuncu notları (4,0-10,0) ve maçın oyuncusu
  const score = timeline.score;
  const rng = createRng(`${seed}|notlar`);
  const ratings = {};
  for (const side of ['home', 'away']) {
    const own = score[side];
    const conceded = score[other(side)];
    const res = own > conceded ? 0.45 : own === conceded ? 0.1 : -0.25;
    ratings[side] = lineups[side].map((c, i) => {
      const x = line[side][i];
      const role = forms[side].slots[i].role;
      let v = 6.1 + (Number(c?.r ?? 65) - 70) * 0.03 + res + (rng.next() - 0.5) * 0.6;
      v += x.goals * 0.95 + x.onTarget * 0.15 + x.shots * 0.05 - x.yellow * 0.3 - x.red * 1.6;
      if (role === 'GK') v += x.saves * 0.35 - conceded * 0.3 + (conceded === 0 ? 0.6 : 0);
      if (role === 'DF') v += (conceded === 0 ? 0.45 : 0) - conceded * 0.12;
      return {
        slot: `s${i}`,
        pos: forms[side].slots[i].pos,
        num: forms[side].slots[i].num,
        name: c ? String(c.s || c.n || '') : '',
        r: Number(c?.r ?? 0),
        ph: c?.ph ?? null,
        goals: x.goals,
        rating: r1(clamp(v, 4, 10)),
      };
    });
  }
  let motm = null;
  for (const side of ['home', 'away']) {
    for (const p of ratings[side]) {
      const bonus = score[side] > score[other(side)] ? 0.05 : 0; // eşitlikte kazanan takım
      if (!motm || p.rating + bonus > motm.rating + motm.bonus) motm = { ...p, side, bonus };
    }
  }
  if (motm) delete motm.bonus;

  const s = timeline.stats;
  const stats = {
    possession: [s.home.possession, s.away.possession],
    shots: [s.home.shots, s.away.shots],
    onTarget: [s.home.onTarget, s.away.onTarget],
    xg: [r2(s.home.xg), r2(s.away.xg)],
    corners: [s.home.corners, s.away.corners],
    yellow: [s.home.yellow, s.away.yellow],
    red: [s.home.red, s.away.red],
  };
  const breakM = choreo.moments.find((m) => m.kind === 'break');
  return {
    timeline,
    choreo,
    players,
    forms,
    feed: choreo.feed,
    goals,
    reds,
    stats,
    ratings,
    motm,
    breakAt: breakM ? { start: r2(breakM.tStart), end: r2(breakM.tEnd) } : null,
    durationSeconds,
  };
}

// -----------------------------------------------------------------------------------------------------------------
// Uygulamaya giden paket (ücretli simülasyonla aynı biçim: SimPack)
// -----------------------------------------------------------------------------------------------------------------
const qPos = (v) => Math.max(0, Math.min(65535, Math.round(((v + 0.1) / 1.2) * 65535)));
const qAng = (a) => Math.max(0, Math.min(65535, Math.round(((a + Math.PI) / (2 * Math.PI)) * 65535)));
const qZ = (z) => Math.max(0, Math.min(65535, Math.round(Math.min(1, Math.max(0, z || 0)) * 65535)));
const VALUES_PER_FRAME = 3 + 11 * 3 * 2 + 2;
const BANNERS = new Set(['goal', 'var', 'penalty', 'halftime', 'fulltime', 'kickoff', 'red_card', 'yellow_card']);
const showInTicker = (f) => !f.skipped || /card|penalty|var|goal/.test(f.type);

/**
 * firstHalf: true → paket devre arasında biter (devre arası düdüğünden hemen sonra); ikinci yarı taktiği seçilince
 * bütün maçın paketi gönderilir ve uygulama ikinci yarıyı resumeAt'ten oynatır.
 */
export function packOf(match, { firstHalf = false } = {}) {
  const { players, choreo, timeline, durationSeconds } = match;
  const cut = firstHalf && match.breakAt ? Math.min(durationSeconds, match.breakAt.start + 0.35) : durationSeconds;
  const D = r2(cut);
  const frames = Math.round(D * DUEL_FPS) + 1;
  const buf = Buffer.alloc(frames * VALUES_PER_FRAME * 2);
  let o = 0;
  const put = (v) => {
    buf.writeUInt16LE(v, o);
    o += 2;
  };
  for (let f = 0; f < frames; f++) {
    const a = players.at(Math.min(D, f / DUEL_FPS));
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
  const labels = [];
  for (let t = 0; t <= D + 1e-9; t += 0.5) {
    const l = choreo.labelAt(t);
    if (!labels.length || labels[labels.length - 1].label !== l) labels.push({ t: r2(t), label: l });
  }
  const stats = [];
  for (let sec = 0; sec <= D; sec++) {
    const st = choreo.statsAt(sec);
    if (st) stats.push({ t: sec, possession: st.possession.home, home: st.home, away: st.away });
  }
  const inCut = (t) => t <= D + 1e-9;
  return {
    fps: DUEL_FPS,
    duration: D,
    frames,
    valuesPerFrame: VALUES_PER_FRAME,
    positions: buf.toString('base64'),
    formations: { home: match.forms.home.name, away: match.forms.away.name },
    roles: {
      home: match.forms.home.slots.map((s) => ({ role: s.role, num: s.num })),
      away: match.forms.away.slots.map((s) => ({ role: s.role, num: s.num })),
    },
    scores: choreo.scoreChanges.filter((c) => inCut(c.t)).map((c) => ({ t: r2(c.t), home: c.score.home, away: c.score.away })),
    labels,
    banners: choreo.fx
      .filter((f) => BANNERS.has(f.type) && inCut(f.t))
      .map((f) => ({ type: f.type, t: r2(f.t), dur: r2(f.dur), side: f.side ?? null, score: f.score ?? null, player: f.player ?? null })),
    feed: choreo.feed
      .filter((f) => showInTicker(f) && inCut(f.t))
      .map((f) => ({ t: r2(f.t), type: f.type, side: f.side ?? null, label: f.label ?? '', text: f.text ?? '', player: f.player ?? null })),
    stats,
    finalScore: firstHalf ? { ...timeline.halftimeScore } : { ...timeline.score },
    halftimeScore: { ...timeline.halftimeScore },
    partial: firstHalf,
    breakAt: match.breakAt,
    resumeAt: !firstHalf && match.breakAt ? match.breakAt.end : null,
  };
}
