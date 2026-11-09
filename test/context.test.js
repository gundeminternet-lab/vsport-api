import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT,
  seasonStakes,
  stakesFactors,
  stageOf,
  scheduleAround,
  rotationOf,
  recentSplits,
  buildContext,
  applyContext,
  contextNotes,
  splitNotes,
} from '../engine/context.js';
import { coherentScore, compatibleHalf } from '../engine/scenario.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 3, 20, 18);

// 18 takımlı lig, 30 hafta oynandı (34'ün %88'i). Puanlar 80'den 2'şer azalır: 1. 80, 18. 46.
function table(played = 30, n = 18) {
  const entries = new Map();
  for (let i = 0; i < n; i++) entries.set(String(i + 1), { rank: i + 1, points: 80 - 2 * i, played });
  return { entries };
}

test('lig durumu: lider şampiyonluk, son sıralar düşme, ortası hedefsiz; sezon başında yok', () => {
  const t = table();
  assert.equal(seasonStakes(t, '1', 'tur.1').label, 'title');
  assert.equal(seasonStakes(t, '17', 'tur.1').label, 'danger');
  assert.equal(seasonStakes(t, '18', 'tur.1').label, 'danger');
  const mid = seasonStakes(t, '9', 'tur.1');
  assert.equal(mid.label, 'mid');
  assert.equal(mid.remaining, 4);
  assert.equal(seasonStakes(table(10), '1', 'tur.1'), null, 'sezonun %60\'ı oynanmadan lig durumu hesaba girmez');
  assert.equal(seasonStakes(t, '99', 'tur.1'), null);
  const f = stakesFactors(seasonStakes(t, '1', 'tur.1'), mid);
  assert.deepEqual(f.home, [CONTEXT.stakes.att.title, CONTEXT.stakes.def.title]);
  assert.deepEqual(f.away, [CONTEXT.stakes.att.mid, CONTEXT.stakes.def.mid]);
});

test('turnuva aşaması: düşme play-off\'u kısır, yükselme daha açık; ilk maç ve final temkinli', () => {
  const rel = stageOf('ger.2', 'Relegation Playoff 2nd Leg');
  assert.equal(rel.kind, 'relegation');
  assert.equal(rel.leg, 2);
  assert.equal(rel.total, CONTEXT.stage.relegation);
  const pro = stageOf('eng.2', 'Championship Play-Off Semi-Final 1st Leg');
  assert.equal(pro.kind, 'promotion');
  assert.ok(Math.abs(pro.total - CONTEXT.stage.promotion * CONTEXT.stage.firstLeg) < 1e-9);
  assert.equal(pro.final, false, 'yarı final, final sayılmaz');
  assert.ok(rel.total < pro.total, 'düşme play-off\'u yükselmeden kısır');
  const ucl = stageOf('uefa.champions', 'Final');
  assert.equal(ucl.kind, 'continental');
  assert.equal(ucl.label, 'Şampiyonlar Ligi');
  assert.equal(ucl.total, CONTEXT.stage.final);
  assert.equal(stageOf('uefa.europa', 'Knockout Round Play-off 1st Leg').kind, 'continental', 'Avrupa play-off turu yükselme play-off\'u değildir');
  assert.equal(stageOf('tur.1', ''), null);
});

test('fikstür yükü: önceki ve sonraki maç; aynı maç sayılmaz', () => {
  const s = scheduleAround(
    [
      { timestamp: NOW - 4 * DAY, league: 'tur.1' },
      { timestamp: NOW + 3 * DAY, league: 'uefa.champions' },
      { timestamp: NOW + 10 * DAY, league: 'tur.1' },
      { timestamp: NOW + 3600e3, league: 'tur.1' },
    ],
    NOW,
  );
  assert.deepEqual(s.prev, { days: 4, league: 'tur.1' });
  assert.deepEqual(s.next, { days: 3, league: 'uefa.champions' });
});

test('rotasyon: Avrupa öncesi lig maçı, hedefsizse daha geniş; yorgunluk; kupada büyük takım', () => {
  const sched = { prev: { days: 6, league: 'tur.1' }, next: { days: 3, league: 'uefa.champions' } };
  const a = rotationOf({ sched, stakes: { label: 'title' } }, { sched: {} }, { league: 'tur.1' });
  assert.deepEqual(a.reasons, ['beforeEurope']);
  assert.ok(a.att < 1 && a.def > 1);
  const b = rotationOf({ sched, stakes: { label: 'mid' } }, { sched: {} }, { league: 'tur.1' });
  assert.deepEqual(b.reasons, ['beforeEuropeMid']);
  assert.ok(b.att < a.att, 'hedefi kalmayan takım daha çok rotasyon yapar');
  const tired = rotationOf({ sched: { prev: { days: 2, league: 'tur.1' } } }, { sched: { prev: { days: 7, league: 'tur.1' } } }, { league: 'tur.1' });
  assert.deepEqual(tired.reasons, ['tired']);
  const cup = rotationOf({ sched: {} }, { sched: {} }, { league: 'tur.cup', homeTier: 1, awayTier: 2, isHome: true });
  assert.deepEqual(cup.reasons, ['cupFavourite']);
  const euro = rotationOf({ sched: { next: { days: 3, league: 'tur.1' } }, stakes: { label: 'danger' } }, { sched: {} }, { league: 'uefa.europa' });
  assert.deepEqual(euro.reasons, ['europeLeagueFirst']);
  const plain = rotationOf({ sched: { prev: { days: 7 }, next: { days: 7 } } }, { sched: {} }, { league: 'tur.1' });
  assert.deepEqual(plain, { att: 1, def: 1, reasons: [] });
});

test('son 20 maç: genel, evde, deplasmanda ve Avrupa/lig ayrımı', () => {
  const ms = [];
  for (let i = 1; i <= 24; i++) {
    const home = i % 2 === 0;
    const europe = i % 4 === 0;
    ms.push({ timestamp: NOW - i * 4 * DAY, homeId: home ? '7' : '8', awayId: home ? '8' : '7', homeGoals: home ? 2 : 1, awayGoals: home ? 0 : 1, league: europe ? 'uefa.europa' : 'tur.1' });
  }
  ms.push({ timestamp: NOW + DAY, homeId: '7', awayId: '8', homeGoals: 5, awayGoals: 0, league: 'tur.1' }); // gelecek: sayılmaz
  const s = recentSplits(ms, '7', NOW);
  assert.equal(s.all.n, 20);
  assert.deepEqual([s.home.n, s.home.gf, s.home.ga, s.home.w], [10, 2, 0, 10]);
  assert.deepEqual([s.away.n, s.away.gf, s.away.ga, s.away.d], [10, 1, 1, 10]);
  assert.equal(s.all.gf, 1.5);
  assert.equal(s.europe.n, 5);
  assert.equal(s.league.n, 15);
});

test('bağlam: lig maçında çarpanlar uygulanır, notlarda takım adları ek almadan geçer', () => {
  const t = table();
  const ctx = buildContext({
    league: 'tur.1',
    kickoff: NOW,
    homeId: '9',
    awayId: '17',
    homeTable: t,
    awayTable: t,
    homeFixtures: [{ timestamp: NOW + 3 * DAY, league: 'uefa.europa.conf' }],
    awayFixtures: [],
  });
  assert.equal(ctx.stakesApplied, true);
  assert.equal(ctx.stakes.home.label, 'mid');
  assert.equal(ctx.stakes.away.label, 'danger');
  assert.deepEqual(ctx.rotation.home.reasons, ['beforeEuropeMid']);
  const [lh, la] = applyContext(1.5, 1.0, ctx);
  const H = ctx.factors.home;
  const A = ctx.factors.away;
  assert.ok(Math.abs(lh - 1.5 * H[0] * A[1]) < 1e-9);
  assert.ok(Math.abs(la - 1.0 * A[0] * H[1]) < 1e-9);
  assert.ok(la > 1.0, 'hedefsiz ve rotasyondaki ev sahibine karşı deplasman takımı daha çok gol bulur');
  const notes = contextNotes(ctx, 'Kasımpaşa', 'Bodrum FK');
  assert.ok(notes.some((n) => n.startsWith('Kasımpaşa için ligde büyük hedef kalmadı')));
  assert.ok(notes.some((n) => n.includes('Bodrum FK düşme hattıyla boğuşuyor')));
  assert.ok(notes.some((n) => n.includes('Motivasyon farkı Bodrum FK lehine')));
  assert.ok(notes.some((n) => n.includes("3 gün sonra Avrupa'da")));
  assert.ok(!notes.some((n) => /Kasımpaşa'|Bodrum FK'/.test(n)), 'takım adına ek bitiştirilmez');
});

test('bağlam: kupada ve Avrupa\'da lig durumu çarpanı uygulanmaz; bağlam yoksa λ değişmez', () => {
  const t = table();
  const ctx = buildContext({ league: 'uefa.champions', kickoff: NOW, homeId: '1', awayId: '9', homeTable: t, awayTable: t, homeLeague: 'tur.1', awayLeague: 'tur.1' });
  assert.equal(ctx.stakesApplied, false);
  assert.deepEqual(ctx.factors, { home: [1, 1], away: [1, 1], total: 1 });
  assert.deepEqual(applyContext(1.2, 0.9, null), [1.2, 0.9]);
  assert.deepEqual(contextNotes(ctx, 'A', 'B'), []);
});

test('son 20 maç cümleleri: az maçı olan takım için cümle kurulmaz', () => {
  const split = (n, gf, ga) => ({ n, gf, ga, w: 0, d: n, l: 0 });
  const ctx = {
    splits: {
      home: { all: split(20, 1.85, 0.9), home: split(10, 2.1, 0.6), away: split(10, 1.6, 1.2), league: split(15, 1.9, 0.8), europe: split(5, 1.4, 1.2) },
      away: { all: split(4, 1, 1), home: split(2, 1, 1), away: split(2, 1, 1), league: split(4, 1, 1), europe: split(0, null, null) },
    },
  };
  const out = splitNotes(ctx, 'Göztepe', 'Rizespor');
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('Göztepe son 20 maçta ortalama 1.85 gol attı, 0.9 gol yedi; evinde 10 maçta 2.1 atıp 0.6 yedi'));
  assert.ok(out[0].includes("Avrupa'da 5 maçta 1.4-1.2, ligde 1.9-0.8"));
});

// ---------------------------------------------------------------------------------------------------
// Tek senaryo skoru
// ---------------------------------------------------------------------------------------------------

function poissonMatrix(lh, la, max = 7) {
  const f = (k) => (k <= 1 ? 1 : k * f(k - 1));
  const p = (l, k) => (Math.exp(-l) * l ** k) / f(k);
  return Array.from({ length: max + 1 }, (_, i) => Array.from({ length: max + 1 }, (_, j) => p(lh, i) * p(la, j)));
}

test('senaryo skoru: sonuç, 2,5 üst ve KG Var öngörüleriyle çelişmeyen en olası skor', () => {
  const m = poissonMatrix(2.0, 1.3);
  const s = coherentScore(m, { outcome: '1', over25: 0.66, btts: 0.62 });
  assert.equal(s.score, '2-1');
  assert.deepEqual(s.constraints, ['over25', 'btts']);
  // Zayıf öngörüler (eşiğin altı) skoru bağlamaz: tablo zirvesi 1-0 kalır
  const low = coherentScore(poissonMatrix(1.3, 0.6), { outcome: '1', over25: 0.4, btts: 0.48 });
  assert.equal(low.score, '1-0');
  // Beraberlik tahmini ve 2,5 alt: 1-1 ya da 0-0
  const draw = coherentScore(poissonMatrix(1.0, 1.0), { outcome: 'X', over25: 0.3 });
  assert.ok(['0-0', '1-1'].includes(draw.score));
  assert.deepEqual(draw.constraints, ['under25']);
});

test('senaryo skoru: bağdaşmayan öngörülerde en zayıfı bırakılır', () => {
  // Beraberlik + 2,5 üst + KG Yok: aynı anda olamaz (X ve KG Yok → 0-0, 2,5 üst değil); zayıf olan KG Yok bırakılır
  const s = coherentScore(poissonMatrix(1.4, 1.4), { outcome: 'X', over25: 0.7, btts: 0.4, min: 0.55 });
  assert.equal(s.score, '2-2');
  assert.deepEqual(s.constraints, ['over25']);
});

test('devre skoru maç sonu skoruyla uyumlu seçilir', () => {
  const ht = [
    { home: 0, away: 0, p: 0.3 },
    { home: 1, away: 0, p: 0.2 },
    { home: 0, away: 1, p: 0.15 },
  ];
  assert.deepEqual(compatibleHalf(ht, { home: 2, away: 1 }, { home: 1, away: 0 }), { home: 1, away: 0 });
  assert.deepEqual(compatibleHalf(ht, { home: 2, away: 0 }, { home: 0, away: 1 }), { home: 0, away: 0 });
  assert.equal(compatibleHalf([{ home: 1, away: 1, p: 1 }], { home: 0, away: 0 }), null);
});
