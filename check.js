// Kupon kontrol aracı: kullanıcının kendi kuponundaki her tahmin için modelin olasılığı, adil oran, değer
// (oran × olasılık) ve kupon puanı. Abonelere özel (her plan); hesap sunucuda, maç başına üretilmiş
// ve saklanmış analizden (beklenen goller) yapılır.

import { scoreMatrix } from './engine/analysis.js';
import { AppError, matchKey } from './logic.js';
import { Narrator } from './narrator.js';

export const CHECK_MARKETS = [
  'MS 1', 'MS X', 'MS 2',
  'Çifte şans 1-X', 'Çifte şans 1-2', 'Çifte şans X-2',
  'KG Var', 'KG Yok',
  '1.5 Üst', '1.5 Alt', '2.5 Üst', '2.5 Alt', '3.5 Üst', '3.5 Alt',
  'İY 1', 'İY X', 'İY 2', 'İY 0.5 Üst',
  'İY/MS 1/1', 'İY/MS X/X', 'İY/MS 2/2',
];
const HT_SHARE = 0.45; // gollerin ~%45'i ilk yarıda

const res = (h, a) => (h > a ? '1' : h === a ? 'X' : '2');
const sum = (m, pred) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (pred(i, j)) s += m[i][j];
  return s;
};

/** Beklenen gollerden bir tahminin olasılığı (0..1). */
export function marketProbability(market, lh, la) {
  const ft = scoreMatrix(lh, la);
  const ht = scoreMatrix(lh * HT_SHARE, la * HT_SHARE);
  let x;
  if ((x = /^MS ([1X2])$/.exec(market))) return sum(ft, (i, j) => res(i, j) === x[1]);
  if ((x = /^Çifte şans ([1X2])-([1X2])$/.exec(market))) return sum(ft, (i, j) => res(i, j) === x[1] || res(i, j) === x[2]);
  if (market === 'KG Var') return sum(ft, (i, j) => i > 0 && j > 0);
  if (market === 'KG Yok') return sum(ft, (i, j) => !(i > 0 && j > 0));
  if ((x = /^İY (\d\.5) (Üst|Alt)$/.exec(market))) {
    const line = Number(x[1]);
    return sum(ht, (i, j) => (x[2] === 'Üst' ? i + j > line : i + j < line));
  }
  if ((x = /^(\d\.5) (Üst|Alt)$/.exec(market))) {
    const line = Number(x[1]);
    return sum(ft, (i, j) => (x[2] === 'Üst' ? i + j > line : i + j < line));
  }
  if ((x = /^İY ([1X2])$/.exec(market))) return sum(ht, (i, j) => res(i, j) === x[1]);
  if ((x = /^İY\/MS ([1X2])\/([1X2])$/.exec(market))) {
    // İlk yarı ve ikinci yarı bağımsız: İY skoru (i,j) + ikinci yarı (k,l)
    const sh = scoreMatrix(lh * (1 - HT_SHARE), la * (1 - HT_SHARE), 0, 8);
    let p = 0;
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (res(i, j) !== x[1]) continue;
        const pht = ht[i]?.[j] ?? 0;
        if (pht < 1e-6) continue;
        p += pht * sum(sh, (k, l) => res(i + k, j + l) === x[2]);
      }
    }
    return p;
  }
  return null;
}

const pct = (p) => Math.round(p * 1000) / 10;

/** Seçim sonuçlarından kupon özeti (saf). */
export function summarize(items) {
  const probs = items.map((i) => i.prob);
  const combined = probs.reduce((a, b) => a * b, 1);
  const withOdds = items.every((i) => i.odd);
  const totalOdd = withOdds ? items.reduce((a, i) => a * i.odd, 1) : null;
  const ev = totalOdd ? combined * totalOdd - 1 : null;
  // Puan: seçim başına ortalama (geometrik) güven, 0-100
  const score = Math.round(100 * Math.pow(combined, 1 / items.length));
  let verdict;
  if (ev !== null) verdict = ev >= 0.05 ? 'value' : ev >= -0.05 ? 'fair' : 'bookmaker';
  else verdict = score >= 70 ? 'strong' : score >= 55 ? 'fair' : 'risky';
  const weakest = items.reduce((w, i, idx) => (w === -1 || i.prob < items[w].prob ? idx : w), -1);
  return {
    combinedPct: pct(combined),
    fairTotalOdd: combined > 0 ? Math.round((1 / combined) * 100) / 100 : null,
    totalOdd: totalOdd ? Math.round(totalOdd * 100) / 100 : null,
    evPct: ev === null ? null : Math.round(ev * 1000) / 10,
    score,
    verdict,
    weakest,
  };
}

export class CouponCheckService {
  /**
   * paid: PaidContentService (findMatch, contentFor, validate, access), store: saveCheck
   */
  constructor({ paid, store, now = () => Date.now(), narrator = new Narrator() }) {
    this.narrator = narrator;
    this.paid = paid;
    this.store = store;
    this.now = now;
  }

  async check({ uid, selections }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (!Array.isArray(selections) || selections.length < 1 || selections.length > 10) {
      throw new AppError('invalid-argument', 'Kuponda 1-10 maç olmalı.');
    }
    const keys = new Set();
    for (const s of selections) {
      this.paid.validate({ league: s?.league, eventId: s?.eventId, kickoff: s?.kickoff }, { needType: false });
      if (!CHECK_MARKETS.includes(s.market)) throw new AppError('invalid-argument', `Geçersiz tahmin: ${s.market}`);
      if (s.odd !== undefined && s.odd !== null && !(Number(s.odd) >= 1.01 && Number(s.odd) <= 100)) {
        throw new AppError('invalid-argument', 'Oranlar 1.01 ile 100 arasında olmalı.');
      }
      const k = matchKey(s.league, s.eventId);
      if (keys.has(k)) throw new AppError('invalid-argument', 'Aynı maç kuponda iki kez olamaz.');
      keys.add(k);
    }
    await this.paid.access.requireSubscriber(uid, 'Tahmin kontrol aracı abonelere özel.');

    // Önce hesap: veri alınamazsa ücret alınmaz.
    const items = [];
    for (const s of selections) {
      const match = await this.paid.findMatch(s);
      if (match.completed || match.timestamp <= this.now()) {
        throw new AppError('failed-precondition', `${match.homeName} - ${match.awayName} başladı; yalnızca başlamamış maçlar kontrol edilir.`);
      }
      const content = await this.paid.contentFor(match);
      const { home: lh, away: la } = content.odds.expectedGoals;
      const p = marketProbability(s.market, lh, la);
      const odd = s.odd ? Math.round(Number(s.odd) * 100) / 100 : null;
      // Aynı maçta daha güvenli alternatif (≥ %60 olasılık, aynı tahmin değil)
      let alternative = null;
      for (const m of CHECK_MARKETS) {
        if (m === s.market) continue;
        const q = marketProbability(m, lh, la);
        if (q >= 0.6 && q <= 0.92 && (!alternative || q > alternative.prob)) alternative = { market: m, prob: q };
      }
      items.push({
        league: match.league,
        eventId: String(match.id),
        kickoff: new Date(match.timestamp).toISOString(),
        home: match.homeName,
        away: match.awayName,
        market: s.market,
        odd,
        prob: p,
        alternative,
      });
    }
    const summary = summarize(items);
    // Kupon yorumu: sayılar motordan; anlatıcı açıksa yeniden yazılır.
    const narrated = await this.narrator.rewrite({
      draft: commentaryDraft(items, summary),
      facts: { seçimSayısı: String(items.length), maçlar: items.map((i) => `${i.home} - ${i.away}`).join(', ') },
    });
    const result = {
      ...summary,
      items: items.map((i) => ({
        ...i,
        pct: pct(i.prob),
        fairOdd: i.prob > 0.01 ? Math.round((1 / i.prob) * 100) / 100 : null,
        valuePct: i.odd ? Math.round((i.prob * i.odd - 1) * 1000) / 10 : null,
        alternative: i.alternative ? { market: i.alternative.market, pct: pct(i.alternative.prob) } : null,
        prob: undefined,
      })),
      commentary: narrated.text,
      commentarySource: narrated.source,
    };
    const id = `check_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.store.saveCheck?.(uid, id, result);
    return { ...result, id };
  }
}

// Kupon yorumu (kısa, olasılığa dayalı). Yalnızca motorun ürettiği sayıları kullanır; anlatıcı açıksa yeniden yazılır.
export function commentaryDraft(items, summary) {
  const parts = [`Seçimlerin birleşik olasılığı %${summary.combinedPct}.`];
  if (items.length > 1 && summary.weakest >= 0) {
    const w = items[summary.weakest];
    parts.push(`En zayıf seçim ${w.home} - ${w.away} (${w.market}, %${pct(w.prob)}).`);
  }
  parts.push(`Seçim puanı ${summary.score}/100.`);
  return parts.join(' ');
}
