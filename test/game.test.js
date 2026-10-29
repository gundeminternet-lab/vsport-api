// Oyunlar: havuz ve kart puanı, kimya ve kadro, sorular, servis akışları (bonus, görev, Fotoğraftan Bil, yarışma,
// paketler, hoşgeldin paketi, kadro, satış, kapışma, liderler).
import test from 'node:test';
import assert from 'node:assert/strict';

import { groupOf, parseRoster, teamCards, playerRating, tierOf, fold, PlayerPool } from '../game/pool.js';
import { evaluate, validateSquad, autoBuild, slotsOf, FORMATIONS } from '../game/squad.js';
import { buildQuestions, STATIC_QUESTIONS } from '../game/quiz.js';
import { simulateDuel } from '../game/duel.js';
import { GameService } from '../game/service.js';
import { BONUS_PATH, PACKS, START_CREDITS, QUIZ, PHOTO, DUEL } from '../game/economy.js';
import { nation } from '../game/nations.js';
import { createRng } from '../engine/rng.js';
import { memoryGameStore, syntheticPool } from './game_fakes.js';

const NOW = Date.UTC(2026, 9, 28, 9, 0);

function svc({ now = () => NOW, pro = false, users = { u1: { username: 'tostcu23', photoURL: null }, u2: { username: 'rakip', photoURL: null } } } = {}) {
  const store = memoryGameStore({ users });
  const pool = syntheticPool();
  let seed = 1;
  const s = new GameService({ store, pool, access: { entitlement: async () => ({ subscribed: pro }) }, now, random: () => createRng(seed++), log: { warn() {} } });
  return { s, store, pool };
}

test('mevki grubu ve kadro ayrıştırma (düz ve gruplu biçim)', () => {
  assert.equal(groupOf('G'), 'KL');
  assert.equal(groupOf('D'), 'DEF');
  assert.equal(groupOf('M'), 'OS');
  assert.equal(groupOf('F'), 'FV');
  assert.equal(groupOf('LW'), 'FV');
  assert.equal(groupOf(null, 'Goalkeeper'), 'KL');
  const flat = parseRoster({ athletes: [{ id: 1, displayName: 'A B', jersey: '9', position: { abbreviation: 'F' }, age: 27, citizenship: 'Brazil', headshot: { href: 'h' }, statistics: { splits: { categories: [{ stats: [{ name: 'appearances', value: 10 }, { name: 'totalGoals', value: 7 }] }] } } }] });
  assert.equal(flat.length, 1);
  assert.equal(flat[0].apps, 10);
  assert.equal(flat[0].goals, 7);
  const grouped = parseRoster({ athletes: [{ position: 'Goalkeepers', items: [{ id: 2, displayName: 'K L', position: { abbreviation: 'G' } }] }] });
  assert.equal(grouped[0].id, '2');
  assert.deepEqual(nation('Brazil'), { name: 'Brezilya', iso: 'BR' });
  assert.deepEqual(nation('Atlantis'), { name: 'Atlantis', iso: null });
});

test('kart puanı: güçlü lig ve lider takım yüksek, sabit (aynı oyuncu aynı puan), 47-92 arası', () => {
  const star = playerRating({ strength: 1, rank: 1, teams: 20, group: 'FV', age: 27, share: 1, goals: 20, assists: 8, rng: createRng(1) });
  const bench = playerRating({ strength: 0.8, rank: 18, teams: 18, group: 'DEF', age: 19, share: 0.1, rng: createRng(1) });
  assert.ok(star >= 85 && star <= 92, `${star}`);
  assert.ok(bench <= 60, `${bench}`);
  const players = parseRoster({ athletes: [{ id: 7, displayName: 'Ali Veli', jersey: '10', position: { abbreviation: 'M' }, age: 24, citizenship: 'Turkey' }] });
  const a = teamCards(players, { id: 1, name: 'Galatasaray', logo: 'l' }, { league: 'tur.1', strength: 0.8, rank: 1, teams: 18 });
  const b = teamCards(players, { id: 1, name: 'Galatasaray', logo: 'l' }, { league: 'tur.1', strength: 0.8, rank: 1, teams: 18 });
  assert.deepEqual(a, b);
  assert.equal(a[0].na, 'Türkiye');
  assert.equal(a[0].st.length, 6);
  assert.equal(tierOf(64), 'bronze');
  assert.equal(tierOf(75), 'gold');
  assert.equal(fold('Şükrü İçel'), 'sukru icel');
});

test('havuz: kayıtlı havuz yüklenir, eksik lig arka planda kurulur, arama 3 harften', async () => {
  const saved = new Map();
  const espn = {
    getTeams: async () => [{ id: '1', name: 'Takım A', logo: null }, { id: '2', name: 'Takım B', logo: null }],
    getStandings: async () => ({ entries: new Map([['1', { rank: 1 }], ['2', { rank: 2 }]]), teamCount: 2 }),
    getRoster: async (lg, id) => ({ athletes: [{ id: `${id}1`, displayName: `Mehmet ${id}`, position: { abbreviation: 'F' } }, { id: `${id}2`, displayName: `Kaleci ${id}`, position: { abbreviation: 'G' } }] }),
  };
  const pool = new PlayerPool({ store: { getPool: async (l) => saved.get(l) ?? null, savePool: async (l, d) => saved.set(l, d) }, espn, leagues: ['tur.1'], now: () => NOW, log: { warn() {} } });
  await pool.ensure();
  await pool.building;
  assert.equal(pool.size, 4);
  assert.ok(saved.get('tur.1').players.length === 4);
  assert.equal(pool.search('meh').length, 2);
  assert.equal(pool.search('me').length, 0);
  // Yeniden başlatma: Firestore'dan yüklenir, kurulmaz
  let built = 0;
  const pool2 = new PlayerPool({ store: { getPool: async (l) => saved.get(l) ?? null, savePool: async () => built++ }, espn, leagues: ['tur.1'], now: () => NOW, log: { warn() {} } });
  await pool2.ensure();
  assert.equal(pool2.size, 4);
  assert.equal(pool2.building, null);
  assert.equal(built, 0);
});

const card = (id, g, r, ci = 'A', na = 'Türkiye', l = 'tur.1') => ({ id, pid: `p${id}`, g, r, ci, c: ci, na, l, s: `S${id}` });

test('kimya: aynı kulüp, uyruk ve lig arttırır; yanlış mevkideki oyuncu 0; en çok 33', () => {
  const groups = ['KL', 'DEF', 'DEF', 'DEF', 'DEF', 'OS', 'OS', 'OS', 'FV', 'FV', 'FV'];
  const same = Object.fromEntries(slotsOf('4-3-3').map((s, i) => [s.key, card(String(i), groups[i], 70)]));
  const ev = evaluate('4-3-3', same);
  assert.equal(ev.chemistry, 33);
  assert.equal(ev.rating, 70);
  assert.equal(ev.missing, 0);
  const mixed = Object.fromEntries(slotsOf('4-3-3').map((s, i) => [s.key, card(String(i), groups[i], 70, `K${i}`, `N${i}`, `L${i}`)]));
  assert.equal(evaluate('4-3-3', mixed).chemistry, 0);
  const wrong = { ...same, s0: card('x', 'FV', 70) };
  assert.equal(evaluate('4-3-3', wrong).per.s0, 0);
  assert.equal(FORMATIONS.length, 10);
  for (const f of FORMATIONS) assert.equal(slotsOf(f).length, 11);
});

test('kadro doğrulama: ad, sahiplik, mevki, aynı oyuncu, eksik', () => {
  const owned = new Map();
  const groups = ['KL', 'DEF', 'DEF', 'DEF', 'DEF', 'OS', 'OS', 'OS', 'FV', 'FV', 'FV'];
  groups.forEach((g, i) => owned.set(`c${i}`, card(`c${i}`, g, 60 + i)));
  const slots = Object.fromEntries(slotsOf('4-3-3').map((s, i) => [s.key, `c${i}`]));
  assert.equal(validateSquad({ name: 'Towtspor', formation: '4-3-3', slots }, owned).ok, true);
  assert.match(validateSquad({ name: 'T', formation: '4-3-3', slots }, owned).error, /2-30/);
  assert.match(validateSquad({ name: 'Takım', formation: '9-9-9', slots }, owned).error, /diziliş/);
  assert.match(validateSquad({ name: 'Takım', formation: '4-3-3', slots: { ...slots, s0: 'yok' } }, owned).error, /ait olmayan/);
  assert.match(validateSquad({ name: 'Takım', formation: '4-3-3', slots: { ...slots, s0: 'c9' } }, owned).error, /oynayamaz/);
  owned.set('dup', { ...owned.get('c1'), id: 'dup' });
  assert.match(validateSquad({ name: 'Takım', formation: '4-3-3', slots: { ...slots, s2: 'dup' } }, owned).error, /iki kez/);
  const { s10: _, ...missing } = slots;
  assert.match(validateSquad({ name: 'Takım', formation: '4-3-3', slots: missing }, owned).error, /1 eksik/);
});

test('otomatik kur: yuvaları doldurur; kimya önceliği kimyayı güç önceliğinden düşürmez', () => {
  const pool = syntheticPool();
  const cards = pool.all().slice(0, 60).map((p) => ({ ...p, pid: p.id }));
  const power = autoBuild(cards, '4-3-3', 'power');
  const chem = autoBuild(cards, '4-3-3', 'chem');
  assert.equal(Object.keys(power).length, 11);
  const ep = evaluate('4-3-3', power);
  const ec = evaluate('4-3-3', chem);
  assert.ok(ec.chemistry >= ep.chemistry);
  assert.ok(ep.rating >= ec.rating);
});

test('sorular: 4 farklı seçenek, doğru cevap seçeneklerde; sabit ve havuz soruları', () => {
  const pool = syntheticPool();
  const qs = buildQuestions(pool.all(), createRng(5), 15);
  assert.equal(qs.length, 15);
  for (const q of qs) {
    assert.equal(q.options.length, 4);
    assert.equal(new Set(q.options).size, 4, q.text);
    assert.ok(q.answer >= 0 && q.answer < 4);
  }
  assert.ok(qs.some((q) => q.kind === 'static'));
  assert.ok(qs.some((q) => q.kind !== 'static'));
  for (const [text, ...opts] of STATIC_QUESTIONS) assert.equal(new Set(opts).size, 4, text);
  assert.equal(buildQuestions([], createRng(1), 10).every((q) => q.kind === 'static'), true);
});

test('kapışma: güçlü takım çoğunlukla kazanır', () => {
  const groups = ['KL', 'DEF', 'DEF', 'DEF', 'DEF', 'OS', 'OS', 'OS', 'FV', 'FV', 'FV'];
  const team = (r) => ({ formation: '4-3-3', lineup: Object.fromEntries(slotsOf('4-3-3').map((s, i) => [s.key, card(`${r}${i}`, groups[i], r)])) });
  let wins = 0;
  const rng = createRng(3);
  for (let i = 0; i < 300; i++) if (simulateDuel(team(85), team(60), rng).result === 'W') wins++;
  assert.ok(wins > 200, `${wins}`);
  const one = simulateDuel(team(70), team(70), createRng(9));
  assert.equal(one.events.length, one.score[0] + one.score[1]);
});

test('durum: ilk açılışta başlangıç kredisi; bonus yolu günde bir adım, 28. adım büyük ödül', async () => {
  let now = NOW;
  const { s, store } = svc({ now: () => now });
  const st = await s.state({ uid: 'u1' });
  assert.equal(st.credits, START_CREDITS);
  assert.equal(st.bonus.nextStep, 1);
  assert.equal(st.missions.length, 5);
  await assert.rejects(s.state({ uid: 'g', guest: true }), /Google/);

  const r1 = await s.claimBonus({ uid: 'u1' });
  assert.equal(r1.reward, BONUS_PATH[0]);
  assert.equal(r1.balance, START_CREDITS + 100);
  await assert.rejects(s.claimBonus({ uid: 'u1' }), /zaten/);
  assert.equal((await s.state({ uid: 'u1' })).bonus.claimedToday, true);
  // Görev: bonus toplandı → 50 kredi
  const m = await s.claimMission({ uid: 'u1', id: 'bonus' });
  assert.equal(m.reward, 50);
  await assert.rejects(s.claimMission({ uid: 'u1', id: 'bonus' }), /aldın/);
  await assert.rejects(s.claimMission({ uid: 'u1', id: 'duel' }), /tamamlanmadı/);
  // 27 gün daha → 28. adım 10.000
  let last;
  for (let d = 1; d < 28; d++) {
    now += 86400e3;
    last = await s.claimBonus({ uid: 'u1' });
  }
  assert.equal(last.step, 28);
  assert.equal(last.reward, 10000);
  assert.equal(last.grandFinale, true);
  now += 86400e3;
  assert.equal((await s.state({ uid: 'u1' })).bonus.nextStep, 1, 'yol baştan');
  // Liderlik: kazanılanlar tabloda
  const lead = await s.leaders({ uid: 'u1', period: 'all' });
  assert.equal(lead.top[0].uid, 'u1');
  assert.equal(lead.me.rank, 1);
  assert.ok(store.boards.get('all').get('u1').earned >= 100 * 24 + 500 + 1000 + 2000 + 10000);
});

test('Fotoğraftan Bil: başlat, yanlış tahmin bulanıklığı azaltır, doğru tahmin ödül; günde bir kez', async () => {
  const { s, store, pool } = svc();
  const before = await s.photoState({ uid: 'u1' });
  assert.equal(before.started, false);
  assert.equal(before.photo, null, 'başlamadan fotoğraf yok');
  const st = await s.photoStart({ uid: 'u1' });
  assert.ok(st.photo);
  assert.equal(st.blur, 1);
  const answer = store.days.get('2026-10-28').photo.pid;
  const wrong = pool.all().find((p) => p.id !== answer);
  const g1 = await s.photoGuess({ uid: 'u1', playerId: wrong.id });
  assert.equal(g1.correct, false);
  assert.equal(g1.attemptsLeft, PHOTO.attempts - 1);
  assert.ok(g1.blur < 1);
  assert.equal(g1.answer, null, 'cevap bitmeden gösterilmez');
  const g2 = await s.photoGuess({ uid: 'u1', playerId: answer });
  assert.equal(g2.correct, true);
  assert.equal(g2.reward, PHOTO.firstReward - PHOTO.stepPenalty);
  assert.equal(g2.balance, START_CREDITS + 900);
  assert.equal(g2.answer.id, answer);
  await assert.rejects(s.photoGuess({ uid: 'u1', playerId: answer }), /hakkını kullandın/);
  assert.equal((await s.photoBoard({ uid: 'u1' })).entries.length, 1);
  // Arama sonucu fotoğraf içermez
  const found = await s.searchPlayers({ uid: 'u1', q: 'Oyuncu 1' });
  assert.ok(found.items.length > 0 && found.items.every((x) => !('ph' in x) && !('photo' in x)));
  // Herkes için aynı oyuncu
  const other = await s.photoStart({ uid: 'u2' });
  assert.equal(other.photo, st.photo);
});

test('bilgi yarışması: doğru cevapla devam, yanlışta biter ve doğru başına kredi; günlük 5 hak; süre aşımı', async () => {
  let now = NOW;
  const { s } = svc({ now: () => now });
  await s.state({ uid: 'u1' });
  const a = await s.quizStart({ uid: 'u1' });
  assert.equal(a.question.options.length, 4);
  const q = s._quiz.get(a.sessionId).questions;
  const r1 = await s.quizAnswer({ uid: 'u1', sessionId: a.sessionId, index: 0, choice: q[0].answer });
  assert.equal(r1.correct, true);
  assert.equal(r1.finished, false);
  const r2 = await s.quizAnswer({ uid: 'u1', sessionId: a.sessionId, index: 1, choice: q[1].answer });
  assert.equal(r2.score, 2);
  const r3 = await s.quizAnswer({ uid: 'u1', sessionId: a.sessionId, index: 2, choice: (q[2].answer + 1) % 4 });
  assert.equal(r3.finished, true);
  assert.equal(r3.reward, 2 * QUIZ.perCorrect);
  assert.equal(r3.balance, START_CREDITS + 100);
  await assert.rejects(s.quizAnswer({ uid: 'u1', sessionId: a.sessionId, index: 3, choice: 0 }), /bulunamadı/);
  // Süre aşımı: doğru seçenek de sayılmaz
  const b = await s.quizStart({ uid: 'u1' });
  now += (QUIZ.seconds + 5) * 1000;
  const late = await s.quizAnswer({ uid: 'u1', sessionId: b.sessionId, index: 0, choice: s._quiz.get(b.sessionId).questions[0].answer });
  assert.equal(late.correct, false);
  assert.equal(late.timeout, true);
  for (let i = 0; i < 3; i++) await s.quizStart({ uid: 'u1' });
  await assert.rejects(s.quizStart({ uid: 'u1' }), /hakların bitti/);
  // Başkası oturuma cevap veremez
  const { s: s2 } = svc();
  const c = await s2.quizStart({ uid: 'u1' });
  await assert.rejects(s2.quizAnswer({ uid: 'u2', sessionId: c.sessionId, index: 0, choice: 0 }), /bulunamadı/);
});

test('hoşgeldin paketi: bölgeden 18 oyuncu (2 KL, 6 DEF, 6 OS, 4 FV), bir kez', async () => {
  const { s, store } = svc();
  await s.state({ uid: 'u1' });
  const w = await s.welcomePack({ uid: 'u1', region: 'tur' });
  assert.equal(w.cards.length, 18);
  const count = (g) => w.cards.filter((c) => c.g === g).length;
  assert.deepEqual([count('KL'), count('DEF'), count('OS'), count('FV')], [2, 6, 6, 4]);
  assert.ok(w.cards.every((c) => c.l === 'tur.1' || c.na === 'Türkiye'));
  assert.ok(w.cards.filter((c) => c.r >= 75).length <= 3);
  await assert.rejects(s.welcomePack({ uid: 'u1', region: 'eng' }), /bir kez/);
  await assert.rejects(s.welcomePack({ uid: 'u2', region: 'xxx' }), /bölge/);
  assert.equal((await store.listCards('u1')).length, 18);
});

test('paketler: ücretsiz günlük paket bir kez, ücretli pakette kredi düşer, yetersiz kredi', async () => {
  const { s, store } = svc();
  await s.state({ uid: 'u1' });
  const free = await s.openPack({ uid: 'u1', pack: 'gunluk' });
  assert.equal(free.cards.length, PACKS.gunluk.count);
  assert.equal(free.balance, START_CREDITS);
  await assert.rejects(s.openPack({ uid: 'u1', pack: 'gunluk' }), /ücretsiz paketini açtın/);
  await assert.rejects(s.openPack({ uid: 'u1', pack: 'bronz' }), /Yetersiz/);
  await store.changeCredits('u1', 30000, { earn: false });
  const elite = await s.openPack({ uid: 'u1', pack: 'vsport' });
  assert.equal(elite.cards.length, 8);
  assert.ok(elite.cards.filter((c) => c.r >= 80).length >= 3);
  assert.equal(elite.balance, START_CREDITS + 30000 - 20000);
  // Kartlar puana göre sıralı (en iyisi sonda)
  assert.ok(elite.cards.every((c, i, a) => i === 0 || a[i - 1].r <= c.r));
  await assert.rejects(s.openPack({ uid: 'u1', pack: 'yok' }), /Geçersiz/);
});

async function squadReady(s, uid) {
  await s.state({ uid });
  const w = await s.welcomePack({ uid, region: 'tur' });
  const byG = (g) => w.cards.filter((c) => c.g === g).map((c) => c.id);
  const kl = byG('KL'), def = byG('DEF'), os = byG('OS'), fv = byG('FV');
  const ids = [kl[0], def[0], def[1], def[2], def[3], os[0], os[1], os[2], fv[0], fv[1], fv[2]];
  return { w, slots: Object.fromEntries(slotsOf('4-3-3').map((x, i) => [x.key, ids[i]])) };
}

test('kadro: kaydet (kimya ve güç sunucuda), en çok 3, satışta kadrodaki kart korunur; kapışma günde 3', async () => {
  const { s, store } = svc();
  const { w, slots } = await squadReady(s, 'u1');
  const sq = await s.saveSquad({ uid: 'u1', name: 'Towtspor', formation: '4-3-3', slots });
  assert.ok(sq.id);
  assert.ok(sq.rating > 0 && sq.chemistry >= 0);
  await assert.rejects(s.saveSquad({ uid: 'u1', name: 'X', formation: '4-3-3', slots }), /2-30/);
  await s.saveSquad({ uid: 'u1', name: 'İkinci', formation: '4-3-3', slots });
  await s.saveSquad({ uid: 'u1', name: 'Üçüncü', formation: '4-3-3', slots });
  await assert.rejects(s.saveSquad({ uid: 'u1', name: 'Dördüncü', formation: '4-3-3', slots }), /En fazla 3/);
  assert.ok(store.duelPool.has('u1'));

  await assert.rejects(s.sellCards({ uid: 'u1', ids: [slots.s0] }), /kadroda/);
  const bench = w.cards.find((c) => !Object.values(slots).includes(c.id));
  const sold = await s.sellCards({ uid: 'u1', ids: [bench.id] });
  assert.equal(sold.sold, 1);
  assert.ok(sold.credits >= 100);

  for (let i = 0; i < DUEL.daily; i++) {
    const d = await s.duel({ uid: 'u1', squadId: sq.id });
    assert.ok(['W', 'D', 'L'].includes(d.result));
    assert.ok([DUEL.win, DUEL.draw, DUEL.loss].includes(d.reward));
    assert.equal(d.opponent.bot, true, 'başka kullanıcı yoksa havuzdan rakip');
  }
  await assert.rejects(s.duel({ uid: 'u1', squadId: sq.id }), /hakların bitti/);
  assert.equal((await s.state({ uid: 'u1' })).duels.last.length, DUEL.daily);
  // İkinci kullanıcı ilk kullanıcının kadrosuyla eşleşebilir
  const { slots: slots2 } = await squadReady(s, 'u2');
  const sq2 = await s.saveSquad({ uid: 'u2', name: 'Rakipspor', formation: '4-3-3', slots: slots2 });
  const d2 = await s.duel({ uid: 'u2', squadId: sq2.id });
  assert.ok(typeof d2.opponent.bot === 'boolean');
  await s.deleteSquad({ uid: 'u1', id: sq.id });
});

test('kadro listesi: sunucudan kartlar ve kadrolar (Firestore okuması reddedilirse istemci bunu kullanır)', async () => {
  const { s } = svc();
  const { w, slots } = await squadReady(s, 'u1');
  const sq = await s.saveSquad({ uid: 'u1', name: 'Towtspor', formation: '4-3-3', slots });
  const col = await s.collection({ uid: 'u1' });
  assert.equal(col.cards.length, w.cards.length);
  assert.deepEqual(new Set(col.cards.map((c) => c.id)), new Set(w.cards.map((c) => c.id)));
  assert.ok(col.cards.every((c, i, a) => i === 0 || a[i - 1].r >= c.r), 'güce göre sıralı');
  assert.ok(col.cards.every((c) => !('at' in c)), 'zaman damgası gönderilmez');
  assert.equal(col.squads.length, 1);
  assert.equal(col.squads[0].id, sq.id);
  assert.deepEqual(col.squads[0].slots, sq.slots);
  assert.ok(!('updatedAt' in col.squads[0]));
  assert.equal((await s.collection({ uid: 'u2' })).cards.length, 0, 'başkasının kartı görünmez');
  await assert.rejects(s.collection({ uid: 'u1', guest: true }), /Google/);
  await assert.rejects(s.collection({ uid: null }), /Giriş/);
});

test('liderler: dönem, arama, sıram', async () => {
  const { s } = svc();
  await s.state({ uid: 'u1' });
  await s.state({ uid: 'u2' });
  await s.claimBonus({ uid: 'u1' });
  await s.claimBonus({ uid: 'u2' });
  await s.claimMission({ uid: 'u2', id: 'bonus' });
  const day = await s.leaders({ uid: 'u1', period: 'day' });
  assert.equal(day.top[0].uid, 'u2');
  assert.equal(day.me.rank, 2);
  const found = await s.leaders({ uid: 'u1', period: 'all', q: 'tost' });
  assert.equal(found.top[0].uid, 'u1');
  await assert.rejects(s.leaders({ uid: 'u1', period: 'year' }), /Geçersiz/);
});
