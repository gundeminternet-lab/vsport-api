// Günlük futbol haberleri (news.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRss, isFootball, decodeEntities, stripHtml, feedsFromEnv, newsId, titleKey, NewsService, NEWS_COMMENT_MAX } from '../news.js';

const SRC = { id: 'trt', name: 'TRT Haber' };
const now0 = Date.parse('2026-11-03T12:00:00Z');

const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Spor</title>${items.join('')}</channel></rss>`;
const item = ({ title, link, desc = '', date = 'Tue, 03 Nov 2026 10:00:00 GMT', extra = '' }) =>
  `<item><title><![CDATA[${title}]]></title><link>${link}</link><description><![CDATA[${desc}]]></description><pubDate>${date}</pubDate>${extra}</item>`;

test('parseRss: CDATA, entity, görsel ve özet', () => {
  const xml = rss([
    item({ title: 'Galatasaray&#39;da yeni transfer', link: 'https://www.trthaber.com/a1.html', desc: '<img src="https://img.example/a1.jpg"/><p>Sarı-kırmızılılar &quot;golcü&quot; arıyor.</p>' }),
    item({ title: 'Fenerbahçe kazandı', link: 'http://www.example.com/a2', extra: '<enclosure url="https://img.example/a2.jpg" type="image/jpeg"/>' }),
    item({ title: 'Beşiktaş hazırlık', link: 'https://example.com/a3', extra: '<media:content url="https://img.example/a3.jpg" medium="image"/>' }),
    '<item><title>Bağlantısız haber</title></item>',
  ]);
  const list = parseRss(xml, SRC);
  assert.equal(list.length, 3);
  assert.equal(list[0].title, "Galatasaray'da yeni transfer");
  assert.equal(list[0].image, 'https://img.example/a1.jpg');
  assert.equal(list[0].summary, 'Sarı-kırmızılılar "golcü" arıyor.');
  assert.equal(list[0].source, 'trt');
  assert.equal(list[0].sourceName, 'TRT Haber');
  assert.equal(list[0].publishedMs, Date.parse('2026-11-03T10:00:00Z'));
  assert.equal(list[0].id, newsId('trt', 'https://www.trthaber.com/a1.html'));
  assert.match(list[0].id, /^[a-f0-9]{20}$/);
  // http bağlantıları https'e çevrilir
  assert.equal(list[1].url, 'https://www.example.com/a2');
  assert.equal(list[1].image, 'https://img.example/a2.jpg');
  assert.equal(list[2].image, 'https://img.example/a3.jpg');
});

test('parseRss: uzun özet kısaltılır, başlıkla aynı özet atılır', () => {
  const long = 'Bu cümle uzun bir haber metninin parçasıdır. '.repeat(20);
  const list = parseRss(rss([item({ title: 'A', link: 'https://x.com/1', desc: long }), item({ title: 'Aynı', link: 'https://x.com/2', desc: 'Aynı' })]), SRC);
  assert.ok(list[0].summary.length <= 261);
  assert.ok(list[0].summary.endsWith('.'));
  assert.equal(list[1].summary, '');
});

test('decodeEntities ve stripHtml', () => {
  assert.equal(decodeEntities('a &amp; b &#252; &#xE7;'), 'a & b ü ç');
  assert.equal(stripHtml('<p>Merhaba<br/>dünya</p><script>x()</script>'), 'Merhaba dünya');
});

test('isFootball: futbol dışı sporlar ayıklanır', () => {
  const t = (title, categories = []) => isFootball({ title, categories });
  assert.equal(t('Galatasaray derbide gol yağdırdı'), true);
  assert.equal(t('Golcü oyuncu sakatlandı'), true);
  assert.equal(t('Atatürk Olimpiyat Stadı finale hazır'), true);
  assert.equal(t('Basketbolda dev maç'), false);
  assert.equal(t("Fenerbahçe Beko EuroLeague'de kazandı"), false);
  assert.equal(t('Filenin Sultanları finalde'), false);
  assert.equal(t('F1 takvimi açıklandı'), false);
  assert.equal(t('Milli güreşçi altın aldı'), false);
  assert.equal(t('Maç sonucu', ['Voleybol']), false);
});

test('feedsFromEnv', () => {
  assert.equal(feedsFromEnv(''), null);
  assert.deepEqual(feedsFromEnv('a|A Spor|https://a.com/rss; b|B|http://insecure ; c|C|https://c.com/x'), [
    { id: 'a', name: 'A Spor', url: 'https://a.com/rss' },
    { id: 'c', name: 'C', url: 'https://c.com/x' },
  ]);
});

test('titleKey: noktalama ve büyük harf farkı yok sayılır', () => {
  assert.equal(titleKey('İcardi: "Hazırım!"'), titleKey('icardi hazırım'));
});

// ---------------------------------------------------------------------------------------------------------------

function fakeStore() {
  const news = new Map();
  const comments = new Map();
  let seq = 0;
  return {
    news,
    comments,
    async listNews(sinceMs, limit) {
      return [...news.values()].filter((x) => x.publishedMs >= sinceMs).sort((a, b) => b.publishedMs - a.publishedMs).slice(0, limit);
    },
    async saveNews(items) {
      for (const it of items) news.set(it.id, { ...it });
    },
    async getNews(id) {
      return news.get(id) ?? null;
    },
    async listComments(id, limit) {
      return [...(comments.get(id) ?? [])].sort((a, b) => b.createdMs - a.createdMs).slice(0, limit);
    },
    async addComment(id, c, item) {
      if (!news.has(id)) news.set(id, { ...item, commentCount: 0 });
      const list = comments.get(id) ?? [];
      const cid = `c${++seq}`;
      list.push({ id: cid, ...c });
      comments.set(id, list);
      const n = news.get(id);
      n.commentCount = (n.commentCount ?? 0) + 1;
      return { id: cid, commentCount: n.commentCount };
    },
    async deleteComment(id, commentId, ownerUid) {
      const list = comments.get(id) ?? [];
      const i = list.findIndex((c) => c.id === commentId);
      if (i < 0) return null;
      if (ownerUid && list[i].uid !== ownerUid) return false;
      list.splice(i, 1);
      const n = news.get(id);
      n.commentCount = Math.max(0, (n.commentCount ?? 1) - 1);
      return { deleted: true, commentCount: n.commentCount };
    },
  };
}

const FEEDS = [
  { id: 'trt', name: 'TRT Haber', url: 'https://feed.test/trt' },
  { id: 'ht', name: 'Habertürk', url: 'https://feed.test/ht' },
  { id: 'bad', name: 'Bozuk', url: 'https://feed.test/bad' },
];

function service({ bodies, clock = { t: now0 }, users = {}, admins = [] } = {}) {
  const store = fakeStore();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.endsWith('/bad')) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => bodies[url.split('/').pop()] ?? rss([]) };
  };
  const author = async (uid, guest) => {
    if (guest) throw Object.assign(new Error('guest'), { code: 'unauthenticated' });
    const u = users[uid];
    if (!u) throw Object.assign(new Error('no user'), { code: 'permission-denied' });
    return u;
  };
  const svc = new NewsService({ store, author, feeds: FEEDS, fetchImpl, now: () => clock.t, log: { warn() {} }, isAdmin: async (uid) => admins.includes(uid) });
  return { svc, store, clock, calls: () => calls };
}

const iso = (ms) => new Date(ms).toUTCString();

test('NewsService: beslemeleri birleştirir, tekrarları ve futbol dışını atar, sayfalar', async () => {
  const bodies = {
    trt: rss([
      item({ title: 'Galatasaray kazandı', link: 'https://trt/1', date: iso(now0 - 3600e3) }),
      item({ title: 'Basketbolda Efes kazandı', link: 'https://trt/2', date: iso(now0 - 2 * 3600e3) }),
      item({ title: 'Eski haber', link: 'https://trt/3', date: iso(now0 - 5 * 86400e3) }),
    ]),
    ht: rss([
      item({ title: 'GALATASARAY KAZANDI!', link: 'https://ht/1', date: iso(now0 - 3000e3) }),
      item({ title: 'Trabzonspor yeni hocasını açıkladı', link: 'https://ht/2', date: iso(now0 - 600e3) }),
      item({ title: 'Göztepe hazırlıklara başladı', link: 'https://ht/3', date: iso(now0 - 7200e3) }),
    ]),
  };
  const { svc, store, calls } = service({ bodies });
  const r = await svc.list({ uid: 'u1', limit: 2 });
  assert.equal(calls(), 3);
  assert.deepEqual(r.items.map((x) => x.title), ['Trabzonspor yeni hocasını açıkladı', 'Galatasaray kazandı']);
  assert.equal(r.more, true);
  assert.deepEqual(r.sources, [
    { id: 'trt', name: 'TRT Haber' },
    { id: 'ht', name: 'Habertürk' },
  ]);
  assert.equal(store.news.size, 3);
  assert.equal(svc.status().feeds.bad.ok, false);
  assert.equal(svc.status().feeds.trt.ok, true);

  const page2 = await svc.list({ uid: 'u1', before: r.items[1].publishedAt, limit: 2 });
  assert.deepEqual(page2.items.map((x) => x.title), ['Göztepe hazırlıklara başladı']);
  assert.equal(page2.more, false);

  const onlyHt = await svc.list({ uid: 'u1', source: 'ht' });
  assert.ok(onlyHt.items.every((x) => x.source === 'ht'));

  // 15 dakika dolmadan beslemeler tekrar okunmaz
  await svc.list({ uid: 'u1' });
  assert.equal(calls(), 3);
  await assert.rejects(svc.list({ uid: null }), /Giriş/);
});

test('NewsService: yeniden başlayınca kayıtlı haberler okunur', async () => {
  const bodies = { trt: rss([item({ title: 'Galatasaray kazandı', link: 'https://trt/1', date: iso(now0 - 3600e3) })]) };
  const a = service({ bodies });
  await a.svc.refresh({ force: true });
  const b = new NewsService({ store: a.store, author: async () => ({}), feeds: [], now: () => now0, log: { warn() {} } });
  const r = await b.list({ uid: 'u1' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].sourceName, 'TRT Haber');
});

test('NewsService: yorum yazma, sayaç, bekleme, silme yetkisi', async () => {
  const bodies = { trt: rss([item({ title: 'Galatasaray kazandı', link: 'https://trt/1', date: iso(now0 - 3600e3) })]) };
  const users = { u1: { username: 'ali', photoURL: null }, u2: { username: 'veli' }, adm: { username: 'yonetici' } };
  const { svc, clock } = service({ bodies, users, admins: ['adm'] });
  const [news] = (await svc.list({ uid: 'u1' })).items;

  await assert.rejects(svc.comment({ uid: 'u1', id: news.id, text: '   ' }), /boş/);
  await assert.rejects(svc.comment({ uid: 'u1', id: news.id, text: 'x'.repeat(NEWS_COMMENT_MAX + 1) }), /en fazla/);
  await assert.rejects(svc.comment({ uid: 'g', guest: true, id: news.id, text: 'selam' }), (e) => e.code === 'unauthenticated');
  await assert.rejects(svc.comment({ uid: 'u1', id: 'yok', text: 'selam' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc.comment({ uid: 'u1', id: 'a'.repeat(20), text: 'selam' }), (e) => e.code === 'not-found');

  const c1 = await svc.comment({ uid: 'u1', id: news.id, text: ' Harika maçtı ' });
  assert.equal(c1.commentCount, 1);
  await assert.rejects(svc.comment({ uid: 'u1', id: news.id, text: 'yine ben' }), (e) => e.code === 'resource-exhausted');
  clock.t += 6e3;
  const c2 = await svc.comment({ uid: 'u2', id: news.id, text: 'Katılıyorum' });
  assert.equal(c2.commentCount, 2);

  const view = await svc.comments({ uid: 'u1', id: news.id });
  assert.equal(view.item.commentCount, 2);
  assert.deepEqual(view.comments.map((c) => [c.username, c.text, c.mine]), [
    ['veli', 'Katılıyorum', false],
    ['ali', 'Harika maçtı', true],
  ]);
  assert.equal((await svc.list({ uid: 'u1' })).items[0].commentCount, 2);

  // Başkasının yorumunu yalnızca yönetici siler
  await assert.rejects(svc.removeComment({ uid: 'u2', id: news.id, commentId: c1.id }), (e) => e.code === 'permission-denied');
  const d1 = await svc.removeComment({ uid: 'u1', id: news.id, commentId: c1.id });
  assert.equal(d1.commentCount, 1);
  const d2 = await svc.removeComment({ uid: 'adm', id: news.id, commentId: c2.id });
  assert.equal(d2.commentCount, 0);
  await assert.rejects(svc.removeComment({ uid: 'u1', id: news.id, commentId: c1.id }), (e) => e.code === 'not-found');
  await assert.rejects(svc.removeComment({ uid: 'u1', id: news.id, commentId: '../x' }), (e) => e.code === 'invalid-argument');
});
