// Kadro düzeltmesi: ayrıştırma, düzenli oyuncular, eksik etkisi, yön ve sınırlar.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLineup, regularPlayers, absences, lineupEffect, applyLineupAdjustment } from '../engine/lineup.js';
import { LineupService } from '../lineup.js';
import { NOW } from './helpers.js';

const rosterJson = (homeStarters, homeBench = []) => ({
  rosters: [
    {
      team: { id: '10' },
      roster: [
        ...homeStarters.map(([name, pos]) => ({ starter: true, athlete: { displayName: name }, position: { abbreviation: pos } })),
        ...homeBench.map(([name, pos]) => ({ starter: false, athlete: { displayName: name }, position: { abbreviation: pos } })),
      ],
    },
    { team: { id: '20' }, roster: [{ starter: true, athlete: { displayName: 'Dep Kaleci' }, position: { abbreviation: 'G' } }] },
  ],
});

const XI = [['Kaleci', 'G'], ['Stoper A', 'CB'], ['Stoper B', 'CB'], ['Sağ bek', 'RB'], ['Sol bek', 'LB'], ['Orta A', 'CM'], ['Orta B', 'CM'], ['Sağ kanat', 'RW'], ['Sol kanat', 'LW'], ['Santrafor', 'ST'], ['Ofansif', 'AM']];

test('kadro ayrıştırma: ilk 11 ve yedekler; açıklanmamışsa null', () => {
  const l = parseLineup(rosterJson(XI, [['Yedek', 'F']]), '10');
  assert.equal(l.starters.length, 11);
  assert.equal(l.bench.length, 1);
  assert.equal(l.starters[9].pos, 'ST');
  assert.equal(parseLineup(rosterJson([]), '10'), null);
  assert.equal(parseLineup({}, '10'), null);
});

test('düzenli oyuncu: son maçların en az yarısında ve en az 3 kez ilk 11', () => {
  const sample = (names) => ({ starters: names.map((n) => ({ name: n, pos: 'CM' })) });
  const samples = [sample(['A', 'B']), sample(['A', 'C']), sample(['A', 'B']), sample(['A', 'D'])];
  const reg = regularPlayers(samples);
  assert.deepEqual(reg.map((r) => r.name), ['A']);
  assert.equal(regularPlayers(samples.slice(0, 2)).length, 0, 'az örnekle düzenli oyuncu yok');
});

test('kadroda olmayan düzenli oyuncu eksik sayılır; yedekteki ilk 11 dışı ayrı tutulur', () => {
  const regulars = [{ name: 'Santrafor', pos: 'ST', starts: 6 }, { name: 'Stoper A', pos: 'CB', starts: 6 }];
  const lineup = { starters: [{ name: 'Stoper A', pos: 'CB' }], bench: [] };
  const { missing, benched } = absences({ regulars, lineup });
  assert.deepEqual(missing.map((m) => m.name), ['Santrafor']);
  assert.equal(benched.length, 0);
  const l2 = absences({ regulars, lineup: { starters: [{ name: 'Stoper A' }], bench: [{ name: 'Santrafor' }] } });
  assert.equal(l2.missing.length, 0);
  assert.equal(l2.benched[0].name, 'Santrafor');
});

test('etki: eksik hücumcu kendi takımını, eksik defans rakibi güçlendirir; sınırlar aşılmaz', () => {
  const noAtt = lineupEffect({ missing: [{ name: 'X', pos: 'ST' }], benched: [] });
  assert.ok(Math.abs(noAtt.attackFactor - 0.94) < 1e-9);
  assert.equal(noAtt.concedeFactor, 1);
  const defs = lineupEffect({ missing: [{ name: 'X', pos: 'CB' }, { name: 'Y', pos: 'LB' }], benched: [] });
  assert.ok(Math.abs(defs.concedeFactor - 1.06) < 1e-9);
  const many = lineupEffect({ missing: Array.from({ length: 10 }, (_, i) => ({ name: `F${i}`, pos: 'ST' })), benched: [] });
  assert.equal(many.attackFactor, 0.85, 'hücum düşüşü en fazla %15');
  const keeper = lineupEffect({ missing: [{ name: 'K', pos: 'G' }], benched: [] });
  assert.ok(keeper.concedeFactor > 1 && keeper.concedeFactor <= 1.1);
  const bench = lineupEffect({ missing: [], benched: [{ name: 'Y', pos: 'ST' }] });
  assert.ok(Math.abs(bench.attackFactor - 0.97) < 1e-9, 'yedekteki düzenli oyuncu yarım etki');
});

test('güncel tahmin: eksik hücumcu ev sahibinin golünü ve ihtimalini düşürür', () => {
  const pm = { lambdaHome: 1.6, lambdaAway: 1.1, sigma: 0 };
  const none = { attackFactor: 1, concedeFactor: 1 };
  const weak = { attackFactor: 0.85, concedeFactor: 1 };
  const before = applyLineupAdjustment({ base: pm, homeEffect: none, awayEffect: none, sigma: 0 });
  const after = applyLineupAdjustment({ base: pm, homeEffect: weak, awayEffect: none, sigma: 0 });
  assert.ok(after.lambdaHome < before.lambdaHome);
  assert.ok(after.probabilities.home < before.probabilities.home);
  assert.ok(['1', 'X', '2'].includes(after.pick));
  assert.match(after.topScore, /^\d+-\d+$/);
  const sum = after.probabilities.home + after.probabilities.draw + after.probabilities.away;
  assert.ok(sum >= 98 && sum <= 102, `toplam ${sum}`);
});

test('hiç düzeltme yoksa tahmin değişmez', () => {
  const pm = { lambdaHome: 1.4, lambdaAway: 1.2, sigma: 0.1 };
  const none = { attackFactor: 1, concedeFactor: 1 };
  const a = applyLineupAdjustment({ base: pm, homeEffect: none, awayEffect: none, sigma: 0.1 });
  const b = applyLineupAdjustment({ base: pm, homeEffect: none, awayEffect: none, sigma: 0.1 });
  assert.deepEqual(a, b);
  assert.equal(a.lambdaHome, 1.4);
});

function fakePaid({ match, content, owned = true }) {
  return {
    async covers(_uid, _key, type) {
      return owned && type === 'ai';
    },
    validate() {},
    async findMatch() {
      return match;
    },
    async contentFor() {
      return content;
    },
    memoryFactory: () => ({}),
  };
}

const matchInfo = { league: 'tur.1', id: '77', homeId: '10', awayId: '20', homeName: 'Ev', awayName: 'Dep', timestamp: NOW + 3600e3, completed: false };
const content = {
  key: 'tur_1_77',
  model: { lambdaHome: 1.5, lambdaAway: 1.1, sigma: 0 },
  ai: { pick: '1', probabilities: { home: 50, draw: 25, away: 25 }, topScore: '2-1' },
};

test('servis: kadro açıklanmadıysa kullanılabilir değil', async () => {
  const espn = { getSummary: async () => ({ rosters: [] }) };
  const svc = new LineupService({ paid: fakePaid({ match: matchInfo, content }), espn, now: () => NOW, samplesFor: async () => [] });
  const r = await svc.update({ uid: 'u', league: 'tur.1', eventId: '77', kickoff: new Date(matchInfo.timestamp).toISOString() });
  assert.equal(r.available, false);
});

test('servis: kadro açıklandığında ilk tahmin ve güncel tahmin yan yana döner', async () => {
  const regularSamples = Array.from({ length: 6 }, () => ({ starters: [{ name: 'Santrafor', pos: 'ST' }, { name: 'Stoper', pos: 'CB' }] }));
  const espn = {
    getSummary: async () => ({
      rosters: [
        { team: { id: '10' }, roster: [{ starter: true, athlete: { displayName: 'Stoper' }, position: { abbreviation: 'CB' } }] },
        { team: { id: '20' }, roster: [{ starter: true, athlete: { displayName: 'Dep Kaleci' }, position: { abbreviation: 'G' } }] },
      ],
    }),
  };
  const svc = new LineupService({
    paid: fakePaid({ match: matchInfo, content }),
    espn,
    now: () => NOW,
    samplesFor: async (_m, teamId) => (String(teamId) === '10' ? regularSamples : []),
  });
  const r = await svc.update({ uid: 'u', league: 'tur.1', eventId: '77', kickoff: new Date(matchInfo.timestamp).toISOString() });
  assert.equal(r.available, true);
  assert.deepEqual(r.base, content.ai);
  assert.deepEqual(r.missing.home.map((p) => p.name), ['Santrafor']);
  assert.equal(r.changed, r.updated.pick !== '1' || r.updated.topScore !== '2-1');
  assert.ok(r.notes.some((n) => n.includes('Santrafor')));
  assert.ok(r.notes.every((n) => !/bahis|kupon|oran/i.test(n)));
});

test('servis: maç başladıktan sonra güncelleme yapılmaz', async () => {
  const svc = new LineupService({ paid: fakePaid({ match: { ...matchInfo, timestamp: NOW - 1 }, content }), espn: {}, now: () => NOW, samplesFor: async () => [] });
  await assert.rejects(() => svc.update({ uid: 'u', league: 'tur.1', eventId: '77', kickoff: new Date(NOW).toISOString() }), { code: 'failed-precondition' });
});

test('servis: giriş yapmadan güncelleme yok', async () => {
  const svc = new LineupService({ paid: fakePaid({ match: matchInfo, content }), espn: {}, now: () => NOW });
  await assert.rejects(() => svc.update({ league: 'tur.1', eventId: '77', kickoff: new Date(NOW).toISOString() }), { code: 'permission-denied' });
});

test('servis: AI paketini açmayan kullanıcıya tahmin ve notlar gönderilmez', async () => {
  let fetched = 0;
  const espn = { getSummary: async () => { fetched++; return { rosters: [] }; } };
  const svc = new LineupService({ paid: fakePaid({ match: matchInfo, content, owned: false }), espn, now: () => NOW, samplesFor: async () => [] });
  const r = await svc.update({ uid: 'u', league: 'tur.1', eventId: '77', kickoff: new Date(matchInfo.timestamp).toISOString() });
  assert.equal(r.available, false);
  assert.equal(r.locked, true);
  for (const k of ['base', 'updated', 'changed', 'notes', 'missing', 'benched']) assert.equal(r[k], undefined, k);
  assert.equal(fetched, 0, 'kilitliyken kadro/tahmin hesaplanmaz');
});

test('servis: paket açanın önbelleğe giren sonucu paketsiz kullanıcıya sızmaz', async () => {
  const owners = new Set(['sahip']);
  const paid = { ...fakePaid({ match: matchInfo, content }), covers: async (uid) => owners.has(uid) };
  const espn = {
    getSummary: async () => ({
      rosters: [
        { team: { id: '10' }, roster: [{ starter: true, athlete: { displayName: 'Stoper' }, position: { abbreviation: 'CB' } }] },
        { team: { id: '20' }, roster: [{ starter: true, athlete: { displayName: 'Dep Kaleci' }, position: { abbreviation: 'G' } }] },
      ],
    }),
  };
  const svc = new LineupService({ paid, espn, now: () => NOW, samplesFor: async () => [] });
  const args = { league: 'tur.1', eventId: '77', kickoff: new Date(matchInfo.timestamp).toISOString() };
  const own = await svc.update({ uid: 'sahip', ...args });
  assert.equal(own.available, true);
  const other = await svc.update({ uid: 'baska', ...args });
  assert.equal(other.locked, true);
  assert.equal(other.base, undefined);
});
