import test from 'node:test';
import assert from 'node:assert/strict';

import { autoPollFor } from '../polls.js';
import { MatchWatcher } from '../watcher.js';

test('otomatik anket şablonları', () => {
  const p = autoPollFor({ type: 'red_card', title: '🟥 Kırmızı kart · Galatasaray - Fenerbahçe', body: '' });
  assert.equal(p.question, 'Kırmızı kart kararı doğru mu? (Galatasaray - Fenerbahçe)');
  assert.equal(p.options.length, 3);
  assert.equal(autoPollFor({ type: 'goal', title: 'GOL', body: '' }), null);
  assert.ok(autoPollFor({ type: 'var', title: 'VAR incelemesi · A - B' }).question.length <= 120);
});

test('izleyici her bildirim için anket kancasını çağırır', async () => {
  const notes = [];
  const sum = {
    header: { competitions: [{ status: { period: 1, displayClock: "30'", type: { state: 'in', name: 'STATUS_FIRST_HALF' } },
      competitors: [{ homeAway: 'home', score: '0', team: { id: '1', shortDisplayName: 'A' } }, { homeAway: 'away', score: '0', team: { id: '2', shortDisplayName: 'B' } }] }] },
    keyEvents: [{ id: 'r1', type: { text: 'Red Card' }, redCard: true, team: { id: '2' }, clock: { displayValue: "30'" } }],
  };
  const w = new MatchWatcher({
    store: { listWatched: async () => [{ key: 'tur_1_5', league: 'tur.1', eventId: '5', state: { phases: { kickoff: true }, seen: [], score: [0, 0] } }], saveWatchState: async () => {} },
    espn: { getSummary: async () => sum },
    send: async () => {},
    onNote: async (n) => notes.push(n),
    log: { error() {} },
  });
  await w.tick();
  assert.deepEqual(notes.map((n) => [n.key, n.note.type]), [['tur_1_5', 'red_card']]);
});
