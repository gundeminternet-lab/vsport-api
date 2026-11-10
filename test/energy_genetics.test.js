// Enerji (günlük maç sınırının yerine), mağazada enerji, yeni paketler ve elit şans sayacı, oyuncu genetiği.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameService } from '../game/service.js';
import { slotsOf } from '../game/squad.js';
import { createRng } from '../engine/rng.js';
import { memoryGameStore, syntheticPool } from './game_fakes.js';
import { ENERGY, addEnergy, energyNow, energyPrice, energyTimes, energyView, matchesLeft, spendEnergy } from '../game/energy.js';
import { BODY, GROWTH, TRAITS, ageFactor, geneticsOf, geneticsView, trainFactor, traitStats } from '../game/genetics.js';
import { PACKS, PITY } from '../game/economy.js';
import { matchEvents } from '../game/office.js';
import { potentialOf } from '../game/staff.js';

const NOW = Date.UTC(2026, 10, 10, 9, 0);
const MIN = 60e3;

function svc(clock = { t: NOW }) {
  const store = memoryGameStore({ users: { u1: { username: 'tostcu23' } } });
  const pool = syntheticPool();
  // Sahte havuzda herkes 25 yaşında; bir kısmını genç yap (Genç Yetenek Paketi için)
  pool.all().forEach((p, i) => { if (i % 3 === 0) p.a = 17 + (i % 5); });
  let seed = 7;
  const s = new GameService({ store, pool, access: { entitlement: async () => ({ subscribed: false }) }, now: () => clock.t, random: () => createRng(seed++), log: { warn() {} } });
  return { s, store, clock };
}

async function ready(s, uid = 'u1') {
  await s.club.create({ uid, name: 'Kuzey Yıldızı', fans: 'Kuzeyliler', crest: { shape: 2, primary: 7, secondary: 4, symbol: 7, pattern: 1 } });
  const w = await s.welcomePack({ uid, region: 'tur' });
  const byG = (g) => w.cards.filter((c) => c.g === g).map((c) => c.id);
  const ids = [byG('KL')[0], ...byG('DEF').slice(0, 4), ...byG('OS').slice(0, 3), ...byG('FV').slice(0, 3)];
  const sq = await s.saveSquad({ uid, name: 'A Takımı', formation: '4-3-3', slots: Object.fromEntries(slotsOf('4-3-3').map((x, i) => [x.key, ids[i]])) });
  return { w, sq, ids };
}

test('enerji: başlangıçta dolu, her 6 dakikada +1, depo doluyken dolum durur, harcama ve bekleme süresi', () => {
  const e0 = energyNow(null, NOW);
  assert.deepEqual(e0, { v: ENERGY.max, at: NOW });
  const a = spendEnergy(null, 20, NOW);
  assert.deepEqual(a, { v: 80, at: NOW }, 'dolu depodan harcayınca sayaç şimdi başlar');
  assert.equal(energyNow(a, NOW + 5 * MIN).v, 80);
  assert.equal(energyNow(a, NOW + 6 * MIN).v, 81);
  assert.equal(energyNow(a, NOW + 61 * MIN).v, 90);
  const t = energyTimes(energyNow(a, NOW + 61 * MIN), NOW + 61 * MIN);
  assert.equal(t.nextInMs, 5 * MIN);
  assert.equal(t.fullInMs, 5 * MIN + 9 * 6 * MIN);
  assert.equal(energyNow(a, NOW + 500 * MIN).v, ENERGY.max, 'en çok depo kadar dolar');
  // Kısmi dolum ilerlemesi harcamada korunur
  const b = spendEnergy(a, 20, NOW + 9 * MIN);
  assert.equal(b.v, 61);
  assert.equal(energyNow(b, NOW + 12 * MIN).v, 62);
  assert.throws(() => spendEnergy({ v: 10, at: NOW }, 20, NOW), /Enerjin yetmiyor \(10\/20\)\. Mağazadan enerji al ya da 60 dakika bekle/);
  // Mağazadan alınan enerji depoyu aşabilir (cap'e kadar), o sırada dolum durur
  const c = addEnergy({ v: 90, at: NOW }, 60, NOW);
  assert.equal(c.v, 150);
  assert.equal(energyNow(c, NOW + 600 * MIN).v, 150);
  assert.equal(addEnergy({ v: 180, at: NOW }, 60, NOW).v, ENERGY.cap);
  // Fiyat o gün her alımda %50 artar
  assert.deepEqual([0, 1, 2].map((n) => energyPrice(ENERGY.shop[0], n)), [400, 600, 800]);
  assert.equal(matchesLeft({ v: 59, at: NOW }, NOW, 'normal'), 2);
  assert.equal(matchesLeft({ v: 59, at: NOW }, NOW, 'season'), 2);
  const v = energyView({ v: 30, at: NOW }, NOW + 3 * MIN, 1);
  assert.equal(v.value, 30);
  assert.equal(v.nextInMs, 3 * MIN);
  assert.equal(v.shop[0].cost, 600);
  assert.equal(v.cost.season, ENERGY.cost.season);
});

test('mağaza: kredi ile enerji; fiyat artar; depo doluysa alınmaz; geçersiz ürün', async () => {
  const { s, store, clock } = svc();
  await ready(s);
  await store.updateProfile('u1', { credits: 5000, energy: { v: 10, at: NOW } });
  const r = await s.energyBuy({ uid: 'u1', item: 'icecek' });
  assert.equal(r.price, 400);
  assert.equal(r.added, 25);
  assert.equal(r.energy.value, 35);
  assert.equal(r.balance, 4600);
  assert.equal(r.energy.shop[0].cost, 600, 'ikinci alım daha pahalı');
  const r2 = await s.energyBuy({ uid: 'u1', item: 'dolum' });
  assert.equal(r2.price, 2100);
  assert.equal(r2.energy.value, 135);
  await assert.rejects(s.energyBuy({ uid: 'u1', item: 'yok' }), /Geçersiz ürün/);
  await store.updateProfile('u1', { energy: { v: ENERGY.cap, at: NOW } });
  await assert.rejects(s.energyBuy({ uid: 'u1', item: 'icecek' }), /deposu dolu/);
  await store.updateProfile('u1', { credits: 100, energy: { v: 0, at: NOW } });
  await assert.rejects(s.energyBuy({ uid: 'u1', item: 'icecek' }), /Yetersiz kredi/);
  // Ertesi gün fiyat sıfırlanır
  clock.t += 86400e3;
  assert.equal((await s.state({ uid: 'u1' })).energy.shop[0].cost, 400);
  // Alınan enerjiyle maç oynanır
  await store.updateProfile('u1', { credits: 5000 });
  const { sq } = { sq: (await store.listSquads('u1'))[0] };
  await s.energyBuy({ uid: 'u1', item: 'icecek' });
  const st = await s.state({ uid: 'u1' });
  assert.ok(st.energy.value >= 20);
  const k = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli' });
  assert.equal(k.energy.value, st.energy.value - 20);
});

test('paketler: Genç Yetenek (21 yaş altı, 1 yıldız aday), Mevki Paketi (seçilen mevki), olasılıklar ve elit şans sayacı', async () => {
  const { s, store } = svc();
  await ready(s);
  await store.updateProfile('u1', { credits: 200000 });
  const st = await s.state({ uid: 'u1' });
  assert.deepEqual(st.packs.map((p) => p.id), ['gunluk', 'bronz', 'mevki', 'gumus', 'genc', 'altin', 'vsport']);
  assert.ok(st.packs.every((p) => p.odds && Object.values(p.odds).reduce((a, b) => a + b, 0) > 0.99));
  assert.deepEqual(st.pity, { value: 0, every: PITY.every });
  const g = await s.openPack({ uid: 'u1', pack: 'genc' });
  assert.equal(g.cards.length, PACKS.genc.count);
  assert.ok(g.cards.every((c) => c.a != null && c.a <= 21), 'hepsi 21 yaş ve altı');
  assert.ok(g.cards.some((c) => potentialOf(c) >= 85), 'yıldız aday garantili');
  await assert.rejects(s.openPack({ uid: 'u1', pack: 'mevki' }), /mevki seç/);
  const m = await s.openPack({ uid: 'u1', pack: 'mevki', group: 'FV' });
  assert.equal(m.cards.length, 6);
  assert.ok(m.cards.every((c) => c.g === 'FV'));
  // Şans sayacı: dolunca elit garantili, sonra sıfırlanır
  await store.updateProfile('u1', { packPity: PITY.every });
  const b = await s.openPack({ uid: 'u1', pack: 'bronz' });
  assert.equal(b.pity.used, true);
  assert.ok(b.cards.some((c) => c.r >= 85), 'elit kart geldi');
  assert.equal(b.pity.value, 0);
  const b2 = await s.openPack({ uid: 'u1', pack: 'bronz' });
  assert.equal(b2.pity.value, b2.cards.some((c) => c.r >= 85) ? 0 : 1);
  // Günlük ücretsiz paket sayacı değiştirmez
  const before = (await store.getProfile('u1')).packPity ?? 0;
  await s.openPack({ uid: 'u1', pack: 'gunluk' });
  assert.equal((await store.getProfile('u1')).packPity ?? 0, before);
});

test('genetik: sabit, dağılım makul; gençler şanslı; gelişim katsayısı ve yaş; yetenek özellikleri', () => {
  const a = geneticsOf({ pid: 'p-123' });
  assert.deepEqual(geneticsOf({ pid: 'p-123', id: 'farklı-kart' }), a, 'aynı oyuncu her kartta aynı');
  assert.ok(a.peak >= 26 && a.peak <= 31);
  const N = 4000;
  const list = Array.from({ length: N }, (_, i) => geneticsOf({ pid: `x${i}` }));
  const share = (f) => list.filter(f).length / N;
  assert.ok(Math.abs(share((g) => g.growth.id === 'hizli') - 0.22) < 0.04);
  assert.ok(Math.abs(share((g) => g.body.id === 'demir') - 0.2) < 0.04);
  assert.ok(Math.abs(share((g) => g.body.id === 'kirilgan') - 0.15) < 0.04);
  assert.ok(share((g) => g.traits.length > 0) > 0.35 && share((g) => g.traits.length > 0) < 0.6);
  const youth = Array.from({ length: N }, (_, i) => geneticsOf({ pid: `x${i}`, youth: true }));
  assert.ok(youth.filter((g) => g.growth.id === 'hizli').length > list.filter((g) => g.growth.id === 'hizli').length, 'altyapı gençleri daha hızlı gelişir');
  assert.ok(['A+', 'A', 'B+', 'B', 'C', 'D'].includes(a.grade));
  // Yaş
  const g0 = geneticsOf({ pid: 'yas' });
  assert.equal(ageFactor({ pid: 'yas', a: 19 }).k, 1.15);
  assert.equal(ageFactor({ pid: 'yas', a: g0.peak + 1 }).k, 0.7);
  assert.equal(ageFactor({ pid: 'yas', a: g0.peak }).k, 1);
  assert.equal(ageFactor({ pid: 'yas' }).k, 1);
  // Katsayı: gelişim × yaş × yetenek uyumu
  const withTrait = list.findIndex((g) => g.traits.some((t) => t.stat === 0) && g.growth.id === 'hizli');
  const card = { pid: `x${withTrait}`, g: 'FV', a: 24 };
  const f = trainFactor(card, [0, 5]);
  assert.equal(f.fits, true);
  assert.equal(f.k, Math.round(1.25 * 1.1 * 1000) / 1000);
  assert.equal(trainFactor(card, [1, 2, 3]).k, 1.25);
  assert.ok(traitStats(card).includes(0));
  assert.deepEqual(Object.keys(geneticsView(card)), ['growth', 'body', 'peak', 'traits', 'grade']);
  assert.ok(GROWTH.hizli.k > GROWTH.normal.k && GROWTH.gec.k < 1);
  assert.ok(BODY.kirilgan.injury > 1 && BODY.demir.injury < 1);
  assert.ok(Object.keys(TRAITS).length >= 7);
});

test('genetik oyunda: hızlı gelişen daha çok gelişim puanı alır; kırılgan daha sık sakatlanır; lider disiplin sorunu çıkarmaz', async () => {
  const { s, store } = svc();
  const { w } = await ready(s);
  await store.updateProfile('u1', { credits: 50000 });
  // İki kart: biri hızlı gelişen, biri geç açılan (pid değiştirerek)
  const list = Array.from({ length: 400 }, (_, i) => ({ pid: `t${i}`, g: geneticsOf({ pid: `t${i}` }) }));
  const fast = list.find((x) => x.g.growth.id === 'hizli' && !x.g.traits.length).pid;
  const slow = list.find((x) => x.g.growth.id === 'gec' && !x.g.traits.length).pid;
  const [c1, c2] = w.cards.filter((c) => c.g === 'OS' && c.r < 75).slice(0, 2);
  await store.updateCard('u1', c1.id, { pid: fast, a: 25, r: 60, pot: 80 });
  await store.updateCard('u1', c2.id, { pid: slow, a: 25, r: 60, pot: 80 });
  const t1 = await s.club.train({ uid: 'u1', cardId: c1.id, drill: 'teknik' });
  const t2 = await s.club.train({ uid: 'u1', cardId: c2.id, drill: 'teknik' });
  assert.ok(t1.gain > t2.gain, `hızlı ${t1.gain} > geç ${t2.gain}`);
  assert.equal(t1.genetics.growth, 'hizli');
  assert.equal(t1.genetics.factor, 1.25);
  // Sakatlık: aynı kadroda kırılgan oyuncular daha sık
  const mk = (body) => {
    const pids = list.filter((x) => x.g.body.id === body).slice(0, 10).map((x) => x.pid);
    return Object.fromEntries(pids.map((pid, i) => [`s${i}`, { id: `c${i}`, pid, s: `O${i}`, g: 'OS', r: 70 }]));
  };
  const count = (lineup) => Array.from({ length: 600 }, (_, i) => matchEvents({ seed: `g${i}`, lineup }).injuries.length).reduce((a, b) => a + b, 0);
  const frail = count(mk('kirilgan')), iron = count(mk('demir'));
  assert.ok(frail > iron * 2, `kırılgan ${frail} > demir ${iron}`);
  // Lider: disiplin olayı yok
  const leaders = list.filter((x) => x.g.traits.some((t) => t.id === 'lider')).slice(0, 10);
  const lineupL = Object.fromEntries(leaders.map((x, i) => [`s${i}`, { id: `l${i}`, pid: x.pid, s: `L${i}`, g: 'OS', r: 70 }]));
  assert.equal(Array.from({ length: 400 }, (_, i) => matchEvents({ seed: `d${i}`, lineup: lineupL }).discipline).filter(Boolean).length, 0);
});

test('altyapı: gencin genetiği görünür ve A takıma alınınca kartta aynı kalır', async () => {
  const { s } = svc();
  await ready(s);
  const sc = await s.manager.youthScout({ uid: 'u1' });
  const y = sc.found[0];
  assert.ok(y.gen && y.gen.grade);
  assert.ok(y.gk.startsWith('youth-'));
  const pr = await s.manager.youthPromote({ uid: 'u1', id: y.id });
  assert.equal(pr.card.pid, y.gk);
  assert.deepEqual(geneticsView({ ...pr.card }), y.gen);
});
