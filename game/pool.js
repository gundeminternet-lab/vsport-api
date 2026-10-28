// Oyun oyuncu havuzu: bölge liglerinin takım kadrolarından (veri kaynağı) oyuncu kartları. Kart puanı OYUN puanıdır
// (gerçek bir derecelendirme değildir): lig gücü, takımın puan durumundaki yeri, oyuncunun sezondaki payı (maç, gol,
// asist), yaş ve oyuncuya özgü sabit küçük bir sapmadan hesaplanır; aynı oyuncu her hesapta aynı puanı alır.
//
// Firestore: game_pool/{lig} = { league, builtAt, players: [kompakt oyuncu] } (haftada bir yenilenir).
// Kompakt oyuncu: { id, n: ad, s: kısa ad, pos: mevki, g: grup, r: puan, st: [6 özellik], c: kulüp, ci: kulüp kimliği,
//                   cl: kulüp logosu, l: lig, na: uyruk, ni: ISO, a: yaş, ph: fotoğraf }

import { LEAGUES } from '../engine/config.js';
import { createRng } from '../engine/rng.js';
import { nation, POOL_LEAGUES } from './nations.js';

export const GROUPS = ['KL', 'DEF', 'OS', 'FV'];
export const POOL_MAX_AGE_MS = 7 * 86400e3;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Veri kaynağının mevki kodu → grup (KL, DEF, OS, FV). */
export function groupOf(abbr, name = '') {
  const a = String(abbr ?? '').toUpperCase();
  const n = String(name ?? '').toLowerCase();
  if (a === 'G' || a === 'GK' || n.includes('goal')) return 'KL';
  if (['D', 'CB', 'LB', 'RB', 'CD', 'CD-L', 'CD-R', 'LWB', 'RWB', 'SW'].includes(a) || n.includes('defend') || n.includes('back')) return 'DEF';
  if (['F', 'ST', 'CF', 'LW', 'RW', 'CF-L', 'CF-R', 'SS'].includes(a) || n.includes('forward') || n.includes('striker') || n.includes('wing')) return 'FV';
  return 'OS';
}

/** Grup içinde ayrıntılı mevki (Türkçe kısaltma). Formadaki numara ipucudur; yoksa oyuncuya özgü sabit seçim. */
export function subPosition(group, jersey, abbr, rng) {
  const a = String(abbr ?? '').toUpperCase();
  const j = Number(jersey);
  if (group === 'KL') return 'KL';
  if (group === 'DEF') {
    if (a === 'LB' || a === 'LWB' || j === 3) return 'SLB';
    if (a === 'RB' || a === 'RWB' || j === 2) return 'SĞB';
    if (['CB', 'CD', 'CD-L', 'CD-R'].includes(a) || [4, 5, 6, 15, 23].includes(j)) return 'STP';
    return rng.next() < 0.5 ? 'STP' : rng.next() < 0.5 ? 'SLB' : 'SĞB';
  }
  if (group === 'FV') {
    if (a === 'LW' || j === 11) return 'SLK';
    if (a === 'RW' || j === 7) return 'SĞK';
    if (['ST', 'CF', 'CF-L', 'CF-R'].includes(a) || j === 9) return 'SNT';
    const x = rng.next();
    return x < 0.5 ? 'SNT' : x < 0.75 ? 'SLK' : 'SĞK';
  }
  if (a === 'DM' || [5, 6, 16].includes(j)) return 'DOS';
  if (a === 'AM' || [10, 20].includes(j)) return 'OOS';
  if (a === 'CM' || [8, 14, 18].includes(j)) return 'MOS';
  const x = rng.next();
  return x < 0.35 ? 'DOS' : x < 0.75 ? 'MOS' : 'OOS';
}

/** Kartın altı özelliği. Saha oyuncusu: HIZ ŞUT PAS DRİ DEF FİZ; kaleci: DAL ELL VUR REF HIZ YER. */
export function cardStats(group, r, rng) {
  const j = () => rng.int(-4, 4);
  const v = (x) => clamp(Math.round(x + j()), 20, 99);
  switch (group) {
    case 'KL':
      return [v(r + 2), v(r), v(r - 8), v(r + 3), v(r - 20), v(r - 1)];
    case 'DEF':
      return [v(r - 6), v(r - 28), v(r - 10), v(r - 12), v(r + 4), v(r + 3)];
    case 'FV':
      return [v(r + 3), v(r + 4), v(r - 7), v(r + 1), v(r - 38), v(r - 4)];
    default:
      return [v(r - 3), v(r - 5), v(r + 4), v(r + 2), v(r - 16), v(r - 2)];
  }
}

/** Kart katmanı: bronz < 65, gümüş 65-74, altın 75-84, elit 85+. */
export function tierOf(r) {
  return r >= 85 ? 'elite' : r >= 75 ? 'gold' : r >= 65 ? 'silver' : 'bronze';
}

/**
 * Oyun puanı (47-92).
 *   strength: lig gücü (engine/config.js LEAGUES; Premier Lig 1.0)   rank/teams: takımın puan durumundaki yeri
 *   share: oyuncunun takımdaki maç payı (0-1; bilinmiyorsa null)      goals/assists: sezon
 */
export function playerRating({ strength = 0.7, rank = null, teams = 18, group = 'OS', age = null, share = null, goals = 0, assists = 0, jersey = null, rng }) {
  let r = 50 + (22 * (strength - 0.6)) / 0.4;
  // Takım gücü: lider +10, sonuncu -2 (puan durumu yoksa ortası)
  const pos = rank && teams > 1 ? (rank - 1) / (teams - 1) : 0.5;
  r += 10 * (1 - pos) - 2;
  // Oyuncunun takımdaki rolü: maç payı ya da forma numarası ipucu
  if (share !== null && Number.isFinite(share)) r += 6 * clamp(share, 0, 1) - 3;
  else {
    const j = Number(jersey);
    if (Number.isFinite(j) && j >= 1 && j <= 11) r += 2;
    else if (Number.isFinite(j) && j >= 30) r -= 4;
  }
  // Hücum katkısı
  if (group === 'FV') r += Math.min(6, goals * 0.6 + assists * 0.4);
  else if (group === 'OS') r += Math.min(5, goals * 0.5 + assists * 0.5);
  else if (group === 'DEF') r += Math.min(2, (goals + assists) * 0.3);
  // Yaş eğrisi
  if (Number.isFinite(age)) r += age < 20 ? -4 : age <= 22 ? -1 : age <= 30 ? 1 : age <= 33 ? 0 : -2;
  r += rng.int(-4, 4);
  return Math.round(clamp(r, 47, 92));
}

const statNum = (list, names) => {
  for (const s of list) {
    if (names.includes(s.name)) {
      const v = Number(s.value ?? s.displayValue);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
};

/** Kadro yanıtındaki oyuncular (düz "athletes" ya da mevki gruplarındaki "items"). */
export function parseRoster(json) {
  const raw = [];
  for (const a of json?.athletes ?? []) {
    if (Array.isArray(a?.items)) raw.push(...a.items);
    else if (a) raw.push(a);
  }
  const out = [];
  for (const a of raw) {
    const name = a.displayName ?? a.fullName;
    if (!a.id || !name) continue;
    // İstatistikler ağaçta {name, value} biçiminde aranır
    const stats = [];
    const walk = (node, depth = 0) => {
      if (!node || depth > 6) return;
      if (Array.isArray(node)) return node.forEach((x) => walk(x, depth + 1));
      if (typeof node === 'object') {
        if (typeof node.name === 'string' && ('value' in node || 'displayValue' in node)) stats.push(node);
        else Object.values(node).forEach((x) => walk(x, depth + 1));
      }
    };
    walk(a.statistics ?? a.stats);
    out.push({
      id: String(a.id),
      name: String(name),
      short: String(a.lastName ?? a.shortName ?? String(name).split(' ').slice(-1)[0]),
      jersey: a.jersey ?? null,
      abbr: a.position?.abbreviation ?? null,
      posName: a.position?.displayName ?? a.position?.name ?? '',
      age: Number.isFinite(Number(a.age)) ? Number(a.age) : null,
      citizenship: a.citizenship ?? a.flag?.alt ?? a.birthPlace?.country ?? null,
      photo: a.headshot?.href ?? null,
      apps: statNum(stats, ['appearances', 'gamesPlayed', 'matchesPlayed', 'starts']),
      goals: statNum(stats, ['totalGoals', 'goals']) ?? 0,
      assists: statNum(stats, ['goalAssists', 'assists']) ?? 0,
    });
  }
  return out;
}

/** Bir takımın kadrosundan kompakt kartlar. team: { id, name, logo }, ctx: { league, strength, rank, teams } */
export function teamCards(players, team, ctx) {
  const maxApps = Math.max(0, ...players.map((p) => p.apps ?? 0));
  return players.map((p) => {
    const rng = createRng(`card:${p.id}`);
    const g = groupOf(p.abbr, p.posName);
    const pos = subPosition(g, p.jersey, p.abbr, rng);
    const share = maxApps >= 3 && p.apps !== null ? p.apps / maxApps : null;
    const r = playerRating({ strength: ctx.strength, rank: ctx.rank, teams: ctx.teams, group: g, age: p.age, share, goals: p.goals, assists: p.assists, jersey: p.jersey, rng });
    const nat = nation(p.citizenship);
    return {
      id: p.id,
      n: p.name,
      s: p.short,
      pos,
      g,
      r,
      st: cardStats(g, r, rng),
      c: team.name,
      ci: String(team.id),
      cl: team.logo ?? null,
      l: ctx.league,
      na: nat.name,
      ni: nat.iso,
      a: p.age,
      ph: p.photo,
    };
  });
}

/** Aramada kullanılan sade biçim (Türkçe harfler ve aksanlar yok sayılır). */
export function fold(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Oyuncu havuzu: liglere göre bellekte; Firestore'dan yüklenir, eskiyse ya da yoksa veri kaynağından kurulur.
 * store: { getPool(league) → doc | null, savePool(league, doc) }   espn: { getTeams, getStandings, getRoster }
 */
export class PlayerPool {
  constructor({ store, espn, leagues = POOL_LEAGUES, now = () => Date.now(), log = console }) {
    this.store = store;
    this.espn = espn;
    this.leagues = leagues;
    this.now = now;
    this.log = log;
    this._byLeague = new Map(); // lig → oyuncular
    this._byId = new Map();
    this._building = null;
    this._loaded = false;
  }

  get size() {
    return this._byId.size;
  }

  get ready() {
    return this._byId.size > 0;
  }

  all() {
    return [...this._byId.values()];
  }

  byId(id) {
    return this._byId.get(String(id)) ?? null;
  }

  league(league) {
    return this._byLeague.get(league) ?? [];
  }

  _set(league, players) {
    for (const p of this._byLeague.get(league) ?? []) this._byId.delete(p.id);
    this._byLeague.set(league, players);
    for (const p of players) this._byId.set(p.id, p);
  }

  /** Arka planda süren kurulum (varsa). */
  get building() {
    return this._building;
  }

  /** Firestore'daki havuzu yükler; eksik ya da eski ligleri arka planda kurar (beklemez; bitince [building] boşalır). */
  async ensure() {
    if (!this._loaded) {
      this._loaded = true;
      for (const lg of this.leagues) {
        try {
          const doc = await this.store.getPool(lg);
          if (doc?.players?.length) this._set(lg, doc.players);
          if (doc?.builtAt) this._builtAt = { ...(this._builtAt ?? {}), [lg]: doc.builtAt };
        } catch (e) {
          this.log.warn?.(`[pool] ${lg} okunamadı: ${e?.message ?? e}`);
        }
      }
    }
    const stale = this.leagues.filter((lg) => !this.league(lg).length || this.now() - (this._builtAt?.[lg] ?? 0) > POOL_MAX_AGE_MS);
    if (stale.length && !this._building) {
      this._building = (async () => {
        for (const lg of stale) {
          try {
            await this.buildLeague(lg);
          } catch (e) {
            this.log.warn?.(`[pool] ${lg} kurulamadı: ${e?.message ?? e}`);
          }
        }
      })().finally(() => {
        this._building = null;
      });
    }
    return null;
  }

  /** Bir ligin bütün takımlarının kadroları → kartlar (en çok 3 eşzamanlı istek). */
  async buildLeague(league) {
    const teams = await this.espn.getTeams(league);
    let table = null;
    try {
      table = await this.espn.getStandings(league);
    } catch {
      table = null;
    }
    const strength = LEAGUES[league]?.strength ?? 0.7;
    const out = [];
    let next = 0;
    const worker = async () => {
      while (next < teams.length) {
        const t = teams[next++];
        try {
          const json = await this.espn.getRoster(league, t.id);
          const players = parseRoster(json);
          const entry = table?.entries?.get?.(String(t.id));
          const rank = entry && Number.isFinite(entry.rank) ? entry.rank : null;
          out.push(...teamCards(players, t, { league, strength, rank, teams: table?.teamCount || teams.length }));
        } catch {
          // bu takımın kadrosu alınamadı
        }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    if (!out.length) throw new Error('kadro bulunamadı');
    const builtAt = this.now();
    this._set(league, out);
    this._builtAt = { ...(this._builtAt ?? {}), [league]: builtAt };
    await this.store.savePool(league, { league, builtAt, players: out });
    return out.length;
  }

  /** Ada göre arama (en az 3 harf), puana göre sıralı. */
  search(q, { limit = 12 } = {}) {
    const want = fold(q);
    if (want.length < 3) return [];
    const hits = [];
    for (const p of this._byId.values()) {
      const f = fold(p.n);
      if (f.includes(want)) hits.push([f.startsWith(want) || f.split(' ').some((w) => w.startsWith(want)) ? 0 : 1, p]);
    }
    hits.sort((a, b) => a[0] - b[0] || b[1].r - a[1].r);
    return hits.slice(0, limit).map(([, p]) => p);
  }

  /** Koşula uyanlardan ağırlıksız rastgele seçim. */
  pick(filter, rng, n = 1, exclude = new Set()) {
    const list = this.all().filter((p) => !exclude.has(p.id) && filter(p));
    const out = [];
    const used = new Set();
    for (let i = 0; i < n && used.size < list.length; i++) {
      let k;
      do k = rng.int(0, list.length - 1);
      while (used.has(k));
      used.add(k);
      out.push(list[k]);
    }
    return out;
  }
}
