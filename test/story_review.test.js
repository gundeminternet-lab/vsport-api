import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStory, reviewStory, evaluateChecks, surpriseOf } from '../story.js';
import { firstGoalSide, StoryReviewService } from '../story_review.js';

const input = { lambdaHome: 1.117, lambdaAway: 1.882, sigma: 0, homeName: 'Liverpool', awayName: 'Brighton', seed: 'eng_1_x' };

test('hikâye: ısı haritası 4x4, sürpriz tarafı ve kontrol maddeleri listeyle aynı uzunlukta', () => {
  const s = buildStory(input);
  assert.equal(s.grid.length, 4);
  assert.ok(s.grid.every((r) => r.length === 4));
  assert.ok(s.gridRest >= 0 && s.gridRest < 40);
  assert.equal(s.upset.team, 'Liverpool');
  assert.equal(s.upset.pct, s.pct.home);
  assert.equal(s.checks.length, s.checklist.length);
});

test('kontrol değerlendirmesi: sonuç, skor, gol, KG ve ilk gol', () => {
  const checks = [
    { type: 'result', value: '2' },
    { type: 'score', value: '1-1' },
    { type: 'over25', value: true },
    { type: 'btts', value: true },
    { type: 'firstGoal', value: 'away' },
  ];
  assert.deepEqual(evaluateChecks(checks, { home: 1, away: 2 }, 'away'), [true, false, true, true, true]);
  assert.deepEqual(evaluateChecks(checks, { home: 1, away: 1 }, null), [false, true, false, true, null]);
  // Golsüz maçta "ilk golü X atar" tutmamıştır
  assert.equal(evaluateChecks(checks, { home: 0, away: 0 }, null)[4], false);
});

test('sürpriz düzeyleri', () => {
  assert.equal(surpriseOf(54).level, 'expected');
  assert.equal(surpriseOf(30).level, 'possible');
  assert.equal(surpriseOf(22).level, 'surprise');
  assert.equal(surpriseOf(9).level, 'shock');
});

test('karne: gerçek skorun simülasyondaki sıklığı ve sırası tutarlı', () => {
  const r = reviewStory({ ...input, actual: { home: 2, away: 1 }, firstGoal: 'away' });
  assert.equal(r.score, '2-1');
  assert.ok(r.simCount > 0);
  assert.equal(r.simPct, Math.round((r.simCount / r.sims) * 1000) / 10);
  assert.ok(r.rank >= 1);
  assert.equal(r.outcome, '1');
  assert.equal(r.pickHit, false);
  assert.equal(r.checklist.length, 5);
  assert.equal(r.hits, r.checklist.filter((c) => c.hit === true).length);
  // Aynı tohum: maç öncesi en olası skor 1. sırada olmalı
  const top = buildStory(input).topScores[0].score;
  const [h, a] = top.split('-').map(Number);
  assert.equal(reviewStory({ ...input, actual: { home: h, away: a } }).rank, 1);
});

const summary = (events) => ({
  header: { competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: [
    { homeAway: 'home', team: { id: '1', displayName: 'Liverpool' }, score: '2' },
    { homeAway: 'away', team: { id: '2', displayName: 'Brighton' }, score: '1' },
  ] }] },
  keyEvents: events,
});

test('ilk gol: ilk gol olayının takımı; kendi kalesine ya da gol yoksa null', () => {
  assert.equal(firstGoalSide(summary([
    { type: { text: 'Yellow Card' }, team: { id: '1' } },
    { type: { text: 'Goal' }, scoringPlay: true, team: { id: '2' } },
    { type: { text: 'Goal' }, scoringPlay: true, team: { id: '1' } },
  ])), 'away');
  assert.equal(firstGoalSide(summary([{ type: { text: 'Own Goal' }, scoringPlay: true, ownGoal: true, team: { id: '1' } }])), null);
  assert.equal(firstGoalSide(summary([])), null);
});

const paid = ({ unlocked = true, completed = true, summaryFails = false } = {}) => ({
  validate() {},
  covers: async () => unlocked,
  findMatch: async () => ({ id: '9', timestamp: 0, completed, homeGoals: completed ? 0 : null, awayGoals: completed ? 2 : null, homeName: 'Liverpool', awayName: 'Brighton' }),
  contentFor: async () => ({ key: 'eng_1_9', model: { lambdaHome: 1.117, lambdaAway: 1.882, sigma: 0 }, home: { name: 'Liverpool' }, away: { name: 'Brighton' } }),
  espn: { getSummary: async () => { if (summaryFails) throw new Error('ağ'); return summary([{ type: { text: 'Goal' }, scoringPlay: true, team: { id: '2' } }]); } },
});
const args = { uid: 'u', league: 'eng.1', eventId: '9', kickoff: '2026-10-25T14:00:00Z' };

test('servis: abone olmayan ve maçın AI paketini açmayan reddedilir; bitmemiş maç reddedilir', async () => {
  await assert.rejects(new StoryReviewService({ paid: paid({ unlocked: false }) }).review(args), { code: 'subscription-required' });
  await assert.rejects(new StoryReviewService({ paid: paid({ completed: false }) }).review(args), { code: 'failed-precondition' });
});

test('servis: bitmiş maçta karne döner; özet alınamazsa ilk gol bilinmiyor', async () => {
  const r = await new StoryReviewService({ paid: paid() }).review(args);
  assert.equal(r.score, '0-2');
  assert.equal(r.checklist[4].hit, true);
  const r2 = await new StoryReviewService({ paid: paid({ summaryFails: true }) }).review(args);
  assert.equal(r2.checklist[4].hit, null);
});
