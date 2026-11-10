// Kulüp yönetimi: seyirci ve bilet fiyatı, maç günü gelirleri, ilişkiler, basın toplantısı, sakatlık/ceza/kadro dışı,
// transfer teklifi, mesaj kutusu, yönetimden bütçe ve taraftardan destek talebi.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameService } from '../game/service.js';
import { slotsOf } from '../game/squad.js';
import { FACILITIES, effectsOf } from '../game/club.js';
import {
  attendanceOf,
  matchdayIncome,
  resultDeltas,
  ticketMood,
  checkTicket,
  fairTicket,
  pressKind,
  makePress,
  headlinesFor,
  quoteOf,
  matchEvents,
  relMood,
  REL_START,
  TICKET,
  ASK,
} from '../game/office.js';
import { createRng } from '../engine/rng.js';
import { memoryGameStore, syntheticPool } from './game_fakes.js';

const NOW = Date.UTC(2026, 10, 9, 9, 0);
const DAY = 86400e3;
const crest = { shape: 2, primary: 3, secondary: 5, symbol: 7, pattern: 1 };
const kits = {
  home: { pattern: 1, shirt: 3, second: 4, shorts: 4, socks: 3 },
  away: { pattern: 0, shirt: 4, second: 3, shorts: 3, socks: 4 },
  gk: { pattern: 0, shirt: 9, second: 5, shorts: 9, socks: 9 },
};

function svc(clock = { t: NOW }) {
  const store = memoryGameStore({ users: { u1: { username: 'tostcu23' } } });
  let seed = 11;
  const s = new GameService({ store, pool: syntheticPool(), access: { entitlement: async () => ({ subscribed: false }) }, now: () => clock.t, random: () => createRng(seed++), log: { warn() {} } });
  return { s, store, clock };
}

async function club(s, uid = 'u1') {
  await s.club.create({ uid, name: 'Kuzey Yıldızı', fans: 'Kuzeyliler', crest, kits });
  const w = await s.welcomePack({ uid, region: 'tur' });
  const byG = (g) => w.cards.filter((c) => c.g === g).map((c) => c.id);
  const kl = byG('KL'), def = byG('DEF'), os = byG('OS'), fv = byG('FV');
  const ids = [kl[0], def[0], def[1], def[2], def[3], os[0], os[1], os[2], fv[0], fv[1], fv[2]];
  const slots = Object.fromEntries(slotsOf('4-3-3').map((x, i) => [x.key, ids[i]]));
  return { w, ids, sq: await s.saveSquad({ uid, name: 'A Takımı', formation: '4-3-3', slots }) };
}

/** Profilin kulüp yönetimi kaydını doğrudan değiştirir (test için). */
async function patchOffice(store, uid, f) {
  const p = await store.getProfile(uid);
  const office = f({ ...(p.club.office ?? {}) });
  await store.updateProfile(uid, { club: { ...p.club, office } });
}

test('seyirci: olağan fiyatta stadyum dolar, iki katında tribün boşalır; kapasite ve taraftar havası sınırlar', () => {
  const base = { capacity: 5000, supporters: 3150, fans: 60, div: 0 };
  assert.equal(attendanceOf({ ...base, price: fairTicket(0) }), 5000, 'olağan fiyatta dolu');
  const high = attendanceOf({ ...base, price: fairTicket(0) * 2 });
  assert.ok(high < 600, `iki kat fiyatta neredeyse boş (${high})`);
  const mid = attendanceOf({ ...base, price: fairTicket(0) * 1.5 });
  assert.ok(mid > high && mid < 5000, 'fiyat arttıkça seyirci azalır');
  assert.ok(attendanceOf({ ...base, capacity: 59000, price: 60 }) < 59000, 'büyük stadyumu talep doldurmaz');
  assert.ok(attendanceOf({ ...base, capacity: 59000, fans: 90, price: 60 }) > attendanceOf({ ...base, capacity: 59000, fans: 20, price: 60 }), 'mutlu taraftar daha çok gelir');
  assert.equal(checkTicket(57), 60);
  assert.equal(checkTicket(5), TICKET.min);
  assert.equal(checkTicket(9999), TICKET.max);
  assert.deepEqual(TICKET.fair.map((_, i) => fairTicket(i)), [60, 90, 130, 180, 250]);
});

test('maç günü gelirleri: gişe, otopark (yerle sınırlı), yeme-içme, forma; tesis seviyesi geliri artırır', () => {
  const a = matchdayIncome({ attendance: 5000, price: 60, levels: {}, fans: 60 });
  assert.equal(a.gate, 120);
  assert.equal(a.cars, 1500);
  assert.equal(a.spaces, 400);
  assert.equal(a.parking, 20, 'otopark 400 araçla sınırlı');
  assert.equal(a.food, 40);
  assert.equal(a.total, a.gate + a.parking + a.food + a.shirts);
  const b = matchdayIncome({ attendance: 5000, price: 60, levels: { parking: 5, food: 5, megastore: 5 }, fans: 60 });
  assert.ok(b.parking > a.parking && b.food > a.food && b.shirts > a.shirts);
  assert.ok(matchdayIncome({ attendance: 5000, price: 60, fans: 60, win: true }).shirts > a.shirts, 'galibiyette forma satışı artar');
  assert.equal(matchdayIncome({ attendance: 0, price: 60 }).total, 0);
  // Yeni tesisler kulüpte
  for (const f of ['parking', 'food', 'megastore']) assert.ok(FACILITIES[f], f);
  assert.equal(effectsOf({ parking: 3 }).parking.spaces, 1200);
});

test('ilişkiler: sonuç, fark, güçlü rakip; bilet fiyatının taraftara etkisi; ruh hali', () => {
  assert.deepEqual(resultDeltas('W', 1), { board: 3, fans: 4, media: 2 });
  assert.deepEqual(resultDeltas('L', -1), { board: -3, fans: -4, media: -2 });
  assert.deepEqual(resultDeltas('L', -4), { board: -4, fans: -6, media: -3 }, 'ağır yenilgi daha çok kızdırır');
  assert.deepEqual(resultDeltas('W', 1, true), { board: 4, fans: 5, media: 2 });
  assert.equal(ticketMood(40, 0), 2);
  assert.equal(ticketMood(60, 0), 0);
  assert.ok(ticketMood(130, 0) <= -3);
  assert.deepEqual([90, 65, 45, 25, 5].map(relMood), ['Çok iyi', 'İyi', 'Orta', 'Gergin', 'Kriz']);
});

test('basın toplantısı: soru sonuca göre, üç cevap, manşetler', () => {
  assert.deepEqual([[4, 0], [2, 1], [1, 1], [0, 1], [0, 3]].map(([a, b]) => pressKind(a, b)), ['bigwin', 'win', 'draw', 'loss', 'bigloss']);
  const pr = makePress({ id: 'p1', at: NOW, my: 0, opp: 2, oppName: 'Liman Belediye', week: 3, seed: 'x' });
  assert.equal(pr.result, 'L');
  assert.equal(pr.options.length, 3);
  assert.ok(pr.q.length > 10 && !pr.q.includes('{'));
  const h = headlinesFor(pr, 'self', 'Kuzey Yıldızı');
  assert.equal(h.length, 2);
  assert.match(h[0].text, /sorumluluğu üstlendi/);
  // Manşetteki alıntı, seçilen açıklamadan gelir
  const opt = pr.options.find((o) => o.id === 'self');
  assert.ok(h[0].text.includes(quoteOf(opt.text)));
  const dr = makePress({ id: 'p2', at: NOW, my: 1, opp: 1, oppName: 'Kuzey Birlik', seed: 'y' });
  const calm = headlinesFor(dr, 'calm', 'Kuzey Yıldızı')[0].text;
  assert.ok(calm.includes('her puan değerli'), calm);
  assert.equal(quoteOf('Kısa. Uzun devamı'), 'Kısa');
  assert.ok(quoteOf('a'.repeat(30) + ' ' + 'b'.repeat(50)).endsWith('…'));
  for (const k of ['bigwin', 'win', 'draw', 'loss', 'bigloss']) {
    const x = makePress({ id: 'p', at: NOW, ...{ bigwin: { my: 4, opp: 0 }, win: { my: 2, opp: 1 }, draw: { my: 1, opp: 1 }, loss: { my: 0, opp: 1 }, bigloss: { my: 0, opp: 4 } }[k], oppName: 'X', seed: k });
    assert.equal(x.kind, k);
    for (const o of x.options) assert.ok(o.text.length > 10 && !o.text.includes('{'), 'cevap düz metin');
  }
});

test('maç sonrası olaylar: kırmızı kart cezası, sakatlık (yoğun planla daha sık), disiplin, transfer teklifi', () => {
  const lineup = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, { id: `c${i}`, s: `Oyuncu ${i}`, n: `Oyuncu ${i}`, g: i === 0 ? 'KL' : 'OS', r: 70 }]));
  const ev = matchEvents({ seed: 'a', lineup, reds: ['Oyuncu 4'] });
  assert.deepEqual(ev.reds, [{ id: 'c4', name: 'Oyuncu 4', left: 1, note: 'kırmızı kart cezası' }]);
  // Olasılıklar: 400 maçta sakatlık sayısı plana göre
  const count = (plan, fit = 0) => Array.from({ length: 400 }, (_, i) => matchEvents({ seed: `s${i}`, lineup, plan, fit }).injuries.length).reduce((a, b) => a + b, 0);
  const calm = count({ press: 1, tempo: 1 }), hard = count({ press: 5, tempo: 5 });
  assert.ok(hard > calm, `yoğun pres ve tempo daha çok sakatlık (${hard} > ${calm})`);
  assert.ok(count({ press: 3, tempo: 3 }, 5) < count({ press: 3, tempo: 3 }, 0), 'kondisyoner sakatlığı azaltır');
  // Kaleci sakatlanmaz; yokluktaki oyuncu yeniden sakatlanmaz
  for (let i = 0; i < 200; i++) {
    const e = matchEvents({ seed: `k${i}`, lineup, absent: { c3: { type: 'injury' } } });
    for (const x of e.injuries) assert.ok(x.id !== 'c0' && x.id !== 'c3');
  }
  // Teklif: en az 12 kart gerekir; altyapı oyuncusuna teklif gelmez
  const cards = Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, s: `K${i}`, r: 60 + i, youth: i === 19 }));
  const offers = Array.from({ length: 300 }, (_, i) => matchEvents({ seed: `o${i}`, lineup, cards }).offer).filter(Boolean);
  assert.ok(offers.length > 10);
  assert.ok(offers.every((o) => o.id !== 'k19' && o.price >= 100));
  assert.equal(Array.from({ length: 200 }, (_, i) => matchEvents({ seed: `o${i}`, lineup, cards: cards.slice(0, 8) }).offer).filter(Boolean).length, 0);
  assert.ok(Array.from({ length: 300 }, (_, i) => matchEvents({ seed: `d${i}`, lineup }).discipline).some(Boolean));
});

test('yönetim ekranı: hoş geldin mesajları, bilet fiyatı ve tahmin, okundu', async () => {
  const { s } = svc();
  await club(s);
  const st0 = await s.state({ uid: 'u1' });
  assert.equal(st0.office.relations.length, 3);
  assert.deepEqual(st0.office.relations.map((r) => r.value), [REL_START.board, REL_START.fans, REL_START.media]);
  assert.equal(st0.office.ticket, 60);
  const o = await s.office.state({ uid: 'u1' });
  assert.equal(o.inbox.length, 2);
  assert.ok(o.inbox.every((m) => m.read === false));
  assert.equal(o.ticket.price, 60);
  assert.equal(o.ticket.forecast.attendance, 5000);
  assert.ok(o.ticket.curve.length >= 5);
  assert.ok(o.ticket.curve.at(-1).attendance < o.ticket.curve[0].attendance, 'pahalı bilet: az seyirci');
  const t = await s.office.setTicket({ uid: 'u1', price: 118 });
  assert.equal(t.ticket.price, 120);
  assert.ok(t.ticket.forecast.attendance < 5000);
  const r = await s.office.read({ uid: 'u1' });
  assert.ok(r.inbox.every((m) => m.read));
  assert.equal((await s.state({ uid: 'u1' })).office.unread, 0);
});

test('kariyer maçı sonrası: ilişkiler değişir, ev maçında gelir, basın toplantısı; cevap ilişkileri etkiler', async () => {
  const { s } = svc();
  const { sq } = await club(s);
  await s.manager.start({ uid: 'u1' });
  let home = null;
  let f = null;
  for (let i = 0; i < 3; i++) {
    const pv = await s.duelNext({ uid: 'u1', mode: 'season' });
    const k = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'season' });
    f = await s.duelFinish({ uid: 'u1', duelId: k.duelId });
    assert.ok(f.office, 'kulüp yönetimi özeti yanıtta');
    assert.equal(f.office.relations.length, 3);
    assert.ok(f.office.press?.options?.length === 3);
    if (pv.fixture.home) {
      home = f;
      assert.ok(f.office.matchday, 'ev maçında gelir');
      assert.equal(f.office.matchday.total, f.office.matchday.gate + f.office.matchday.parking + f.office.matchday.food + f.office.matchday.shirts);
      assert.ok(f.office.matchday.attendance > 0);
    } else {
      assert.equal(f.office.matchday, null, 'deplasmanda gişe yok');
    }
    if (i < 2) {
      // Basın toplantısına cevap
      const ans = await s.office.press({ uid: 'u1', id: f.office.press.id, answer: f.office.press.options[0].id });
      assert.equal(ans.headlines.length, 2);
      assert.ok(ans.statement.length > 10);
      await assert.rejects(s.office.press({ uid: 'u1', id: f.office.press.id, answer: 'self' }), /basın toplantısı yok/);
    }
  }
  assert.ok(home, 'üç maçta en az bir ev maçı');
  // Son basın toplantısı cevapsız kaldı: bir sonraki maçtan önce bekliyor
  const st = await s.state({ uid: 'u1' });
  assert.ok(st.office.press);
  assert.ok(st.office.unread >= 2);
});

test('sakat, cezalı ve kadro dışı oyuncu kariyer maçında oynayamaz; süre her maçta azalır', async () => {
  const { s, store } = svc();
  const { sq, ids } = await club(s);
  await s.manager.start({ uid: 'u1' });
  await patchOffice(store, 'u1', (o) => ({ ...o, absent: { [ids[5]]: { type: 'injury', left: 2, name: 'Orta Saha', note: 'diz' } } }));
  const pv = await s.duelNext({ uid: 'u1', mode: 'season' });
  assert.equal(pv.absent.length, 1);
  await assert.rejects(s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'season' }), /oynayamazlar: Orta Saha \(sakat, 2 maç\)/);
  // Normal kapışmada oynayabilir
  const k = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'normal' });
  await s.duelFinish({ uid: 'u1', duelId: k.duelId });
  // Yokluk bir maç kala: kariyer maçı oynanınca biter
  await patchOffice(store, 'u1', (o) => ({ ...o, absent: { [ids[5]]: { type: 'red', left: 1, name: 'Orta Saha', note: 'kırmızı kart cezası' }, x9: { type: 'injury', left: 3, name: 'Başka', note: 'kas' } } }));
  const sq2 = await s.saveSquad({ uid: 'u1', id: sq.id, name: 'A Takımı', formation: '4-3-3', slots: sq.slots });
  assert.ok(sq2);
  await patchOffice(store, 'u1', (o) => ({ ...o, absent: { x9: { type: 'injury', left: 3, name: 'Başka', note: 'kas' } } }));
  const k2 = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'season' });
  await s.duelFinish({ uid: 'u1', duelId: k2.duelId });
  const st = await s.office.state({ uid: 'u1' });
  const x9 = st.absent.find((a) => a.id === 'x9');
  assert.equal(x9.left, 2, 'süre bir azaldı');
});

test('mesajdaki kararlar: transfer teklifi kabul/ret, disiplin (kadro dışı ya da uyarı)', async () => {
  const { s, store, clock } = svc();
  const { w, ids } = await club(s);
  const free = w.cards.find((c) => !ids.includes(c.id));
  await s.office.state({ uid: 'u1' });
  const before = (await store.getProfile('u1')).credits;
  await patchOffice(store, 'u1', (o) => ({
    ...o,
    seq: 10,
    inbox: [
      { id: 'm9', at: NOW, from: 'transfer', text: 'teklif', read: false, act: { kind: 'offer', cardId: free.id, name: free.s, buyer: 'Liman FK', price: 900, state: 'open', expires: NOW + 3 * DAY } },
      { id: 'm8', at: NOW, from: 'transfer', text: 'teklif 2', read: false, act: { kind: 'offer', cardId: ids[1], name: 'Kadrolu', buyer: 'Sahil Spor', price: 700, state: 'open', expires: NOW + 3 * DAY } },
      { id: 'm7', at: NOW, from: 'captain', text: 'disiplin', read: false, act: { kind: 'discipline', cardId: ids[2], name: 'Defans', state: 'open', expires: NOW + 3 * DAY } },
      ...o.inbox,
    ],
  }));
  await assert.rejects(s.office.act({ uid: 'u1', id: 'm8', choice: 'accept' }), /bir kadroda/);
  const a = await s.office.act({ uid: 'u1', id: 'm9', choice: 'accept' });
  assert.equal(a.balance, before + 900);
  assert.ok(!(await store.listCards('u1')).some((c) => c.id === free.id), 'oyuncu satıldı');
  await assert.rejects(s.office.act({ uid: 'u1', id: 'm9', choice: 'accept' }), /bekleyen bir karar yok/);
  const r = await s.office.act({ uid: 'u1', id: 'm8', choice: 'reject' });
  assert.ok(r.inbox[0].text.includes('reddettik'));
  const d = await s.office.act({ uid: 'u1', id: 'm7', choice: 'drop' });
  assert.equal(d.absent.find((x) => x.id === ids[2]).type, 'dropped');
  assert.equal(d.absent.find((x) => x.id === ids[2]).left, 2);
  // Süresi geçen teklif
  await patchOffice(store, 'u1', (o) => ({ ...o, inbox: [{ id: 'm20', at: NOW, from: 'transfer', text: 't', read: false, act: { kind: 'offer', cardId: ids[3], name: 'X', buyer: 'B', price: 500, state: 'open', expires: NOW + DAY } }, ...o.inbox] }));
  clock.t = NOW + 2 * DAY;
  await assert.rejects(s.office.act({ uid: 'u1', id: 'm20', choice: 'accept' }), /süresi doldu/);
});

test('talepler: yönetimden bütçe (güvene bağlı, bekleme süresi), taraftardan destek (yalnızca zor durumda)', async () => {
  const { s, store, clock } = svc();
  await club(s);
  const b = await s.office.ask({ uid: 'u1', kind: 'board' });
  assert.ok(b.amount > 0, 'başkanın güveni yeterli: bütçe geldi');
  assert.equal(b.relations.find((r) => r.id === 'board').value, REL_START.board - 4);
  await assert.rejects(s.office.ask({ uid: 'u1', kind: 'board' }), /birkaç gün sonra/);
  clock.t = NOW + ASK.boardCooldown + 1000;
  await patchOffice(store, 'u1', (o) => ({ ...o, rel: { ...o.rel, board: 30 } }));
  const b2 = await s.office.ask({ uid: 'u1', kind: 'board' });
  assert.equal(b2.amount, 0, 'güven düşük: ret');
  assert.match(b2.inbox[0].text, /bütçe veremeyiz/);
  // Taraftar desteği: kasa doluyken olmaz
  await store.updateProfile('u1', { credits: 5000 });
  await assert.rejects(s.office.ask({ uid: 'u1', kind: 'fans' }), /zor durumdayken/);
  const p = await store.getProfile('u1');
  await store.updateProfile('u1', { credits: 300 });
  const f = await s.office.ask({ uid: 'u1', kind: 'fans' });
  assert.ok(f.amount >= 200 && f.amount <= 2500);
  assert.equal(f.balance, 300 + f.amount);
  assert.ok(p);
  await assert.rejects(s.office.ask({ uid: 'u1', kind: 'fans' }), /zor durumdayken|birkaç gün sonra/);
  await assert.rejects(s.office.ask({ uid: 'u1', kind: 'x' }), /Geçersiz talep/);
});
