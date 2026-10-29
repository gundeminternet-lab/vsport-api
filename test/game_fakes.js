// Oyun testleri için bellek içi depo ve yapay oyuncu havuzu.
import { AppError } from '../errors.js';
import { createRng } from '../engine/rng.js';
import { PlayerPool, cardStats } from '../game/pool.js';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function deepMerge(a, b) {
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.__inc === undefined) out[k] = deepMerge(out[k], v);
    else if (v && v.__inc !== undefined) out[k] = Number(out[k] ?? 0) + v.__inc;
    else out[k] = v;
  }
  return out;
}

export function memoryGameStore({ users = {} } = {}) {
  const s = {
    users: { ...users },
    profiles: new Map(),
    daily: new Map(),
    cards: new Map(), // uid → Map(id → card)
    squads: new Map(),
    days: new Map(),
    boards: new Map(), // pid → Map(uid → entry)
    photo: new Map(),
    quiz: new Map(),
    duelPool: new Map(),
    pools: new Map(),
    seq: 0,
    async getUser(uid) {
      return clone(s.users[uid] ?? null);
    },
    async getProfile(uid) {
      return clone(s.profiles.get(uid) ?? null);
    },
    async createProfile(uid, data) {
      if (!s.profiles.has(uid)) s.profiles.set(uid, clone(data));
      return clone(s.profiles.get(uid));
    },
    async updateProfile(uid, patch) {
      s.profiles.set(uid, { ...(s.profiles.get(uid) ?? {}), ...clone(patch) });
    },
    async changeCredits(uid, delta, { periods = [], user = {}, earn = true } = {}) {
      const p = s.profiles.get(uid) ?? {};
      const cur = Number(p.credits ?? 0);
      if (cur + delta < 0) throw new AppError('failed-precondition', 'Yetersiz kredi.');
      p.credits = cur + delta;
      if (delta > 0 && earn) {
        p.earnedTotal = Number(p.earnedTotal ?? 0) + delta;
        for (const pid of periods) {
          const b = s.boards.get(pid) ?? new Map();
          const e = b.get(uid) ?? { earned: 0 };
          b.set(uid, { ...e, earned: e.earned + delta, username: user.username ?? null, usernameLower: user.username?.toLowerCase() ?? null, pro: user.pro === true });
          s.boards.set(pid, b);
        }
      }
      s.profiles.set(uid, p);
      return p.credits;
    },
    async purchase(uid, cost, cards) {
      const p = s.profiles.get(uid) ?? {};
      const cur = Number(p.credits ?? 0);
      if (cur < cost) throw new AppError('failed-precondition', 'Yetersiz kredi.');
      p.credits = cur - cost;
      s.profiles.set(uid, p);
      const m = s.cards.get(uid) ?? new Map();
      const ids = cards.map((c) => {
        const id = `c${++s.seq}`;
        m.set(id, { ...clone(c), at: { _seconds: 1 } }); // Firestore zaman damgası gibi
        return id;
      });
      s.cards.set(uid, m);
      return { balance: p.credits, ids };
    },
    async getDaily(uid, day) {
      return clone(s.daily.get(`${uid}/${day}`) ?? null);
    },
    async updateDaily(uid, day, patch) {
      const k = `${uid}/${day}`;
      s.daily.set(k, deepMerge(s.daily.get(k), clone(patch)));
    },
    async incrementDaily(uid, day, field, by = 1) {
      const parts = field.split('.');
      const obj = {};
      let cur = obj;
      parts.forEach((k, i) => {
        if (i === parts.length - 1) cur[k] = { __inc: by };
        else cur = cur[k] = {};
      });
      const key = `${uid}/${day}`;
      s.daily.set(key, deepMerge(s.daily.get(key), obj));
    },
    async listCards(uid) {
      return [...(s.cards.get(uid) ?? new Map()).entries()].map(([id, c]) => ({ id, ...clone(c) }));
    },
    async deleteCards(uid, ids) {
      const m = s.cards.get(uid) ?? new Map();
      for (const id of ids) m.delete(id);
    },
    async listSquads(uid) {
      return [...(s.squads.get(uid) ?? new Map()).entries()].map(([id, x]) => ({ id, ...clone(x) }));
    },
    async saveSquad(uid, id, data) {
      const m = s.squads.get(uid) ?? new Map();
      const sid = id ?? `q${++s.seq}`;
      m.set(sid, { ...clone(data), updatedAt: { _seconds: 1 } });
      s.squads.set(uid, m);
      return sid;
    },
    async deleteSquad(uid, id) {
      s.squads.get(uid)?.delete(id);
    },
    async getDay(day) {
      return clone(s.days.get(day) ?? null);
    },
    async setDay(day, data) {
      s.days.set(day, { ...(s.days.get(day) ?? {}), ...clone(data) });
    },
    async boardTop(pid, limit = 50) {
      return [...(s.boards.get(pid) ?? new Map()).entries()]
        .map(([uid, e]) => ({ uid, ...e }))
        .sort((a, b) => b.earned - a.earned)
        .slice(0, limit);
    },
    async boardEntry(pid, uid) {
      const e = s.boards.get(pid)?.get(uid);
      return e ? { uid, ...e } : null;
    },
    async boardRank(pid, earned) {
      return [...(s.boards.get(pid) ?? new Map()).values()].filter((e) => e.earned > earned).length + 1;
    },
    async boardSearch(prefix, limit = 10) {
      return [...(s.boards.get('all') ?? new Map()).entries()]
        .filter(([, e]) => e.usernameLower?.startsWith(prefix.toLowerCase()))
        .slice(0, limit)
        .map(([uid, e]) => ({ uid, ...e }));
    },
    async upsertDuelPool(uid, summary) {
      s.duelPool.set(uid, clone(summary));
    },
    async deleteDuelPool(uid) {
      s.duelPool.delete(uid);
    },
    async queryDuelPool(min, max, limit = 20) {
      return [...s.duelPool.entries()].filter(([, x]) => x.power >= min && x.power <= max).slice(0, limit).map(([uid, x]) => ({ uid, ...x }));
    },
    async addPhotoScore(day, uid, entry) {
      const m = s.photo.get(day) ?? new Map();
      m.set(uid, clone(entry));
      s.photo.set(day, m);
    },
    async topPhoto(day) {
      return [...(s.photo.get(day) ?? new Map()).entries()].map(([uid, e]) => ({ uid, ...e })).sort((a, b) => a.ms - b.ms);
    },
    async addQuizScore(day, uid, entry) {
      const m = s.quiz.get(day) ?? new Map();
      if ((m.get(uid)?.best ?? -1) < entry.best) m.set(uid, clone(entry));
      s.quiz.set(day, m);
    },
    async topQuiz(day) {
      return [...(s.quiz.get(day) ?? new Map()).entries()].map(([uid, e]) => ({ uid, ...e })).sort((a, b) => b.best - a.best);
    },
    async getPool(league) {
      return clone(s.pools.get(league) ?? null);
    },
    async savePool(league, doc) {
      s.pools.set(league, clone(doc));
    },
  };
  return s;
}

const CLUBS = {
  'tur.1': ['Galatasaray', 'Fenerbahçe', 'Beşiktaş', 'Trabzonspor', 'Başakşehir', 'Samsunspor'],
  'eng.1': ['Arsenal', 'Liverpool', 'Chelsea', 'Everton', 'Fulham', 'Brentford'],
};
const NATIONS = ['Türkiye', 'Brezilya', 'Fransa', 'İngiltere', 'Arjantin', 'Portekiz'];

/** Yapay havuz: her lig 6 kulüp × 22 oyuncu (3 KL, 7 DEF, 7 OS, 5 FV), puanlar 50-90 arası. */
export function syntheticPool() {
  const rng = createRng('synthetic');
  const pool = new PlayerPool({ store: { getPool: async () => null, savePool: async () => {} }, espn: null, leagues: [] });
  const groups = [...Array(3).fill('KL'), ...Array(7).fill('DEF'), ...Array(7).fill('OS'), ...Array(5).fill('FV')];
  const pos = { KL: 'KL', DEF: 'STP', OS: 'MOS', FV: 'SNT' };
  let id = 1;
  for (const [league, clubs] of Object.entries(CLUBS)) {
    const players = [];
    clubs.forEach((club, ci) => {
      groups.forEach((g, i) => {
        const r = 50 + ((id * 37 + i * 11) % 41);
        players.push({
          id: String(id),
          n: `Oyuncu ${id}`,
          s: `O${id}`,
          pos: pos[g],
          g,
          r,
          st: cardStats(g, r, rng),
          c: club,
          ci: `${league}-${ci}`,
          cl: null,
          l: league,
          na: league === 'tur.1' && i % 2 === 0 ? 'Türkiye' : NATIONS[(id + i) % NATIONS.length],
          ni: null,
          a: 25,
          ph: `https://img/${id}.png`,
        });
        id++;
      });
    });
    pool._set(league, players);
  }
  pool.ensure = async () => null;
  return pool;
}
