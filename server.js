// vSport API sunucusu — Render (ya da herhangi bir Node.js 22 barındırma) için giriş noktası.
// Firebase ücretsiz (Spark) planda kalır; bu sunucu Firestore'a servis hesabı anahtarıyla bağlanır.
//
// Ortam değişkenleri:
//   FIREBASE_SERVICE_ACCOUNT   Firebase konsolu → Proje ayarları → Hizmet hesapları → "Yeni özel anahtar oluştur"
//                              ile indirilen JSON dosyasının TAMAMI (gizli tutun, asla Git'e koymayın)
//   PORT                       barındırma hizmeti verir (varsayılan 8080)
//   PLAY_PACKAGE_NAME          Google Play paket adı (varsayılan com.macsimulasyon.futbol_app)
//   PLAY_SERVICE_ACCOUNT       (isteğe bağlı) Play Console'a yetkili servis hesabı JSON'u; yoksa FIREBASE_SERVICE_ACCOUNT
//   PLAY_RTDN_SECRET           Play abonelik bildirimleri adresindeki ?secret= değeri (/play/rtdn)
//   ASSISTANT_OPEN=true        (yalnızca test) AI Asistan'ı abonelik aramadan herkese açar
//   DAILY_PER_MINUTE           günlük tahminlerde dakikada hesaplanan yeni maç sayısı (varsayılan 4)
//
// Başlatma: node server.js

import http from 'node:http';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

import { EspnClient } from './engine/espn.js';
import { PaidContentService } from './logic.js';
import { CouponService } from './coupons.js';
import { createStore } from './store.js';
import { createApi } from './app.js';
import { MatchWatcher } from './watcher.js';
import { fcmMessage } from './notify.js';
import { createLeagueStore, previousWeekId } from './league.js';
import { createProgressStore, XP } from './progress.js';
import { createPollStore } from './polls.js';
import { CouponSettler, createSettleStore } from './settle.js';
import { TrackService, createTrackStore } from './track.js';
import { LineupService } from './lineup.js';
import { LiveForecastService } from './live_forecast.js';
import { BulletinService } from './bulletin.js';
import { narratorFromEnv } from './narrator.js';
import { readerFromEnv } from './coupon_vision.js';
import { StoryReviewService } from './story_review.js';
import { AccountService } from './account.js';
import { CouponCheckService } from './check.js';
import { createRewardStore } from './rewards.js';
import { createAdminService } from './admin.js';
import { createTts } from './tts.js';
import { AssistantService } from './assistant.js';
import { ASSISTANT_DAILY_LIMIT, AccessService, PLAN_PRICES_TL, PLAN_PRODUCTS, TRIAL_MATCHES } from './subscription.js';
import { billingFromEnv } from './billing.js';
import { createFeaturedService } from './featured.js';
import { WheelService, WHEEL_WEIGHTS, WHEEL_SLICES, CREDIT_DAYS, ASSISTANT_PRIZE_HOURS } from './wheel.js';
import { DailyPredictionService, createDailyStore } from './daily.js';

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT ortam değişkeni tanımlı değil.');
  // JSON doğrudan ya da base64 olarak verilebilir.
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return JSON.parse(text);
}

initializeApp({ credential: cert(serviceAccount()) });
const db = getFirestore();
const auth = getAuth();
const baseStore = createStore(db, FieldValue);
const rewards = createRewardStore(db, FieldValue);
const progress = createProgressStore(db, FieldValue, undefined, rewards);
// Ücretli içerik ilk kez açıldığında (abonelikle ya da deneme hakkıyla) seviye/rozet ilerlemesi
const store = {
  ...baseStore,
  async recordUnlock(args) {
    const r = await baseStore.recordUnlock(args);
    if (r.created) progress.add(args.uid, { unlocks: 1, xp: XP.unlock }).catch(() => {});
    return r;
  },
  async useTrial(args) {
    const r = await baseStore.useTrial(args);
    if (r.used) progress.add(args.uid, { unlocks: 1, xp: XP.unlock }).catch(() => {});
    return r;
  },
  async useWheelCredit(args) {
    const r = await baseStore.useWheelCredit(args);
    if (r.used) progress.add(args.uid, { unlocks: 1, xp: XP.unlock }).catch(() => {});
    return r;
  },
  // Kupon kontrol sonuçları kullanıcının geçmişine (yalnızca kendisi okur)
  async saveCheck(uid, id, result) {
    await db.doc(`users/${uid}/checks/${id}`).set({ ...result, createdAt: FieldValue.serverTimestamp() });
  },
};

const espn = new EspnClient();
const trackService = new TrackService({ store: createTrackStore(db), espn });
// Abonelik: Google Play doğrulaması + erişim denetimi (bitmiş görünen Play aboneliği mağazadan yeniden okunur)
const billing = billingFromEnv(baseStore);
const access = new AccessService({ store: baseStore, billing });
if (!billing.enabled) console.warn('[billing] Google Play doğrulaması kapalı: servis hesabı ya da paket adı eksik.');
const paidService = new PaidContentService({ store, espn, track: trackService, access });
// Günlük toplu tahminler: kendi liglerimizin bugünkü ve yarınki maçları, maç başlamadan hesaplanır
const daily = new DailyPredictionService({
  paid: paidService,
  store: { ...createDailyStore(db, FieldValue), hasUnlock: baseStore.hasUnlock },
  espn,
  access,
  perTick: Number(process.env.DAILY_PER_MINUTE) || 4,
});
const narrator = narratorFromEnv();
const couponReader = readerFromEnv();
const api = createApi({
  // Misafir (anonim oturum) yalnızca okuma uçlarını kullanabilir (app.js → GUEST_ROUTES)
  verifyToken: async (token) => {
    const t = await auth.verifyIdToken(token);
    return { uid: t.uid, anonymous: t.firebase?.sign_in_provider === 'anonymous' };
  },
  service: paidService,
  checker: new CouponCheckService({ paid: paidService, store, narrator }),
  rewards,
  admin: createAdminService({ db, FieldValue, auth }),
  tts: createTts({ db, FieldValue }),
  // AI Asistan aylık ve yıllık abonelere açık. Yalnızca test için ASSISTANT_OPEN=true herkese açar.
  // ASSISTANT_DAILY_LIMIT ile günlük sınır değiştirilebilir (varsayılan 15).
  assistant: new AssistantService({
    paid: paidService,
    store,
    narrator,
    access,
    requireSubscription: process.env.ASSISTANT_OPEN !== 'true',
    dailyLimit: Number(process.env.ASSISTANT_DAILY_LIMIT) || ASSISTANT_DAILY_LIMIT,
  }),
  featured: createFeaturedService({ db, FieldValue, Timestamp, paid: paidService }),
  coupons: new CouponService({ store, access }),
  billing,
  access,
  // Günlük hediye çarkı (+10 XP ödülü seviyeye işlenir)
  wheel: new WheelService({ store: baseStore, progress }),
  daily,
  progress,
  track: trackService,
  lineup: new LineupService({ paid: paidService, espn }),
  // Tek canlı model: canlı kart, baskı kartı ve AI yorumcu aynı ihtimalleri buradan alır
  liveForecast: new LiveForecastService({ paid: paidService }),
  bulletin: new BulletinService({ espn, db }),
  reader: couponReader,
  storyReview: new StoryReviewService({ paid: paidService }),
  account: new AccountService({ db, auth }),
  info: {
    version: '2026-10-26-tahminler',
    assistantRequiresSubscription: process.env.ASSISTANT_OPEN !== 'true',
    billingEnabled: billing.enabled,
    plans: { prices: PLAN_PRICES_TL, products: PLAN_PRODUCTS, trialMatches: TRIAL_MATCHES },
    wheel: { weights: WHEEL_WEIGHTS, slices: WHEEL_SLICES, creditDays: CREDIT_DAYS, assistantHours: ASSISTANT_PRIZE_HOURS },
    assistantDailyLimit: Number(process.env.ASSISTANT_DAILY_LIMIT) || ASSISTANT_DAILY_LIMIT,
  },
});

const port = Number(process.env.PORT ?? 8080);
http.createServer(api).listen(port, () => console.log(`vSport API ${port} portunda çalışıyor`));

// ---- Canlı maç bildirimleri ----
const messaging = getMessaging();
const league = createLeagueStore(db, FieldValue, progress);
const polls = createPollStore(db, FieldValue, Timestamp);
const settler = new CouponSettler({ store: createSettleStore(db, FieldValue), espn });
let lastSettle = 0;
let lastTrack = 0;
let lastDailyResolve = 0;
let awardedWeek = null; // bellekte: aynı hafta için her dakika işlem açılmasın
const watcher = new MatchWatcher({
  store,
  espn,
  // Penaltı, kırmızı kart, VAR, gol iptali: maç sohbetinde otomatik anket
  onNote: (n) => polls.autoPoll(n),
  // Tahmin ligi: biten maçın tahminleri puanlanır
  onFinished: (m) => league.scoreMatch(m),
  // Pazartesi (Türkiye saati) geçen haftanın ilk üçüne token ödülü; tekrar dağıtılmaz
  onTick: async (now) => {
    // Günlük tahminler: her dakika birkaç yeni maç hesaplanır; sonuçlar 10 dakikada bir işlenir
    daily.tick().then((n) => n && console.log(`[daily] ${n} maç tahmini hazırlandı`)).catch((e) => console.error('[daily]', e?.message ?? e));
    if (now - lastDailyResolve >= 10 * 60e3) {
      lastDailyResolve = now;
      daily.resolveDue().then((n) => n && console.log(`[daily] ${n} maç sonuçlandı`)).catch((e) => console.error('[daily]', e?.message ?? e));
    }
    // Tahmin karnesi: bitmiş maçların bekleyen tahminleri sonuçlanır (10 dakikada bir)
    if (now - lastTrack >= 10 * 60e3) {
      lastTrack = now;
      trackService.resolveDue().then((n) => n && console.log(`[track] ${n} tahmin sonuçlandı`)).catch((e) => console.error('[track]', e?.message ?? e));
    }
    // Kuponlar 10 dakikada bir sonuçlandırılır (editör karnesi)
    if (now - lastSettle >= 10 * 60e3) {
      lastSettle = now;
      settler.run().then((n) => n && console.log(`[settle] ${n} kupon sonuçlandı`)).catch((e) => console.error('[settle]', e?.message ?? e));
    }
    // Pazar gecesi biten maçlar da puanlansın diye Pazartesi 06:00'dan sonra dağıtılır.
    const week = previousWeekId(now - 6 * 3600e3);
    if (awardedWeek === week) return;
    const winners = await league.awardWeek(week);
    if (winners.length) console.log(`[league] ${week} kürsüsü:`, winners.map((w) => `${w.rank}. ${w.username} (${w.points} puan)`).join(', '));
    awardedWeek = week;
  },
  send: (message) => messaging.send(fcmMessage(message)),
});
watcher.start(60000);

// Ücretsiz Render servisi 15 dk istek gelmezse uyur ve maçları izleyemez. Sunucu 9 dakikada bir kendi adresini
// çağırarak uyanık kalır (tek servis için aylık 750 ücretsiz saat buna yeter). RENDER_EXTERNAL_URL'i Render verir.
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => fetch(`${selfUrl}/health`).catch(() => {}), 9 * 60 * 1000);
}
