// Testler için ortak sahte veri katmanı ve ESPN (Firebase ve ağ yok).
import { DemoEspn } from '../engine/demo.js';
import { AppError } from '../logic.js';

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

/**
 * Sahte veri katmanı. Jeton yok: erişim abonelik (subscription) ve deneme hakkı (trialUsed) ile.
 * makeStore({ subscription, trialUsed }) — subscription: { plan, until } ya da null.
 */
export function makeStore(opts = {}) {
  const { subscription = null, trialUsed = 0 } = typeof opts === 'number' ? {} : opts;
  const s = {
    users: { u1: { subscription, trialUsed } },
    unlocks: new Set(),
    records: new Map(),
    contents: new Map(),
    specials: new Map(),
    usage: new Map(),
    playTokens: new Map(),
    billing: new Map(),
    saves: 0,
    specialSaves: 0,
    async getContent(k) { return s.contents.get(k) ?? null; },
    async saveContent(k, c) {
      s.saves++;
      if (!s.contents.has(k)) s.contents.set(k, JSON.parse(JSON.stringify(c)));
      return s.contents.get(k);
    },
    async getEditorComment() { return null; },
    async hasUnlock(uid, k, t) { return s.unlocks.has(`${uid}/${k}_${t}`); },
    async hasUnlockId(uid, id) { return s.unlocks.has(`${uid}/${id}`); },
    async getSpecial(k) { return s.specials.get(k) ?? null; },
    async saveSpecial(k, patch) {
      s.specialSaves++;
      const cur = s.specials.get(k) ?? { topics: {} };
      s.specials.set(k, JSON.parse(JSON.stringify({ ...cur, ...patch, topics: { ...cur.topics, ...patch.topics } })));
    },
    async getAccess(uid) {
      const u = s.users[uid];
      return { subscription: u?.subscription ?? null, trialUsed: u?.trialUsed ?? 0 };
    },
    async getSubscription(uid) { return s.users[uid]?.subscription ?? null; },
    async setSubscription(uid, sub) {
      s.users[uid] ??= { subscription: null, trialUsed: 0 };
      s.users[uid].subscription = sub;
    },
    async recordUnlock({ uid, unlockId, record }) {
      const id = `${uid}/${unlockId}`;
      if (s.unlocks.has(id)) return { created: false };
      s.unlocks.add(id);
      s.records.set(id, record);
      return { created: true };
    },
    async useTrial({ uid, unlockId, record, limit }) {
      const u = s.users[uid];
      if (!u) throw new AppError('failed-precondition', 'Profil bulunamadı.');
      const id = `${uid}/${unlockId}`;
      if (s.unlocks.has(id)) return { used: false, trialLeft: Math.max(0, limit - u.trialUsed) };
      if (u.trialUsed >= limit) throw new AppError('subscription-required', 'Ücretsiz deneme hakların bitti.');
      u.trialUsed += 1;
      s.unlocks.add(id);
      s.records.set(id, record);
      return { used: true, trialLeft: Math.max(0, limit - u.trialUsed) };
    },
    async linkPlayToken({ hash, uid, token, productId }) {
      const cur = s.playTokens.get(hash);
      if (cur && cur.uid !== uid) return { ok: false, owner: cur.uid };
      s.playTokens.set(hash, { uid, token, productId });
      s.billing.set(uid, { tokenHash: hash, productId });
      return { ok: true };
    },
    async getPlayToken(hash) { return s.playTokens.get(hash) ?? null; },
    async getBilling(uid) { return s.billing.get(uid) ?? null; },
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

/** Süresi dolmamış abonelik kaydı (testler için). */
export const subscribed = (plan = 'monthly', now = NOW) => ({ plan, until: now + 30 * 86400000, source: 'admin' });

export const fixture = { league: 'demo.1', eventId: '9001', kickoff: new Date(FUTURE).toISOString() };
export const finished = { league: 'demo.1', eventId: '9002', kickoff: new Date(PAST).toISOString() };
