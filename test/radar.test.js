import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RADAR,
  buildView,
  chanceIn,
  describe as describeSig,
  detectSignals,
  elapsedOf,
  notificationText,
  parseClock,
  playKind,
  pressureOf,
  readMatch,
  resolveSignal,
  shotXg,
  snapWindow,
  starsOf,
} from '../radar.js';
import { RadarService, alarmMatches, cleanRules, clockOf, inQuiet, localTime } from '../radar_service.js';
import { RADAR_CHANNEL, channelFor } from '../notify.js';

// ---------------------------------------------------------------------------------------------------
// Örnek maç özeti
// ---------------------------------------------------------------------------------------------------
const team = (id, n) => ({ id, displayName: n, shortDisplayName: n, abbreviation: n.slice(0, 3).toUpperCase(), logos: [{ href: `https://x/${id}.png` }] });
const stats = (poss, shots, sot, corners) => [
  { name: 'possessionPct', displayValue: String(poss) },
  { name: 'totalShots', displayValue: String(shots) },
  { name: 'shotsOnTarget', displayValue: String(sot) },
  { name: 'wonCorners', displayValue: String(corners) },
];
const H = 'Şanlıurfaspor';
const A = 'Gölcükspor';
function summary({ clock = "36'", period = 1, state = 'in', name, score = [0, 0], home = [63, 7, 3, 4], away = [37, 2, 0, 1], commentary = [], keyEvents = [], completed = false, box = true } = {}) {
  return {
    header: {
      competitions: [
        {
          status: { displayClock: clock, period, type: { state, completed, name: name ?? (period === 1 ? 'STATUS_FIRST_HALF' : 'STATUS_SECOND_HALF') } },
          competitors: [
            { homeAway: 'home', score: String(score[0]), team: team('1', H) },
            { homeAway: 'away', score: String(score[1]), team: team('2', A) },
          ],
        },
      ],
    },
    boxscore: box ? { teams: [{ team: { id: '1' }, statistics: stats(...home) }, { team: { id: '2' }, statistics: stats(...away) }] } : undefined,
    commentary,
    keyEvents,
  };
}
const c = (t, text) => ({ time: { displayValue: t }, text });
// Ev sahibinin 27-35. dakikalardaki baskısı: 4 şut (2 isabetli, biri çok yakından), 2 korner
const PRESS = [
  c("27'", `Attempt missed. Oyuncu A (${H}) right footed shot from outside the box misses to the left.`),
  c("29'", `Corner,  ${H}. Conceded by Defans.`),
  c("30'", `Attempt saved. Oyuncu B (${H}) header from the centre of the box is saved in the centre of the goal.`),
  c("32'", `Attempt blocked. Oyuncu C (${H}) left footed shot from the centre of the box is blocked.`),
  c("33'", `Attempt saved. Oyuncu D (${H}) right footed shot from very close range is saved in the bottom left corner.`),
  c("34'", `Corner,  ${H}. Conceded by Defans.`),
  c("35'", `Attempt missed. Oyuncu E (${A}) right footed shot from outside the box is too high.`),
];

// ---------------------------------------------------------------------------------------------------
// Saat ve şut değeri
// ---------------------------------------------------------------------------------------------------
test('maç saati oynanan dakikaya çevrilir (ilk yarının uzatması sayılır)', () => {
  assert.deepEqual(parseClock("45'+2'"), { base: 45, extra: 2 });
  assert.equal(elapsedOf(parseClock("36'"), 1, 47), 36);
  assert.equal(elapsedOf(parseClock("45'+3'"), 1, 48), 48);
  assert.equal(elapsedOf(parseClock("46'"), 2, 48), 49);
  assert.equal(elapsedOf(parseClock("90'+4'"), 2, 47), 96);
  assert.equal(clockOf(56, 47), "54'");
  assert.equal(clockOf(46, 47), "45+1'");
  assert.equal(clockOf(30, 47), "30'");
});

test('anlatımdaki şutun yeri ve türü gol beklentisini belirler', () => {
  assert.ok(shotXg('Attempt saved. X (T) right footed shot from very close range is saved.') > 0.4);
  assert.ok(shotXg('Attempt missed. X (T) header from the centre of the box misses.') < shotXg('Attempt missed. X (T) right footed shot from the centre of the box misses.'));
  assert.ok(shotXg('Attempt missed. X (T) right footed shot from outside the box is high.') < 0.05);
  assert.equal(shotXg('Penalty saved! X (T) fails to capitalise on this great opportunity, right footed shot saved.'), 0.76);
  assert.ok(shotXg('Attempt saved. X (T) left footed shot from the left side of the box following a fast break.') > shotXg('Attempt saved. X (T) left footed shot from the left side of the box.'));
  assert.equal(playKind('Attempt blocked. X (T) shot.'), 'shot');
  assert.equal(playKind('Attempt saved. X (T) shot.'), 'sot');
  assert.equal(playKind('Goal! T 1, U 0. X (T) shot.'), 'goal');
  assert.equal(playKind('Corner,  T. Conceded by Y.'), 'corner');
  assert.equal(playKind('Own Goal by Y, U.  T 1, U 0.'), 'own_goal');
  assert.equal(playKind('Foul by X (T).'), null);
});

// ---------------------------------------------------------------------------------------------------
// Maç okuma ve pencereler
// ---------------------------------------------------------------------------------------------------
test('özetten takımlar, toplamlar ve anlatım anları okunur', () => {
  const m = readMatch(summary({ commentary: PRESS }));
  assert.equal(m.e, 36);
  assert.equal(m.teams.home.name, H);
  assert.equal(m.totals.home.poss, 63);
  assert.equal(m.plays.length, 7);
  assert.ok(m.hasPlays);
  const view = buildView(m, []);
  assert.equal(view.w10.home.shots, 4);
  assert.equal(view.w10.home.sot, 2);
  assert.equal(view.w10.home.corners, 2);
  assert.equal(view.w10.away.shots, 1);
  assert.ok(view.w10.home.xg > 0.6);
  // Son 5 dk: 32-36
  assert.equal(view.w5.home.shots, 2);
  // Maç geneli şutlar kutu istatistiğinden
  assert.equal(view.total.home.shots, 7);
});

test('anlatım yoksa pencereler radarın kaydettiği toplamlardan çıkar (topa sahip olma payı dahil)', () => {
  const snaps = [
    { e: 25, totals: { home: { poss: 55, shots: 3, sot: 1, corners: 2 }, away: { poss: 45, shots: 2, sot: 0, corners: 1 } } },
    { e: 30, totals: { home: { poss: 57, shots: 5, sot: 2, corners: 3 }, away: { poss: 43, shots: 2, sot: 0, corners: 1 } } },
  ];
  const now = { e: 35, totals: { home: { poss: 60, shots: 8, sot: 4, corners: 4 }, away: { poss: 40, shots: 2, sot: 0, corners: 1 } } };
  const w = snapWindow(snaps, now, 10);
  assert.equal(w.home.shots, 5);
  assert.equal(w.home.sot, 3);
  assert.equal(w.home.corners, 2);
  // (60·35 − 55·25) / 10 = 72,5
  assert.equal(w.home.poss, 73);
  assert.equal(w.away.poss, 28);
  assert.ok(w.home.xg > 0.6);
  // Yeterli geçmiş yoksa pencere yok
  assert.equal(snapWindow([snaps[1]], now, 10), null);
});

// ---------------------------------------------------------------------------------------------------
// Baskı endeksi ve sinyaller
// ---------------------------------------------------------------------------------------------------
test('topa sahip olma + şut + xG birlikte yüksekse Gol Sireni çalar (yalnızca baskılı takım için)', () => {
  const m = readMatch(summary({ commentary: PRESS }));
  const view = buildView(m, []);
  const p = pressureOf(view, 'home');
  assert.ok(p.index >= RADAR.levels[2], `endeks ${p.index}`);
  assert.equal(pressureOf(view, 'away').index, 0);
  const sigs = detectSignals(m, view, [], { home: 1.5, away: 1.1 });
  const siren = sigs.find((s) => s.type === 'siren');
  assert.ok(siren);
  assert.equal(siren.side, 'home');
  assert.equal(siren.stars, 3);
  assert.equal(siren.target.kind, 'team_goal');
  assert.equal(siren.target.deadline, 56);
  assert.ok(siren.chance.p > siren.chance.base, 'baskı gol ihtimalini artırır');
  assert.ok(!sigs.some((s) => s.side === 'away'));
  const d = describeSig(siren, m.teams, m.score);
  assert.equal(d.subtitle, `${H}: 0-0'da baskı artıyor`);
});

test('yalnızca topla oynamak siren çaldırmaz', () => {
  const m = readMatch(summary({ home: [72, 3, 0, 1], away: [28, 2, 0, 0], commentary: [c("30'", `Attempt missed. X (${H}) right footed shot from outside the box misses.`)] }));
  const view = buildView(m, []);
  assert.ok(pressureOf(view, 'home').index < RADAR.levels[0]);
  assert.equal(detectSignals(m, view).length, 0);
});

test('topa sahip olma düşükse (kontra takımı) Gol Sireni çalmaz', () => {
  const m = readMatch(summary({ home: [38, 7, 3, 4], away: [62, 2, 0, 1], commentary: PRESS }));
  const view = buildView(m, []);
  assert.ok(!detectSignals(m, view).some((s) => s.type === 'siren'));
});

test('geride kalan takımın baskısı Geri Dönüş, 70. dakikadan sonra Son Dakika Baskısı olur', () => {
  const m1 = readMatch(summary({ commentary: PRESS, score: [0, 1] }));
  const s1 = detectSignals(m1, buildView(m1, []));
  assert.equal(s1.find((s) => s.side === 'home' && s.type !== 'corner').type, 'comeback');

  const late = PRESS.map((x) => ({ ...x, time: { displayValue: `${Number.parseInt(x.time.displayValue, 10) + 45}'` } }));
  const m2 = readMatch(summary({ clock: "81'", period: 2, commentary: late }), { h1: 47 });
  assert.equal(m2.e, 83);
  const s2 = detectSignals(m2, buildView(m2, []));
  const l = s2.find((s) => s.type === 'late');
  assert.ok(l);
  assert.ok(l.target.untilEnd);
});

test('ilk dakikalarda, devre arasında ve 3 farkla önde olan takıma sinyal yok', () => {
  const early = readMatch(summary({ clock: "8'", commentary: PRESS.map((x, i) => ({ ...x, time: { displayValue: `${i + 1}'` } })) }));
  assert.equal(detectSignals(early, buildView(early, [])).length, 0);
  const ht = readMatch(summary({ clock: 'HT', name: 'STATUS_HALFTIME', commentary: PRESS }));
  assert.equal(detectSignals(ht, buildView(ht, [])).length, 0);
  const big = readMatch(summary({ commentary: PRESS, score: [3, 0] }));
  assert.ok(!detectSignals(big, buildView(big, [])).some((s) => s.type === 'siren'));
});

test('aynı takıma açık sinyal varken ya da bekleme süresinde yeni sinyal verilmez', () => {
  const m = readMatch(summary({ commentary: PRESS }));
  const view = buildView(m, []);
  assert.ok(!detectSignals(m, view, [{ type: 'siren', side: 'home', e: 30, status: 'open' }]).some((s) => s.type === 'siren'));
  assert.ok(!detectSignals(m, view, [{ type: 'siren', side: 'home', e: 30, status: 'miss' }]).some((s) => s.type === 'siren'));
  assert.ok(detectSignals(m, view, [{ type: 'siren', side: 'home', e: 20, status: 'miss' }]).some((s) => s.type === 'siren'));
});

test('iki takım da gole yakınsa Karşılıklı Baskı (maçta gol hedefi)', () => {
  const both = [
    c("27'", `Attempt saved. X (${H}) right footed shot from the centre of the box is saved.`),
    c("29'", `Attempt missed. X (${A}) right footed shot from the centre of the box misses.`),
    c("30'", `Attempt saved. X (${A}) right footed shot from very close range is saved.`),
    c("31'", `Attempt saved. X (${H}) left footed shot from the left side of the box is saved.`),
    c("33'", `Attempt missed. X (${A}) header from the centre of the box misses.`),
    c("34'", `Attempt blocked. X (${H}) right footed shot from the centre of the box is blocked.`),
    c("35'", `Attempt missed. X (${H}) right footed shot from outside the box misses.`),
  ];
  const m = readMatch(summary({ home: [51, 6, 2, 1], away: [49, 5, 1, 1], commentary: both }));
  const sigs = detectSignals(m, buildView(m, []));
  const open = sigs.find((s) => s.type === 'open');
  assert.ok(open, JSON.stringify(sigs.map((s) => s.type)));
  assert.equal(open.side, null);
  assert.equal(open.target.kind, 'any_goal');
});

test('yıldızlar ve gol ihtimali', () => {
  assert.equal(starsOf(50), 0);
  assert.equal(starsOf(55), 1);
  assert.equal(starsOf(70), 2);
  assert.equal(starsOf(85), 3);
  const p20 = chanceIn(1.4 / 90, 30, 20);
  assert.ok(p20 > 0.2 && p20 < 0.35, String(p20));
  assert.ok(chanceIn(1.4 / 90, 30, 20, 1.6) > p20);
});

// ---------------------------------------------------------------------------------------------------
// Sonuç
// ---------------------------------------------------------------------------------------------------
const sigAt = (over = {}) => ({ type: 'siren', side: 'home', e: 36, score: { home: 0, away: 0 }, target: { kind: 'team_goal', side: 'home', minutes: 20, deadline: 56 }, ...over });

test('hedef süre içinde gol: tuttu; süre bitince: tutmadı; sonra gelen gol: geç gelen gol', () => {
  const goalAt = (clock, score) => readMatch(summary({ clock, period: 1, score, keyEvents: [{ type: { text: 'Goal' }, scoringPlay: true, team: { id: '1' }, clock: { displayValue: "43'" } }] }));
  assert.deepEqual(resolveSignal(sigAt(), goalAt("44'", [1, 0])), { status: 'hit', at: 7 });
  const open = readMatch(summary({ clock: "50'", period: 2 }), { h1: 47 });
  assert.equal(resolveSignal(sigAt(), open).status, 'open');
  const over = readMatch(summary({ clock: "60'", period: 2 }), { h1: 47 });
  assert.deepEqual(resolveSignal(sigAt(), over), { status: 'miss' });
  const late = readMatch(summary({ clock: "80'", period: 2, score: [1, 0], keyEvents: [{ type: { text: 'Goal' }, scoringPlay: true, team: { id: '1' }, clock: { displayValue: "79'" } }] }), { h1: 47 });
  assert.deepEqual(resolveSignal(sigAt(), late), { status: 'miss', late: 45 });
  // Rakibin golü takımın hedefini gerçekleştirmez
  const opp = readMatch(summary({ clock: "44'", score: [0, 1], keyEvents: [{ type: { text: 'Goal' }, scoringPlay: true, team: { id: '2' }, clock: { displayValue: "40'" } }] }));
  assert.equal(resolveSignal(sigAt(), opp).status, 'open');
  // Karşılıklı baskıda iki takımın golü de sayılır
  assert.equal(resolveSignal(sigAt({ side: null, target: { kind: 'any_goal', side: null, deadline: 51 } }), opp).status, 'hit');
});

test('olay saati yoksa radarın golü gördüğü an kullanılır; korner hedefi', () => {
  const m = readMatch(summary({ clock: "45'", score: [1, 0] }));
  assert.deepEqual(resolveSignal(sigAt(), m, { goalE: { home: [41], away: [] } }), { status: 'hit', at: 5 });
  const cs = sigAt({ type: 'corner', corners: 4, target: { kind: 'team_corner', side: 'home', minutes: 10, deadline: 46 } });
  const mc = readMatch(summary({ clock: "40'", home: [63, 7, 3, 5] }));
  assert.equal(resolveSignal(cs, mc, { cornerE: 39 }).status, 'hit');
});

test('bildirim metni: takım adı tek başına, dakika, son 10 dk verileri ve güç', () => {
  const m = readMatch(summary({ commentary: PRESS }));
  const view = buildView(m, []);
  const f = detectSignals(m, view).find((s) => s.type === 'siren');
  const d = describeSig(f, m.teams, m.score);
  const n = notificationText({ ...f, ...d, home: m.teams.home, away: m.teams.away, score: m.score, minuteLabel: "36'", view });
  assert.equal(n.title, `🚨 Gol Sireni · ${H}`);
  assert.match(n.body, /^36' Şanlıurfaspor 0-0 Gölcükspor/);
  assert.match(n.body, /4 şut \(2 isabetli\)/);
  assert.match(n.body, /topa sahip olma %63/);
  assert.match(n.body, /★★★ Çok güçlü baskı/);
  assert.doesNotMatch(n.title + n.body, /bahis|oran|kupon|espn/i);
});

// ---------------------------------------------------------------------------------------------------
// Alarm kuralları
// ---------------------------------------------------------------------------------------------------
test('sessiz saatler gece yarısını aşabilir; yerel saat dilimine göre', () => {
  const at = (h, m = 0) => Date.UTC(2026, 9, 29, h - 3, m); // Türkiye saati
  const a = { quiet: { on: true, from: '23:00', to: '08:00' }, tz: 180 };
  assert.ok(inQuiet(a, at(23, 30)));
  assert.ok(inQuiet(a, at(7, 59)));
  assert.ok(!inQuiet(a, at(8, 0)));
  assert.ok(!inQuiet({ ...a, quiet: { ...a.quiet, on: false } }, at(23, 30)));
  assert.ok(inQuiet({ quiet: { on: true, from: '00:00', to: '08:00' }, tz: 180 }, at(3)));
  assert.equal(localTime(at(1), 180).day, '2026-10-29');
});

test('alarm kuralları: tür, en az yıldız, lig ve takım', () => {
  const sig = { type: 'siren', stars: 2, league: 'tur.1', side: 'home', home: { id: '1' }, away: { id: '2' } };
  assert.ok(alarmMatches({ rules: [] }, sig)); // varsayılan: siren/geri dönüş/son dakika, ★★+
  assert.ok(!alarmMatches({ rules: [{ types: ['siren'], minStars: 3 }] }, sig));
  assert.ok(!alarmMatches({ rules: [{ types: ['corner'], minStars: 1 }] }, sig));
  assert.ok(alarmMatches({ rules: [{ types: ['siren'], minStars: 1, leagues: ['tur.1'] }] }, sig));
  assert.ok(!alarmMatches({ rules: [{ types: ['siren'], minStars: 1, leagues: ['eng.1'] }] }, sig));
  assert.ok(!alarmMatches({ rules: [{ types: ['siren'], minStars: 1, teams: ['2'] }] }, sig));
  assert.ok(alarmMatches({ rules: [{ types: ['siren'], minStars: 1, teams: ['1'] }] }, sig));
  assert.throws(() => cleanRules([{ types: [] }]), /en az bir/);
  assert.deepEqual(cleanRules([{ types: ['siren', 'x'], minStars: 9, leagues: ['tur.1', 'yok.9'] }])[0], { id: 'r1', types: ['siren'], minStars: 2, leagues: ['tur.1'], teams: [] });
});

test('radar bildirim kanalı uygulamadaki kanalla aynı', () => {
  assert.deepEqual(RADAR_CHANNEL, { channelId: 'ev_radar_v1', sound: 'snd_radar' });
  assert.deepEqual(channelFor('radar'), RADAR_CHANNEL);
});

// ---------------------------------------------------------------------------------------------------
// Servis: tarama, kayıt, yalnızca abonelere bildirim, kilit ve açma hakkı
// ---------------------------------------------------------------------------------------------------
function fakeStore({ alarms = [] } = {}) {
  const signals = new Map();
  const reveals = new Map();
  const alarmDocs = new Map(alarms.map((a) => [a.uid, a]));
  const stats = [];
  return {
    signals,
    stats,
    alarmDocs,
    async saveSignal(s) {
      signals.set(s.id, structuredClone(s));
    },
    async updateSignal(id, patch) {
      signals.set(id, { ...signals.get(id), ...structuredClone(patch) });
    },
    async getSignal(id) {
      return signals.get(id) ?? null;
    },
    async listSignalsSince() {
      return [];
    },
    async bumpStats(sig, hit) {
      stats.push({ id: sig.id, hit });
    },
    async getStats() {
      return [];
    },
    async listAlarms() {
      return [...alarmDocs.values()].filter((a) => a.enabled);
    },
    async getAlarm(uid) {
      return alarmDocs.get(uid) ?? null;
    },
    async saveAlarm(uid, data) {
      alarmDocs.set(uid, { ...(alarmDocs.get(uid) ?? {}), ...data });
    },
    async addToken(uid, token, tz, max, extra) {
      const cur = alarmDocs.get(uid) ?? { enabled: true };
      const next = { ...cur, tokens: [token, ...(cur.tokens ?? []).filter((t) => t !== token)].slice(0, max), tz, ...extra };
      alarmDocs.set(uid, next);
      return next;
    },
    async removeTokens(uid, tokens) {
      const a = alarmDocs.get(uid);
      if (a) a.tokens = a.tokens.filter((t) => !tokens.includes(t));
    },
    async getReveals(uid, week) {
      const r = reveals.get(uid);
      return r && r.week === week ? r.ids : [];
    },
    async addReveal(uid, week, id, limit) {
      const r = reveals.get(uid);
      const ids = r && r.week === week ? r.ids : [];
      if (ids.includes(id)) return ids;
      if (ids.length >= limit) return null;
      reveals.set(uid, { week, ids: [...ids, id] });
      return [...ids, id];
    },
  };
}

const TOKEN = (n) => `tok_${n}_${'x'.repeat(30)}`;

function setup({ subs = ['pro'], alarms, now = Date.UTC(2026, 9, 29, 15, 0) } = {}) {
  let clock = now;
  let json = summary({ commentary: PRESS });
  const pushes = [];
  const store = fakeStore({
    alarms: alarms ?? [
      { uid: 'pro', enabled: true, tokens: [TOKEN(1)], tz: 180, quiet: { on: false, from: '00:00', to: '08:00' }, dailyLimit: 10, rules: [] },
      { uid: 'free', enabled: true, tokens: [TOKEN(2)], tz: 180, quiet: { on: false, from: '00:00', to: '08:00' }, dailyLimit: 10, rules: [] },
    ],
  });
  const radar = new RadarService({
    store,
    espn: { getSummary: async () => json },
    access: {
      isSubscriber: async (uid) => subs.includes(uid),
      entitlement: async (uid) => ({ subscribed: subs.includes(uid), until: subs.includes(uid) ? clock + 86400e3 : null }),
    },
    plan: async () => [{ league: 'tur.1', id: '777', timestamp: now - 40 * 60e3 }],
    push: async (msg) => {
      pushes.push(msg);
      return { invalid: [] };
    },
    now: () => clock,
    log: { error() {} },
  });
  return {
    radar,
    store,
    pushes,
    set: (j) => (json = j),
    advance: (ms) => (clock += ms),
  };
}

test('servis: sinyali kaydeder ve bildirimi yalnızca PRO aboneye gönderir', async () => {
  const t = setup();
  await t.radar.tick();
  const saved = [...t.store.signals.values()];
  assert.ok(saved.some((s) => s.type === 'siren' && s.side === 'home'));
  assert.equal(t.pushes.length, 1);
  assert.deepEqual(t.pushes[0].tokens, [TOKEN(1)]);
  assert.equal(t.pushes[0].data.type, 'radar');
  assert.match(t.pushes[0].title, /Gol Sireni/);
  // Aynı turda tekrar sinyal ya da bildirim yok
  t.advance(60e3);
  await t.radar.tick();
  assert.equal(t.pushes.length, 1);
});

test('servis: sessiz saat ve günlük sınır bildirimi durdurur', async () => {
  const quiet = setup({ alarms: [{ uid: 'pro', enabled: true, tokens: [TOKEN(1)], tz: 180, quiet: { on: true, from: '17:00', to: '19:00' }, dailyLimit: 10, rules: [] }] });
  await quiet.radar.tick(); // 15:00 UTC = 18:00 Türkiye
  assert.equal(quiet.pushes.length, 0);
  const limited = setup({ alarms: [{ uid: 'pro', enabled: true, tokens: [TOKEN(1)], tz: 180, quiet: { on: false, from: '00:00', to: '08:00' }, dailyLimit: 5, rules: [] }] });
  limited.radar._sent.set('pro', { day: '2026-10-29', n: 5 });
  await limited.radar.tick();
  assert.equal(limited.pushes.length, 0);
});

test('servis: gol gelince sinyal (VAR ihtimaline karşı bir tur bekleyip) tuttu olarak kapanır', async () => {
  const t = setup();
  await t.radar.tick();
  const id = [...t.store.signals.values()].find((s) => s.type === 'siren').id;
  t.advance(4 * 60e3);
  t.set(summary({ clock: "41'", score: [1, 0], commentary: PRESS, keyEvents: [{ type: { text: 'Goal' }, scoringPlay: true, team: { id: '1' }, clock: { displayValue: "40'" } }] }));
  await t.radar.tick();
  assert.equal(t.store.signals.get(id).status, 'open');
  t.advance(2 * 60e3);
  await t.radar.tick();
  assert.equal(t.store.signals.get(id).status, 'hit');
  assert.equal(t.store.signals.get(id).at, 4);
  assert.ok(t.store.stats.some((s) => s.id === id && s.hit));
});

test('servis: abone olmayan süren sinyalin takımlarını görmez, haftalık hakla açar; sonuçlanan sinyal herkese açık', async () => {
  const t = setup({ subs: ['pro'] });
  t.radar.freeReveals = 1;
  await t.radar.tick();
  const free = await t.radar.feed({ uid: 'free' });
  const s = free.active.find((x) => x.type === 'siren');
  assert.equal(s.locked, true);
  assert.equal(s.home, undefined);
  assert.equal(s.view, undefined);
  assert.equal(free.reveals.left, 1);
  const pro = await t.radar.feed({ uid: 'pro' });
  assert.equal(pro.active.find((x) => x.id === s.id).locked, false);
  assert.equal(pro.active.find((x) => x.id === s.id).home.name, H);

  const opened = await t.radar.reveal({ uid: 'free', id: s.id });
  assert.equal(opened.signal.locked, false);
  assert.equal(opened.left, 0);
  assert.equal((await t.radar.feed({ uid: 'free' })).active.find((x) => x.id === s.id).locked, false);
  const other = (await t.radar.feed({ uid: 'free' })).active.find((x) => x.id !== s.id);
  if (other) await assert.rejects(() => t.radar.reveal({ uid: 'free', id: other.id }), (e) => e.code === 'subscription-required');
  await assert.rejects(() => t.radar.reveal({ uid: 'misafir', guest: true, id: s.id }), (e) => e.code === 'unauthenticated');
  assert.equal((await t.radar.feed({ uid: 'x', guest: true })).active.find((x) => x.id === s.id).locked, true);

  // Süre dolunca sinyal geçmişe düşer ve herkese açılır
  t.advance(25 * 60e3);
  t.set(summary({ clock: "62'", period: 2, commentary: [] }));
  await t.radar.tick();
  const after = await t.radar.feed({ uid: 'x', guest: true });
  const done = after.recent.find((x) => x.id === s.id);
  assert.equal(done.status, 'miss');
  assert.equal(done.locked, false);
  assert.equal(after.day.total >= 1, true);
});

test('servis: alarm ayarları doğrulanır, jeton kaydı abonelik bitişini saklar', async () => {
  const t = setup({ alarms: [] });
  const def = await t.radar.getAlarms({ uid: 'pro' });
  assert.equal(def.enabled, true);
  assert.equal(def.dailyLimit, 10);
  assert.deepEqual(def.quiet, { on: true, from: '00:00', to: '08:00' });
  await assert.rejects(() => t.radar.saveAlarms({ uid: 'pro', dailyLimit: 7 }), /Günlük sınır/);
  await assert.rejects(() => t.radar.saveAlarms({ uid: 'pro', quiet: { on: true, from: '25:00', to: '08:00' } }), /Sessiz/);
  const saved = await t.radar.saveAlarms({ uid: 'pro', dailyLimit: 0, rules: [{ types: ['siren', 'corner'], minStars: 1 }] });
  assert.equal(saved.dailyLimit, 0);
  assert.deepEqual(saved.rules[0].types, ['siren', 'corner']);
  await t.radar.registerToken({ uid: 'pro', token: TOKEN(9), tz: 180 });
  const doc = t.store.alarmDocs.get('pro');
  assert.deepEqual(doc.tokens, [TOKEN(9)]);
  assert.ok(doc.subUntil > Date.UTC(2026, 9, 29));
  await assert.rejects(() => t.radar.registerToken({ uid: 'pro', token: 'kısa' }), /jeton/);
  await assert.rejects(() => t.radar.getAlarms({ uid: 'm', guest: true }), (e) => e.code === 'unauthenticated');
  // Sınırsız ve korner dahil kural: yeni turda bildirim gider
  await t.radar.tick();
  assert.ok(t.pushes.length >= 1);
  assert.deepEqual(t.pushes[0].tokens, [TOKEN(9)]);
});

test('ilk yarıdaki sinyalin süresi devreyi aşarsa ilk yarının uzatması süreye eklenir (saatle 36+20 = 56)', () => {
  const goal = (clock) =>
    readMatch(summary({ clock, period: 2, score: [1, 0], keyEvents: [{ type: { text: 'Goal' }, scoringPlay: true, team: { id: '1' }, clock: { displayValue: clock } }] }), { h1: 48 });
  // 54. dakika: oynanan dakika 48 + 9 = 57 > 56, ama uzatma eklenince süre 59'a kadar
  assert.equal(resolveSignal(sigAt(), goal("54'")).status, 'hit');
  assert.equal(resolveSignal(sigAt(), goal("58'")).status, 'miss');
});

test('takım yeni gol attıysa (son 4 dk) ona sinyal verilmez', () => {
  const withGoal = [...PRESS, c("34'", `Goal! ${H} 1, ${A} 0. Oyuncu F (${H}) right footed shot from the centre of the box.`)];
  const m = readMatch(summary({ commentary: withGoal, score: [1, 0] }));
  assert.ok(!detectSignals(m, buildView(m, [])).some((s) => s.side === 'home'));
  const later = readMatch(summary({ clock: "40'", commentary: withGoal.map((x) => x), score: [1, 0] }));
  // 6 dk sonra baskı sürüyorsa yeniden çıkabilir (pencere hâlâ doluysa)
  assert.ok(Array.isArray(detectSignals(later, buildView(later, []))));
});
