// Benim 11'im kulübü (game/club.js): kuruluş, kilit, tesis yükseltme, taraftar geliri, antrenman.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameService } from '../game/service.js';
import { slotsOf } from '../game/squad.js';
import { CLUB, FACILITIES, upgradeCost, buildMs, effectsOf, xpNeed, trainCost, shortOf, nameKey, clubLevel } from '../game/club.js';
import { START_CREDITS, DUEL } from '../game/economy.js';
import { createRng } from '../engine/rng.js';
import { memoryGameStore, syntheticPool } from './game_fakes.js';

const NOW = Date.UTC(2026, 9, 28, 9, 0);
const crest = { shape: 2, primary: 3, secondary: 5, symbol: 7, pattern: 1 };
const kits = {
  home: { pattern: 1, shirt: 3, second: 4, shorts: 4, socks: 3 },
  away: { pattern: 0, shirt: 4, second: 3, shorts: 3, socks: 4 },
  gk: { pattern: 0, shirt: 9, second: 5, shorts: 9, socks: 9 },
};

function svc(clock = { t: NOW }) {
  const store = memoryGameStore({ users: { u1: { username: 'tostcu23' }, u2: { username: 'rakip' } } });
  let seed = 3;
  const s = new GameService({ store, pool: syntheticPool(), access: { entitlement: async () => ({ subscribed: false }) }, now: () => clock.t, random: () => createRng(seed++), log: { warn() {} } });
  return { s, store, clock };
}

async function squad(s, uid) {
  const w = await s.welcomePack({ uid, region: 'tur' });
  const byG = (g) => w.cards.filter((c) => c.g === g).map((c) => c.id);
  const kl = byG('KL'), def = byG('DEF'), os = byG('OS'), fv = byG('FV');
  const ids = [kl[0], def[0], def[1], def[2], def[3], os[0], os[1], os[2], fv[0], fv[1], fv[2]];
  const slots = Object.fromEntries(slotsOf('4-3-3').map((x, i) => [x.key, ids[i]]));
  return { w, sq: await s.saveSquad({ uid, name: 'A Takımı', formation: '4-3-3', slots }) };
}

test('saf yardımcılar: kısaltma, ad anahtarı, fiyat, süre, etkiler', () => {
  assert.equal(shortOf('Kuzey Yıldızı Spor'), 'KYS');
  assert.equal(shortOf('İstanbul'), 'İST');
  assert.equal(shortOf('Ankara Gücü', 'agç'), 'AGÇ');
  assert.equal(nameKey('  Kuzey   Yıldızı! '), nameKey('kuzey yıldızı'));
  assert.ok(upgradeCost('stadium', 2) > upgradeCost('stadium', 1));
  assert.equal(buildMs(1), 2 * 60e3);
  const e1 = effectsOf({});
  const e10 = effectsOf({ stadium: 10, training: 10, academy: 10, fanshop: 10 });
  assert.equal(e1.stadium.incomePct, 0);
  assert.ok(e10.stadium.capacity > e1.stadium.capacity);
  assert.ok(e10.training.sessions > e1.training.sessions);
  assert.ok(e10.academy.cap > e1.academy.cap);
  assert.ok(e10.fanshop.daily > e1.fanshop.daily);
  assert.ok(xpNeed(80) > xpNeed(60));
  assert.ok(trainCost(80, 'mac') > trainCost(80, 'fizik'));
  assert.equal(clubLevel({ stadium: 3, training: 2 }), 4);
});

test('kulüp kurulmadan kadro, hoşgeldin paketi ve kapışma kilitli; kuruluş hediyesi verilir', async () => {
  const { s } = svc();
  const st0 = await s.state({ uid: 'u1' });
  assert.equal(st0.club, null);
  await assert.rejects(s.welcomePack({ uid: 'u1', region: 'tur' }), /kulübünü kur/);
  await assert.rejects(s.saveSquad({ uid: 'u1', name: 'X', formation: '4-3-3', slots: {} }), /kulübünü kur/);
  await assert.rejects(s.club.upgrade({ uid: 'u1', facility: 'stadium' }), /kulübünü kur/);

  await assert.rejects(s.club.create({ uid: 'u1', name: 'ab', fans: 'Aslanlar', crest }), /3-22/);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest: { ...crest, secondary: 3 } }), /iki rengi/);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest: { ...crest, symbol: 99 } }), /arma/);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'amk spor', fans: 'Aslanlar', crest }), /kullanılamaz/);

  const r = await s.club.create({ uid: 'u1', name: 'Kuzey Yıldızı', fans: 'Kuzey Aslanları', crest, short: 'KYZ' });
  assert.equal(r.club.name, 'Kuzey Yıldızı');
  assert.equal(r.club.short, 'KYZ');
  assert.equal(r.club.fans, 'Kuzey Aslanları');
  assert.deepEqual(r.club.crest, crest);
  assert.equal(r.club.level, 1);
  assert.equal(r.balance, START_CREDITS + CLUB.foundingGift);
  assert.equal(r.club.facilities.length, Object.keys(FACILITIES).length);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Başka', fans: 'Aslanlar', crest }), /zaten kurulu/);
  // Ad tekil (büyük-küçük harf ve boşluk farkı sayılmaz)
  await assert.rejects(s.club.create({ uid: 'u2', name: 'kuzey  YILDIZI', fans: 'Biz', crest }), /alınmış/);

  const st = await s.state({ uid: 'u1' });
  assert.equal(st.club.name, 'Kuzey Yıldızı');
  assert.equal(st.club.training.left, effectsOf({}).training.sessions);
  const { sq } = await squad(s, 'u1');
  // Kapışmada takım kulübün adıyla çıkar
  const start = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli' });
  assert.equal(start.me.name, 'Kuzey Yıldızı');
  assert.equal(start.me.fans, 'Kuzey Aslanları');
});

test('tesis yükseltme: kredi düşer, tek inşaat, süre dolunca seviye artar; stadyum maç gelirini artırır', async () => {
  const { s, store, clock } = svc();
  await s.club.create({ uid: 'u1', name: 'Kuzey Yıldızı', fans: 'Kuzey Aslanları', crest });
  const before = (await s.state({ uid: 'u1' })).credits;
  const cost = upgradeCost('stadium', 1);
  const up = await s.club.upgrade({ uid: 'u1', facility: 'stadium' });
  assert.equal(up.cost, cost);
  assert.equal(up.balance, before - cost);
  assert.equal(up.club.build.facility, 'stadium');
  await assert.rejects(s.club.upgrade({ uid: 'u1', facility: 'training' }), /inşaatı sürüyor/);
  clock.t += buildMs(1) + 1000;
  const st = await s.state({ uid: 'u1' });
  assert.equal(st.club.build, null);
  assert.equal(st.club.facilities.find((f) => f.id === 'stadium').level, 2);
  assert.equal(st.club.level, 2);
  assert.equal(st.club.incomePct, 8);
  // Kredi yetmezse yükseltme yok
  store.profiles.get('u1').credits = 10;
  await assert.rejects(s.club.upgrade({ uid: 'u1', facility: 'stadium' }), /Yetersiz kredi/);
  store.profiles.get('u1').credits = 5000;

  // Stadyum geliri: kapışma ödülüne +%8
  const { sq } = await squad(s, 'u1');
  const start = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli' });
  const fin = await s.duelFinish({ uid: 'u1', duelId: start.duelId });
  const base = { W: DUEL.win, D: DUEL.draw, L: DUEL.loss }[fin.result];
  assert.equal(fin.stadiumBonus, Math.round(base * 0.08));
  assert.equal(fin.reward, base + fin.stadiumBonus);
});

test('taraftar mağazası: günde bir kez gelir', async () => {
  const { s, clock } = svc();
  await s.club.create({ uid: 'u1', name: 'Kuzey Yıldızı', fans: 'Kuzey Aslanları', crest });
  const r = await s.club.collect({ uid: 'u1' });
  assert.equal(r.amount, effectsOf({}).fanshop.daily);
  assert.equal(r.club.shop.ready, false);
  await assert.rejects(s.club.collect({ uid: 'u1' }), /alındı/);
  clock.t += 86400e3;
  const r2 = await s.club.collect({ uid: 'u1' });
  assert.equal(r2.amount, effectsOf({}).fanshop.daily);
});

test('antrenman: gelişim puanı birikir, güç artar, günlük hak ve akademi sınırı', async () => {
  const { s, store } = svc();
  await s.club.create({ uid: 'u1', name: 'Kuzey Yıldızı', fans: 'Kuzey Aslanları', crest });
  const { w, sq } = await squad(s, 'u1');
  const card = w.cards.find((c) => c.g === 'FV');
  store.profiles.get('u1').credits = 100000;
  // Düşük güçlü oyuncu: bir günün antrenmanı bir puan için yeter (eşik 120, günlük 3 × 45)
  store.cards.get('u1').set(card.id, { ...store.cards.get('u1').get(card.id), r: 55 });
  card.r = 55;
  const r0 = card.r;
  const st0 = [...card.st];
  await assert.rejects(s.club.train({ uid: 'u1', cardId: card.id, drill: 'yüzme' }), /Geçersiz antrenman/);
  await assert.rejects(s.club.train({ uid: 'u1', cardId: 'yok', drill: 'fizik' }), /bulunamadı/);
  let last;
  const sessions = effectsOf({}).training.sessions;
  for (let i = 0; i < sessions; i++) last = await s.club.train({ uid: 'u1', cardId: card.id, drill: 'fizik' });
  assert.equal(last.left, 0);
  await assert.rejects(s.club.train({ uid: 'u1', cardId: card.id, drill: 'fizik' }), /hakkın bitti/);
  const saved = (await store.listCards('u1')).find((c) => c.id === card.id);
  const gained = saved.r - r0;
  assert.equal(gained, 1);
  assert.equal(saved.dev.plus, gained);
  assert.equal(saved.dev.base, r0);
  if (gained > 0) {
    assert.ok(saved.st[0] > st0[0] || saved.st[5] > st0[5], 'fizik: hız ve fizik artar');
    // Kadronun gücü yenilendi
    const sq2 = (await store.listSquads('u1')).find((x) => x.id === sq.id);
    assert.notEqual(sq2.rating, sq.rating, 'kadro gücü yeni puanla hesaplandı');
  }
  // Akademi sınırı: sınıra gelen oyuncu gelişmez
  store.cards.get('u1').set(card.id, { ...saved, dev: { xp: 0, plus: effectsOf({}).academy.cap, base: r0 } });
  store.daily.clear();
  await assert.rejects(s.club.train({ uid: 'u1', cardId: card.id, drill: 'teknik' }), /gelişim sınırında/);
});

test('kulüp kimliği kilitli: ad, arma ve taraftar grubu kuruluştan sonra değişmez', async () => {
  const { s } = svc();
  await s.club.create({ uid: 'u1', name: 'Kuzey Yıldızı', fans: 'Kuzey Aslanları', crest, kits });
  await assert.rejects(s.club.edit({ uid: 'u1', fans: 'Yıldız Ordusu', crest: { ...crest, symbol: 2 } }), /değiştirilemez/);
  const st = await s.club.get({ uid: 'u1' });
  assert.equal(st.club.fans, 'Kuzey Aslanları');
  assert.equal(st.club.crest.symbol, crest.symbol);
  // Formalar kuruluşta seçildi: yeniden seçilemez
  await assert.rejects(s.club.setKits({ uid: 'u1', kits }), /değiştirilemez/);
});

test('formalar: kuruluşta seçilir ve denetlenir; eski kulüp bir kez seçer', async () => {
  const { s, store } = svc();
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest, kits: { ...kits, away: { ...kits.away, shirt: kits.home.shirt } } }), /ana rengi farklı/);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest, kits: { ...kits, gk: { ...kits.gk, shirt: kits.away.shirt } } }), /Kaleci/);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest, kits: { ...kits, home: { ...kits.home, pattern: 1, second: kits.home.shirt } } }), /iki rengi/);
  await assert.rejects(s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest, kits: { ...kits, home: { ...kits.home, socks: 99 } } }), /Geçersiz/);
  const r = await s.club.create({ uid: 'u1', name: 'Kuzey Spor', fans: 'Aslanlar', crest, kits });
  assert.deepEqual(r.club.kits, kits);
  assert.equal(r.club.kitsChosen, true);
  assert.equal(r.club.venue, 'Kuzey Spor Stadyumu');
  // Formasız kurulmuş eski kulüp: armadan türetilen formalar görünür, bir kez seçilebilir
  await s.club.create({ uid: 'u2', name: 'Güney Spor', fans: 'Güneyliler', crest: { ...crest, primary: 1, secondary: 4 } });
  const old = store.profiles.get('u2');
  delete old.club.kits;
  const v = await s.club.get({ uid: 'u2' });
  assert.equal(v.club.kitsChosen, false);
  assert.equal(v.club.kits.home.shirt, 1);
  assert.notEqual(v.club.kits.gk.shirt, v.club.kits.home.shirt);
  const set = await s.club.setKits({ uid: 'u2', kits: { ...kits, home: { ...kits.home, shirt: 6 } } });
  assert.equal(set.club.kits.home.shirt, 6);
  await assert.rejects(s.club.setKits({ uid: 'u2', kits }), /değiştirilemez/);
});

test('sıradaki maç: rakip önceden belirlenir, maçta aynı rakip çıkar; kulüp formasıyla oynanır', async () => {
  const { s } = svc();
  await s.club.create({ uid: 'u1', name: 'Kuzey Yıldızı', fans: 'Kuzey Aslanları', crest, kits });
  await assert.rejects(s.duelNext({ uid: 'u1' }), /kadro kur/);
  const { sq } = await squad(s, 'u1');
  const n1 = await s.duelNext({ uid: 'u1' });
  const n2 = await s.duelNext({ uid: 'u1' });
  assert.equal(n1.opponent.name, n2.opponent.name);
  assert.equal(n1.opponent.power, n2.opponent.power);
  assert.ok(n1.opponent.kits?.home, 'rakibin forması');
  assert.ok(n1.opponent.crest, 'rakibin arması');
  // Maç ev sahibinin stadyumunda: iç sahada kulübün stadyumu, deplasmanda rakibin
  assert.equal(n1.venue.name, n1.home ? 'Kuzey Yıldızı Stadyumu' : `${n1.opponent.name} Arena`);
  assert.equal(n1.stadium.host, n1.home ? 'me' : 'opp');
  assert.deepEqual(n1.rewards, [DUEL.win, DUEL.draw, DUEL.loss]);
  const start = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', kit: 'away' });
  assert.equal(start.opponent.name, n1.opponent.name);
  assert.equal(start.home, n1.home, 'maç öncesinde gösterilen saha');
  assert.equal(start.venue, n1.venue.name);
  assert.deepEqual(start.me.kits, kits);
  assert.equal(start.me.wear, 'away');
  assert.deepEqual(start.me.crest, crest);
  assert.ok(start.opponent.kits?.home);
  const fin = await s.duelFinish({ uid: 'u1', duelId: start.duelId });
  assert.equal(fin.me.wear, 'away');
  assert.deepEqual(fin.me.kits, kits);
  // Maç oynandı: sıradaki maç için rakip yeniden belirlenir (kayıt silindi)
  const boss = await s.duelNext({ uid: 'u1', mode: 'boss' });
  assert.equal(boss.opponent.boss, true);
  assert.ok(boss.opponent.kits?.home);
});
