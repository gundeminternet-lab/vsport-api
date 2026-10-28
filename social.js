// Sosyal akış: gönderi (metin + isteğe bağlı maç kartı), beğeni, yorum, takip, gündem etiketleri; topluluk sayıları
// (kayıtlı kullanıcı, bugün aktif, çevrimiçi). Yazma işlemleri sunucudan (sayaçlar tutarlı kalsın); okuma istemciden.
//
//   posts/{id}                    { uid, username, photoURL, text, tags, match?, likeCount, commentCount, createdAt, createdMs }
//   posts/{id}/likes/{uid}        { at }
//   posts/{id}/comments/{id}      { uid, username, photoURL, text, createdAt }
//   social_follows/{uid}          { following: [uid] }        social_profiles/{uid} { followers, following, posts }
//   social_tags/{gün}             { counts: { etiket: { n, label } } }     presence/{uid} { at, day }

import { AppError } from './errors.js';
import { trDay } from './progress.js';

export const POST_MAX = 500;
export const COMMENT_MAX = 300;
const POST_GAP_MS = 20e3;
const COMMENT_GAP_MS = 5e3;
const MAX_FOLLOWING = 500;

/** "#Galatasaray maçı #SüperLig" → [{ key: 'galatasaray', label: '#Galatasaray' }, ...] (en çok 5, tekrar yok). */
export function extractTags(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/#([\p{L}\p{N}_]{2,30})/gu)) {
    const key = m[1].toLocaleLowerCase('tr');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: `#${m[1]}` });
    if (out.length >= 5) break;
  }
  return out;
}

/** Gönderiye eklenen maç kartı: yalnızca bilinen alanlar, kısaltılmış. */
export function cleanMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const s = (v, n = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const league = s(m.league, 30);
  const eventId = s(m.eventId, 20);
  if (!league || !eventId || !/^[a-z0-9._]+$/i.test(league) || !/^[0-9]+$/.test(eventId)) return null;
  const kickoff = s(m.kickoff, 30);
  return {
    key: `${league.replace(/[^a-zA-Z0-9]/g, '_')}_${eventId}`,
    league,
    eventId,
    home: s(m.home) ?? '',
    away: s(m.away) ?? '',
    homeLogo: s(m.homeLogo, 300),
    awayLogo: s(m.awayLogo, 300),
    kickoff: kickoff && Number.isFinite(Date.parse(kickoff)) ? kickoff : null,
    pick: s(m.pick, 30),
    pct: Number.isInteger(m.pct) && m.pct >= 0 && m.pct <= 100 ? m.pct : null,
  };
}

export class SocialService {
  /** store: createSocialStore. isAdmin: async (uid) → bool. */
  constructor({ store, now = () => Date.now(), isAdmin = null }) {
    this.store = store;
    this.now = now;
    this.isAdmin = isAdmin;
    this._lastPost = new Map();
    this._lastComment = new Map();
    this._presence = new Map();
    this._stats = null;
  }

  async _author(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Paylaşmak için Google ile giriş yap.');
    const u = await this.store.getUser(uid);
    if (!u) throw new AppError('permission-denied', 'Profil bulunamadı.');
    if (u.banned === true) throw new AppError('permission-denied', 'Hesabın paylaşıma kapalı.');
    if (!u.username) throw new AppError('failed-precondition', 'Önce kullanıcı adını belirle.');
    return u;
  }

  _gap(map, uid, ms, message) {
    const at = map.get(uid) ?? 0;
    if (this.now() - at < ms) throw new AppError('resource-exhausted', message);
    map.set(uid, this.now());
    if (map.size > 5000) map.clear();
  }

  async post({ uid, guest = false, text, match = null }) {
    const u = await this._author(uid, guest);
    const body = String(text ?? '').trim();
    if (!body) throw new AppError('invalid-argument', 'Bir şeyler yaz.');
    if (body.length > POST_MAX) throw new AppError('invalid-argument', `Gönderi en fazla ${POST_MAX} karakter olabilir.`);
    this._gap(this._lastPost, uid, POST_GAP_MS, 'Biraz bekle; art arda gönderi paylaşılamaz.');
    const tags = extractTags(body);
    const doc = {
      uid,
      username: u.username,
      photoURL: u.photoURL ?? null,
      text: body,
      tags: tags.map((t) => t.key),
      match: cleanMatch(match),
      likeCount: 0,
      commentCount: 0,
      createdMs: this.now(),
    };
    const id = await this.store.addPost(doc);
    if (tags.length) await this.store.countTags(trDay(this.now()), tags);
    await this.store.bumpProfile(uid, { posts: 1 });
    return { id, ...doc };
  }

  async like({ uid, guest = false, postId, like = true }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Beğenmek için Google ile giriş yap.');
    if (typeof postId !== 'string' || !postId) throw new AppError('invalid-argument', 'Geçersiz gönderi.');
    const r = await this.store.setLike(postId, uid, like === true);
    if (r === null) throw new AppError('not-found', 'Gönderi bulunamadı.');
    return r; // { liked, likeCount }
  }

  async comment({ uid, guest = false, postId, text }) {
    const u = await this._author(uid, guest);
    const body = String(text ?? '').trim();
    if (!body) throw new AppError('invalid-argument', 'Yorum boş olamaz.');
    if (body.length > COMMENT_MAX) throw new AppError('invalid-argument', `Yorum en fazla ${COMMENT_MAX} karakter olabilir.`);
    this._gap(this._lastComment, uid, COMMENT_GAP_MS, 'Biraz bekle; art arda yorum yazılamaz.');
    const r = await this.store.addComment(postId, { uid, username: u.username, photoURL: u.photoURL ?? null, text: body });
    if (r === null) throw new AppError('not-found', 'Gönderi bulunamadı.');
    return r;
  }

  async remove({ uid, postId }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const post = await this.store.getPost(postId);
    if (!post) throw new AppError('not-found', 'Gönderi bulunamadı.');
    if (post.uid !== uid && !(this.isAdmin && (await this.isAdmin(uid).catch(() => false)))) {
      throw new AppError('permission-denied', 'Yalnızca kendi gönderini silebilirsin.');
    }
    await this.store.deletePost(postId);
    await this.store.bumpProfile(post.uid, { posts: -1 });
    return { ok: true };
  }

  async follow({ uid, guest = false, target, follow = true }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Takip için Google ile giriş yap.');
    if (typeof target !== 'string' || !target || target === uid) throw new AppError('invalid-argument', 'Geçersiz kullanıcı.');
    const r = await this.store.setFollow(uid, target, follow === true, MAX_FOLLOWING);
    if (r === 'limit') throw new AppError('failed-precondition', `En fazla ${MAX_FOLLOWING} kişiyi takip edebilirsin.`);
    return { following: follow === true, changed: r === 'changed' };
  }

  /** Uygulama açıkken birkaç dakikada bir: çevrimiçi sayısı için. */
  async presence({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const at = this._presence.get(uid) ?? 0;
    if (this.now() - at >= 60e3) {
      this._presence.set(uid, this.now());
      if (this._presence.size > 20000) this._presence.clear();
      await this.store.setPresence(uid, this.now(), trDay(this.now()));
    }
    return { ok: true };
  }

  /** Kayıtlı kullanıcı, bugün aktif ve son 5 dakikada çevrimiçi sayıları (2 dakika saklanır). */
  async stats({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (this._stats && this.now() - this._stats.at < 120e3) return this._stats.value;
    const [users, today, online] = await Promise.all([
      this.store.countUsers().catch(() => null),
      this.store.countActiveDay(trDay(this.now())).catch(() => null),
      this.store.countOnline(this.now() - 5 * 60e3).catch(() => null),
    ]);
    const value = { users, today, online };
    this._stats = { at: this.now(), value };
    return value;
  }
}

export function createSocialStore(db, FieldValue) {
  return {
    async getUser(uid) {
      const s = await db.doc(`users/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async addPost(doc) {
      const ref = await db.collection('posts').add({ ...doc, createdAt: FieldValue.serverTimestamp() });
      return ref.id;
    },
    async getPost(id) {
      const s = await db.doc(`posts/${id}`).get();
      return s.exists ? s.data() : null;
    },
    async deletePost(id) {
      await db.doc(`posts/${id}`).delete();
    },
    async setLike(postId, uid, like) {
      const post = db.doc(`posts/${postId}`);
      const ref = db.doc(`posts/${postId}/likes/${uid}`);
      return db.runTransaction(async (tx) => {
        const [p, l] = await Promise.all([tx.get(post), tx.get(ref)]);
        if (!p.exists) return null;
        const count = Number(p.get('likeCount') ?? 0);
        if (like === l.exists) return { liked: like, likeCount: count };
        if (like) tx.set(ref, { at: FieldValue.serverTimestamp() });
        else tx.delete(ref);
        const next = Math.max(0, count + (like ? 1 : -1));
        tx.update(post, { likeCount: next });
        return { liked: like, likeCount: next };
      });
    },
    async addComment(postId, c) {
      const post = db.doc(`posts/${postId}`);
      return db.runTransaction(async (tx) => {
        const p = await tx.get(post);
        if (!p.exists) return null;
        const ref = post.collection('comments').doc();
        tx.set(ref, { ...c, createdAt: FieldValue.serverTimestamp() });
        tx.update(post, { commentCount: FieldValue.increment(1) });
        return { id: ref.id, commentCount: Number(p.get('commentCount') ?? 0) + 1 };
      });
    },
    async countTags(day, tags) {
      const counts = Object.fromEntries(tags.map((t) => [t.key, { n: FieldValue.increment(1), label: t.label }]));
      await db.doc(`social_tags/${day}`).set({ day, counts }, { merge: true });
    },
    async bumpProfile(uid, inc) {
      await db.doc(`social_profiles/${uid}`).set(Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, FieldValue.increment(v)])), { merge: true });
    },
    async setFollow(uid, target, follow, max) {
      const mine = db.doc(`social_follows/${uid}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(mine);
        const list = s.exists ? s.get('following') ?? [] : [];
        const has = list.includes(target);
        if (has === follow) return 'same';
        if (follow && list.length >= max) return 'limit';
        tx.set(mine, { following: follow ? FieldValue.arrayUnion(target) : FieldValue.arrayRemove(target) }, { merge: true });
        tx.set(db.doc(`social_profiles/${target}`), { followers: FieldValue.increment(follow ? 1 : -1) }, { merge: true });
        tx.set(db.doc(`social_profiles/${uid}`), { following: FieldValue.increment(follow ? 1 : -1) }, { merge: true });
        return 'changed';
      });
    },
    async setPresence(uid, at, day) {
      await db.doc(`presence/${uid}`).set({ at, day });
    },
    async countUsers() {
      return (await db.collection('users').count().get()).data().count;
    },
    async countActiveDay(day) {
      return (await db.collection('presence').where('day', '==', day).count().get()).data().count;
    },
    async countOnline(sinceMs) {
      return (await db.collection('presence').where('at', '>=', sinceMs).count().get()).data().count;
    },
  };
}
