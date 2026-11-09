// Maç bağlamı: takımların bu maça hangi durumda girdiği. Saf fonksiyonlar (veri service.js'te toplanır).
//
//   • Lig durumu (sezonun en az %60'ı oynandıysa): şampiyonluk/yükselme yarışı, Avrupa/play-off yarışı, düşme hattı,
//     "hedefsiz" orta sıra. 2021-2026 arası 18 Avrupa liginde (~33 bin maç) ölçüldü (geriye dönük test, eğitim
//     2021-23 / doğrulama 2023-26): hedefsiz takım rakibine %8 fazla gol veriyor, kendisi %3 fazla atıyor; düşme
//     hattındaki iki takımın maçı modelden kısır geçiyor; şampiyonluk yarışındaki takım %3,5 daha az gol yiyor.
//     Doğrulamada 2,5 gol alt/üst log kaybı 0.6828 → 0.6805, maç sonucu 1.0122 → 1.0118 (sezon sonu maçları).
//   • Turnuva aşaması: düşme play-off'u (baraj) kısır, yükselme play-off'u daha açık; eleme turunun ilk maçı ve
//     final temkinli geçer. Bu oranlar ölçülmedi (veri setinde play-off maçı yok); yayımlanmış gözlemlere dayanır,
//     bu yüzden küçük tutuldu.
//   • Fikstür yükü ve rotasyon: lig maçından 3 gün sonra Avrupa maçı olan takım ligde rotasyona gidebilir (özellikle
//     ligde hedefi kalmamışsa); Avrupa maçından 3 gün içinde oynanan lig maçında yorgunluk; ligde düşme hattındaki
//     takım Avrupa'da kadro dinlendirebilir; ulusal kupada büyük takım alt lig rakibine yedeklerle çıkar.
//     Bunlar da ölçülmedi (kupa maçları veri setinde yok); etkiler küçük tutuldu ve gerekçesiyle gösterilir.
//   • Son 20 maç: gol attığı/yediği ortalamalar (genel, evde, deplasmanda; ligde ve Avrupa'da ayrı). Yalnızca
//     anlatım içindir: geriye dönük testte lig gücü modeli bu bilgiyi zaten taşıyor; son 5 maçın gol "ivmesi" ise
//     tahmini kötüleştiriyor (şanslı seriler ortalamaya döner). İsabetli şut ivmesi ise bilgi taşıyor (ratings.js).

const DAY = 86400000;

export const CONTEXT = Object.freeze({
  // Lig durumunun hesaba girdiği eşik: sezonun bu kadarı oynanmış olmalı
  lateShare: 0.6,
  // Gol çarpanları (atak: takımın attığı; savunma: takımın yediği). Referans: düşme hattı (1,00).
  stakes: {
    att: { title: 1.031, europe: 0.993, mid: 1.034, danger: 1 },
    def: { title: 0.966, europe: 1.027, mid: 1.081, danger: 1 },
  },
  // Turnuva aşaması: toplam gol çarpanı
  stage: { relegation: 0.88, promotion: 0.97, firstLeg: 0.95, final: 0.93 },
  // Rotasyon / yorgunluk: [atak, savunma] çarpanları
  rotation: {
    beforeEurope: [0.95, 1.03], // lig maçı, 3 gün içinde Avrupa maçı var
    beforeEuropeMid: [0.93, 1.05], // ... ve ligde hedefi kalmamış
    afterEurope: [0.97, 1.02], // lig maçı, 3 gün önce Avrupa maçı oynadı
    europeLeagueFirst: [0.96, 1.03], // Avrupa maçı, ligde düşme hattında ve 3 gün içinde lig maçı var
    cupFavourite: [0.94, 1.03], // ulusal kupada alt lig rakibine karşı büyük takım
    tired: [0.97, 1.02], // son maçından bu yana 3 günden az, rakip 5+ gün dinlendi
  },
  windowDays: 3.5,
});

// Lig başına düşme hattı (doğrudan düşen takım sayısı), üst sıralar (doğrudan çıkan) ve Avrupa/play-off hattı
const RELEGATION = { 'eng.1': 3, 'eng.2': 3, 'eng.3': 4, 'eng.4': 2, 'esp.1': 3, 'esp.2': 4, 'ger.1': 2, 'ger.2': 2, 'ita.1': 3, 'ita.2': 3, 'fra.1': 2, 'fra.2': 2, 'ned.1': 2, 'por.1': 2, 'tur.1': 4, 'tur.2': 3, 'bel.1': 2, 'sco.1': 1, 'gre.1': 2, 'rus.1': 2, 'aut.1': 1, 'sui.1': 1, 'den.1': 2, 'swe.1': 2, 'nor.1': 2 };
const PROMOTION = { 'eng.2': 2, 'eng.3': 2, 'eng.4': 3, 'esp.2': 2, 'ger.2': 2, 'ita.2': 2, 'fra.2': 2, 'tur.2': 2 };
const RACE_LINE = { 'eng.2': 6, 'eng.3': 6, 'eng.4': 7, 'esp.2': 6, 'ger.2': 3, 'ita.2': 8, 'fra.2': 5, 'tur.2': 6 };

export const CUPS = /^(eng\.(fa|league_cup)|esp\.copa_del_rey|ita\.coppa_italia|ger\.dfb_pokal|fra\.coupe_de_france|tur\.cup|.*\.cup)$/;
export const CONTINENTAL = /^(uefa\.(champions|europa|europa\.conf)|conmebol\.(libertadores|sudamericana)|concacaf\.champions|afc\.champions|caf\.champions)/;
export const EUROPE_COMPS = ['uefa.champions', 'uefa.europa', 'uefa.europa.conf'];
const COMP_NAME = { 'uefa.champions': 'Şampiyonlar Ligi', 'uefa.europa': 'Avrupa Ligi', 'uefa.europa.conf': 'Konferans Ligi' };
export const compName = (slug) => COMP_NAME[slug] ?? (CONTINENTAL.test(slug) ? 'kıta turnuvası' : CUPS.test(slug) ? 'kupa' : 'lig');

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const tierOf = (league) => Number(String(league ?? '').split('.')[1]) || 1;

/**
 * Takımın lig durumu (saf). table: parseStandings çıktısı. Sezonun [lateShare]'i oynanmadıysa ya da takım tabloda
 * yoksa null. Döner: { label: 'title'|'europe'|'danger'|'mid', rank, points, played, remaining, gapTop, gapSafe, tier }
 */
export function seasonStakes(table, teamId, league) {
  const e = table?.entries?.get?.(String(teamId));
  if (!e || !fin(e.points) || !fin(e.played)) return null;
  const list = [...table.entries.values()].filter((x) => fin(x.points)).map((x) => x.points).sort((a, b) => b - a);
  const n = list.length;
  if (n < 8) return null;
  const rounds = 2 * (n - 1);
  if (e.played < CONTEXT.lateShare * rounds) return null;
  const remaining = Math.max(0, rounds - e.played);
  const maxGain = 3 * remaining;
  const k = RELEGATION[league] ?? 2;
  const tier = tierOf(league);
  const safeLine = list[Math.max(0, n - k - 1)];
  const topN = PROMOTION[league] ?? 1;
  const topLine = list[Math.min(n - 1, topN - 1)];
  const raceLine = list[Math.min(n - 1, (RACE_LINE[league] ?? 6) - 1)];
  const pts = e.points;
  const title = pts >= topLine - maxGain * 0.5 || topLine - pts <= 0;
  const danger = pts <= safeLine + maxGain * 0.35;
  const race = Math.abs(pts - raceLine) <= maxGain * 0.35;
  const label = danger ? 'danger' : title ? 'title' : race ? 'europe' : 'mid';
  return { label, rank: e.rank ?? null, points: pts, played: e.played, remaining, gapTop: list[0] - pts, gapSafe: pts - safeLine, tier, teams: n };
}

/** Lig durumundan gol çarpanları (saf): { home: [atak, savunma], away: [...] } ya da durum yoksa null. */
export function stakesFactors(home, away) {
  if (!home || !away) return null;
  const S = CONTEXT.stakes;
  return { home: [S.att[home.label], S.def[home.label]], away: [S.att[away.label], S.def[away.label]] };
}

/**
 * Turnuva aşaması (saf). league: lig kimliği, stage: maç notu ("Championship Play-Off Semi-Final 1st Leg",
 * "Relegation Playoff", "Final" ...). Döner: { kind, leg, final, total, label } ya da sıradan lig maçıysa null.
 */
export function stageOf(league, stage = '') {
  const s = String(stage ?? '').toLowerCase();
  const out = { kind: null, leg: null, final: false, total: 1, label: null };
  if (/relegation|play-?out|baraj|permanence|abstieg|barrage|descenso|salvezza/.test(s)) {
    out.kind = 'relegation';
    out.total *= CONTEXT.stage.relegation;
    out.label = 'Düşme play-off\'u';
  } else if (/promotion|play-?off/.test(s) && !CONTINENTAL.test(league)) {
    out.kind = 'promotion';
    out.total *= CONTEXT.stage.promotion;
    out.label = 'Yükselme play-off\'u';
  } else if (CONTINENTAL.test(league)) {
    out.kind = 'continental';
    out.label = compName(league);
  } else if (CUPS.test(league)) {
    out.kind = 'cup';
    out.label = 'Ulusal kupa';
  }
  if (/1st leg|first leg|ilk maç/.test(s)) {
    out.leg = 1;
    out.total *= CONTEXT.stage.firstLeg;
  } else if (/2nd leg|second leg|rövanş/.test(s)) out.leg = 2;
  if (/\bfinal\b/.test(s) && !/semi|quarter|1\/2|1\/4|yarı|çeyrek/.test(s)) {
    out.final = true;
    out.total *= CONTEXT.stage.final;
  }
  return out.kind || out.leg || out.final ? out : null;
}

/**
 * Fikstür yükü (saf). fixtures: takımın kupa/Avrupa/lig maçları [{ timestamp, league }] (bu maç hariç), kickoff:
 * bu maçın zamanı. Döner: { prev: {days, league}|null, next: {days, league}|null }.
 */
export function scheduleAround(fixtures, kickoff) {
  let prev = null;
  let next = null;
  for (const f of fixtures ?? []) {
    if (!fin(f?.timestamp) || Math.abs(f.timestamp - kickoff) < 3 * 3600e3) continue;
    const days = (f.timestamp - kickoff) / DAY;
    if (days < 0 && (!prev || days > -prev.days)) prev = { days: -days, league: f.league ?? null };
    if (days > 0 && (!next || days < next.days)) next = { days, league: f.league ?? null };
  }
  return { prev, next };
}

/**
 * Rotasyon ve yorgunluk çarpanları (saf). side: { league (bu maçın ligi), sched: scheduleAround, stakes, rank }
 * opp: rakibin aynı bilgileri. Döner: { att, def, reasons: [kod] }.
 */
export function rotationOf(side, opp, { league, homeTier = null, awayTier = null, isHome = true } = {}) {
  const R = CONTEXT.rotation;
  const W = CONTEXT.windowDays;
  let att = 1;
  let def = 1;
  const reasons = [];
  const apply = ([a, d], code) => {
    att *= a;
    def *= d;
    reasons.push(code);
  };
  const s = side?.sched ?? {};
  const europeNext = s.next && s.next.days <= W && EUROPE_OR_CONT(s.next.league);
  const europePrev = s.prev && s.prev.days <= W && EUROPE_OR_CONT(s.prev.league);
  const domestic = !CONTINENTAL.test(league) && !CUPS.test(league);
  if (domestic && europeNext) apply(side?.stakes?.label === 'mid' ? R.beforeEuropeMid : R.beforeEurope, side?.stakes?.label === 'mid' ? 'beforeEuropeMid' : 'beforeEurope');
  else if (domestic && europePrev) apply(R.afterEurope, 'afterEurope');
  if (CONTINENTAL.test(league) && side?.stakes?.label === 'danger' && s.next && s.next.days <= W && !EUROPE_OR_CONT(s.next.league)) apply(R.europeLeagueFirst, 'europeLeagueFirst');
  // Ulusal kupa: üst ligin üst yarısındaki takım, alt basamaktan bir rakibe karşı
  const myTier = isHome ? homeTier : awayTier;
  const oppTier = isHome ? awayTier : homeTier;
  if (CUPS.test(league) && fin(myTier) && fin(oppTier) && myTier < oppTier && myTier === 1) apply(R.cupFavourite, 'cupFavourite');
  // Yorgunluk: dinlenme farkı
  const myRest = s.prev?.days;
  const oppRest = opp?.sched?.prev?.days;
  if (fin(myRest) && fin(oppRest) && myRest < 3 && oppRest >= 5) apply(R.tired, 'tired');
  return { att, def, reasons };
}
const EUROPE_OR_CONT = (lg) => Boolean(lg) && CONTINENTAL.test(lg);

/**
 * Son [n] maçın gol ortalamaları (saf, yalnızca anlatım için). matches: takımın maçları (her yarışma),
 * [{ timestamp, homeId, awayId, homeGoals, awayGoals, league }].
 */
export function recentSplits(matches, teamId, now, n = 20) {
  const id = String(teamId);
  const own = (matches ?? [])
    .filter((m) => fin(m.homeGoals) && fin(m.awayGoals) && m.timestamp < now && (String(m.homeId) === id || String(m.awayId) === id))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, n);
  const rows = own.map((m) => {
    const home = String(m.homeId) === id;
    return { home, gf: home ? m.homeGoals : m.awayGoals, ga: home ? m.awayGoals : m.homeGoals, league: m.league ?? null };
  });
  const avg = (xs, k) => (xs.length ? Math.round((xs.reduce((s, x) => s + x[k], 0) / xs.length) * 100) / 100 : null);
  const part = (xs) => ({ n: xs.length, gf: avg(xs, 'gf'), ga: avg(xs, 'ga'), w: xs.filter((x) => x.gf > x.ga).length, d: xs.filter((x) => x.gf === x.ga).length, l: xs.filter((x) => x.gf < x.ga).length });
  const europe = rows.filter((x) => x.league && CONTINENTAL.test(x.league));
  const league = rows.filter((x) => !x.league || (!CONTINENTAL.test(x.league) && !CUPS.test(x.league)));
  return { all: part(rows), home: part(rows.filter((x) => x.home)), away: part(rows.filter((x) => !x.home)), league: part(league), europe: part(europe) };
}

/**
 * Bütün bağlam (saf). input: { league, stage, kickoff, homeTable, awayTable, homeLeague, awayLeague,
 * homeFixtures, awayFixtures, homeMatches, awayMatches }. Döner: { factors: {home:[a,d], away:[a,d], total}, stakes,
 * stage, rotation, splits, notes: [metin] } — notes takım adları verilince build edilir (contextNotes).
 */
export function buildContext(input) {
  const { league, stage = '', kickoff, homeTable = null, awayTable = null, homeLeague = league, awayLeague = league } = input;
  const st = {
    home: seasonStakes(homeTable, input.homeId, homeLeague),
    away: seasonStakes(awayTable, input.awayId, awayLeague),
  };
  // Lig durumu çarpanı yalnızca lig maçında (kupada ve Avrupa'da maçın kendisi lig puanı getirmez)
  const domestic = !CONTINENTAL.test(league) && !CUPS.test(league);
  const sf = domestic ? stakesFactors(st.home, st.away) : null;
  const stg = stageOf(league, stage);
  const sched = { home: scheduleAround(input.homeFixtures, kickoff), away: scheduleAround(input.awayFixtures, kickoff) };
  const tiers = { homeTier: homeLeague ? tierOf(homeLeague) : null, awayTier: awayLeague ? tierOf(awayLeague) : null };
  const rot = {
    home: rotationOf({ sched: sched.home, stakes: st.home }, { sched: sched.away }, { league, ...tiers, isHome: true }),
    away: rotationOf({ sched: sched.away, stakes: st.away }, { sched: sched.home }, { league, ...tiers, isHome: false }),
  };
  const home = [(sf?.home[0] ?? 1) * rot.home.att, (sf?.home[1] ?? 1) * rot.home.def];
  const away = [(sf?.away[0] ?? 1) * rot.away.att, (sf?.away[1] ?? 1) * rot.away.def];
  return {
    factors: { home, away, total: stg?.total ?? 1 },
    stakes: st,
    stakesApplied: Boolean(sf),
    stage: stg,
    schedule: sched,
    rotation: rot,
    splits: {
      home: recentSplits(input.homeMatches, input.homeId, kickoff),
      away: recentSplits(input.awayMatches, input.awayId, kickoff),
    },
  };
}

/**
 * Bağlam çarpanlarını gol beklentilerine uygular (saf): ev λ = λ × atak_ev × savunma_dep × toplam.
 * Toplam çarpanı (play-off, ilk maç, final) iki tarafa eşit uygulanır; güç farkı korunur.
 */
export function applyContext(lh, la, ctx) {
  if (!ctx?.factors) return [lh, la];
  const { home, away, total } = ctx.factors;
  return [lh * home[0] * away[1] * total, la * away[0] * home[1] * total];
}

const STAKE_TEXT = {
  title: (T, s) => (s.tier > 1 ? `${T} üst lig yarışında (${s.rank}. sıra, ${s.remaining} maç kaldı)` : `${T} şampiyonluk yarışında (${s.rank}. sıra, ${s.remaining} maç kaldı)`),
  europe: (T, s) => (s.tier > 1 ? `${T} play-off yarışında (${s.rank}. sıra)` : `${T} Avrupa kupaları yarışında (${s.rank}. sıra)`),
  danger: (T, s) => `${T} düşme hattıyla boğuşuyor (${s.rank}. sıra, kurtuluşa ${s.gapSafe >= 0 ? `${s.gapSafe} puan önde` : `${-s.gapSafe} puan geride`})`,
  mid: (T, s) => `${T} için ligde büyük hedef kalmadı (${s.rank}. sıra)`,
};

const ROT_TEXT = {
  beforeEurope: (T, n) => `${T} ${n} gün sonra Avrupa'da sahada; bu maçta bazı yıldızlarını dinlendirebilir.`,
  beforeEuropeMid: (T, n) => `${T} ${n} gün sonra Avrupa'da oynayacak ve ligde hedefi kalmadı; geniş rotasyon beklenebilir.`,
  afterEurope: (T, n) => `${T} ${n} gün önce Avrupa'da oynadı; yorgunluk ve rotasyon payı var.`,
  europeLeagueFirst: (T) => `${T} ligde düşme hattında; bu Avrupa maçında kadro dinlendirip ligi öne alabilir.`,
  cupFavourite: (T) => `${T} kupada alt lig rakibine karşı genelde yedeklere şans verir; sürpriz payı normalden yüksek.`,
  tired: (T, n) => `${T} son maçından bu yana yalnızca ${n} gün dinlenebildi; rakibi daha dinç.`,
};

/** Bağlamın Türkçe maddeleri (saf). Takım adlarına ek getirilmez. */
export function contextNotes(ctx, H, A) {
  if (!ctx) return [];
  const out = [];
  const st = ctx.stakes ?? {};
  if (ctx.stage?.kind === 'relegation') out.push('Düşme play-off\'u: kaybedenin çok şey kaybedeceği maçlarda takımlar risk almaz, maç genelde kısır geçer.');
  else if (ctx.stage?.kind === 'promotion') out.push('Yükselme play-off\'u: iki takım da kazanmak için oynar; normal lig maçına göre daha açık bir oyun beklenir.');
  if (ctx.stage?.leg === 1) out.push('Eleme turunun ilk maçı: takımlar rövanşı düşünerek temkinli başlar.');
  if (ctx.stage?.final) out.push('Final: tek maçta her şey biter; kontrollü, az pozisyonlu bir oyun beklenir.');
  if (st.home && st.away && ctx.stakesApplied) {
    out.push(`${STAKE_TEXT[st.home.label](H, st.home)}; ${STAKE_TEXT[st.away.label](A, st.away)}.`);
    if (st.home.label === 'danger' && st.away.label === 'danger') out.push('İki takım da düşme hattında: altı puanlık maç, gollerin zor gelmesi beklenir.');
    else if (st.home.label === 'mid' && st.away.label === 'mid') out.push('İki takımın da ligde hedefi kalmadı: baskı yok, maç daha açık geçebilir.');
    else if (st.home.label === 'mid' || st.away.label === 'mid') {
      const calm = st.home.label === 'mid' ? H : A;
      const hungry = st.home.label === 'mid' ? A : H;
      out.push(`Motivasyon farkı ${hungry} lehine: ${calm} savunmada daha fazla açık verebilir.`);
    }
  }
  for (const [side, T] of [['home', H], ['away', A]]) {
    const r = ctx.rotation?.[side];
    const s = ctx.schedule?.[side];
    for (const code of r?.reasons ?? []) {
      const days = code === 'afterEurope' || code === 'tired' ? s?.prev?.days : s?.next?.days;
      const f = ROT_TEXT[code];
      if (f) out.push(f(T, fin(days) ? Math.max(1, Math.round(days)) : 3));
    }
  }
  return out;
}

/** Son 20 maç cümleleri (saf): genel, iç saha/deplasman ve (varsa) lig ile Avrupa ayrımı. */
export function splitNotes(ctx, H, A, { homeVenue = true } = {}) {
  const out = [];
  for (const [side, T, venue] of [['home', H, 'home'], ['away', A, 'away']]) {
    const s = ctx?.splits?.[side];
    if (!s || s.all.n < 6) continue;
    const v = s[venue];
    let t = `${T} son ${s.all.n} maçta ortalama ${s.all.gf} gol attı, ${s.all.ga} gol yedi`;
    if (v.n >= 4 && homeVenue) t += `; ${venue === 'home' ? 'evinde' : 'deplasmanda'} ${v.n} maçta ${v.gf} atıp ${v.ga} yedi (${v.w}G ${v.d}B ${v.l}M)`;
    if (s.europe.n >= 3 && s.league.n >= 3) t += `. Avrupa'da ${s.europe.n} maçta ${s.europe.gf}-${s.europe.ga}, ligde ${s.league.gf}-${s.league.ga}`;
    out.push(`${t}.`);
  }
  return out;
}
