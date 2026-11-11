// Sosyal servisler için bellekte çalışan sahte depo (social.js, social_missions.js, social_community.js, social_dm.js).

import { pairOf } from '../social_rules.js';

export function memSocial(users = {}, stats = {}) {
  const s = {
    users,
    stats,
    usernames: Object.fromEntries(Object.entries(users).filter(([, u]) => u.username).map(([uid, u]) => [u.username.toLowerCase(), uid])),
    posts: new Map(),
    likes: new Map(),
    comments: new Map(),
    votes: new Map(),
    duel: new Map(),
    paid: new Set(),
    history: new Map(),
    tags: new Map(),
    profiles: new Map(),
    followMap: new Map(),
    presence: new Map(),
    notifs: new Map(),
    watched: new Map(),
    week: new Map(),
    missions: new Map(),
    communities: new Map(),
    war: new Map(),
    warUsers: new Map(),
    warMeta: new Map(),
    ratings: new Map(),
    convs: new Map(),
    messages: new Map(),
    blocks: new Map(),
    reports: [],
    seq: 0,

    // ---- ortak ----
    async getUser(uid) {
      return s.users[uid] ?? null;
    },
    async getStats(uid) {
      return s.stats[uid] ?? null;
    },
    async getProfile(uid) {
      return s.profiles.get(uid) ?? null;
    },
    async saveProfile(uid, patch) {
      s.profiles.set(uid, { ...(s.profiles.get(uid) ?? {}), ...patch });
    },
    async bumpProfile(uid, inc) {
      const p = { ...(s.profiles.get(uid) ?? {}) };
      for (const [k, v] of Object.entries(inc)) p[k] = (p[k] ?? 0) + v;
      s.profiles.set(uid, p);
    },
    async uidOfUsername(name) {
      return s.usernames[name.toLowerCase()] ?? null;
    },
    async follows(uid, target) {
      return (s.followMap.get(uid) ?? []).includes(target);
    },

    // ---- gönderi ----
    async addPost(doc) {
      const id = `post${++s.seq}`;
      s.posts.set(id, structuredClone(doc));
      return id;
    },
    async addPostWithId(id, doc) {
      if (s.posts.has(id)) return false;
      s.posts.set(id, structuredClone(doc));
      return true;
    },
    async getPost(id) {
      return s.posts.get(id) ?? null;
    },
    async deletePost(id) {
      s.posts.delete(id);
    },
    async getComment(postId, id) {
      return (s.comments.get(postId) ?? []).find((c) => c.id === id) ?? null;
    },
    async setReaction(postId, uid, r, { keep = false } = {}) {
      const p = s.posts.get(postId);
      if (!p) return null;
      const k = `${postId}/${uid}`;
      const prev = s.likes.get(k) ?? null;
      p.reactions = { fire: 0, goal: 0, wow: 0, lol: 0, ...(p.reactions ?? {}) };
      const base = { author: p.uid, username: p.username, text: p.text, createdMs: p.createdMs };
      if (prev === r || (keep && prev !== null && r !== null)) return { ...base, prev, reaction: prev, reactions: { ...p.reactions }, likeCount: p.likeCount };
      if (prev) p.reactions[prev]--;
      if (r) p.reactions[r]++;
      p.likeCount = Math.max(0, p.likeCount + (r ? 1 : 0) - (prev ? 1 : 0));
      if (r) s.likes.set(k, r);
      else s.likes.delete(k);
      return { ...base, prev, reaction: r, reactions: { ...p.reactions }, likeCount: p.likeCount };
    },
    async addComment(postId, c) {
      const p = s.posts.get(postId);
      if (!p) return null;
      const list = s.comments.get(postId) ?? [];
      const id = `cmt${list.length + 1}`;
      list.push({ id, ...c });
      s.comments.set(postId, list);
      p.commentCount++;
      return { id, commentCount: p.commentCount, author: p.uid };
    },
    async vote(postId, uid, option, nowMs) {
      const p = s.posts.get(postId);
      if (!p?.poll) return null;
      const k = `${postId}/${uid}`;
      if (s.votes.has(k)) return { same: true, option: s.votes.get(k), counts: { ...p.poll.counts }, total: p.poll.total };
      if (p.poll.closesMs <= nowMs) return 'closed';
      if (option >= p.poll.options.length) return 'invalid';
      s.votes.set(k, option);
      p.poll.counts[String(option)] = (p.poll.counts[String(option)] ?? 0) + 1;
      p.poll.total++;
      return { same: false, option, counts: { ...p.poll.counts }, total: p.poll.total };
    },
    async addDuelEntry(postId, uid, e) {
      s.duel.set(`${postId}/${uid}`, { ...e });
    },
    async duelJoin(postId, uid, e, nowMs) {
      const p = s.posts.get(postId);
      if (!p?.duel) return null;
      if (p.duel.status !== 'open' || p.duel.kickoffMs <= nowMs) return 'closed';
      const k = `${postId}/${uid}`;
      if (s.duel.has(k)) return 'exists';
      s.duel.set(k, { ...e });
      p.duel.n++;
      if (p.duel.top.length < 3) p.duel.top.push({ username: e.username, h: e.home, a: e.away });
      return { n: p.duel.n, top: [...p.duel.top], author: p.uid };
    },
    async openDuels(key) {
      return [...s.posts.entries()].filter(([, p]) => p.duel?.key === key && p.duel.status === 'open').map(([id, p]) => ({ id, ...p }));
    },
    async duelEntries(postId) {
      return [...s.duel.entries()].filter(([k]) => k.startsWith(`${postId}/`)).map(([k, e]) => ({ uid: k.split('/')[1], ...e }));
    },
    async finishDuel(postId, final, results) {
      const p = s.posts.get(postId);
      p.duel.status = 'done';
      p.duel.final = final;
      for (const r of results) Object.assign(s.duel.get(`${postId}/${r.uid}`), { result: r.result, reward: r.reward });
    },
    async claimDuelPay(uid, key) {
      const k = `${uid}_${key}`;
      if (s.paid.has(k)) return false;
      s.paid.add(k);
      return true;
    },
    async addDuelHistory(uid, postId, item) {
      s.history.set(`${uid}/${postId}`, item);
    },
    async ensureWatched({ key, league, eventId, kickoffMs }) {
      if (!s.watched.has(key)) s.watched.set(key, { league, eventId, kickoffMs });
    },
    async notify(uid, item, agg = null) {
      const list = s.notifs.get(uid) ?? [];
      const readAt = Number(s.profiles.get(uid)?.readAt ?? 0);
      const old = agg ? list.find((x) => x.id === agg) : null;
      let fresh = true;
      if (old) {
        fresh = old.at <= readAt;
        const names = [item.from?.username, ...(old.names ?? [])].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 2);
        Object.assign(old, { ...item, n: fresh ? 1 : old.n + 1, names });
      } else {
        list.unshift({ id: agg ?? `n${++s.seq}`, ...item, n: 1, names: item.from?.username ? [item.from.username] : [] });
      }
      s.notifs.set(uid, list);
      if (fresh) await s.bumpProfile(uid, { unread: 1 });
    },
    async markRead(uid, nowMs) {
      await s.saveProfile(uid, { unread: 0, readAt: nowMs });
    },
    async weekBestPost(week, best) {
      const w = s.week.get(week) ?? {};
      if (!w.bestPost || w.bestPost.n < best.n) w.bestPost = best;
      s.week.set(week, w);
    },
    async weekDuelMaster(week, m) {
      const w = s.week.get(week) ?? {};
      if (!w.duel || w.duel.wins < m.wins) w.duel = m;
      s.week.set(week, w);
    },
    async weekKing(week, k) {
      const w = s.week.get(week) ?? {};
      const cur = w.king;
      if (!(cur && cur.uid !== k.uid && (cur.acc > k.acc || (cur.acc === k.acc && cur.n >= k.n)))) w.king = k;
      s.week.set(week, w);
    },
    async getWeek(week) {
      return s.week.get(week) ?? null;
    },
    async countTags(day, tags) {
      const m = s.tags.get(day) ?? {};
      for (const t of tags) m[t.key] = { n: (m[t.key]?.n ?? 0) + 1, label: t.label };
      s.tags.set(day, m);
    },
    async setFollow(uid, target, follow, max) {
      const list = s.followMap.get(uid) ?? [];
      const has = list.includes(target);
      if (has === follow) return 'same';
      if (follow && list.length >= max) return 'limit';
      s.followMap.set(uid, follow ? [...list, target] : list.filter((x) => x !== target));
      await s.bumpProfile(target, { followers: follow ? 1 : -1 });
      await s.bumpProfile(uid, { following: follow ? 1 : -1 });
      return 'changed';
    },
    async setPresence(uid, at, day) {
      s.presence.set(uid, { at, day });
    },
    async countUsers() {
      return Object.keys(s.users).length;
    },
    async countActiveDay(day) {
      return [...s.presence.values()].filter((p) => p.day === day).length;
    },
    async countOnline(since) {
      return [...s.presence.values()].filter((p) => p.at >= since).length;
    },

    // ---- görevler ----
    async getMissions(uid) {
      return s.missions.get(uid) ?? null;
    },
    async mutateMissions(uid, fn) {
      const { doc, result } = fn(structuredClone(s.missions.get(uid) ?? null));
      if (doc) s.missions.set(uid, structuredClone(doc));
      return result;
    },

    // ---- topluluk ----
    async getCommunity(id) {
      return s.communities.get(id) ?? null;
    },
    async topCommunities(limit) {
      return [...s.communities.values()].sort((a, b) => b.members - a.members).slice(0, limit);
    },
    async joinTeam(uid, team, prevId, nowMs) {
      await s.saveProfile(uid, { team: team ?? null, teamChangedMs: nowMs });
      if (prevId) s.communities.get(prevId).members--;
      if (team) {
        const c = s.communities.get(team.id) ?? { id: team.id, name: team.name, logo: team.logo, league: team.league, members: 0 };
        c.members++;
        s.communities.set(team.id, c);
      }
    },
    async warRecord(week, uid, team, { hit, exact, username }) {
      const k = `${week}/${uid}`;
      const prev = s.warUsers.get(k) ?? {};
      const same = prev.team === team.id;
      const me = {
        team: team.id,
        username: username ?? prev.username ?? null,
        n: (same ? prev.n : 0) + 1,
        hits: (same ? prev.hits : 0) + (hit ? 1 : 0),
        exact: (same ? prev.exact : 0) + (exact ? 1 : 0),
        claimed: prev.claimed === true,
      };
      s.warUsers.set(k, me);
      const tk = `${week}/${team.id}`;
      const t = s.war.get(tk) ?? { id: team.id, name: team.name, logo: team.logo ?? null, n: 0, hits: 0, exact: 0, top: null };
      t.n++;
      t.hits += hit ? 1 : 0;
      t.exact += exact ? 1 : 0;
      if (!t.top || me.hits > t.top.hits || (me.hits === t.top.hits && me.exact > t.top.exact) || t.top.uid === uid) t.top = { uid, username: me.username, n: me.n, hits: me.hits, exact: me.exact };
      s.war.set(tk, t);
      return { ...me };
    },
    async warTeams(week, limit) {
      return [...s.war.entries()].filter(([k]) => k.startsWith(`${week}/`)).map(([, t]) => ({ ...t })).slice(0, limit);
    },
    async warUser(week, uid) {
      return s.warUsers.get(`${week}/${uid}`) ?? null;
    },
    async countBetter(week, teamId, hits) {
      return [...s.warUsers.entries()].filter(([k, u]) => k.startsWith(`${week}/`) && u.team === teamId && u.hits > hits).length;
    },
    async getWarMeta(week) {
      return s.warMeta.get(week) ?? null;
    },
    async setWarMeta(week, v) {
      if (!s.warMeta.get(week)?.closedMs) s.warMeta.set(week, v);
    },
    async claimWar(week, uid, winner) {
      const u = s.warUsers.get(`${week}/${uid}`);
      if (!u || u.team !== winner || !(u.n > 0)) return false;
      if (u.claimed) return 'claimed';
      u.claimed = true;
      return true;
    },
    async rate(key, uid, shard, { items, fan, max, at }) {
      const r = s.ratings.get(key) ?? { pids: new Set(), players: {}, users: {}, raters: 0 };
      const mine = r.users[uid]?.r ?? {};
      const fresh = items.filter((i) => !r.pids.has(i.pid));
      if (r.pids.size + fresh.length > max) return 'full';
      const first = !r.users[uid];
      for (const i of items) {
        const p = r.players[i.pid] ?? { name: i.name, teamId: i.teamId, sum: 0, n: 0, f: {} };
        const old = mine[i.pid];
        if (Number.isInteger(old)) {
          p.sum -= old;
          p.n--;
          p.f[fan].sum -= old;
          p.f[fan].n--;
        }
        p.sum += i.score;
        p.n++;
        p.f[fan] = { sum: (p.f[fan]?.sum ?? 0) + i.score, n: (p.f[fan]?.n ?? 0) + 1 };
        r.players[i.pid] = p;
        mine[i.pid] = i.score;
        r.pids.add(i.pid);
      }
      r.users[uid] = { r: mine, team: fan, at, shard };
      if (first) r.raters++;
      s.ratings.set(key, r);
      return { first };
    },

    // ---- mesajlar ----
    async blocked(uid) {
      return s.blocks.get(uid) ?? [];
    },
    async setBlock(uid, target, on) {
      const l = s.blocks.get(uid) ?? [];
      s.blocks.set(uid, on ? [...new Set([...l, target])] : l.filter((x) => x !== target));
    },
    async getConv(pair) {
      return s.convs.get(pair) ?? null;
    },
    async sendDm(pair, { from, to, text, attach, startAs, names, photos, limit, at }) {
      const c = s.convs.get(pair) ?? null;
      let state = c?.state ?? startAs;
      let pending = c?.pending ?? 0;
      const requester = c?.requester ?? (startAs === 'request' ? from : null);
      if (state === 'declined') {
        if (from === requester) return 'declined';
        state = 'active';
      }
      if (state === 'request') {
        if (from === requester) {
          if (pending >= limit) return 'limit';
          pending++;
        } else state = 'active';
      }
      const list = s.messages.get(pair) ?? [];
      const id = `m${list.length + 1}`;
      list.push({ id, from, text, attach, at });
      s.messages.set(pair, list);
      const unread = { ...(c?.unread ?? {}) };
      unread[to] = (unread[to] ?? 0) + 1;
      unread[from] = 0;
      s.convs.set(pair, { members: pair.split('_'), names, photos, state, requester, pending, last: { text, from, at }, unread, readAt: { ...(c?.readAt ?? {}), [from]: at }, updatedMs: at });
      return { id, state };
    },
    async setConvState(pair, uid, state) {
      const c = s.convs.get(pair);
      if (!c) return null;
      if (c.requester === uid) return c.state;
      c.state = state;
      if (state === 'active') c.pending = 0;
      c.unread[uid] = 0;
      return state;
    },
    async readConv(pair, uid, at) {
      const c = s.convs.get(pair);
      if (!c) return;
      c.unread[uid] = 0;
      c.readAt[uid] = at;
    },
    async addReport(doc) {
      s.reports.push(doc);
    },
  };
  s.pairOf = pairOf;
  return s;
}
