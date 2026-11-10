// Oynanış özellikleri: maç içi kritik anlar, stadyum (iç saha / deplasman), genetik sisi, gizli ikililer, canlı form,
// Sezon Yolu, menajer takvimi, özel haftalar, galibiyet serisi, küme ligi, albüm, takas, doğru tahmin ödülü,
// arkadaşa meydan okuma.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameService } from '../game/service.js';
import { slotsOf } from '../game/squad.js';
import { createRng } from '../engine/rng.js';
import { memoryGameStore, syntheticPool } from './game_fakes.js';
import { DIRS, LATE, momentInputs, resolvePenalty } from '../game/moments.js';
import { awayStadium, botStadiumLevel, homeAdvantage, homeFor } from '../game/venue.js';
import { FOG, maskedGenetics, revealOne, youthBits } from '../game/fog.js';
import { DUO, duoPower, findDuos, isDuo } from '../game/duos.js';
import { formOf, liveCard } from '../game/form.js';
import { CALENDAR, ROAD, THEMES, addRoadXp, calendarStep, packCost, roadReward, streakPct, themeOf, tierOf } from '../game/road.js';
import { DIVISIONS, RULES, settleWeek } from '../game/divisions.js';
import { albumPages, checkExchange, weeklyExchanges } from '../game/album.js';
import { PACKS } from '../game/economy.js';
import { PREDICTION } from '../game/progression.js';

const NOW = Date.UTC(2026, 10, 10, 9, 0);
const DAY = 86400e3;

function svc(clock = { t: NOW }, { pro = false } = {}) {
  const store = memoryGameStore({ users: { u1: { username: 'tostcu23' }, u2: { username: 'rakip99' } } });
  const pool = syntheticPool();
  let seed = 11;
  const s = new GameService({ store, pool, access: { entitlement: async () => ({ subscribed: pro }) }, now: () => clock.t, random: () => createRng(seed++), log: { warn() {} } });
  return { s, store, clock, pool };
}

async function ready(s, uid = 'u1', name = 'Kuzey Yıldızı') {
  await s.club.create({ uid, name, fans: 'Kuzeyliler', crest: { shape: 2, primary: 7, secondary: 4, symbol: 7, pattern: 1 } });
  const w = await s.welcomePack({ uid, region: 'tur' });
  const byG = (g) => w.cards.filter((c) => c.g === g).map((c) => c.id);
  const ids = [byG('KL')[0], ...byG('DEF').slice(0, 4), ...byG('OS').slice(0, 3), ...byG('FV').slice(0, 3)];
  const sq = await s.saveSquad({ uid, name: 'A Takımı', formation: '4-3-3', slots: Object.fromEntries(slotsOf('4-3-3').map((x, i) => [x.key, ids[i]])) });
  return { w, sq, ids };
}

const full = (store, uid = 'u1') => store.updateProfile(uid, { energy: { v: 200, at: NOW } });
const bytes = (pack) => Buffer.from(pack.positions, 'base64');
const scoreAt = (pack, t) => pack.scores.filter((x) => x.t <= t + 1e-9).at(-1) ?? { home: 0, away: 0 };
const ballAt = (pack, t) => {
  const f = Math.min(pack.frames - 1, Math.round(t * pack.fps));
  const b = bytes(pack);
  return [b.readUInt16LE(f * pack.valuesPerFrame * 2), b.readUInt16LE(f * pack.valuesPerFrame * 2 + 2)];
};
/** Durulan an ile devam edilen an aynı: top aynı yerde, skor aynı; zaman kaymadıysa önceki her kare birebir aynı. */
function assertSeamless(prev, next, label) {
  const cut = prev.moment.cut;
  const res = next.pack.resumeAt;
  assert.ok(Number.isFinite(res), `${label}: devam saniyesi`);
  const [x1, y1] = ballAt(prev.pack, cut);
  const [x2, y2] = ballAt(next.pack, res);
  assert.ok(Math.abs(x1 - x2) < 40 && Math.abs(y1 - y2) < 40, `${label}: top aynı yerde`);
  const s1 = scoreAt(prev.pack, cut);
  const s2 = scoreAt(next.pack, res);
  assert.deepEqual([s2.home, s2.away], [s1.home, s1.away], `${label}: skor aynı`);
  if (Math.abs(res - cut) < 1e-6) {
    const a = bytes(prev.pack);
    const fb = prev.pack.valuesPerFrame * 2;
    assert.ok(bytes(next.pack).subarray(0, a.length - fb).equals(a.subarray(0, a.length - fb)), `${label}: önceki bölüm birebir aynı`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Maç içi kritik anlar
// ---------------------------------------------------------------------------------------------------------------
test('kritik anlar: maç ikinci yarıda durur, seçimle sürer; izlenen bölüm birebir aynı kalır', async () => {
  const { s, store } = svc();
  const { sq } = await ready(s);
  await full(store);
  const st = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli' });
  const r = await s.duelFinish({ uid: 'u1', duelId: st.duelId, tactic: 'hucum', moments: true });
  assert.equal(r.paused, true);
  assert.ok(r.moment.options.length >= 3);
  assert.ok(r.pack.partial);
  assert.deepEqual(r.tactics.me, ['dengeli', 'hucum'], 'devre arası taktiği saklanır');
  // Bağlantı koparsa aynı an yeniden gösterilir
  const again = await s.duelFinish({ uid: 'u1', duelId: st.duelId, moments: true });
  assert.equal(again.moment.id, r.moment.id);
  assert.equal(again.pack.positions, r.pack.positions);
  await assert.rejects(s.duelMoment({ uid: 'u1', duelId: st.duelId, choice: 'yanlis' }), /Geçersiz/);
  let cur = r;
  let fin = null;
  for (let i = 0; i < 4 && cur.paused; i++) {
    const choice = cur.moment.type === 'late' ? 'yuklen' : 'sol';
    const next = await s.duelMoment({ uid: 'u1', duelId: st.duelId, choice });
    assert.equal(next.answered.id, cur.moment.id);
    // Oyuncu izlediği maçın değiştiğini görmez: durduğu yerden aynı sahneyle devam eder
    assertSeamless(cur, next, cur.moment.id);
    cur = next;
    if (!next.paused) fin = next;
  }
  assert.ok(fin, 'maç bitti');
  assert.ok(['W', 'D', 'L'].includes(fin.result));
  assert.ok(fin.moments.some((m) => m.id === 'late'), 'son 20 dakika kararı kayıtlı');
  const p = await store.getProfile('u1');
  assert.equal(p.pendingDuel, null);
  await assert.rejects(s.duelMoment({ uid: 'u1', duelId: st.duelId, choice: 'sol' }), /bitmiş/);
});

test('kritik anlar: penaltı yönü sonucu belirler; kalecinin yönüyle aynıysa çoğunlukla kurtarılır', () => {
  let same = 0;
  let saved = 0;
  let diff = 0;
  let goals = 0;
  for (let i = 0; i < 400; i++) {
    for (const choice of DIRS) {
      const r = resolvePenalty({ seed: `s${i}`, n: 0, type: 'pen_for', choice });
      assert.equal(r.dir, choice);
      if (r.keeper === choice) (same++, r.outcome === 'saved' && saved++);
      else (diff++, r.outcome === 'goal' && goals++);
    }
  }
  assert.ok(saved / same > 0.7, 'aynı köşe: kaleci kurtarır');
  assert.ok(goals / diff > 0.88, 'farklı köşe: gol');
  // Aleyhimize penaltı: seçim kalecinin atladığı yön
  const a = resolvePenalty({ seed: 'x', n: 0, type: 'pen_against', choice: 'sag' });
  assert.equal(a.keeper, 'sag');
  // Seçimler motora: penaltı sonucu/yönü ve son dakikalar taktiği
  const mi = momentInputs({ choices: { pen0: { outcome: 'goal', dir: 'sol' }, late: { id: 'savun', from: 72 } } }, 'hucum');
  assert.deepEqual(mi.penaltyOutcome, { 0: 'goal' });
  assert.deepEqual(mi.penaltyDir, { 0: 'sol' });
  assert.deepEqual(mi.phase3, { fromMinute: 72, me: LATE.savun.tactic, opp: 'hucum' });
});

test('kritik anlar: ikinci yarı penaltısında maç atıştan hemen önce durur; seçilen sonuç sahaya yansır', async () => {
  const { s, store } = svc();
  const { sq } = await ready(s);
  let found = null;
  for (let i = 0; i < 60 && !found; i++) {
    await full(store);
    const st = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'hucum' });
    const r = await s.duelFinish({ uid: 'u1', duelId: st.duelId, tactic: 'hucum', moments: true });
    if (r.paused && r.moment.type !== 'late') found = { st, r };
    else await s.duelFinish({ uid: 'u1', duelId: st.duelId });
  }
  assert.ok(found, 'ikinci yarı penaltısı bulunmalı');
  const { st, r } = found;
  assert.match(r.moment.title, /Penaltı|penaltı/);
  assert.deepEqual(r.moment.options.map((o) => o.id), DIRS);
  const next = await s.duelMoment({ uid: 'u1', duelId: st.duelId, choice: 'orta' });
  assert.ok(['goal', 'saved', 'missed'].includes(next.answered.outcome));
  assertSeamless(r, next, 'penaltı');
  const side = r.moment.type === 'pen_for' ? 'home' : 'away';
  const before = r.pack.finalScore[side];
  const res = next.pack.resumeAt;
  const after = next.pack.scores.filter((x) => x.t > res && x.t < res + 8);
  if (next.answered.outcome === 'goal') assert.ok(after.some((x) => x[side] === before + 1), 'gol skora yazılır');
  else assert.ok(!after.some((x) => x[side] > before), 'kaçan penaltı skoru değiştirmez');
});

// ---------------------------------------------------------------------------------------------------------------
// Stadyum: ev sahibi / deplasman
// ---------------------------------------------------------------------------------------------------------------
test('stadyum: saha avantajı seviye ve dolulukla artar; kurgusal takımın stadyumu gücüyle', () => {
  assert.equal(homeAdvantage(1, 0), 1.02);
  assert.equal(homeAdvantage(10, 1), 1.09);
  assert.ok(homeAdvantage(6, 0.9) > homeAdvantage(3, 0.9));
  assert.equal(botStadiumLevel(50), 1);
  assert.equal(botStadiumLevel(95), 10);
  const st = awayStadium({ name: 'Mavi Şimşek', crest: null }, 80, 'x');
  assert.equal(st.host, 'opp');
  assert.equal(st.name, 'Mavi Şimşek Arena');
  assert.ok(st.fill >= 0.55 && st.fill <= 0.95);
  const homes = Array.from({ length: 400 }, (_, i) => homeFor(`s${i}`)).filter(Boolean).length;
  assert.ok(homes > 180 && homes < 260, 'normal maçların yarısından biraz fazlası iç sahada');
});

test('stadyum: iç sahada kulübün stadyumu, deplasmanda rakibinki; maç önceki ekranla aynı sahada oynanır', async () => {
  const { s, store } = svc();
  const { sq } = await ready(s);
  await full(store);
  const n = await s.duelNext({ uid: 'u1' });
  assert.equal(typeof n.home, 'boolean');
  if (n.home) {
    assert.equal(n.stadium.host, 'me');
    assert.equal(n.stadium.name, 'Kuzey Yıldızı Stadyumu');
    assert.ok(n.stadium.capacity > 0);
  } else assert.equal(n.stadium.host, 'opp');
  const st = await s.duelStart({ uid: 'u1', squadId: sq.id });
  assert.deepEqual(st.stadium, n.stadium);
  const fin = await s.duelFinish({ uid: 'u1', duelId: st.duelId });
  assert.equal(fin.home, n.home);
  assert.deepEqual(fin.stadium, n.stadium);
  // Günün Meydan Okuması deplasmanda: rakibin dev stadyumu, stadyum geliri yok
  await full(store);
  const boss = await s.duelStart({ uid: 'u1', squadId: sq.id, mode: 'boss' });
  assert.equal(boss.home, false);
  assert.equal(boss.stadium.name, 'Yıldızlar Arenası');
  assert.equal(boss.stadium.level, 10);
  const bf = await s.duelFinish({ uid: 'u1', duelId: boss.duelId });
  assert.equal(bf.bonuses.stadium, 0, 'deplasmanda stadyum geliri yok');
});

// ---------------------------------------------------------------------------------------------------------------
// Genetik sisi
// ---------------------------------------------------------------------------------------------------------------
test('genetik sisi: açılmamış parçalar gizli; tek tek açılır; gözlemci raporu hepsini açar', async () => {
  const card = { id: 'k1', pid: 'p77', g: 'OS', r: 70, a: 22 };
  const m0 = maskedGenetics(card, 0);
  assert.deepEqual([m0.growth, m0.body, m0.peak, m0.traits, m0.grade], [null, null, null, null, null]);
  const rng = createRng('fog');
  let c = { ...card, gx: 0 };
  const parts = new Set();
  for (let i = 0; i < 4; i++) {
    const r = revealOne(c, rng);
    parts.add(r.part);
    c = { ...c, gx: r.gx };
  }
  assert.equal(parts.size, 4);
  assert.equal(c.gx, FOG.all);
  assert.equal(revealOne(c, rng), null, 'hepsi açık');
  assert.ok(maskedGenetics(c).grade, 'not ancak hepsi açılınca');
  assert.equal(youthBits(1), 1);
  assert.equal(youthBits(10), 15);

  const { s, store } = svc();
  const { ids } = await ready(s);
  await store.updateProfile('u1', { credits: 1000 });
  const r = await s.geneScout({ uid: 'u1', cardId: ids[0] });
  assert.equal(r.cost, FOG.scoutCost);
  assert.equal(r.balance, 1000 - FOG.scoutCost);
  assert.equal(r.genetics.gx, FOG.all);
  await assert.rejects(s.geneScout({ uid: 'u1', cardId: ids[0] }), /zaten açık/);
  await store.updateProfile('u1', { credits: 10 });
  await assert.rejects(s.geneScout({ uid: 'u1', cardId: ids[1] }), /Yetersiz/);
});

// ---------------------------------------------------------------------------------------------------------------
// Gizli ikililer ve canlı form
// ---------------------------------------------------------------------------------------------------------------
test('gizli ikililer: uyum oyuncu kimliğinden sabit; yan mevkiler; en çok üç ikili', () => {
  let a = null;
  let b = null;
  for (let i = 0; i < 2000 && !b; i++) {
    for (let j = i + 1; j < i + 60; j++) {
      if (isDuo(`p${i}`, `p${j}`)) {
        a = `p${i}`;
        b = `p${j}`;
        break;
      }
    }
  }
  assert.ok(b);
  assert.equal(isDuo(a, b), isDuo(b, a));
  const lineup = { os1: { pid: a, g: 'OS', s: 'Ali' }, fv1: { pid: b, g: 'FV', s: 'Can' } };
  assert.equal(findDuos(lineup).length, 1);
  assert.equal(findDuos({ kl: { pid: a, g: 'KL' }, fv1: { pid: b, g: 'FV' } }).length, 0, 'kaleci ile forvet yan yana oynamaz');
  assert.equal(duoPower([1, 2, 3, 4, 5]), Math.round(DUO.max * DUO.power * 10) / 10);
});

test('canlı form: gerçek maçlardaki gol, asist ve maç artışı karta yansır', () => {
  assert.equal(formOf(null, { sg: 5 }), 0);
  assert.equal(formOf({ sg: 3, sa: 1, sp: 10 }, { sg: 3, sa: 1, sp: 10 }), 0);
  assert.equal(formOf({ sg: 3, sa: 1, sp: 10 }, { sg: 5, sa: 1, sp: 11 }), 3, 'iki gol: alev alev');
  assert.equal(formOf({ sg: 0, sa: 0, sp: 10 }, { sg: 0, sa: 0, sp: 11 }, 'DEF'), 1, 'savunmada maç oynamak da form');
  const pool = { byId: (id) => (id === 'p1' ? { fm: 2 } : null) };
  const c = liveCard({ id: 'c1', pid: 'p1', r: 80 }, pool);
  assert.equal(c.r, 82);
  assert.equal(c.form, 2);
  assert.equal(liveCard({ id: 'c2', pid: 'p2', r: 80 }, pool).r, 80);
});

// ---------------------------------------------------------------------------------------------------------------
// Sezon Yolu, takvim, özel haftalar, galibiyet serisi
// ---------------------------------------------------------------------------------------------------------------
test('Sezon Yolu: XP kademe atlatır; ücretsiz ve PRO yol ödülleri; kademe atlayınca enerji', async () => {
  const a = addRoadXp(null, 650, NOW);
  assert.equal(a.tiersUp, 2);
  assert.equal(tierOf(a.road.xp), 2);
  assert.equal(addRoadXp(a.road, 10, NOW + 40 * DAY).road.xp, 10, 'yeni sezonda sıfırdan');
  assert.equal(roadReward(ROAD.tiers, 'free').type, 'token');
  for (let t = 1; t <= ROAD.tiers; t++) for (const tr of ['free', 'pro']) assert.ok(['credits', 'energy', 'token'].includes(roadReward(t, tr).type));

  const { s, store } = svc();
  await ready(s);
  await store.updateProfile('u1', { energy: { v: 50, at: NOW } });
  const xp = await s.progress.xp('u1', ROAD.xpPerTier + 5);
  assert.equal(xp.tiersUp, 1);
  assert.equal(xp.energy, ROAD.levelEnergy);
  assert.equal((await store.getProfile('u1')).energy.v, 50 + ROAD.levelEnergy);
  await assert.rejects(s.progress.roadClaim({ uid: 'u1', tier: 2 }), /2\. kademeye/);
  await assert.rejects(s.progress.roadClaim({ uid: 'u1', tier: 1, track: 'pro' }), /PRO/);
  const c = await s.progress.roadClaim({ uid: 'u1', tier: 1 });
  assert.equal(c.reward.type, roadReward(1, 'free').type);
  assert.equal(c.road.rows[0].freeClaimed, true);
  await assert.rejects(s.progress.roadClaim({ uid: 'u1', tier: 1 }), /aldın/);

  const pro = svc(undefined, { pro: true });
  await ready(pro.s);
  await pro.s.progress.xp('u1', ROAD.xpPerTier);
  const pc = await pro.s.progress.roadClaim({ uid: 'u1', tier: 1, track: 'pro' });
  assert.equal(pc.reward.type, roadReward(1, 'pro').type);
});

test('menajer takvimi: her gün bir ödül; gün kaçarsa baştan; 7. gün sürpriz', async () => {
  assert.deepEqual(calendarStep(null, 'd2', 'd1'), { step: 1, claimed: false });
  assert.deepEqual(calendarStep({ step: 3, lastDay: 'd1' }, 'd2', 'd1'), { step: 4, claimed: false });
  assert.deepEqual(calendarStep({ step: 3, lastDay: 'd0' }, 'd2', 'd1'), { step: 1, claimed: false });
  assert.deepEqual(calendarStep({ step: 7, lastDay: 'd1' }, 'd2', 'd1'), { step: 1, claimed: false }, 'hafta bitince yeniden');
  const clock = { t: NOW };
  const { s, store } = svc(clock);
  await ready(s);
  const before = Number((await store.getProfile('u1')).credits ?? 0);
  const d1 = await s.progress.calendarClaim({ uid: 'u1' });
  assert.equal(d1.step, 1);
  assert.equal(d1.reward.balance, before + CALENDAR[0].amount);
  assert.equal(d1.xp.gained, ROAD.xp.login);
  await assert.rejects(s.progress.calendarClaim({ uid: 'u1' }), /aldın/);
  clock.t += DAY;
  const d2 = await s.progress.calendarClaim({ uid: 'u1' });
  assert.equal(d2.step, 2);
  assert.equal(d2.reward.type, 'energy');
  clock.t += 2 * DAY;
  assert.equal((await s.progress.calendarClaim({ uid: 'u1' })).step, 1, 'bir gün kaçtı');
});

test('özel haftalar: her hafta değişir; paket indirimi; antrenman ve satış yüzdeleri', () => {
  const seen = new Set();
  for (let w = 0; w < THEMES.length; w++) seen.add(themeOf(NOW + w * 7 * DAY).id);
  assert.equal(seen.size, THEMES.length);
  const genc = THEMES.find((t) => t.id === 'genc');
  assert.equal(packCost(PACKS.genc, genc), Math.round((PACKS.genc.cost * 0.8) / 10) * 10);
  assert.equal(packCost(PACKS.bronz, genc), PACKS.bronz.cost);
});

test('galibiyet serisi: her galibiyet ödülü %10 artırır (en çok %50); 3. galibiyette enerji hediyesi', async () => {
  assert.deepEqual([1, 2, 3, 6, 12].map(streakPct), [0, 10, 20, 50, 50]);
  const { s, store } = svc();
  const { sq } = await ready(s);
  let win = null;
  for (let i = 0; i < 25 && !win; i++) {
    await store.updateProfile('u1', { winStreak: { n: 2, best: 4 }, energy: { v: 100, at: NOW } });
    const st = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'hucum' });
    const f = await s.duelFinish({ uid: 'u1', duelId: st.duelId });
    if (f.result === 'W') win = f;
    else {
      assert.equal(f.streak.count, 0, 'galibiyet gelmezse seri biter');
      assert.equal(f.streak.best, 4);
    }
  }
  assert.ok(win, 'bir galibiyet');
  assert.equal(win.streak.count, 3);
  assert.equal(win.streak.pct, 20);
  assert.equal(win.streak.gift.type, 'energy');
  assert.ok(win.bonuses.streak > 0);
  assert.ok(win.xp.gained >= ROAD.xp.match + ROAD.xp.win);
});

// ---------------------------------------------------------------------------------------------------------------
// Küme ligi
// ---------------------------------------------------------------------------------------------------------------
test('küme ligi: ilk üç çıkar, son üç düşer; az maçla çıkılmaz; en alt kümeden düşülmez', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ uid: `u${i}`, points: 30 - i * 3, played: 5, gf: 10, ga: 5 }));
  assert.deepEqual(settleWeek(rows, 'u0', 4), { rank: 1, size: 10, move: 1, reward: DIVISIONS[3].prize[0] + DIVISIONS[3].base, div: 3 });
  assert.equal(settleWeek(rows, 'u9', 4).div, 5);
  assert.equal(settleWeek(rows, 'u5', 4).move, 0);
  assert.equal(settleWeek(rows, 'u9', 5).move, 0, 'Çaylak Ligi en alt küme');
  assert.equal(settleWeek(rows, 'u0', 1).move, 0, 'Elit Lig en üst');
  const few = rows.map((r) => ({ ...r, played: RULES.minPlayed - 1 }));
  assert.equal(settleWeek(few, 'u0', 4).move, 0);
  assert.equal(settleWeek(rows.slice(0, 5), 'u4', 3).move, 0, 'kalabalık olmayan kümede düşme yok');
});

test('küme ligi: yeni haftada geçen hafta sonuçlanır (yükselme ve ödül); tablo yalnızca kendi kümen', async () => {
  const clock = { t: NOW };
  const { s, store } = svc(clock);
  await ready(s);
  const prev = s._week(NOW - 7 * DAY);
  await store.updateProfile('u1', { league: { div: 4, week: prev } });
  await store.addDuelBoard(prev, 'u1', { points: 12, played: 4, w: 4, d: 0, l: 0, gf: 9, ga: 2 }, { username: 'tostcu23', div: 4 });
  for (let i = 0; i < 6; i++) await store.addDuelBoard(prev, `x${i}`, { points: i, played: 3, w: 0, d: i, l: 3 - i, gf: 1, ga: 4 }, { username: `x${i}`, div: 4 });
  await store.addDuelBoard(prev, 'y1', { points: 99, played: 9, w: 9, d: 0, l: 0, gf: 30, ga: 1 }, { username: 'y1', div: 2 });
  const credits = Number((await store.getProfile('u1')).credits ?? 0);
  const b = await s.duelBoard({ uid: 'u1' });
  assert.equal(b.division.div, 3, 'Bronz Lig birincisi Gümüş Lig\'e çıktı');
  assert.equal(b.division.last.move, 1);
  assert.equal(b.division.last.rank, 1, 'başka kümedeki y1 sıralamayı etkilemez');
  assert.equal(Number((await store.getProfile('u1')).credits), credits + b.division.last.reward);
  // Bu haftanın tablosu: yalnız Gümüş Lig
  const week = s._week(NOW);
  await store.addDuelBoard(week, 'z1', { points: 3, played: 1, w: 1, d: 0, l: 0, gf: 2, ga: 0 }, { username: 'z1', div: 3 });
  await store.addDuelBoard(week, 'z2', { points: 3, played: 1, w: 1, d: 0, l: 0, gf: 2, ga: 0 }, { username: 'z2', div: 5 });
  const b2 = await s.duelBoard({ uid: 'u1' });
  assert.deepEqual(b2.top.map((r) => r.uid), ['z1']);
  // İkinci çağrı haftayı yeniden sonuçlandırmaz
  assert.equal(Number((await store.getProfile('u1')).credits), credits + b.division.last.reward);
});

// ---------------------------------------------------------------------------------------------------------------
// Albüm, takas, doğru tahmin, arkadaşa meydan okuma
// ---------------------------------------------------------------------------------------------------------------
test('albüm: kulüp sayfasında farklı oyuncu sayısı kademeye ulaşınca ödül (sırayla, bir kez)', async () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, ci: '10', c: 'Mavi Şimşek', na: 'Türkiye' }));
  const cards = players.slice(0, 7).map((p) => ({ id: `c${p.id}`, pid: p.id }));
  const [pg] = albumPages('club', players, [...cards, { id: 'dup', pid: 'p0' }]);
  assert.equal(pg.owned, 7, 'aynı oyuncunun ikinci kartı sayılmaz');
  assert.deepEqual(pg.tiers.map((t) => t.done), [true, true, false]);

  const { s, store } = svc();
  await ready(s);
  const a = await s.progress.album({ uid: 'u1', kind: 'club' });
  assert.ok(a.pages.length > 0);
  const page = a.pages[0];
  if (page.tiers[0]?.done) {
    await assert.rejects(s.progress.albumClaim({ uid: 'u1', kind: 'club', key: page.key, tier: 2 }), /önceki|topla/);
    const c = await s.progress.albumClaim({ uid: 'u1', kind: 'club', key: page.key, tier: 1 });
    assert.equal(c.tier, 1);
    await assert.rejects(s.progress.albumClaim({ uid: 'u1', kind: 'club', key: page.key, tier: 1 }), /aldın/);
    const p = await store.getProfile('u1');
    assert.equal(Object.keys(p.album).length, 1);
  }
});

test('takas görevleri: haftada 4 görev; şartı sağlayan kartlar verilir; kadrodaki kart verilemez', async () => {
  const w = weeklyExchanges('w2026-46');
  assert.equal(w.length, 4);
  assert.equal(new Set(w.map((e) => e.id)).size, 4);
  assert.deepEqual(weeklyExchanges('w2026-46'), w, 'hafta içinde sabit');
  const ex = { need: { count: 3, sameClub: true } };
  assert.equal(checkExchange(ex, [{ ci: '1' }, { ci: '1' }, { ci: '1' }]), null);
  assert.match(checkExchange(ex, [{ ci: '1' }, { ci: '2' }, { ci: '1' }]), /aynı kulüpten/);
  assert.match(checkExchange(ex, [{ ci: '1' }]), /tam 3/);

  const { s } = svc();
  const { ids } = await ready(s);
  const list = s.progress.exchangesView({}).list;
  await assert.rejects(s.progress.exchangeSubmit({ uid: 'u1', id: list[0].id, cards: [ids[0]] }), /kadroda/);
  await assert.rejects(s.progress.exchangeSubmit({ uid: 'u1', id: 'yok', cards: [] }), /böyle bir takas/);
});

test('doğru tahmin: puan başına kredi, günde en çok sınır; oyuna girmemiş kullanıcıya profil açılmaz', async () => {
  const { s, store } = svc();
  await ready(s);
  const before = Number((await store.getProfile('u1')).credits ?? 0);
  const r = await s.progress.predictionReward({ uid: 'u1', points: 5, exact: true });
  assert.equal(r.amount, 5 * PREDICTION.perPoint);
  assert.equal(r.balance, before + r.amount);
  let total = r.amount;
  for (let i = 0; i < 10; i++) total += (await s.progress.predictionReward({ uid: 'u1', points: 5 }))?.amount ?? 0;
  assert.equal(total, PREDICTION.cap);
  assert.equal(await s.progress.predictionReward({ uid: 'yok', points: 5 }), null);
  assert.equal(await store.getProfile('yok'), null);
});

test('arkadaşa meydan okuma: kullanıcı adıyla; arkadaşın stadyumunda dostluk maçı; lige yazılmaz, sonuç arkadaşa gider', async () => {
  const { s, store } = svc();
  const { sq } = await ready(s);
  await ready(s, 'u2', 'Mavi Şimşek');
  await full(store);
  await assert.rejects(s.duelNext({ uid: 'u1', mode: 'friend', friend: 'kimseyok' }), /bulunamadı/);
  await assert.rejects(s.duelNext({ uid: 'u1', mode: 'friend', friend: 'tostcu23' }), /Kendine/);
  const n = await s.duelNext({ uid: 'u1', mode: 'friend', friend: '@rakip99' });
  assert.equal(n.opponent.name, 'Mavi Şimşek');
  assert.equal(n.home, false);
  assert.equal(n.stadium.name, 'Mavi Şimşek Stadyumu', 'arkadaşın kendi stadyumu');
  const st = await s.duelStart({ uid: 'u1', squadId: sq.id, mode: 'friend', friend: 'rakip99' });
  const fin = await s.duelFinish({ uid: 'u1', duelId: st.duelId });
  assert.equal(fin.friendly, true);
  assert.equal(fin.week.gained, 0);
  assert.equal(await store.duelBoardEntry(s._week(NOW), 'u1'), null, 'lige yazılmaz');
  const u2 = await store.getProfile('u2');
  assert.equal(u2.challenges.length, 1);
  assert.equal(u2.challenges[0].from, 'tostcu23');
  assert.deepEqual(u2.challenges[0].score, [fin.score[1], fin.score[0]]);
});

test('oyun durumu: Sezon Yolu, takvim, tema, küme, seri, jetonlar ve takaslar', async () => {
  const { s } = svc();
  await ready(s);
  const st = await s.state({ uid: 'u1' });
  for (const k of ['road', 'calendar', 'theme', 'league', 'winStreak', 'tokens', 'exchanges']) assert.ok(st[k] != null, k);
  assert.equal(st.league.div, 5, 'herkes Çaylak Ligi\'nde başlar');
  assert.equal(st.road.rows.length, ROAD.tiers);
  assert.equal(st.calendar.days.length, CALENDAR.length);
});

test('sakatlık: vücuttaki yeri, tarafı ve dakikası (sakatlık animasyonu ve rapor için)', async () => {
  const { matchEvents, INJURY_PARTS, PART_LABELS } = await import('../game/office.js');
  const lineup = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`s${i}`, { id: `c${i}`, pid: `p${i}`, g: i === 0 ? 'KL' : 'OS', s: `Oyuncu ${i}`, r: 70, a: 25 }]));
  let n = 0;
  for (let i = 0; i < 300; i++) {
    const ev = matchEvents({ seed: `m${i}`, lineup });
    for (const inj of ev.injuries) {
      n++;
      assert.ok(INJURY_PARTS.includes(inj.part));
      assert.ok(PART_LABELS[inj.part]);
      assert.ok(['sol', 'sag'].includes(inj.side));
      assert.ok(inj.minute >= 12 && inj.minute <= 85);
    }
  }
  assert.ok(n > 10, 'sakatlıklar oluşur');
});
