// Bağımsız HTTP API (Render vb. ücretsiz Node.js barındırma için). Firebase'e doğrudan bağlı değildir;
// kimlik doğrulama ve servisler dışarıdan verilir, bu yüzden bilgisayarda test edilebilir (test/app.test.js).
//
//   GET  /health                      → 200 "ok"  (uyku önleme / sağlık kontrolü)
//   POST /api/{ad}  { data: {...} }   → 200 { result } | 4xx/5xx { error: { code, message } }
//   POST /play/rtdn?secret=…            → Google Play abonelik bildirimi (Pub/Sub push)
//        ad: unlockContent | getContent | getReview | unlockCoupon | unlockSpecial | getSpecial | assistantAnalyze | getTrackRecord | getLineupUpdate | getLiveForecast | getWeeklyBulletin | readCouponImage | getStoryReview | deleteAccount | getVerdicts | verifyPlaySubscription | getEntitlement | spinWheel | getWheel | getDailyPredictions
//            setFeatured | clearFeatured | adminSetSubscription (ve diğer yönetim/ödül/ses uçları)
//   Authorization: Bearer <Firebase ID token>   (uygulama her istekte gönderir)
//   Misafir (Firebase anonim oturum) yalnızca GUEST_ROUTES'taki okuma uçlarını kullanabilir; deneme hakkı, çark,
//   satın alma, sohbet ve Asistan gibi işlemler giriş ister.

import { AppError } from './errors.js';

/** Misafirin (anonim oturum) kullanabileceği uçlar: yalnızca okuma, hak harcamayan işlemler. */
export const GUEST_ROUTES = new Set([
  'getContent',
  'getReview',
  'getSpecial',
  'getEntitlement',
  'getDailyPredictions',
  'getTrackRecord',
  'getVerdicts',
  'getLineupUpdate',
  'getLiveForecast',
  'getStoryReview',
  'getWeeklyBulletin',
]);

const STATUS = {
  'invalid-argument': 400,
  unauthenticated: 401,
  'permission-denied': 403,
  'not-found': 404,
  'failed-precondition': 409,
  'subscription-required': 402,
  'resource-exhausted': 429,
  internal: 500,
  unavailable: 503,
};

export function createApi({ verifyToken, service, coupons, progress = null, checker = null, rewards = null, admin = null, tts = null, assistant = null, featured = null, track = null, lineup = null, liveForecast = null, bulletin = null, reader = null, storyReview = null, account = null, billing = null, access = null, wheel = null, daily = null, info = null, maxBodyBytes = 16 * 1024, rateLimit = 40, log = console }) {
  const routes = {
    unlockContent: (d) => service.unlock(d),
    getContent: (d) => service.get(d),
    getReview: (d) => service.review(d),
    unlockCoupon: (d) => coupons.unlock(d),
    unlockSpecial: (d) => service.unlockSpecial(d),
    getSpecial: (d) => service.getSpecial(d),
    ...(track ? { getTrackRecord: (d) => track.trackRecord(d), getVerdicts: (d) => track.verdicts(d) } : {}),
    ...(bulletin ? { getWeeklyBulletin: (d) => bulletin.get(d) } : {}),
    ...(reader ? { readCouponImage: (d) => reader.read(d) } : {}),
    ...(storyReview ? { getStoryReview: (d) => storyReview.review(d) } : {}),
    ...(account ? { deleteAccount: (d) => account.deleteAccount(d) } : {}),
    // Abonelik: Google Play satın alma doğrulaması ve kullanıcının hakları (abonelik, deneme hakkı)
    ...(billing ? { verifyPlaySubscription: (d) => billing.verify(d) } : {}),
    ...(access ? { getEntitlement: (d) => access.entitlement(d.uid) } : {}),
    // Günlük hediye çarkı: günde bir ücretsiz çevirme (sonuç sunucuda belirlenir)
    ...(wheel ? { spinWheel: (d) => wheel.spin(d), getWheel: (d) => wheel.status(d) } : {}),
    // Günlük toplu tahminler (Tahminler sekmesi, Ana Sayfa, Canlı takip)
    ...(daily ? { getDailyPredictions: (d) => daily.list(d) } : {}),
    ...(lineup ? { getLineupUpdate: (d) => lineup.update(d) } : {}),
    ...(liveForecast ? { getLiveForecast: (d) => liveForecast.forecast(d) } : {}),
    ...(assistant ? { assistantAnalyze: (d) => assistant.analyze(d) } : {}),
    ...(featured ? { setFeatured: (d) => featured.set(d), clearFeatured: (d) => featured.clear(d) } : {}),
    ...(progress ? { checkIn: (d) => progress.checkIn(d) } : {}),
    ...(checker ? { checkCoupon: (d) => checker.check(d) } : {}),
    ...(admin
      ? { adminSetRole: (d) => admin.setRole(d), adminSetBanned: (d) => admin.setBanned(d), adminSetSubscription: (d) => admin.setSubscription(d) }
      : {}),
    ...(tts ? { tts: (d) => tts.speak(d) } : {}),
    ...(rewards ? { myInviteCode: (d) => rewards.myInviteCode(d), redeemInvite: (d) => rewards.redeemInvite(d) } : {}),
  };

  // Kullanıcı başına dakikada en fazla [rateLimit] istek (bellekte; tek örnek için yeterli).
  const hits = new Map();
  const limited = (uid) => {
    const minute = Math.floor(Date.now() / 60000);
    const h = hits.get(uid);
    if (!h || h.minute !== minute) {
      hits.set(uid, { minute, n: 1 });
      if (hits.size > 10000) hits.clear();
      return false;
    }
    h.n++;
    return h.n > rateLimit;
  };

  const send = (res, status, body) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
  };
  const fail = (res, code, message) => send(res, STATUS[code] ?? 500, { error: { code, message } });

  const readBody = (req, limit = maxBodyBytes) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new AppError('invalid-argument', 'İstek çok büyük.'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Hangi sürümün yayında olduğunu tarayıcıdan görmek için (gizli bilgi içermez).
    if (req.method === 'GET' && url.pathname === '/version') return send(res, 200, info ?? {});
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    // Google Play gerçek zamanlı bildirimleri (Pub/Sub push). Kimlik: adresteki ?secret= (PLAY_RTDN_SECRET).
    if (req.method === 'POST' && url.pathname === '/play/rtdn' && billing) {
      try {
        const raw = await readBody(req, 64 * 1024);
        const r = await billing.handleRtdn(raw ? JSON.parse(raw) : {}, url.searchParams.get('secret'));
        res.writeHead(r.status);
        return res.end();
      } catch (e) {
        log.error?.(e);
        // 5xx: Pub/Sub bildirimi daha sonra yeniden dener
        res.writeHead(500);
        return res.end();
      }
    }
    const m = /^\/api\/([A-Za-z]+)$/.exec(url.pathname);
    if (!m || !Object.hasOwn(routes, m[1])) return fail(res, 'not-found', 'Bulunamadı.');
    if (req.method !== 'POST') return fail(res, 'invalid-argument', 'Yalnızca POST.');

    try {
      // Kimlik: Firebase ID token. Sahte ya da süresi geçmiş belge reddedilir.
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!token) return fail(res, 'unauthenticated', 'Giriş yapmalısınız.');
      let uid;
      let guest = false;
      try {
        // verifyToken: uid ya da { uid, anonymous } döner
        const v = await verifyToken(token);
        uid = typeof v === 'string' ? v : v?.uid;
        guest = typeof v === 'object' && v !== null && v.anonymous === true;
      } catch {
        return fail(res, 'unauthenticated', 'Oturum doğrulanamadı; lütfen tekrar giriş yapın.');
      }
      if (!uid) return fail(res, 'unauthenticated', 'Giriş yapmalısınız.');
      if (guest && !GUEST_ROUTES.has(m[1])) return fail(res, 'unauthenticated', 'Bu işlem için Google ile giriş yapmalısın.');
      if (limited(uid)) return fail(res, 'resource-exhausted', 'Çok fazla istek; biraz sonra tekrar deneyin.');

      let data = {};
      // Ekran görüntüsü yalnızca bu uç noktada daha büyük gövde kabul eder.
      const raw = await readBody(req, m[1] === 'readCouponImage' ? 4 * 1024 * 1024 : maxBodyBytes);
      if (raw) {
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return fail(res, 'invalid-argument', 'Geçersiz istek.');
        }
        if (parsed && typeof parsed.data === 'object' && parsed.data !== null && !Array.isArray(parsed.data)) data = parsed.data;
      }
      // uid ve misafir bilgisi her zaman doğrulanmış belgeden gelir; istemcinin gönderdikleri yok sayılır.
      const result = await routes[m[1]]({ ...data, uid, ...(guest ? { guest: true } : {}) });
      return send(res, 200, { result });
    } catch (e) {
      if (e instanceof AppError) return fail(res, e.code, e.message);
      log.error?.(e);
      return fail(res, 'internal', 'İşlem tamamlanamadı, lütfen tekrar deneyin.');
    }
  };
}
