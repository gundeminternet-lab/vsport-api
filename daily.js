// Günlük toplu tahminler ("Tahminler" sekmesi, Ana Sayfa'daki "Günün tahminleri" ve Canlı sekmesindeki takip).
// Kendi liglerimizdeki (logic.js → LEAGUES) maçlar için, maç BAŞLAMADAN önce beş tahmin hesaplanır:
//   ms  : maç sonucu (AI analizindeki tahmin)        → "MS 1" | "MS X" | "MS 2"
//   iy  : ilk yarı sonucu                           → "İY 1" | "İY X" | "İY 2"
//   au  : 2,5 gol alt/üst                           → "2.5 Üst" | "2.5 Alt"
//   kg  : karşılıklı gol                            → "KG Var" | "KG Yok"
//   iyg : ilk yarıda gol (0,5 alt/üst)              → "İY 0.5 Üst" | "İY 0.5 Alt"
// Oran gösterilmez; yalnızca tahmin ve olasılığı. Maçın "güven"i en güçlü tahminin olasılığıdır.
// Tahminler maç başına bir kez hesaplanır ve değiştirilmez; maç bitince sonuç işlenir (tuttu / tutmadı).
//
// Erişim: abone her tahmini görür; abone olmayan (ve misafir) güven yüzdesini ve kilitli kutuları görür. Maç bitince
// tahminler ve sonuçları herkese açılır (karne şeffaf). Deneme/çark hakkıyla AI paketi açılmış maç da açık görünür.
//
// Kayıt (yalnızca sunucu; firestore.rules):
//   daily_preds/{matchKey}   = { day, key, league, eventId, kickoffMs, home, away, markets, best, confidence, createdAt,
//                                result?: { status: 'done'|'void', home, away, ht }, hits?: { ms: true|false|null, ... } }
//   daily_pending/{matchKey} = { kickoffMs, league, eventId }   (sonuç bekleyenler)

import { markets as marketProbs } from './content.js';
import { LEAGUES, matchKey } from './logic.js';
import { matchFacts, settleMarket } from './settle.js';
import { trDay } from './progress.js';
import { AppError } from './errors.js';

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

/** AI içeriğinden beş tahmin (saf). content: logic.js → contentFor çıktısı (ai + model). */
export function marketsFromContent(content) {
  const ai = content?.ai;
  const model = content?.model;
  if (!ai?.probabilities || !model || !Number.isFinite(model.lambdaHome) || !Number.isFinite(model.lambdaAway)) return null;
  const { p } = marketProbs(model.lambdaHome, model.lambdaAway, model.sigma ?? 0);
  const msPct = { '1': ai.probabilities.home, X: ai.probabilities.draw, '2': ai.probabilities.away }[ai.pick];
  const iy = [['1', p.iy1], ['X', p.iyX], ['2', p.iy2]].sort((a, b) => b[1] - a[1])[0];
  const side = (prob, yes, no) => (prob >= 0.5 ? [yes, pct(prob)] : [no, pct(1 - prob)]);
  const [au, auPct] = side(p.over25, '2.5 Üst', '2.5 Alt');
  const [kg, kgPct] = side(p.kgVar, 'KG Var', 'KG Yok');
  const [iyg, iygPct] = side(p.iyOver05, 'İY 0.5 Üst', 'İY 0.5 Alt');
  return [
    { id: 'ms', pick: `MS ${ai.pick}`, pct: Number.isFinite(msPct) ? msPct : 0 },
    { id: 'iy', pick: `İY ${iy[0]}`, pct: pct(iy[1]) },
    { id: 'au', pick: au, pct: auPct },
    { id: 'kg', pick: kg, pct: kgPct },
    { id: 'iyg', pick: iyg, pct: iygPct },
  ];
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
  const best = list.reduce((a, b) => (b.pct > a.pct ? b : a));
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
    reason: reasonOf(content),
    createdAt: now,
  };
}

/** Bitmiş maçın sonucu ve her tahminin hükmü (saf). facts: settle.js → matchFacts. Bekleniyorsa null. */
export function settleEntry(entry, facts, now) {
  if (facts.postponed || (!facts.completed && now - entry.kickoffMs > VOID_AFTER_MS)) {
    return { result: { status: 'void' }, hits: {} };
  }
  if (!facts.completed || typeof facts.home !== 'number' || typeof facts.away !== 'number') return null;
  const hits = Object.fromEntries(entry.markets.map((m) => [m.id, settleMarket(m.pick, facts)]));
  return { result: { status: 'done', home: facts.home, away: facts.away, ht: facts.ht ?? null }, hits };
}

/** Günün özeti (saf): sonuçlanan maçlarda en güçlü tahminin isabeti ve ortalama güven. */
export function daySummary(rows) {
  const done = rows.filter((r) => r.result?.status === 'done');
  let hit = 0;
  let miss = 0;
  for (const r of done) {
    const h = r.hits?.[r.best];
    if (h === true) hit++;
    else if (h === false) miss++;
  }
  const valid = rows.filter((r) => r.result?.status !== 'void');
  const avg = valid.length ? Math.round(valid.reduce((s, r) => s + (r.confidence ?? 0), 0) / valid.length) : null;
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
  constructor({ paid, store, espn, access, leagues = LEAGUES, now = () => Date.now(), perTick = 4, planMs = 30 * 60e3, listCacheMs = 60e3, log = console, isAdmin = null, statusExtra = null }) {
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
    this.stats = { ticks: 0, lastTickAt: null, planned: 0, pending: 0, made: 0, failed: 0, lastError: null, lastErrorAt: null, resolved: 0 };
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
          if (!m.completed && Number.isFinite(m.timestamp) && days.has(trDay(m.timestamp))) out.push({ ...m, league: m.league ?? league });
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
    this._plan = { at: out.length ? now : now - this.planMs + 5 * 60e3, matches: out };
    return out;
  }

  /** Bugün ve yarının başlamamış ya da sürmekte olan maçları (fikstür planı; dış veri toplayıcı da kullanır). */
  async upcoming() {
    return this._matches();
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
      return {
        key: r.key,
        league: r.league,
        eventId: r.eventId,
        kickoff: new Date(r.kickoffMs).toISOString(),
        home: r.home,
        away: r.away,
        confidence: r.confidence,
        best: r.best,
        open: visible,
        reason: visible ? (r.reason ?? null) : null,
        markets: r.markets.map((m) =>
          visible
            ? { id: m.id, pick: m.pick, pct: m.pct, hit: r.hits?.[m.id] ?? null }
            : { id: m.id, pick: null, pct: null, hit: null },
        ),
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
    async saveDailyResult(key, settled) {
      if (settled) await db.doc(`daily_preds/${key}`).set({ ...settled, resolved: true, resolvedAt: FieldValue.serverTimestamp() }, { merge: true });
      await db.doc(`daily_pending/${key}`).delete();
    },
  };
}
