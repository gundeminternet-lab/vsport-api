// Canlı Radar: canlı maçlarda baskıyı ölçer ve gol (ya da korner) ihtimali yükselen takım için sinyal üretir.
// Saf fonksiyonlar (test edilebilir); maçları tarayan, kaydeden ve bildirim gönderen kısım radar_service.js'tedir.
//
// Ölçülenler (takım başına, son 5 ve son 10 dakika + maç geneli):
//   • Gol beklentisi (xG): maç anlatımındaki her şutun yerinden ve türünden (ceza sahası ortası, çok yakın mesafe, kafa,
//     ceza sahası dışı, penaltı…). Anlatım yoksa şut ve isabetli şut sayılarından kaba xG.
//   • Şut ve isabetli şut, korner.
//   • Topa sahip olma: maç geneli; radar maçı izledikçe son 10 dakikanın oranı da hesaplanır.
// Baskı endeksi (0-100) bu üçünün birleşimidir: xG %40, şut %30, topa sahip olma %30 (+ korner ve süreklilik payı),
// rakibe göre üstünlükle çarpılır. Gol Sireni için üçünün de eşiği geçmesi gerekir: yalnızca topla oynayan ya da
// yalnızca uzaktan şut atan takım siren almaz.
//
// Yıldızlar baskının yoğunluğudur (★ Baskı, ★★ Güçlü baskı, ★★★ Çok güçlü baskı). Sinyal anındaki veriler dondurulur;
// sonrasında hedefin (takımın golü, maçta gol, korner) süre içinde gerçekleşip gerçekleşmediği izlenir.

export const RADAR = Object.freeze({
  window: 10, // baskı penceresi (dk)
  short: 5, // kısa pencere: baskı sürüyor mu
  goalMinutes: 20, // Gol Sireni / Geri Dönüş hedef süresi
  openMinutes: 15, // Karşılıklı Baskı hedef süresi
  cornerMinutes: 10, // Korner Baskısı hedef süresi
  lateFrom: 70, // Son Dakika Baskısı bu dakikadan sonra (hedef: maç sonuna kadar)
  firstMinute: 12, // ilk dakikalarda pencere dolmadığı için sinyal yok
  lastMinute: 88,
  cooldown: 12, // aynı takım için iki sinyal arası en az (dk)
  maxPerMatch: 6,
  levels: [55, 68, 80], // ★, ★★, ★★★ eşikleri (baskı endeksi)
  // Gol Sireni kapıları: üçü birden
  minShots: 2,
  minXg: 0.25,
  minPossWindow: 52, // son 10 dk topa sahip olma (biliniyorsa)
  minPossMatch: 55, // ya da maç geneli
  minShare: 0.62, // son 10 dk xG+şut payı (rakibe göre)
  // Kaba xG (anlatım yoksa)
  sotXg: 0.2,
  shotXg: 0.05,
  // Lig ortalaması (maç öncesi tahmin yoksa): maç başına gol
  avgHome: 1.45,
  avgAway: 1.15,
});

export const SIGNAL_TYPES = ['siren', 'comeback', 'late', 'open', 'corner'];

export const TYPE_INFO = {
  siren: { title: 'Gol Sireni', target: 'team_goal' },
  comeback: { title: 'Geri Dönüş', target: 'team_goal' },
  late: { title: 'Son Dakika Baskısı', target: 'team_goal' },
  open: { title: 'Karşılıklı Baskı', target: 'any_goal' },
  corner: { title: 'Korner Baskısı', target: 'team_corner' },
};

export const STAR_LABELS = ['', 'Baskı', 'Güçlü baskı', 'Çok güçlü baskı'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (v) => Math.round(v * 100) / 100;
const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const num = (v) => {
  const n = Number(typeof v === 'object' && v !== null ? (v.value ?? v.displayValue) : v);
  return Number.isFinite(n) ? n : null;
};

// ---------------------------------------------------------------------------------------------------
// Zaman: maç saati → oynanan dakika (ilk yarının uzatması da sayılır; ikinci yarı ilk yarının bittiği yerden sürer)
// ---------------------------------------------------------------------------------------------------

/** "45'+2'" → { base: 45, extra: 2 }; okunamazsa null. */
export function parseClock(text) {
  const m = /(\d+)'?\s*(?:\+\s*(\d+))?/.exec(str(text));
  if (!m) return null;
  return { base: Number(m[1]), extra: Number(m[2] ?? 0) };
}

/**
 * Oynanan dakika (sürekli): ilk yarıda saat, ikinci yarıda ilk yarının uzunluğu [h1] + (saat - 45).
 * [period] bilinmiyorsa saat 45'ten büyükse ikinci yarı sayılır ("45'+2'" ilk yarının uzatmasıdır).
 */
export function elapsedOf(clock, period = 0, h1 = 47) {
  if (!clock) return null;
  const { base, extra } = clock;
  const second = period >= 2 ? base >= 45 : base > 45;
  if (!second) return base + extra;
  return Math.max(45, h1) + Math.max(0, base + extra - 45);
}

// ---------------------------------------------------------------------------------------------------
// Şut değeri (xG): anlatım metninden
// ---------------------------------------------------------------------------------------------------

/** Anlatımdaki şutun gol beklentisi (0-0,9). Değerler yayımlanmış xG modellerinin bölge ortalamalarına yakındır. */
export function shotXg(text) {
  const t = str(text).toLowerCase();
  if (/penalty/.test(t) && !/draws a foul|conceded|penalty area/.test(t)) return 0.76;
  const header = /header/.test(t);
  let x;
  if (/very close range/.test(t)) x = header ? 0.32 : 0.48;
  else if (/six yard box|6 yard box/.test(t)) x = header ? 0.24 : 0.36;
  else if (/difficult angle/.test(t)) x = 0.045;
  else if (/(centre|center) of the box/.test(t)) x = header ? 0.1 : 0.14;
  else if (/(left|right) side of the box/.test(t)) x = header ? 0.05 : 0.065;
  else if (/more than (35|40) yards|long range/.test(t)) x = 0.015;
  else if (/outside the box/.test(t)) x = 0.035;
  else if (/free kick/.test(t)) x = 0.06;
  else x = header ? 0.07 : 0.08;
  if (/fast break/.test(t)) x *= 1.25;
  if (/through ball/.test(t)) x *= 1.2;
  return Math.min(0.9, Math.round(x * 1000) / 1000);
}

/** Anlatım satırının türü: shot | sot | goal | own_goal | corner | penalty_won | null. */
export function playKind(text) {
  const t = str(text).toLowerCase();
  if (t.startsWith('own goal')) return 'own_goal';
  if (t.startsWith('goal!') || t.startsWith('goal ')) return 'goal';
  if (t.startsWith('attempt saved') || t.startsWith('penalty saved')) return 'sot';
  if (t.startsWith('attempt missed') || t.startsWith('attempt blocked') || t.startsWith('penalty missed')) return 'shot';
  if (/hits the (left |right )?(post|bar|crossbar)/.test(t)) return 'shot';
  if (t.startsWith('corner,')) return 'corner';
  if (t.startsWith('penalty ') && /draws a foul|wins/.test(t)) return 'penalty_won';
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Maç özetinden radarın okuduğu durum
// ---------------------------------------------------------------------------------------------------

const teamNames = (t) => [t?.displayName, t?.shortDisplayName, t?.name, t?.location, t?.abbreviation].map(str).filter(Boolean).map((s) => s.toLowerCase());

function sideResolver(ids, names) {
  const of = (name) => {
    const n = str(name).toLowerCase();
    if (!n) return null;
    for (const s of ['home', 'away']) if (names[s].includes(n)) return s;
    for (const s of ['home', 'away']) if (names[s].some((x) => x.includes(n) || n.includes(x))) return s;
    return null;
  };
  return {
    of,
    inParens(text) {
      for (const m of str(text).matchAll(/\(([^()]+)\)/g)) {
        const s = of(m[1]);
        if (s) return s;
      }
      return null;
    },
    afterComma(text) {
      const m = /^[^,]+,\s*([^.]+)\./.exec(str(text));
      return m ? of(m[1]) : null;
    },
    ofId(id) {
      const v = str(id);
      return !v ? null : v === ids.home ? 'home' : v === ids.away ? 'away' : null;
    },
  };
}

const other = (s) => (s === 'home' ? 'away' : 'home');

/**
 * Özet (summary) → radar durumu. [h1]: bilinen ilk yarı uzunluğu (dk). Dönen:
 * { state, statusName, halftime, period, clock, minute, e, h1, score, ids, teams, totals, plays, hasPlays, goals, reds }
 */
export function readMatch(json, { h1: knownH1 = null } = {}) {
  const comp = json?.header?.competitions?.[0];
  if (!comp) return null;
  const cs = comp.competitors ?? [];
  const H = cs.find((c) => c.homeAway === 'home') ?? cs[0] ?? {};
  const A = cs.find((c) => c.homeAway === 'away') ?? cs[1] ?? {};
  const st = comp.status ?? json?.header?.status ?? {};
  const type = st.type ?? {};
  const ids = { home: str(H.team?.id ?? H.id), away: str(A.team?.id ?? A.id) };
  const names = { home: teamNames(H.team), away: teamNames(A.team) };
  const sides = sideResolver(ids, names);
  const team = (c) => ({
    id: str(c.team?.id ?? c.id),
    name: str(c.team?.shortDisplayName ?? c.team?.displayName ?? c.team?.name) || '?',
    abbr: str(c.team?.abbreviation) || null,
    logo: str(c.team?.logos?.[0]?.href ?? c.team?.logo) || null,
  });
  let period = num(st.period) ?? 0;
  const statusName = str(type.name);
  if (!period) period = /FIRST_HALF|HALFTIME/.test(statusName) ? 1 : /SECOND_HALF/.test(statusName) ? 2 : 0;
  const halftime = statusName === 'STATUS_HALFTIME';

  // Anlatım: şutlar (xG ile), goller, kornerler
  const raw = [];
  for (const c of json?.commentary ?? []) {
    const text = str(c?.text);
    const kind = playKind(text);
    if (!kind) continue;
    const clock = parseClock(c?.time?.displayValue ?? c?.time);
    if (!clock) continue;
    let side = kind === 'corner' ? sides.afterComma(text) : null;
    if (kind === 'own_goal') {
      // "Own Goal by X, Takım. ..." → gol rakibe yazılır
      const own = sides.afterComma(text) ?? sides.ofId(c?.play?.team?.id);
      side = own ? other(own) : null;
    }
    side ??= sides.inParens(text) ?? sides.ofId(c?.play?.team?.id);
    if (!side) continue;
    raw.push({ clock, side, kind, text });
  }
  // İlk yarının uzunluğu: ilk yarı uzatmasındaki son anlatım ya da saat
  let h1 = knownH1 ?? 45;
  for (const p of raw) if (p.clock.base === 45 && p.clock.extra > 0) h1 = Math.max(h1, 45 + p.clock.extra);
  const clock = parseClock(st.displayClock);
  if (period === 1 && clock) h1 = Math.max(h1, clock.base + clock.extra);
  if (period >= 2 && knownH1 === null && h1 === 45) h1 = 47; // ilk yarının uzatması görülmediyse ortalama
  const plays = raw
    .map((p) => {
      const shot = p.kind === 'shot' || p.kind === 'sot' || p.kind === 'goal';
      return { e: elapsedOf(p.clock, p.clock.base > 45 ? 2 : 1, h1), side: p.side, kind: p.kind, xg: shot ? shotXg(p.text) : 0 };
    })
    .sort((a, b) => a.e - b.e);
  let e = halftime ? h1 : elapsedOf(clock, period, h1);
  if (e === null) e = 0;

  // Toplamlar: kutu istatistikleri
  const statOf = (teamId, name) => {
    const t = (json?.boxscore?.teams ?? []).find((x) => str(x?.team?.id) === teamId);
    const s = (t?.statistics ?? []).find((x) => x?.name === name);
    return s ? num(s.displayValue ?? s.value) : null;
  };
  const tot = (id) => ({ poss: statOf(id, 'possessionPct'), shots: statOf(id, 'totalShots'), sot: statOf(id, 'shotsOnTarget'), corners: statOf(id, 'wonCorners') });

  // Goller (olaylardan, dakikasıyla) ve kırmızı kartlar
  const goals = [];
  const reds = { home: 0, away: 0 };
  for (const ev of json?.keyEvents ?? []) {
    const t = str(ev?.type?.text ?? ev?.type?.type).toLowerCase();
    const s = sides.ofId(ev?.team?.id);
    const c = parseClock(ev?.clock?.displayValue);
    const disallowed = /disallow|ruled out|overturn|cancel/.test(t);
    const scoring = !disallowed && (ev?.scoringPlay === true || t === 'goal' || t.startsWith('goal') || t.includes('own goal'));
    if (scoring && s && !(t.includes('penalty') && /miss|saved/.test(t))) {
      goals.push({ side: s, e: c ? elapsedOf(c, c.base > 45 ? 2 : 1, h1) : null });
    }
    if (s && (ev?.redCard === true || t.includes('red card') || t.includes('second yellow') || t.includes('yellow-red'))) reds[s] += 1;
  }
  goals.sort((a, b) => (a.e ?? 999) - (b.e ?? 999));

  return {
    state: str(type.state) || 'pre',
    statusName,
    completed: type.completed === true,
    halftime,
    period,
    clock: str(st.displayClock),
    minute: clock ? clock.base + clock.extra : null,
    e,
    h1,
    score: { home: num(H.score) ?? 0, away: num(A.score) ?? 0 },
    ids,
    teams: { home: team(H), away: team(A) },
    totals: { home: tot(ids.home), away: tot(ids.away) },
    plays,
    hasPlays: plays.some((p) => p.kind !== 'corner'),
    goals,
    reds,
  };
}

// ---------------------------------------------------------------------------------------------------
// Pencereler: son N dakikanın sayıları
// ---------------------------------------------------------------------------------------------------

const zero = () => ({ shots: 0, sot: 0, corners: 0, xg: 0, poss: null });

/** Anlatımdan (e-w, e] penceresinin sayıları. */
export function playWindow(plays, e, w) {
  const out = { home: zero(), away: zero() };
  for (const p of plays) {
    if (w !== null && (p.e <= e - w || p.e > e + 0.5)) continue;
    const t = out[p.side];
    if (p.kind === 'corner') t.corners++;
    else if (p.kind === 'shot' || p.kind === 'sot' || p.kind === 'goal') {
      t.shots++;
      if (p.kind !== 'shot') t.sot++;
      t.xg += p.xg;
    }
  }
  for (const s of ['home', 'away']) out[s].xg = r2(out[s].xg);
  return out;
}

const roughXg = (shots, sot) => r2(RADAR.sotXg * Math.max(0, sot) + RADAR.shotXg * Math.max(0, shots - sot));

/**
 * Anlık görüntülerden (radarın her turda kaydettiği toplamlar) pencere: şimdiki toplam - pencerenin başındaki toplam.
 * snaps: [{ e, totals: {home:{poss,shots,sot,corners}, away} }] (eskiden yeniye). Yeterli geçmiş yoksa null.
 * Topa sahip olma: maç geneli yüzdelerden pencereye düşen pay (yuvarlama gürültüsü ±3 puan).
 */
export function snapWindow(snaps, now, w) {
  if (!snaps?.length || !now) return null;
  let base = null;
  for (const s of snaps) {
    if (s.e <= now.e - w + 1) base = s;
    else break;
  }
  if (!base || now.e - base.e < w * 0.6) return null;
  const span = now.e - base.e;
  const out = {};
  for (const side of ['home', 'away']) {
    const a = now.totals[side];
    const b = base.totals[side];
    const d = (k) => (Number.isFinite(a[k]) && Number.isFinite(b[k]) ? Math.max(0, a[k] - b[k]) : null);
    const shots = d('shots');
    const sot = d('sot');
    let poss = null;
    if (Number.isFinite(a.poss) && Number.isFinite(b.poss) && now.e > 0) poss = Math.round(clamp((a.poss * now.e - b.poss * base.e) / span, 0, 100));
    out[side] = { shots: shots ?? 0, sot: sot ?? 0, corners: d('corners') ?? 0, xg: roughXg(shots ?? 0, sot ?? 0), poss, known: shots !== null };
  }
  if (!out.home.known && !out.away.known && out.home.poss === null) return null;
  delete out.home.known;
  delete out.away.known;
  return out;
}

/**
 * Maçın o anki görünümü: son 5 dk, son 10 dk ve maç geneli (takım başına şut, isabetli, korner, xG, topa sahip olma).
 * Anlatım varsa sayılar ondan, yoksa anlık görüntülerden. Topa sahip olma penceresi yalnızca görüntülerden gelir.
 */
export function buildView(m, snaps = []) {
  const now = { e: m.e, totals: m.totals };
  const fromPlays = m.hasPlays;
  const win = (w) => {
    const sw = snapWindow(snaps, now, w);
    if (fromPlays) {
      const pw = playWindow(m.plays, m.e, w);
      if (sw) {
        pw.home.poss = sw.home.poss;
        pw.away.poss = sw.away.poss;
      }
      return pw;
    }
    return sw;
  };
  const total = { home: zero(), away: zero() };
  const pt = fromPlays ? playWindow(m.plays, m.e, null) : null;
  for (const s of ['home', 'away']) {
    const t = m.totals[s];
    total[s] = {
      shots: Number.isFinite(t.shots) ? t.shots : (pt?.[s].shots ?? 0),
      sot: Number.isFinite(t.sot) ? t.sot : (pt?.[s].sot ?? 0),
      corners: Number.isFinite(t.corners) ? t.corners : (pt?.[s].corners ?? 0),
      xg: pt ? pt[s].xg : roughXg(t.shots ?? 0, t.sot ?? 0),
      poss: Number.isFinite(t.poss) ? Math.round(t.poss) : null,
    };
  }
  return { e: m.e, source: fromPlays ? 'plays' : 'stats', w5: win(RADAR.short), w10: win(RADAR.window), total };
}

// ---------------------------------------------------------------------------------------------------
// Baskı endeksi
// ---------------------------------------------------------------------------------------------------

/**
 * Takımın baskı endeksi (0-100) ve parçaları. Kullanılan: son 10 dk xG, şut (+ isabetli), topa sahip olma (son 10 dk
 * biliniyorsa o, yoksa maç geneli), korner; maç genelinde süren üstünlük; rakibe göre pay.
 */
export function pressureOf(view, side) {
  const w = view.w10;
  if (!w) return null;
  const T = w[side];
  const O = w[other(side)];
  const total = view.total;
  const poss = Number.isFinite(T.poss) ? T.poss : total[side].poss;
  const fXg = clamp((T.xg - 0.12) / 0.63, 0, 1);
  const fSh = clamp((T.shots + T.sot - 1) / 5, 0, 1);
  const fPo = Number.isFinite(poss) ? clamp((poss - 50) / 18, 0, 1) : 0;
  const fC = clamp(T.corners / 3, 0, 1);
  const tXg = total[side].xg;
  const oXg = total[other(side)].xg;
  const sustained = tXg >= 0.6 && tXg >= 1.8 * Math.max(0.15, oXg) && (total[side].poss ?? 50) >= 55 ? 1 : 0;
  const base = 0.4 * fXg + 0.3 * fSh + 0.3 * fPo + 0.08 * fC + 0.07 * sustained;
  const a = T.xg + 0.03 * T.shots;
  const b = O.xg + 0.03 * O.shots;
  const share = (a + 0.05) / (a + b + 0.1);
  const dom = 0.55 + 0.45 * clamp((share - 0.4) / 0.45, 0, 1);
  // Son 5 dakikada hiçbir şey yoksa baskı sönüyor
  const s5 = view.w5?.[side];
  const fading = s5 && s5.shots === 0 && s5.corners === 0 && s5.xg < 0.05;
  const index = Math.round(100 * clamp(base, 0, 1) * dom * (fading ? 0.85 : 1));
  return { index, share: r2(share), poss: Number.isFinite(poss) ? Math.round(poss) : null, parts: { xg: r2(fXg), shots: r2(fSh), poss: r2(fPo), corners: r2(fC) }, sustained: sustained === 1, fading: Boolean(fading) };
}

export const starsOf = (index) => (index >= RADAR.levels[2] ? 3 : index >= RADAR.levels[1] ? 2 : index >= RADAR.levels[0] ? 1 : 0);

// ---------------------------------------------------------------------------------------------------
// Gol ihtimali (model tahmini): kalan sürenin takım gol hızı × baskı çarpanı
// ---------------------------------------------------------------------------------------------------

/**
 * Takımın dakikalık gol hızı: maç öncesi gol beklentisi (yoksa lig ortalaması), maç içi xG ile harmanlanır; skor
 * durumu (geride olan atağa çıkar) ve kırmızı kartlar uygulanır. lambdas: { home, away } (maç başına).
 */
export function teamRate(m, side, lambdas = null, view = null) {
  const pre = Number.isFinite(lambdas?.[side]) && lambdas[side] > 0 ? lambdas[side] : side === 'home' ? RADAR.avgHome : RADAR.avgAway;
  const e = Math.max(1, m.e);
  const xg = view?.total?.[side]?.xg ?? 0;
  const w = e / (e + 45);
  const per90 = (1 - w) * pre + w * (xg / e) * 90;
  const diff = (m.score[side] ?? 0) - (m.score[other(side)] ?? 0);
  const state = diff === 0 ? 1 : diff === -1 ? 1.2 : diff <= -2 ? 1.15 : diff === 1 ? 0.88 : 0.9;
  const ownRed = Math.min(2, m.reds?.[side] ?? 0);
  const oppRed = Math.min(2, m.reds?.[other(side)] ?? 0);
  const red = 0.7 ** ownRed * 1.3 ** oppRed;
  return (per90 / 90) * state * red;
}

/** [minutes] dk içinde gol ihtimali (0-1): hız zamanla artar (maç sonuna doğru daha çok gol). */
export function chanceIn(rate, fromE, minutes, mult = 1) {
  let mass = 0;
  for (let t = 0; t < minutes; t++) mass += rate * mult * (1 + (0.5 * Math.min(95, fromE + t)) / 90) / 1.25;
  return 1 - Math.exp(-mass);
}

/** Baskı çarpanı: endeks 55 → ×1,35, 80 → ×1,6 (yüksek baskı altındaki takımların kısa sürede gol bulma sıklığı). */
export const pressureMult = (index) => clamp(0.8 + index / 100, 0.8, 1.85);

// ---------------------------------------------------------------------------------------------------
// Sinyaller
// ---------------------------------------------------------------------------------------------------

/** Takım hâlâ sinyal alabilir mi (yakın zamanda aynı takıma sinyal verildiyse bekler). */
function cooled(history, side, type, e) {
  for (const s of history) {
    if (s.side === side && (s.type === type || (TYPE_INFO[s.type].target === TYPE_INFO[type].target && type !== 'corner'))) {
      if (s.status === 'open') return false;
      if (e - s.e < RADAR.cooldown) return false;
    }
  }
  return true;
}

/**
 * Bu turda çıkan yeni sinyaller. m: readMatch, view: buildView, history: maçın önceki sinyalleri
 * ([{ type, side, e, status }]), lambdas: maç öncesi gol beklentileri (isteğe bağlı).
 * Dönen: [{ type, side, e, index, stars, pressure, chance: { p, base, minutes }, target: { kind, side, minutes, deadline } }]
 */
export function detectSignals(m, view, history = [], lambdas = null) {
  const out = [];
  if (!m || m.state !== 'in' || m.halftime || !view?.w10) return out;
  if (m.e < RADAR.firstMinute || m.e > RADAR.lastMinute + (m.period >= 2 ? Math.max(0, m.h1 - 45) : 0)) return out;
  if (m.period === 1 && m.e > 50) return out;
  if (history.length >= RADAR.maxPerMatch) return out;
  const p = { home: pressureOf(view, 'home'), away: pressureOf(view, 'away') };
  // Gol yeni olduysa (son 4 dk) o takıma sinyal verilmez: golün şutu baskı penceresini şişirir, takım da genelde geri çekilir
  const goalTimes = [...m.goals.filter((g) => Number.isFinite(g.e)), ...m.plays.filter((x) => x.kind === 'goal' || x.kind === 'own_goal')];
  const justScored = (side) => goalTimes.some((g) => (side === null || g.side === side) && m.e - g.e >= -0.5 && m.e - g.e < 4);
  const end = m.h1 + 45 + 4; // ikinci yarının beklenen sonu (oynanan dakika)
  const minuteOfMatch = m.period >= 2 ? (m.minute ?? 46) : m.e;

  for (const side of ['home', 'away']) {
    const pr = p[side];
    if (!pr) continue;
    const T = view.w10[side];
    const diff = m.score[side] - m.score[other(side)];
    // Gol Sireni / Geri Dönüş / Son Dakika: topa sahip olma + şut + xG kapıları
    const possOk = (Number.isFinite(T.poss) && T.poss >= RADAR.minPossWindow) || (view.total[side].poss ?? 0) >= RADAR.minPossMatch;
    const shotsOk = T.shots >= RADAR.minShots && (T.sot >= 1 || T.xg >= 0.35);
    const xgOk = T.xg >= RADAR.minXg;
    const stars = starsOf(pr.index);
    if (justScored(side)) continue;
    if (possOk && shotsOk && xgOk && pr.share >= RADAR.minShare && stars > 0 && diff < 3) {
      const late = m.period >= 2 && minuteOfMatch >= RADAR.lateFrom;
      const type = late ? 'late' : diff < 0 ? 'comeback' : 'siren';
      if (cooled(history, side, type, m.e)) {
        // Son Dakika: hedef maç sonuna kadar (uzatma ne kadar uzarsa uzasın; maç bitince sonuçlanır)
        const minutes = late ? Math.max(5, Math.round(end - m.e)) : RADAR.goalMinutes;
        const deadline = late ? end + 15 : m.e + minutes;
        const rate = teamRate(m, side, lambdas, view);
        out.push({
          type,
          side,
          e: m.e,
          index: pr.index,
          stars,
          pressure: pr,
          chance: { p: r2(chanceIn(rate, m.e, minutes, pressureMult(pr.index))), base: r2(chanceIn(rate, m.e, minutes)), minutes },
          target: { kind: 'team_goal', side, minutes, deadline, untilEnd: late },
        });
      }
    }
    // Korner Baskısı: kornerler ve şutlarla sahaya yerleşen takım
    const cornerHeat = T.corners >= 2 || ((view.w5?.[side]?.corners ?? 0) >= 1 && T.shots >= 3);
    if (cornerHeat && pr.index >= 45 && pr.share >= 0.6 && possOk && cooled(history, side, 'corner', m.e)) {
      const idx = Math.min(100, pr.index + 10 * Math.min(3, T.corners));
      out.push({
        type: 'corner',
        side,
        e: m.e,
        index: idx,
        stars: Math.max(1, starsOf(idx)),
        pressure: pr,
        chance: null,
        target: { kind: 'team_corner', side, minutes: RADAR.cornerMinutes, deadline: m.e + RADAR.cornerMinutes },
      });
    }
  }

  // Karşılıklı Baskı: iki takım da gole yakın (takım sinyali yoksa)
  const W = view.w10;
  const both = W.home.xg + W.away.xg;
  const bothShots = W.home.shots + W.away.shots;
  const ph = p.home?.index ?? 0;
  const pa = p.away?.index ?? 0;
  const teamGoal = out.some((s) => TYPE_INFO[s.type].target === 'team_goal');
  if (!teamGoal && !justScored(null) && both >= 0.7 && bothShots >= 6 && Math.min(W.home.shots, W.away.shots) >= 2 && Math.min(W.home.xg, W.away.xg) >= 0.2 && cooled(history, null, 'open', m.e)) {
    const idx = Math.round(clamp(25 + both * 45 + bothShots * 2.5, 0, 100));
    const stars = Math.max(1, starsOf(idx));
    const minutes = RADAR.openMinutes;
    const rh = teamRate(m, 'home', lambdas, view);
    const ra = teamRate(m, 'away', lambdas, view);
    out.push({
      type: 'open',
      side: null,
      e: m.e,
      index: idx,
      stars,
      pressure: { index: idx, home: ph, away: pa },
      chance: { p: r2(chanceIn(rh + ra, m.e, minutes, pressureMult(idx))), base: r2(chanceIn(rh + ra, m.e, minutes)), minutes },
      target: { kind: 'any_goal', side: null, minutes, deadline: m.e + minutes },
    });
  }
  return out;
}

/** Sinyal başlığı ve alt satırı (takım adı tek başına; ek bitiştirilmez). */
export function describe(sig, teams, score) {
  const T = sig.side ? teams[sig.side].name : null;
  const level = score.home === score.away;
  const diff = sig.side ? score[sig.side] - score[other(sig.side)] : 0;
  const title = TYPE_INFO[sig.type].title;
  let subtitle;
  switch (sig.type) {
    case 'siren':
      subtitle = level && score.home === 0 ? `${T}: 0-0'da baskı artıyor` : level ? `${T}: beraberlikte baskı kurdu` : diff > 0 ? `${T}: farkı açmak için yükleniyor` : `${T}: gol baskısı kurdu`;
      break;
    case 'comeback':
      subtitle = `${T}: geride ama baskılı oynuyor`;
      break;
    case 'late':
      subtitle = `${T}: son dakikalarda kaleye yükleniyor`;
      break;
    case 'corner':
      subtitle = `${T}: rakip yarı sahaya yerleşti`;
      break;
    default:
      subtitle = 'İki takım da gole yakın';
  }
  return { title, subtitle, team: T };
}

/** Bildirim metni. */
export function notificationText(sig) {
  const icon = { siren: '🚨', comeback: '🔥', late: '⏱️', open: '⚡', corner: '🚩' }[sig.type] ?? '🚨';
  const h = sig.home.name;
  const a = sig.away.name;
  const line = `${sig.minuteLabel} ${h} ${sig.score.home}-${sig.score.away} ${a}`;
  const w = sig.view?.w10?.[sig.side ?? 'home'];
  const parts = [];
  if (sig.side && w) {
    parts.push(`son 10 dk ${w.shots} şut${w.sot ? ` (${w.sot} isabetli)` : ''}`);
    parts.push(`xG ${String(w.xg.toFixed(2)).replace('.', ',')}`);
    const poss = Number.isFinite(w.poss) ? w.poss : sig.view?.total?.[sig.side]?.poss;
    if (Number.isFinite(poss)) parts.push(`topa sahip olma %${poss}`);
    if (sig.type === 'corner' && w.corners) parts.push(`${w.corners} korner`);
  }
  const stars = '★'.repeat(sig.stars) + '☆'.repeat(3 - sig.stars);
  const title = sig.side ? `${icon} ${sig.title} · ${sig.team}` : `${icon} ${sig.title} · ${h} - ${a}`;
  const body = `${line}${parts.length ? ` · ${parts.join(', ')}` : ''} · ${stars} ${STAR_LABELS[sig.stars]}`;
  return { title, body: body.slice(0, 230) };
}

// ---------------------------------------------------------------------------------------------------
// Sonuç: hedef süre içinde gerçekleşti mi
// ---------------------------------------------------------------------------------------------------

/**
 * Sinyalin sonucu. sig: { target: {kind, side, deadline}, e, score (sinyal anı), corners (sinyal anı, takım) },
 * m: readMatch (şimdi), seen: { goalE?: { home: [e…], away: [e…] }, cornerE? } (radarın gördüğü anlar; olay saati
 * yoksa kullanılır). Dönen: { status: 'open'|'hit'|'miss', at?: dk (sinyalden sonra), late?: dk } — değişmediyse null.
 */
export function resolveSignal(sig, m, seen = {}) {
  if (!m) return null;
  const ended = m.completed || m.state === 'post';
  const nowE = m.e;
  const t = sig.target;
  // İlk yarıda (uzatmadan önce) çıkan sinyalin süresi devreyi aşıyorsa ilk yarının uzatması süreye eklenir: "36' + 20 dk"
  // saatte 56' demektir, oynanan dakikada değil.
  const deadline = t.deadline + (!t.untilEnd && sig.e <= 45 && t.deadline > 45 ? Math.max(0, (m.h1 ?? 45) - 45) : 0);
  let eventE = null;
  if (t.kind === 'team_goal' || t.kind === 'any_goal') {
    const sides = t.kind === 'any_goal' ? ['home', 'away'] : [t.side];
    for (const s of sides) {
      const before = sig.score[s] ?? 0;
      const now = m.score[s] ?? 0;
      if (now <= before) continue;
      // (before+1). gol: olaylardan dakikası; yoksa radarın gördüğü an; o da yoksa şimdi
      const list = m.goals.filter((g) => g.side === s);
      const g = list[before];
      const at = Number.isFinite(g?.e) ? Math.max(g.e, sig.e) : (seen.goalE?.[s]?.[before] ?? nowE);
      eventE = eventE === null ? at : Math.min(eventE, at);
    }
  } else if (t.kind === 'team_corner') {
    const before = sig.corners ?? 0;
    const tot = m.totals[t.side]?.corners;
    const fromPlays = m.plays.filter((p) => p.kind === 'corner' && p.side === t.side && p.e > sig.e);
    if (fromPlays.length) eventE = fromPlays[0].e;
    else if (Number.isFinite(tot) && tot > before) eventE = seen.cornerE ?? nowE;
  }
  if (eventE !== null) {
    const after = Math.max(0, Math.round(eventE - sig.e));
    if (eventE <= deadline + 0.5) return { status: 'hit', at: after };
    return { status: 'miss', late: after };
  }
  if (ended || nowE > deadline + 0.5) return { status: 'miss' };
  return { status: 'open' };
}
