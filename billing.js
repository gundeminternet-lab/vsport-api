// Google Play abonelikleri: satın alma doğrulama, süre yenileme ve gerçek zamanlı bildirimler (RTDN).
//
// Akış:
//   1) Uygulama Play'den satın alır (ürün: vsport_weekly | vsport_monthly | vsport_yearly; hesap kimliği olarak
//      Firebase uid gönderilir) ve satın alma belgesini (purchaseToken) verifyPlaySubscription ile sunucuya yollar.
//   2) Sunucu Google Play Developer API'den aboneliği okur (subscriptionsv2): ürün, bitiş zamanı, durum, hesap kimliği.
//      Geçerliyse users/{uid}.subscription yazılır; satın alma onaylanmamışsa sunucu onaylar (3 gün içinde onaylanmayan
//      satın alma Google tarafından iade edilir).
//   3) Yenileme, iptal, askıya alma: Play gerçek zamanlı bildirimi (Pub/Sub push → POST /play/rtdn?secret=...) gelince
//      ve abonelik bitmiş görünürken yapılan erişim denetiminde (subscription.js → AccessService) yeniden okunur.
//
// Satın alma belgesi yalnızca sunucuda tutulur: play_tokens/{sha256} → { uid, token, productId }; billing/{uid} →
// { tokenHash }. Aynı satın alma iki hesaba bağlanamaz.
//
// Ortam değişkenleri:
//   PLAY_PACKAGE_NAME        uygulamanın paket adı (varsayılan com.macsimulasyon.futbol_app)
//   PLAY_SERVICE_ACCOUNT     Play Console'a yetkili servis hesabı JSON'u (düz ya da base64). Yoksa FIREBASE_SERVICE_ACCOUNT
//                            kullanılır (o hesabın Play Console → Kullanıcılar ve izinler'de yetkisi olmalı).
//   PLAY_RTDN_SECRET         Pub/Sub push adresindeki ?secret= değeri

import { createHash, createSign } from 'node:crypto';

import { AppError } from './errors.js';
import { planOfProduct } from './subscription.js';

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

/** Abonelik bitiş zamanına kadar erişim veren durumlar. CANCELED: yenilenmeyecek ama süre bitene kadar geçerli. */
export const ACTIVE_STATES = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];

export const tokenHash = (token) => createHash('sha256').update(String(token)).digest('hex');

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

/** Servis hesabıyla OAuth erişim belgesi (JWT bearer akışı). Belge süresi dolana kadar bellekte tutulur. */
export function createTokenSource(credentials, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null;
  return async function accessToken() {
    if (cached && cached.exp - 60e3 > now()) return cached.token;
    const iat = Math.floor(now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: credentials.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${b64url(signer.sign(credentials.private_key))}`;
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw new AppError('unavailable', `Google oturumu alınamadı (${res.status}).`);
    const j = await res.json();
    cached = { token: j.access_token, exp: now() + (Number(j.expires_in) || 3600) * 1000 };
    return cached.token;
  };
}

/**
 * Play yanıtından abonelik kaydı (saf). Dönen: { plan, productId, until, state, active, autoRenew, accountId } ya da
 * bilinen ürün yoksa null.
 */
export function subscriptionFromPlay(res, now = Date.now()) {
  const items = Array.isArray(res?.lineItems) ? res.lineItems : [];
  // Birden çok satır varsa (plan değişikliği) bitişi en geç olan bilinen ürün
  let best = null;
  for (const li of items) {
    const plan = planOfProduct(li?.productId);
    const until = Date.parse(li?.expiryTime ?? '');
    if (!plan || !Number.isFinite(until)) continue;
    if (!best || until > best.until) best = { plan, productId: li.productId, until, autoRenew: li?.autoRenewingPlan?.autoRenewEnabled === true };
  }
  if (!best) return null;
  const state = String(res?.subscriptionState ?? '');
  const active = ACTIVE_STATES.includes(state) && best.until > now;
  return {
    ...best,
    state,
    active,
    accountId: res?.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    acknowledged: res?.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  };
}

export class PlayBilling {
  /**
   * store: linkPlayToken, getPlayToken, getBilling, setSubscription. credentials: servis hesabı JSON'u (yoksa kapalı).
   * api(token): isteğe bağlı sahte Play istemcisi (testler) → subscriptionsv2 yanıtı.
   */
  constructor({ store, packageName, credentials = null, rtdnSecret = null, fetchImpl = fetch, now = () => Date.now(), api = null, log = console }) {
    this.store = store;
    this.packageName = packageName;
    this.rtdnSecret = rtdnSecret;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this._api = api;
    this._accessToken = credentials ? createTokenSource(credentials, { fetchImpl, now }) : null;
  }

  get enabled() {
    return Boolean(this._api || (this._accessToken && this.packageName));
  }

  async _get(token) {
    if (this._api) return this._api.get(token);
    const at = await this._accessToken();
    const res = await this.fetchImpl(`${API}/${encodeURIComponent(this.packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`, {
      headers: { authorization: `Bearer ${at}` },
    });
    if (res.status === 404 || res.status === 410) throw new AppError('not-found', 'Satın alma bulunamadı.');
    if (!res.ok) throw new AppError('unavailable', `Google Play yanıt vermedi (${res.status}).`);
    return res.json();
  }

  async _acknowledge(productId, token) {
    if (this._api) return this._api.acknowledge?.(productId, token);
    const at = await this._accessToken();
    const url = `${API}/${encodeURIComponent(this.packageName)}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`;
    const res = await this.fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok && res.status !== 400 /* zaten onaylı */) throw new AppError('unavailable', `Satın alma onaylanamadı (${res.status}).`);
  }

  /** Mağazadan okunan durumu kullanıcı kaydına yazar. */
  async _apply(uid, sub, hash) {
    const record = {
      plan: sub.plan,
      // Etkin değilse (süresi doldu, askıda) bitiş geçmişte kalır → erişim kapanır
      until: sub.active ? sub.until : Math.min(sub.until, this.now()),
      source: 'play',
      productId: sub.productId,
      state: sub.state,
      autoRenew: sub.autoRenew,
      tokenHash: hash,
      updatedAt: this.now(),
    };
    await this.store.setSubscription(uid, record);
    return record;
  }

  /** Uygulamanın gönderdiği satın almayı doğrular ve aboneliği kaydeder. */
  async verify({ uid, productId, purchaseToken }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (!this.enabled) throw new AppError('unavailable', 'Ödeme doğrulaması henüz yapılandırılmadı.');
    if (typeof purchaseToken !== 'string' || purchaseToken.length < 10 || purchaseToken.length > 2000) {
      throw new AppError('invalid-argument', 'Geçersiz satın alma.');
    }
    if (productId !== undefined && !planOfProduct(productId)) throw new AppError('invalid-argument', 'Bilinmeyen abonelik ürünü.');
    const sub = subscriptionFromPlay(await this._get(purchaseToken), this.now());
    if (!sub) throw new AppError('invalid-argument', 'Bu satın alma bir vSport aboneliği değil.');
    // Satın alma başka hesapla yapıldıysa (uygulama hesap kimliği olarak uid gönderir) bu hesaba bağlanmaz
    if (sub.accountId && sub.accountId !== uid) throw new AppError('permission-denied', 'Bu abonelik başka bir hesaba ait.');
    const hash = tokenHash(purchaseToken);
    const link = await this.store.linkPlayToken({ hash, uid, token: purchaseToken, productId: sub.productId });
    if (!link.ok) throw new AppError('permission-denied', 'Bu abonelik başka bir hesaba bağlı.');
    if (!sub.acknowledged && sub.active) {
      try {
        await this._acknowledge(sub.productId, purchaseToken);
      } catch (e) {
        this.log.warn?.(`[billing] onaylanamadı: ${e?.message ?? e}`);
      }
    }
    const record = await this._apply(uid, sub, hash);
    return { plan: record.plan, until: record.until, active: sub.active, state: sub.state, autoRenew: sub.autoRenew };
  }

  /** Kullanıcının kayıtlı Play aboneliğini mağazadan yeniden okur (yenileme/iptal). Kayıt yoksa null. */
  async refresh(uid) {
    if (!this.enabled) return null;
    const b = await this.store.getBilling(uid);
    if (!b?.tokenHash) return null;
    const t = await this.store.getPlayToken(b.tokenHash);
    if (!t?.token || t.uid !== uid) return null;
    const sub = subscriptionFromPlay(await this._get(t.token), this.now());
    if (!sub) return null;
    return this._apply(uid, sub, b.tokenHash);
  }

  /**
   * Gerçek zamanlı geliştirici bildirimi (Pub/Sub push gövdesi). Gizli anahtar doğruysa ilgili aboneliği yeniden okur.
   * Dönen: { status } (204: işlendi ya da yok sayıldı; 403: anahtar yanlış).
   */
  async handleRtdn(body, secret) {
    if (!this.rtdnSecret || secret !== this.rtdnSecret) return { status: 403 };
    let note = null;
    try {
      note = JSON.parse(Buffer.from(String(body?.message?.data ?? ''), 'base64').toString('utf8'));
    } catch {
      return { status: 204 };
    }
    const token = note?.subscriptionNotification?.purchaseToken;
    if (!token || (note.packageName && note.packageName !== this.packageName)) return { status: 204 };
    const hash = tokenHash(token);
    const link = await this.store.getPlayToken(hash);
    // Uygulama satın almayı henüz göndermediyse hesap bilinmez; uygulama gönderince doğrulanır.
    if (!link?.uid) return { status: 204 };
    const sub = subscriptionFromPlay(await this._get(token), this.now());
    if (sub) await this._apply(link.uid, sub, hash);
    return { status: 204 };
  }
}

/** Ortam değişkenlerinden Play doğrulayıcısı (servis hesabı yoksa kapalı). */
export function billingFromEnv(store, env = process.env) {
  const raw = env.PLAY_SERVICE_ACCOUNT || env.FIREBASE_SERVICE_ACCOUNT || '';
  let credentials = null;
  if (raw) {
    try {
      credentials = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      credentials = null;
    }
  }
  return new PlayBilling({
    store,
    packageName: env.PLAY_PACKAGE_NAME || 'com.macsimulasyon.futbol_app',
    credentials: credentials?.client_email && credentials?.private_key ? credentials : null,
    rtdnSecret: env.PLAY_RTDN_SECRET || null,
  });
}
