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

import { EspnClient } from './engine/espn.js';
import { PaidContentService } from './logic.js';
import { CouponService } from './coupons.js';
import { createStore } from './store.js';
import { createApi } from './app.js';

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

const api = createApi({
  verifyToken: async (token) => (await auth.verifyIdToken(token)).uid,
  service: new PaidContentService({ store, espn: new EspnClient() }),
  coupons: new CouponService({ store }),
});

const port = Number(process.env.PORT ?? 8080);
http.createServer(api).listen(port, () => console.log(`vSport API ${port} portunda çalışıyor`));
