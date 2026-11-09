import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRatings } from '../engine/ratings.js';
import { shotStats, parseEvents } from '../engine/espn.js';

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);

// 6 takımlı çift devreli lig. 'sanssiz' isabetli şut üretip az gol atıyor; 'sansli' tam tersi.
function league({ withSot = true, sotShare = 1 } = {}) {
  const ids = ['sanssiz', 'sansli', 'c', 'd', 'e', 'f'];
  const out = [];
  let k = 0;
  for (let round = 0; round < 4; round++) {
    for (const h of ids) {
      for (const a of ids) {
        if (h === a) continue;
        k++;
        const goals = (id) => (id === 'sansli' ? 2 : id === 'sanssiz' ? 0 : 1);
        const sot = (id) => (id === 'sanssiz' ? 7 : id === 'sansli' ? 2 : 4);
        const m = { id: `m${k}`, timestamp: T0 + k * DAY, homeId: h, awayId: a, homeGoals: goals(h), awayGoals: goals(a) };
        if (withSot && (k % 10) / 10 < sotShare) Object.assign(m, { homeSot: sot(h), awaySot: sot(a) });
        out.push(m);
      }
    }
  }
  return out;
}

test('lig gücü: isabetli şut, golün şansa açık kısmını düzeltir', () => {
  const ms = league();
  const now = ms.at(-1).timestamp + DAY;
  const goalsOnly = fitRatings(ms, { now, sotBlend: 1, newTeam: null });
  const blended = fitRatings(ms, { now, sotBlend: 0.5, newTeam: null });
  assert.equal(goalsOnly.sot, false);
  assert.equal(blended.sot, true);
  const att = (r, id) => r.teams.get(id).att;
  assert.ok(att(blended, 'sanssiz') > att(goalsOnly, 'sanssiz'), 'şut üreten ama atamayan takımın hücum gücü yükselir');
  assert.ok(att(blended, 'sansli') < att(goalsOnly, 'sansli'), 'az şutla çok gol bulan takımın hücum gücü düşer');
  // Sıralama yine de gol ağırlıklı kalır (yarı yarıya karışım)
  assert.ok(att(blended, 'sansli') > att(blended, 'sanssiz') * 0.5);
});

test('lig gücü: maçların çoğunda isabetli şut yoksa yalnızca gol kullanılır', () => {
  const ms = league({ sotShare: 0.5 });
  const now = ms.at(-1).timestamp + DAY;
  const r = fitRatings(ms, { now, sotBlend: 0.5, sotMinShare: 0.8, newTeam: null });
  const plain = fitRatings(ms, { now, sotBlend: 1, newTeam: null });
  assert.equal(r.sot, false);
  assert.equal(r.teams.get('sanssiz').att, plain.teams.get('sanssiz').att);
});

test('skor tablosu: şut istatistikleri ve maç notu okunur', () => {
  assert.deepEqual(shotStats({ statistics: [{ name: 'shotsOnTarget', displayValue: '6' }, { name: 'totalShots', displayValue: '14' }] }), { sot: 6, shots: 14 });
  assert.deepEqual(shotStats({ statistics: [{ name: 'shotsOnTarget', value: 3 }] }), { sot: 3, shots: null });
  assert.equal(shotStats({ statistics: [{ name: 'possessionPct', displayValue: '55' }] }), null);
  assert.equal(shotStats({}), null);
  const json = {
    events: [
      {
        id: '1',
        date: '2026-05-20T18:00Z',
        competitions: [
          {
            notes: [{ headline: 'Championship Play-Off Final' }],
            status: { type: { completed: true } },
            competitors: [
              { homeAway: 'home', team: { id: '10', displayName: 'Ev' }, score: '2', statistics: [{ name: 'shotsOnTarget', displayValue: '5' }, { name: 'totalShots', displayValue: '12' }] },
              { homeAway: 'away', team: { id: '20', displayName: 'Dep' }, score: '1', statistics: [{ name: 'shotsOnTarget', displayValue: '2' }, { name: 'totalShots', displayValue: '7' }] },
            ],
          },
        ],
      },
      {
        id: '2',
        date: '2026-05-21T18:00Z',
        competitions: [
          {
            status: { type: { completed: true } },
            competitors: [
              { homeAway: 'home', team: { id: '30' }, score: '0' },
              { homeAway: 'away', team: { id: '40' }, score: '0' },
            ],
          },
        ],
      },
    ],
  };
  const [a, b] = parseEvents(json, { league: 'eng.2' });
  assert.equal(a.stage, 'Championship Play-Off Final');
  assert.deepEqual([a.homeSot, a.awaySot, a.homeShots, a.awayShots], [5, 2, 12, 7]);
  assert.equal(b.stage, undefined);
  assert.equal(b.homeSot, undefined, 'şut verisi yoksa alan eklenmez');
});
