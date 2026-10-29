// Günlük toplu tahminler ("Tahminler" sekmesi, Ana Sayfa'daki "Günün tahminleri" ve Canlı sekmesindeki takip).
// Kendi liglerimizdeki (logic.js → LEAGUES) maçlar için, maç BAŞLAMADAN önce beş tahmin hesaplanır:
//   ms  : maç sonucu (AI analizindeki tahmin)        → "MS 1" | "MS X" | "MS 2"
//   iy  : ilk yarı sonucu                           → "İY 1" | "İY X" | "İY 2"
//   au  : 2,5 gol alt/üst                           → "2.5 Üst" | "2.5 Alt"
//   kg  : karşılıklı gol                            → "KG Var" | "KG Yok"
//   iyg : ilk yarıda gol (0,5 alt/üst)              → "İY 0.5 Üst" | "İY 0.5 Alt"
// Oran gösterilmez; yalnızca tahmin ve olasılığı. Maçın "güven"i en güçlü tahminin olasılığıdır.
// İlk tahmin maç başına bir kez hesaplanır ve saklanır (markets). Sonra dış tahmin verisi değiştikçe (market.js)
// gol beklentileri yeniden birleştirilir ve "live" alanı güncellenir: tahminler maç başlayana kadar hareket eder,
// başlamadan bir dakika önce kilitlenir. Karne kilitlenen son tahmine göre tutulur (ilk tahminin sonucu da saklanır).
//
// Erişim: abone her tahmini görür; abone olmayan (ve misafir) güven yüzdesini ve kilitli kutuları görür. Maç bitince
// tahminler ve sonuçları herkese açılır (karne şeffaf). Deneme/çark hakkıyla AI paketi açılmış maç da açık görünür.
//
// Kayıt (yalnızca sunucu; firestore.rules):
//   daily_preds/{matchKey}   = { day, key, league, eventId, kickoffMs, home, away, markets, best, confidence, createdAt,
//                                model: { lh, la, sigma }, probs: { home, draw, away },
//                                live?: { at, rev, weight, lambdas, sigma, markets, best, confidence, probs },
//                                result?: { status: 'done'|'void', home, away, ht }, hits?: { ms: true|false|null, ... },
//                                firstHits?: (canlı güncelleme olduysa ilk tahminin sonucu) }
//   daily_pending/{matchKey} = { kickoffMs, league, eventId }   (sonuç bekleyenler)

import { markets as marketProbs } from './content.js';
import { blendLambdas, marketWeight } from './engine/blend.js';
import { LEAGUES, matchKey } from './logic.js';
import { matchFacts, settleMarket } from './settle.js';
import { trDay } from './progress.js';
import { AppError } from './errors.js';
import { predictionDetail, DETAIL_MARKETS } from './prediction_detail.js';

const DAY = 86400000;
/** Maç bitmiş sayılmadan önce beklenen süre. */
const FINISH_GRACE_MS = 110 * 60e3;
/** Başlama saatinden bu kadar sonra hâlâ bitmemiş maç geçersiz (ertelenmiş/iptal). */
const VOID_AFTER_MS = 3 * DAY;
/** Başlamasına bundan az kalmış maç için yeni tahmin üretilmez (geç üretilen tahmin karneye uygun değil). */
const MIN_LEAD_MS = 5 * 60e3;
/** İstemcinin "açtım" dediği maçlardan en fazla bu kadarı doğrulanır. */
const MAX_CLAIMS = 30;
/** Tek maçın hesaplanması bundan uzun sürerse bırakılır (takılan bir istek bütün hattı durdurmasın). */
const MATCH_TIMEOUT_MS = 3 * 60e3;
/** Başlamasına bundan az kalan maçın tahmini artık değişmez (kilit). */
export const LIVE_LOCK_MS = 60e3;
/** Bir tur bundan uzun "meşgul" kalırsa takılmış sayılır, yeni tur başlar. */
const STALE_BUSY_MS = 12 * 60e3;
/** Sonuçlanamayan maçın yeniden denenmesi için beklenen süre. */
const RETRY_MS = 30 * 60e3;

const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
};

export const MARKET_IDS = ['ms', 'iy', 'au', 'kg', 'iyg'];

const pct = (p) => Math.round(p * 100);

/** İlk yarı, alt/üst, KG ve İY gol tahminleri (saf): ms tahmini dışarıdan verilir. */
function restMarkets(p, ms) {
  const iy = [['1', p.iy1], ['X', p.iyX], ['2', p.iy2]].sort((a, b) => b[1] - a[1])[0];
  const side = (prob, yes, no) => (prob >= 0.5 ? [yes, pct(prob)] : [no, pct(1 - prob)]);
  const [au, auPct] = side(p.over25, '2.5 Üst', '2.5 Alt');
  const [kg, kgPct] = side(p.kgVar, 'KG Var', 'KG Yok');
  const [iyg, iygPct] = side(p.iyOver05, 'İY 0.5 Üst', 'İY 0.5 Alt');
  return [
    ms,
    { id: 'iy', pick: `İY ${iy[0]}`, pct: pct(iy[1]) },
    { id: 'au', pick: au, pct: auPct },
    { id: 'kg', pick: kg, pct: kgPct },
    { id: 'iyg', pick: iyg, pct: iygPct },
  ];
}

/** AI içeriğinden beş tahmin (saf). content: logic.js → contentFor çıktısı (ai + model). */
export function marketsFromContent(content) {
  const ai = content?.ai;
  const model = content?.model;
  if (!ai?.probabilities || !model || !Number.isFinite(model.lambdaHome) || !Number.isFinite(model.lambdaAway)) return null;
  const { p } = marketProbs(model.lambdaHome, model.lambdaAway, model.sigma ?? 0);
  const msPct = { '1': ai.probabilities.home, X: ai.probabilities.draw, '2': ai.probabilities.away }[ai.pick];
  return restMarkets(p, { id: 'ms', pick: `MS ${ai.pick}`, pct: Number.isFinite(msPct) ? msPct : 0 });
}

/**
 * Türlerin olağan yüzdeleri: seçilen tarafın yüzdesi → maçların ne kadarında bundan düşük çıkıyor (geriye dönük test,
 * ~36 bin maç). "İY 0.5 Üst" neredeyse her maçta %65-75 çıkar; en yüksek yüzdeyi seçmek kartlarda hep aynı tahmini
 * gösteriyordu. Öne çıkan tahmin: kendi türünde en sıra dışı olan (yüksek yüzdelik), yeterince güçlü ([BEST_FLOOR]).
 */
export const PCT_TABLE = {
  ms: [[35, 0.011], [38, 0.114], [40, 0.218], [42, 0.315], [44, 0.408], [46, 0.494], [48, 0.573], [50, 0.644], [52, 0.705], [55, 0.782], [58, 0.84], [60, 0.873], [63, 0.91], [66, 0.938], [70, 0.964], [75, 0.984], [80, 0.995], [85, 0.999]],
  iy: [[38, 0.042], [40, 0.159], [42, 0.353], [44, 0.566], [46, 0.739], [48, 0.854], [50, 0.921], [52, 0.955], [55, 0.978], [60, 0.994], [65, 0.998]],
  au: [[50, 0.018], [52, 0.145], [54, 0.285], [56, 0.421], [58, 0.544], [60, 0.654], [62, 0.748], [64, 0.823], [66, 0.88], [68, 0.923], [70, 0.953], [73, 0.98], [76, 0.992], [80, 0.998]],
  kg: [[50, 0.024], [52, 0.19], [54, 0.369], [56, 0.528], [58, 0.666], [60, 0.778], [62, 0.862], [64, 0.921], [66, 0.958], [68, 0.979], [70, 0.991], [74, 0.999]],
  iyg: [[56, 0.012], [58, 0.026], [60, 0.054], [62, 0.1], [64, 0.17], [66, 0.266], [68, 0.382], [70, 0.512], [72, 0.644], [74, 0.769], [76, 0.869], [78, 0.935], [80, 0.973], [82, 0.991], [85, 0.999]],
};

/** Öne çıkan tahmin en az bu kadar güçlü olmalı (yoksa en yüksek yüzdeli tahmin). */
export const BEST_FLOOR = 57;

/** Öne çıkan tahmin kuralının sürümü (kayıtta saklanır; eski kayıtlar maç kilitlenmeden önce yeni kurala geçer). */
export const BEST_RULE = 2;

/** Tahminin kendi türünde ne kadar sıra dışı olduğu: 0 (sıradan) - 1 (çok nadir). */
export function standout(id, pct, pick = '') {
  const t = PCT_TABLE[id];
  if (!t || !Number.isFinite(pct)) return 0;
  // "İY 0.5 Alt" çok nadirdir: Üst yüzdesi ne kadar düşükse o kadar sıra dışı
  if (id === 'iyg' && /Alt$/.test(pick)) return 1 - standout('iyg', 100 - pct);
  if (pct < t[0][0]) return 0;
  for (let i = 1; i < t.length; i++) {
    const [x1, y1] = t[i];
    if (pct <= x1) {
      const [x0, y0] = t[i - 1];
      return y0 + ((pct - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return 1;
}

/** Öne çıkan tahmin (saf): [BEST_FLOOR] ve üstündekiler arasında kendi türünde en sıra dışı olan; eşitlikte yüzdesi yüksek. */
export function pickBest(list) {
  const top = list.reduce((a, b) => (b.pct > a.pct ? b : a));
  const pool = list.filter((m) => Number.isFinite(m.pct) && m.pct >= BEST_FLOOR && PCT_TABLE[m.id]);
  if (!pool.length) return top;
  const sc = (m) => standout(m.id, m.pct, m.pick);
  return pool.reduce((a, b) => {
    const d = sc(b) - sc(a);
    return d > 1e-9 || (Math.abs(d) <= 1e-9 && b.pct > a.pct) ? b : a;
  });
}

/**
 * Gol beklentilerinden beş tahmin, en güçlüsü ve 1X2 olasılıkları (saf). Canlı güncellemede kullanılır.
 * Döner: { markets, best, confidence, probs }
 */
export function marketsFromModel(lh, la, sigma = 0) {
  const { p } = marketProbs(lh, la, sigma);
  const pick = p.ms1 >= p.msX && p.ms1 >= p.ms2 ? '1' : p.ms2 >= p.msX && p.ms2 >= p.ms1 ? '2' : 'X';
  const list = restMarkets(p, { id: 'ms', pick: `MS ${pick}`, pct: pct({ '1': p.ms1, X: p.msX, '2': p.ms2 }[pick]) });
  const best = pickBest(list);
  return { markets: list, best: best.id, confidence: best.pct, probs: { home: pct(p.ms1), draw: pct(p.msX), away: pct(p.ms2) } };
}

/** Kaydın geçerli (son) tahmini: canlı güncelleme varsa o, yoksa ilk tahmin. */
export function finalOf(entry) {
  const l = entry?.live;
  if (l && Array.isArray(l.markets) && l.markets.length) return { markets: l.markets, best: l.best, confidence: l.confidence };
  return { markets: entry?.markets ?? [], best: entry?.best, confidence: entry?.confidence };
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/**
 * Dış tahmin verisinin son görüntüsüyle kaydın canlı tahmini (saf). Değişiklik yoksa, maç kilitlendiyse ya da
 * veri kullanılamıyorsa null.
 */
export function liveUpdate(entry, snap, now) {
  if (!entry || entry.result || entry.resolved) return null;
  if (!(entry.kickoffMs - now >= LIVE_LOCK_MS)) return null;
  const m = entry.model;
  if (!m || !Number.isFinite(m.lh) || !Number.isFinite(m.la)) return null;
  const w = marketWeight(snap, { now });
  if (w <= 0) return null;
  const b = blendLambdas({ home: m.lh, away: m.la, sigma: m.sigma ?? 0 }, snap.lambdas, w);
  const next = marketsFromModel(b.home, b.away, b.sigma);
  const prev = entry.live;
  if (prev?.markets?.length === next.markets.length && prev.markets.every((x, i) => x.pick === next.markets[i].pick && x.pct === next.markets[i].pct)) return null;
  // İlk tahminle aynıysa (ve önceden canlı güncelleme yoksa) yazmaya gerek yok
  if (!prev && entry.markets?.every((x, i) => x.pick === next.markets[i]?.pick && x.pct === next.markets[i]?.pct)) return null;
  return {
    at: now,
    rev: (prev?.rev ?? 0) + 1,
    weight: Math.round(w * 1000) / 1000,
    lambdas: { home: r4(b.home), away: r4(b.away) },
    sigma: r4(b.sigma),
    ...next,
  };
}

/**
 * Eski kuralla (en yüksek yüzde) seçilmiş, henüz kilitlenmemiş kaydın öne çıkan tahminini yeni kurala göre yeniden
 * seçer (saf). Değişiklik yoksa null; varsa kayda yazılacak alanlar. Kilitlenen/sonuçlanan kayıtlara dokunulmaz:
 * karne kullanıcının o an gördüğü tahminle tutulur.
 */
export function rebestPatch(entry, now) {
  if (!entry || entry.result || entry.resolved || entry.bestRule === BEST_RULE) return null;
  if (!(entry.kickoffMs - now >= LIVE_LOCK_MS) || !Array.isArray(entry.markets) || !entry.markets.length) return null;
  const first = pickBest(entry.markets);
  const patch = { best: first.id, confidence: first.pct, bestRule: BEST_RULE };
  const l = entry.live;
  if (l && Array.isArray(l.markets) && l.markets.length) {
    const lb = pickBest(l.markets);
    patch['live.best'] = lb.id;
    patch['live.confidence'] = lb.pct;
  }
  return patch;
}

/** Kartta gösterilen kısa gerekçe: AI analizindeki "Maçın anahtarı" (yoksa "Genel bakış"), en fazla ~220 karakter. */
export function reasonOf(content) {
  const sections = content?.ai?.sections ?? [];
  const pick = sections.find((x) => x.title === 'Maçın anahtarı') ?? sections.find((x) => x.title === 'Genel bakış');
  const text = String(pick?.text ?? '').trim();
  if (text.length <= 220) return text || null;
  const cut = text.slice(0, 220);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > 80 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Maç + içerikten kayıt (saf). Geçersizse null. */
export function dailyEntry(match, content, now) {
  const list = marketsFromContent(content);
  if (!list) return null;
  const best = pickBest(list);
  return {
    day: trDay(match.timestamp),
    key: matchKey(match.league, match.id),
    league: match.league,
    eventId: String(match.id),
    kickoffMs: match.timestamp,
    home: { id: String(match.homeId ?? ''), name: match.homeName ?? '', logo: match.homeLogo ?? null },
    away: { id: String(match.awayId ?? ''), name: match.awayName ?? '', logo: match.awayLogo ?? null },
    markets: list,
    best: best.id,
    confidence: best.pct,
    bestRule: BEST_RULE,
    reason: reasonOf(content),
    // Canlı güncelleme için modelin kendi gol beklentileri (dış veriyle birleştirilecek taban)
    model: { lh: r4(content.model.lambdaHome), la: r4(content.model.lambdaAway), sigma: r4(content.model.sigma ?? 0) },
    probs: content.ai?.probabilities ?? null,
    createdAt: now,
  };
}

/** Bitmiş maçın sonucu ve her tahminin hükmü (saf). facts: settle.js → matchFacts. Bekleniyorsa null. */
export function settleEntry(entry, facts, now) {
  if (facts.postponed || (!facts.completed && now - entry.kickoffMs > VOID_AFTER_MS)) {
    return { result: { status: 'void' }, hits: {} };
  }
  if (!facts.completed || typeof facts.home !== 'number' || typeof facts.away !== 'number') return null;
  // Karne maç başında kilitlenen son tahmine göre; canlı güncelleme olduysa ilk tahminin sonucu da saklanır
  const hits = Object.fromEntries(finalOf(entry).markets.map((m) => [m.id, settleMarket(m.pick, facts)]));
  const out = { result: { status: 'done', home: facts.home, away: facts.away, ht: facts.ht ?? null }, hits };
  if (entry.live?.markets?.length) out.firstHits = Object.fromEntries(entry.markets.map((m) => [m.id, settleMarket(m.pick, facts)]));
  return out;
}

/** Günün özeti (saf): sonuçlanan maçlarda en güçlü tahminin isabeti ve ortalama güven. */
export function daySummary(rows) {
  const done = rows.filter((r) => r.result?.status === 'done');
  let hit = 0;
  let miss = 0;
  for (const r of done) {
    const h = r.hits?.[finalOf(r).best];
    if (h === true) hit++;
    else if (h === false) miss++;
  }
  const valid = rows.filter((r) => r.result?.status !== 'void');
  const avg = valid.length ? Math.round(valid.reduce((s, r) => s + (finalOf(r).confidence ?? 0), 0) / valid.length) : null;
  return { total: valid.length, settled: hit + miss, hit, miss, rate: hit + miss ? Math.round((hit / (hit + miss)) * 100) : null, avgConfidence: avg };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * store arayüzü (createDailyStore):
 *   saveDaily(entry) -> bool (zaten varsa false)   listDaily(day) -> [entry]
 *   listDailyDue(beforeMs, limit) -> [{ key, kickoffMs, league, eventId }]   getDaily(key) -> entry | null
 *   saveDailyResult(key, { result, hits })   hasUnlock(uid, key, type) (users/{uid}/unlocks)
 */
export class DailyPredictionService {
  constructor({ paid, store, espn, access, leagues = LEAGUES, now = () => Date.now(), perTick = 4, planMs = 30 * 60e3, listCacheMs = 60e3, log = console, isAdmin = null, statusExtra = null, marketLatest = null }) {
    /** Dış tahmin verisinin bellekteki son görüntüsü (market.js → latest): yeni tahmin hemen güncel veriyle başlasın. */
    this.marketLatest = marketLatest;
    /** Liste boşken yöneticiye hat durumu gösterilsin diye (uid → bool). */
    this.isAdmin = isAdmin;
    /** Durum özetine eklenecek sunucu bilgisi (sürüm, bellek). */
    this.statusExtra = statusExtra;
    this.startedAt = now();
    this.paid = paid;
    this.store = store;
    this.espn = espn;
    this.access = access;
    this.leagues = leagues;
    this.now = now;
    this.perTick = perTick;
    this.planMs = planMs;
    this.listCacheMs = listCacheMs;
    this.log = log;
    this._plan = null; // { at, matches }
    this._known = new Set(); // kaydı olan maç anahtarları (gün listeleriyle doldurulur)
    this._knownDays = new Map(); // day → son okuma zamanı
    this._failed = new Map(); // key → son hata zamanı (30 dk beklenir)
    this._lists = new Map(); // day → { at, rows }
    this._busy = false;
    this._busyAt = 0;
    // Durum (sunucu /version adresinde görünür): hattın çalışıp çalışmadığı uzaktan anlaşılsın
    this.stats = { ticks: 0, lastTickAt: null, planned: 0, pending: 0, made: 0, failed: 0, lastError: null, lastErrorAt: null, resolved: 0, liveUpdates: 0 };
  }

  /** /version'da gösterilen özet. */
  status() {
    return {
      ...(this.statusExtra?.() ?? {}),
      ...this.stats,
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMin: Math.round((this.now() - this.startedAt) / 60e3),
      busy: this._busy,
      busySince: this._busy ? new Date(this._busyAt).toISOString() : null,
    };
  }

  _error(key, e) {
    const message = `${key}: ${e?.message ?? e}`;
    this.stats.failed++;
    this.stats.lastError = message.slice(0, 300);
    this.stats.lastErrorAt = new Date(this.now()).toISOString();
    this.log.error?.(`[daily] ${message}`);
  }

  /** Bugün ve yarının (Türkiye saati) maçları; lig başına tek fikstür isteği (3 günlük aralık), 30 dakika saklanır. */
  async _matches() {
    const now = this.now();
    if (this._plan && now - this._plan.at < this.planMs) return this._plan.matches;
    const days = new Set([trDay(now), trDay(now + DAY)]);
    const from = new Date(now - DAY);
    const to = new Date(now + 2 * DAY);
    const out = [];
    const recent = [];
    let next = 0;
    const worker = async () => {
      while (next < this.leagues.length) {
        const league = this.leagues[next++];
        let list;
        try {
          list = await this.espn.getFixtures(league, from, to);
        } catch {
          // Tarih aralığı isteği reddedildiyse gün gün denenir; o da olmazsa lig sonraki planda yeniden denenir
          list = [];
          for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
            try {
              list.push(...(await this.espn.getFixtures(league, new Date(t))));
            } catch {
              // bu gün alınamadı
            }
          }
        }
        for (const m of list) {
          if (m.completed || !Number.isFinite(m.timestamp)) continue;
          if (days.has(trDay(m.timestamp))) out.push({ ...m, league: m.league ?? league });
          // Gece yarısından önce başlayıp süren maçlar da Canlı Radar'a girsin (gün listesinde olmasalar da)
          else if (m.timestamp >= now - 4 * 3600e3 && m.timestamp <= now) recent.push({ ...m, league: m.league ?? league });
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const seen = new Set();
    for (let i = out.length - 1; i >= 0; i--) {
      const k = matchKey(out[i].league, out[i].id);
      if (seen.has(k)) out.splice(i, 1);
      else seen.add(k);
    }
    out.sort((a, b) => a.timestamp - b.timestamp);
    // Hiç maç alınamadıysa (ESPN erişilemedi) plan 30 dakika beklemeden 5 dakika sonra yeniden kurulur
    this._plan = { at: out.length ? now : now - this.planMs + 5 * 60e3, matches: out, recent };
    return out;
  }

  /**
   * Canlı Radar'ın tarayacağı maçlar: başlamış (en çok [maxAgeMin] dakika önce) ya da 2 dakika içinde başlayacak maçlar.
   * Fikstür planından gelir (ek istek yok).
   */
  async liveCandidates({ maxAgeMin = 150 } = {}) {
    const list = await this._matches();
    const now = this.now();
    const all = [...list, ...(this._plan?.recent ?? [])];
    return all.filter((m) => m.timestamp <= now + 2 * 60e3 && now - m.timestamp <= maxAgeMin * 60e3);
  }

  /**
   * Dış tahmin verisi değişince (market.js → onUpdate) maçın tahminini günceller. Kilitli (başlamak üzere ya da
   * başlamış) maça, değişiklik yoksa ya da veri zayıfsa dokunulmaz. Döner: yeni canlı tahmin | null.
   */
  async applyMarket(key, snap, { entry = null } = {}) {
    const now = this.now();
    const e = entry ?? (await this.store.getDaily(key));
    const live = liveUpdate(e, snap, now);
    if (!live) return null;
    await this.store.saveDailyLive(key, live);
    this._lists.delete(e.day);
    this.stats.liveUpdates++;
    this.stats.lastLiveAt = new Date(now).toISOString();
    return live;
  }

  /**
   * Tahmin detayı (uygulamada tahmin kartına dokununca): bütün tahmin türleri, seçeneklerin olasılıkları ve kısa
   * gerekçeler. Erişim listeyle aynı: abone, maçı deneme/çark hakkıyla açan ya da bitmiş maç. Kapalıysa yalnızca güven
   * ve türlerin adları döner.
   */
  async detail({ uid, key, unlocked = false, guest = false }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (typeof key !== 'string' || !/^[A-Za-z0-9_]{3,120}$/.test(key)) throw new AppError('invalid-argument', 'Geçersiz maç.');
    const entry = await this.store.getDaily(key);
    if (!entry) throw new AppError('not-found', 'Bu maç için tahmin bulunamadı.');
    const now = this.now();
    const settled = entry.result?.status === 'done' || entry.result?.status === 'void';
    let open = settled;
    if (!open && !guest) {
      const ent = await this.access.entitlement(uid);
      open = ent.subscribed === true || (unlocked === true && (await this.store.hasUnlock(uid, key, 'ai')));
    }
    const fin = finalOf(entry);
    const head = {
      key,
      league: entry.league,
      eventId: entry.eventId,
      kickoff: new Date(entry.kickoffMs).toISOString(),
      home: entry.home,
      away: entry.away,
      best: fin.best,
      confidence: fin.confidence,
      open,
      locked: settled || entry.kickoffMs - now < LIVE_LOCK_MS,
      updatedAt: entry.live?.at ? new Date(entry.live.at).toISOString() : null,
      result: entry.result ?? null,
    };
    if (!open) return { ...head, expected: null, markets: DETAIL_MARKETS.map((m) => ({ id: m.id, title: m.title, pick: null, pct: null, options: [], why: [], hit: null })) };
    const d = predictionDetail(entry, fin, await this._contentModel(key));
    return { ...head, ...d };
  }

  /** AI içeriğinin model alanı (form, sıra, gol ortalamaları); 30 dakika bellekte. Okunamazsa null. */
  async _contentModel(key) {
    this._cm ??= new Map();
    const hit = this._cm.get(key);
    if (hit && this.now() - hit.at < 30 * 60e3) return hit.model;
    let model = null;
    try {
      model = (await this.paid?.store?.getContent?.(key))?.model ?? null;
    } catch {
      model = null;
    }
    this._cm.set(key, { at: this.now(), model });
    if (this._cm.size > 500) this._cm.delete(this._cm.keys().next().value);
    return model;
  }

  /** Maçın kilitlenen son gol beklentileri (canlı modelin maç öncesi tabanı). Canlı güncelleme yoksa null. */
  async finalLambdas(key) {
    const e = await this.store.getDaily(key);
    const l = e?.live?.lambdas;
    return l && Number.isFinite(l.home) && Number.isFinite(l.away) ? { home: l.home, away: l.away, sigma: e.live.sigma } : null;
  }

  /** Bugün ve yarının başlamamış ya da sürmekte olan maçları (fikstür planı; dış veri toplayıcı da kullanır). */
  async upcoming() {
    return this._matches();
  }

  /**
   * Eski kuralla seçilmiş bugünün ve yarının kilitlenmemiş tahminlerini yeni öne çıkan kuralına geçirir (10 dakikada bir,
   * tur başına en çok 60). Geçirilecek kayıt kalmayınca durur.
   */
  async _rebest(now) {
    if (typeof this.store.updateDaily !== 'function' || this._rebestClean) return 0;
    if (this._rebestAt && now - this._rebestAt < 10 * 60e3) return 0;
    this._rebestAt = now;
    let done = 0;
    for (const day of [trDay(now), trDay(now + DAY)]) {
      for (const r of await this._rows(day)) {
        if (done >= 60) return done;
        const patch = rebestPatch(r, now);
        if (!patch) continue;
        await this.store.updateDaily(r.key, patch);
        done++;
        this._lists.delete(day);
      }
    }
    // Eski kayıt kalmadı: yeni kayıtlar zaten yeni kuralla üretiliyor, bir daha taranmaz
    if (!done) this._rebestClean = true;
    return done;
  }

  async _loadKnown(day) {
    const now = this.now();
    const at = this._knownDays.get(day) ?? 0;
    if (now - at < this.planMs) return;
    for (const r of await this.store.listDaily(day)) this._known.add(r.key);
    this._knownDays.set(day, now);
    if (this._known.size > 5000) this._known.clear();
  }

  /** Dakikada bir çağrılır: henüz tahmini olmayan en yakın maçlardan [perTick] tanesini hesaplar. */
  async tick() {
    if (this._busy && this.now() - this._busyAt < STALE_BUSY_MS) return 0;
    this._busy = true;
    this._busyAt = this.now();
    let made = 0;
    try {
      const now = this.now();
      this.stats.ticks++;
      this.stats.lastTickAt = new Date(now).toISOString();
      await this._loadKnown(trDay(now));
      await this._loadKnown(trDay(now + DAY));
      await this._rebest(now).catch((e) => this._error('öne çıkan geçişi', e));
      const todo = (await this._matches()).filter((m) => {
        const key = matchKey(m.league, m.id);
        if (this._known.has(key)) return false;
        if (m.timestamp - now < MIN_LEAD_MS) return false;
        const failedAt = this._failed.get(key);
        return !(failedAt && now - failedAt < 30 * 60e3);
      });
      this.stats.planned = (this._plan?.matches ?? []).length;
      this.stats.pending = todo.length;
      for (const m of todo.slice(0, this.perTick)) {
        const key = matchKey(m.league, m.id);
        try {
          let content = await withTimeout(this.paid.contentFor(m), MATCH_TIMEOUT_MS, 'zaman aşımı');
          // "model" alanı eklenmeden önce üretilmiş (önbellekteki) içerikte tahmin sayıları yeniden hesaplanır
          if (!content?.model && typeof this.paid.modelFor === 'function') {
            content = { ...content, model: await withTimeout(this.paid.modelFor(m, content), MATCH_TIMEOUT_MS, 'zaman aşımı') };
          }
          const entry = dailyEntry(m, content, this.now());
          if (!entry) throw new Error('tahmin hesaplanamadı');
          await this.store.saveDaily(entry);
          this._known.add(key);
          this._lists.delete(entry.day);
          made++;
          this.stats.made++;
          const snap = this.marketLatest?.(key);
          if (snap) await this.applyMarket(key, snap, { entry }).catch((e) => this._error(key, e));
        } catch (e) {
          this._failed.set(key, this.now());
          this._error(key, e);
        }
      }
    } catch (e) {
      this._error('tur', e);
      throw e;
    } finally {
      this._busy = false;
    }
    return made;
  }

  /**
   * Bitmiş maçların sonucunu işler (10 dakikada bir). Henüz bitmemiş ya da okunamayan maç yarım saat yeniden
   * denenmez: listenin başında takılı kalan eski maçlar (ertelenmiş, geçici veri sorunu) yeni biten maçları bekletmesin.
   */
  async resolveDue({ limit = 30 } = {}) {
    const now = this.now();
    this._tried ??= new Map();
    for (const [k, t] of this._tried) if (now - t > RETRY_MS) this._tried.delete(k);
    const listed = await this.store.listDailyDue(now - FINISH_GRACE_MS, limit * 4);
    const due = listed.filter((d) => !this._tried.has(d.key)).slice(0, limit);
    let done = 0;
    for (const d of due) {
      this._tried.set(d.key, now);
      const entry = await this.store.getDaily(d.key);
      if (!entry) {
        await this.store.saveDailyResult(d.key, null);
        continue;
      }
      let facts;
      try {
        facts = matchFacts(await this.espn.getSummary(entry.league, entry.eventId, { maxAgeMs: 10 * 60e3 }));
      } catch {
        continue; // veri alınamadı; sonraki turda
      }
      const settled = settleEntry(entry, facts, now);
      if (!settled) continue;
      await this.store.saveDailyResult(d.key, settled);
      this._tried.delete(d.key);
      this._lists.delete(entry.day);
      done++;
      this.stats.resolved++;
    }
    return done;
  }

  async _rows(day) {
    const now = this.now();
    const hit = this._lists.get(day);
    if (hit && now - hit.at < this.listCacheMs) return hit.rows;
    const rows = (await this.store.listDaily(day)).sort((a, b) => a.kickoffMs - b.kickoffMs);
    this._lists.set(day, { at: now, rows });
    if (this._lists.size > 20) this._lists.delete(this._lists.keys().next().value);
    return rows;
  }

  /**
   * Bir günün tahminleri. day: "YYYY-MM-DD" (Türkiye saati; bugünden 7 gün öncesi ile 2 gün sonrası arası).
   * unlocked: istemcinin deneme/çark hakkıyla AI paketini açtığını bildirdiği maç anahtarları (sunucuda doğrulanır).
   */
  async list({ uid, day = null, unlocked = [], guest = false }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const now = this.now();
    const d = day ?? trDay(now);
    if (typeof d !== 'string' || !DAY_RE.test(d)) throw new AppError('invalid-argument', 'Geçersiz tarih.');
    const t = Date.parse(`${d}T12:00:00+03:00`);
    if (!Number.isFinite(t) || t < now - 8 * DAY || t > now + 3 * DAY) throw new AppError('invalid-argument', 'Bu tarih için tahmin yok.');

    const rows = await this._rows(d);
    const ent = guest ? { subscribed: false } : await this.access.entitlement(uid);
    const open = new Set();
    if (!ent.subscribed && !guest && Array.isArray(unlocked) && unlocked.length) {
      const keys = new Set(rows.map((r) => r.key));
      const claims = [...new Set(unlocked)].filter((k) => typeof k === 'string' && keys.has(k)).slice(0, MAX_CLAIMS);
      const flags = await Promise.all(claims.map((k) => this.store.hasUnlock(uid, k, 'ai')));
      claims.forEach((k, i) => flags[i] && open.add(k));
    }
    const items = rows.map((r) => {
      const settled = r.result?.status === 'done' || r.result?.status === 'void';
      const visible = ent.subscribed || settled || open.has(r.key);
      const fin = finalOf(r);
      const moved = Boolean(r.live?.markets?.length);
      const first = new Map((r.markets ?? []).map((m) => [m.id, m]));
      return {
        key: r.key,
        league: r.league,
        eventId: r.eventId,
        kickoff: new Date(r.kickoffMs).toISOString(),
        home: r.home,
        away: r.away,
        confidence: fin.confidence,
        best: fin.best,
        open: visible,
        reason: visible ? (r.reason ?? null) : null,
        markets: fin.markets.map((m) =>
          visible
            ? {
                id: m.id,
                pick: m.pick,
                pct: m.pct,
                hit: r.hits?.[m.id] ?? null,
                // İlk tahmin (güncellendiyse): uygulama değişimi ok ve fark olarak gösterir
                ...(moved && first.has(m.id) ? { from: { pick: first.get(m.id).pick, pct: first.get(m.id).pct } } : {}),
              }
            : { id: m.id, pick: null, pct: null, hit: null },
        ),
        // Güncelleme bilgisi: kaçıncı sürüm, ne zaman; maç başlamadan bir dakika önce kilitlenir
        updatedAt: moved ? new Date(r.live.at).toISOString() : null,
        rev: r.live?.rev ?? 0,
        ...(moved && first.has(fin.best) ? { confidenceFrom: first.get(fin.best).pct } : {}),
        locked: settled || r.kickoffMs - now < LIVE_LOCK_MS,
        result: r.result ?? null,
      };
    });
    // Liste boşsa yöneticiye hattın durumu da gönderilir (Tahminler ekranında görünür; neden boş olduğu anlaşılsın)
    let diag = null;
    if (!rows.length && !guest && this.isAdmin) diag = (await this.isAdmin(uid).catch(() => false)) ? this.status() : null;
    return { day: d, subscribed: ent.subscribed === true, items, summary: daySummary(rows), ...(diag ? { diag } : {}) };
  }
}

/** Firestore veri katmanı. */
export function createDailyStore(db, FieldValue) {
  return {
    async saveDaily(entry) {
      try {
        await db.doc(`daily_preds/${entry.key}`).create({ ...entry, resolved: false, savedAt: FieldValue.serverTimestamp() });
      } catch (e) {
        if (e.code === 6 /* ALREADY_EXISTS */) return false;
        throw e;
      }
      await db.doc(`daily_pending/${entry.key}`).set({ kickoffMs: entry.kickoffMs, league: entry.league, eventId: entry.eventId });
      return true;
    },
    async listDaily(day) {
      const q = await db.collection('daily_preds').where('day', '==', day).limit(600).get();
      return q.docs.map((d) => d.data());
    },
    async getDaily(key) {
      const s = await db.doc(`daily_preds/${key}`).get();
      return s.exists ? s.data() : null;
    },
    async listDailyDue(beforeMs, limit) {
      const q = await db.collection('daily_pending').where('kickoffMs', '<', beforeMs).orderBy('kickoffMs').limit(limit).get();
      return q.docs.map((d) => ({ key: d.id, ...d.data() }));
    },
    /** Alan güncellemesi (noktalı anahtarlar iç alanı değiştirir: "live.best"). */
    async updateDaily(key, patch) {
      await db.doc(`daily_preds/${key}`).update(patch);
    },
    /** Canlı tahmin alanı bütünüyle değişir (update: iç içe birleştirme yapılmaz). */
    async saveDailyLive(key, live) {
      await db.doc(`daily_preds/${key}`).update({ live });
    },
    async saveDailyResult(key, settled) {
      if (settled) await db.doc(`daily_preds/${key}`).set({ ...settled, resolved: true, resolvedAt: FieldValue.serverTimestamp() }, { merge: true });
      await db.doc(`daily_pending/${key}`).delete();
    },
  };
}
