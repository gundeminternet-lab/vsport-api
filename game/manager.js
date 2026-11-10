// Menajer modu (Benim 11'im): kariyer ligi, altyapı (genç takım) ve taktik planı.
//
// Kariyer ligi: 8 takımlı, çift devreli (14 hafta) sezon. Kulüp Amatör Lig'den başlar; ilk iki sıra bir üst lige
// çıkar, son iki sıra düşer. Rakipler kurgusal kulüplerdir; güçleri ligin seviyesi ile kulübün en iyi kadrosunun
// gücünün ortasında belirlenir (her ligde rekabet sürer). Kulübün maçı stadyumda oynanır (Kapışma motoru, 'season'
// modu); haftanın diğer maçları aynı gol modeliyle sonuçlanır. Sezon sonunda sıraya göre ödül, yönetim hedefi
// tutarsa prim, menajer tecrübesi.
//
//   game_profiles/{uid}.career  { div, manager: { xp, seasons, titles, promotions, best }, season, history }
//   season: { no, div, startedAt, week, teams: [{ id, name, short, crest, power, me }], table: { id: satır },
//             fixtures: ['0-1,2-3,…' her hafta], results: [{ w, h, a, hg, ag }], objective, done, final }
//
// Altyapı: kulübün genç takımı. Gözlemci her gün ücretsiz bir tarama yapar (ek tarama kredili); 15-17 yaşında, gücü
// düşük ama potansiyeli yüksek kurgusal gençler gelir. Gençler akademide gün geçtikçe gelişir (Altyapı Akademisi
// seviyesiyle hızlanır). A takıma alınan genç, kulübün kartı olur (potansiyeli kartta yazılı, antrenmanla gelişir).
//
//   club.youth  { list: [{ id, n, s, pos, g, age, r0, pot, at }], day, scouts }
//
// Krediler yalnızca oyunlarla kazanılır; burada harcanır ve maç/sezon ödülü olarak kazanılır.

import { AppError } from '../errors.js';
import { ENERGY, matchesLeft } from './energy.js';
import { maskedGenetics, youthBits } from './fog.js';
import { trDay } from '../progress.js';
import { createRng } from '../engine/rng.js';
import { cardStats, subPosition, tierOf } from './pool.js';
import { PLAN_KEYS, TACTICS, duelLambdas } from './match.js';
import { randomCrest } from './club.js';
import { hashStr, staffEffects, staffLevels } from './staff.js';

// ---------------------------------------------------------------------------------------------------------------
// Kariyer ligi
// ---------------------------------------------------------------------------------------------------------------

export const DIVISIONS = [
  { id: 0, name: 'Amatör Lig', base: 63 },
  { id: 1, name: '3. Lig', base: 68 },
  { id: 2, name: '2. Lig', base: 73 },
  { id: 3, name: '1. Lig', base: 78 },
  { id: 4, name: 'Süper Lig', base: 83 },
];

export const SEASON = {
  teams: 8,
  weeks: 14,
  daily: 3,
  win: 350,
  draw: 140,
  loss: 50,
  promote: 2,
  relegate: 2,
  /** Sıraya göre sezon ödülü (ligin seviyesiyle artar). */
  prizes: [5000, 3500, 2500, 1800, 1200, 900, 700, 500],
  objectiveBonus: 1500,
};

export const divisionOf = (div) => DIVISIONS[Math.max(0, Math.min(DIVISIONS.length - 1, Number(div) || 0))];
export const prizeOf = (rank, div) => Math.round((SEASON.prizes[rank - 1] ?? 0) * (1 + 0.3 * Number(div)) / 10) * 10;

/** Menajer seviyesi ve unvanı (tecrübe puanından). */
export function managerLevel(xp) {
  const level = Math.floor(Math.sqrt(Math.max(0, Number(xp) || 0) / 40)) + 1;
  const title = level >= 11 ? 'Efsane menajer' : level >= 8 ? 'Usta menajer' : level >= 5 ? 'Deneyimli menajer' : level >= 3 ? 'Genç menajer' : 'Stajyer menajer';
  const next = 40 * level * level;
  return { level, title, xp: Number(xp) || 0, next };
}
export const MANAGER_XP = { W: 30, D: 10, L: 3, title: 400, promotion: 250, objective: 150 };

// Kurgusal kulüp adları
const NAME_A = ['Liman', 'Kuzey', 'Güney', 'Vadi', 'Ova', 'Çınar', 'Meşe', 'Fırtına', 'Şimşek', 'Yıldız', 'Kartal', 'Doğan', 'Poyraz', 'Lodos', 'Bozkır', 'Kıyı', 'Pınar', 'Zirve', 'Akıncı', 'Sahil'];
const NAME_B = ['Spor', 'SK', 'FK', 'Gücü', 'Gençlik', 'İdman Yurdu', 'Birlik', 'Belediye'];
const shortOf = (name) => {
  const w = name.split(' ');
  const up = (x) => x.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
  return up(w.length > 1 ? `${w[0].slice(0, 2)}${w[1][0]}` : name.slice(0, 3)).replace(/[^\p{L}]/gu, '').slice(0, 3);
};

/** Çift devre fikstür (daire yöntemi): her hafta n/2 maç, [ev, deplasman] takım dizinleri. */
export function roundRobin(n) {
  const ids = Array.from({ length: n }, (_, i) => i);
  const half = [];
  for (let r = 0; r < n - 1; r++) {
    const week = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      week.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    half.push(week);
    ids.splice(1, 0, ids.pop());
  }
  return [...half, ...half.map((w) => w.map(([a, b]) => [b, a]))];
}

const encodeWeek = (w) => w.map(([a, b]) => `${a}-${b}`).join(',');
export const decodeWeek = (s) => String(s ?? '').split(',').filter(Boolean).map((x) => x.split('-').map(Number));

const emptyRow = () => ({ p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 });
const pick = (rng, arr) => arr[rng.int(0, arr.length - 1)];

/** Puan durumu sırası: puan, averaj, atılan gol, ad. */
export function standings(season) {
  return season.teams
    .map((t) => ({ ...t, ...(season.table?.[t.id] ?? emptyRow()) }))
    .sort((a, b) => b.pts - a.pts || b.gf - b.ga - (a.gf - a.ga) || b.gf - a.gf || a.name.localeCompare(b.name, 'tr'));
}

/** Yönetimin hedefi: kadronun güç sırasına göre. */
function objectiveFor(teams) {
  const order = [...teams].sort((a, b) => b.power - a.power);
  const exp = order.findIndex((t) => t.me) + 1;
  if (exp <= 1) return { rank: 1, text: 'Şampiyon ol' };
  if (exp <= 3) return { rank: 2, text: 'İlk iki sırada bitir (üst lige çık)' };
  if (exp <= 5) return { rank: 4, text: 'İlk dörtte bitir' };
  return { rank: 6, text: 'Ligde kal' };
}

/** Yeni sezon: 7 kurgusal rakip, güçleri lig seviyesi ile kadro gücünün ortası çevresinde. */
export function newSeason({ no, div, power, club, seed }) {
  const rng = createRng(`season:${seed}:${no}`);
  const d = divisionOf(div);
  const mean = 0.5 * d.base + 0.5 * power;
  const spread = [-3.5, -2.2, -1, 0, 1, 2.2, 3.5].sort(() => rng.next() - 0.5);
  const usedNames = new Set();
  const teams = [{ id: 'me', name: club.name, short: club.short ?? shortOf(club.name), crest: club.crest ?? null, power: Math.round(power * 10) / 10, me: true }];
  for (let i = 0; i < SEASON.teams - 1; i++) {
    let name;
    do name = `${pick(rng, NAME_A)} ${pick(rng, NAME_B)}`;
    while (usedNames.has(name) || name === club.name);
    usedNames.add(name);
    const p = Math.max(55, Math.min(92, mean + spread[i] + (rng.next() - 0.5)));
    teams.push({ id: `t${i + 1}`, name, short: shortOf(name), crest: randomCrest(rng), power: Math.round(p * 10) / 10, me: false });
  }
  // Fikstürde kulübün yeri rastgele
  const order = teams.map((t) => t.id).sort(() => rng.next() - 0.5);
  const sorted = order.map((id) => teams.find((t) => t.id === id));
  return {
    no,
    div: d.id,
    week: 0,
    teams: sorted,
    table: Object.fromEntries(sorted.map((t) => [t.id, emptyRow()])),
    fixtures: roundRobin(SEASON.teams).map(encodeWeek),
    results: [],
    objective: objectiveFor(sorted),
    done: false,
    final: null,
  };
}

/** Poisson çekilişi (rng.next ile). */
function poisson(l, rng) {
  const L = Math.exp(-l);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.next();
  } while (p > L && k < 12);
  return k - 1;
}

function addResult(table, h, a, hg, ag) {
  const H = { ...(table[h] ?? emptyRow()) };
  const A = { ...(table[a] ?? emptyRow()) };
  H.p++;
  A.p++;
  H.gf += hg;
  H.ga += ag;
  A.gf += ag;
  A.ga += hg;
  if (hg > ag) {
    H.w++;
    A.l++;
    H.pts += 3;
  } else if (hg < ag) {
    A.w++;
    H.l++;
    A.pts += 3;
  } else {
    H.d++;
    A.d++;
    H.pts++;
    A.pts++;
  }
  return { ...table, [h]: H, [a]: A };
}

/** Haftanın kulübün maçı: { home, away, meHome, opponent } ya da null (sezon bitti). */
export function nextFixture(season) {
  if (!season || season.done || season.week >= SEASON.weeks) return null;
  const week = decodeWeek(season.fixtures[season.week]);
  const meIdx = season.teams.findIndex((t) => t.me);
  const m = week.find(([h, a]) => h === meIdx || a === meIdx);
  if (!m) return null;
  const [h, a] = m;
  const opp = season.teams[h === meIdx ? a : h];
  return { week: season.week + 1, meHome: h === meIdx, home: season.teams[h], away: season.teams[a], opponent: opp };
}

/**
 * Kulübün maç sonucunu işler, haftanın diğer maçlarını oynatır, haftayı ilerletir; sezon biterse sonucu hesaplar.
 * myGoals/oppGoals: kulübün attığı ve yediği. Döner: yeni sezon nesnesi.
 */
export function playWeek(season, myGoals, oppGoals, seed) {
  const s = { ...season, table: { ...season.table }, results: [...season.results] };
  const w = s.week;
  const week = decodeWeek(s.fixtures[w]);
  const meIdx = s.teams.findIndex((t) => t.me);
  week.forEach(([h, a], i) => {
    let hg;
    let ag;
    if (h === meIdx || a === meIdx) {
      [hg, ag] = h === meIdx ? [myGoals, oppGoals] : [oppGoals, myGoals];
    } else {
      const rng = createRng(`week:${seed}:${s.no}:${w}:${i}`);
      const l = duelLambdas(s.teams[h].power, s.teams[a].power, 'dengeli', 'dengeli');
      hg = poisson(l.home * 1.05, rng);
      ag = poisson(l.away * 0.95, rng);
    }
    s.table = addResult(s.table, s.teams[h].id, s.teams[a].id, hg, ag);
    s.results.push({ w: w + 1, h, a, hg, ag });
  });
  s.week = w + 1;
  if (s.week >= SEASON.weeks) {
    const rows = standings(s);
    const rank = rows.findIndex((t) => t.me) + 1;
    const top = s.div < DIVISIONS.length - 1 && rank <= SEASON.promote;
    const down = s.div > 0 && rank > SEASON.teams - SEASON.relegate;
    s.done = true;
    s.final = {
      rank,
      points: rows[rank - 1].pts,
      prize: prizeOf(rank, s.div),
      objectiveMet: rank <= s.objective.rank,
      bonus: rank <= s.objective.rank ? Math.round((SEASON.objectiveBonus * (1 + 0.25 * s.div)) / 10) * 10 : 0,
      promoted: top,
      relegated: down,
      champion: rank === 1,
      nextDiv: top ? s.div + 1 : down ? s.div - 1 : s.div,
    };
  }
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Altyapı
// ---------------------------------------------------------------------------------------------------------------

export const YOUTH = { freePerDay: 1, extraCost: 400, extraPerDay: 3, ageMin: 15, ageMax: 17 };
export const youthCap = (academyLevel) => 3 + Math.floor(Math.max(1, Number(academyLevel) || 1) / 2);
/** Gencin bugünkü gücü: akademide geçen günle artar (akademi seviyesiyle hızlanır); potansiyelin 2 altında durur. */
export const youthRating = (y, now, academyLevel) => {
  const days = Math.max(0, Math.floor((now - Number(y.at ?? now)) / 86400e3));
  const rate = 0.3 + 0.05 * Math.max(1, Number(academyLevel) || 1);
  return Math.min(Math.max(y.r0, y.pot - 2), y.r0 + Math.floor(days * rate));
};

const FIRST = ['Emir', 'Yusuf', 'Eymen', 'Kerem', 'Alp', 'Aras', 'Çınar', 'Mert', 'Efe', 'Berk', 'Arda', 'Kuzey', 'Deniz', 'Batu', 'Tuna', 'Doruk', 'Ege', 'Atlas', 'Rüzgar', 'Aybars', 'Oğuz', 'Selim', 'Kaan', 'Toprak'];
const LAST = ['Yıldırım', 'Aksoy', 'Kaplan', 'Er', 'Sönmez', 'Tekin', 'Ateş', 'Bulut', 'Çelik', 'Duman', 'Kara', 'Öztürk', 'Tan', 'Uçar', 'Ekinci', 'Avcı', 'Bayram', 'Coşkun', 'Erdem', 'Güneş', 'Işık', 'Kılınç', 'Şahin', 'Yalın'];
const GROUP_W = [['KL', 0.1], ['DEF', 0.32], ['OS', 0.33], ['FV', 0.25]];

/** Bir genç aday (kurgusal). */
export function makeProspect({ seed, id, academyLevel, scoutLevel, now }) {
  const rng = createRng(`youth:${seed}:${id}`);
  let x = rng.next();
  let g = 'OS';
  for (const [k, w] of GROUP_W) {
    x -= w;
    if (x <= 0) {
      g = k;
      break;
    }
  }
  const ac = Math.max(1, Number(academyLevel) || 1);
  const sc = staffEffects({ scout: scoutLevel });
  const first = pick(rng, FIRST);
  const last = pick(rng, LAST);
  const r0 = 44 + Math.floor(ac * 0.8) + rng.int(0, 6);
  const pot = Math.min(94, 64 + Math.round(ac * 1.6) + sc.scoutPot + rng.int(0, 12));
  // gk: genetik anahtarı (A takıma alınınca kartın pid'i olur; genetik aynı kalır)
  return { id, gk: `youth-${hashStr(String(seed))}-${id}`, n: `${first} ${last}`, s: `${first[0]}. ${last}`, pos: subPosition(g, null, null, rng), g, age: rng.int(YOUTH.ageMin, YOUTH.ageMax), r0, pot: Math.max(pot, r0 + 6), at: now };
}

/** Gencin görünümü (bugünkü güç ve özelliklerle). */
export function prospectView(y, now, academyLevel) {
  const r = youthRating(y, now, academyLevel);
  // Genetik sisi: akademinin gözlemcisi seviyesine göre genetiğin bir kısmını görür
  const gen = maskedGenetics({ pid: y.gk ?? `youth-?-${y.id}`, youth: true, g: y.g }, youthBits(academyLevel));
  return { id: y.id, gk: y.gk ?? null, name: y.n, short: y.s, pos: y.pos, g: y.g, age: y.age, r, pot: y.pot, st: cardStats(y.g, r, createRng(`ys:${y.id}`)), star: y.pot >= 85, days: Math.max(0, Math.floor((now - Number(y.at ?? now)) / 86400e3)), gen };
}

// ---------------------------------------------------------------------------------------------------------------
// Taktik planı
// ---------------------------------------------------------------------------------------------------------------

export function checkPlan(raw) {
  if (!raw || typeof raw !== 'object') throw new AppError('invalid-argument', 'Taktik planı eksik.');
  const style = raw.style ?? 'dengeli';
  if (!TACTICS[style]) throw new AppError('invalid-argument', 'Geçersiz oyun anlayışı.');
  const plan = { style };
  for (const k of PLAN_KEYS) {
    const v = Number(raw[k] ?? 3);
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new AppError('invalid-argument', 'Taktik ayarları 1 ile 5 arasında olmalı.');
    plan[k] = v;
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------------------------------------------

export class ManagerService {
  /** game: GameService (profil, kredi, kadro gücü ve yapay takım kurma için) */
  constructor({ game }) {
    this.game = game;
  }

  get store() {
    return this.game.store;
  }

  now() {
    return this.game.now();
  }

  _career(p) {
    const c = p.career ?? {};
    return { div: Number(c.div ?? 0), manager: { xp: 0, seasons: 0, titles: 0, promotions: 0, best: 0, ...(c.manager ?? {}) }, season: c.season ?? null, history: Array.isArray(c.history) ? c.history : [] };
  }

  /** Uygulamaya giden kariyer görünümü. */
  careerView(p, daily = null) {
    const c = this._career(p);
    const s = c.season;
    const fx = nextFixture(s);
    const rows = s ? standings(s) : [];
    return {
      division: divisionOf(c.div).name,
      div: c.div,
      divisions: DIVISIONS.map((d) => d.name),
      manager: { ...managerLevel(c.manager.xp), seasons: c.manager.seasons, titles: c.manager.titles, promotions: c.manager.promotions },
      // Günlük sınır yok: kalan kariyer maçı enerjiye göre (energy.js)
      left: matchesLeft(p.energy, this.now(), 'season'),
      daily: Math.floor(ENERGY.max / ENERGY.cost.season),
      energyCost: ENERGY.cost.season,
      rewards: { win: SEASON.win, draw: SEASON.draw, loss: SEASON.loss },
      season: s
        ? {
            no: s.no,
            division: divisionOf(s.div).name,
            week: s.week,
            weeks: SEASON.weeks,
            done: s.done === true,
            objective: s.objective,
            final: s.final ?? null,
            next: fx ? { week: fx.week, home: fx.meHome, opponent: { id: fx.opponent.id, name: fx.opponent.name, short: fx.opponent.short, crest: fx.opponent.crest, power: fx.opponent.power } } : null,
            table: rows.map((t, i) => ({ rank: i + 1, id: t.id, name: t.name, short: t.short, crest: t.crest, me: t.me === true, p: t.p, w: t.w, d: t.d, l: t.l, gf: t.gf, ga: t.ga, pts: t.pts, power: t.power, zone: i < SEASON.promote && s.div < DIVISIONS.length - 1 ? 'up' : i >= SEASON.teams - SEASON.relegate && s.div > 0 ? 'down' : null })),
            last: s.results
              .filter((r) => r.w === s.week)
              .map((r) => ({ home: s.teams[r.h].name, away: s.teams[r.a].name, hg: r.hg, ag: r.ag, me: s.teams[r.h].me === true || s.teams[r.a].me === true })),
          }
        : null,
      history: c.history.slice(0, 10),
      prizes: SEASON.prizes.map((_, i) => prizeOf(i + 1, c.div)),
    };
  }

  /** Kariyer durumu (kariyer ekranı). */
  async state({ uid, guest = false }) {
    this.game._member(uid, guest);
    const p = await this.game._profile(uid);
    this.game._needClub(p);
    const daily = await this.store.getDaily(uid, trDay(this.now()));
    return { career: this.careerView(p, daily), credits: Number(p.credits ?? 0) };
  }

  /** Yeni sezonu başlat (ilk sezon ya da önceki sezon bittikten sonra). Rakipler kadronun gücüne göre kurulur. */
  async start({ uid, guest = false }) {
    this.game._member(uid, guest);
    const p = await this.game._profile(uid);
    this.game._needClub(p);
    const c = this._career(p);
    if (c.season && !c.season.done) throw new AppError('failed-precondition', 'Sezon sürüyor; önce bu sezonu tamamla.');
    const [cards, squads] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid)]);
    const best = this.game._bestSquad(squads, cards);
    if (!best) throw new AppError('failed-precondition', 'Sezona başlamak için önce 11 kişilik bir kadro kur.');
    const no = Number(c.season?.no ?? 0) + 1;
    const season = newSeason({ no, div: c.div, power: best.power, club: p.club, seed: uid });
    const career = { div: c.div, manager: c.manager, season, history: c.history };
    await this.store.updateProfile(uid, { career });
    p.career = career;
    const daily = await this.store.getDaily(uid, trDay(this.now()));
    return { career: this.careerView(p, daily) };
  }

  /** Sezonun sıradaki rakibi, maç motoru için kadrosuyla (aynı sezon aynı kadro). */
  opponentFor(uid, p) {
    const c = this._career(p);
    const fx = nextFixture(c.season);
    if (!fx) throw new AppError('failed-precondition', c.season?.done ? 'Sezon bitti; Kariyer ekranından yeni sezona başla.' : 'Önce Kariyer ekranından sezona başla.');
    const o = fx.opponent;
    const team = this.game._aiTeam({ name: o.name, crest: o.crest, power: o.power, seed: `season:${uid}:${c.season.no}:${o.id}` });
    return { ...team, league: divisionOf(c.season.div).name, fixture: fx };
  }

  /** Kariyer maçının sonucunu işler (Kapışma bitince). Döner: { season (görünüm), final, managerXp, prize }. */
  async record(uid, p, myGoals, oppGoals) {
    const c = this._career(p);
    if (!c.season || c.season.done) return null;
    const season = playWeek(c.season, myGoals, oppGoals, uid);
    const result = myGoals > oppGoals ? 'W' : myGoals === oppGoals ? 'D' : 'L';
    const manager = { ...c.manager, xp: c.manager.xp + MANAGER_XP[result] };
    let div = c.div;
    let history = c.history;
    let prize = 0;
    if (season.done && season.final) {
      const f = season.final;
      manager.seasons++;
      if (f.champion) manager.titles++;
      if (f.promoted) manager.promotions++;
      manager.best = Math.max(Number(manager.best ?? 0), f.promoted ? f.nextDiv : season.div);
      manager.xp += (f.champion ? MANAGER_XP.title : 0) + (f.promoted ? MANAGER_XP.promotion : 0) + (f.objectiveMet ? MANAGER_XP.objective : 0);
      div = f.nextDiv;
      prize = f.prize + f.bonus;
      history = [{ no: season.no, division: divisionOf(season.div).name, rank: f.rank, points: f.points, prize, promoted: f.promoted, relegated: f.relegated, champion: f.champion }, ...history].slice(0, 20);
    }
    const career = { div, manager, season, history };
    await this.store.updateProfile(uid, { career });
    p.career = career;
    if (prize > 0) await this.game._earn(uid, p, prize, await this.game._pro(uid));
    return { final: season.final ?? null, prize, managerXp: MANAGER_XP[result], view: this.careerView(p) };
  }

  // ---- Altyapı -----------------------------------------------------------------------------------------------

  _youth(club) {
    const y = club?.youth ?? {};
    return { list: Array.isArray(y.list) ? y.list : [], day: y.day ?? null, scouts: Number(y.scouts ?? 0) };
  }

  youthView(club, now) {
    const y = this._youth(club);
    const ac = Number(club?.levels?.academy ?? 1);
    const today = trDay(now);
    const used = y.day === today ? y.scouts : 0;
    const scout = staffLevels(club).scout;
    return {
      list: y.list.map((x) => prospectView(x, now, ac)).sort((a, b) => b.pot - a.pot),
      cap: youthCap(ac),
      academy: ac,
      scout,
      free: used < YOUTH.freePerDay,
      extraLeft: Math.max(0, YOUTH.freePerDay + YOUTH.extraPerDay - used),
      extraCost: YOUTH.extraCost,
      perScout: 1 + (ac >= 5 ? 1 : 0) + staffEffects({ scout }).scoutExtra,
      growth: Math.round((0.3 + 0.05 * ac) * 70) / 10, // 7 günde beklenen gelişim
    };
  }

  async youthState({ uid, guest = false }) {
    const p = await this.game.club._club(uid, guest);
    return { youth: this.youthView(p.club, this.now()), credits: Number(p.credits ?? 0) };
  }

  /** Gözlemci taraması: günde bir ücretsiz, sonra ücretli. Yeni gençler akademiye katılır (yer varsa). */
  async youthScout({ uid, guest = false }) {
    const p = await this.game.club._club(uid, guest);
    const now = this.now();
    const today = trDay(now);
    const y = this._youth(p.club);
    const used = y.day === today ? y.scouts : 0;
    if (used >= YOUTH.freePerDay + YOUTH.extraPerDay) throw new AppError('resource-exhausted', 'Bugünkü taramalar bitti; gözlemci yarın yeni gençlerle döner.');
    const ac = Number(p.club.levels?.academy ?? 1);
    const cap = youthCap(ac);
    if (y.list.length >= cap) throw new AppError('failed-precondition', `Altyapı dolu (${cap} genç). Bir genci A takıma al ya da serbest bırak; Altyapı Akademisi'ni geliştirerek yer açılır.`);
    const free = used < YOUTH.freePerDay;
    let balance = Number(p.credits ?? 0);
    if (!free) balance = await this.store.changeCredits(uid, -YOUTH.extraCost, { earn: false });
    const scout = staffLevels(p.club).scout;
    const count = Math.min(cap - y.list.length, 1 + (ac >= 5 ? 1 : 0) + staffEffects({ scout }).scoutExtra);
    const found = [];
    for (let i = 0; i < count; i++) {
      const id = `y${today.replace(/-/g, '')}${used}${i}${hashStr(`${uid}:${now}:${i}`) % 1000}`;
      found.push(makeProspect({ seed: uid, id, academyLevel: ac, scoutLevel: scout, now }));
    }
    const club = { ...p.club, youth: { list: [...y.list, ...found], day: today, scouts: used + 1 } };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return { found: found.map((x) => prospectView(x, now, ac)), cost: free ? 0 : YOUTH.extraCost, balance, youth: this.youthView(club, now) };
  }

  /** Genci A takıma al: kulübün kartı olur (potansiyeli kartta). */
  async youthPromote({ uid, guest = false, id }) {
    const p = await this.game.club._club(uid, guest);
    const now = this.now();
    const y = this._youth(p.club);
    const x = y.list.find((k) => k.id === id);
    if (!x) throw new AppError('not-found', 'Genç oyuncu bulunamadı.');
    const ac = Number(p.club.levels?.academy ?? 1);
    const v = prospectView(x, now, ac);
    const card = {
      // Genetiğin akademide görülen kısmı kartta açık kalır
      gx: youthBits(ac),
      pid: x.gk ?? `youth-${hashStr(uid)}-${x.id}`,
      n: x.n,
      s: x.s,
      pos: x.pos,
      g: x.g,
      r: v.r,
      st: v.st,
      c: p.club.name,
      ci: `club-${hashStr(uid)}`,
      cl: null,
      l: 'Altyapı',
      na: null,
      ni: null,
      ph: null,
      tier: tierOf(v.r),
      youth: true,
      a: x.age,
      pot: x.pot,
    };
    const { ids } = await this.store.purchase(uid, 0, [card]);
    const club = { ...p.club, youth: { ...y, list: y.list.filter((k) => k.id !== id) } };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return { card: { id: ids[0], ...card }, youth: this.youthView(club, now) };
  }

  async youthRelease({ uid, guest = false, id }) {
    const p = await this.game.club._club(uid, guest);
    const y = this._youth(p.club);
    if (!y.list.some((k) => k.id === id)) throw new AppError('not-found', 'Genç oyuncu bulunamadı.');
    const club = { ...p.club, youth: { ...y, list: y.list.filter((k) => k.id !== id) } };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return { youth: this.youthView(club, this.now()) };
  }

  // ---- Taktik planı ------------------------------------------------------------------------------------------

  /** Kadronun taktik planını kaydeder (oyun anlayışı + pres, savunma çizgisi, genişlik, tempo). */
  async setPlan({ uid, guest = false, squadId, plan }) {
    this.game._member(uid, guest);
    const clean = checkPlan(plan);
    const squads = await this.store.listSquads(uid);
    const s = squads.find((x) => x.id === squadId);
    if (!s) throw new AppError('not-found', 'Kadro bulunamadı.');
    const { id, updatedAt, at, ...data } = s;
    await this.store.saveSquad(uid, squadId, { ...data, plan: clean });
    return { squadId, plan: clean };
  }
}
