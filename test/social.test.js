// Sosyal akış: gönderi, etiket, maç kartı, beğeni, yorum, silme, takip, çevrimiçi ve topluluk sayıları.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SocialService, extractTags, cleanMatch, POST_MAX } from '../social.js';

function memStore(users) {
  const s = {
    users,
    posts: new Map(),
    likes: new Map(),
    comments: new Map(),
    tags: new Map(),
    profiles: new Map(),
    follows: new Map(),
    presence: new Map(),
    seq: 0,
    async getUser(uid) {
      return s.users[uid] ?? null;
    },
    async addPost(doc) {
      const id = `p${++s.seq}`;
      s.posts.set(id, { ...doc });
      return id;
    },
    async getPost(id) {
      return s.posts.get(id) ?? null;
    },
    async deletePost(id) {
      s.posts.delete(id);
    },
    async setLike(postId, uid, like) {
      const p = s.posts.get(postId);
      if (!p) return null;
      const k = `${postId}/${uid}`;
      if (like === s.likes.has(k)) return { liked: like, likeCount: p.likeCount };
      if (like) s.likes.set(k, true);
      else s.likes.delete(k);
      p.likeCount = Math.max(0, p.likeCount + (like ? 1 : -1));
      return { liked: like, likeCount: p.likeCount };
    },
    async addComment(postId, c) {
      const p = s.posts.get(postId);
      if (!p) return null;
      const list = s.comments.get(postId) ?? [];
      list.push(c);
      s.comments.set(postId, list);
      p.commentCount++;
      return { id: `c${list.length}`, commentCount: p.commentCount };
    },
    async countTags(day, tags) {
      const m = s.tags.get(day) ?? {};
      for (const t of tags) m[t.key] = { n: (m[t.key]?.n ?? 0) + 1, label: t.label };
      s.tags.set(day, m);
    },
    async bumpProfile(uid, inc) {
      const p = s.profiles.get(uid) ?? {};
      for (const [k, v] of Object.entries(inc)) p[k] = (p[k] ?? 0) + v;
      s.profiles.set(uid, p);
    },
    async setFollow(uid, target, follow, max) {
      const list = s.follows.get(uid) ?? [];
      const has = list.includes(target);
      if (has === follow) return 'same';
      if (follow && list.length >= max) return 'limit';
      s.follows.set(uid, follow ? [...list, target] : list.filter((x) => x !== target));
      await s.bumpProfile(target, { followers: follow ? 1 : -1 });
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
  };
  return s;
}

const NOW = Date.UTC(2026, 9, 28, 9);
const users = { u1: { username: 'tostcu23', photoURL: 'p' }, u2: { username: 'rakip' }, u3: { username: null }, bad: { username: 'kotu', banned: true } };

function make() {
  let now = NOW;
  const store = memStore(users);
  const s = new SocialService({ store, now: () => now, isAdmin: async (uid) => uid === 'admin' });
  return { s, store, tick: (ms) => (now += ms) };
}

test('etiketler: en çok 5, tekrar yok, Türkçe harfler korunur', () => {
  assert.deepEqual(extractTags('Bugün #Galatasaray kazanır #SüperLig #galatasaray').map((t) => t.key), ['galatasaray', 'süperlig']);
  assert.equal(extractTags('#a #bb #cc #dd #ee #ff #gg').length, 5);
  assert.deepEqual(extractTags('etiket yok'), []);
});

test('maç kartı: yalnızca geçerli alanlar', () => {
  const m = cleanMatch({ league: 'tur.1', eventId: '401', home: 'Galatasaray', away: 'Fenerbahçe', kickoff: '2026-10-28T17:00:00Z', pick: 'MS 1', pct: 55, extra: 'x' });
  assert.equal(m.key, 'tur_1_401');
  assert.equal(m.pick, 'MS 1');
  assert.ok(!('extra' in m));
  assert.equal(cleanMatch({ league: '../x', eventId: '1' }), null);
  assert.equal(cleanMatch({ league: 'tur.1', eventId: 'abc' }), null);
  assert.equal(cleanMatch(null), null);
});

test('gönderi: kullanıcı adı şart, uzunluk, art arda gönderi beklemesi, etiket sayımı', async () => {
  const { s, store, tick } = make();
  const p = await s.post({ uid: 'u1', text: 'Derbi günü! #Galatasaray #Fenerbahçe', match: { league: 'tur.1', eventId: '401', home: 'Galatasaray', away: 'Fenerbahçe' } });
  assert.equal(p.username, 'tostcu23');
  assert.deepEqual(p.tags, ['galatasaray', 'fenerbahçe']);
  assert.equal(p.match.key, 'tur_1_401');
  assert.equal(store.tags.get('2026-10-28').galatasaray.n, 1);
  await assert.rejects(s.post({ uid: 'u1', text: 'tekrar' }), /bekle/);
  tick(21e3);
  await assert.rejects(s.post({ uid: 'u1', text: 'x'.repeat(POST_MAX + 1) }), /en fazla/);
  await assert.rejects(s.post({ uid: 'u1', text: '   ' }), /yaz/);
  await assert.rejects(s.post({ uid: 'u3', text: 'merhaba' }), /kullanıcı adını/);
  await assert.rejects(s.post({ uid: 'bad', text: 'merhaba' }), /kapalı/);
  await assert.rejects(s.post({ uid: 'u1', guest: true, text: 'merhaba' }), /Google/);
  assert.equal(store.profiles.get('u1').posts, 1);
});

test('beğeni ve yorum: sayaçlar tutarlı, iki kez beğeni sayılmaz; silme yalnızca sahibine ya da yöneticiye', async () => {
  const { s, tick } = make();
  const p = await s.post({ uid: 'u1', text: 'Merhaba' });
  assert.deepEqual(await s.like({ uid: 'u2', postId: p.id, like: true }), { liked: true, likeCount: 1 });
  assert.deepEqual(await s.like({ uid: 'u2', postId: p.id, like: true }), { liked: true, likeCount: 1 });
  assert.deepEqual(await s.like({ uid: 'u2', postId: p.id, like: false }), { liked: false, likeCount: 0 });
  const c = await s.comment({ uid: 'u2', postId: p.id, text: 'Katılıyorum' });
  assert.equal(c.commentCount, 1);
  await assert.rejects(s.comment({ uid: 'u2', postId: p.id, text: 'yine' }), /bekle/);
  tick(6e3);
  await assert.rejects(s.comment({ uid: 'u2', postId: 'yok', text: 'x' }), /bulunamadı/);
  await assert.rejects(s.like({ uid: 'u2', postId: 'yok' }), /bulunamadı/);
  await assert.rejects(s.remove({ uid: 'u2', postId: p.id }), /kendi/);
  assert.deepEqual(await s.remove({ uid: 'admin', postId: p.id }), { ok: true });
});

test('takip: kendini takip edemez, tekrar değişmez, takipçi sayısı', async () => {
  const { s, store } = make();
  assert.deepEqual(await s.follow({ uid: 'u1', target: 'u2', follow: true }), { following: true, changed: true });
  assert.deepEqual(await s.follow({ uid: 'u1', target: 'u2', follow: true }), { following: true, changed: false });
  assert.equal(store.profiles.get('u2').followers, 1);
  await s.follow({ uid: 'u1', target: 'u2', follow: false });
  assert.equal(store.profiles.get('u2').followers, 0);
  await assert.rejects(s.follow({ uid: 'u1', target: 'u1' }), /Geçersiz/);
});

test('çevrimiçi ve topluluk sayıları (2 dakika saklanır)', async () => {
  const { s, tick } = make();
  await s.presence({ uid: 'u1' });
  await s.presence({ uid: 'u2' });
  const st = await s.stats({ uid: 'u1' });
  assert.deepEqual(st, { users: 4, today: 2, online: 2 });
  tick(6 * 60e3);
  await s.presence({ uid: 'u1' });
  assert.deepEqual(await s.stats({ uid: 'u1' }), { users: 4, today: 2, online: 1 });
});
