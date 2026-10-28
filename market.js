// Dış tahmin verisi toplayıcı: önümüzdeki ~48 saatin maçları için dış kaynakların fiyatlarını periyodik okur,
// olasılığa çevirir ve açılış / son / kapanış anlarını saklar. Veriler YALNIZCA sunucuda model girdisi ve
// karşılaştırma içindir: uygulamaya oran, kaynak adı ya da bağlantı gönderilmez (yönetici yalnızca kapsama sayılarını görür).
//
// Firestore (istemci kurallarıyla kapalı):
//   odds/{matchKey} = { key, league, eventId, kickoffMs, home, away, homeId, awayId, source,
//                       open, last, close: { at, x12: {home, draw, away, n, spread, margin}, ou: {line, over, under, n},
//                                            lambdas: {home, away, error}, from },
//                       history: [{ at, h, d, a, line, over }], providers: [ham ondalık fiyatlar], checks, misses,
//                       hasOdds, closed, updatedAt }
//   odds_coverage/{gün} = { day, leagues: { [lig]: { matches, withOdds, withX12, withOu, withClose } } }
//
// Görüntü değişince onUpdate(key, snap) çağrılır: daily.js → applyMarket tahminleri maç başına kadar günceller.
// Kaynak değiştirilebilir: sources = [{ name, fetch(match) → ham yanıt }]. Varsayılan sıra lig bazında öğrenilir
// (bir ligde ikinci kaynak veri verdiyse o lig için öne alınır).

import { parseOddsResponse, consensus, marketLambdas } from './engine/odds.js';
import { LEAGUES, matchKey } from './logic.js';
import { trDay } from './progress.js';
import { AppError } from './errors.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Başlama saatine kalan süreye göre yenileme aralığı (tahminler bu sıklıkta hareket edebilir). */
export function refreshEvery(leadMs) {
  if (leadMs > 24 * HOUR) return 3 * HOUR;
  if (leadMs > 6 * HOUR) return HOUR;
  if (leadMs > HOUR) return 30 * MIN;
  return 10 * MIN;
}

/** Değişmeyen görüntü en çok bu aralıkla yeniden yazılır (Firestore yazma sayısı). */
const SAVE_EVERY_MS = 3 * HOUR;

/** İki görüntü arasında anlamlı fark (≥ 0.5 puan ya da çizgi değişimi) var mı. */
export function snapMoved(a, b) {
  if (!a || !b) return true;
  const keys = [
    [a.x12?.home, b.x12?.home],
    [a.x12?.draw, b.x12?.draw],
    [a.x12?.away, b.x12?.away],
    [a.ou?.over, b.ou?.over],
  ];
  if ((a.ou?.line ?? null) !== (b.ou?.line ?? null) || Boolean(a.x12) !== Boolean(b.x12)) return true;
  return keys.some(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) >= 0.005);
}

/** Kapanış penceresi: başlamadan 10 dk önce ile başladıktan 3 dk sonrası (sonrası canlı fiyattır, alınmaz). */
export const CLOSE_WINDOW = { before: 10 * MIN, after: 3 * MIN };
const HISTORY_MAX = 12;

/** ESPN istemcisinden iki kaynak: core odds uç noktası ve maç özetindeki bloklar. */
export function espnSources(espn) {
  return [
    { name: 'core', fetch: (m) => espn.getOdds(m.league, m.id) },
    { name: 'summary', fetch: (m) => espn.getSummaryOdds(m.league, m.id) },
  ];
}

const slimProvider = (p) => ({ id: p.provider.id, name: p.provider.name, current: p.current, open: p.open, close: p.close });

const snapOf = (cons, at, from) => {
  if (!cons) return null;
  const lambdas = cons.x12 ? marketLambdas(cons) : null;
  return { at, x12: cons.x12, ou: cons.ou, lambdas, n: cons.providers, ...(from ? { from } : {}) };
};

/** Geçmiş satırı: yalnızca anlamlı değişimde (≥ 0.5 puan) ya da 6 saatte bir eklenir. */
function pushHistory(history, snap) {
  const row = {
    at: snap.at,
    h: snap.x12?.home ?? null,
    d: snap.x12?.draw ?? null,
    a: snap.x12?.away ?? null,
    line: snap.ou?.line ?? null,
    over: snap.ou?.over ?? null,
  };
  const prev = history[history.length - 1];
  if (prev) {
    const moved = ['h', 'd', 'a', 'over'].some((k) => row[k] !== null && prev[k] !== null && Math.abs(row[k] - prev[k]) >= 0.005) || row.line !== prev.line;
    if (!moved && row.at - prev.at < 6 * HOUR) return history;
  }
  const out = [...history, row];
  // İlk satır (açılış) korunur, sonra en yeniler
  return out.length > HISTORY_MAX ? [out[0], ...out.slice(out.length - HISTORY_MAX + 1)] : out;
}

export class MarketCollector {
  /**
   * matches: async () → yaklaşan maçlar [{ id, league, timestamp, homeName, awayName, homeId, awayId }]
   * store: createMarketStore arayüzü. isAdmin: async (uid) → bool (yönetici durum ekranı için).
   */
  /**
   * onUpdate: async (key, snap) → görüntü değişince çağrılır (daily.js → applyMarket: tahminler hareket eder).
   */
  constructor({ store, matches, sources, leagues = LEAGUES, now = () => Date.now(), perTick = 8, log = console, isAdmin = null, coverageCacheMs = 10 * MIN, onUpdate = null }) {
    this.store = store;
    this.onUpdate = onUpdate;
    this.matches = matches;
    this.sources = sources;
    this.leagues = leagues;
    this.now = now;
    this.perTick = perTick;
    this.log = log;
    this.isAdmin = isAdmin;
    this.coverageCacheMs = coverageCacheMs;
    this._state = new Map(); // key → { m, doc, nextAt, loaded }
    this._done = new Map(); // key → kickoffMs (sonuçlandırıldı; liste yenilenene dek yeniden ele alınmaz)
    this._league = new Map(); // lig → { checked, hits, misses, prefer, probedAt }
    this._busy = false;
    this._busyAt = 0;
    this._coverage = null; // { at, days }
    this.stats = { ticks: 0, lastTickAt: null, fetches: 0, hits: 0, errors: 0, closed: 0, lastError: null, lastErrorAt: null };
  }

  _leagueState(league) {
    let s = this._league.get(league);
    if (!s) {
      s = { checked: 0, hits: 0, misses: 0, prefer: 0, probedAt: 0 };
      this._league.set(league, s);
    }
    return s;
  }

  _error(key, e) {
    this.stats.errors++;
    // Yönetici ekranında görünür: adres ve kaynak adı ayıklanır
    const msg = String(e?.message ?? e)
      .replace(/\s*\(?https?:\/\/[^\s)]+\)?/g, '')
      .replace(/espn/gi, 'kaynak');
    this.stats.lastError = `${key}: ${msg}`.slice(0, 300);
    this.stats.lastErrorAt = new Date(this.now()).toISOString();
    this.log.warn?.(`[market] ${this.stats.lastError}`);
  }

  /** Hiç veri vermeyen ligde (≥ 6 maç denendi, hiç bulunmadı) aralık dört katına çıkar; kapanış denemesi yine yapılır. */
  _interval(m, now) {
    const ls = this._leagueState(m.league);
    const base = refreshEvery(m.timestamp - now);
    return ls.hits === 0 && ls.checked >= 6 ? base * 4 : base;
  }

  /** Dakikada bir çağrılır. Döner: bu turda yapılan okuma sayısı. */
  async tick() {
    if (this._busy && this.now() - this._busyAt < 10 * MIN) return 0;
    this._busy = true;
    this._busyAt = this.now();
    let work = 0;
    try {
      const now = this.now();
      this.stats.ticks++;
      this.stats.lastTickAt = new Date(now).toISOString();
      const list = await this.matches();
      const inList = new Set();
      for (const m of list) {
        if (!m?.id || !m.league || !Number.isFinite(m.timestamp)) continue;
        const key = matchKey(m.league, m.id);
        inList.add(key);
        if (this._done.has(key)) continue;
        const st = this._state.get(key);
        if (st) st.m = m;
        else this._state.set(key, { m, doc: null, nextAt: 0, loaded: false });
      }
      // Listeden düşen (bitmiş) maçlar: başlama saati geçtiyse sonuçlandırılır
      for (const [key, st] of this._state) {
        if (!inList.has(key) && st.m.timestamp + CLOSE_WINDOW.after < now) {
          // Hiç başarılı okuma yapılmadıysa (kayıt yok) kapsamaya sayılmaz
          if (st.loaded && st.doc) await this._finalize(key, st, now).catch((e) => this._error(key, e));
          this._state.delete(key);
        }
      }
      for (const [key, at] of this._done) if (at < now - DAY) this._done.delete(key);

      // Sıra: kapanış penceresindekiler, sonra en yakın başlama saati
      const due = [...this._state.entries()]
        .filter(([, st]) => st.nextAt <= now)
        .sort(([, a], [, b]) => {
          const ca = this._inClose(a.m, now) ? 0 : 1;
          const cb = this._inClose(b.m, now) ? 0 : 1;
          return ca - cb || a.m.timestamp - b.m.timestamp;
        });
      for (const [key, st] of due) {
        if (work >= this.perTick) break;
        work++;
        try {
          await this._visit(key, st, now);
        } catch (e) {
          this._error(key, e);
          st.nextAt = now + 15 * MIN;
        }
      }
      return work;
    } catch (e) {
      this._error('tick', e);
      return work;
    } finally {
      this._busy = false;
    }
  }

  _inClose(m, now) {
    return now >= m.timestamp - CLOSE_WINDOW.before && now <= m.timestamp + CLOSE_WINDOW.after;
  }

  async _visit(key, st, now) {
    const m = st.m;
    if (!st.loaded) {
      st.doc = await this.store.getOdds(key);
      st.loaded = true;
      if (st.doc?.closed) {
        this._state.delete(key);
        this._done.set(key, m.timestamp);
        return;
      }
    }
    // Kapanış penceresi kaçtıysa (sunucu kapalıydı) son okunan değerle sonuçlandırılır. Bu süreçte hiç
    // denenmemiş ve kaydı olmayan maç kapsamaya sayılmaz (veri olup olmadığı bilinmiyor).
    if (now > m.timestamp + CLOSE_WINDOW.after) {
      if (st.doc) await this._finalize(key, st, now);
      else {
        this._state.delete(key);
        this._done.set(key, m.timestamp);
      }
      return;
    }
    const closing = this._inClose(m, now);
    const providers = await this._fetch(m, now);
    const ls = this._leagueState(m.league);
    const first = !(st.doc?.checks > 0);
    if (first) ls.checked++;
    const doc = st.doc ?? {
      key,
      league: m.league,
      eventId: String(m.id),
      kickoffMs: m.timestamp,
      home: m.homeName ?? null,
      away: m.awayName ?? null,
      homeId: m.homeId ?? null,
      awayId: m.awayId ?? null,
      open: null,
      last: null,
      close: null,
      history: [],
      checks: 0,
      misses: 0,
      hasOdds: false,
      closed: false,
    };
    doc.kickoffMs = m.timestamp; // saat değişmiş olabilir
    doc.checks = (doc.checks ?? 0) + 1;
    const cons = providers?.list.length ? consensus(providers.list) : null;
    if (!cons) {
      doc.misses = (doc.misses ?? 0) + 1;
      ls.misses++;
      st.doc = doc;
      if (closing) await this._finalize(key, st, now);
      else st.nextAt = Math.min(now + this._interval(m, now), m.timestamp - CLOSE_WINDOW.before);
      return;
    }
    this.stats.hits++;
    if (!doc.hasOdds) ls.hits++;
    doc.hasOdds = true;
    doc.source = providers.source;
    doc.providers = providers.list.slice(0, 8).map(slimProvider);
    const snap = snapOf(cons, now);
    const moved = snapMoved(doc.last, snap);
    doc.last = snap;
    // Açılış: kaynağın bildirdiği açılış fiyatı varsa o, yoksa ilk görülen değer
    const reportedOpen = consensus(providers.list, { phase: 'open' });
    if (reportedOpen && doc.open?.from !== 'source') doc.open = snapOf(reportedOpen, doc.open?.at ?? now, 'source');
    else if (!doc.open) doc.open = { ...snap, from: 'first' };
    doc.history = pushHistory(doc.history ?? [], snap);
    st.doc = doc;
    // Tahminleri güncelle (değiştiyse ya da bu süreçte ilk kez görülüyorsa); hata toplayıcıyı durdurmaz
    if (this.onUpdate && (moved || !st.notified)) {
      st.notified = true;
      try {
        await this.onUpdate(key, snap);
        this.stats.updates = (this.stats.updates ?? 0) + 1;
      } catch (e) {
        this._error(`${key} güncelleme`, e);
      }
    }
    if (closing) {
      const reportedClose = consensus(providers.list, { phase: 'close' });
      doc.close = reportedClose ? snapOf(reportedClose, now, 'source') : { ...snap, from: 'fetch' };
      await this._finalize(key, st, now);
      return;
    }
    // Değişmeyen görüntü 3 saatte bir yazılır (bellekte her zaman güncel)
    if (moved || !st.savedAt || now - st.savedAt >= SAVE_EVERY_MS) {
      doc.updatedAt = now;
      await this.store.saveOdds(key, doc);
      st.savedAt = now;
    }
    st.nextAt = Math.min(now + this._interval(m, now), m.timestamp - CLOSE_WINDOW.before);
    if (st.nextAt <= now) st.nextAt = now + MIN;
  }

  /** Maçın bellekteki son görüntüsü (yeni hazırlanan tahmin hemen güncel veriyle başlasın). */
  latest(key) {
    const last = this._state.get(key)?.doc?.last;
    return last?.x12 ? last : null;
  }

  /**
   * Tercih edilen kaynaktan okur; veri yoksa diğer kaynak lig başına 6 saatte bir denenir (bulursa o lig için öne
   * alınır). Döner: { source, list } | null (veri yok). Denenen kaynakların hepsi hata verdiyse hata fırlatır.
   */
  async _fetch(m, now) {
    const ls = this._leagueState(m.league);
    const order = this.sources.map((_, i) => i);
    if (ls.prefer) order.unshift(...order.splice(order.indexOf(ls.prefer), 1));
    let tried = 0;
    let failed = 0;
    let lastError = null;
    for (let i = 0; i < order.length; i++) {
      if (i > 0) {
        if (now - ls.probedAt < 6 * HOUR) break;
        ls.probedAt = now;
      }
      const src = this.sources[order[i]];
      tried++;
      this.stats.fetches++;
      let raw;
      try {
        raw = await src.fetch(m);
      } catch (e) {
        failed++;
        lastError = e;
        continue;
      }
      const list = parseOddsResponse(raw);
      if (list.length && consensus(list)) {
        if (i > 0) ls.prefer = order[i];
        return { source: src.name, list };
      }
    }
    if (tried > 0 && failed === tried) throw lastError;
    return null;
  }

  /** Maçı kapatır: kapanış yoksa son değer (başlamadan en fazla 3 saat önce okunmuşsa) kullanılır; kapsama sayılır. */
  async _finalize(key, st, now) {
    const m = st.m;
    const doc = st.doc ?? {
      key,
      league: m.league,
      eventId: String(m.id),
      kickoffMs: m.timestamp,
      home: m.homeName ?? null,
      away: m.awayName ?? null,
      checks: 0,
      misses: 0,
      hasOdds: false,
    };
    if (doc.closed) return;
    if (!doc.close && doc.last && m.timestamp - doc.last.at <= 3 * HOUR) doc.close = { ...doc.last, from: 'last' };
    doc.closed = true;
    doc.updatedAt = now;
    await this.store.saveOdds(key, doc);
    await this.store.addCoverage(trDay(m.timestamp), m.league, {
      matches: 1,
      withOdds: doc.hasOdds ? 1 : 0,
      withX12: doc.last?.x12 ? 1 : 0,
      withOu: doc.last?.ou ? 1 : 0,
      withClose: doc.close ? 1 : 0,
    });
    this.stats.closed++;
    this._state.delete(key);
    this._done.set(key, m.timestamp);
    this._coverage = null; // bir sonraki durum isteğinde yeniden okunur
  }

  /** Son 7 günün lig kapsaması (Firestore'dan, 10 dk saklanır). */
  async coverage() {
    const now = this.now();
    if (this._coverage && now - this._coverage.at < this.coverageCacheMs) return this._coverage.value;
    const days = Array.from({ length: 7 }, (_, i) => trDay(now - i * DAY));
    const rows = await this.store.listCoverage(days);
    const leagues = {};
    const total = { matches: 0, withOdds: 0, withX12: 0, withOu: 0, withClose: 0 };
    for (const r of rows) {
      for (const [lg, c] of Object.entries(r?.leagues ?? {})) {
        const t = (leagues[lg] ??= { matches: 0, withOdds: 0, withX12: 0, withOu: 0, withClose: 0 });
        for (const k of Object.keys(total)) {
          const v = Number(c?.[k]) || 0;
          t[k] += v;
          total[k] += v;
        }
      }
    }
    const value = { days: days.length, total, leagues };
    this._coverage = { at: now, value };
    return value;
  }

  /** Şu anki penceredeki maçların lig bazında durumu (bellekten). */
  windowStatus() {
    const leagues = {};
    let matches = 0;
    let checked = 0;
    let withOdds = 0;
    for (const st of this._state.values()) {
      const l = (leagues[st.m.league] ??= { matches: 0, checked: 0, withOdds: 0 });
      l.matches++;
      matches++;
      if (st.doc?.checks > 0) {
        l.checked++;
        checked++;
      }
      if (st.doc?.hasOdds) {
        l.withOdds++;
        withOdds++;
      }
    }
    return { matches, checked, withOdds, leagues };
  }

  /** /version özeti: yalnızca sayılar (kaynak adı yok). */
  status() {
    const w = this.windowStatus();
    return { ...this.stats, tracked: this._state.size, window: { matches: w.matches, checked: w.checked, withOdds: w.withOdds } };
  }

  /** Yönetici ekranı: pencere + son 7 gün kapsaması (lig bazında). */
  async adminStatus({ uid }) {
    if (!uid || !this.isAdmin || !(await this.isAdmin(uid).catch(() => false))) throw new AppError('permission-denied', 'Bu işlem için yönetici yetkisi gerekli.');
    let week = null;
    try {
      week = await this.coverage();
    } catch (e) {
      this._error('coverage', e);
    }
    return { ...this.status(), windowLeagues: this.windowStatus().leagues, week };
  }
}

export function createMarketStore(db, FieldValue) {
  return {
    async getOdds(key) {
      const s = await db.doc(`odds/${key}`).get();
      return s.exists ? s.data() : null;
    },
    async saveOdds(key, doc) {
      await db.doc(`odds/${key}`).set({ ...doc, savedAt: FieldValue.serverTimestamp() });
    },
    async addCoverage(day, league, inc) {
      const row = Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, FieldValue.increment(v)]));
      // set + merge: lig adındaki nokta (eng.1) alan yolu sayılmaz, harita anahtarı olarak kalır
      await db.doc(`odds_coverage/${day}`).set({ day, leagues: { [league]: row }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    },
    async listCoverage(days) {
      const snaps = await Promise.all(days.map((d) => db.doc(`odds_coverage/${d}`).get()));
      return snaps.filter((s) => s.exists).map((s) => s.data());
    },
  };
}
