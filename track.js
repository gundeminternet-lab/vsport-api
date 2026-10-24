// Tahmin karnesi: AI tahmini maç başlamadan önce üretildiyse kaydedilir, maç bitince gerçek sonuçla karşılaştırılır.
//   prediction_pending/{key}  : henüz sonuçlanmamış tahminler (kickoffMs'e göre taranır)
//   predictions/{key}         : sonuçlanmış tahminler (hit/miss, Brier, kalibrasyon kaynağı)
// Yalnızca maç başlamadan üretilen içerikler sayılır: maç bittikten sonra hesaplanan "tahmin" karneye girmez.
// Tahmin hiçbir zaman değiştirilmez; karne bu kayıtlardan hesaplanır.

import { matchFacts } from './settle.js';

/** Sonuç ve karne hesabında kullanılan en az maç sayısı; altında yüzdeler "az veri" uyarısıyla gösterilir. */
export const TRACK_MIN_SAMPLE = 30;
/** Başlama saatinden bu kadar sonra hâlâ bitmemiş/okunamayan maç geçersiz sayılır (ertelenmiş, iptal). */
const VOID_AFTER_MS = 3 * 86400e3;
/** Bir maç bitmiş sayılmadan önce beklenen süre (uzatmalar ve bitiş gecikmesi). */
const FINISH_GRACE_MS = 110 * 60e3;

const outcomeOf = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');
const round1 = (x) => Math.round(x * 10) / 10;

/** AI içeriğinden bekleyen tahmin kaydı. Olasılıklar yüzde tamsayıdır. Geçersizse null. */
export function pendingEntry({ key, league, eventId, kickoffMs, homeName, awayName, ai }) {
  const p = ai?.probabilities;
  if (!p || typeof ai.pick !== 'string' || typeof ai.topScore !== 'string') return null;
  if (![p.home, p.draw, p.away].every((v) => Number.isFinite(v))) return null;
  return {
    key,
    league,
    eventId: String(eventId),
    kickoffMs,
    home: homeName,
    away: awayName,
    pick: ai.pick,
    probs: { '1': p.home, X: p.draw, '2': p.away },
    topScore: ai.topScore,
  };
}

/** Bekleyen kaydı gerçek sonuçla birleştirir. Brier: üç sonucun olasılık hatasının karelerinin toplamı (0 en iyi, 2 en kötü). */
export function resolveEntry(entry, actual, resolvedAtMs) {
  const outcome = outcomeOf(actual.home, actual.away);
  const pr = { '1': entry.probs['1'] / 100, X: entry.probs.X / 100, '2': entry.probs['2'] / 100 };
  const brier = ['1', 'X', '2'].reduce((s, o) => s + (pr[o] - (outcome === o ? 1 : 0)) ** 2, 0);
  const actualScore = `${actual.home}-${actual.away}`;
  const { key, league, eventId, kickoffMs, home, away, pick, probs, topScore } = entry;
  return {
    key,
    league,
    eventId,
    kickoffMs,
    home,
    away,
    pick,
    probs,
    topScore,
    actual: { home: actual.home, away: actual.away, score: actualScore },
    outcome,
    outcomeHit: pick === outcome,
    scoreHit: topScore === actualScore,
    brier: round1(brier * 100) / 100,
    resolvedAtMs,
  };
}

/** Sonuçlanmış tahminlerden karne: isabet yüzdelerı, kalibrasyon kovaları ve son tahminler. */
export function summarize(entries) {
  const n = entries.length;
  if (n === 0) return { n: 0, sufficient: false, outcomeAccuracy: null, exactAccuracy: null, brier: null, streak: 0, calibration: [], recent: [] };
  const outcomeHits = entries.filter((e) => e.outcomeHit).length;
  const exactHits = entries.filter((e) => e.scoreHit).length;
  const brier = entries.reduce((s, e) => s + e.brier, 0) / n;
  // Kalibrasyon: her maçta üç sonucun her biri bir nokta. Olasılık kovası 10'luk aralıklarla.
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, n: 0, sumP: 0, hits: 0 }));
  for (const e of entries) {
    for (const o of ['1', 'X', '2']) {
      const p = e.probs[o];
      const b = bins[Math.min(9, Math.floor(p / 10))];
      b.n++;
      b.sumP += p;
      if (e.outcome === o) b.hits++;
    }
  }
  const calibration = bins
    .filter((b) => b.n > 0)
    .map((b) => ({ from: b.from, to: b.to, n: b.n, predicted: round1(b.sumP / b.n), observed: round1((b.hits / b.n) * 100) }));
  // Sıralı en yeni maçtan geriye doğru ardışık isabet sayısı.
  const sorted = [...entries].sort((a, b) => b.kickoffMs - a.kickoffMs);
  let streak = 0;
  for (const e of sorted) {
    if (!e.outcomeHit) break;
    streak++;
  }
  return {
    n,
    sufficient: n >= TRACK_MIN_SAMPLE,
    outcomeAccuracy: round1((outcomeHits / n) * 100),
    exactAccuracy: round1((exactHits / n) * 100),
    brier: round1(brier * 100) / 100,
    // Her sonucu eşit olasılıkla tahmin eden referans: 2/3 · 2/3 + 2 · (1/3)² ≈ 0,67.
    brierBaseline: 0.67,
    streak,
    calibration,
    recent: sorted.slice(0, 20).map((e) => ({
      key: e.key,
      title: `${e.home} - ${e.away}`,
      league: e.league,
      kickoffMs: e.kickoffMs,
      pick: e.pick,
      topScore: e.topScore,
      actualScore: e.actual.score,
      outcomeHit: e.outcomeHit,
      scoreHit: e.scoreHit,
    })),
  };
}

export class TrackService {
  constructor({ store, espn, now = () => Date.now(), cacheMs = 10 * 60e3, log = console }) {
    this.store = store;
    this.espn = espn;
    this.now = now;
    this.cacheMs = cacheMs;
    this.log = log;
    this._cache = null;
    this._cacheAt = 0;
    this._busy = false;
  }

  /** Maç başlamadan üretilmiş bir içerik için bekleyen kayıt açar. Zaten varsa dokunmaz. */
  async recordPending(entry) {
    if (!entry) return false;
    return this.store.createPending(entry);
  }

  /** Bitmiş maçların bekleyen tahminlerini sonuçlandırır. Dönen değer sonuçlanan kayıt sayısıdır. */
  async resolveDue({ limit = 40 } = {}) {
    if (this._busy) return 0;
    this._busy = true;
    let done = 0;
    try {
      const now = this.now();
      const due = await this.store.listPendingBefore(now - FINISH_GRACE_MS, limit);
      for (const p of due) {
        let facts;
        try {
          facts = matchFacts(await this.espn.getSummary(p.league, p.eventId, { maxAgeMs: 10 * 60e3 }));
        } catch {
          continue; // veri sağlayıcısına ulaşılamadı; sonraki turda yeniden denenir
        }
        if (facts.postponed || (!facts.completed && now - p.kickoffMs > VOID_AFTER_MS)) {
          await this.store.deletePending(p.key); // ertelenmiş ya da iptal: karneye girmez
          continue;
        }
        if (!facts.completed || typeof facts.home !== 'number' || typeof facts.away !== 'number') continue;
        const resolved = resolveEntry(p, { home: facts.home, away: facts.away }, now);
        await this.store.saveResolved(resolved);
        done++;
      }
    } finally {
      this._busy = false;
    }
    if (done) this._cache = null;
    return done;
  }

  /** Karne (önbellekli). Herkes aynı karneyi görür; yalnızca giriş yapmış kullanıcılar okuyabilir. */
  async trackRecord({ uid, limit = 500 } = {}) {
    if (!uid) throw Object.assign(new Error('Giriş yapmalısınız.'), { code: 'permission-denied' });
    const now = this.now();
    if (this._cache && now - this._cacheAt < this.cacheMs) return this._cache;
    const entries = await this.store.listResolved(limit);
    this._cache = summarize(entries);
    this._cacheAt = now;
    return this._cache;
  }
}

/** Firestore veri katmanı (Admin SDK). */
export function createTrackStore(db) {
  return {
    async createPending(entry) {
      // Aynı maç için ikinci kayıt açılmaz: ilk üretilen tahmin esastır.
      const done = await db.doc(`predictions/${entry.key}`).get();
      if (done.exists) return false;
      try {
        await db.doc(`prediction_pending/${entry.key}`).create(entry);
        return true;
      } catch (e) {
        if (e.code === 6 /* ALREADY_EXISTS */) return false;
        throw e;
      }
    },
    async listPendingBefore(cutoffMs, limit) {
      const q = await db.collection('prediction_pending').where('kickoffMs', '<=', cutoffMs).orderBy('kickoffMs').limit(limit).get();
      return q.docs.map((d) => d.data());
    },
    async deletePending(key) {
      await db.doc(`prediction_pending/${key}`).delete();
    },
    async saveResolved(resolved) {
      await db.doc(`predictions/${resolved.key}`).set(resolved);
      await db.doc(`prediction_pending/${resolved.key}`).delete().catch(() => {});
    },
    async listResolved(limit) {
      const q = await db.collection('predictions').orderBy('kickoffMs', 'desc').limit(limit).get();
      return q.docs.map((d) => d.data());
    },
  };
}
