// Tahmin karnesi: kayıt, sonuçlandırma, Brier, kalibrasyon ve yalnızca maç öncesi tahminlerin sayılması.
import test from 'node:test';
import assert from 'node:assert/strict';

import { pendingEntry, resolveEntry, summarize, TrackService, TRACK_MIN_SAMPLE } from '../track.js';
import { NOW } from './helpers.js';

const ai = { pick: '1', probabilities: { home: 60, draw: 25, away: 15 }, topScore: '2-1' };
const entry = (over = {}) => ({
  key: 'tur_1_1',
  league: 'tur.1',
  eventId: '1',
  kickoffMs: NOW + 3600e3,
  homeName: 'Ev',
  awayName: 'Dep',
  ai,
  ...over,
});

const completedJson = (h, a) => ({
  header: {
    competitions: [
      {
        date: new Date(NOW).toISOString(),
        status: { type: { state: 'post', completed: true, name: 'STATUS_FULL_TIME' } },
        competitors: [
          { homeAway: 'home', score: String(h), team: { id: '1', displayName: 'Ev' } },
          { homeAway: 'away', score: String(a), team: { id: '2', displayName: 'Dep' } },
        ],
      },
    ],
  },
});

test('bekleyen kayıt: olasılıklar 1/X/2 anahtarlarıyla saklanır', () => {
  const e = pendingEntry(entry());
  assert.deepEqual(e.probs, { '1': 60, X: 25, '2': 15 });
  assert.equal(e.pick, '1');
  assert.equal(e.topScore, '2-1');
});

test('eksik ya da bozuk içerik kayda girmez', () => {
  assert.equal(pendingEntry(entry({ ai: null })), null);
  assert.equal(pendingEntry(entry({ ai: { ...ai, probabilities: { home: 60, draw: null, away: 15 } } })), null);
  assert.equal(pendingEntry(entry({ ai: { ...ai, topScore: undefined } })), null);
});

test('sonuç: isabet, tam skor ve Brier (0 en iyi, 2 en kötü)', () => {
  const e = pendingEntry(entry());
  const win = resolveEntry(e, { home: 2, away: 1 }, NOW);
  assert.equal(win.outcome, '1');
  assert.equal(win.outcomeHit, true);
  assert.equal(win.scoreHit, true);
  assert.equal(win.actual.score, '2-1');
  // (0,6-1)² + (0,25)² + (0,15)² = 0,16 + 0,0625 + 0,0225 = 0,245
  assert.ok(Math.abs(win.brier - 0.245) < 0.01, `brier ${win.brier}`);

  const lose = resolveEntry(e, { home: 0, away: 3 }, NOW);
  assert.equal(lose.outcome, '2');
  assert.equal(lose.outcomeHit, false);
  assert.equal(lose.scoreHit, false);
  assert.ok(lose.brier > win.brier);
});

test('beraberlik sonucu X olarak okunur', () => {
  const r = resolveEntry(pendingEntry(entry()), { home: 1, away: 1 }, NOW);
  assert.equal(r.outcome, 'X');
  assert.equal(r.outcomeHit, false);
});

test('karne: oranlar, az veri uyarısı ve son tahminler', () => {
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push(resolveEntry(pendingEntry(entry({ key: `k${i}`, kickoffMs: NOW - i * 1000 })), { home: 2, away: 1 }, NOW));
  const s = summarize(rows);
  assert.equal(s.n, 4);
  assert.equal(s.outcomeAccuracy, 100);
  assert.equal(s.exactAccuracy, 100);
  assert.equal(s.sufficient, false, 'az maçta yeterli değil');
  assert.equal(s.streak, 4);
  assert.equal(s.recent.length, 4);
  assert.equal(s.recent[0].key, 'k0', 'en yeni önce');
  assert.equal(s.brierBaseline, 0.67);
});

test('boş karne güvenli döner', () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.outcomeAccuracy, null);
  assert.deepEqual(s.calibration, []);
});

test('kalibrasyon: olasılık kovaları ile gerçekleşme oranı', () => {
  // 60'lık tahmin 1 kez tuttu, bir kez tutmadı: 60'lık kovada ortalama tahmin 60, gerçekleşme %50 (1 sonuç 2 maçta bu kovada).
  const hit = resolveEntry(pendingEntry(entry({ key: 'a' })), { home: 2, away: 1 }, NOW);
  const miss = resolveEntry(pendingEntry(entry({ key: 'b', kickoffMs: NOW - 1 })), { home: 0, away: 1 }, NOW);
  const s = summarize([hit, miss]);
  const bin = s.calibration.find((b) => b.from === 60);
  assert.ok(bin, '60-70 kovası var');
  assert.equal(bin.n, 2);
  assert.equal(bin.predicted, 60);
  assert.equal(bin.observed, 50);
  const total = s.calibration.reduce((t, b) => t + b.n, 0);
  assert.equal(total, 6, 'her maç üç sonuç noktası üretir');
});

test('kalibrasyonda 100 olasılık son kovaya girer', () => {
  const e = pendingEntry(entry({ ai: { pick: '1', probabilities: { home: 100, draw: 0, away: 0 }, topScore: '1-0' } }));
  const s = summarize([resolveEntry(e, { home: 1, away: 0 }, NOW)]);
  assert.ok(s.calibration.some((b) => b.from === 90));
});

test('TrackService: maç öncesi kayıt, bitince sonuçlanır ve önbellekten döner', async () => {
  const pending = new Map();
  const resolved = new Map();
  const store = {
    async createPending(e) {
      if (resolved.has(e.key) || pending.has(e.key)) return false;
      pending.set(e.key, e);
      return true;
    },
    async listPendingBefore(cutoff, limit) {
      return [...pending.values()].filter((p) => p.kickoffMs <= cutoff).slice(0, limit);
    },
    async deletePending(key) {
      pending.delete(key);
    },
    async saveResolved(r) {
      resolved.set(r.key, r);
      pending.delete(r.key);
    },
    async listResolved() {
      return [...resolved.values()];
    },
  };
  let now = NOW;
  const espn = { async getSummary() { return completedJson(2, 1); } };
  const svc = new TrackService({ store, espn, now: () => now });

  assert.equal(await svc.recordPending(pendingEntry(entry({ kickoffMs: NOW - 200 * 60e3 }))), true);
  assert.equal(await svc.recordPending(pendingEntry(entry({ kickoffMs: NOW - 200 * 60e3 }))), false, 'aynı maç ikinci kez yazılmaz');

  const done = await svc.resolveDue();
  assert.equal(done, 1);
  const rec = await svc.trackRecord({ uid: 'user_one' });
  assert.equal(rec.n, 1);
  assert.equal(rec.outcomeAccuracy, 100);
  // Önbellek: yeni sonuç eklense bile süre dolmadan aynı karne döner (sonuç işi önbelleği temizler).
  now += 1000;
  assert.equal(await svc.trackRecord({ uid: 'user_one' }), rec);
});

test('TrackService: uid yoksa karne verilmez', async () => {
  const svc = new TrackService({ store: { listResolved: async () => [] }, espn: {} });
  await assert.rejects(() => svc.trackRecord({}), { code: 'permission-denied' });
});

test('TrackService: ertelenen ya da çok uzun süredir bitmeyen maç karneye girmez', async () => {
  const pending = new Map([['old', { key: 'old', league: 'tur.1', eventId: '9', kickoffMs: NOW - 4 * 86400e3 }]]);
  const store = {
    async listPendingBefore() {
      return [...pending.values()];
    },
    async deletePending(key) {
      pending.delete(key);
    },
    async saveResolved() {
      throw new Error('karneye girmemeli');
    },
  };
  const espn = { async getSummary() { return { header: { competitions: [{ status: { type: { state: 'pre', completed: false } }, competitors: [] }] } }; } };
  const svc = new TrackService({ store, espn, now: () => NOW });
  assert.equal(await svc.resolveDue(), 0);
  assert.equal(pending.size, 0, 'bekleyen kayıt temizlenir');
});

test('TrackService: bitmemiş eski kayıtlar listenin başında takılı kalsa da yeni biten maç sonuçlanır', async () => {
  let now = NOW;
  const pending = new Map();
  for (let i = 0; i < 50; i++) pending.set(`s${i}`, { key: `s${i}`, league: 'tur.1', eventId: `s${i}`, kickoffMs: NOW - 86400e3 + i, probs: { '1': 40, X: 30, '2': 30 }, pick: '1', topScore: '1-0' });
  pending.set('bitti', { key: 'bitti', league: 'tur.1', eventId: 'bitti', kickoffMs: NOW - 3 * 3600e3, probs: { '1': 40, X: 30, '2': 30 }, pick: '1', topScore: '1-0' });
  const saved = [];
  const store = {
    async listPendingBefore(cutoff, limit) {
      return [...pending.values()].filter((p) => p.kickoffMs <= cutoff).sort((a, b) => a.kickoffMs - b.kickoffMs).slice(0, limit);
    },
    async deletePending(key) { pending.delete(key); },
    async saveResolved(r) { saved.push(r); pending.delete(r.key); },
  };
  const notStarted = { header: { competitions: [{ status: { type: { state: 'in', completed: false } }, competitors: [] }] } };
  const espn = { async getSummary(lg, id) { return id === 'bitti' ? completedJson(2, 1) : notStarted; } };
  const svc = new TrackService({ store, espn, now: () => now });
  await svc.resolveDue({ limit: 40 });
  now += 10 * 60e3;
  await svc.resolveDue({ limit: 40 });
  assert.deepEqual(saved.map((r) => r.key), ['bitti']);
});

test('TRACK_MIN_SAMPLE: az veri eşiği makul', () => {
  assert.ok(TRACK_MIN_SAMPLE >= 20);
});

test('içerik üretimi: maç öncesi bekleyen tahmin yazılır; bitmiş maçta yazılmaz', async () => {
  const { PaidContentService } = await import('../logic.js');
  const { makeStore, makeEspn, fixture, finished, FUTURE } = await import('./helpers.js');
  const recorded = [];
  const track = { async recordPending(e) { recorded.push(e); return true; } };

  const pre = new PaidContentService({ leagues: ['demo.1'], store: makeStore(300), espn: makeEspn(), now: () => NOW, track });
  await pre.contentFor({ league: fixture.league, id: fixture.eventId, timestamp: FUTURE, homeId: '1001', awayId: '1002', homeName: 'Demo Ev FK', awayName: 'Demo Dep SK' });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kickoffMs, FUTURE);
  assert.deepEqual(Object.keys(recorded[0].probs).sort(), ['1', '2', 'X']);

  const after = [];
  const post = new PaidContentService({ leagues: ['demo.1'], store: makeStore(300), espn: makeEspn(), now: () => FUTURE + 3600e3, track: { recordPending: async (e) => after.push(e) } });
  await post.contentFor({ league: finished.league, id: finished.eventId, timestamp: Date.parse(finished.kickoff), homeId: '1003', awayId: '1004', homeName: 'Demo Takım 3', awayName: 'Demo Takım 4' });
  assert.equal(after.length, 0, 'maç bittikten sonra üretilen içerik karneye girmez');
});

// ---- Sonuçlanan listesi hükümleri ----
import { verdictOf, SURPRISE_PCT, TrackService as TS2 } from '../track.js';

test('hüküm: tutan tahmin, gerçek sonucun maç öncesi yüzdesi ve sürpriz', () => {
  const hit = verdictOf({ pick: '1', outcome: '1', outcomeHit: true, scoreHit: false, probs: { '1': 55, X: 25, '2': 20 } });
  assert.deepEqual(hit, { pick: '1', outcome: '1', hit: true, scoreHit: false, pct: 55, surprise: false });
  const shock = verdictOf({ pick: '1', outcome: '2', outcomeHit: false, scoreHit: false, probs: { '1': 60, X: 22, '2': 18 } });
  assert.equal(shock.hit, false);
  assert.equal(shock.pct, 18);
  assert.equal(shock.surprise, 18 < SURPRISE_PCT);
});

test('hükümler: yalnızca sonuçlanmış maçlar döner; geçersiz liste ve girişsiz kullanıcı reddedilir', async () => {
  const rows = [{ key: 'tur_1_1', pick: 'X', outcome: 'X', outcomeHit: true, scoreHit: true, probs: { '1': 40, X: 30, '2': 30 } }];
  let asked = null;
  const svc = new TS2({ store: { getResolvedMany: async (keys) => { asked = keys; return rows; } }, espn: {} });
  const r = await svc.verdicts({ uid: 'u', keys: ['tur_1_1', 'tur_1_2', 'tur_1_1'] });
  assert.deepEqual(asked, ['tur_1_1', 'tur_1_2']);
  assert.deepEqual(Object.keys(r.verdicts), ['tur_1_1']);
  assert.equal(r.verdicts.tur_1_1.scoreHit, true);
  await assert.rejects(svc.verdicts({ uid: 'u', keys: ['kötü/anahtar'] }), { code: 'invalid-argument' });
  await assert.rejects(svc.verdicts({ uid: 'u', keys: Array.from({ length: 101 }, (_, i) => `k${i}`) }), { code: 'invalid-argument' });
  await assert.rejects(svc.verdicts({ uid: null, keys: [] }), { code: 'permission-denied' });
});
