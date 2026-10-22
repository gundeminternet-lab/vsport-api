// Maç doğrulama: kimlikle doğrudan arama, fikstüre geri dönüş ve ESPN'e ulaşılamama durumu.
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSummaryEvent } from '../engine/espn.js';
import { PaidContentService } from '../logic.js';

const summary = {
  header: {
    id: '700123',
    competitions: [{
      id: '700123',
      date: '2026-10-18T17:00Z',
      status: { type: { completed: false, state: 'pre' } },
      competitors: [
        { homeAway: 'home', team: { id: '436', displayName: 'Galatasaray', logos: [{ href: 'g.png' }] } },
        { homeAway: 'away', team: { id: '432', displayName: 'Fenerbahçe', logos: [{ href: 'f.png' }] } },
      ],
    }],
  },
};

test('summary yanıtı fikstür biçimine çevrilir', () => {
  const m = parseSummaryEvent(summary, { league: 'tur.1' });
  assert.equal(m.id, '700123');
  assert.equal(m.homeId, '436');
  assert.equal(m.awayName, 'Fenerbahçe');
  assert.equal(m.completed, false);
  assert.equal(m.league, 'tur.1');
  assert.equal(parseSummaryEvent({}), null);
});

const args = { league: 'tur.1', eventId: '700123', kickoff: '2026-10-18T17:00:00.000Z' };
const svc = (espn) => new PaidContentService({ store: {}, espn });

test('maç önce kimliğiyle bulunur (tarih kayması sorun olmaz)', async () => {
  let fixtureCalls = 0;
  const m = await svc({
    getEvent: async (l, id) => parseSummaryEvent(summary, { league: l, eventId: id }),
    getFixtures: async () => (fixtureCalls++, []),
  }).findMatch(args);
  assert.equal(m.id, '700123');
  assert.equal(fixtureCalls, 0);
});

test('kimlikle arama başarısızsa fikstürde aranır', async () => {
  const m = await svc({
    getEvent: async () => { throw new Error('ESPN 500'); },
    getFixtures: async () => [{ id: '700123', homeId: '1', awayId: '2' }],
  }).findMatch(args);
  assert.equal(m.id, '700123');
});

test('ESPN tamamen ulaşılamazsa "bulunamadı" değil "ulaşılamıyor" hatası', async () => {
  const fail = async () => { throw new Error('fetch failed'); };
  const orig = console.error;
  console.error = () => {};
  try {
    await assert.rejects(svc({ getEvent: fail, getFixtures: fail }).findMatch(args), (e) => e.code === 'unavailable');
    await assert.rejects(svc({ getEvent: async () => null, getFixtures: async () => [] }).findMatch(args), (e) => e.code === 'not-found');
  } finally {
    console.error = orig;
  }
});
