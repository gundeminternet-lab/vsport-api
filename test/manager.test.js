// Menajer modu: mevkiye göre güç, teknik ekip ve potansiyel, altyapı, taktik planı, kariyer ligi (sezon, fikstür,
// kulübün maçı stadyumda, diğer maçlar, küme düşme/çıkma, ödüller).
import test from 'node:test';
import assert from 'node:assert/strict';

import { ENERGY } from '../game/energy.js';
import { GameService } from '../game/service.js';
import { slotsOf } from '../game/squad.js';
import { positionRating, bestPositions, fitOf, POSITIONS } from '../game/positions.js';
import { STAFF_IDS, staffCost, staffEffects, potentialOf, hashStr } from '../game/staff.js';
import { DIVISIONS, SEASON, roundRobin, newSeason, playWeek, standings, nextFixture, managerLevel, prizeOf, makeProspect, youthRating, YOUTH, checkPlan } from '../game/manager.js';
import { planMods, duelLambdas } from '../game/match.js';
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
  return { w, sq: await s.saveSquad({ uid, name: 'A Takımı', formation: '4-3-3', slots }) };
}

test('mevkiye göre güç: kendi mevkisinde kartın gücü, yakın mevkide küçük, uzak mevkide büyük kayıp', () => {
  const winger = { r: 80, pos: 'SLK', g: 'FV', st: [90, 80, 70, 86, 30, 62] };
  assert.equal(positionRating(winger, 'SLK'), 80);
  assert.ok(positionRating(winger, 'SĞK') >= 76, 'öbür kanatta neredeyse aynı');
  assert.ok(positionRating(winger, 'STP') < 65, 'stoperde zayıf');
  const best = bestPositions(winger);
  assert.equal(best.length, 3);
  assert.ok(best.some((b) => b.pos === 'SLK'));
  assert.deepEqual(bestPositions({ r: 77, pos: 'KL', g: 'KL', st: [] }), [{ pos: 'KL', r: 77 }]);
  assert.ok(positionRating({ r: 77, pos: 'KL', g: 'KL', st: [] }, 'SNT') <= 60);
  assert.equal(fitOf('SLK', 'SLK'), 'tam');
  assert.equal(fitOf('SLK', 'SLO'), 'yakın');
  assert.equal(fitOf('STP', 'SLB'), 'yakın');
  assert.equal(fitOf('SNT', 'STP'), 'uzak');
  assert.equal(Object.keys(POSITIONS).length, 12);
});

test('teknik ekip ve potansiyel: etkiler, bedeller, yaşa göre potansiyel', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(staffCost), [400, 1300, 2590, 4220, 6170]);
  const e = staffEffects({ def: 5, fit: 4, scout: 3 });
  assert.equal(e.xpPct.DEF, 75);
  assert.equal(e.capBonus.DEF, 3);
  assert.equal(e.xpPct.FV, 0);
  assert.equal(e.sessions, 2);
  assert.equal(e.scoutPot, 9);
  assert.equal(e.scoutExtra, 1);
  assert.equal(potentialOf({ r: 70, pot: 88 }), 88);
  const young = potentialOf({ pid: 'p1', r: 68, a: 19 });
  const old = potentialOf({ pid: 'p1', r: 68, a: 33 });
  assert.ok(young >= 76 && young <= 84, `${young}`);
  assert.ok(old >= 68 && old <= 69, `${old}`);
  assert.equal(potentialOf({ pid: 'abc', r: 90, a: 22 }), Math.min(95, 90 + 5 + (hashStr('abc') % 6)));
  assert.equal(hashStr('Kuzey'), 'Kuzey'.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0x7fffffff, 0));
});

test('teknik ekip: işe al, seviye artır; savunma antrenörü savunmacıya daha çok gelişim verir', async () => {
  const { s, store } = svc();
  const { w } = await club(s);
  await store.changeCredits('u1', 20000, { earn: false });
  const r = await s.club.hireStaff({ uid: 'u1', staff: 'def' });
  assert.equal(r.level, 1);
  assert.equal(r.cost, 400);
  const view = r.club.staff.find((x) => x.id === 'def');
  assert.equal(view.level, 1);
  assert.match(view.effect, /Gelişim \+%15/);
  assert.equal(r.club.training.groupXpPct.DEF, 15);
  await assert.rejects(s.club.hireStaff({ uid: 'u1', staff: 'yok' }), /Geçersiz antrenör/);
  // Savunmacı ve forvet: aynı antrenman, savunmacı %15 daha çok gelişim puanı alır
  const def = w.cards.find((c) => c.g === 'DEF');
  const fv = w.cards.find((c) => c.g === 'FV');
  // Genetik ve yaş aynı olsun (yalnızca antrenör farkı ölçülsün)
  await store.updateCard('u1', def.id, { pot: 99, pid: 'ayni-genetik', a: 25 });
  await store.updateCard('u1', fv.id, { pot: 99, pid: 'ayni-genetik', a: 25 });
  const a = await s.club.train({ uid: 'u1', cardId: def.id, drill: 'fizik' });
  const b = await s.club.train({ uid: 'u1', cardId: fv.id, drill: 'fizik' });
  assert.equal(a.gain, Math.round(b.gain * 1.15));
  for (const id of STAFF_IDS) assert.ok(r.club.staff.some((x) => x.id === id));
});

test('antrenman potansiyeli aşamaz', async () => {
  const { s, store } = svc();
  const { w } = await club(s);
  await store.changeCredits('u1', 5000, { earn: false });
  const c = w.cards.find((x) => x.g === 'OS');
  await store.updateCard('u1', c.id, { pot: c.r });
  await assert.rejects(s.club.train({ uid: 'u1', cardId: c.id, drill: 'teknik' }), /potansiyeline ulaştı/);
});

test('altyapı: günlük ücretsiz tarama, ücretli ek tarama, gençler günle gelişir, A takıma alınır', async () => {
  const clock = { t: NOW };
  const { s, store } = svc(clock);
  await club(s);
  const first = await s.manager.youthScout({ uid: 'u1' });
  assert.equal(first.cost, 0);
  assert.equal(first.found.length, 1);
  const y = first.found[0];
  assert.ok(y.age >= 15 && y.age <= 17);
  assert.ok(y.pot >= y.r + 6);
  assert.match(y.name, /^\p{L}+ \p{L}+$/u);
  // İkinci tarama ücretli
  await store.changeCredits('u1', 2000, { earn: false });
  const second = await s.manager.youthScout({ uid: 'u1' });
  assert.equal(second.cost, YOUTH.extraCost);
  // Gençler akademide gelişir
  const before = (await s.manager.youthState({ uid: 'u1' })).youth.list.find((x) => x.id === y.id).r;
  clock.t += 10 * DAY;
  const after = (await s.manager.youthState({ uid: 'u1' })).youth.list.find((x) => x.id === y.id).r;
  assert.ok(after > before, `${before} → ${after}`);
  // A takıma al: kart olur, potansiyeli yazılı, Transfer Pazarı'na konamaz
  const pr = await s.manager.youthPromote({ uid: 'u1', id: y.id });
  assert.equal(pr.card.youth, true);
  assert.equal(pr.card.pot, y.pot);
  assert.equal(pr.card.l, 'Altyapı');
  assert.equal(pr.card.r, after);
  assert.ok(!pr.youth.list.some((x) => x.id === y.id));
  const cards = await store.listCards('u1');
  assert.ok(cards.some((c) => c.id === pr.card.id && c.youth === true));
  // Serbest bırak
  const rest = pr.youth.list[0];
  const rel = await s.manager.youthRelease({ uid: 'u1', id: rest.id });
  assert.ok(!rel.youth.list.some((x) => x.id === rest.id));
  await assert.rejects(s.manager.youthPromote({ uid: 'u1', id: 'yok' }), /bulunamadı/);
});

test('altyapı: yer dolunca tarama yapılmaz; gençlerin gücü potansiyelin altında kalır', () => {
  const p = makeProspect({ seed: 'u', id: 'y1', academyLevel: 10, scoutLevel: 5, now: NOW });
  assert.ok(p.pot <= 94);
  assert.equal(youthRating(p, NOW + 1000 * DAY, 10), Math.max(p.r0, p.pot - 2));
  assert.equal(youthRating(p, NOW, 1), p.r0);
});

test('taktik planı: doğrulama, kaydetme, kadro düzenlenince korunur; plan gol beklentisini değiştirir', async () => {
  const { s, store } = svc();
  const { sq } = await club(s);
  assert.throws(() => checkPlan({ style: 'yok' }), /oyun anlayışı/);
  assert.throws(() => checkPlan({ press: 7 }), /1 ile 5/);
  const r = await s.manager.setPlan({ uid: 'u1', squadId: sq.id, plan: { style: 'hucum', press: 5, line: 4, width: 3, tempo: 5 } });
  assert.deepEqual(r.plan, { style: 'hucum', press: 5, line: 4, width: 3, tempo: 5 });
  let saved = (await store.listSquads('u1')).find((x) => x.id === sq.id);
  assert.equal(saved.plan.press, 5);
  await s.saveSquad({ uid: 'u1', id: sq.id, name: 'A Takımı 2', formation: sq.formation, slots: sq.slots });
  saved = (await store.listSquads('u1')).find((x) => x.id === sq.id);
  assert.equal(saved.plan.tempo, 5, 'kadro düzenlenince plan korunur');
  const aggressive = planMods({ press: 5, line: 5, width: 5, tempo: 5 });
  assert.ok(aggressive.att > 1.1 && aggressive.open > 1.1, 'hücum artar, savunmada açık da artar');
  const base = duelLambdas(75, 75, 'dengeli', 'dengeli');
  const withPlan = duelLambdas(75, 75, 'dengeli', 'dengeli', aggressive, null);
  assert.ok(withPlan.home > base.home && withPlan.away > base.away);
  assert.deepEqual(planMods(null), { att: 1, open: 1 });
});

test('fikstür: 8 takım, 14 hafta, her takım herkesle iki kez (bir evde bir deplasmanda)', () => {
  const rr = roundRobin(8);
  assert.equal(rr.length, 14);
  const seen = new Map();
  for (const week of rr) {
    assert.equal(week.length, 4);
    const inWeek = new Set(week.flat());
    assert.equal(inWeek.size, 8, 'her takım haftada bir maç');
    for (const [h, a] of week) seen.set(`${h}-${a}`, (seen.get(`${h}-${a}`) ?? 0) + 1);
  }
  assert.equal(seen.size, 56);
  assert.ok([...seen.values()].every((n) => n === 1));
});

test('sezon: rakipler kurgusal, güçler lig ile kadronun ortasında; 14 hafta sonunda sıra, ödül, çıkış', () => {
  const season = newSeason({ no: 1, div: 0, power: 78, club: { name: 'Kuzey Yıldızı', short: 'KY', crest }, seed: 'u1' });
  assert.equal(season.teams.length, 8);
  assert.equal(new Set(season.teams.map((t) => t.name)).size, 8);
  const ai = season.teams.filter((t) => !t.me);
  const avg = ai.reduce((a, t) => a + t.power, 0) / ai.length;
  assert.ok(Math.abs(avg - (0.5 * DIVISIONS[0].base + 0.5 * 78)) < 1.5, `${avg}`);
  assert.equal(season.objective.rank, 1, 'en güçlü kadro şampiyonluk hedefi alır');
  let s2 = season;
  // Kulüp her maçı 2-0 kazanır: şampiyon olur, üst lige çıkar
  for (let w = 0; w < SEASON.weeks; w++) {
    const fx = nextFixture(s2);
    assert.equal(fx.week, w + 1);
    s2 = playWeek(s2, 2, 0, 'u1');
  }
  assert.equal(s2.done, true);
  assert.equal(nextFixture(s2), null);
  const rows = standings(s2);
  assert.equal(rows[0].me, true);
  assert.equal(rows[0].pts, 42);
  assert.equal(rows.reduce((a, r) => a + r.p, 0), 8 * 14);
  assert.equal(s2.final.rank, 1);
  assert.equal(s2.final.champion, true);
  assert.equal(s2.final.promoted, true);
  assert.equal(s2.final.nextDiv, 1);
  assert.equal(s2.final.prize, prizeOf(1, 0));
  assert.ok(s2.final.bonus > 0);
  // Hep kaybeden kulüp üst ligde düşer
  let s3 = newSeason({ no: 2, div: 2, power: 70, club: { name: 'X', crest }, seed: 'u1' });
  for (let w = 0; w < SEASON.weeks; w++) s3 = playWeek(s3, 0, 3, 'u1');
  assert.equal(s3.final.relegated, true);
  assert.equal(s3.final.nextDiv, 1);
  assert.equal(managerLevel(0).title, 'Stajyer menajer');
  assert.ok(managerLevel(4000).level >= 10);
});

test('kariyer: sezona başla, kariyer maçı stadyumda oynanır, tablo ve hafta ilerler, ödül verilir', async () => {
  const { s } = svc();
  const { sq } = await club(s);
  await assert.rejects(s.duelNext({ uid: 'u1', mode: 'season' }), /sezona başla/);
  const st = await s.manager.start({ uid: 'u1' });
  assert.equal(st.career.division, 'Amatör Lig');
  assert.equal(st.career.season.week, 0);
  assert.equal(st.career.season.table.length, 8);
  await assert.rejects(s.manager.start({ uid: 'u1' }), /Sezon sürüyor/);
  const pv = await s.duelNext({ uid: 'u1', mode: 'season' });
  assert.equal(pv.mode, 'season');
  assert.equal(pv.fixture.week, 1);
  assert.equal(pv.rewards[0], SEASON.win);
  assert.equal(pv.opponent.name, st.career.season.next.opponent.name);
  const k = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'season' });
  assert.equal(k.opponent.name, pv.opponent.name);
  const f = await s.duelFinish({ uid: 'u1', duelId: k.duelId });
  assert.ok(f.season, 'kariyer sonucu yanıtta');
  assert.equal(f.season.career.season.week, 1);
  const me = f.season.career.season.table.find((t) => t.me);
  assert.equal(me.p, 1);
  assert.equal(me.gf, f.score[0]);
  assert.equal(f.season.career.season.table.reduce((a, t) => a + t.p, 0), 8, 'haftanın bütün maçları oynandı');
  assert.equal(f.reward >= [SEASON.win, SEASON.draw, SEASON.loss][['W', 'D', 'L'].indexOf(f.result)], true);
  // Kariyer maçı haftalık Kapışma Ligi'ne yazılmaz; kariyer maçı 25 enerji harcar
  const state = await s.state({ uid: 'u1' });
  assert.equal(state.energy.value, ENERGY.max - ENERGY.cost.season);
  assert.equal(state.duel.week.played, 0);
  assert.equal(state.career.season.week, 1);
  assert.equal(state.career.left, Math.floor((ENERGY.max - ENERGY.cost.season) / ENERGY.cost.season));
  // Günlük sınır yok: enerji yettikçe (100 → 4 kariyer maçı)
  for (let i = 0; i < 3; i++) {
    const kk = await s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'hucum', mode: 'season' });
    await s.duelFinish({ uid: 'u1', duelId: kk.duelId });
  }
  await assert.rejects(s.duelStart({ uid: 'u1', squadId: sq.id, tactic: 'dengeli', mode: 'season' }), /Enerjin yetmiyor/);
});
