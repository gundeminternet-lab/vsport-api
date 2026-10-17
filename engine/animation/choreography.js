// Animasyon koreografisi: simülasyonun zaman çizelgesini (timeline) görsel bir maça çevirir.
//
// Çıktı tamamen DETERMİNİSTİKTİR (aynı timeline + seed = aynı animasyon) ve çizimden bağımsızdır,
// yani Canvas, React Native Skia ya da SVG ile çizilebilir.
//
// Koordinatlar normalize: x = saha boyu (0..1), y = saha eni (0..1). Ev sahibi her zaman x=1 kalesine
// atak yapar, deplasman x=0 kalesine. Saha 105 x 68 m kabul edilir.
//
// Fikir: top yolu "segmentlerden" oluşur (pas, taşıma, şut...). Her segmentin başlangıç/bitiş zamanı ve
// sahibi (hangi takım) vardır. Olaylar (gol, şut, korner, kart...) geldiğinde, olaydan ÖNCE topu o
// bölgeye taşıyan bir hücum kurulur; böylece gol, topun ağlara gittiği anda görünür.

import { createRng } from '../rng.js';
import { makeClockMap } from '../playback.js';
import { SIM } from '../config.js';

export const PITCH = { length: 105, width: 68 };
export const GOAL_HALF = 3.66 / PITCH.width; // kale ağzı yarı genişliği (normalize)
export const GOAL_MOUTH = { y0: 0.5 - GOAL_HALF, y1: 0.5 + GOAL_HALF };

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, u) => a + (b - a) * u;
export const distM = (ax, ay, bx, by) => Math.hypot((ax - bx) * PITCH.length, (ay - by) * PITCH.width);

export const other = (s) => (s === 'home' ? 'away' : 'home');
export const dirOf = (s) => (s === 'home' ? 1 : -1); // hücum yönü (x ekseninde)
export const goalX = (s) => (s === 'home' ? 1 : 0); // s takımının atak yaptığı kale çizgisi
export const worldX = (s, xa) => (s === 'home' ? xa : 1 - xa); // s takımının "hücum çerçevesi" -> dünya

// Görsel hızlar (m/sn). 90 dakika 60 saniyeye sığdığı için gerçekte olmayacak kadar hızlıdır;
// amaç "oyun gibi" akıcı görünmek.
const SPEED = { pass: 58, long: 76, carry: 24, shot: 125, build: 95, kick: 105 };
const MAX_DELAY = 0.9; // bir olay en fazla bu kadar geç gösterilir, aksi halde (önemsizse) atlanır

const EASE = {
  linear: (u) => u,
  out: (u) => 1 - (1 - u) ** 1.8,
  shot: (u) => 1 - (1 - u) ** 1.25,
  smooth: (u) => u * u * (3 - 2 * u),
};

// ---------------------------------------------------------------------------
// Top yolu örnekleyici: t anındaki top konumu, yüksekliği ve sahibi
// ---------------------------------------------------------------------------
export function sampleBall(segs, t) {
  let lo = 0;
  let hi = segs.length - 1;
  if (t <= segs[0].t0) lo = 0;
  else {
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].t0 <= t) lo = mid;
      else hi = mid - 1;
    }
  }
  const s = segs[lo];
  const span = s.t1 - s.t0;
  const u = span <= 0 ? 1 : clamp((t - s.t0) / span, 0, 1);
  const e = EASE[s.ease](u);
  return {
    x: lerp(s.x0, s.x1, e),
    y: lerp(s.y0, s.y1, e),
    z: s.arc * 4 * u * (1 - u), // 0..~1 (1 ≈ 3.5 m yükseklik gibi çizilir)
    owner: s.owner,
    kind: s.kind,
    u,
    endX: s.x1,
    endY: s.y1,
    tEnd: s.t1,
    // son "ışınlamadan" beri geçen süre: çizici topu bu sürede yumuşakça belirtir
    sinceTeleport: t - s.tp,
  };
}

class Track {
  constructor() {
    this.segs = [];
    this.t = 0;
    this.x = 0.5;
    this.y = 0.5;
    this.owner = null;
    this.lastTp = 0;
  }

  seg(kind, x1, y1, dur, { arc = 0, owner = this.owner, ease = 'out' } = {}) {
    dur = Math.max(0.02, dur);
    this.segs.push({ t0: this.t, t1: this.t + dur, x0: this.x, y0: this.y, x1, y1, arc, kind, owner, ease, tp: this.lastTp });
    this.t += dur;
    this.x = x1;
    this.y = y1;
    this.owner = owner;
  }

  hold(kind, dur, owner = this.owner) {
    this.seg(kind, this.x, this.y, dur, { owner, ease: 'linear' });
  }

  // Işınlama: top bir anda başka yere konur (devre arası, orta yuvarlak, penaltı noktası...)
  place(x, y, owner = this.owner) {
    this.lastTp = this.t;
    this.segs.push({ t0: this.t, t1: this.t, x0: x, y0: y, x1: x, y1: y, arc: 0, kind: 'place', owner, ease: 'linear', teleport: true, tp: this.t });
    this.x = x;
    this.y = y;
    this.owner = owner;
  }
}

// ---------------------------------------------------------------------------
// Timeline olaylarını "oyun anlarına" (plays) çevirir
// ---------------------------------------------------------------------------
function collectPlays(timeline, clockToReal) {
  const evs = timeline.events;
  const used = new Set();
  const plays = [];
  for (let i = 0; i < evs.length; i++) {
    if (used.has(i)) continue;
    const e = evs[i];
    const t = clockToReal(e.clock);
    switch (e.type) {
      case 'goal':
        plays.push({ kind: 'shot', outcome: 'goal', side: e.side, t, e, xg: e.xg, must: true });
        break;
      case 'var_goal_disallowed':
        plays.push({ kind: 'shot', outcome: 'var', side: e.side, t, e, xg: e.xg, must: true });
        break;
      case 'shot':
        plays.push({ kind: 'shot', outcome: e.outcome ?? 'off_target', side: e.side, t, e, xg: e.xg });
        break;
      case 'corner':
        plays.push({ kind: 'corner', side: e.side, t, e });
        break;
      case 'yellow_card':
      case 'red_card':
        plays.push({ kind: 'card', side: e.side, t, e, card: e.type === 'red_card' ? 'red' : 'yellow' });
        break;
      case 'penalty_awarded': {
        let outcome = 'goal';
        let result = null;
        for (let j = i + 1; j < Math.min(evs.length, i + 8); j++) {
          const r = evs[j];
          if (r.side === e.side && (r.type === 'goal' || r.type === 'penalty_missed') && r.clock - e.clock < 0.2) {
            used.add(j);
            result = r;
            outcome = r.type === 'goal' ? 'goal' : r.saved ? 'saved' : 'off_target';
            break;
          }
        }
        plays.push({ kind: 'penalty', outcome, side: e.side, t, e, result, must: true });
        break;
      }
      default:
        break;
    }
  }
  return plays;
}

// ---------------------------------------------------------------------------
// Ana fonksiyon
// ---------------------------------------------------------------------------
export function buildChoreography(timeline, { durationSeconds = SIM.durationSeconds, halftimeSeconds = SIM.halftimeSeconds, seed } = {}) {
  const D = durationSeconds;
  const rng = createRng(seed ?? `anim-${timeline.seed}`);
  const clockMap = makeClockMap(timeline, D, halftimeSeconds);
  const { realToClock, clockToReal, firstHalfSec } = clockMap;
  const ms = timeline.minuteStats;

  const track = new Track();
  const feed = [];
  const fx = [];
  const moments = [];
  const scoreChanges = [{ t: 0, score: { home: 0, away: 0 } }];
  // Saat çapaları: gol anlarında ekrandaki maç saati, olayın gerçek dakikasına tam oturur.
  // Aradaki saat doğrusal akar. Animasyon olaydan biraz geç kalsa bile dakika hiç kaymaz.
  const anchors = [{ t: 0, clock: 0 }];
  let firstHalfOut = firstHalfSec;

  const possHome = (t) => ms[clamp(Math.floor(realToClock(t)), 0, ms.length - 1)].possession.home / 100;
  const pressureAt = (t) => ms[clamp(Math.floor(realToClock(t)), 0, ms.length - 1)].pressure;

  const pushFeed = (e, t, extra = {}) =>
    feed.push({ t, type: e.type, side: e.side, label: e.label, text: e.text, importance: e.importance, score: e.score, ...extra });

  // ---- Boşluk doldurma: olaylar arasında orta sahada pas trafiği ------------
  const ambientStep = (left) => {
    const ph = possHome(track.t);
    let next = track.owner;
    if (next === null || rng.chance(0.26)) next = rng.chance(ph) ? 'home' : 'away';

    if (track.owner !== null && next !== track.owner) {
      // top kapma: top yakın bir noktada rakibe geçer
      track.seg('intercept', clamp(track.x + (rng.next() - 0.5) * 0.05, 0.02, 0.98), clamp(track.y + (rng.next() - 0.5) * 0.06, 0.04, 0.96), Math.min(0.22, left), { owner: next });
      return;
    }

    const pr = pressureAt(track.t) * dirOf(next); // + ise bu takım baskıda
    let tx = worldX(next, clamp(0.5 + 0.2 * pr + (rng.next() - 0.5) * 0.42, 0.1, 0.86));
    let ty = clamp(track.y + (rng.next() - 0.5) * 0.55, 0.08, 0.92);
    let kind = 'pass';
    let speed = SPEED.pass;
    let arc = 0;
    let min = 0.28;
    let max = 0.62;
    let ease = 'out';
    const r = rng.next();
    if (r > 0.8) {
      kind = 'carry';
      speed = SPEED.carry;
      tx = clamp(track.x + dirOf(next) * (0.05 + rng.next() * 0.1), 0.05, 0.95);
      ty = clamp(track.y + (rng.next() - 0.5) * 0.2, 0.08, 0.92);
      min = 0.34;
      max = 0.7;
      ease = 'linear';
    } else if (r > 0.62) {
      speed = SPEED.long;
      arc = 0.5;
      min = 0.42;
      max = 0.8;
    }
    const d = clamp(distM(track.x, track.y, tx, ty) / speed, min, max);
    track.seg(kind, tx, ty, Math.min(d, left), { owner: next, arc, ease });
  };

  const ambient = (until) => {
    let guard = 0;
    while (until - track.t > 0.34 && guard++ < 300) ambientStep(until - track.t);
    if (until - track.t > 0.01) track.hold('control', until - track.t);
  };

  // ---- Hücum kurulumu: topu atış noktasına birkaç pasla taşır ----------------
  const needBuild = (side, to) => (track.owner !== side ? 0.2 : 0) + clamp(distM(track.x, track.y, to.x, to.y) / SPEED.build, 0.22, 1.3);

  const buildUp = (side, to, endT) => {
    if (track.owner !== side) {
      track.seg('intercept', clamp(track.x + (rng.next() - 0.5) * 0.05, 0.02, 0.98), clamp(track.y + (rng.next() - 0.5) * 0.06, 0.04, 0.96), 0.2, { owner: side });
    }
    const sx = track.x;
    const sy = track.y;
    const t0 = track.t;
    const span = endT - t0;
    const n = span > 0.85 ? 2 : span > 0.5 ? 1 : 0;
    for (let k = 1; k <= n; k++) {
      const u = k / (n + 1);
      const wx = clamp(lerp(sx, to.x, u) + (rng.next() - 0.5) * 0.05, 0.02, 0.98);
      const wy = clamp(lerp(sy, to.y, u) + (rng.next() - 0.5) * 0.22, 0.08, 0.92);
      track.seg('pass', wx, wy, t0 + span * u - track.t, { owner: side });
    }
    const last = endT - track.t;
    track.seg(rng.chance(0.3) ? 'carry' : 'pass', to.x, to.y, last, { owner: side, ease: 'out' });
  };

  // Sonraki olaya kalan boşluğa göre kuyruk (ölü top / kutlama) süresini kısaltır
  const tailScale = (tC, nextT, nominal) => clamp((nextT - tC - 0.45) / nominal, 0.25, 1);
  // Uzun top süresi: en az nominal süre, ama top 105 m/sn'yi geçmesin (aksi halde ekranda "ışınlanır")
  const kickDur = (tx, ty, nominal) => Math.max(0.3, nominal, distM(track.x, track.y, tx, ty) / SPEED.kick);
  const goalKick = (def, k) => {
    track.hold('goalkick_wait', Math.max(0.2, 0.28 * k), def);
    const tx = worldX(def, 0.4 + rng.next() * 0.15);
    const ty = clamp(0.2 + rng.next() * 0.6, 0.1, 0.9);
    track.seg('goalkick', tx, ty, kickDur(tx, ty, 0.55 * k), { arc: 0.8, owner: def });
  };

  const shotTarget = (outcome, side, sp) => {
    const gx = goalX(side);
    const da = dirOf(side);
    const arc = 0.12 + rng.next() * 0.28;
    switch (outcome) {
      case 'goal':
      case 'var': {
        const yy = rng.chance(0.7) ? (rng.chance(0.5) ? GOAL_MOUTH.y0 + 0.015 : GOAL_MOUTH.y1 - 0.015) : 0.5 + (rng.next() - 0.5) * 0.05;
        return { x: gx + da * 0.014, y: yy, arc };
      }
      case 'saved':
        return { x: gx - da * 0.02, y: 0.5 + (rng.next() - 0.5) * 0.1, arc };
      case 'blocked': {
        const f = 0.18 + rng.next() * 0.14;
        return { x: lerp(sp.x, gx, f), y: lerp(sp.y, 0.5, f), arc: 0.05 };
      }
      default: {
        const off = 0.04 + rng.next() * 0.12;
        return { x: gx + da * 0.03, y: rng.chance(0.5) ? GOAL_MOUTH.y0 - off : GOAL_MOUTH.y1 + off, arc };
      }
    }
  };

  // Şuttan sonra topun akıbeti (kurtarış, gol, auta...). moment'i doldurur.
  const afterShot = (p, target, k, moment) => {
    const side = p.side;
    const def = other(side);
    const gx = goalX(side);
    const da = dirOf(side);
    switch (p.outcome) {
      case 'goal':
      case 'var': {
        track.seg('net', target.x + da * 0.008, clamp(target.y + (rng.next() - 0.5) * 0.02, 0.4, 0.6), 0.16, { owner: null });
        if (p.outcome === 'goal') {
          const celeb = Math.max(0.5, 0.95 * k);
          track.hold('dead', celeb, null);
          moment.celebEnd = track.t;
          track.place(0.5, 0.5, def);
          track.hold('restart', Math.max(0.25, 0.3 * k), def);
        } else {
          const wait = Math.max(0.8, 1.5 * k);
          track.hold('dead', wait, null);
          moment.celebEnd = track.t;
          track.place(gx - da * 0.05, 0.5, def);
          goalKick(def, k);
        }
        break;
      }
      case 'saved': {
        if (rng.chance(0.55)) {
          track.hold('keeper', Math.max(0.2, 0.3 * k), def);
          const tx = worldX(def, 0.42 + rng.next() * 0.15);
          const ty = clamp(0.2 + rng.next() * 0.6, 0.1, 0.9);
          track.seg('goalkick', tx, ty, kickDur(tx, ty, 0.55 * k), { arc: 0.8, owner: def });
        } else {
          const sgn = rng.chance(0.5) ? 1 : -1;
          track.seg('parry', gx - da * 0.075, clamp(target.y + sgn * (0.12 + rng.next() * 0.08), 0.06, 0.94), 0.26, { arc: 0.3, owner: null });
          const tx = worldX(def, 0.3 + rng.next() * 0.1);
          const ty = clamp(0.2 + rng.next() * 0.6, 0.1, 0.9);
          track.seg('clear', tx, ty, kickDur(tx, ty, 0.4 * k), { arc: 0.7, owner: rng.chance(0.75) ? def : side });
        }
        break;
      }
      case 'blocked': {
        track.seg('deflect', clamp(target.x - da * (0.05 + rng.next() * 0.07), 0.03, 0.97), clamp(target.y + (rng.next() - 0.5) * 0.3, 0.06, 0.94), Math.max(0.2, 0.3 * k), { arc: 0.2, owner: rng.chance(0.6) ? def : null });
        break;
      }
      default: {
        track.seg('out', target.x + da * 0.02, target.y, 0.12, { owner: null });
        track.place(gx - da * 0.05, 0.5, def);
        goalKick(def, k);
      }
    }
  };

  const skip = (p) => {
    pushFeed(p.e, p.t, { skipped: true });
  };

  // ---- Şut / gol ----------------------------------------------------------
  const doShot = (p, nextT) => {
    const side = p.side;
    const gx = goalX(side);
    const da = dirOf(side);
    const xg = p.xg ?? 0.08;
    const d = lerp(0.23, 0.055, clamp(xg / 0.35, 0, 1)) + rng.next() * 0.03;
    const shotPos = { x: worldX(side, 1 - d), y: clamp(0.5 + (rng.next() - 0.5) * (xg > 0.2 ? 0.3 : 0.6), 0.1, 0.9) };
    const target = shotTarget(p.outcome, side, shotPos);
    const flight = clamp(distM(shotPos.x, shotPos.y, target.x, target.y) / SPEED.shot, 0.16, 0.34);
    const tC = Math.max(p.t, track.t + needBuild(side, shotPos) + flight);
    if (!p.must && (tC - p.t > MAX_DELAY || tC > D - 0.4)) return skip(p);

    const tShot = tC - flight;
    ambient(tShot - Math.min(tShot - track.t, 1.1));
    const tStart = track.t;
    buildUp(side, shotPos, tShot);
    track.seg('shot', target.x, target.y, flight, { arc: target.arc, ease: 'shot', owner: side });

    const nominalTail = p.outcome === 'goal' ? 1.25 : p.outcome === 'var' ? 2.0 : 0.7;
    const k = tailScale(tC, Math.min(nextT, D - 0.25), nominalTail);
    const moment = { kind: 'shot', outcome: p.outcome, side, tStart, tShot, tC, shotPos, target, celebEnd: tC };
    afterShot(p, target, k, moment);
    moment.tEnd = track.t;
    moments.push(moment);

    pushFeed(p.e, tC);
    if (p.outcome === 'goal') {
      fx.push({ type: 'goal', t: tC, dur: 2.0, side, score: p.e.score, text: p.e.text, label: p.e.label });
      scoreChanges.push({ t: tC, score: p.e.score });
      anchors.push({ t: tC, clock: p.e.clock });
    } else if (p.outcome === 'var') {
      fx.push({ type: 'var', t: tC + 0.15, dur: 1.9, side, label: p.e.label });
    }
    void gx;
    void da;
  };

  // ---- Penaltı ------------------------------------------------------------
  const doPenalty = (p, nextT) => {
    const side = p.side;
    const spot = { x: worldX(side, 1 - 0.105), y: 0.5 };
    const target = shotTarget(p.outcome, side, spot);
    const flight = 0.22;
    const setup = 0.8;
    const tAward = Math.max(p.t, track.t + 0.1);
    ambient(tAward);
    track.place(spot.x, spot.y, side);
    const tStart = track.t;
    track.hold('penalty_wait', setup, side);
    const tShot = track.t;
    track.seg('shot', target.x, target.y, flight, { arc: target.arc, ease: 'shot', owner: side });
    const tC = track.t;
    const k = tailScale(tC, Math.min(nextT, D - 0.25), p.outcome === 'goal' ? 1.25 : 0.7);
    const moment = { kind: 'penalty', outcome: p.outcome, side, tStart, tShot, tC, shotPos: spot, target, celebEnd: tC };
    afterShot(p, target, k, moment);
    moment.tEnd = track.t;
    moments.push(moment);

    pushFeed(p.e, tAward);
    fx.push({ type: 'penalty', t: tAward, dur: 1.2, side });
    if (p.result) pushFeed(p.result, tC);
    if (p.outcome === 'goal') {
      const src = p.result ?? p.e;
      fx.push({ type: 'goal', t: tC, dur: 2.0, side, score: src.score, text: src.text, label: src.label });
      scoreChanges.push({ t: tC, score: src.score });
      anchors.push({ t: tC, clock: src.clock });
    }
  };

  // ---- Korner -------------------------------------------------------------
  const doCorner = (p, nextT) => {
    const side = p.side;
    const def = other(side);
    const gx = goalX(side);
    const da = dirOf(side);
    const top = rng.chance(0.5);
    const flag = { x: gx, y: top ? 0 : 1 };
    const approach = { x: gx - da * 0.08, y: top ? 0.14 : 0.86 };
    const out = 0.2;
    const tC = Math.max(p.t, track.t + needBuild(side, approach) + out);
    if (tC - p.t > MAX_DELAY || tC > D - 0.6) return skip(p);

    const tA = tC - out;
    ambient(tA - Math.min(tA - track.t, 1.0));
    const tStart = track.t;
    buildUp(side, approach, tA);
    track.seg('out', flag.x, flag.y, out, { owner: side, arc: 0.15 });
    const k = tailScale(tC, Math.min(nextT, D - 0.25), 0.95);
    track.hold('corner_wait', Math.max(0.15, 0.24 * k), side);
    track.seg('cross', gx - da * 0.055, clamp(0.5 + (rng.next() - 0.5) * 0.14, 0.4, 0.6), 0.38, { arc: 0.95, ease: 'smooth', owner: side });
    const cx = worldX(def, 0.24 + rng.next() * 0.1);
    const cy = clamp(0.2 + rng.next() * 0.6, 0.1, 0.9);
    track.seg('clear', cx, cy, kickDur(cx, cy, 0.3 * k), { arc: 0.6, owner: rng.chance(0.78) ? def : side });
    moments.push({ kind: 'corner', side, tStart, tC, tEnd: track.t, flag, top });
    pushFeed(p.e, tC);
  };

  // ---- Kart ---------------------------------------------------------------
  const doCard = (p, nextT) => {
    const tC = Math.max(p.t, track.t + 0.05);
    if (tC - p.t > MAX_DELAY || tC > D - 0.5) return skip(p);
    ambient(tC);
    const k = tailScale(tC, Math.min(nextT, D - 0.25), 0.8);
    const dur = Math.max(0.4, 0.8 * k);
    track.hold('dead', dur, track.owner);
    moments.push({ kind: 'card', side: p.side, card: p.card, tStart: tC, tC, tEnd: track.t });
    fx.push({ type: 'card', t: tC, dur: Math.max(1.2, dur + 0.4), side: p.side, card: p.card });
    pushFeed(p.e, tC);
  };

  // ---- Devre arası --------------------------------------------------------
  let secondHalfStart = null;
  const doBreak = () => {
    const tW = Math.max(firstHalfSec, track.t + 0.05);
    ambient(tW);
    track.place(0.5, 0.5, null);
    track.hold('break', halftimeSeconds, null);
    anchors.push({ t: tW, clock: timeline.firstHalfClock }, { t: track.t, clock: timeline.firstHalfClock });
    moments.push({ kind: 'break', tStart: tW, tC: tW, tEnd: track.t });
    fx.push({ type: 'halftime', t: tW, dur: halftimeSeconds, score: { ...timeline.halftimeScore } });
    const ht = timeline.events.find((e) => e.type === 'halftime');
    if (ht) pushFeed(ht, tW);
    track.place(0.5, 0.5, 'away');
    track.hold('kickoff', 0.4, 'away');
    secondHalfStart = track.t;
  };

  // ---- Akış ---------------------------------------------------------------
  const plays = collectPlays(timeline, clockToReal);
  plays.push({ kind: 'break', t: firstHalfSec });
  plays.sort((a, b) => a.t - b.t || (a.kind === 'break' ? -1 : 0));

  track.place(0.5, 0.5, 'home');
  track.hold('kickoff', 0.45, 'home');
  const ko = timeline.events.find((e) => e.type === 'kickoff');
  if (ko) pushFeed(ko, 0);
  fx.push({ type: 'kickoff', t: 0, dur: 0.9 });

  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const nextT = i + 1 < plays.length ? plays[i + 1].t : D - 0.25;
    if (p.kind === 'break') doBreak();
    else if (p.kind === 'shot') doShot(p, nextT);
    else if (p.kind === 'penalty') doPenalty(p, nextT);
    else if (p.kind === 'corner') doCorner(p, nextT);
    else if (p.kind === 'card') doCard(p, nextT);
  }
  void secondHalfStart;

  // Final. Olaylar yoğunsa kurulan animasyon süreyi aşabilir (gol animasyonu 60. saniyeden sonraya düşer
  // ve skor yanlış biter). Bu durumda TÜM zamanlar orantılı sıkıştırılıp süreye sığdırılır.
  const END_PAD = 0.3;
  if (track.t > D - END_PAD) {
    const f = (D - END_PAD) / track.t;
    for (const s of track.segs) {
      s.t0 *= f;
      s.t1 *= f;
      s.tp *= f;
    }
    for (const m of moments) for (const k of ['tStart', 'tShot', 'tC', 'tEnd', 'celebEnd']) if (Number.isFinite(m[k])) m[k] *= f;
    for (const list of [fx, feed, scoreChanges, anchors]) for (const x of list) x.t *= f;
    track.t *= f;
    firstHalfOut *= f;
  } else {
    ambient(D - END_PAD);
  }
  if (track.t < D) track.hold('end', D - track.t);
  const ft = timeline.events.find((e) => e.type === 'fulltime');
  if (ft) pushFeed(ft, D - 0.05);
  fx.push({ type: 'fulltime', t: D - 0.25, dur: 99, score: { ...timeline.score } });
  moments.push({ kind: 'end', tStart: D - 0.25, tC: D - 0.25, tEnd: Infinity });

  anchors.push({ t: D, clock: timeline.totalClock });
  anchors.sort((a, b) => a.t - b.t);
  for (let i = 1; i < anchors.length; i++) anchors[i].clock = Math.max(anchors[i].clock, anchors[i - 1].clock);
  const clockAt = (t) => {
    if (t <= anchors[0].t) return anchors[0].clock;
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i - 1];
      const b = anchors[i];
      if (t <= b.t) return b.t === a.t ? b.clock : lerp(a.clock, b.clock, (t - a.t) / (b.t - a.t));
    }
    return anchors[anchors.length - 1].clock;
  };

  feed.sort((a, b) => a.t - b.t);
  moments.sort((a, b) => a.tStart - b.tStart);
  const segs = track.segs;

  const breakM = moments.find((m) => m.kind === 'break');

  return {
    duration: D,
    seed: rng.seed,
    clockMap,
    segs,
    moments,
    fx,
    feed,
    scoreChanges,
    anchors,
    firstHalfSec: firstHalfOut,
    ball: (t) => sampleBall(segs, t),
    // t anında EKRANDA görünen maç saati (dakika, kesirli). Goller gerçek dakikalarına oturur.
    clockAt,
    scoreAt(t) {
      let s = scoreChanges[0].score;
      for (const c of scoreChanges) if (c.t <= t) s = c.score;
      return s;
    },
    labelAt(t) {
      if (t >= D) return 'MS';
      if (breakM && t >= breakM.tStart && t < breakM.tEnd) return 'DA';
      return ms[clamp(Math.floor(clockAt(t)), 0, ms.length - 1)].label;
    },
    // Dakika istatistikleri (top hakimiyeti, şut, xG...). Maç bitince son dakikanın verisi döner.
    statsAt(t) {
      const c = clockAt(t);
      return c < 1 ? null : ms[clamp(Math.floor(c) - 1, 0, ms.length - 1)];
    },
    // t anında hangi "an" (şut, korner...) oynanıyor
    momentAt(t) {
      let best = null;
      for (const m of moments) {
        if (m.tStart <= t && t < m.tEnd && (!best || m.tStart >= best.tStart)) best = m;
      }
      return best;
    },
  };
}
