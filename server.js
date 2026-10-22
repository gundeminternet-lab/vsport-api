// vSport API sunucusu — Render (ya da herhangi bir Node.js 22 barındırma) için giriş noktası.
// Firebase ücretsiz (Spark) planda kalır; bu sunucu Firestore'a servis hesabı anahtarıyla bağlanır.
//
// Ortam değişkenleri:
//   FIREBASE_SERVICE_ACCOUNT   Firebase konsolu → Proje ayarları → Hizmet hesapları → "Yeni özel anahtar oluştur"
//                              ile indirilen JSON dosyasının TAMAMI (gizli tutun, asla Git'e koymayın)
//   PORT                       barındırma hizmeti verir (varsayılan 8080)
//
// Başlatma: node server.js

import http from 'node:http';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

import { EspnClient } from './engine/espn.js';
import { PaidContentService } from './logic.js';
import { CouponService } from './coupons.js';
import { createStore } from './store.js';
import { createApi } from './app.js';
import { MatchWatcher } from './watcher.js';
import { createLeagueStore, previousWeekId } from './league.js';

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
const store = createStore(db, FieldValue);

const espn = new EspnClient();
const api = createApi({
  verifyToken: async (token) => (await auth.verifyIdToken(token)).uid,
  service: new PaidContentService({ store, espn }),
  coupons: new CouponService({ store }),
});

const port = Number(process.env.PORT ?? 8080);
http.createServer(api).listen(port, () => console.log(`vSport API ${port} portunda çalışıyor`));

// ---- Canlı maç bildirimleri ----
const messaging = getMessaging();
const league = createLeagueStore(db, FieldValue);
let awardedWeek = null; // bellekte: aynı hafta için her dakika işlem açılmasın
const watcher = new MatchWatcher({
  store,
  espn,
  // Tahmin ligi: biten maçın tahminleri puanlanır
  onFinished: (m) => league.scoreMatch(m),
  // Pazartesi (Türkiye saati) geçen haftanın ilk üçüne token ödülü; tekrar dağıtılmaz
  onTick: async (now) => {
    // Pazar gecesi biten maçlar da puanlansın diye Pazartesi 06:00'dan sonra dağıtılır.
    const week = previousWeekId(now - 6 * 3600e3);
    if (awardedWeek === week) return;
    const winners = await league.awardWeek(week);
    if (winners.length) console.log(`[league] ${week} ödülleri:`, winners.map((w) => `${w.rank}. ${w.username} +${w.amount}`).join(', '));
    awardedWeek = week;
  },
  send: ({ topic, title, body, data }) =>
    messaging.send({
      topic,
      notification: { title, body },
      data,
      android: { priority: 'high', notification: { channelId: 'match_events', sound: 'default' } },
    }),
});
watcher.start(60000);

// Ücretsiz Render servisi 15 dk istek gelmezse uyur ve maçları izleyemez. Sunucu 9 dakikada bir kendi adresini
// çağırarak uyanık kalır (tek servis için aylık 750 ücretsiz saat buna yeter). RENDER_EXTERNAL_URL'i Render verir.
const selfUrl = process.env.RENDER_EXTERNAL_URL;
if (selfUrl) {
  setInterval(() => fetch(`${selfUrl}/health`).catch(() => {}), 9 * 60 * 1000);
}
