// Oyuncu hareketi: koreografideki top yolundan 22 oyuncunun, kalecilerin ve hakemin konumunu üretir.
//
// Çizimden bağımsız ve TAMAMEN DETERMİNİSTİKTİR: at(t) her zaman aynı sonucu verir (geri sarılabilir).
// Koordinatlar choreography.js ile aynı: x, y normalize (0..1), ev sahibi x=1 kalesine atak yapar.
//
// Mantık (üç katman):
//  1) Diziliş: her oyuncunun bir "yeri" vardır (4-4-2, 4-3-3). Takım bloğu topu hafif gecikmeyle takip eder,
//     topa yakın oyuncular topa doğru kayar. Dengeli ve doğal görünür, top ışınlansa bile sıçramaz.
//  2) Sahneler: kick-off, gol kutlaması, penaltı, korner, kaleci uçuşu dizilişin üstüne yumuşakça bindirilir.
//  3) Topla temas: top bir oyuncuya ulaşacağında o oyuncu önceden koşuya başlar, topu alır, taşır, pas verir.
//     Pas hedefleri en yakın oyuncuya doğru kaydırılır; böylece top her zaman bir oyuncuya gider.

import { distM, other, dirOf, goalX, sampleBall } from './choreography.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (u) => {
  u = clamp(u, 0, 1);
  return u * u * (3 - 2 * u);
};
// 0 -> a'da başlar, b'ye kadar yükselir, c'ye kadar 1 kalır, d'de 0 olur
const trap = (t, a, b, c, d) => {
  if (t <= a || t >= d) return 0;
  if (t < b) return smooth((t - a) / Math.max(1e-6, b - a));
  if (t <= c) return 1;
  return 1 - smooth((t - c) / Math.max(1e-6, d - c));
};

const toWorld = (side, xa, ya) => ({ x: side === 'home' ? xa : 1 - xa, y: side === 'home' ? ya : 1 - ya });
const toAttack = (side, x, y) => ({ xa: side === 'home' ? x : 1 - x, ya: side === 'home' ? y : 1 - y });

// xa: kendi kalesinden rakip kaleye (0..1), ya: sahanın eni (0..1)
export const FORMATIONS = {
  '4-4-2': {
    slots: [
      { role: 'GK', xa: 0.04, ya: 0.5, num: 1 },
      { role: 'DF', xa: 0.2, ya: 0.14, num: 2 },
      { role: 'DF', xa: 0.18, ya: 0.38, num: 4 },
      { role: 'DF', xa: 0.18, ya: 0.62, num: 5 },
      { role: 'DF', xa: 0.2, ya: 0.86, num: 3 },
      { role: 'MF', xa: 0.42, ya: 0.12, num: 7 },
      { role: 'MF', xa: 0.4, ya: 0.38, num: 6 },
      { role: 'MF', xa: 0.4, ya: 0.62, num: 8 },
      { role: 'MF', xa: 0.42, ya: 0.88, num: 11 },
      { role: 'FW', xa: 0.62, ya: 0.38, num: 9 },
      { role: 'FW', xa: 0.62, ya: 0.62, num: 10 },
    ],
  },
  '4-3-3': {
    slots: [
      { role: 'GK', xa: 0.04, ya: 0.5, num: 1 },
      { role: 'DF', xa: 0.2, ya: 0.14, num: 2 },
      { role: 'DF', xa: 0.18, ya: 0.38, num: 4 },
      { role: 'DF', xa: 0.18, ya: 0.62, num: 5 },
      { role: 'DF', xa: 0.2, ya: 0.86, num: 3 },
      { role: 'MF', xa: 0.4, ya: 0.28, num: 8 },
      { role: 'MF', xa: 0.36, ya: 0.5, num: 6 },
      { role: 'MF', xa: 0.4, ya: 0.72, num: 10 },
      { role: 'FW', xa: 0.62, ya: 0.16, num: 7 },
      { role: 'FW', xa: 0.66, ya: 0.5, num: 9 },
      { role: 'FW', xa: 0.62, ya: 0.84, num: 11 },
    ],
  },
};

for (const f of Object.values(FORMATIONS)) {
  const ids = (role) => f.slots.map((s, i) => (s.role === role ? i : -1)).filter((i) => i >= 0);
  f.gk = 0;
  f.df = ids('DF');
  f.mf = ids('MF');
  f.fw = ids('FW');
  f.cornerTaker = f.mf[f.mf.length - 1];
  f.penaltyTaker = f.fw[0];
}

// adv: takımın top yönündeki kayma payı, lat: yanlara kayma, pull: topa doğru çekilme gücü
const ROLE = {
  GK: { adv: 0.05, lat: 0.22, pull: 0 },
  DF: { adv: 0.5, lat: 0.5, pull: 0.22 },
  MF: { adv: 0.8, lat: 0.6, pull: 0.32 },
  FW: { adv: 0.9, lat: 0.4, pull: 0.26 },
};

const RUN_SPEED = 16; // m/sn: topa koşan oyuncunun görsel hızı (oyun hızlandırıldığı için gerçekten yüksek)
const FALL = 0.35; // pastan sonra oyuncunun topu bırakma süresi
const ARRIVE_AT_END = new Set(['pass', 'cross', 'clear', 'goalkick', 'out', 'intercept', 'deflect', 'penalty_wait']);
const HOLD_LIKE = new Set(['carry', 'control', 'kickoff', 'restart', 'goalkick_wait', 'keeper', 'corner_wait', 'dead', 'end']);

// ÖNEMLİ: Pas hedefleri en yakın oyuncuya doğru kaydırıldığı için top yolu burada hafifçe değişir. Bu değişiklik
// choreo.segs'e DOKUNMAZ (yerel kopya); çizici topu her zaman buildPlayers(...).at(t).ball veya .ball(t)
// üzerinden okumalıdır ki top ile oyuncular aynı yolu görsün.
const SPEED_CAP = 118; // m/sn: kaydırma, topun görsel hızını bunun (veya özgün hızının %8 fazlasının) üstüne çıkaramaz

export function buildPlayers(choreo, { homeFormation = '4-4-2', awayFormation = '4-3-3' } = {}) {
  const { moments } = choreo;
  const segs = choreo.segs.map((s) => ({ ...s }));
  const D = choreo.duration;
  const form = { home: FORMATIONS[homeFormation], away: FORMATIONS[awayFormation] };
  const ball = (t) => sampleBall(segs, t);
  const SIDES = ['home', 'away'];

  // ---- Yumuşatılmış top ve top sahipliği ---------------------------------------------------------------
  // Topun ve sahipliğin geçmiş penceredeki ORTALAMASI (kutu filtresi) önceden toplanan kümülatif tablolardan
  // okunur. Ortalama zamanla sürekli değiştiği için, top ışınlansa ya da sahiplik anında el değiştirse bile
  // oyuncular tek karede sıçramaz; hareket birkaç yüz ms'ye yayılır.
  const H = 1 / 120;
  const NG = Math.ceil(D / H) + 2;
  const CX = new Float64Array(NG + 1);
  const CY = new Float64Array(NG + 1);
  const CP = { home: new Float64Array(NG + 1), away: new Float64Array(NG + 1) };
  for (let i = 0; i < NG; i++) {
    const b = ball(Math.min(D, i * H));
    CX[i + 1] = CX[i] + b.x * H;
    CY[i + 1] = CY[i] + b.y * H;
    for (const s of SIDES) CP[s][i + 1] = CP[s][i] + (b.owner === s ? 1 : b.owner === null ? 0.5 : 0) * H;
  }
  const cum = (arr, t) => {
    const u = clamp(t, 0, D) / H;
    const i = Math.min(NG - 1, Math.floor(u));
    return arr[i] + (arr[i + 1] - arr[i]) * (u - i);
  };
  // [t - w1, t - w0] aralığındaki ortalama top konumu
  const avgBall = (t, w0, w1) => {
    const a = clamp(t - w1, 0, D);
    const b = clamp(t - w0, 0, D);
    if (b - a < H) {
      const p = ball(b);
      return { x: p.x, y: p.y };
    }
    return { x: (cum(CX, b) - cum(CX, a)) / (b - a), y: (cum(CY, b) - cum(CY, a)) / (b - a) };
  };
  const possW = (side, t) => {
    const a = clamp(t - 1.0, 0, D);
    const b = clamp(t, 0, D);
    if (b - a < H) {
      const o = ball(b).owner;
      return o === side ? 1 : o === null ? 0.5 : 0;
    }
    return (cum(CP[side], b) - cum(CP[side], a)) / (b - a);
  };

  // ---- Sahne pencereleri ------------------------------------------------------------------------------
  const WIN = { ko: [], cel: [], pen: [], cor: [], dive: [], card: [] };
  WIN.ko.push({ a: -1, b: -0.5, c: 0.3, d: 0.7, taker: 'home' });
  for (const m of moments) {
    if ((m.kind === 'shot' || m.kind === 'penalty') && m.outcome === 'goal') {
      const ce = m.celebEnd;
      const a = m.tC + 0.05;
      const b = a + Math.min(0.7, 0.85 * (ce - m.tC)); // kutlamaya koşu: daha uzun, daha yumuşak
      const c = Math.max(b, ce - 0.3);
      WIN.cel.push({ m, a, b, c, d: c + 0.4 });
      WIN.ko.push({ a: ce - 0.85, b: ce + 0.1, c: ce + 0.3, d: ce + 0.7, taker: other(m.side) });
    }
    if (m.kind === 'shot' || m.kind === 'penalty') WIN.dive.push({ m, a: m.tShot - 0.12, b: m.tShot + 0.12, c: m.tC + 0.3, d: m.tC + 0.8 });
    if (m.kind === 'penalty') WIN.pen.push({ m, a: m.tStart - 1.0, b: m.tStart - 0.1, c: m.tC + 0.15, d: m.tC + 0.7 });
    if (m.kind === 'corner') WIN.cor.push({ m, a: m.tC - 1.5, b: m.tC - 0.4, c: m.tEnd - 0.1, d: m.tEnd + 0.5 });
    if (m.kind === 'card') WIN.card.push({ m, a: m.tC - 0.6, b: m.tC - 0.1, c: m.tEnd + 0.5, d: m.tEnd + 1.2 });
    if (m.kind === 'break') WIN.ko.push({ a: m.tStart - 0.25, b: m.tStart + 0.25, c: m.tEnd + 0.35, d: m.tEnd + 0.7, taker: 'away' });
  }

  // Aynı anda etkin olan TÜM pencereler sırayla uygulanır (üst üste binen iki korner gibi). Böylece bir
  // pencere ötekinin yerine geçerken konum sıçramaz.
  const sceneAt = (t) => {
    const out = { ko: [], cel: [], pen: [], cor: [], dive: [], card: [] };
    for (const key of Object.keys(WIN)) {
      for (const w of WIN[key]) {
        if (t <= w.a || t >= w.d) continue;
        const v = trap(t, w.a, w.b, w.c, w.d);
        if (v > 0) out[key].push({ ...w, w: v });
      }
    }
    return out;
  };

  const makeCtx = (t) => ({
    t,
    sb: avgBall(t, 0, 1.8), // takım bloğu topu yavaş takip eder
    sf: avgBall(t, 0, 0.5), // topa yakın oyuncular topa daha çabuk kayar
    poss: { home: possW('home', t), away: possW('away', t) },
    sc: sceneAt(t),
  });

  // ---- Sahne konumları (dünya koordinatı) -----------------------------------------------------------
  const koPos = (side, idx, taker) => {
    const f = form[side];
    const slot = f.slots[idx];
    if (slot.role === 'GK') return null;
    if (slot.role === 'FW') {
      const k = f.fw.indexOf(idx);
      if (side === taker) {
        if (k === 0) return { x: 0.5, y: 0.5 };
        if (k === 1) return toWorld(side, 0.482, 0.43);
        return toWorld(side, 0.45, slot.ya);
      }
      return toWorld(side, 0.4, slot.ya);
    }
    return toWorld(side, slot.xa * 0.8, slot.ya);
  };

  const scorerPos = (m, t) => {
    const b0 = ball(m.tShot);
    const gx = goalX(m.side);
    const da = dirOf(m.side);
    const cp = { x: gx - da * 0.1, y: b0.y < 0.5 ? 0.04 : 0.96 };
    const u = clamp((t - m.tC) / 0.9, 0, 1);
    const e = 1 - (1 - u) ** 2;
    return { x: lerp(b0.x, cp.x, e), y: lerp(b0.y, cp.y, e) };
  };

  const celPos = (side, idx, w, t) => {
    const m = w.m;
    if (side !== m.side || idx === 0 || !m.shooter) return null;
    const sp = scorerPos(m, t);
    if (idx === m.shooter.idx) return { ...sp, k: 1 };
    const ang = idx * 2.399;
    return { x: sp.x + (Math.cos(ang) * 2.4) / 105, y: sp.y + (Math.sin(ang) * 2.4) / 68, ring: true };
  };

  const penPos = (side, idx, w) => {
    const m = w.m;
    const att = m.side;
    const gx = goalX(att);
    const da = dirOf(att);
    const f = form[side];
    if (idx === 0) return side === att ? null : { x: gx - da * 0.008, y: 0.5 };
    if (side === att && idx === f.penaltyTaker) return { x: m.shotPos.x - da * 0.045, y: 0.515 };
    const list = f.slots.map((s, i) => i).filter((i) => i !== 0 && !(side === att && i === f.penaltyTaker));
    const k = list.indexOf(idx);
    const n = list.length;
    // İki takım ceza yayının dışında sıralanır; savunanlar yarım adım kaymış durur ki oyuncular üst üste binmesin.
    const span = 0.76 / Math.max(1, n - 1);
    const ya = 0.12 + k * span + (side === att ? 0 : span / 2);
    return toWorld(att, side === att ? 0.765 : 0.8, clamp(ya, 0.06, 0.94));
  };

  const corPos = (side, idx, w) => {
    const m = w.m;
    const att = m.side;
    const gx = goalX(att);
    const da = dirOf(att);
    const f = form[side];
    if (side === att) {
      if (idx === 0) return null;
      if (idx === f.cornerTaker) return { x: gx - da * 0.002, y: m.top ? 0.012 : 0.988 };
      const box = [...f.mf, ...f.fw].filter((i) => i !== f.cornerTaker);
      const j = box.indexOf(idx);
      if (j < 0) return null;
      return toWorld(att, 0.93 - 0.012 * (j % 3), 0.4 + 0.2 * (j / Math.max(1, box.length - 1)));
    }
    if (idx === 0) return { x: gx - da * 0.01, y: 0.5 + (m.top ? -0.03 : 0.03) };
    const dfj = f.df.indexOf(idx);
    if (dfj >= 0) return toWorld(att, 0.945 - 0.01 * (dfj % 2), 0.38 + 0.24 * (dfj / Math.max(1, f.df.length - 1)));
    const mfj = f.mf.indexOf(idx);
    if (mfj >= 0) return toWorld(att, 0.83, 0.25 + 0.5 * (mfj / Math.max(1, f.mf.length - 1)));
    return null;
  };

  const divePos = (side, idx, w) => {
    const m = w.m;
    if (idx !== 0 || side === m.side) return null;
    const gx = goalX(m.side);
    const da = dirOf(m.side);
    const ty = m.target.y;
    let y = ty;
    if (m.outcome === 'goal' || m.outcome === 'var') y = ty + (ty > 0.5 ? -1 : 1) * 0.04; // uçar ama yetişemez
    else if (m.outcome === 'blocked') y = lerp(0.5, ty, 0.3);
    else if (m.outcome === 'off_target') y = lerp(0.5, ty, 0.3);
    return { x: gx - da * 0.012, y: clamp(y, 0.4, 0.6) };
  };

  // ---- Diziliş konumu (topla temas HARİÇ) ---------------------------------------------------------
  const formationPos = (side, idx, ctx) => {
    const slot = form[side].slots[idx];
    const R = ROLE[slot.role];
    const b = toAttack(side, ctx.sb.x, ctx.sb.y);
    let xa;
    let ya;
    if (slot.role === 'GK') {
      xa = 0.03 + 0.05 * b.xa;
      ya = 0.5 + (b.ya - 0.5) * 0.22;
    } else {
      xa = clamp(slot.xa + (b.xa - 0.5) * 0.42 * R.adv + (ctx.poss[side] - 0.5) * 0.1 * R.adv, 0.06, 0.95);
      ya = clamp(slot.ya + (b.ya - 0.5) * 0.26 * R.lat, 0.05, 0.95);
    }
    const w0 = toWorld(side, xa, ya);
    const ph = idx * 2.399 + (side === 'home' ? 0 : 1.3);
    let x = w0.x + Math.sin(ctx.t * 0.9 + ph) * 0.0035;
    let y = w0.y + Math.cos(ctx.t * 0.75 + ph * 1.7) * 0.005;

    // topa yakın oyuncular topa doğru kayar
    const dm = distM(x, y, ctx.sf.x, ctx.sf.y);
    const pull = R.pull * (1 - clamp(dm / 18, 0, 1)) ** 1.6;
    x += (ctx.sf.x - x) * pull;
    y += (ctx.sf.y - y) * pull;

    // sahneler (sırayla üst üste)
    const sc = ctx.sc;
    const mix = (p, wt) => {
      if (!p || wt <= 0) return;
      x = lerp(x, p.x, wt);
      y = lerp(y, p.y, wt);
    };
    for (const w of sc.cel) {
      const p = celPos(side, idx, w, ctx.t);
      if (!p) continue;
      let wt = w.w;
      if (p.ring) {
        // uzaktaki takım arkadaşları kutlamaya sadece kısmen koşar
        const far = smooth(distM(x, y, p.x, p.y) / 50);
        wt *= 1 - 0.65 * far;
      }
      mix(p, wt);
    }
    for (const w of sc.ko) mix(koPos(side, idx, w.taker), w.w);
    for (const w of sc.cor) mix(corPos(side, idx, w), w.w);
    for (const w of sc.pen) mix(penPos(side, idx, w), w.w);
    for (const w of sc.dive) mix(divePos(side, idx, w), w.w);
    return { x: clamp(x, 0.005, 0.995), y: clamp(y, 0.005, 0.995) };
  };

  // ---- Topla temas aralıkları ------------------------------------------------------------------------
  const nearestSlot = (side, P, t, exclude = -1) => {
    const ctx = makeCtx(t);
    const own = toAttack(side, P.x, P.y).xa;
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < 11; i++) {
      if (i === exclude) continue;
      if (i === 0 && own > 0.2) continue; // kaleci yalnızca kendi ceza sahasına yakın toplarda
      const f = formationPos(side, i, ctx);
      const d = distM(f.x, f.y, P.x, P.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const intervals = { home: Array.from({ length: 11 }, () => []), away: Array.from({ length: 11 }, () => []) };
  let holder = null; // { side, idx, iv }

  const closeHolder = (t, x, y) => {
    if (!holder) return;
    holder.iv.rel = t;
    holder.iv.rx = x;
    holder.iv.ry = y;
    holder = null;
  };
  const openHolder = (side, idx, arr, x, y) => {
    const iv = { arr, rel: D, px: x, py: y, rx: x, ry: y, lead: 0.3 };
    intervals[side][idx].push(iv);
    holder = { side, idx, iv };
  };

  // Pasın bittiği noktayı oyuncuya doğru kaydırır. Bu noktaya bağlı sonraki segmentler de uyar: durağan tutuşlar
  // (kontrol, bekleme...) noktayla birlikte taşınır, ilk hareketli segment yeni noktadan başlar. Top hızı
  // sınırı aşılacaksa kaydırma payı azaltılır, hiçbiri uymazsa kaydırma yapılmaz.
  const segSpeed = (q, x0, y0, x1, y1) => (q.t1 - q.t0 > 1e-6 ? distM(x0, y0, x1, y1) / (q.t1 - q.t0) : 0);
  const retarget = (k, f) => {
    const s = segs[k];
    const ox = s.x1;
    const oy = s.y1;
    const chain = [];
    for (let j = k + 1; j < segs.length; j++) {
      const q = segs[j];
      if (q.teleport || Math.abs(q.x0 - ox) > 1e-9 || Math.abs(q.y0 - oy) > 1e-9) break;
      const still = Math.abs(q.x1 - ox) < 1e-9 && Math.abs(q.y1 - oy) < 1e-9;
      chain.push({ q, still });
      if (!still) break;
    }
    const limit = (was) => Math.max(SPEED_CAP, was * 1.08);
    const moving = chain.find((c) => !c.still)?.q;
    const wasS = segSpeed(s, s.x0, s.y0, ox, oy);
    const wasQ = moving ? segSpeed(moving, ox, oy, moving.x1, moving.y1) : 0;
    for (const u of [0.6, 0.4, 0.2]) {
      const nx = lerp(ox, f.x, u);
      const ny = lerp(oy, f.y, u);
      if (segSpeed(s, s.x0, s.y0, nx, ny) > limit(wasS)) continue;
      if (moving && segSpeed(moving, nx, ny, moving.x1, moving.y1) > limit(wasQ)) continue;
      s.x1 = nx;
      s.y1 = ny;
      for (const { q, still } of chain) {
        q.x0 = nx;
        q.y0 = ny;
        if (still) {
          q.x1 = nx;
          q.y1 = ny;
        }
      }
      return;
    }
  };

  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s.teleport || s.owner === null) {
      // Işınlamada topu bırakan oyuncunun bırakma noktası YENİ konum değil, topun son bulunduğu yerdir:
      // bir önceki segmentin bitiş noktası. (Eskiden yalnızca sahipsiz segmentlerden güncellenen bir değişken
      // kullanılıyordu; devre arası ve penaltıda oyuncu sahanın ortasına ışınlanıyordu.)
      const before = s.teleport && k > 0 ? segs[k - 1] : null;
      closeHolder(s.t0, before ? before.x1 : s.x0, before ? before.y1 : s.y0);
      continue;
    }
    const side = s.owner;
    if (s.kind === 'shot') {
      // atışı yapan: topu şu an taşıyan oyuncu (gol sonrası kutlamayı o yapar).
      // Çok sıkışık anlarda şut segmenti planlanandan birkaç yüz ms kayabilir; en yakın "an" eşlenir.
      let m = null;
      for (const q of moments) {
        if ((q.kind === 'shot' || q.kind === 'penalty') && q.side === side && Math.abs(q.tShot - s.t0) < 0.15) {
          if (!m || Math.abs(q.tShot - s.t0) < Math.abs(m.tShot - s.t0)) m = q;
        }
      }
      if (m) {
        m.tShot = s.t0;
        m.shooter = holder && holder.side === side ? { side, idx: holder.idx } : { side, idx: form[side].fw[0] };
      }
      closeHolder(s.t0, s.x0, s.y0);
      continue;
    }
    if (HOLD_LIKE.has(s.kind)) {
      if (holder && holder.side === side) continue;
      closeHolder(s.t0, s.x0, s.y0);
      openHolder(side, nearestSlot(side, { x: s.x0, y: s.y0 }, s.t0), s.t0, s.x0, s.y0);
      continue;
    }
    // pas benzeri: top yeni bir oyuncuya gider. Hedefi o oyuncuya doğru kaydır.
    const exclude = holder && holder.side === side ? holder.idx : -1;
    const idx = nearestSlot(side, { x: s.x1, y: s.y1 }, s.t1, exclude);
    const f = formationPos(side, idx, makeCtx(s.t1));
    if (distM(s.x1, s.y1, f.x, f.y) > 3 && s.kind !== 'out') retarget(k, f);
    closeHolder(s.t0, s.x0, s.y0);
    const arr = ARRIVE_AT_END.has(s.kind) ? s.t1 : s.t0;
    openHolder(side, idx, arr, s.x1, s.y1);
    holder.iv.lead = clamp(distM(f.x, f.y, s.x1, s.y1) / RUN_SPEED, 0.3, 1.0);
  }
  // Maç bitince topu tutan oyuncu topu bırakmaz: son kareler dahil top onunla kalır.
  if (holder) {
    holder.iv.rel = Infinity;
    holder = null;
  }

  // kartı gören oyuncu: faulün olduğu yere en yakın (kaleci hariç) oyuncu
  for (const m of moments) {
    if (m.kind !== 'card') continue;
    const ctx = makeCtx(m.tC);
    const b = ball(m.tC);
    let best = 1;
    let bd = Infinity;
    for (let i = 1; i < 11; i++) {
      const f = formationPos(m.side, i, ctx);
      const d = distM(f.x, f.y, b.x, b.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    m.carded = { side: m.side, idx: best };
  }

  // ---- Topla temas ağırlığı ----------------------------------------------------------------------------
  // Aynı oyuncunun üst üste binen temas aralıkları (biri bırakılırken diğerine koşu başlar) SEÇİLMEZ,
  // karıştırılır. Eskiden her karede ağırlığı en yüksek aralık seçiliyordu; iki ağırlık birbirini geçtiği
  // anda oyuncu bir hedeften ötekine (onlarca metre) tek karede sıçrıyordu. Karışım hem ağırlıkta hem
  // hedefte süreklidir.
  const attachOf = (side, idx, t, b) => {
    const dir = dirOf(side);
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let rest = 1; // (1 - w1)(1 - w2)...
    let top = null;
    for (const iv of intervals[side][idx]) {
      if (t < iv.arr - iv.lead || t > iv.rel + FALL) continue;
      let w;
      let ax;
      let ay;
      let state;
      if (t < iv.arr) {
        w = smooth((t - (iv.arr - iv.lead)) / iv.lead);
        ax = iv.px;
        ay = iv.py;
        state = 'run';
      } else if (t < iv.rel) {
        // (kesin küçüktür: t === rel anında top ışınlanmış olabilir; o karede "bırakma" durumuna geçilir)
        w = 1;
        ax = b.x;
        ay = b.y;
        state = 'hold';
      } else {
        w = 1 - smooth((t - iv.rel) / FALL);
        ax = iv.rx;
        ay = iv.ry;
        state = 'release';
      }
      if (w <= 0) continue;
      sw += w;
      sx += w * ax;
      sy += w * ay;
      rest *= 1 - w;
      if (!top || w > top.w) top = { w, state };
    }
    if (!top) return { w: 0 };
    return { w: 1 - rest, x: sx / sw - dir * 0.006, y: sy / sw, state: top.state };
  };

  // ---- Hakem --------------------------------------------------------------------------------------------
  const refPos = (t, ctx) => {
    const a = avgBall(t, 0.2, 1.4); // hakem topu biraz geriden takip eder
    let x = a.x;
    let y = a.y + (a.y < 0.5 ? 0.09 : -0.09);
    for (const cw of ctx.sc.card) {
      if (!cw.m.carded) continue;
      const f = formationPos(cw.m.carded.side, cw.m.carded.idx, ctx);
      x = lerp(x, f.x - 0.012, cw.w);
      y = lerp(y, f.y - 0.04, cw.w);
    }
    return { x: clamp(x, 0.04, 0.96), y: clamp(y, 0.05, 0.95) };
  };

  // ---- Değerlendirme --------------------------------------------------------------------------------------
  const positions = (t) => {
    const tt = clamp(t, 0, D);
    const ctx = makeCtx(tt);
    const b = ball(tt);
    const res = { home: [], away: [], carrier: null, ctx };
    let cw = 0.85;
    for (const side of SIDES) {
      for (let i = 0; i < 11; i++) {
        const f = formationPos(side, i, ctx);
        const a = attachOf(side, i, tt, b);
        // oyuncu topu kale arkasına kadar kovalasa bile sahada kalır
        const x = clamp(a.w > 0 ? lerp(f.x, a.x, a.w) : f.x, 0, 1);
        const y = clamp(a.w > 0 ? lerp(f.y, a.y, a.w) : f.y, 0, 1);
        res[side].push({ x, y, attach: a.w, state: a.state });
        if (a.state === 'hold' && a.w > cw && b.owner !== null) {
          cw = a.w;
          res.carrier = { side, idx: i };
        }
      }
    }
    res.ref = refPos(tt, ctx);
    return res;
  };

  const faceOf = (vx, vy, fallback) => (Math.hypot(vx, vy) > 1.2 ? Math.atan2(vy, vx) : fallback);

  return {
    formations: { home: homeFormation, away: awayFormation },
    slots: { home: form.home.slots, away: form.away.slots },
    // Oyuncularla uyumlu (kaydırılmış) top yolu. choreo.ball(t) yerine bunu kullan.
    ball: (t) => ball(clamp(t, 0, D)),
    segs,
    // t anındaki tüm oyuncular: { home: [11], away: [11], ref, carrier, carded }
    at(t) {
      const DT = 0.05;
      const cur = positions(t);
      const prev = positions(Math.max(0, t - DT));
      const b = ball(clamp(t, 0, D));
      const out = { t, ball: b, carrier: cur.carrier, carded: null, home: [], away: [], ref: null };
      for (const side of SIDES) {
        for (let i = 0; i < 11; i++) {
          const c = cur[side][i];
          const p = prev[side][i];
          const dtm = t > DT ? DT : Math.max(1e-3, t);
          let vx = ((c.x - p.x) * 105) / dtm;
          let vy = ((c.y - p.y) * 68) / dtm;
          const sp = Math.hypot(vx, vy);
          if (sp > 14) {
            vx *= 14 / sp;
            vy *= 14 / sp;
          }
          const toBall = Math.atan2((b.y - c.y) * 68, (b.x - c.x) * 105);
          out[side].push({
            idx: i,
            side,
            role: form[side].slots[i].role,
            num: form[side].slots[i].num,
            x: c.x,
            y: c.y,
            vx,
            vy,
            speed: Math.min(sp, 14),
            face: faceOf(vx, vy, toBall),
            attach: c.attach,
          });
        }
      }
      const r = cur.ref;
      const rp = prev.ref;
      const rvx = ((r.x - rp.x) * 105) / DT;
      const rvy = ((r.y - rp.y) * 68) / DT;
      out.ref = { x: r.x, y: r.y, speed: Math.min(Math.hypot(rvx, rvy), 12), face: faceOf(rvx, rvy, Math.atan2((b.y - r.y) * 68, (b.x - r.x) * 105)) };
      for (const w of WIN.card) {
        if (w.m.carded && t >= w.m.tC && t < w.m.tEnd + 1.0) out.carded = { ...w.m.carded, card: w.m.card };
      }
      return out;
    },
  };
}
