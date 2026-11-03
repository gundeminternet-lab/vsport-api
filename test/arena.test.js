// Kapışma (stadyumda maç), Günün Meydan Okuması, haftalık lig, giriş serisi ve görev sandığı.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameService } from '../game/service.js';
import { slotsOf, FORMATIONS } from '../game/squad.js';
import { animFormation, duelLambdas, adaptTactic, playDuel, packOf, TACTIC_EDGE } from '../game/match.js';
import { BOSS, DUEL, MISSION_CHEST, MISSIONS } from '../game/economy.js';
import { createRng } from '../engine/rng.js';
import { memoryGameStore, syntheticPool } from './game_fakes.js';

const NOW = Date.UTC(2026, 9, 28, 9, 0);

function svc({ now = () => NOW } = {}) {
  const store = memoryGameStore({ users: { u1: { username: 'tostcu23', photoURL: null }, u2: { username: 'rakip', photoURL: null } } });
  const pool = syntheticPool();
  let seed = 1;
  const s = new GameService({ store, pool, access: { entitlement: async () => ({ subscribed: false }) }, now, random: () => createRng(seed++), log: { warn() {} } });
  return { s, store, pool };
}

async function squadReady(s, uid) {
  await s.state({ uid });
  await s.club.create({ uid, name: `${uid} Spor`, fans: 'Tribün Aslanları', crest: { shape: 0, primary: 0, secondary: 1, symbol: 0, pattern: 0 } }).catch(() => {});
  const w = await s.welcomePack({ uid, region: 'tur' });
  const byG = (g) => w.cards.filter((c) => c.g === g).map((c) => c.id);
  const kl = byG('KL'), def = byG('DEF'), os = byG('OS'), fv = byG('FV');
  const ids = [kl[0], def[0], def[1], def[2], def[3], os[0], os[1], os[2], fv[0], fv[1], fv[2]];
  const slots = Object.fromEntries(slotsOf('4-3-3').map((x, i) => [x.key, ids[i]]));
  const sq = await s.saveSquad({ uid, name: 'Towtspor', formation: '4-3-3', slots });
  return { w, sq };
}

const team = (pref, formation, r) => ({
  name: `${pref}spor`,
  formation,
  power: r,
  lineup: Object.fromEntries(slotsOf(formation).map((s, i) => [s.key, { s: `${pref}${i}`, g: s.g, r }])),
});

test('diziliş: bütün Benim 11\'im dizilişleri 11 oyuncu, mevki rolleri ve tekil forma numarasıyla animasyona eşlenir', () => {
  const role = { KL: 'GK', DEF: 'DF', OS: 'MF', FV: 'FW' };
  for (const f of FORMATIONS) {
    const a = animFormation(f);
    assert.equal(a.slots.length, 11, f);
    assert.equal(new Set(a.slots.map((s) => s.num)).size, 11, `${f} numaralar tekil`);
    slotsOf(f).forEach((s, i) => assert.equal(a.slots[i].role, role[s.g], `${f} ${s.pos}`));
    for (const s of a.slots) assert.ok(s.xa > 0 && s.xa < 0.8 && s.ya > 0 && s.ya < 1);
  }
});

test('taktik: üstün taktik gol beklentisini artırır; rakip devre arasında skora göre plan değiştirir', () => {
  const base = duelLambdas(75, 75, 'dengeli', 'dengeli');
  assert.ok(Math.abs(base.home - base.away) < 1e-9);
  const k = duelLambdas(75, 75, 'kontra', 'hucum');
  const k0 = duelLambdas(75, 75, 'dengeli', 'hucum');
  assert.ok(k.home > k0.home * 0.95 * TACTIC_EDGE * 0.99, 'kontra hücuma karşı üstün');
  assert.ok(duelLambdas(75, 75, 'savunma', 'dengeli').away < base.away, 'savunma rakibin gol beklentisini düşürür');
  assert.equal(adaptTactic('dengeli', 0, 1), 'hucum');
  assert.equal(adaptTactic('dengeli', 1, 0), 'kontra');
  assert.equal(adaptTactic('hucum', 2, 0), 'savunma');
  assert.equal(adaptTactic('kontra', 1, 1), 'kontra');
});

test('maç: aynı tohum aynı maç; ikinci yarı taktiği ilk yarıyı değiştirmez; golleri atan oyuncular adlarıyla', () => {
  const me = team('A', '4-2-3-1', 76);
  const opp = team('B', '3-5-2', 75);
  const a = playDuel({ me, opp, seed: 't1', tactics: { me1: 'hucum', opp1: 'dengeli' } });
  const a2 = playDuel({ me, opp, seed: 't1', tactics: { me1: 'hucum', opp1: 'dengeli' } });
  assert.deepEqual(a.timeline.score, a2.timeline.score);
  assert.deepEqual(a.goals, a2.goals);
  for (let k = 0; k < 25; k++) {
    const x = playDuel({ me, opp, seed: `s${k}`, tactics: { me1: 'dengeli', opp1: 'dengeli' } });
    const y = playDuel({ me, opp, seed: `s${k}`, tactics: { me1: 'dengeli', opp1: 'dengeli', me2: 'hucum', opp2: 'savunma' } });
    assert.deepEqual(x.timeline.halftimeScore, y.timeline.halftimeScore, 'devre skoru aynı');
    const fh = (m) => m.timeline.events.filter((e) => e.clock < m.timeline.firstHalfClock).map((e) => `${e.type}:${e.side}:${e.minute}`);
    assert.deepEqual(fh(x), fh(y), 'ilk yarı olayları aynı');
    for (const g of y.goals) assert.ok(g.name && /^[AB]\d+$/.test(g.name), `gol atan: ${g.name}`);
    assert.equal(y.goals.length, y.timeline.score.home + y.timeline.score.away);
    assert.ok(y.motm && y.motm.rating >= 4 && y.motm.rating <= 10);
    assert.equal(y.ratings.home.length, 11);
  }
});

test('paket: ilk yarı paketi devre arasında biter, tam paket ikinci yarıyı devre arası sonundan oynatır', () => {
  const m = playDuel({ me: team('A', '4-4-2', 74), opp: team('B', '4-3-3', 74), seed: 'p1', tactics: { me1: 'dengeli', opp1: 'kontra' } });
  const first = packOf(m, { firstHalf: true });
  const full = packOf(m);
  assert.equal(first.partial, true);
  assert.ok(first.duration < full.duration / 2 + 2 && first.duration > full.duration / 2 - 6);
  assert.equal(first.frames, Math.round(first.duration * first.fps) + 1);
  assert.equal(Buffer.from(first.positions, 'base64').length, first.frames * first.valuesPerFrame * 2);
  assert.ok(first.feed.every((f) => f.t <= first.duration + 1e-9));
  assert.deepEqual(first.finalScore, m.timeline.halftimeScore);
  assert.ok(full.resumeAt > first.duration - 0.5);
  assert.equal(full.roles.home.length, 11);
  for (const b of full.banners.filter((x) => x.type === 'goal')) assert.ok(b.player, 'gol bandında oyuncu adı');
});

test('kapışma: başlat → ilk yarı, devre arasında taktik → ikinci yarı ve ödül; aynı kapışma iki kez bitmez', async () => {
  const { s, store } = svc();
  const { sq } = await squadReady(s, 'u1');
  const st0 = await s.state({ uid: 'u1' });
  const start = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'hucum', kit: 3 });
  assert.equal(start.pack.partial, true);
  assert.equal(start.me.lineup.length, 11);
  assert.equal(start.me.tactic, 'hucum');
  assert.equal(start.me.kit, 3);
  assert.equal(start.opponent.lineup.length, 11);
  assert.ok(start.halftime.hint.length > 10);
  assert.equal(start.left, DUEL.daily - 1);
  assert.equal((await s.state({ uid: 'u1' })).duel.pending.duelId, start.duelId);
  await assert.rejects(s.duelFinish({ uid: 'u1', duelId: 'yok', tactic: 'kontra' }), /bulunamadı/);

  const fin = await s.duelFinish({ uid: 'u1', duelId: start.duelId, tactic: 'kontra' });
  assert.deepEqual(fin.halftimeScore, start.halftime.score, 'devre skoru ilk yarıyla aynı');
  assert.equal(fin.pack.partial, false);
  assert.ok(['W', 'D', 'L'].includes(fin.result));
  assert.equal(fin.reward, { W: DUEL.win, D: DUEL.draw, L: DUEL.loss }[fin.result]);
  assert.equal(fin.balance, st0.credits + fin.reward);
  assert.deepEqual(fin.tactics.me, ['hucum', 'kontra']);
  assert.equal(fin.week.points, { W: 3, D: 1, L: 0 }[fin.result]);
  assert.equal(fin.week.rank, 1);
  assert.equal(fin.goals.length, fin.score[0] + fin.score[1]);
  await assert.rejects(s.duelFinish({ uid: 'u1', duelId: start.duelId, tactic: 'kontra' }), /bitmiş/);

  const st = await s.state({ uid: 'u1' });
  assert.equal(st.duel.pending, null);
  assert.equal(st.duels.left, DUEL.daily - 1);
  assert.equal(st.duel.week.played, 1);
  assert.equal(st.duel.career.w + st.duel.career.d + st.duel.career.l, 1);
  assert.equal(st.duels.last[0].mode, 'normal');
  const daily = store.daily.get('u1/2026-10-28');
  assert.equal(daily.duelWins ?? 0, fin.result === 'W' ? 1 : 0);

  const board = await s.duelBoard({ uid: 'u1' });
  assert.equal(board.top[0].username, 'tostcu23');
  assert.equal(board.me.rank, 1);
  assert.ok(board.resetsAt > NOW && board.resetsAt - NOW <= 7 * 86400e3);
});

test('kapışma: yarım kalan kapışma yenisi başlarken biter; günde 3 hak; eski kapışma 30 dakika sonra kendiliğinden biter', async () => {
  let now = NOW;
  const { s } = svc({ now: () => now });
  const { sq } = await squadReady(s, 'u1');
  const a = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli' });
  const b = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'savunma' });
  assert.ok(b.resolved, 'ilki ödülüyle bitti');
  assert.notEqual(a.duelId, b.duelId);
  await s.duelFinish({ uid: 'u1', duelId: b.duelId });
  await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'kontra' });
  await assert.rejects(s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'kontra' }), /hakların bitti/);
  now += 31 * 60e3;
  const st = await s.state({ uid: 'u1' });
  assert.equal(st.duel.pending, null, 'unutulan kapışma bitti');
  assert.equal(st.duel.week.played, 3);
  assert.equal(st.duels.last.length, 3);
});

test('Günün Meydan Okuması: günde bir kez, büyük ödül; görevler ve sandık', async () => {
  const { s, store } = svc();
  const { sq } = await squadReady(s, 'u1');
  const st = await s.state({ uid: 'u1' });
  assert.ok(st.duel.boss.name.endsWith('Yıldızları'));
  assert.equal(st.duel.boss.done, false);
  const start = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'boss' });
  assert.equal(start.mode, 'boss');
  assert.equal(start.opponent.boss, true);
  assert.equal(start.opponent.name, st.duel.boss.name);
  assert.ok(start.opponent.power >= start.me.power, 'rakip biraz daha güçlü');
  assert.equal(start.left, null);
  const fin = await s.duelFinish({ uid: 'u1', duelId: start.duelId, tactic: 'hucum' });
  assert.equal(fin.reward, { W: BOSS.win, D: BOSS.draw, L: BOSS.loss }[fin.result]);
  assert.equal(fin.bossDone, true);
  await assert.rejects(s.duelStart({ uid: 'u1', squadId: sq.id, mode: 'boss' }), /bugün oynandı/);
  // Normal haklar ayrı
  assert.equal((await s.state({ uid: 'u1' })).duels.left, DUEL.daily);

  // Görev: meydan okuma → 100 kredi; sandık bütün görevler alınınca
  await s.claimMission({ uid: 'u1', id: 'boss' });
  await assert.rejects(s.claimChest({ uid: 'u1' }), /bütün görevlerini/);
  // Kalan görevleri doğrudan tamamlanmış say
  store.daily.set('u1/2026-10-28', { ...store.daily.get('u1/2026-10-28'), claimed: Object.fromEntries(MISSIONS.map((m) => [m.id, true])) });
  assert.equal((await s.state({ uid: 'u1' })).chest.ready, true);
  const c = await s.claimChest({ uid: 'u1' });
  assert.equal(c.reward, MISSION_CHEST);
  await assert.rejects(s.claimChest({ uid: 'u1' }), /açtın/);
});

test('giriş serisi: art arda günler artar, ara verilince 1\'den başlar; 3. gün ek ödül', async () => {
  let now = NOW;
  const { s } = svc({ now: () => now });
  await s.state({ uid: 'u1' });
  const d1 = await s.claimBonus({ uid: 'u1' });
  now += 86400e3;
  await s.claimBonus({ uid: 'u1' });
  now += 86400e3;
  const d3 = await s.claimBonus({ uid: 'u1' });
  assert.equal(d1.streak, 1);
  assert.equal(d3.streak, 3);
  assert.equal(d3.streakBonus, 100);
  assert.equal(d3.reward, 100 + 100);
  now += 3 * 86400e3;
  assert.equal((await s.state({ uid: 'u1' })).streak.count, 0, 'seri bozuldu');
  const again = await s.claimBonus({ uid: 'u1' });
  assert.equal(again.streak, 1);
  assert.equal((await s.state({ uid: 'u1' })).streak.best, 3);
});

test('kapışma: oyuncu havuzu boşken de rakip 11 kişi çıkar (maç donmaz)', async () => {
  const { s, pool } = svc();
  const { sq } = await squadReady(s, 'u1');
  pool.all = () => [];
  const start = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli' });
  assert.equal(start.opponent.lineup.filter((x) => x.name).length, 11);
  assert.ok(start.opponent.power > 40);
  const fin = await s.duelFinish({ uid: 'u1', duelId: start.duelId });
  assert.ok(['W', 'D', 'L'].includes(fin.result));
});
