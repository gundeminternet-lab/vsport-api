// Canlı bildirim mantığı testleri.
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, classifyEvent, readSummary, NOTIFY_TYPES, SOUND_CHANNELS, DEFAULT_CHANNEL, channelFor, fcmMessage } from '../notify.js';
import { MatchWatcher } from '../watcher.js';

function summary({ state = 'in', name = 'STATUS_FIRST_HALF', period = 1, clock = "10'", score = [0, 0], completed = false, events = [] } = {}) {
  return {
    header: {
      competitions: [{
        status: { period, displayClock: clock, type: { state, name, completed } },
        competitors: [
          { homeAway: 'home', score: String(score[0]), team: { id: '1', shortDisplayName: 'Galatasaray' } },
          { homeAway: 'away', score: String(score[1]), team: { id: '2', shortDisplayName: 'Fenerbahçe' } },
        ],
      }],
    },
    keyEvents: events,
  };
}
const goal = (id, teamId, clock, extra = {}) => ({
  id, type: { text: 'Goal' }, scoringPlay: true, clock: { displayValue: clock }, team: { id: teamId },
  participants: [{ athlete: { displayName: 'Mauro Icardi' } }], ...extra,
});

test('maç öncesinden sona kadar bildirim akışı', () => {
  let r = evaluate(summary({ state: 'pre', name: 'STATUS_SCHEDULED', period: 0, clock: "0'" }), null);
  assert.equal(r.notes.length, 0);
  let st = r.state;

  r = evaluate(summary({ clock: "1'" }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['kickoff']);
  st = r.state;

  r = evaluate(summary({ clock: "23'", score: [1, 0], events: [goal('e1', '1', "23'")] }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['goal']);
  assert.equal(r.notes[0].title, '⚽ GOL! Galatasaray 1-0 Fenerbahçe');
  assert.match(r.notes[0].body, /23' Mauro Icardi \(Galatasaray\)/);
  st = r.state;

  // Aynı olay tekrar gelmez
  r = evaluate(summary({ clock: "30'", score: [1, 0], events: [goal('e1', '1', "23'")] }), st);
  assert.equal(r.notes.length, 0);
  st = r.state;

  r = evaluate(summary({ clock: "45'+2'", score: [1, 0], events: [goal('e1', '1', "23'")] }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['added_time']);
  st = r.state;

  r = evaluate(summary({ name: 'STATUS_HALFTIME', clock: 'HT', score: [1, 0], events: [goal('e1', '1', "23'")] }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['half_time']);
  st = r.state;

  r = evaluate(summary({ name: 'STATUS_SECOND_HALF', period: 2, clock: "46'", score: [1, 0], events: [goal('e1', '1', "23'")] }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['second_half']);
  st = r.state;

  const red = { id: 'e2', type: { text: 'Red Card' }, redCard: true, clock: { displayValue: "55'" }, team: { id: '2' }, participants: [{ athlete: { displayName: 'Oyuncu' } }] };
  const pen = { id: 'e3', type: { text: 'Penalty - Scored' }, scoringPlay: true, penaltyKick: true, clock: { displayValue: "60'" }, team: { id: '1' } };
  r = evaluate(summary({ name: 'STATUS_SECOND_HALF', period: 2, clock: "60'", score: [2, 0], events: [goal('e1', '1', "23'"), red, pen] }), st);
  assert.deepEqual(r.notes.map((n) => n.type).sort(), ['goal', 'penalty', 'red_card']);
  st = r.state;

  // Skor geri gitti: gol iptal
  r = evaluate(summary({ name: 'STATUS_SECOND_HALF', period: 2, clock: "62'", score: [1, 0], events: [goal('e1', '1', "23'"), red] }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['goal_disallowed']);
  st = r.state;

  r = evaluate(summary({ state: 'post', name: 'STATUS_FULL_TIME', period: 2, clock: "90'+5'", score: [1, 0], completed: true, events: [goal('e1', '1', "23'"), red] }), st);
  assert.deepEqual(r.notes.map((n) => n.type), ['full_time']);
  assert.equal(r.notes[0].body, 'Maç sonucu: Galatasaray 1-0 Fenerbahçe');
  assert.equal(r.state.done, true);
});

test('takibe maç sürerken başlanırsa eski olaylar için bildirim gönderilmez', () => {
  const r = evaluate(summary({ name: 'STATUS_SECOND_HALF', period: 2, clock: "70'", score: [2, 1], events: [goal('a', '1', "10'"), goal('b', '2', "50'")] }), null);
  assert.equal(r.notes.length, 0);
  assert.equal(r.state.phases.kickoff, true);
  assert.equal(r.state.phases.half_time, true);
  assert.deepEqual(r.state.seen.sort(), ['a', 'b']);
});

test('ertelenen maç takipten düşer', () => {
  const r = evaluate(summary({ state: 'post', name: 'STATUS_POSTPONED', completed: false }), { phases: {}, seen: [], score: [0, 0] });
  assert.equal(r.notes.length, 0);
  assert.equal(r.state.done, true);
});

test('olay sınıflandırma', () => {
  const s = readSummary(summary({ events: [
    { id: '1', type: { text: 'Penalty - Missed' }, penaltyKick: true },
    { id: '2', type: { text: 'Own Goal' }, ownGoal: true, scoringPlay: true },
    { id: '3', type: { text: 'VAR - Goal Disallowed' } },
    { id: '4', type: { text: 'Yellow Card' } },
  ] }));
  assert.deepEqual(classifyEvent(s.events[0]), ['penalty']);
  assert.deepEqual(classifyEvent(s.events[1]), ['goal']);
  assert.deepEqual(classifyEvent(s.events[2]), ['goal_disallowed']);
  assert.deepEqual(classifyEvent(s.events[3]), []);
});

test('izleyici: konu adı, durum kaydı, ligi geçersiz ve bitmiş maçları atlar', async () => {
  const sent = [];
  const saved = new Map();
  const items = [
    { key: 'tur_1_100', league: 'tur.1', eventId: '100', state: { phases: {}, seen: [], score: [0, 0] } },
    { key: 'xxx_1_200', league: 'xxx.1', eventId: '200', state: null },
    { key: 'tur_1_300', league: 'tur.1', eventId: '300', state: { done: true } },
  ];
  let fetched = 0;
  const w = new MatchWatcher({
    store: { listWatched: async () => items, saveWatchState: async (k, s) => saved.set(k, s) },
    espn: { getSummary: async () => (fetched++, summary({ clock: "2'" })) },
    send: async (m) => sent.push(m),
    log: { error() {} },
  });
  assert.equal(await w.tick(), 1);
  assert.equal(fetched, 1);
  assert.deepEqual(sent.map((m) => m.topic), ['tur_1_100_kickoff']);
  assert.equal(sent[0].data.type, 'kickoff');
  assert.equal(saved.get('tur_1_100').phases.kickoff, true);
});

test('izleyici: biten maçta tahminler bir kez puanlanır', async () => {
  const finished = [];
  const saved = new Map();
  const ended = summary({ state: 'post', name: 'STATUS_FULL_TIME', period: 2, clock: "90'", score: [2, 1], completed: true });
  ended.header.competitions[0].date = '2026-10-18T17:00Z';
  const item = { key: 'tur_1_100', league: 'tur.1', eventId: '100', state: { phases: { kickoff: true, half_time: true, second_half: true }, seen: [], score: [2, 1] } };
  const w = new MatchWatcher({
    store: { listWatched: async () => [item], saveWatchState: async (k, s) => saved.set(k, s) },
    espn: { getSummary: async () => ended },
    send: async () => {},
    onFinished: async (m) => finished.push(m),
    log: { error() {} },
  });
  await w.tick();
  assert.deepEqual(finished, [{ key: 'tur_1_100', homeGoals: 2, awayGoals: 1, kickoffMs: Date.parse('2026-10-18T17:00Z') }]);
  assert.equal(saved.get('tur_1_100').scored, true);
  assert.equal(saved.get('tur_1_100').done, true);
  // Kayıtlı durum: bitti + puanlandı → bir daha bakılmaz
  item.state = saved.get('tur_1_100');
  await w.tick();
  assert.equal(finished.length, 1);
});

test('olay sesleri: her ses ayrı kanalda, geçerli türler için', () => {
  const types = Object.keys(SOUND_CHANNELS);
  assert.deepEqual([...types].sort(), ['full_time', 'goal', 'half_time', 'kickoff', 'penalty', 'red_card', 'second_half']);
  for (const t of types) assert.ok(NOTIFY_TYPES.includes(t), `${t} geçerli bir bildirim türü değil`);
  const ids = types.map((t) => SOUND_CHANNELS[t].channelId);
  const sounds = types.map((t) => SOUND_CHANNELS[t].sound);
  assert.equal(new Set(ids).size, ids.length, 'kanal kimlikleri benzersiz olmalı');
  assert.equal(new Set(sounds).size, sounds.length, 'ses dosyaları benzersiz olmalı');
  for (const id of ids) assert.match(id, /^ev_[a-z_]+_v\d+$/);
  for (const snd of sounds) assert.match(snd, /^snd_[a-z_]+$/); // Android kaynak adı: küçük harf, rakam, alt çizgi
  assert.ok(!ids.includes(DEFAULT_CHANNEL.channelId));
});

test('özel sesi olmayan türler varsayılan kanalı kullanır', () => {
  for (const t of ['var', 'goal_disallowed', 'added_time', 'bilinmeyen', undefined]) {
    assert.deepEqual(channelFor(t), DEFAULT_CHANNEL);
  }
  assert.equal(DEFAULT_CHANNEL.channelId, 'match_events');
});

test('FCM mesajı olay türüne göre kanal ve ses taşır', () => {
  const m = fcmMessage({ topic: 'tur_1_77_goal', title: 'GOL', body: '23\' Icardi', data: { matchKey: 'tur_1_77', type: 'goal' } });
  assert.equal(m.topic, 'tur_1_77_goal');
  assert.deepEqual(m.notification, { title: 'GOL', body: "23' Icardi" });
  assert.equal(m.data.type, 'goal');
  assert.equal(m.android.priority, 'high');
  assert.deepEqual(m.android.notification, { channelId: 'ev_goal_v1', sound: 'snd_goal' });

  const v = fcmMessage({ topic: 't', title: 'VAR', body: '', data: { type: 'var' } });
  assert.deepEqual(v.android.notification, { channelId: 'match_events', sound: 'default' });
  // veri olmasa da çökmez
  assert.equal(fcmMessage({ topic: 't', title: 'x', body: 'y' }).android.notification.channelId, 'match_events');
});

test('izleyici bildirimini olay türüyle gönderir (kanal seçimi için)', async () => {
  // evaluate çıktısındaki her tür, uygulamadaki bildirim türlerinden biri olmalı
  let r = evaluate(summary({ state: 'pre', name: 'STATUS_SCHEDULED', period: 0, clock: "0'" }), null);
  r = evaluate(summary({ state: 'in', clock: "1'" }), r.state);
  assert.equal(r.notes[0].type, 'kickoff');
  assert.equal(channelFor(r.notes[0].type).channelId, 'ev_kickoff_v1');
});
