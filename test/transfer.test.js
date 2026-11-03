// Transfer Pazarı (game/transfer.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { TransferService, priceRange, TRANSFER } from '../game/transfer.js';
import { AppError } from '../errors.js';

function fakeStore() {
  const profiles = new Map();
  const cards = new Map(); // uid → Map(id → card)
  const squads = new Map();
  const listings = new Map();
  let seq = 0;
  const cardsOf = (uid) => cards.get(uid) ?? cards.set(uid, new Map()).get(uid);
  return {
    profiles,
    cards,
    squads,
    listings,
    cardsOf,
    async getProfile(uid) {
      return profiles.get(uid) ?? null;
    },
    async listSquads(uid) {
      return squads.get(uid) ?? [];
    },
    async getCard(uid, id) {
      return cardsOf(uid).get(id) ?? null;
    },
    async listOpen() {
      return [...listings.entries()].map(([id, x]) => ({ id, ...x }));
    },
    async listBySeller(uid) {
      return [...listings.entries()].filter(([, x]) => x.seller === uid).map(([id, x]) => ({ id, ...x }));
    },
    async create(uid, cardId, listing) {
      if (!cardsOf(uid).has(cardId)) throw new AppError('not-found', 'Kart bulunamadı.');
      cardsOf(uid).delete(cardId);
      const id = `L${++seq}`;
      listings.set(id, listing);
      return id;
    },
    async cancel(id, uid) {
      const x = listings.get(id);
      if (!x) return null;
      if (x.seller !== uid) return false;
      cardsOf(uid).set(x.cardId, { ...x.card });
      listings.delete(id);
      return true;
    },
    async buy(id, buyer, now) {
      const x = listings.get(id);
      if (!x) throw new AppError('not-found', 'Bu oyuncu az önce satıldı.');
      if (x.seller === buyer) throw new AppError('failed-precondition', 'Kendi ilanını satın alamazsın.');
      if (x.expiresMs <= now) throw new AppError('failed-precondition', 'İlanın süresi doldu.');
      const b = profiles.get(buyer);
      if ((b?.credits ?? 0) < x.price) throw new AppError('failed-precondition', 'Yetersiz kredi.');
      b.credits -= x.price;
      const s = profiles.get(x.seller);
      s.credits += x.price;
      s.transferSales = [{ name: x.card.s, price: x.price }, ...(s.transferSales ?? [])];
      const cid = `C${++seq}`;
      cardsOf(buyer).set(cid, { ...x.card });
      listings.delete(id);
      return { balance: b.credits, cardId: cid, card: x.card, price: x.price };
    },
  };
}

function setup() {
  const store = fakeStore();
  const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
  store.profiles.set('a', { username: 'ali', credits: 500, welcomeDone: true });
  store.profiles.set('b', { username: 'veli', credits: 5000, welcomeDone: true });
  store.cardsOf('a').set('c1', { pid: 'p1', n: 'Ayşe Kaleci', s: 'Kaleci', g: 'KL', r: 78, tier: 'gold' });
  store.cardsOf('a').set('c2', { pid: 'p2', n: 'Forvet Ali', s: 'Ali', g: 'FV', r: 64, tier: 'silver' });
  store.cardsOf('a').set('c3', { pid: 'p3', n: 'Bronz', s: 'Bronz', g: 'DEF', r: 55, tier: 'bronze' });
  store.squads.set('a', [{ id: 's1', slots: { 0: 'c3' } }]);
  const game = { _profile: async (uid) => store.profiles.get(uid) };
  const svc = new TransferService({ store, game, now: () => clock.t });
  return { store, svc, clock };
}

test('fiyat aralığı hızlı satış fiyatına göre', () => {
  assert.deepEqual(priceRange('gold'), { min: 600, max: 4800, base: 600 });
});

test('satışa koyma: kadrodaki kart, aralık dışı fiyat ve ilan sınırı', async () => {
  const { svc, store } = setup();
  await assert.rejects(svc.sell({ uid: 'a', cardId: 'c3', price: 200 }), /kadroda/);
  await assert.rejects(svc.sell({ uid: 'a', cardId: 'c1', price: 100 }), /arasında/);
  await assert.rejects(svc.sell({ uid: 'a', cardId: 'yok', price: 600 }), (e) => e.code === 'not-found');
  await assert.rejects(svc.sell({ uid: 'g', guest: true, cardId: 'c1', price: 600 }), (e) => e.code === 'unauthenticated');
  const r = await svc.sell({ uid: 'a', cardId: 'c1', price: 900 });
  assert.equal(r.listing.price, 900);
  assert.equal(store.cardsOf('a').has('c1'), false, 'kart emanete geçer');
  for (let i = 0; i < TRANSFER.maxListings - 1; i++) {
    store.cardsOf('a').set(`x${i}`, { s: 'X', g: 'OS', r: 60, tier: 'bronze' });
    await svc.sell({ uid: 'a', cardId: `x${i}`, price: 100 });
  }
  store.cardsOf('a').set('fazla', { s: 'X', g: 'OS', r: 60, tier: 'bronze' });
  await assert.rejects(svc.sell({ uid: 'a', cardId: 'fazla', price: 100 }), (e) => e.code === 'resource-exhausted');
});

test('pazar listesi: kendi ilanı görünmez, mevki ve sıralama süzgeci', async () => {
  const { svc } = setup();
  await svc.sell({ uid: 'a', cardId: 'c1', price: 1200 });
  await svc.sell({ uid: 'a', cardId: 'c2', price: 300 });
  assert.equal((await svc.list({ uid: 'a' })).items.length, 0);
  const all = await svc.list({ uid: 'b', sort: 'cheap' });
  assert.deepEqual(all.items.map((x) => x.price), [300, 1200]);
  assert.equal((await svc.list({ uid: 'b', group: 'KL' })).items.length, 1);
  assert.equal(all.items[0].seller, 'ali');
});

test('satın alma: kredi satıcıya, kart alıcıya; kendi ilanı ve yetersiz kredi', async () => {
  const { svc, store } = setup();
  const { id } = await svc.sell({ uid: 'a', cardId: 'c1', price: 1200 });
  await assert.rejects(svc.buy({ uid: 'a', id }), /Kendi/);
  store.profiles.get('b').credits = 100;
  await assert.rejects(svc.buy({ uid: 'b', id }), /Yetersiz/);
  store.profiles.get('b').credits = 5000;
  const r = await svc.buy({ uid: 'b', id });
  assert.equal(r.balance, 3800);
  assert.equal(store.profiles.get('a').credits, 1700);
  assert.equal(store.cardsOf('b').size, 1);
  await assert.rejects(svc.buy({ uid: 'b', id }), /satıldı/);
  const mine = await svc.mine({ uid: 'a' });
  assert.equal(mine.items.length, 0);
  assert.equal(mine.sales[0].price, 1200);
});

test('iptal ve süre dolumu: kart sahibine döner', async () => {
  const { svc, store, clock } = setup();
  const { id } = await svc.sell({ uid: 'a', cardId: 'c1', price: 700 });
  await assert.rejects(svc.cancel({ uid: 'b', id }), (e) => e.code === 'permission-denied');
  await svc.cancel({ uid: 'a', id });
  assert.equal(store.cardsOf('a').has('c1'), true);
  await svc.sell({ uid: 'a', cardId: 'c2', price: 300 });
  clock.t += TRANSFER.ttlMs + 1;
  assert.equal((await svc.list({ uid: 'b' })).items.length, 0, 'süresi dolan ilan pazarda görünmez');
  const mine = await svc.mine({ uid: 'a' });
  assert.equal(mine.returned, 1);
  assert.equal(store.cardsOf('a').has('c2'), true);
});
