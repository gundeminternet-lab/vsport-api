// Maç sonu karnesi videosunun sunucu tarafı: maç öncesi simülasyon hikâyesini gerçek sonuçla karşılaştırır.
// Erişim: bu maçın AI yorumunu açmış kullanıcılar (maç öncesi videoyu izleyenler karnesini de görür).

import { AppError, matchKey } from './logic.js';
import { readSummary, classifyEvent } from './notify.js';
import { reviewStory } from './story.js';

/**
 * Maç özetinden ilk golü atan taraf: 'home' | 'away' | null.
 * Kendi kalesine gollerde ESPN'deki takım kimliği belirsiz olabildiğinden ilk gol böyleyse null döner.
 */
export function firstGoalSide(json) {
  const s = readSummary(json);
  for (const e of s.events) {
    if (!classifyEvent(e).includes('goal')) continue;
    if (e.ownGoal || e.type.includes('own goal')) return null;
    if (e.teamId && e.teamId === s.home.id) return 'home';
    if (e.teamId && e.teamId === s.away.id) return 'away';
    return null;
  }
  return null;
}

export class StoryReviewService {
  constructor({ paid }) {
    this.paid = paid;
  }

  async review({ uid, league, eventId, kickoff }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.paid.validate({ league, eventId, kickoff }, { needType: false });
    const key = matchKey(league, eventId);
    if (!(await this.paid.store.hasUnlock(uid, key, 'ai'))) {
      throw new AppError('permission-denied', 'Maç sonu karnesi, bu maçın AI yorumunu açanlara özel.');
    }
    const match = await this.paid.findMatch({ league, eventId, kickoff });
    if (!match.completed || !Number.isFinite(match.homeGoals) || !Number.isFinite(match.awayGoals)) {
      throw new AppError('failed-precondition', 'Maç henüz bitmedi; karne maç sonunda hazırlanır.');
    }
    // Maç öncesi içerik: sonradan üretilecekse yalnızca maç öncesi veriyle.
    const content = await this.paid.contentFor(match, { asOf: match.timestamp - 60000 });
    const m = content?.model;
    if (!m || !Number.isFinite(m.lambdaHome) || !Number.isFinite(m.lambdaAway)) {
      throw new AppError('failed-precondition', 'Bu maç için simülasyon verisi yok.');
    }
    let firstGoal = null;
    try {
      firstGoal = firstGoalSide(await this.paid.espn.getSummary(league, eventId, { maxAgeMs: 10 * 60e3 }));
    } catch {
      firstGoal = null; // özet alınamazsa ilk gol maddesi "bilinmiyor" olur
    }
    return reviewStory({
      lambdaHome: m.lambdaHome,
      lambdaAway: m.lambdaAway,
      sigma: m.sigma ?? 0,
      homeName: content.home?.name ?? match.homeName,
      awayName: content.away?.name ?? match.awayName,
      seed: content.key,
      actual: { home: match.homeGoals, away: match.awayGoals },
      firstGoal,
    });
  }
}
