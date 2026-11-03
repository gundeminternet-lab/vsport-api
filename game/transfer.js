// Transfer Pazarı (Benim 11'im): kullanıcılar kadroda olmayan kartlarını kredi karşılığı satışa koyar, başkaları satın
// alır. Kredi yalnızca oyunlarla kazanılır; burada el değiştirir (puan tablosuna "kazanılmış" olarak yazılmaz).
//
//   transfer_market/{id}   { seller, sellerName, cardId, card, tier, g, r, price, createdMs, expiresMs }
//
// Kart ilana konunca sahibinin kartlarından çıkar (emanette). İlan satılınca kart alıcıya geçer, kredi satıcıya;
// iptal edilince ya da süresi dolunca kart sahibine döner. İlanlar 3 gün açık kalır.

import { AppError } from '../errors.js';
import { SELL_PRICE } from './economy.js';
import { tierOf } from './pool.js';

export const TRANSFER = {
  maxListings: 5,
  ttlMs: 3 * 86400e3,
  // Fiyat aralığı: hızlı satış fiyatının 1 ile 8 katı arası
  minFactor: 1,
  maxFactor: 8,
};

export const priceRange = (tier) => {
  const base = SELL_PRICE[tier] ?? 100;
  return { min: base * TRANSFER.minFactor, max: base * TRANSFER.maxFactor, base };
};

const GROUPS = ['KL', 'DEF', 'OS', 'FV'];

export class TransferService {
  /** store: createTransferStore   game: GameService (profil ve kullanıcı adı için) */
  constructor({ store, game, now = () => Date.now() }) {
    this.store = store;
    this.game = game;
    this.now = now;
  }

  _member(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Transfer Pazarı için Google ile giriş yap.');
  }

  _view(x, uid) {
    const tier = x.tier ?? tierOf(x.card?.r ?? 50);
    return {
      id: x.id,
      price: x.price,
      tier,
      seller: x.sellerName ?? 'Oyuncu',
      mine: x.seller === uid,
      createdAt: new Date(x.createdMs).toISOString(),
      expiresAt: new Date(x.expiresMs).toISOString(),
      card: { ...x.card, id: x.cardId },
      // Hızlı satış fiyatına göre: 'ucuz' | 'normal' | 'pahalı'
      deal: x.price <= priceRange(tier).base * 2 ? 'cheap' : x.price >= priceRange(tier).base * 5 ? 'pricey' : 'fair',
    };
  }

  /** Süresi dolan ilanlarını sahibine iade eder. Döner: iade sayısı. */
  async _returnExpired(uid) {
    const mine = await this.store.listBySeller(uid);
    const now = this.now();
    let n = 0;
    for (const x of mine) {
      if (x.expiresMs > now) continue;
      if (await this.store.cancel(x.id, uid).catch(() => null)) n++;
    }
    return n;
  }

  /** Pazardaki ilanlar (başkalarının). group: KL | DEF | OS | FV; sort: new | cheap | rating. */
  async list({ uid, guest = false, group = null, sort = 'new' }) {
    this._member(uid, guest);
    const now = this.now();
    let items = (await this.store.listOpen(200)).filter((x) => x.expiresMs > now && x.seller !== uid);
    if (group && GROUPS.includes(group)) items = items.filter((x) => (x.g ?? x.card?.g) === group);
    if (sort === 'cheap') items.sort((a, b) => a.price - b.price);
    else if (sort === 'rating') items.sort((a, b) => (b.r ?? 0) - (a.r ?? 0) || a.price - b.price);
    else items.sort((a, b) => b.createdMs - a.createdMs);
    return { items: items.slice(0, 60).map((x) => this._view(x, uid)), rules: this.rules() };
  }

  rules() {
    return {
      maxListings: TRANSFER.maxListings,
      hours: TRANSFER.ttlMs / 3600e3,
      ranges: Object.fromEntries(Object.keys(SELL_PRICE).map((t) => [t, priceRange(t)])),
    };
  }

  /** Kendi ilanlarım (süresi dolanlar önce iade edilir) ve son satışlarım. */
  async mine({ uid, guest = false }) {
    this._member(uid, guest);
    const returned = await this._returnExpired(uid);
    const [items, p] = await Promise.all([this.store.listBySeller(uid), this.store.getProfile(uid)]);
    return {
      items: items.sort((a, b) => b.createdMs - a.createdMs).map((x) => this._view(x, uid)),
      sales: Array.isArray(p?.transferSales) ? p.transferSales.slice(0, 10) : [],
      returned,
      rules: this.rules(),
    };
  }

  /** Kartı satışa koyar. */
  async sell({ uid, guest = false, cardId, price }) {
    this._member(uid, guest);
    if (typeof cardId !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(cardId)) throw new AppError('invalid-argument', 'Geçersiz kart.');
    const p = Math.round(Number(price));
    if (!Number.isFinite(p)) throw new AppError('invalid-argument', 'Geçersiz fiyat.');
    await this._returnExpired(uid);
    const [profile, squads, open] = await Promise.all([this.game._profile(uid), this.store.listSquads(uid), this.store.listBySeller(uid)]);
    if (open.length >= TRANSFER.maxListings) throw new AppError('resource-exhausted', `Aynı anda en çok ${TRANSFER.maxListings} ilanın olabilir.`);
    if (squads.some((s) => Object.values(s.slots ?? {}).includes(cardId))) {
      throw new AppError('failed-precondition', 'Bu oyuncu bir kadroda; satışa koymak için önce kadrodan çıkar.');
    }
    const card = await this.store.getCard(uid, cardId);
    if (!card) throw new AppError('not-found', 'Kart bulunamadı.');
    const tier = card.tier ?? tierOf(card.r ?? 50);
    const range = priceRange(tier);
    if (p < range.min || p > range.max) throw new AppError('invalid-argument', `Fiyat ${range.min} ile ${range.max} kredi arasında olmalı.`);
    const now = this.now();
    const { at, ...data } = card;
    const listing = {
      seller: uid,
      sellerName: profile?.username ?? null,
      cardId,
      card: data,
      tier,
      g: data.g ?? null,
      r: data.r ?? null,
      price: p,
      createdMs: now,
      expiresMs: now + TRANSFER.ttlMs,
    };
    const id = await this.store.create(uid, cardId, listing);
    return { id, listing: this._view({ ...listing, id }, uid) };
  }

  /** İlanı geri çeker; kart sahibine döner. */
  async cancel({ uid, guest = false, id }) {
    this._member(uid, guest);
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(id)) throw new AppError('invalid-argument', 'Geçersiz ilan.');
    const r = await this.store.cancel(id, uid);
    if (r === null) throw new AppError('not-found', 'İlan bulunamadı; satılmış olabilir.');
    if (r === false) throw new AppError('permission-denied', 'Bu ilan senin değil.');
    return { ok: true };
  }

  /** İlanı satın alır: kredi satıcıya, kart alıcıya geçer. */
  async buy({ uid, guest = false, id }) {
    this._member(uid, guest);
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,40}$/.test(id)) throw new AppError('invalid-argument', 'Geçersiz ilan.');
    const profile = await this.game._profile(uid);
    if (profile?.welcomeDone !== true) throw new AppError('failed-precondition', 'Önce Benim 11\'im başlangıç paketini aç.');
    const r = await this.store.buy(id, uid, this.now());
    return { ok: true, balance: r.balance, cardId: r.cardId, card: r.card, price: r.price };
  }
}

export function createTransferStore(db, FieldValue) {
  const prof = (uid) => db.doc(`game_profiles/${uid}`);
  const col = () => db.collection('transfer_market');
  return {
    async getProfile(uid) {
      const s = await prof(uid).get();
      return s.exists ? s.data() : null;
    },
    async listSquads(uid) {
      const q = await prof(uid).collection('squads').limit(10).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async getCard(uid, cardId) {
      const s = await prof(uid).collection('cards').doc(cardId).get();
      return s.exists ? s.data() : null;
    },
    async listOpen(limit) {
      const q = await col().orderBy('createdMs', 'desc').limit(limit).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async listBySeller(uid) {
      const q = await col().where('seller', '==', uid).limit(20).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    /** Kart kullanıcının kartlarından çıkar, ilan açılır (tek işlem). */
    async create(uid, cardId, listing) {
      const ref = col().doc();
      const cref = prof(uid).collection('cards').doc(cardId);
      await db.runTransaction(async (tx) => {
        const c = await tx.get(cref);
        if (!c.exists) throw new AppError('not-found', 'Kart bulunamadı.');
        tx.delete(cref);
        tx.set(ref, listing);
      });
      return ref.id;
    },
    /** null: ilan yok, false: sahibi değil, true: kart iade edildi. */
    async cancel(id, uid) {
      const ref = col().doc(id);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return null;
        const x = s.data();
        if (x.seller !== uid) return false;
        tx.set(prof(uid).collection('cards').doc(x.cardId), { ...x.card, at: FieldValue.serverTimestamp() });
        tx.delete(ref);
        return true;
      });
    },
    async buy(id, buyer, now) {
      const ref = col().doc(id);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) throw new AppError('not-found', 'Bu oyuncu az önce satıldı.');
        const x = s.data();
        if (x.seller === buyer) throw new AppError('failed-precondition', 'Kendi ilanını satın alamazsın.');
        if (x.expiresMs <= now) throw new AppError('failed-precondition', 'İlanın süresi doldu.');
        const [bs, ss] = await Promise.all([tx.get(prof(buyer)), tx.get(prof(x.seller))]);
        const cur = Number(bs.get('credits') ?? 0);
        if (cur < x.price) throw new AppError('failed-precondition', 'Yetersiz kredi.');
        const sales = Array.isArray(ss.get('transferSales')) ? ss.get('transferSales') : [];
        const newCard = prof(buyer).collection('cards').doc();
        tx.set(prof(buyer), { credits: cur - x.price }, { merge: true });
        tx.set(
          prof(x.seller),
          {
            credits: Number(ss.get('credits') ?? 0) + x.price,
            transferSales: [{ name: x.card?.s ?? x.card?.n ?? 'Oyuncu', price: x.price, at: new Date(now).toISOString() }, ...sales].slice(0, 10),
          },
          { merge: true },
        );
        tx.set(newCard, { ...x.card, at: FieldValue.serverTimestamp() });
        tx.delete(ref);
        return { balance: cur - x.price, cardId: newCard.id, card: x.card, price: x.price };
      });
    },
  };
}
