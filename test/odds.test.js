// Dış oran ayrıştırma ve olasılık matematiği.
import test from 'node:test';
import assert from 'node:assert/strict';

import { americanToDecimal, decimalToAmerican, toDecimal, parseOddsItem, parseOddsResponse, impliedProbabilities, marketProbabilities, consensus, marketLambdas } from '../engine/odds.js';
import { matchProbabilities } from '../engine/analysis.js';

const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('Amerikan ↔ ondalık', () => {
  near(americanToDecimal(140), 2.4);
  near(americanToDecimal(-165), 1.60606);
  near(americanToDecimal('+250'), 3.5);
  near(americanToDecimal(100), 2);
  assert.ok(Number.isNaN(americanToDecimal(50)));
  assert.ok(Number.isNaN(americanToDecimal('abc')));
  assert.equal(decimalToAmerican(2.4), 140);
  assert.equal(decimalToAmerican(1.606), -165);
});

test('toDecimal: sayı, metin ve nesne biçimleri', () => {
  near(toDecimal(-110), 1.909);
  near(toDecimal(1.61), 1.61);
  near(toDecimal('EVEN'), 2);
  near(toDecimal('7/4'), 2.75);
  near(toDecimal('+140'), 2.4);
  near(toDecimal('1.85'), 1.85);
  near(toDecimal({ value: 1.61, displayValue: '8/13', alternateDisplayValue: '-165', decimal: 1.61, fraction: '8/13', american: '-165' }), 1.61);
  near(toDecimal({ american: '-165' }), 1.606);
  near(toDecimal({ displayValue: '8/13' }), 1.615);
  assert.ok(Number.isNaN(toDecimal(null)));
  assert.ok(Number.isNaN(toDecimal(0.5)));
  assert.ok(Number.isNaN(toDecimal({})));
});

// Belgelenen düz biçim (Amerikan sayılar) + futbol için beraberlik
const flat = {
  provider: { id: '58', name: 'Kaynak A', priority: 1 },
  details: 'ARS -165',
  overUnder: 2.5,
  overOdds: -150,
  underOdds: 120,
  homeTeamOdds: { favorite: true, moneyLine: -165 },
  awayTeamOdds: { underdog: true, moneyLine: 450 },
  drawOdds: { moneyLine: 290 },
};

// İç içe biçim: current / open / close nesneleri
const nested = {
  provider: { id: '100', name: 'Kaynak B', priority: 2 },
  homeTeamOdds: {
    moneyLine: -150,
    open: { moneyLine: { decimal: 1.8, american: '-125' } },
    close: { moneyLine: { decimal: 1.62, american: '-161' } },
    current: { moneyLine: { decimal: 1.66, american: '-152' } },
  },
  awayTeamOdds: {
    moneyLine: 400,
    open: { moneyLine: { decimal: 4.0, american: '+300' } },
    close: { moneyLine: { decimal: 5.2, american: '+420' } },
    current: { moneyLine: { decimal: 5.0, american: '+400' } },
  },
  drawOdds: { moneyLine: 280, open: { moneyLine: { american: '+250' } }, current: { moneyLine: { decimal: 3.8 } } },
  current: { total: { alternateDisplayValue: '2.5', american: '2.5' }, over: { decimal: 1.7, american: '-143' }, under: { decimal: 2.15, american: '+115' } },
  open: { over: { value: 2.5 }, under: { value: 2.5 } },
};

test('parseOddsItem: düz biçim', () => {
  const p = parseOddsItem(flat);
  assert.deepEqual(p.provider, { id: '58', name: 'Kaynak A', priority: 1 });
  near(p.current.home, 1.606);
  near(p.current.draw, 3.9);
  near(p.current.away, 5.5);
  assert.equal(p.current.total, 2.5);
  near(p.current.over, 1.667);
  near(p.current.under, 2.2);
  assert.equal(p.open, null);
  assert.equal(p.close, null);
});

test('parseOddsItem: iç içe biçimde güncel, açılış ve kapanış', () => {
  const p = parseOddsItem(nested);
  near(p.current.home, 1.66, 1e-9);
  near(p.current.draw, 3.8, 1e-9);
  near(p.current.away, 5.0, 1e-9);
  near(p.current.over, 1.7, 1e-9);
  assert.equal(p.current.total, 2.5);
  near(p.open.home, 1.8, 1e-9);
  near(p.open.draw, 3.5, 1e-9);
  assert.equal(p.open.total, 2.5, 'açılışta over.value çizgidir');
  assert.equal(p.open.over, null);
  near(p.close.away, 5.2, 1e-9);
  assert.equal(p.close.draw, null);
});

test('parseOddsItem: hiçbir fiyat yoksa null', () => {
  assert.equal(parseOddsItem({ provider: { id: 1 }, details: 'x' }), null);
  assert.equal(parseOddsItem(null), null);
});

test('parseOddsResponse: core items, summary pickcenter/odds; yinelenen sağlayıcı atılır', () => {
  assert.equal(parseOddsResponse({ count: 2, items: [flat, nested] }).length, 2);
  assert.equal(parseOddsResponse({ pickcenter: [flat], odds: [flat] }).length, 1);
  assert.equal(parseOddsResponse({ items: [{ $ref: 'http://x' }] }).length, 0);
  assert.deepEqual(parseOddsResponse(null), []);
});

test('impliedProbabilities: toplam 1, pay temizlenir; power yöntemi favoriyi orantılıdan az kırpar', () => {
  const dec = [1.606, 3.9, 5.5];
  const pr = impliedProbabilities(dec, { method: 'proportional' });
  const pw = impliedProbabilities(dec, { method: 'power' });
  near(pr.overround, 1 / 1.606 + 1 / 3.9 + 1 / 5.5, 1e-9);
  near(pr.probs.reduce((a, b) => a + b, 0), 1, 1e-9);
  near(pw.probs.reduce((a, b) => a + b, 0), 1, 1e-9);
  assert.ok(pw.probs[0] > pr.probs[0], 'favori');
  assert.ok(pw.probs[2] < pr.probs[2], 'sürpriz');
  assert.equal(impliedProbabilities([1.5, 0.9]), null);
  assert.equal(impliedProbabilities([2]), null);
});

test('marketProbabilities: makul olmayan pay reddedilir', () => {
  const ok = marketProbabilities(parseOddsItem(flat).current);
  near(ok.x12.home + ok.x12.draw + ok.x12.away, 1, 1e-9);
  assert.ok(ok.x12.margin > 0.03 && ok.x12.margin < 0.1);
  assert.equal(ok.ou.line, 2.5);
  // Toplamı 0.9 olan fiyatlar (hatalı veri) ve %40 pay
  assert.equal(marketProbabilities({ home: 2.5, draw: 4, away: 5 }).x12, null);
  assert.equal(marketProbabilities({ home: 1.3, draw: 2.5, away: 3 }).x12, null);
  assert.deepEqual(marketProbabilities(null), { x12: null, ou: null });
});

test('consensus: geometrik havuz, ayrışma ve en yaygın çizgi', () => {
  const a = parseOddsItem(flat);
  const b = parseOddsItem(nested);
  const c = { provider: { id: '9' }, current: { home: 1.7, draw: 3.7, away: 5, total: 3.5, over: 2.6, under: 1.5 } };
  const cons = consensus([a, b, c]);
  assert.equal(cons.x12.n, 3);
  near(cons.x12.home + cons.x12.draw + cons.x12.away, 1, 2e-4);
  assert.ok(cons.x12.home > 0.55 && cons.x12.home < 0.65, `${cons.x12.home}`);
  assert.ok(cons.x12.spread >= 0 && cons.x12.spread < 0.05);
  assert.equal(cons.ou.line, 2.5);
  assert.equal(cons.ou.n, 2);
  assert.equal(cons.providers, 3);
  const open = consensus([a, b], { phase: 'open' });
  assert.equal(open.x12.n, 1);
  assert.equal(consensus([]), null);
  assert.equal(consensus([{ current: { home: 2 } }]), null);
});

test('marketLambdas: modelin kendi olasılıklarından λ geri bulunur', () => {
  for (const [lh, la] of [
    [1.6, 1.0],
    [0.9, 1.4],
    [2.4, 0.7],
  ]) {
    const p = matchProbabilities(lh, la);
    const got = marketLambdas({ x12: { home: p.homeWin, draw: p.draw, away: p.awayWin }, ou: { line: 2.5, over: p.over25 } });
    near(got.home, lh, 0.03);
    near(got.away, la, 0.03);
    assert.ok(got.error < 0.01);
  }
  assert.equal(marketLambdas({ x12: null }), null);
  // Yalnızca 1X2 ile de çözülür
  const p = matchProbabilities(1.5, 1.2);
  const got = marketLambdas({ x12: { home: p.homeWin, draw: p.draw, away: p.awayWin } });
  near(got.home, 1.5, 0.05);
  near(got.away, 1.2, 0.05);
});
