// Günlük futbol haberleri (Sosyal → Haberler). Ücretsiz RSS beslemelerinden toplanır: başlık, kısa özet, görsel ve
// kaynağa bağlantı. Haberin tamamı kaynağın sitesinde açılır (içerik kopyalanmaz, kaynak her haberde yazılır).
// Kullanıcılar haberlere yorum yazar.
//
//   news/{id}                   { id, title, summary, image, url, source, sourceName, publishedMs, firstSeenMs, commentCount }
//   news/{id}/comments/{id}     { uid, username, photoURL, text, createdMs, createdAt }
//
// Beslemeler NEWS_FEEDS ortam değişkeniyle değiştirilebilir: "kimlik|Ad|adres;kimlik|Ad|adres".
// Okunamayan besleme atlanır (durum yöneticide görünür).

import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

export const DEFAULT_FEEDS = [
  { id: 'trt', name: 'TRT Haber', url: 'https://www.trthaber.com/spor_articles.rss' },
  { id: 'haberturk', name: 'Habertürk', url: 'https://www.haberturk.com/rss/spor.xml' },
  { id: 'ntv', name: 'NTV', url: 'https://www.ntv.com.tr/spor.rss' },
  { id: 'sabah', name: 'Sabah', url: 'https://www.sabah.com.tr/rss/spor.xml' },
];

export const NEWS_COMMENT_MAX = 300;
const COMMENT_GAP_MS = 5e3;
const REFRESH_MS = 15 * 60e3;
const KEEP_MS = 3 * 86400e3;
const MAX_ITEMS = 400;
const SUMMARY_MAX = 260;

/** "trt|TRT Haber|https://...;..." → besleme listesi (geçersiz satırlar atlanır). */
export function feedsFromEnv(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const list = raw
    .split(';')
    .map((x) => x.split('|').map((y) => y.trim()))
    .filter(([id, name, url]) => id && name && /^https:\/\//.test(url ?? ''))
    .map(([id, name, url]) => ({ id, name, url }));
  return list.length ? list : null;
}

// -----------------------------------------------------------------------------------------------------------------
// RSS ayrıştırma (saf)
// -----------------------------------------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', ndash: '–', mdash: '—' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const cdata = (s) => String(s ?? '').replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? cdata(m[1]).trim() : null;
};
const attr = (xml, name, a) => {
  const m = new RegExp(`<${name}\\s[^>]*${a}\\s*=\\s*["']([^"']+)["'][^>]*>`, 'i').exec(xml);
  return m ? decodeEntities(m[1]) : null;
};
export const stripHtml = (s) =>
  decodeEntities(
    String(s ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();

const clip = (s, n) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > n * 0.5 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : n)}…`;
};

const httpsUrl = (u) => {
  if (!u) return null;
  const v = decodeEntities(String(u).trim());
  if (!/^https?:\/\//i.test(v)) return null;
  return v.replace(/^http:\/\//i, 'https://');
};

export const newsId = (source, url) => createHash('sha1').update(`${source}|${url}`).digest('hex').slice(0, 20);

/** Bir RSS yanıtındaki haberler (saf). source: { id, name }. */
export function parseRss(xml, source) {
  const out = [];
  for (const m of String(xml ?? '').matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const it = m[0];
    const title = stripHtml(tag(it, 'title') ?? '');
    const link = httpsUrl(tag(it, 'link') ?? attr(it, 'link', 'href') ?? tag(it, 'guid'));
    if (!title || !link) continue;
    const rawDesc = tag(it, 'description') ?? tag(it, 'content:encoded') ?? '';
    const image =
      httpsUrl(attr(it, 'enclosure', 'url')) ??
      httpsUrl(attr(it, 'media:content', 'url')) ??
      httpsUrl(attr(it, 'media:thumbnail', 'url')) ??
      httpsUrl(tag(it, 'image')) ??
      httpsUrl(/<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(decodeEntities(rawDesc))?.[1]);
    const summary = clip(stripHtml(rawDesc), SUMMARY_MAX);
    const pub = Date.parse(tag(it, 'pubDate') ?? tag(it, 'dc:date') ?? tag(it, 'published') ?? '');
    const categories = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => stripHtml(cdata(c[1])));
    out.push({
      id: newsId(source.id, link),
      title: clip(title, 200),
      summary: summary && summary !== title ? summary : '',
      image,
      url: link,
      source: source.id,
      sourceName: source.name,
      publishedMs: Number.isFinite(pub) ? pub : null,
      categories,
    });
  }
  return out;
}

/** Futbol dışı spor haberleri (basketbol, voleybol, tenis, Formula 1 ...) ayıklanır. */
// Uzun kelimeler ekli halleriyle de yakalanır (basketbolda, güreşçi); kısa olanlar yalnız tam kelime.
const OTHER_SPORTS_WORDS = [
  'basketbol', 'voleybol', 'filenin sultanları', 'filenin efeleri', 'hentbol', 'tenis', 'masa tenisi', 'badminton',
  'formula 1', 'formula1', 'f1', 'motogp', 'motosiklet', 'ralli', 'boks', 'kick boks', 'güreş', 'atletizm', 'yüzme',
  'paralimpik', 'euroleague', 'eurocup', 'nba', 'wnba', 'golf', 'kayak', 'satranç', 'e-spor', 'espor',
  'okçuluk', 'halter', 'judo', 'taekwondo', 'eskrim', 'jimnastik', 'mma', 'ufc', 'wwe', 'snooker', 'yelken',
  'binicilik', 'at yarışı', 'anadolu efes', 'fenerbahçe beko', 'beşiktaş fibabanka', 'galatasaray daikin', 'vakıfbank',
  'eczacıbaşı', 'smaç', 'pota', 'basket',
];
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (w) => (w.length >= 5 ? esc(w) : `${esc(w)}(?![\\p{L}\\p{N}])`);
// Türkçe harflerde \b çalışmaz: sınır "harf/rakam olmayan" olarak tanımlanır
const OTHER_SPORTS = new RegExp(`(?<![\\p{L}\\p{N}])(?:${OTHER_SPORTS_WORDS.map(wordRe).join('|')})`, 'u');

export function isFootball(item) {
  const text = `${item.title} ${(item.categories ?? []).join(' ')}`.toLocaleLowerCase('tr');
  return !OTHER_SPORTS.test(text);
}

/** Aynı haberin farklı kaynaklardaki kopyası için başlık anahtarı. */
export const titleKey = (t) =>
  String(t ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);

// -----------------------------------------------------------------------------------------------------------------
// Servis
// -----------------------------------------------------------------------------------------------------------------

/**
 * store: { listNews(sinceMs, limit), saveNews(items), getNews(id), listComments(id, limit), addComment(id, c),
 *          deleteComment(id, commentId) }
 * author: async (uid, guest) → { username, photoURL } (Sosyal'deki kullanıcı adı ve yasak denetimi)
 */
export class NewsService {
  constructor({ store, author, feeds = DEFAULT_FEEDS, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, isAdmin = null, timeoutMs = 10e3 }) {
    this.store = store;
    this.author = author;
    this.feeds = feeds;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.isAdmin = isAdmin;
    this.timeoutMs = timeoutMs;
    this._items = new Map(); // id → haber
    this._loaded = false;
    this._refreshedAt = 0;
    this._refreshing = null;
    this._lastComment = new Map();
    this.stats = { refreshes: 0, lastRefreshAt: null, feeds: {} };
  }

  async _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      for (const it of await this.store.listNews(this.now() - KEEP_MS, MAX_ITEMS)) this._items.set(it.id, it);
    } catch (e) {
      this.log.warn?.('[news] kayıtlar okunamadı', e?.message ?? e);
    }
  }

  async _fetchFeed(feed) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(feed.url, {
        signal: ctrl.signal,
        headers: { accept: 'application/rss+xml, application/xml, text/xml, */*', 'user-agent': 'Mozilla/5.0 (vSport haber okuyucu)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const xml = await res.text();
      return parseRss(xml, feed);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Beslemeleri okur (15 dakikada bir). Döner: yeni haber sayısı. */
  async refresh({ force = false } = {}) {
    await this._load();
    if (!force && this.now() - this._refreshedAt < REFRESH_MS) return 0;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      this._refreshedAt = this.now();
      const results = await Promise.all(
        this.feeds.map(async (f) => {
          try {
            const list = await this._fetchFeed(f);
            this.stats.feeds[f.id] = { ok: true, items: list.length, at: new Date(this.now()).toISOString() };
            return list;
          } catch (e) {
            this.stats.feeds[f.id] = { ok: false, error: String(e?.message ?? e).slice(0, 120), at: new Date(this.now()).toISOString() };
            return [];
          }
        }),
      );
      const now = this.now();
      const seenTitles = new Set([...this._items.values()].map((x) => titleKey(x.title)));
      const fresh = [];
      for (const it of results.flat()) {
        if (this._items.has(it.id) || !isFootball(it)) continue;
        const k = titleKey(it.title);
        if (seenTitles.has(k)) continue;
        seenTitles.add(k);
        const published = it.publishedMs && it.publishedMs <= now + 3600e3 ? it.publishedMs : now;
        if (now - published > KEEP_MS) continue;
        const { categories, ...rest } = it;
        const item = { ...rest, publishedMs: published, firstSeenMs: now, commentCount: 0 };
        this._items.set(item.id, item);
        fresh.push(item);
      }
      // Eski haberler bellekten düşer
      const sorted = [...this._items.values()].sort((a, b) => b.publishedMs - a.publishedMs);
      for (const x of sorted.slice(MAX_ITEMS)) this._items.delete(x.id);
      for (const x of sorted) if (now - x.publishedMs > KEEP_MS) this._items.delete(x.id);
      if (fresh.length) {
        try {
          await this.store.saveNews(fresh);
        } catch (e) {
          this.log.warn?.('[news] kaydedilemedi', e?.message ?? e);
        }
      }
      this.stats.refreshes++;
      this.stats.lastRefreshAt = new Date(now).toISOString();
      return fresh.length;
    })();
    try {
      return await this._refreshing;
    } finally {
      this._refreshing = null;
    }
  }

  _view(x) {
    return {
      id: x.id,
      title: x.title,
      summary: x.summary || null,
      image: x.image ?? null,
      url: x.url,
      source: x.source,
      sourceName: x.sourceName,
      publishedAt: new Date(x.publishedMs).toISOString(),
      commentCount: x.commentCount ?? 0,
    };
  }

  /** Haber listesi (yeniden eskiye). before: sayfalama (ISO zaman), source: tek kaynak. */
  async list({ uid, before = null, source = null, limit = 30 }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    await this._load();
    if (!this._items.size) await this.refresh({ force: true }).catch(() => 0);
    else this.refresh().catch((e) => this.log.warn?.('[news]', e?.message ?? e));
    const n = Math.max(1, Math.min(50, Number(limit) || 30));
    const beforeMs = before ? Date.parse(before) : Infinity;
    const all = [...this._items.values()]
      .filter((x) => (!source || x.source === source) && x.publishedMs < beforeMs)
      .sort((a, b) => b.publishedMs - a.publishedMs);
    const page = all.slice(0, n);
    const sources = this.feeds.filter((f) => [...this._items.values()].some((x) => x.source === f.id)).map(({ id, name }) => ({ id, name }));
    return {
      items: page.map((x) => this._view(x)),
      more: all.length > n,
      sources,
      updatedAt: this.stats.lastRefreshAt,
    };
  }

  async _item(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{20}$/.test(id)) throw new AppError('invalid-argument', 'Geçersiz haber.');
    await this._load();
    const mem = this._items.get(id);
    if (mem) return mem;
    const doc = await this.store.getNews(id);
    if (!doc) throw new AppError('not-found', 'Haber bulunamadı.');
    return doc;
  }

  /** Bir haber ve yorumları (yeniden eskiye, en çok 100). */
  async comments({ uid, id }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const item = await this._item(id);
    const list = await this.store.listComments(id, 100);
    return {
      item: this._view(item),
      comments: list.map((c) => ({
        id: c.id,
        uid: c.uid,
        username: c.username,
        photoURL: c.photoURL ?? null,
        text: c.text,
        createdAt: new Date(c.createdMs).toISOString(),
        mine: c.uid === uid,
      })),
    };
  }

  async comment({ uid, guest = false, id, text }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const u = await this.author(uid, guest);
    const body = String(text ?? '').trim();
    if (!body) throw new AppError('invalid-argument', 'Yorum boş olamaz.');
    if (body.length > NEWS_COMMENT_MAX) throw new AppError('invalid-argument', `Yorum en fazla ${NEWS_COMMENT_MAX} karakter olabilir.`);
    const item = await this._item(id);
    const last = this._lastComment.get(uid) ?? 0;
    if (this.now() - last < COMMENT_GAP_MS) throw new AppError('resource-exhausted', 'Biraz bekle; art arda yorum yazılamaz.');
    this._lastComment.set(uid, this.now());
    if (this._lastComment.size > 5000) this._lastComment.clear();
    const r = await this.store.addComment(id, { uid, username: u.username, photoURL: u.photoURL ?? null, text: body, createdMs: this.now() }, item);
    const mem = this._items.get(id);
    if (mem) mem.commentCount = r.commentCount;
    return r; // { id, commentCount }
  }

  async removeComment({ uid, id, commentId }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (typeof commentId !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(commentId)) throw new AppError('invalid-argument', 'Geçersiz yorum.');
    await this._item(id);
    const admin = this.isAdmin ? await this.isAdmin(uid) : false;
    const r = await this.store.deleteComment(id, commentId, admin ? null : uid);
    if (r === null) throw new AppError('not-found', 'Yorum bulunamadı.');
    if (r === false) throw new AppError('permission-denied', 'Bu yorumu silemezsin.');
    const mem = this._items.get(id);
    if (mem) mem.commentCount = r.commentCount;
    return r;
  }

  status() {
    return { ...this.stats, items: this._items.size };
  }
}

export function createNewsStore(db, FieldValue) {
  return {
    async listNews(sinceMs, limit) {
      const q = await db.collection('news').where('publishedMs', '>=', sinceMs).orderBy('publishedMs', 'desc').limit(limit).get();
      return q.docs.map((d) => d.data());
    },
    async saveNews(items) {
      const batch = db.batch();
      for (const it of items) batch.set(db.doc(`news/${it.id}`), it, { merge: true });
      await batch.commit();
    },
    async getNews(id) {
      const s = await db.doc(`news/${id}`).get();
      return s.exists ? s.data() : null;
    },
    async listComments(id, limit) {
      const q = await db.collection(`news/${id}/comments`).orderBy('createdMs', 'desc').limit(limit).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async addComment(id, c, item) {
      const ref = db.doc(`news/${id}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        // Haber kaydı yoksa (eski sunucu) şimdi yazılır
        if (!s.exists) tx.set(ref, { ...item, commentCount: 0 });
        const cref = ref.collection('comments').doc();
        tx.set(cref, { ...c, createdAt: FieldValue.serverTimestamp() });
        const count = Number(s.exists ? s.get('commentCount') ?? 0 : 0) + 1;
        tx.set(ref, { commentCount: count }, { merge: true });
        return { id: cref.id, commentCount: count };
      });
    },
    async deleteComment(id, commentId, ownerUid) {
      const ref = db.doc(`news/${id}`);
      const cref = ref.collection('comments').doc(commentId);
      return db.runTransaction(async (tx) => {
        const [s, c] = await Promise.all([tx.get(ref), tx.get(cref)]);
        if (!c.exists) return null;
        if (ownerUid && c.get('uid') !== ownerUid) return false;
        tx.delete(cref);
        const count = Math.max(0, Number(s.exists ? s.get('commentCount') ?? 1 : 1) - 1);
        if (s.exists) tx.set(ref, { commentCount: count }, { merge: true });
        return { deleted: true, commentCount: count };
      });
    },
  };
}
