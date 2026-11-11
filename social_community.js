// Taraftar toplulukları, Taraftar Savaşı (hangi taraftar daha iyi tahmin ediyor), haftanın ödülleri ve maç sonu
// oyuncu puanlama.
//
//   social_communities/{teamId}             { id, name, logo, league, members }
//   social_profiles/{uid}.team              { id, name, logo, league, joinedMs }   (teamChangedMs: son değişiklik)
//   social_war/{hafta}                      { winner, name, acc, closedMs }  (geçen haftanın sonucu, bir kez yazılır)
//   social_war/{hafta}/teams/{teamId}       { id, name, logo, n, hits, exact, top: { uid, username, n, hits, exact } }
//   social_war/{hafta}/users/{uid}          { team, username, n, hits, exact, claimed }
//   social_war/{hafta}/teams/{teamId}/members/{uid}  { hits, n }   (topluluk içi sıra)
//   social_week/{hafta}                     { bestPost, king, duel }   haftanın ödülleri (en iyi gönderi, tahmin kralı, düello ustası)
//   ratings/{maç}/shards/{0-9}              { players: { pid: { name, teamId, sum, n, f: { takım|x: { sum, n } } } } }
//   ratings/{maç}/users/{uid}               { r: { pid: puan }, team, at }

import { AppError } from './errors.js';
import { WAR, accuracy, cleanTeam, prevWeekOf, warTable, weekOf } from './social_rules.js';

const SHARDS = 10;
const MAX_PLAYERS = 40;

function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Oyuncu anahtarı: takım + sadeleştirilmiş ad (Firestore alan adı olarak güvenli). */
export function playerKey(teamId, name) {
  const base = String(name ?? '')
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base ? `t${teamId}_${base}` : null;
}

export class CommunityService {
  /** reward: async (uid, ödül). */
  constructor({ store, now = () => Date.now(), reward = null, log = console }) {
    this.store = store;
    this.now = now;
    this.reward = reward;
    this.log = log;
    this._lists = null;
  }

  _member(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Topluluklar için Google ile giriş yap.');
  }

  async join({ uid, guest = false, team }) {
    this._member(uid, guest);
    const t = cleanTeam(team);
    if (!t) throw new AppError('invalid-argument', 'Geçersiz takım.');
    const prof = (await this.store.getProfile(uid)) ?? {};
    if (prof.team?.id === t.id) return { team: prof.team };
    const changed = Number(prof.teamChangedMs ?? 0);
    if (prof.team?.id && this.now() - changed < WAR.switchCooldownMs) {
      const days = Math.ceil((WAR.switchCooldownMs - (this.now() - changed)) / 86400e3);
      throw new AppError('failed-precondition', `Topluluğunu ${days} gün sonra değiştirebilirsin.`);
    }
    const next = { ...t, joinedMs: this.now() };
    await this.store.joinTeam(uid, next, prof.team?.id ?? null, this.now());
    this._lists = null;
    return { team: next };
  }

  async leave({ uid, guest = false }) {
    this._member(uid, guest);
    const prof = (await this.store.getProfile(uid)) ?? {};
    if (!prof.team?.id) return { team: null };
    await this.store.joinTeam(uid, null, prof.team.id, this.now());
    this._lists = null;
    return { team: null };
  }

  /** Keşfet: en kalabalık topluluklar (5 dakika saklanır). */
  async list({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (this._lists && this.now() - this._lists.at < 5 * 60e3) return this._lists.value;
    const value = { communities: await this.store.topCommunities(30) };
    this._lists = { at: this.now(), value };
    return value;
  }

  /** Tahmin sonuçlandı (tahmin ligi ya da skor düellosu): isabet sayaçları ve Taraftar Savaşı. */
  async record({ uid, hit, exact = false, username = null }) {
    if (!uid) return null;
    await this.store.bumpProfile(uid, { n: 1, hits: hit ? 1 : 0, exact: exact ? 1 : 0 });
    const prof = await this.store.getProfile(uid);
    const team = prof?.team;
    if (!team?.id) return null;
    const week = weekOf(this.now());
    const me = await this.store.warRecord(week, uid, team, { hit: !!hit, exact: !!exact, username });
    if (me && me.n >= 5) {
      await this.store.weekKing(week, { uid, username: me.username ?? username, acc: accuracy(me.n, me.hits), n: me.n, team: team.name }).catch(() => null);
    }
    return me;
  }

  /** Tahmin ligi puanlaması (her geçerli tahmin için). */
  async recordPrediction({ uid, points, exact = false }) {
    return this.record({ uid, hit: points > 0, exact });
  }

  /** Geçen haftanın kazananı: bir kez hesaplanıp yazılır. */
  async _winner(week) {
    const meta = await this.store.getWarMeta(week);
    if (meta?.closedMs) return meta;
    const table = warTable(await this.store.warTeams(week, 60));
    const top = table.find((t) => t.ranked);
    const value = { winner: top?.id ?? null, name: top?.name ?? null, logo: top?.logo ?? null, acc: top?.acc ?? null, closedMs: this.now() };
    await this.store.setWarMeta(week, value);
    return value;
  }

  /** Topluluk ekranı: benim topluluğum, Taraftar Savaşı tablosu, sıram, haftanın tahmincisi, ödül ve haftanın ödülleri. */
  async state({ uid, guest = false }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const week = weekOf(this.now());
    const prev = prevWeekOf(this.now());
    const prof = guest ? null : await this.store.getProfile(uid);
    const team = prof?.team ?? null;
    const [teams, awards, last] = await Promise.all([this.store.warTeams(week, 60), this.store.getWeek(week).catch(() => null), this._winner(prev).catch(() => null)]);
    const table = warTable(teams);
    const mine = team ? table.find((t) => t.id === team.id) : null;
    let me = null;
    let community = null;
    let prize = null;
    if (team) {
      const [w, c, lastMe] = await Promise.all([this.store.warUser(week, uid), this.store.getCommunity(team.id), last?.winner ? this.store.warUser(prev, uid) : null]);
      const n = Number(w?.n ?? 0);
      const hits = Number(w?.hits ?? 0);
      const rank = n > 0 ? (await this.store.countBetter(week, team.id, hits).catch(() => null)) : null;
      me = { n, hits, exact: Number(w?.exact ?? 0), acc: accuracy(n, hits), rank: rank === null ? null : rank + 1 };
      community = { members: Number(c?.members ?? 0) };
      if (last?.winner) {
        const eligible = lastMe?.team === last.winner && Number(lastMe?.n ?? 0) > 0;
        prize = { week: prev, winner: last.winner, name: last.name, eligible, claimed: lastMe?.claimed === true };
      }
    }
    const row = (t, i) => ({ rank: i + 1, id: t.id, name: t.name, logo: t.logo ?? null, n: t.n, acc: t.acc, ranked: t.ranked });
    return {
      week,
      endsAt: this._weekEnd(),
      team,
      community,
      me,
      top: mine?.top ?? null,
      table: table.slice(0, 8).map(row),
      mine: mine ? row(mine, table.indexOf(mine)) : null,
      lastWinner: last?.winner ? { id: last.winner, name: last.name, acc: last.acc } : null,
      prize,
      awards: { bestPost: awards?.bestPost ?? null, king: awards?.king ?? null, duel: awards?.duel ?? null },
      minPredictions: WAR.minPredictions,
      cooldownUntil: prof?.teamChangedMs ? Number(prof.teamChangedMs) + WAR.switchCooldownMs : null,
    };
  }

  _weekEnd() {
    const now = this.now();
    // Haftanın sonu: Türkiye saatiyle Pazartesi 00:00
    const tr = now + 3 * 3600e3;
    const d = new Date(tr);
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Pazartesi
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * 86400e3;
    return start + 7 * 86400e3 - 3 * 3600e3;
  }

  /** Geçen haftanın kazanan topluluğundaki (o hafta en az bir tahmini olan) üyelere Altın Paket jetonu (bir kez). */
  async claim({ uid, guest = false }) {
    this._member(uid, guest);
    const prev = prevWeekOf(this.now());
    const last = await this._winner(prev);
    if (!last?.winner) throw new AppError('failed-precondition', 'Geçen hafta kazanan topluluk yok.');
    const ok = await this.store.claimWar(prev, uid, last.winner);
    if (ok === 'claimed') throw new AppError('failed-precondition', 'Ödülü zaten aldın.');
    if (ok !== true) throw new AppError('failed-precondition', 'Bu ödül geçen hafta kazanan topluluğun tahmin yapan üyelerine.');
    const reward = this.reward ? await this.reward(uid, WAR.prize) : WAR.prize;
    return { reward };
  }
}

export class RatingService {
  /**
   * matchState: async (league, eventId) → 'pre' | 'in' | 'post' | null (sonuç 5 dakika saklanır).
   * missions: görev sayacı (maç başına bir kez 'rated').
   */
  constructor({ store, now = () => Date.now(), matchState = null, missions = null, log = console }) {
    this.store = store;
    this.now = now;
    this.matchState = matchState;
    this.missions = missions;
    this.log = log;
    this._states = new Map();
  }

  async _state(league, eventId) {
    if (!this.matchState) return 'post';
    const k = `${league}_${eventId}`;
    const hit = this._states.get(k);
    if (hit && this.now() - hit.at < 5 * 60e3) return hit.v;
    const v = await this.matchState(league, eventId).catch(() => null);
    this._states.set(k, { at: this.now(), v });
    if (this._states.size > 500) this._states.clear();
    return v;
  }

  /** Oyuncu puanları (1-10). list: [{ player, teamId, score }]. Maç bitince (ya da ikinci yarıda) açılır. */
  async rate({ uid, guest = false, league, eventId, homeId, awayId, list }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Puanlamak için Google ile giriş yap.');
    const ok = (v) => typeof v === 'string' && /^[0-9]{1,10}$/.test(v);
    if (typeof league !== 'string' || !/^[a-z0-9._]{2,30}$/i.test(league) || !ok(String(eventId ?? '')) || !ok(homeId) || !ok(awayId)) {
      throw new AppError('invalid-argument', 'Geçersiz maç.');
    }
    if (!Array.isArray(list) || !list.length || list.length > 30) throw new AppError('invalid-argument', 'Puan listesi boş.');
    const items = [];
    for (const x of list) {
      const teamId = String(x?.teamId ?? '');
      if (teamId !== homeId && teamId !== awayId) continue;
      const name = typeof x?.player === 'string' ? x.player.trim().slice(0, 40) : '';
      const pid = playerKey(teamId, name);
      if (!pid || !Number.isInteger(x?.score) || x.score < 1 || x.score > 10) continue;
      if (!items.some((i) => i.pid === pid)) items.push({ pid, name, teamId, score: x.score });
    }
    if (!items.length) throw new AppError('invalid-argument', 'Geçerli puan yok.');
    const state = await this._state(league, String(eventId));
    if (state !== 'post' && state !== 'in') throw new AppError('failed-precondition', 'Puanlama maç başladıktan sonra açılır.');
    const key = `${league.replace(/[^a-zA-Z0-9]/g, '_')}_${eventId}`;
    const prof = await this.store.getProfile(uid).catch(() => null);
    const fan = prof?.team?.id === homeId || prof?.team?.id === awayId ? prof.team.id : 'x';
    const shard = hashOf(uid) % SHARDS;
    const r = await this.store.rate(key, uid, shard, { items, fan, homeId, awayId, max: MAX_PLAYERS, at: this.now() });
    if (r === 'full') throw new AppError('failed-precondition', 'Bu maçta puanlanabilecek oyuncu sınırına ulaşıldı.');
    if (r?.first) {
      await this.store.bumpProfile(uid, { rated: 1 }).catch(() => null);
      if (this.missions) await this.missions.track(uid, 'rated').catch(() => null);
    }
    return { key, saved: items.length, first: r?.first === true };
  }
}

export function createCommunityStore(db, FieldValue) {
  const profile = (uid) => db.doc(`social_profiles/${uid}`);
  return {
    async getProfile(uid) {
      const s = await profile(uid).get();
      return s.exists ? s.data() : null;
    },
    async bumpProfile(uid, inc) {
      await profile(uid).set(Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, FieldValue.increment(v)])), { merge: true });
    },
    async getCommunity(id) {
      const s = await db.doc(`social_communities/${id}`).get();
      return s.exists ? s.data() : null;
    },
    async topCommunities(limit) {
      const q = await db.collection('social_communities').orderBy('members', 'desc').limit(limit).get();
      return q.docs.map((d) => ({ id: d.id, name: d.get('name') ?? '', logo: d.get('logo') ?? null, league: d.get('league') ?? null, members: Number(d.get('members') ?? 0) }));
    },
    /** team: yeni takım ya da null (ayrıl). */
    async joinTeam(uid, team, prevId, nowMs) {
      await db.runTransaction(async (tx) => {
        tx.set(profile(uid), { team: team ?? null, teamChangedMs: nowMs }, { merge: true });
        if (prevId) tx.set(db.doc(`social_communities/${prevId}`), { members: FieldValue.increment(-1) }, { merge: true });
        if (team) {
          tx.set(db.doc(`social_communities/${team.id}`), { id: team.id, name: team.name, logo: team.logo ?? null, league: team.league ?? null, members: FieldValue.increment(1) }, { merge: true });
        }
      });
    },
    async warRecord(week, uid, team, { hit, exact, username }) {
      const uref = db.doc(`social_war/${week}/users/${uid}`);
      const tref = db.doc(`social_war/${week}/teams/${team.id}`);
      return db.runTransaction(async (tx) => {
        const [u, t] = await Promise.all([tx.get(uref), tx.get(tref)]);
        const prev = u.exists ? u.data() : {};
        // Hafta içinde topluluk değiştiren yeni topluluğa sıfırdan başlar
        const same = prev.team === team.id;
        const me = {
          team: team.id,
          username: username ?? prev.username ?? null,
          n: (same ? Number(prev.n ?? 0) : 0) + 1,
          hits: (same ? Number(prev.hits ?? 0) : 0) + (hit ? 1 : 0),
          exact: (same ? Number(prev.exact ?? 0) : 0) + (exact ? 1 : 0),
          claimed: prev.claimed === true,
        };
        const td = t.exists ? t.data() : {};
        const top = td.top ?? null;
        const better = !top || me.hits > Number(top.hits ?? 0) || (me.hits === Number(top.hits ?? 0) && me.exact > Number(top.exact ?? 0)) || top.uid === uid;
        tx.set(uref, me);
        // Topluluk içi sıra için takım altında da tutulur (tek alanlı dizinle sayılır)
        tx.set(db.doc(`social_war/${week}/teams/${team.id}/members/${uid}`), { hits: me.hits, n: me.n });
        if (prev.team && !same) tx.delete(db.doc(`social_war/${week}/teams/${prev.team}/members/${uid}`));
        tx.set(
          tref,
          {
            id: team.id,
            name: team.name,
            logo: team.logo ?? null,
            n: FieldValue.increment(1),
            hits: FieldValue.increment(hit ? 1 : 0),
            exact: FieldValue.increment(exact ? 1 : 0),
            ...(better ? { top: { uid, username: me.username, n: me.n, hits: me.hits, exact: me.exact } } : {}),
          },
          { merge: true },
        );
        return me;
      });
    },
    async warTeams(week, limit) {
      const q = await db.collection(`social_war/${week}/teams`).orderBy('n', 'desc').limit(limit).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async warUser(week, uid) {
      const s = await db.doc(`social_war/${week}/users/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async countBetter(week, teamId, hits) {
      return (await db.collection(`social_war/${week}/teams/${teamId}/members`).where('hits', '>', hits).count().get()).data().count;
    },
    async getWarMeta(week) {
      const s = await db.doc(`social_war/${week}`).get();
      return s.exists ? s.data() : null;
    },
    async setWarMeta(week, value) {
      const ref = db.doc(`social_war/${week}`);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (s.exists && s.get('closedMs')) return;
        tx.set(ref, value, { merge: true });
      });
    },
    async claimWar(week, uid, winner) {
      const ref = db.doc(`social_war/${week}/users/${uid}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists || s.get('team') !== winner || !(Number(s.get('n') ?? 0) > 0)) return false;
        if (s.get('claimed') === true) return 'claimed';
        tx.update(ref, { claimed: true });
        return true;
      });
    },
    async getWeek(week) {
      const s = await db.doc(`social_week/${week}`).get();
      return s.exists ? s.data() : null;
    },
    async weekKing(week, k) {
      const ref = db.doc(`social_week/${week}`);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const cur = s.exists ? s.get('king') : null;
        if (cur && cur.uid !== k.uid && (Number(cur.acc ?? 0) > k.acc || (Number(cur.acc ?? 0) === k.acc && Number(cur.n ?? 0) >= k.n))) return;
        tx.set(ref, { king: k }, { merge: true });
      });
    },
    async rate(key, uid, shard, { items, fan, homeId, awayId, max, at }) {
      const uref = db.doc(`ratings/${key}/users/${uid}`);
      const sref = db.doc(`ratings/${key}/shards/${shard}`);
      const meta = db.doc(`ratings/${key}`);
      return db.runTransaction(async (tx) => {
        const [u, s, m] = await Promise.all([tx.get(uref), tx.get(sref), tx.get(meta)]);
        const mine = u.exists ? { ...(u.get('r') ?? {}) } : {};
        const oldFan = u.exists ? (u.get('team') ?? 'x') : fan;
        const players = s.exists ? { ...(s.get('players') ?? {}) } : {};
        const known = new Set(m.exists ? (m.get('pids') ?? []) : []);
        const fresh = items.filter((i) => !known.has(i.pid));
        if (known.size + fresh.length > max) return 'full';
        for (const i of items) {
          const p = players[i.pid] ? { ...players[i.pid], f: { ...(players[i.pid].f ?? {}) } } : { name: i.name, teamId: i.teamId, sum: 0, n: 0, f: {} };
          const old = mine[i.pid];
          if (Number.isInteger(old)) {
            p.sum -= old;
            p.n -= 1;
            const of = p.f[oldFan] ?? { sum: 0, n: 0 };
            p.f[oldFan] = { sum: of.sum - old, n: of.n - 1 };
          }
          p.sum += i.score;
          p.n += 1;
          const f = p.f[fan] ?? { sum: 0, n: 0 };
          p.f[fan] = { sum: f.sum + i.score, n: f.n + 1 };
          players[i.pid] = p;
          mine[i.pid] = i.score;
        }
        tx.set(sref, { players });
        tx.set(uref, { r: mine, team: fan, at });
        const patch = {};
        if (!m.exists) Object.assign(patch, { homeId, awayId });
        if (fresh.length) patch.pids = FieldValue.arrayUnion(...fresh.map((i) => i.pid));
        if (!u.exists) patch.raters = FieldValue.increment(1);
        if (Object.keys(patch).length) tx.set(meta, patch, { merge: true });
        return { first: !u.exists };
      });
    },
  };
}
