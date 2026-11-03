// Ekran görüntüsü kilidi: AI ekranlarında (tahmin, AI analizi, AI yorumcu, simülasyon, özel yorum) ekran görüntüsü
// alınmaya çalışıldığında uygulama ekrandaki maç(lar)ı bildirir; o maçların AI tahmini o kullanıcıya bir daha
// gösterilmez. Kilit kalıcıdır (aboneliği olsa da açılmaz).
//
//   capture_locks/{uid}   { keys: { [maçAnahtarı]: { at, area } }, count, updatedAt }
//
// Uygulama ekran görüntüsünü sistem üzerinden yakalar (Android 14+ ekran görüntüsü bildirimi); AI ekranları ayrıca
// FLAG_SECURE ile korunur, yani görüntü zaten boş çıkar. Bu kayıt, girişimi yapan kullanıcıyı içerikten men eder.

import { AppError } from './errors.js';

export const CAPTURE_MAX_KEYS = 12;
const KEY_RE = /^[A-Za-z0-9_]{3,120}$/;
const AREAS = new Set(['predictions', 'prediction', 'analysis', 'commentary', 'simulation', 'special', 'ask', 'ai', 'radar', 'coupons', 'other']);

export const CAPTURE_MESSAGE = 'Bu maçın AI tahmini, ekran görüntüsü alınmaya çalışıldığı için hesabına kapatıldı.';
export const captureLocked = () => new AppError('capture-locked', CAPTURE_MESSAGE);

export function createCaptureStore(db, FieldValue) {
  return {
    async get(uid) {
      const s = await db.doc(`capture_locks/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async clear(uid) {
      await db.doc(`capture_locks/${uid}`).delete();
    },
    async add(uid, keys, area, now) {
      await db.doc(`capture_locks/${uid}`).set(
        { keys: Object.fromEntries(keys.map((k) => [k, { at: now, area }])), count: FieldValue.increment(1), updatedAt: now },
        { merge: true },
      );
    },
  };
}

export class CaptureLocks {
  /** isExempt: async (uid) → true ise (yönetici, test hesabı) kilit uygulanmaz. */
  constructor({ store, now = () => Date.now(), cacheMs = 60e3, log = console, isExempt = null }) {
    this.store = store;
    this.isExempt = isExempt;
    this._exempt = new Map(); // uid → { at, value }
    this.now = now;
    this.cacheMs = cacheMs;
    this.log = log;
    this._cache = new Map(); // uid → { at, keys: Set }
  }

  async _isExempt(uid) {
    if (!this.isExempt || !uid) return false;
    const hit = this._exempt.get(uid);
    if (hit && this.now() - hit.at < 5 * 60e3) return hit.value;
    let value = false;
    try {
      value = (await this.isExempt(uid)) === true;
    } catch {
      value = hit?.value ?? false;
    }
    if (this._exempt.size > 5000) this._exempt.clear();
    this._exempt.set(uid, { at: this.now(), value });
    return value;
  }

  async keysOf(uid) {
    if (!uid) return new Set();
    if (await this._isExempt(uid)) return new Set();
    const hit = this._cache.get(uid);
    if (hit && this.now() - hit.at < this.cacheMs) return hit.keys;
    let keys = new Set();
    try {
      const doc = await this.store.get(uid);
      keys = new Set(Object.keys(doc?.keys ?? {}));
    } catch (e) {
      // Okunamazsa kilit yok sayılır (içerik gösterilir) ama son bilinen liste korunur
      if (hit) keys = hit.keys;
      this.log.warn?.('[capture] okunamadı', e?.message ?? e);
    }
    if (this._cache.size > 5000) this._cache.clear();
    this._cache.set(uid, { at: this.now(), keys });
    return keys;
  }

  async isLocked(uid, key) {
    return (await this.keysOf(uid)).has(key);
  }

  /** Kilitliyse hata fırlatır (içerik uçları çağırır). */
  async check(uid, key) {
    if (await this.isLocked(uid, key)) throw captureLocked();
  }

  /** Uygulamadan gelen bildirim: ekrandaki maçlar kilitlenir. Dönen: kullanıcının bütün kilitli maçları. */
  async report({ uid, guest = false, keys, area = 'other' }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const list = [...new Set(Array.isArray(keys) ? keys : [])].filter((k) => typeof k === 'string' && KEY_RE.test(k)).slice(0, CAPTURE_MAX_KEYS);
    if (!list.length) throw new AppError('invalid-argument', 'Geçersiz maç.');
    const a = AREAS.has(area) ? area : 'other';
    // Yönetici/test hesabı: kilit yazılmaz (uygulamayı denerken ekran görüntüsü alınabilir)
    if (await this._isExempt(uid)) return { locked: [], exempt: true, message: CAPTURE_MESSAGE };
    await this.store.add(uid, list, a, this.now());
    const cur = new Set(await this.keysOf(uid));
    for (const k of list) cur.add(k);
    this._cache.set(uid, { at: this.now(), keys: cur });
    this.log.info?.(`[capture] ${guest ? 'misafir ' : ''}${uid}: ${list.length} maç kilitlendi (${a})`);
    return { locked: [...cur], message: CAPTURE_MESSAGE };
  }

  async list({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    return { keys: [...(await this.keysOf(uid))] };
  }

  /** Yönetici: bir kullanıcının bütün ekran görüntüsü kilitlerini kaldırır (target boşsa kendi hesabı). */
  async clear({ uid, target = null }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (!this.isExempt || !(await this.isExempt(uid))) throw new AppError('permission-denied', 'Bu işlem yöneticilere özel.');
    const who = typeof target === 'string' && /^[A-Za-z0-9]{6,128}$/.test(target) ? target : uid;
    await this.store.clear(who);
    this._cache.delete(who);
    this.log.info?.(`[capture] ${who} kilitleri kaldırıldı (${uid})`);
    return { cleared: true, uid: who };
  }
}
