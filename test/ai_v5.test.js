// AI analiz (5. sürüm), AI Yorumcu verisi ve AI Asistan: tek senaryo, tahmini ne bozar, AI seçimleri, model ve oranlar;
// asistanın yeni soru türleri (en güvenli seçim, motivasyon, form, risk).
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchProbabilities } from '../engine/analysis.js';
import { buildAi, buildSim, scenarioOf, riskScenarios, modelVsOdds, markets } from '../content.js';
import { aiPicks, RULES, mainCandidates } from '../coupon_rules.js';
import { RULES as COUPON_RULES, pickText } from '../ai_coupons.js';
import { intentOf, followUpAnswer, pickHit, picksOf, whyAnswer } from '../chat.js';
import { PaidContentService } from '../logic.js';
import { AssistantService, sayable } from '../assistant.js';
import { NOW, makeEspn, makeStore, fixture } from './helpers.js';

const H = 'Kasımpaşa';
const A = 'Rizespor';

function analysisFor(lh, la, extra = {}) {
  const sigma = 0.15;
  const prof = (form, pts, rank) => ({ form: { string: form, points: pts, matches: 5, index: pts / 15 }, goalsForPerGame: 1.5, goalsAgainstPerGame: 1.1, rank, ppg: 1.5 });
  return {
    home: { id: '1', name: H, profile: prof('GGBMG', 10, 4) },
    away: { id: '2', name: A, profile: prof('MBMGB', 5, 14) },
    lambdaHome: lh,
    lambdaAway: la,
    sigma,
    probabilities: matchProbabilities(lh, la, sigma),
    h2h: { n: 0 },
    dataQuality: { homeMatches: 20, awayMatches: 20, h2hMatches: 0, confidence: 'yüksek' },
    ...extra,
  };
}

const section = (ai, t) => ai.sections.find((s) => s.title === t)?.text ?? null;

test('analiz: senaryo, ne bozar ve AI seçimleri bölümleri; yer tutucu ya da takım adına ek yok', () => {
  for (const [lh, la] of [[1.8, 0.9], [1.1, 1.1], [0.9, 1.7], [2.4, 1.3], [2.9, 0.6]]) {
    const ai = buildAi(analysisFor(lh, la), { seed: `t${lh}` });
    const titles = ai.sections.map((s) => s.title);
    for (const t of ['Maçın senaryosu', 'Tahmini ne bozar?', 'Öne çıkan tercih', 'Veri güveni']) assert.ok(titles.includes(t), `${t} @ ${lh}-${la}`);
    assert.ok(titles.indexOf('Maçın senaryosu') < titles.indexOf('Öne çıkan tercih'));
    const all = ai.sections.map((s) => s.text).join('\n');
    assert.doesNotMatch(all, /\{\w+\}|undefined|NaN|\bnull\b|Infinity/);
    assert.doesNotMatch(all, new RegExp(`(${H}|${A})['’]?(nın|nin|ın|in|ya|ye|da|de|dan|den)\\b`));
    // Senaryonun final skoru analizin skoru
    assert.equal(ai.scenario.ft, ai.topScore);
    assert.match(section(ai, 'Maçın senaryosu'), new RegExp(`${ai.scenario.ft}`));
  }
});

test('tek senaryo: analizdeki devre ve final skoru simülasyonun oynattığı skorlar', () => {
  for (const [lh, la] of [[1.8, 0.9], [1.1, 1.1], [0.9, 1.7], [2.4, 1.3], [1.3, 1.2]]) {
    const a = analysisFor(lh, la);
    const ai = buildAi(a, { seed: 'k' });
    const sim = buildSim(a, { seed: 'k' });
    assert.equal(`${sim.finalScore.home}-${sim.finalScore.away}`, ai.scenario.ft);
    assert.equal(`${sim.halftimeScore.home}-${sim.halftimeScore.away}`, ai.scenario.ht);
    const sc = scenarioOf(a);
    assert.ok(sc.ht.home <= sc.ft.home && sc.ht.away <= sc.ft.away, 'devre skoru final skorunu aşamaz');
  }
});

test('ne bozar: favoriye karşı erken gol kazanma ihtimalini düşürür, favorinin golü yükseltir; başlangıç analizin rakamı', () => {
  const a = analysisFor(1.8, 0.9);
  const r = riskScenarios(a);
  assert.equal(r.base.p1, a.probabilities.homeWin);
  assert.ok(r.awayFirst.p1 < r.base.p1 - 0.15);
  assert.ok(r.homeFirst.p1 > r.base.p1 + 0.1);
  assert.ok(r.nilHt.pX > r.base.pX, 'golsüz ilk yarı beraberliği artırır');
  const text = section(buildAi(a, { seed: 'r' }), 'Tahmini ne bozar?');
  assert.match(text, new RegExp(`%${Math.round(a.probabilities.homeWin * 100)} seviyesinden`));
  assert.match(text, new RegExp(A));
});

test('AI seçimleri: kupon kurallarıyla aynı; her tür kuralına uyar, bir seçim tek türde', () => {
  assert.equal(RULES, COUPON_RULES, 'kupon ve analiz aynı kural nesnesini kullanır');
  assert.equal(pickText('Çifte şans 1-X', H, A).label, `${H} kaybetmez`);
  const { p } = markets(1.8, 0.9, 0.15);
  const picks = aiPicks(p, H, A);
  assert.ok(picks.length >= 2);
  const cands = mainCandidates(p, H, A);
  for (const k of picks) {
    const c = cands.find((x) => x.market === k.market);
    assert.ok(RULES[k.kind].ok(c), `${k.kind} ${k.market}`);
    assert.equal(k.pct, Math.round(c.p * 100));
  }
  assert.equal(new Set(picks.map((k) => k.market)).size, picks.length);
  const ai = buildAi(analysisFor(1.8, 0.9), { seed: 'p' });
  assert.deepEqual(ai.picks, picks);
  assert.match(section(ai, 'AI seçimleri'), /^Banko: /);
});

test('model ve oranlar: yalnızca belirgin ayrışmada bölüm; uyumluysa veri güvenine not düşülür', () => {
  const far = analysisFor(1.6, 1.0, { base: { lambdaHome: 2.1, lambdaAway: 0.8, sigma: 0.2 }, marketWeight: 0.8 });
  const t = modelVsOdds(far, H, A);
  assert.equal(t.agree, false);
  assert.match(t.text, new RegExp(`AI modeli ${H} tarafını oranların gösterdiğinden daha güçlü görüyor`));
  assert.ok(section(buildAi(far, { seed: 'm' }), 'Model ve oranlar'));
  const near = analysisFor(1.6, 1.0, { base: { lambdaHome: 1.62, lambdaAway: 0.99, sigma: 0.15 }, marketWeight: 0.8 });
  assert.deepEqual(modelVsOdds(near, H, A), { agree: true, text: null });
  const ai = buildAi(near, { seed: 'm' });
  assert.equal(section(ai, 'Model ve oranlar'), null);
  assert.match(section(ai, 'Veri güveni'), /aynı yönü gösteriyor/);
  assert.equal(modelVsOdds(analysisFor(1.6, 1.0), H, A), null, 'oran yoksa bölüm yok');
});

// ---------------------------------------------------------------------------------------------------
// AI Asistan
// ---------------------------------------------------------------------------------------------------

test('asistan: yeni soru türleri', () => {
  const cases = {
    'banko ne?': 'pick',
    'Ne oynayayım?': 'pick',
    'En güvenli seçim?': 'pick',
    'Motivasyon durumu?': 'context',
    'Rotasyon yapar mı?': 'context',
    'Düşme hattında mı?': 'context',
    'Form durumu?': 'form',
    'Evinde nasıl?': 'form',
    'Tahmini ne bozar?': 'risk',
    'Kim kazanır?': 'winner',
    'Kaç gol olur?': 'goals',
  };
  for (const [q, want] of Object.entries(cases)) assert.equal(intentOf(q), want, q);
});

function chatInputs(extra = {}) {
  const a = analysisFor(1.8, 0.9);
  const ai = buildAi(a, { seed: 'c' });
  const model = {
    lambdaHome: a.lambdaHome,
    lambdaAway: a.lambdaAway,
    sigma: a.sigma,
    homeForm: 'GGBMG',
    awayForm: 'MBMGB',
    homeFormPoints: 10,
    awayFormPoints: 5,
    homeFormMatches: 5,
    awayFormMatches: 5,
    homeGf: 1.6,
    homeGa: 0.9,
    awayGf: 1.0,
    awayGa: 1.6,
    context: {
      notes: [`${A} düşme hattıyla boğuşuyor; her puan değerli.`, `${H} 3 gün sonra Avrupa'da oynayacak; bu maçta rotasyon yapabilir.`],
      splits: [`${H} son 20 maçta ortalama 1.85 gol attı, 0.9 gol yedi; evinde 10 maçta 2.1 atıp 0.6 yedi.`],
      factors: { home: [0.95, 1.03], away: [1, 1], total: 1 },
    },
  };
  return { H, A, model, content: { ai }, importance: { label: 'Orta', score: 50, reasons: [] }, state: 'pre', live: null, ...extra };
}

test('asistan: en güvenli seçim, motivasyon, form ve risk yanıtları', () => {
  const base = chatInputs();
  const pick = followUpAnswer({ ...base, intent: 'pick', question: 'banko ne?' });
  assert.match(pick.answer, /^Bu maç için AI seçimleri: Banko: /);
  assert.match(pick.answer, /garanti değildir/);
  const ctx = followUpAnswer({ ...base, intent: 'context', question: 'motivasyon?' });
  assert.match(ctx.answer, /düşme hattıyla boğuşuyor/);
  assert.match(ctx.answer, /Maçın önemi orta/);
  const none = followUpAnswer({ ...base, model: { ...base.model, context: null }, intent: 'context', question: 'motivasyon?' });
  assert.match(none.answer, /öne çıkan bir motivasyon, rotasyon ya da yoğun takvim etkisi görünmüyor/);
  const form = followUpAnswer({ ...base, intent: 'form', question: 'form?' });
  assert.match(form.answer, new RegExp(`${H} son 5 maçta 10 puan topladı \\(GGBMG\\)`));
  assert.match(form.answer, /son 20 maçta/);
  const risk = followUpAnswer({ ...base, intent: 'risk', question: 'ne bozar?' });
  assert.match(risk.answer, /seviyesinden/);
  // Neden: bağlam tahmini etkilediyse nedenlerden biri
  const why = whyAnswer({ H, A, model: base.model, content: base.content, importance: base.importance });
  assert.match(why, /Başlıca nedenler/);
});

test('asistan: maç bittiyse AI seçimlerinin karnesi', () => {
  const base = chatInputs({ state: 'post', homeGoals: 2, awayGoals: 0 });
  const picks = picksOf(base);
  const r = followUpAnswer({ ...base, intent: intentOf('AI seçimleri tuttu mu?'), question: 'AI seçimleri tuttu mu?' });
  assert.match(r.answer, /^Maç 2-0 bitti\. Maç öncesi AI seçimleri: /);
  const won = picks.filter((k) => pickHit(k.market, 2, 0) === true).length;
  assert.match(r.answer, new RegExp(`seçimden ${won} tanesi tuttu`));
  assert.equal(pickHit('Çifte şans 1-X', 1, 1), true);
  assert.equal(pickHit('2.5 Üst', 2, 0), false);
  assert.equal(pickHit('KG Var', 1, 1), true);
  assert.equal(pickHit('İY 0.5 Üst', 1, 0), null);
});

test('asistan sahneleri: AI seçimleri ve maçın senaryosu; seste yüzde işareti ve rakam-çizgi-rakam yok', async () => {
  const store = makeStore({ subscription: { plan: 'weekly', until: NOW + 86400000 } });
  const paid = new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW });
  const assistant = new AssistantService({ paid, store, now: () => NOW, dailyLimit: 15 });
  const r = await assistant.analyze({ uid: 'u1', ...fixture });
  const titles = r.scenes.map((s) => s.title);
  assert.ok(titles.includes('AI seçimleri'), titles.join(', '));
  assert.ok(titles.includes('Maçın senaryosu'), titles.join(', '));
  assert.ok(titles.includes('Tahmini ne bozar?'), titles.join(', '));
  for (const s of r.scenes) {
    assert.ok(!/%/.test(s.speech), s.speech);
    assert.ok(!/\d\s*-\s*\d/.test(s.speech), s.speech);
  }
  assert.ok(r.suggestions.includes('En güvenli seçim?'));
  assert.equal(sayable('Devre 1-0, ilk yarıda gol %70; ortalama 1.4-1.2'), 'Devre bir sıfır, ilk yarıda gol yüzde 70; ortalama 1,4 karşı 1,2');
});
