// Canlı tahmin uç noktası ve canlı ayrıştırma (şut, kırmızı kart, devre).
import test from 'node:test';
import assert from 'node:assert/strict';

import { LiveForecastService } from '../live_forecast.js';
import { parseLive, liveProbabilities } from '../assistant.js';
import { NOW } from './helpers.js';

const summary = ({ minute = 63, period = 2, home = 1, away = 0, state = 'in', name = 'STATUS_SECOND_HALF', shots = [12, 4], sot = [5, 1], redAway = false } = {}) => ({
  header: {
    competitions: [
      {
        status: { displayClock: `${minute}'`, period, type: { state, name } },
        competitors: [
          { homeAway: 'home', score: String(home), team: { id: '10' } },
          { homeAway: 'away', score: String(away), team: { id: '20' } },
        ],
      },
    ],
  },
  boxscore: {
    teams: [
      { team: { id: '10' }, statistics: [{ name: 'totalShots', displayValue: String(shots[0]) }, { name: 'shotsOnTarget', displayValue: String(sot[0]) }] },
      { team: { id: '20' }, statistics: [{ name: 'totalShots', displayValue: String(shots[1]) }, { name: 'shotsOnTarget', displayValue: String(sot[1]) }] },
    ],
  },
  keyEvents: redAway ? [{ type: { text: 'Red Card' }, redCard: true, team: { id: '20' }, clock: { displayValue: "40'" } }] : [],
});

const match = { league: 'tur.1', id: '77', homeId: '10', awayId: '20', homeName: 'Ev', awayName: 'Dep', timestamp: NOW - 63 * 60e3, completed: false };
const model = { lambdaHome: 1.5, lambdaAway: 1.1, sigma: 0.15 };

function make({ json = summary(), m = match, now = NOW } = {}) {
  const calls = { summary: 0, model: 0 };
  const paid = {
    validate() {},
    async findMatch() {
      return m;
    },
    async contentFor() {
      calls.model++;
      return { model };
    },
    async modelFor(_m, content) {
      return content.model;
    },
    espn: {
      async getSummary() {
        calls.summary++;
        return typeof json === 'function' ? json() : json;
      },
    },
  };
  let t = now;
  const svc = new LiveForecastService({ paid, now: () => t });
  return { svc, calls, advance: (ms) => (t += ms) };
}

const args = { uid: 'u', league: 'tur.1', eventId: '77', kickoff: new Date(match.timestamp).toISOString() };

test('canlı ayrıştırma: devre, şutlar ve kırmızı kartlar okunur', () => {
  const live = parseLive(summary({ redAway: true }));
  assert.equal(live.period, 2);
  assert.deepEqual(live.stats, { home: { shots: 12, onTarget: 5 }, away: { shots: 4, onTarget: 1 } });
  assert.deepEqual(live.reds, [0, 1]);
  // Devre bilgisi yoksa durum adından
  const s = summary();
  delete s.header.competitions[0].status.period;
  assert.equal(parseLive(s).period, 2);
  // İstatistik yoksa şut verisi null
  const bare = summary();
  delete bare.boxscore;
  assert.equal(parseLive(bare).stats, null);
});

test('uç nokta: kalan süre ihtimalleri, skor böyle biter, sıradaki gol ve en olası 3 final', async () => {
  const { svc } = make();
  const r = await svc.forecast(args);
  assert.equal(r.available, true);
  assert.equal(r.minute, 63);
  assert.deepEqual(r.score, { home: 1, away: 0 });
  const p = r.probabilities;
  assert.equal(p.home + p.draw + p.away, 100);
  assert.equal(r.nextGoal.home + r.nextGoal.away + r.nextGoal.none, 100);
  assert.equal(r.stay + r.moreGoals, 100);
  assert.equal(r.topFinals.length, 3);
  assert.equal(r.topFinals[0].score, '1-0');
  assert.equal(r.evidence.source, 'shots');
  // Asistanla aynı sayılar
  const a = liveProbabilities(model, parseLive(summary()));
  assert.ok(Math.abs(r.probabilities.home - a.p1 * 100) <= 1);
  assert.ok(Math.abs(r.stay - a.noMoreGoals * 100) <= 0.5 + 1e-9);
});

test('uç nokta: 15 sn önbellek, aynı anda gelen istekler tek hesap; maç öncesi güç bir kez hesaplanır', async () => {
  const { svc, calls, advance } = make();
  await Promise.all([svc.forecast(args), svc.forecast(args), svc.forecast(args)]);
  assert.equal(calls.summary, 1);
  await svc.forecast(args);
  assert.equal(calls.summary, 1);
  advance(16e3);
  await svc.forecast(args);
  assert.equal(calls.summary, 2);
  assert.equal(calls.model, 1);
});

test('uç nokta: maç başlamadıysa hata, bittiyse ya da devre bilgisi yoksa "kullanılamaz", giriş şart', async () => {
  const future = make({ m: { ...match, timestamp: NOW + 3600e3 } });
  await assert.rejects(() => future.svc.forecast(args), { code: 'failed-precondition' });
  const post = make({ json: summary({ state: 'post', name: 'STATUS_FULL_TIME' }) });
  assert.equal((await post.svc.forecast(args)).available, false);
  const { svc } = make();
  await assert.rejects(() => svc.forecast({ ...args, uid: null }), { code: 'permission-denied' });
});

test('kırmızı kart gören deplasman: ev sahibinin ihtimali artar', async () => {
  const a = await make().svc.forecast(args);
  const b = await make({ json: summary({ redAway: true }) }).svc.forecast(args);
  assert.ok(b.probabilities.home > a.probabilities.home);
  assert.deepEqual(b.reds, [0, 1]);
});
