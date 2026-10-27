// Tahmin motoru testleri: lig geneli güç, belirsizlik, skor tutarlılığı, simülasyon hedefi, lig verisi çekme.
import test from 'node:test';
import assert from 'node:assert/strict';

import { fitRatings, ratingLambdas, crossRatingLambdas } from '../engine/ratings.js';
import { MODEL } from '../engine/config.js';
import { makeSyntheticLeague, walkForward } from '../engine/backtest.js';
import { scoreMatrix, matchProbabilities, scoresForOutcome } from '../engine/analysis.js';
import { simulateToScore } from '../engine/simulator.js';
import { EspnClient } from '../engine/espn.js';
import { MatchSimulator } from '../engine/service.js';
import { TeamMemory } from '../engine/memory.js';
import { buildAi, buildOdds, buildSim, predictedOutcome, predictedScore, pickSimTarget } from '../content.js';

const DAY = 86400000;
const corr = (a, b) => {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
};

test('lig gücü: gerçek hücum/savunma ve ev avantajı yeniden bulunur, ham gol ortalamasından daha iyi', () => {
  const { matches, truth } = makeSyntheticLeague({ seed: 'dogrulama' });
  const now = matches.at(-1).timestamp + DAY;
  const r = fitRatings(matches, { now });
  const ids = truth.map((t) => t.id);
  const fitAtt = ids.map((id) => Math.log(r.teams.get(id).att));
  const fitDef = ids.map((id) => Math.log(r.teams.get(id).def));
  assert.ok(corr(fitAtt, truth.map((t) => Math.log(t.att))) > 0.85, 'hücum gücü gerçeğe yakın olmalı');
  assert.ok(corr(fitDef, truth.map((t) => Math.log(t.def))) > 0.8, 'savunma gücü gerçeğe yakın olmalı');
  // ev/deplasman: gerçek 1.17 / 0.90
  assert.ok(Math.abs(r.homeF - 1.17) < 0.08 && Math.abs(r.awayF - 0.9) < 0.08, `ev ${r.homeF.toFixed(2)} dep ${r.awayF.toFixed(2)}`);
  // ham: takımın attığı gol ortalaması rakip kalitesini bilmez
  const raw = ids.map((id) => {
    const mine = matches.filter((m) => m.homeId === id || m.awayId === id);
    return mine.reduce((s, m) => s + (m.homeId === id ? m.homeGoals : m.awayGoals), 0) / mine.length;
  });
  assert.ok(corr(fitAtt, truth.map((t) => Math.log(t.att))) >= corr(raw, truth.map((t) => Math.log(t.att))) - 0.01);
});

test('lig gücü: az veri ya da bilinmeyen takım için null döner (eski yönteme geçilir)', () => {
  assert.equal(fitRatings([], {}), null);
  const { matches } = makeSyntheticLeague({ seed: 'x' });
  const r = fitRatings(matches, { now: matches.at(-1).timestamp + DAY, newTeam: null });
  assert.equal(ratingLambdas(r, '100', 'yok'), null);
  assert.equal(ratingLambdas(null, '100', '101'), null);
  // gelecekteki maçlar kullanılmaz
  const early = fitRatings(matches, { now: matches[0].timestamp + DAY });
  assert.equal(early, null);
});

test('lig gücü: ligde yeni takım zayıf merkeze çekilir, sezonun ilk maçında bile tahmin edilir', () => {
  const { matches } = makeSyntheticLeague({ seed: 'x' });
  const now = matches.at(-1).timestamp + DAY;
  const nt = { days: 300, att: 0.9, def: 1.1 };
  const r = fitRatings(matches, { now, newTeam: nt });
  // hiç maçı olmayan takım: merkezden
  const first = ratingLambdas(r, '100', 'yeni', { minWeightNew: 0 });
  assert.ok(first && first.newAway && first.away.attack === 0.9 && first.away.defense === 1.1);
  assert.equal(ratingLambdas(r, '100', 'yeni', { minWeightNew: 1 }), null, 'eşik üstünde değilse eski yönteme dönülür');
  // az maçla yeni takım: ön bilgi lig ortalamasına değil zayıf merkeze çeker
  const t0 = now - 20 * DAY;
  const extra = [0, 1, 2].map((i) => ({ id: `n${i}`, timestamp: t0 + i * 3 * DAY, homeId: 'yeni', awayId: String(100 + i), homeGoals: 1, awayGoals: 1 }));
  const withNew = fitRatings([...matches, ...extra], { now, newTeam: nt });
  const plain = fitRatings([...matches, ...extra], { now, newTeam: null });
  assert.ok(withNew.teams.get('yeni').isNew);
  assert.ok(withNew.teams.get('yeni').att < plain.teams.get('yeni').att);
  assert.ok(withNew.teams.get('yeni').def > plain.teams.get('yeni').def);
  // yeni takım değil: uzun süredir ligde olan takım etkilenmez
  assert.equal(withNew.teams.get('100').isNew, false);
  // üst ligden düşen takım için ayrı merkez
  const down = fitRatings([...matches, ...extra], { now, newTeam: { ...nt, center: (id) => (id === 'yeni' ? { att: 1.2, def: 0.85 } : null) } });
  assert.ok(down.teams.get('yeni').att > plain.teams.get('yeni').att);
});

test('ligler arası: güçlü ligin takımı lig katsayısı oranında öne geçer; aynı güçte lig farkı yok', () => {
  const { matches } = makeSyntheticLeague({ seed: 'x' });
  const now = matches.at(-1).timestamp + DAY;
  const r = fitRatings(matches, { now, newTeam: null });
  const same = ratingLambdas(r, '100', '101');
  const eq = crossRatingLambdas({ ratings: r, id: '100', strength: 0.8 }, { ratings: r, id: '101', strength: 0.8 });
  assert.ok(Math.abs(eq.lh - same.lh) < 1e-9 && Math.abs(eq.la - same.la) < 1e-9 && eq.leagueRatio === 1);
  const strong = crossRatingLambdas({ ratings: r, id: '100', strength: 1.0 }, { ratings: r, id: '101', strength: 0.8 }, { strengthExp: 1.4 });
  assert.ok(Math.abs(strong.leagueRatio - 1.25 ** 1.4) < 1e-9);
  // hiçbir ligde bulunamayan takım (ör. amatör kulüp) dışarıdan verilen güçle
  const amateur = crossRatingLambdas({ ratings: r, id: '100', strength: 1 }, { ratings: r, team: { att: 1, def: 1 }, strength: 0.4 });
  assert.ok(amateur.virtualAway && amateur.leagueRatio > 3);
  // tarafsız saha: ev avantajı yok
  const n = crossRatingLambdas({ ratings: r, id: '100', strength: 0.8 }, { ratings: r, id: '100', strength: 0.8 }, { neutral: true });
  assert.ok(Math.abs(n.lh - n.la) < 1e-9);
});

test('yürüyen deneme: yeni yöntem eskisinden iyi olasılık üretir ve tahminle skor hep tutarlıdır', () => {
  const total = { old: 0, neu: 0, n: 0, cOld: 0, cNew: 0 };
  for (const seed of ['t1', 't2', 't3']) {
    const { matches } = makeSyntheticLeague({ seed });
    const rep = walkForward(matches, {
      from: matches[0].timestamp + 400 * DAY,
      variants: {
        old: { ratings: false, uncertainty: false, venueAdjust: false },
        neu: { ratings: true, uncertainty: true, consistentScore: true },
      },
    });
    total.old += rep.results.old.rps * rep.results.old.n;
    total.neu += rep.results.neu.rps * rep.results.neu.n;
    total.n += rep.results.neu.n;
    total.cOld += rep.results.old.scoreConsistent * rep.results.old.n;
    total.cNew += rep.results.neu.scoreConsistent * rep.results.neu.n;
  }
  assert.ok(total.neu / total.n < total.old / total.n, `yeni ${(total.neu / total.n).toFixed(4)} eski ${(total.old / total.n).toFixed(4)}`);
  assert.equal(total.cNew / total.n, 1);
  assert.ok(total.cOld / total.n < 0.7, 'eski yöntemde tahminle skor sık sık çelişiyordu');
});

test('belirsizlik katmanı: olasılıklar toplamı 1, ortalama gol korunur, aşırı iddialılık azalır', () => {
  const m = scoreMatrix(2.2, 0.8, -0.06, 10, 0.2);
  let sum = 0, eh = 0, ea = 0;
  m.forEach((row, i) => row.forEach((p, j) => { sum += p; eh += p * i; ea += p * j; }));
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(Math.abs(eh - 2.2) < 0.05 && Math.abs(ea - 0.8) < 0.05, `${eh} ${ea}`);
  const sharp = matchProbabilities(2.2, 0.8, 0);
  const soft = matchProbabilities(2.2, 0.8, 0.2);
  assert.ok(soft.homeWin < sharp.homeWin, 'büyük favori olasılığı biraz azalmalı');
  assert.ok(soft.awayWin > sharp.awayWin, 'sürpriz ihtimali artmalı');
  // sigma 0 = eski davranış
  assert.deepEqual(scoreMatrix(1.4, 1.1), scoreMatrix(1.4, 1.1, MODEL.dcRho, 10, 0));
});

test('en olası skor tahminle hiçbir λ kombinasyonunda çelişmez', () => {
  for (let lh = 0.6; lh <= 3; lh += 0.2) {
    for (let la = 0.5; la <= 2.4; la += 0.2) {
      const analysis = { home: { name: 'A' }, away: { name: 'B' }, lambdaHome: lh, lambdaAway: la, sigma: 0.18, probabilities: matchProbabilities(lh, la, 0.18) };
      const pick = predictedOutcome(analysis);
      const s = predictedScore(analysis);
      const o = s.home > s.away ? '1' : s.home < s.away ? '2' : 'X';
      assert.equal(o, pick, `λ ${lh.toFixed(1)}-${la.toFixed(1)}`);
    }
  }
});

function analysisFor(lh, la, name = ['Ev', 'Dep']) {
  const sigma = 0.18;
  const mk = (n, id) => ({ id, name: n, profile: { form: { string: 'GBG', points: 7, matches: 3 }, goalsForPerGame: 1.5, goalsAgainstPerGame: 1.1, rank: null, ppg: null } });
  return { home: mk(name[0], '1'), away: mk(name[1], '2'), lambdaHome: lh, lambdaAway: la, sigma, probabilities: matchProbabilities(lh, la, sigma), h2h: { n: 0 }, dataQuality: { homeMatches: 20, awayMatches: 20, h2hMatches: 0, confidence: 'yüksek' } };
}

test('AI analizi: topScore tahminle uyumlu ve odds.predictedScore ile aynı', () => {
  for (const [lh, la] of [[1.3, 1.2], [2.0, 0.8], [0.9, 1.6], [1.1, 1.05]]) {
    const a = analysisFor(lh, la);
    const ai = buildAi(a);
    const odds = buildOdds(a);
    assert.equal(ai.topScore, odds.predictedScore);
    const [h, d] = ai.topScore.split('-').map(Number);
    assert.equal(h > d ? '1' : h < d ? '2' : 'X', ai.pick);
    assert.ok(ai.sections.some((s) => s.text.includes(`Tahmin edilen skor ${ai.topScore}`)));
  }
});

test('simülasyon: hedef skorla biter, aynı tohum aynı sonuç, sonuç AI tahminiyle aynı', () => {
  const a = analysisFor(1.7, 1.0);
  const target = pickSimTarget(a, 'maç-1');
  assert.deepEqual(pickSimTarget(a, 'maç-1'), target);
  const t = simulateToScore(a, { seed: 'maç-1', target });
  assert.equal(t.score.home, target.home);
  assert.equal(t.score.away, target.away);
  assert.equal(t.conditioned.hit, true);
  assert.deepEqual(simulateToScore(a, { seed: 'maç-1', target }).score, t.score);
  // olaylar son skorla uyumlu
  const goals = t.events.filter((e) => e.type === 'goal');
  assert.equal(goals.length, target.home + target.away);

  // birçok maçta simülasyon sonucu = AI tahmini, skorlar da çeşitli ve makul
  const seen = new Map();
  for (let i = 0; i < 60; i++) {
    const an = analysisFor(1.2 + (i % 5) * 0.2, 1.0 + (i % 3) * 0.15);
    const tg = pickSimTarget(an, `k${i}`);
    const o = tg.home > tg.away ? '1' : tg.home < tg.away ? '2' : 'X';
    assert.equal(o, predictedOutcome(an));
    assert.ok(tg.home + tg.away <= 6);
    seen.set(`${tg.home}-${tg.away}`, 1);
  }
  assert.ok(seen.size >= 3, 'skorlar tek tip olmamalı');
});

test('buildSim: son skor hedef skorla aynı', () => {
  const a = analysisFor(1.5, 1.2);
  const sim = buildSim(a, { seed: 'demo-1' });
  const target = pickSimTarget(a, 'demo-1');
  assert.deepEqual(sim.finalScore, { home: target.home, away: target.away });
});

// --- ESPN lig verisi ---------------------------------------------------------------------------------------------
function scoreboardFetch(matches, { failEvery = 0 } = {}) {
  let calls = 0;
  const impl = async (url) => {
    calls++;
    if (failEvery && calls % failEvery === 0) return { ok: false, status: 500, json: async () => ({}) };
    const m = /dates=(\d{8})-(\d{8})/.exec(url);
    const toTs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    const [from, to] = [toTs(m[1]), toTs(m[2]) + DAY];
    const events = matches
      .filter((x) => x.timestamp >= from && x.timestamp < to)
      .map((x) => ({
        id: x.id,
        date: new Date(x.timestamp).toISOString(),
        competitions: [{ status: { type: { completed: true, state: 'post' } }, competitors: [
          { homeAway: 'home', score: String(x.homeGoals), team: { id: x.homeId, displayName: x.homeId } },
          { homeAway: 'away', score: String(x.awayGoals), team: { id: x.awayId, displayName: x.awayId } },
        ] }],
      }));
    return { ok: true, status: 200, json: async () => ({ events }) };
  };
  impl.calls = () => calls;
  return impl;
}

test('lig maçları: 30 günlük dilimlerle çekilir, tekrarlar atılır, önbelleğe alınır', async () => {
  const { matches } = makeSyntheticLeague({ seed: 'espn' });
  const now = matches.at(-1).timestamp + 2 * DAY;
  const f = scoreboardFetch(matches);
  const espn = new EspnClient({ fetchImpl: f, retries: 0 });
  const got = await espn.getLeagueMatches('tur.1', { days: 620, now });
  assert.ok(got.length > 600 && got.length <= matches.length);
  assert.equal(new Set(got.map((m) => m.id)).size, got.length);
  const calls = f.calls();
  await espn.getLeagueMatches('tur.1', { days: 620, now });
  assert.equal(f.calls(), calls, 'ikinci çağrı önbellekten gelmeli');
});

test('lig maçları: çok dilim başarısızsa hata; az sayıda başarısızlık tolere edilir', async () => {
  const { matches } = makeSyntheticLeague({ seed: 'espn2' });
  const now = matches.at(-1).timestamp + 2 * DAY;
  const bad = new EspnClient({ fetchImpl: scoreboardFetch(matches, { failEvery: 1 }), retries: 0 });
  await assert.rejects(() => bad.getLeagueMatches('tur.1', { now }), /eksik alındı/);
  const ok = new EspnClient({ fetchImpl: scoreboardFetch(matches, { failEvery: 7 }), retries: 0 });
  const got = await ok.getLeagueMatches('tur.1', { now });
  assert.ok(got.length > 400);
});

// --- Servis: lig gücü kullanımı ve geri dönüş -----------------------------------------------------------------
test('ESPN istemcisi: eşzamanlı aynı istek tek istekte birleşir; takım listesi ayrı önbellekte, alınamayan lig yarım saat istenmez', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (url.includes('/yok.1/')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ sports: [{ leagues: [{ teams: [{ team: { id: 7, displayName: 'A' } }] }] }] }) };
  };
  const espn = new EspnClient({ fetchImpl, retries: 0 });
  const [a, b] = await Promise.all([espn.getTeams('tur.1', { maxAgeMs: 3600e3 }), espn.getTeams('tur.1', { maxAgeMs: 3600e3 })]);
  assert.equal(calls, 1);
  assert.equal(a[0].id, '7');
  assert.deepEqual(a, b);
  await espn.getTeams('tur.1', { maxAgeMs: 3600e3 });
  assert.equal(calls, 1, 'önbellekten');
  await assert.rejects(() => espn.getTeams('yok.1', { maxAgeMs: 3600e3 }));
  await assert.rejects(() => espn.getTeams('yok.1', { maxAgeMs: 3600e3 }));
  assert.equal(calls, 2, 'alınamayan lig hemen yeniden istenmez');
});

function fakeEspn(leagueMatches, { failLeague = false } = {}) {
  return {
    async getStandings() { return { entries: new Map(), teamCount: 0, leagueAvgGoals: null }; },
    async getTeamMatches() { return []; },
    async getLeagueMatches() {
      if (failLeague) throw new Error('ağ yok');
      return leagueMatches;
    },
  };
}

test('servis: yerel ligde lig gücü modeli kullanılır; veri alınamazsa uyarıyla eski yönteme döner', async () => {
  const { matches, truth } = makeSyntheticLeague({ seed: 'svc' });
  const now = matches.at(-1).timestamp + DAY;
  const strongest = [...truth].sort((a, b) => b.att / b.def - a.att / a.def);
  const [best, worst] = [strongest[0], strongest.at(-1)];
  const run = async (espn) => {
    const sim = new MatchSimulator({ espn, memory: new TeamMemory() });
    return sim.prepare({ league: 'tur.1', homeId: best.id, awayId: worst.id, homeName: 'Güçlü', awayName: 'Zayıf', now });
  };
  const withFit = await run(fakeEspn(matches));
  assert.equal(withFit.dataQuality.model, 'lig-gücü');
  assert.ok(withFit.lambdaHome > withFit.lambdaAway * 1.3, `${withFit.lambdaHome} ${withFit.lambdaAway}`);
  assert.ok(withFit.probabilities.homeWin > 0.55);
  assert.ok(withFit.sigma > 0);

  const without = await run(fakeEspn(matches, { failLeague: true }));
  assert.equal(without.dataQuality.model, 'takım-geçmişi');
  assert.ok(without.dataQuality.warnings.some((w) => w.includes('lig verisi alınamadı')));

  // Avrupa kupası: takımların ligi bilinmiyorsa (takım listesi yok) lig gücü denenmez
  let asked = false;
  const espn = fakeEspn(matches);
  espn.getLeagueMatches = async () => { asked = true; return matches; };
  const sim = new MatchSimulator({ espn, memory: new TeamMemory() });
  await sim.prepare({ league: 'uefa.champions', homeId: best.id, awayId: worst.id, now });
  assert.equal(asked, false);
});

test('servis: Avrupa kupası ve ulusal kupada takımlar kendi liglerinin gücüyle, lig farkıyla değerlendirilir', async () => {
  const eng = makeSyntheticLeague({ seed: 'ing' }).matches;
  const tur = makeSyntheticLeague({ seed: 'tur' }).matches.map((m) => ({ ...m, id: `t${m.id}`, homeId: String(+m.homeId + 100), awayId: String(+m.awayId + 100) }));
  const now = Math.max(eng.at(-1).timestamp, tur.at(-1).timestamp) + DAY;
  const leagues = { 'eng.1': eng, 'tur.1': tur };
  const teamCalls = [];
  const espn = {
    async getStandings() { return { entries: new Map(), teamCount: 0, leagueAvgGoals: null }; },
    async getTeamMatches() { return []; },
    async getLeagueMatches(lg) {
      if (!leagues[lg]) throw new Error('yok');
      return leagues[lg];
    },
    async getTeams(lg) {
      teamCalls.push(lg);
      const ms = leagues[lg];
      if (!ms) return [];
      return [...new Set(ms.flatMap((m) => [m.homeId, m.awayId]))].map((id) => ({ id }));
    },
  };
  const run = (league, homeId, awayId, extra = {}) => new MatchSimulator({ espn, memory: new TeamMemory() }).prepare({ league, homeId, awayId, now, ...extra });
  // aynı sıradaki (ligin ortasındaki) takımlar: İngiliz takımı lig farkıyla öne geçer
  const mid = (ms) => {
    const r = fitRatings(ms, { now, newTeam: null });
    return [...r.teams.values()].sort((a, b) => a.att / a.def - b.att / b.def)[10].id;
  };
  const e = mid(eng);
  const t = mid(tur);
  const a = await run('uefa.champions', t, e);
  assert.equal(a.dataQuality.model, 'ligler-arası');
  assert.ok(a.factors.leagueRatio < 1 && a.factors.homeLeague === 'tur.1' && a.factors.awayLeague === 'eng.1');
  const b = await run('uefa.champions', e, t);
  assert.ok(b.probabilities.homeWin > a.probabilities.awayWin, 'güçlü lig takımı evinde daha da favori');
  assert.ok(b.lambdaHome / b.lambdaAway > 1.5);
  // içerikte saklanan model: lig bilgisi ve tarafsız saha bayrağı (Asistan "neden" cevabı kullanır)
  const { modelOf } = await import('../content.js');
  const mb = modelOf(b);
  assert.ok(mb.leagueRatio > 1 && mb.homeLeague === 'eng.1' && mb.awayLeague === 'tur.1' && mb.neutral === false);
  // tarafsız saha (final): iki yön simetrik
  const n1 = await run('uefa.champions', e, t, { neutral: true });
  const n2 = await run('uefa.champions', t, e, { neutral: true });
  assert.ok(Math.abs(n1.probabilities.homeWin - n2.probabilities.awayWin) < 0.03);
  // aynı ligin iki takımı kupada: o ligin güç tablosu
  const same = await run('eng.fa', eng[0].homeId, eng[0].awayId);
  assert.equal(same.dataQuality.model, 'lig-gücü');
  // ulusal kupada listede olmayan (amatör) takım: en alt basamaktan da zayıf
  const amateur = await run('eng.fa', 'amatör', e);
  assert.equal(amateur.dataQuality.model, 'ligler-arası');
  assert.ok(amateur.probabilities.awayWin > 0.6, `${amateur.probabilities.awayWin}`);
  assert.equal(amateur.dataQuality.confidence, 'düşük');
  assert.ok(amateur.dataQuality.warnings.some((w) => w.includes('bulunamadı')));
  // milli takım turnuvasında kulüp ligleri aranmaz
  teamCalls.length = 0;
  await run('fifa.world', '1', '2');
  assert.equal(teamCalls.length, 0);
});
