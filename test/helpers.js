// Testler için ortak sahte veri katmanı ve ESPN (Firebase ve ağ yok).
import { DemoEspn } from '../engine/demo.js';
import { AppError } from '../logic.js';
import { specialPrice } from '../special.js';

export const NOW = Date.UTC(2026, 9, 17, 12, 0);
export const FUTURE = NOW + 2 * 86400000;
export const PAST = NOW - 3 * 86400000;

export function makeEspn({ now = NOW } = {}) {
  const espn = new DemoEspn({ now });
  const fixtures = [
    { id: '9001', timestamp: FUTURE, date: new Date(FUTURE).toISOString(), league: 'demo.1', homeId: '1001', awayId: '1002', homeName: 'Demo Ev FK', awayName: 'Demo Dep SK', completed: false },
    { id: '9002', timestamp: PAST, date: new Date(PAST).toISOString(), league: 'demo.1', homeId: '1003', awayId: '1004', homeName: 'Demo Takım 3', awayName: 'Demo Takım 4', completed: true, homeGoals: 2, awayGoals: 1 },
  ];
  espn.getFixtures = async (league, from) => {
    const day = from.toISOString().slice(0, 10);
    return fixtures.filter((f) => f.league === league && new Date(f.timestamp).toISOString().slice(0, 10) === day);
  };
  return espn;
}

export function makeStore(opts = {}) {
  const { tokens = 300, subscription = null } = typeof opts === 'number' ? { tokens: opts } : opts;
  const s = {
    users: { u1: { tokens, subscription } },
    unlocks: new Set(),
    contents: new Map(),
    specials: new Map(),
    usage: new Map(),
    ledger: [],
    saves: 0,
    specialSaves: 0,
    async getContent(k) { return s.contents.get(k) ?? null; },
    async saveContent(k, c) {
      s.saves++;
      if (!s.contents.has(k)) s.contents.set(k, JSON.parse(JSON.stringify(c)));
      return s.contents.get(k);
    },
    async getEditorComment() { return null; },
    async getTokens(uid) { return s.users[uid]?.tokens ?? 0; },
    async hasUnlock(uid, k, t) { return s.unlocks.has(`${uid}/${k}_${t}`); },
    async hasUnlockId(uid, id) { return s.unlocks.has(`${uid}/${id}`); },
    async getSpecial(k) { return s.specials.get(k) ?? null; },
    async saveSpecial(k, patch) {
      s.specialSaves++;
      const cur = s.specials.get(k) ?? { topics: {} };
      s.specials.set(k, JSON.parse(JSON.stringify({ ...cur, ...patch, topics: { ...cur.topics, ...patch.topics } })));
    },
    async purchaseBundle({ uid, items, priceFor }) {
      const missing = items.filter((i) => !s.unlocks.has(`${uid}/${i.unlockId}`));
      if (!missing.length) return { charged: false, balance: s.users[uid].tokens };
      const price = priceFor(missing.length);
      if (s.users[uid].tokens < price) throw new AppError('failed-precondition', 'Yetersiz token');
      s.users[uid].tokens -= price;
      for (const m of missing) s.unlocks.add(`${uid}/${m.unlockId}`);
      s.ledger.push(-price);
      return { charged: price > 0, balance: s.users[uid].tokens };
    },
    async purchase({ uid, unlockId, price }) {
      const id = `${uid}/${unlockId}`;
      if (s.unlocks.has(id)) return { charged: false, balance: s.users[uid].tokens };
      if (s.users[uid].tokens < price) throw new AppError('failed-precondition', 'Yetersiz token');
      s.users[uid].tokens -= price;
      s.unlocks.add(id);
      return { charged: price > 0, balance: s.users[uid].tokens };
    },
    async getSubscription(uid) { return s.users[uid]?.subscription ?? null; },
    async getAssistantUsage(uid, day) { return s.usage.get(`${uid}/${day}`) ?? 0; },
    async bumpAssistantUsage(uid, day, limit) {
      const n = s.usage.get(`${uid}/${day}`) ?? 0;
      if (n >= limit) return { ok: false, used: n };
      s.usage.set(`${uid}/${day}`, n + 1);
      return { ok: true, used: n + 1 };
    },
  };
  return s;
}

export const fixture = { league: 'demo.1', eventId: '9001', kickoff: new Date(FUTURE).toISOString() };
export const finished = { league: 'demo.1', eventId: '9002', kickoff: new Date(PAST).toISOString() };
export { specialPrice };
