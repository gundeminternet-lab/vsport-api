import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBulletin, BulletinService, teamKey } from '../bulletin.js';

const NOW = Date.parse('2026-10-24T10:00:00Z');
const H = 3600e3;
const teams = [
  { league: 'tur.1', teamId: '1', name: 'Ev Takımı' },
  { league: 'eng.1', teamId: '9', name: 'Dep Takımı' },
];

test('takım anahtarı istemcideki biçimle aynı', () => {
  assert.equal(teamKey('tur.1', '1'), 'tur_1_1');
});

test('yaklaşan ve son hafta sonuçları takip edilenlerle sınırlı, sıralı', () => {
  const fixtures = [
    { id: 'a', league: 'tur.1', timestamp: NOW + 48 * H, homeId: '1', homeName: 'Ev Takımı', awayId: '50', awayName: 'X', completed: false },
    { id: 'b', league: 'tur.1', timestamp: NOW + 24 * H, homeId: '60', homeName: 'Y', awayId: '1', awayName: 'Ev Takımı', completed: false },
    { id: 'c', league: 'tur.1', timestamp: NOW + 24 * H, homeId: '70', homeName: 'Takip dışı', awayId: '71', awayName: 'Z', completed: false },
    { id: 'd', league: 'eng.1', timestamp: NOW - 2 * H, homeId: '80', homeName: 'Rakip', awayId: '9', awayName: 'Dep Takımı', completed: true, homeGoals: 2, awayGoals: 1 },
    { id: 'e', league: 'tur.1', timestamp: NOW - 3 * 24 * H, homeId: '1', homeName: 'Ev Takımı', awayId: '90', awayName: 'R', completed: true, homeGoals: 0, awayGoals: 0 },
    { id: 'f', league: 'tur.1', timestamp: NOW - 20 * 24 * H, homeId: '1', homeName: 'Ev Takımı', awayId: '91', awayName: 'Eski', completed: true, homeGoals: 3, awayGoals: 0 },
  ];
  const b = buildBulletin({ teams, fixtures, now: NOW });
  assert.equal(b.followed, 2);
  assert.deepEqual(b.upcoming.map((u) => u.id), ['b', 'a']);
  assert.deepEqual(b.results.map((r) => r.id), ['d', 'e']);
});

test('sonuç takip edilen takımın bakışıyla yazılır (galibiyet, beraberlik, mağlubiyet)', () => {
  const fixtures = [
    { id: 'd', league: 'eng.1', timestamp: NOW - 2 * H, homeId: '80', homeName: 'Rakip', awayId: '9', awayName: 'Dep Takımı', completed: true, homeGoals: 2, awayGoals: 1 },
    { id: 'e', league: 'tur.1', timestamp: NOW - 3 * H, homeId: '1', homeName: 'Ev Takımı', awayId: '90', awayName: 'R', completed: true, homeGoals: 0, awayGoals: 0 },
    { id: 'g', league: 'tur.1', timestamp: NOW - 4 * H, homeId: '92', homeName: 'S', awayId: '1', awayName: 'Ev Takımı', completed: true, homeGoals: 3, awayGoals: 1 },
  ];
  const b = buildBulletin({ teams, fixtures, now: NOW });
  const byId = Object.fromEntries(b.results.map((r) => [r.id, r]));
  assert.equal(byId.d.outcome, 'L');
  assert.equal(byId.d.scoreLine, '2-1');
  assert.equal(byId.e.outcome, 'D');
  assert.equal(byId.g.outcome, 'L');
  assert.equal(byId.g.followedName, 'Ev Takımı');
});

test('takip yoksa anlamlı başlık ve boş listeler', () => {
  const b = buildBulletin({ teams: [], fixtures: [], now: NOW });
  assert.equal(b.followed, 0);
  assert.deepEqual(b.upcoming, []);
  assert.deepEqual(b.results, []);
  assert.match(b.headline, /takip ettiğin bir takım yok/);
});

test('bir ligin fikstürü hata verse de diğer ligler gelir', async () => {
  const db = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          get: async () => ({
            docs: [
              { data: () => ({ league: 'tur.1', teamId: '1', name: 'Ev Takımı' }) },
              { data: () => ({ league: 'eng.1', teamId: '9', name: 'Dep Takımı' }) },
            ],
          }),
        }),
      }),
    }),
  };
  const espn = {
    getFixtures: async (league) => {
      if (league === 'eng.1') throw new Error('ESPN kapalı');
      return [{ id: 'a', league, timestamp: NOW + 5 * H, homeId: '1', homeName: 'Ev Takımı', awayId: '50', awayName: 'X', completed: false }];
    },
  };
  const svc = new BulletinService({ espn, db, now: () => NOW });
  const b = await svc.get({ uid: 'u1' });
  assert.equal(b.upcoming.length, 1);
  assert.equal(b.followed, 2);
});

test('giriş yapılmamışsa reddedilir; sonuç 30 dk önbelleğe alınır', async () => {
  let calls = 0;
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ get: async () => { calls += 1; return { docs: [] }; } }) }) }),
  };
  const svc = new BulletinService({ espn: { getFixtures: async () => [] }, db, now: () => NOW });
  await assert.rejects(svc.get({}), { code: 'permission-denied' });
  await svc.get({ uid: 'u2' });
  await svc.get({ uid: 'u2' });
  assert.equal(calls, 1);
});
