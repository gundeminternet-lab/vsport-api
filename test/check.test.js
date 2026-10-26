import test from 'node:test';
import assert from 'node:assert/strict';

import { marketProbability, summarize, CouponCheckService, CHECK_MARKETS } from '../check.js';
import { AccessService } from '../subscription.js';

test('olasılıklar tutarlı', () => {
  const lh = 1.6, la = 1.0;
  const ms = ['MS 1', 'MS X', 'MS 2'].map((m) => marketProbability(m, lh, la));
  assert.ok(Math.abs(ms.reduce((a, b) => a + b) - 1) < 0.01);
  assert.ok(ms[0] > ms[2]);
  assert.ok(Math.abs(marketProbability('KG Var', lh, la) + marketProbability('KG Yok', lh, la) - 1) < 0.01);
  assert.ok(Math.abs(marketProbability('2.5 Üst', lh, la) + marketProbability('2.5 Alt', lh, la) - 1) < 0.01);
  const htft = ['1', 'X', '2'].flatMap((a) => ['1', 'X', '2'].map((b) => `${a}/${b}`));
  // Yalnızca 3 İY/MS var; 1/1 olasılığı MS 1'den küçük olmalı
  assert.ok(marketProbability('İY/MS 1/1', lh, la) < ms[0]);
  assert.ok(htft.length === 9);
  for (const m of CHECK_MARKETS) {
    const p = marketProbability(m, lh, la);
    assert.ok(p > 0 && p < 1, `${m}: ${p}`);
  }
});

test('kupon özeti', () => {
  const s = summarize([{ prob: 0.6, odd: 2 }, { prob: 0.5, odd: 2 }]);
  assert.equal(s.combinedPct, 30);
  assert.equal(s.totalOdd, 4);
  assert.equal(s.evPct, 20);
  assert.equal(s.verdict, 'value');
  assert.equal(s.weakest, 1);
  assert.equal(summarize([{ prob: 0.8 }]).verdict, 'strong');
});

test('servis: abonelere açık; sonuç geçmişe kaydedilir; abone olmayan reddedilir', async () => {
  const saved = [];
  const future = Date.parse('2026-10-25T17:00:00Z');
  const now = () => Date.parse('2026-10-22T12:00:00Z');
  const make = (subscription) => {
    const store = { getAccess: async () => ({ subscription, trialUsed: 0 }), saveCheck: async (uid, id, r) => saved.push({ uid, id, r }) };
    return new CouponCheckService({
      now,
      paid: {
        validate() {},
        access: new AccessService({ store, now }),
        findMatch: async (s) => ({ id: s.eventId, league: s.league, timestamp: future, completed: false, homeName: 'A', awayName: 'B' }),
        contentFor: async () => ({ odds: { expectedGoals: { home: 1.5, away: 1.1 } } }),
      },
      store,
    });
  };
  const one = [{ league: 'tur.1', eventId: '1', kickoff: '2026-10-25T17:00:00Z', market: 'MS 1', odd: 2.1 }];
  await assert.rejects(make(null).check({ uid: 'u', selections: one }), (e) => e.code === 'subscription-required');
  assert.equal(saved.length, 0);

  const svc = make({ plan: 'weekly', until: now() + 86400e3 });
  const r = await svc.check({ uid: 'u', selections: one });
  assert.equal(saved.length, 1);
  assert.equal(r.price, undefined);
  assert.equal(r.items[0].home, 'A');
  assert.ok(r.items[0].pct > 30);
  assert.equal(r.items[0].prob, undefined);
  await assert.rejects(svc.check({ uid: 'u', selections: [{ league: 'tur.1', eventId: '1', kickoff: 'x', market: 'Yanlış' }] }), (e) => e.code === 'invalid-argument');
  await assert.rejects(
    svc.check({ uid: 'u', selections: [{ league: 'tur.1', eventId: '1', kickoff: 'x', market: 'MS 1' }, { league: 'tur.1', eventId: '1', kickoff: 'x', market: 'MS 2' }] }),
    (e) => e.code === 'invalid-argument',
  );
});
