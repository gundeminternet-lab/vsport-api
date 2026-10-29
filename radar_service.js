// Canlı Radar servisi: sürmekte olan maçları dakikada bir tarar, baskı sinyallerini (radar.js) üretir, kaydeder,
// sonuçlarını izler ve yalnızca PRO abonelere telefon bildirimi gönderir.
//
//   • Tarama: günlük tahmin hattının fikstür planındaki başlamış maçlar (ek fikstür isteği yok); her maçın özeti en
//     çok 25 sn önbellekle okunur. Anlatım olmayan liglerde radar her turda toplamları saklar, pencereler onlardan çıkar.
//   • Kayıt: radar_signals/{id} (sinyal anındaki veriler dondurulur), radar_stats/{gün} (gün gün tutan/tutmayan,
//     yıldıza ve türe göre), radar_alarms/{uid} (bildirim tercihleri ve cihaz jetonları), radar_reveals/{uid}
//     (abone olmayanın haftalık ücretsiz açma hakları).
//   • Bildirim: kullanıcının alarm kurallarına (tür, en az yıldız, lig, takım), sessiz saatlerine ve günlük sınırına
//     uyan PRO abonelere, cihaz jetonlarına doğrudan (konu aboneliği değil; abone olmayan cihaz alamaz).
//   • Gizlilik: abone olmayan, süren sinyalin türünü, gücünü ve dakikasını görür; takımlar ve veriler kilitlidir
//     (haftada [freeReveals] sinyali açabilir). Sonuçlanan sinyaller herkese açıktır (radarın karnesi).

import { AppError } from './errors.js';
import { LEAGUES, matchKey } from './logic.js';
import { periodIds } from './league.js';
import {
  RADAR,
  SIGNAL_TYPES,
  STAR_LABELS,
  TYPE_INFO,
  buildView,
  describe,
  detectSignals,
  notificationText,
  readMatch,
  resolveSignal,
} from './radar.js';

export const FREE_REVEALS = 3;
export const MAX_RULES = 10;
export const MAX_TOKENS = 5;
export const DAILY_LIMITS = [5, 10, 20, 40, 60, 0]; // 0: sınırsız
export const DEFAULT_RULE = Object.freeze({ id: 'default', types: ['siren', 'comeback', 'late'], minStars: 2, leagues: [], teams: [] });
export const DEFAULT_ALARMS = Object.freeze({
  enabled: true,
  quiet: { on: true, from: '00:00', to: '08:00' },
  dailyLimit: 10,
  rules: [DEFAULT_RULE],
  tz: 180,
});

const HOUR = 3600e3;
const KEEP_MS = 36 * HOUR; // bellekteki sinyaller (Geçmiş: son 24 saat)
const SUB_CACHE_MS = 30 * 60e3;
const TOKEN_RE = /^[A-Za-z0-9_:\-.]{20,4096}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY_RE = /^[A-Za-z0-9_]{3,80}$/;
const ID_RE = /^[A-Za-z0-9_]{3,140}$/;

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();

/** Kullanıcının yerel saatine göre gün (YYYY-MM-DD) ve gün içindeki dakika. tz: UTC'ye göre dakika (Türkiye 180). */
export function localTime(ms, tz = 180) {
  const d = new Date(ms + tz * 60e3);
  return { day: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

/** Sessiz saatlerde mi (gece yarısını aşan aralık desteklenir: 23:00 → 08:00). */
export function inQuiet(alarm, ms) {
  const q = alarm?.quiet;
  if (!q?.on || !TIME_RE.test(q.from ?? '') || !TIME_RE.test(q.to ?? '')) return false;
  const { minutes } = localTime(ms, alarm.tz ?? 180);
  const a = toMin(q.from);
  const b = toMin(q.to);
  if (a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** Sinyal bu kurala uyuyor mu. */
export function ruleMatches(rule, sig) {
  if (!rule?.types?.includes(sig.type)) return false;
  if (sig.stars < (rule.minStars ?? 1)) return false;
  if (rule.leagues?.length && !rule.leagues.includes(sig.league)) return false;
  if (rule.teams?.length) {
    const ids = sig.side ? [sig[sig.side]?.id] : [sig.home?.id, sig.away?.id];
    if (!ids.some((id) => id && rule.teams.includes(String(id)))) return false;
  }
  return true;
}

export const alarmMatches = (alarm, sig) => (alarm?.rules?.length ? alarm.rules : [DEFAULT_RULE]).some((r) => ruleMatches(r, sig));

/** Maç saati etiketi: "45'+2'" → "45+2'". */
const minuteLabel = (clock, e) => {
  const c = str(clock).replace(/'/g, '');
  return c ? `${c.replace(/\s+/g, '')}'` : `${Math.round(e)}'`;
};

/** Oynanan dakikadan saat etiketi (hedef süresinin bittiği an). */
export function clockOf(e, h1 = 47) {
  const v = Math.round(e);
  if (v <= 45) return `${v}'`;
  if (v <= h1) return `45+${v - 45}'`;
  const m = 45 + (v - h1);
  return m > 90 ? `90+${m - 90}'` : `${m}'`;
}

/** Abone olmayana süren sinyalin kilitli görünümü: tür, güç, lig, dakika ve süre; takımlar ve veriler yok. */
export function lockedView(sig) {
  return {
    id: sig.id,
    type: sig.type,
    title: sig.title,
    league: sig.league,
    stars: sig.stars,
    label: sig.label,
    minuteLabel: sig.minuteLabel,
    e: sig.e,
    createdAt: sig.createdAt,
    // Hangi tarafın baskı kurduğu da gizli (lig + dakika + taraf maçı ele verebilir)
    target: { kind: sig.target.kind, minutes: sig.target.minutes, deadline: sig.target.deadline, deadlineLabel: sig.target.deadlineLabel, untilEnd: sig.target.untilEnd === true },
    status: sig.status,
    now: sig.now ? { e: sig.now.e, clock: sig.now.clock } : null,
    locked: true,
  };
}

/** Uygulamaya giden sinyal (iç alanlar olmadan). */
export function publicView(sig) {
  const { _pending, _final, ...rest } = sig;
  return { ...rest, locked: false };
}

export class RadarService {
  /**
   * store: createRadarStore; espn: getSummary; access: isSubscriber/entitlement; plan: async () → başlamış maçlar
   * ([{ league, id, timestamp, homeName, awayName }]); lambdasFor: async (key) → { home, away } | null;
   * push: async ({ tokens, title, body, data }) → { invalid: [token] }.
   */
  constructor({ store, espn, access, plan, lambdasFor = null, push = null, now = () => Date.now(), log = console, concurrency = 4, freeReveals = FREE_REVEALS, leagues = LEAGUES }) {
    this.store = store;
    this.espn = espn;
    this.access = access;
    this.plan = plan;
    this.lambdasFor = lambdasFor;
    this.push = push;
    this.now = now;
    this.log = log;
    this.concurrency = concurrency;
    this.freeReveals = freeReveals;
    this.leagues = new Set(leagues);
    this._matches = new Map(); // key → izleme durumu
    this._signals = new Map(); // id → sinyal (son 36 saat)
    this._loaded = null;
    this._alarms = null; // { at, list: Map uid → alarm }
    this._subs = new Map(); // uid → { at, ok }
    this._sent = new Map(); // uid → { day, n } (bellekte; günlük sınır)
    this._week = null; // { at, value }
    this._busy = false;
    this.stats = { ticks: 0, live: 0, withData: 0, signals: 0, pushed: 0, lastTickAt: null, lastError: null };
  }

  status() {
    return { ...this.stats, tracked: this._matches.size, open: [...this._signals.values()].filter((s) => s.status === 'open').length };
  }

  // -------------------------------------------------------------------------------------------------
  // Tarama
  // -------------------------------------------------------------------------------------------------

  async _load() {
    if (!this._loaded) {
      this._loaded = (async () => {
        try {
          const list = await this.store.listSignalsSince(this.now() - KEEP_MS);
          for (const s of list) this._signals.set(s.id, s);
        } catch (e) {
          this._loaded = null;
          throw e;
        }
      })();
    }
    return this._loaded;
  }

  /** Bir tur: başlamış maçlar + açık sinyali olan maçlar. Dönen: taranan maç sayısı. */
  async tick() {
    if (this._busy) return 0;
    this._busy = true;
    try {
      await this._load();
      const now = this.now();
      const todo = new Map();
      for (const m of (await this.plan()) ?? []) {
        if (!this.leagues.has(m.league)) continue;
        const key = matchKey(m.league, m.id);
        if (KEY_RE.test(key)) todo.set(key, { key, league: m.league, eventId: String(m.id), kickoff: m.timestamp });
      }
      for (const s of this._signals.values()) {
        if ((s.status === 'open' || (s.status === 'miss' && !s._final)) && !todo.has(s.key) && now - s.createdAt < 4 * HOUR) {
          todo.set(s.key, { key: s.key, league: s.league, eventId: s.eventId, kickoff: s.kickoff ?? null });
        }
      }
      const list = [...todo.values()];
      let i = 0;
      let live = 0;
      let withData = 0;
      const worker = async () => {
        while (i < list.length) {
          const job = list[i++];
          try {
            const json = await this.espn.getSummary(job.league, job.eventId, { maxAgeMs: 25e3 });
            const r = await this._scan(job, json);
            if (r?.live) live++;
            if (r?.data) withData++;
          } catch (e) {
            this.stats.lastError = `${job.key}: ${e?.message ?? e}`.slice(0, 300);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, list.length) }, worker));
      // Bitmiş ve izlenmeyen maçlar ile eski sinyaller bellekten atılır
      for (const [k, st] of this._matches) if (now - st.at > 40 * 60e3) this._matches.delete(k);
      for (const [id, s] of this._signals) if (now - s.createdAt > KEEP_MS) this._signals.delete(id);
      this.stats.ticks++;
      this.stats.live = live;
      this.stats.withData = withData;
      this.stats.lastTickAt = new Date(now).toISOString();
      return list.length;
    } finally {
      this._busy = false;
    }
  }

  async _scan(job, json) {
    const now = this.now();
    const st = this._matches.get(job.key) ?? { key: job.key, league: job.league, eventId: job.eventId, kickoff: job.kickoff, snaps: [], h1: null, lastScore: null, goalE: { home: [], away: [] }, cornerAt: { home: [], away: [] }, lambdas: undefined, at: now };
    this._matches.set(job.key, st);
    st.at = now;
    const m = readMatch(json, { h1: st.h1 });
    if (!m) return null;
    if (m.state === 'in' && m.period === 1 && !m.halftime) st.h1 = Math.max(st.h1 ?? 45, m.e, 45);
    if (m.halftime || m.period >= 2) st.h1 = Math.max(st.h1 ?? 45, m.h1);

    // Görülen anlar: gol ve korner (olay saati yoksa sonuç bunlarla bulunur)
    for (const side of ['home', 'away']) {
      const prev = st.lastScore?.[side];
      if (Number.isFinite(prev) && m.score[side] > prev) for (let k = prev; k < m.score[side]; k++) st.goalE[side][k] ??= m.e;
      const c = m.totals[side]?.corners;
      const last = st.cornerAt[side].at(-1);
      if (Number.isFinite(c) && (!last || c > last.n)) st.cornerAt[side].push({ n: c, e: m.e });
    }
    st.lastScore = { ...m.score };
    const live = m.state === 'in';
    if (live && !m.halftime) {
      const last = st.snaps.at(-1);
      if (!last || m.e - last.e >= 0.9) st.snaps.push({ e: m.e, totals: JSON.parse(JSON.stringify(m.totals)) });
      if (st.snaps.length > 150) st.snaps.splice(0, st.snaps.length - 150);
    }
    st.info = { teams: m.teams, score: m.score, clock: m.clock, minute: m.minute, e: m.e, state: m.state, period: m.period, halftime: m.halftime, h1: st.h1 ?? m.h1 };

    const view = live ? buildView(m, st.snaps) : null;
    const data = Boolean(view?.w10);

    // Sonuç takibi
    for (const sig of this._signals.values()) {
      if (sig.key !== job.key) continue;
      await this._resolve(sig, m, st);
    }

    // Yeni sinyaller
    if (data) {
      if (st.lambdas === undefined) st.lambdas = this.lambdasFor ? await this.lambdasFor(job.key).catch(() => null) : null;
      const history = [...this._signals.values()].filter((s) => s.key === job.key);
      const found = detectSignals(m, view, history, st.lambdas);
      // Aynı takıma aynı anda gol ve korner sinyali verilmez (bildirim yağmuru olmasın)
      const goalSides = new Set([...found.filter((f) => f.type !== 'corner'), ...history.filter((h) => h.status === 'open' && h.type !== 'corner')].map((f) => f.side));
      for (const f of found) {
        if (f.type === 'corner' && goalSides.has(f.side)) continue;
        await this._create(job, st, m, view, f);
      }
    }
    return { live, data };
  }

  async _create(job, st, m, view, f) {
    const now = this.now();
    const id = `${job.key}_${f.type}_${f.side ?? 'x'}_${Math.round(f.e)}`;
    if (this._signals.has(id)) return;
    const d = describe(f, m.teams, m.score);
    const h1 = st.h1 ?? m.h1;
    const sig = {
      id,
      key: job.key,
      league: job.league,
      eventId: job.eventId,
      kickoff: job.kickoff ?? null,
      type: f.type,
      side: f.side,
      title: d.title,
      subtitle: d.subtitle,
      team: d.team,
      home: m.teams.home,
      away: m.teams.away,
      e: f.e,
      minuteLabel: minuteLabel(m.clock, f.e),
      period: m.period,
      score: { ...m.score },
      corners: f.side ? (m.totals[f.side]?.corners ?? m.plays.filter((p) => p.kind === 'corner' && p.side === f.side).length) : null,
      stars: f.stars,
      index: f.index,
      label: STAR_LABELS[f.stars],
      pressure: f.pressure,
      chance: f.chance,
      // Süre sonu saati: ilk yarıdaki sinyalde saat + süre (uzatma, sonuçta süreye eklenir), sonra oynanan dakikadan
      target: { ...f.target, deadlineLabel: f.target.untilEnd ? 'MS' : f.e <= 45 ? `${Math.round(f.target.deadline)}'` : clockOf(f.target.deadline, h1) },
      view: { source: view.source, w5: view.w5, w10: view.w10, total: view.total },
      status: 'open',
      createdAt: now,
      resolvedAt: null,
      at: null,
      late: null,
      now: { e: m.e, clock: m.clock, score: { ...m.score } },
    };
    this._signals.set(id, sig);
    this.stats.signals++;
    try {
      await this.store.saveSignal(publicView(sig));
    } catch (e) {
      this.log.error?.(`[radar] sinyal kaydedilemedi ${id}: ${e?.message ?? e}`);
    }
    try {
      await this._notify(sig);
    } catch (e) {
      this.log.error?.(`[radar] bildirim gönderilemedi ${id}: ${e?.message ?? e}`);
    }
  }

  async _resolve(sig, m, st) {
    const now = this.now();
    if (sig._final) return;
    sig.now = { e: m.e, clock: m.clock, score: { ...m.score } };
    const cornerE = sig.target.kind === 'team_corner' ? st.cornerAt[sig.target.side].find((c) => c.n > (sig.corners ?? 0))?.e : undefined;
    const r = resolveSignal(sig, m, { goalE: st.goalE, cornerE });
    const ended = m.completed || m.state === 'post';
    if (!r) return;
    if (sig.status === 'open') {
      if (r.status === 'hit') {
        // Gol VAR ile iptal edilebilir: bir sonraki turda (en az 90 sn sonra) hâlâ geçerliyse kesinleşir
        if (sig.target.kind !== 'team_corner' && !ended) {
          if (!sig._pending) {
            sig._pending = { at: now, r };
            return;
          }
          if (now - sig._pending.at < 90e3) return;
        }
        await this._finish(sig, { status: 'hit', at: r.at, resolvedAt: now });
      } else if (r.status === 'miss') {
        await this._finish(sig, { status: 'miss', late: r.late ?? null, resolvedAt: now });
      } else {
        delete sig._pending; // gol iptal edildi
      }
    } else if (sig.status === 'miss' && sig.late === null && Number.isFinite(r.late)) {
      // Süre bittikten sonra gelen gol: "geç gelen gol" notu
      sig.late = r.late;
      await this._save(sig, { late: r.late });
    }
    if (ended && sig.status !== 'open') sig._final = true;
  }

  async _finish(sig, patch) {
    const was = sig.status;
    Object.assign(sig, patch);
    delete sig._pending;
    await this._save(sig, { ...patch, now: sig.now });
    if (was === 'open' && (patch.status === 'hit' || patch.status === 'miss')) {
      try {
        await this.store.bumpStats?.(sig, patch.status === 'hit');
      } catch (e) {
        this.log.error?.(`[radar] karne yazılamadı: ${e?.message ?? e}`);
      }
      this._week = null;
    }
  }

  async _save(sig, patch) {
    try {
      await this.store.updateSignal(sig.id, patch);
    } catch (e) {
      this.log.error?.(`[radar] sinyal güncellenemedi ${sig.id}: ${e?.message ?? e}`);
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Bildirim (yalnızca PRO)
  // -------------------------------------------------------------------------------------------------

  async _alarmList() {
    if (this._alarms && this.now() - this._alarms.at < 30 * 60e3) return this._alarms.list;
    const list = new Map();
    for (const a of (await this.store.listAlarms()) ?? []) list.set(a.uid, a);
    this._alarms = { at: this.now(), list };
    return list;
  }

  /** Alarm belgesi değişti (kaydetme, jeton): önbellek de güncellenir. */
  _cacheAlarm(uid, alarm) {
    if (!this._alarms) return;
    if (alarm?.enabled) this._alarms.list.set(uid, { uid, ...alarm });
    else this._alarms.list.delete(uid);
  }

  /** Abone mi: alarm belgesindeki bitiş tarihi geçerliyse okuma yapılmaz; değilse kayıt [ttl] süre saklanır. */
  async _subscribed(uid, alarm = null, ttl = SUB_CACHE_MS) {
    const now = this.now();
    if (Number(alarm?.subUntil) > now) return true;
    const hit = this._subs.get(uid);
    if (hit && now - hit.at < ttl) return hit.ok;
    let ok = false;
    try {
      ok = Boolean(await this.access.isSubscriber(uid));
    } catch {
      ok = false;
    }
    this._subs.set(uid, { at: now, ok });
    if (this._subs.size > 20000) this._subs.clear();
    return ok;
  }

  /** Kullanıcı bugün kaç bildirim aldı / sınır doldu mu. */
  _sentToday(uid, alarm) {
    const { day } = localTime(this.now(), alarm?.tz ?? 180);
    const s = this._sent.get(uid);
    return s && s.day === day ? s.n : 0;
  }

  async _recipients(sig) {
    const now = this.now();
    const out = [];
    for (const a of (await this._alarmList()).values()) {
      if (!a.enabled || !a.tokens?.length) continue;
      if (!alarmMatches(a, sig)) continue;
      if (inQuiet(a, now)) continue;
      const limit = Number.isFinite(a.dailyLimit) ? a.dailyLimit : DEFAULT_ALARMS.dailyLimit;
      if (limit > 0 && this._sentToday(a.uid, a) >= limit) continue;
      if (!(await this._subscribed(a.uid, a))) continue;
      out.push(a);
    }
    return out;
  }

  async _notify(sig) {
    if (!this.push) return 0;
    const users = await this._recipients(sig);
    if (!users.length) return 0;
    const { title, body } = notificationText(sig);
    const data = { type: 'radar', signalId: sig.id, matchKey: sig.key, league: sig.league, eventId: String(sig.eventId), kind: sig.type, stars: String(sig.stars) };
    const owner = new Map();
    const tokens = [];
    for (const u of users) {
      for (const t of u.tokens.slice(0, MAX_TOKENS)) {
        if (owner.has(t)) continue;
        owner.set(t, u.uid);
        tokens.push(t);
      }
    }
    let invalid = [];
    for (let k = 0; k < tokens.length; k += 500) {
      const r = await this.push({ tokens: tokens.slice(k, k + 500), title, body, data });
      invalid = invalid.concat(r?.invalid ?? []);
    }
    for (const u of users) {
      const { day } = localTime(this.now(), u.tz ?? 180);
      const s = this._sent.get(u.uid);
      this._sent.set(u.uid, { day, n: s && s.day === day ? s.n + 1 : 1 });
    }
    if (this._sent.size > 50000) this._sent.clear();
    // Geçersiz jetonlar (uygulama silinmiş) temizlenir
    const byUser = new Map();
    for (const t of invalid) {
      const uid = owner.get(t);
      if (uid) byUser.set(uid, [...(byUser.get(uid) ?? []), t]);
    }
    for (const [uid, list] of byUser) {
      try {
        await this.store.removeTokens(uid, list);
        const a = this._alarms?.list.get(uid);
        if (a) a.tokens = a.tokens.filter((t) => !list.includes(t));
      } catch {
        // sonraki gönderimde yeniden denenir
      }
    }
    this.stats.pushed += users.length;
    return users.length;
  }

  // -------------------------------------------------------------------------------------------------
  // Uygulama uçları
  // -------------------------------------------------------------------------------------------------

  async _viewer(uid, guest) {
    if (!uid || guest) return { subscribed: false, revealed: new Set(), left: 0 };
    // Ekran: abone olur olmaz açılsın diye kısa süreli kayıt (2 dk)
    const subscribed = await this._subscribed(uid, null, 2 * 60e3);
    if (subscribed) return { subscribed: true, revealed: new Set(), left: 0 };
    const week = periodIds(this.now()).week;
    const ids = (await this.store.getReveals(uid, week).catch(() => [])) ?? [];
    return { subscribed: false, revealed: new Set(ids), left: Math.max(0, this.freeReveals - ids.length) };
  }

  _show(sig, v) {
    if (sig.status !== 'open' || v.subscribed || v.revealed.has(sig.id)) return publicView(sig);
    return lockedView(sig);
  }

  /** Son 7 günün karnesi (radar_stats günlükleri, 10 dakika saklanır). */
  async _weekStats() {
    if (this._week && this.now() - this._week.at < 10 * 60e3) return this._week.value;
    const days = [];
    for (let k = 0; k < 7; k++) days.push(new Date(this.now() + 3 * HOUR - k * 24 * HOUR).toISOString().slice(0, 10));
    const docs = (await this.store.getStats?.(days).catch(() => [])) ?? [];
    const value = { total: 0, hit: 0, byStars: { 1: { n: 0, hit: 0 }, 2: { n: 0, hit: 0 }, 3: { n: 0, hit: 0 } }, byType: {} };
    for (const d of docs) {
      value.total += d.total ?? 0;
      value.hit += d.hit ?? 0;
      for (const s of [1, 2, 3]) {
        value.byStars[s].n += d.byStars?.[s]?.n ?? 0;
        value.byStars[s].hit += d.byStars?.[s]?.hit ?? 0;
      }
      for (const [t, v] of Object.entries(d.byType ?? {})) {
        value.byType[t] ??= { n: 0, hit: 0 };
        value.byType[t].n += v?.n ?? 0;
        value.byType[t].hit += v?.hit ?? 0;
      }
    }
    this._week = { at: this.now(), value };
    return value;
  }

  /** Canlı Radar ekranı: taranan maçlar, süren sinyaller, son 24 saatin sonuçları ve karne. */
  async feed({ uid, guest = false } = {}) {
    await this._load().catch(() => {});
    const now = this.now();
    const v = await this._viewer(uid, guest);
    const all = [...this._signals.values()];
    const order = (a, b) => b.stars - a.stars || b.createdAt - a.createdAt;
    const active = all.filter((s) => s.status === 'open').sort(order).map((s) => this._show(s, v));
    const done = all.filter((s) => s.status !== 'open' && now - s.createdAt <= 24 * HOUR).sort((a, b) => b.createdAt - a.createdAt);
    const recent = done.slice(0, 80).map((s) => publicView(s));
    const day = { total: done.length, hit: done.filter((s) => s.status === 'hit').length };
    day.miss = day.total - day.hit;
    const liveMatches = [...this._matches.values()].filter((st) => st.info?.state === 'in' && now - st.at < 5 * 60e3);
    const sample = liveMatches.slice(0, 12).map((st) => ({
      key: st.key,
      league: st.league,
      home: st.info.teams.home.name,
      away: st.info.teams.away.name,
      score: st.info.score,
      clock: st.info.halftime ? 'İY' : minuteLabel(st.info.clock, st.info.e),
    }));
    return {
      subscribed: v.subscribed,
      reveals: v.subscribed ? null : { left: v.left, total: this.freeReveals, resetsOn: 'Pazartesi' },
      scanning: { live: liveMatches.length, withData: this.stats.withData, sample },
      active,
      recent,
      day,
      week: await this._weekStats(),
      types: SIGNAL_TYPES,
      updatedAt: this.stats.lastTickAt,
    };
  }

  async signal({ uid, guest = false, id } = {}) {
    if (!ID_RE.test(str(id))) throw new AppError('invalid-argument', 'Geçersiz sinyal.');
    await this._load().catch(() => {});
    let sig = this._signals.get(id);
    if (!sig) sig = (await this.store.getSignal(id)) ?? null;
    if (!sig) throw new AppError('not-found', 'Sinyal bulunamadı.');
    return this._show(sig, await this._viewer(uid, guest));
  }

  /** Abone olmayanın haftalık ücretsiz açma hakkı (Pazartesi yenilenir). */
  async reveal({ uid, guest = false, id } = {}) {
    if (!uid || guest) throw new AppError('unauthenticated', 'Sinyali açmak için Google ile giriş yapmalısın.');
    if (!ID_RE.test(str(id))) throw new AppError('invalid-argument', 'Geçersiz sinyal.');
    await this._load().catch(() => {});
    const sig = this._signals.get(id) ?? (await this.store.getSignal(id));
    if (!sig) throw new AppError('not-found', 'Sinyal bulunamadı.');
    if (sig.status !== 'open' || (await this._subscribed(uid, null, 60e3))) return { signal: publicView(sig), left: null };
    const week = periodIds(this.now()).week;
    const ids = await this.store.addReveal(uid, week, id, this.freeReveals);
    if (!ids) throw new AppError('subscription-required', "Bu haftaki ücretsiz açma hakların bitti. Bütün sinyaller ve gol bildirimi PRO'da.");
    return { signal: publicView(sig), left: Math.max(0, this.freeReveals - ids.length) };
  }

  /** Alarm ayarları (Alarmlarım). */
  async getAlarms({ uid, guest = false } = {}) {
    if (!uid || guest) throw new AppError('unauthenticated', 'Alarm kurmak için Google ile giriş yapmalısın.');
    const saved = (await this.store.getAlarm(uid)) ?? null;
    const subscribed = await this._subscribed(uid, null, 60e3);
    const a = { ...DEFAULT_ALARMS, ...(saved ?? {}) };
    return {
      subscribed,
      enabled: a.enabled !== false,
      quiet: a.quiet ?? DEFAULT_ALARMS.quiet,
      dailyLimit: Number.isFinite(a.dailyLimit) ? a.dailyLimit : DEFAULT_ALARMS.dailyLimit,
      rules: a.rules?.length ? a.rules : [DEFAULT_RULE],
      devices: (saved?.tokens ?? []).length,
      sentToday: this._sentToday(uid, a),
      limits: DAILY_LIMITS,
      types: SIGNAL_TYPES,
    };
  }

  async saveAlarms({ uid, guest = false, enabled, quiet, dailyLimit, rules } = {}) {
    if (!uid || guest) throw new AppError('unauthenticated', 'Alarm kurmak için Google ile giriş yapmalısın.');
    const patch = {};
    if (enabled !== undefined) patch.enabled = enabled === true;
    if (quiet !== undefined) {
      if (typeof quiet !== 'object' || quiet === null || !TIME_RE.test(str(quiet.from)) || !TIME_RE.test(str(quiet.to))) {
        throw new AppError('invalid-argument', 'Sessiz saatler geçersiz.');
      }
      patch.quiet = { on: quiet.on === true, from: str(quiet.from), to: str(quiet.to) };
    }
    if (dailyLimit !== undefined) {
      if (!DAILY_LIMITS.includes(dailyLimit)) throw new AppError('invalid-argument', 'Günlük sınır geçersiz.');
      patch.dailyLimit = dailyLimit;
    }
    if (rules !== undefined) patch.rules = cleanRules(rules, this.leagues);
    const sub = await this.access.entitlement?.(uid).catch(() => null);
    if (sub?.subscribed && Number.isFinite(sub.until)) patch.subUntil = sub.until;
    const prev = (await this.store.getAlarm(uid)) ?? {};
    const next = { ...DEFAULT_ALARMS, ...prev, ...patch };
    await this.store.saveAlarm(uid, { ...patch, ...(prev.enabled === undefined && patch.enabled === undefined ? { enabled: true } : {}) });
    this._cacheAlarm(uid, next);
    return this.getAlarms({ uid });
  }

  /** Cihazın bildirim jetonu (uygulama her açılışta gönderir). tz: UTC'ye göre dakika. */
  async registerToken({ uid, guest = false, token, tz } = {}) {
    if (!uid || guest) return { ok: false };
    const t = str(token);
    if (!TOKEN_RE.test(t)) throw new AppError('invalid-argument', 'Geçersiz bildirim jetonu.');
    const zone = Number.isInteger(tz) && tz >= -720 && tz <= 840 ? tz : 180;
    const sub = await this.access.entitlement?.(uid).catch(() => null);
    const extra = sub?.subscribed && Number.isFinite(sub.until) ? { subUntil: sub.until } : {};
    const saved = await this.store.addToken(uid, t, zone, MAX_TOKENS, extra);
    this._cacheAlarm(uid, { ...DEFAULT_ALARMS, ...saved });
    if (sub) this._subs.set(uid, { at: this.now(), ok: Boolean(sub.subscribed) });
    return { ok: true };
  }
}

/** Alarm kurallarını doğrular: en çok 10 kural; türler, 1-3 yıldız, ligler ve takımlar. */
export function cleanRules(rules, leagues = new Set(LEAGUES)) {
  if (!Array.isArray(rules) || rules.length > MAX_RULES) throw new AppError('invalid-argument', `En çok ${MAX_RULES} alarm kurabilirsin.`);
  return rules.map((r, i) => {
    if (typeof r !== 'object' || r === null) throw new AppError('invalid-argument', 'Alarm geçersiz.');
    const types = Array.isArray(r.types) ? [...new Set(r.types.filter((t) => SIGNAL_TYPES.includes(t)))] : [];
    if (!types.length) throw new AppError('invalid-argument', 'Alarmda en az bir sinyal türü seçilmeli.');
    const minStars = Number.isInteger(r.minStars) && r.minStars >= 1 && r.minStars <= 3 ? r.minStars : 2;
    const ls = Array.isArray(r.leagues) ? [...new Set(r.leagues.map(str).filter((l) => leagues.has(l)))].slice(0, 60) : [];
    const teams = Array.isArray(r.teams) ? [...new Set(r.teams.map(str).filter((t) => /^[0-9A-Za-z-]{1,20}$/.test(t)))].slice(0, 50) : [];
    const id = /^[A-Za-z0-9_-]{1,40}$/.test(str(r.id)) ? str(r.id) : `r${i + 1}`;
    const name = str(r.name).slice(0, 40);
    return { id, ...(name ? { name } : {}), types, minStars, leagues: ls, teams };
  });
}

/** Firestore kayıtları (sunucu yazar; uygulamanın doğrudan erişimi yok: firestore.rules). */
export function createRadarStore(db, FieldValue) {
  return {
    async saveSignal(s) {
      await db.doc(`radar_signals/${s.id}`).set(s);
    },
    async updateSignal(id, patch) {
      await db.doc(`radar_signals/${id}`).set(patch, { merge: true });
    },
    async getSignal(id) {
      const s = await db.doc(`radar_signals/${id}`).get();
      return s.exists ? s.data() : null;
    },
    async listSignalsSince(ms, limit = 600) {
      const q = await db.collection('radar_signals').where('createdAt', '>=', ms).orderBy('createdAt', 'desc').limit(limit).get();
      return q.docs.map((d) => d.data());
    },
    /** Günlük karne: tutan/tutmayan sayıları (Türkiye günü), yıldıza ve türe göre. */
    async bumpStats(sig, hit) {
      const day = new Date(sig.createdAt + 3 * HOUR).toISOString().slice(0, 10);
      const inc = (n) => FieldValue.increment(n);
      await db.doc(`radar_stats/${day}`).set(
        {
          day,
          total: inc(1),
          hit: inc(hit ? 1 : 0),
          byStars: { [sig.stars]: { n: inc(1), hit: inc(hit ? 1 : 0) } },
          byType: { [sig.type]: { n: inc(1), hit: inc(hit ? 1 : 0) } },
        },
        { merge: true },
      );
    },
    async getStats(days) {
      const snaps = await db.getAll(...days.map((d) => db.doc(`radar_stats/${d}`)));
      return snaps.filter((s) => s.exists).map((s) => s.data());
    },
    async listAlarms() {
      const q = await db.collection('radar_alarms').where('enabled', '==', true).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async getAlarm(uid) {
      const s = await db.doc(`radar_alarms/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async saveAlarm(uid, data) {
      await db.doc(`radar_alarms/${uid}`).set({ ...data, updatedAt: Date.now() }, { merge: true });
    },
    /** Jeton listenin başına eklenir (en çok [max]); belge yoksa varsayılan ayarlarla oluşur. */
    async addToken(uid, token, tz, max, extra = {}) {
      const ref = db.doc(`radar_alarms/${uid}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const cur = s.exists ? s.data() : { ...DEFAULT_ALARMS };
        const tokens = [token, ...(cur.tokens ?? []).filter((t) => t !== token)].slice(0, max);
        const next = { ...cur, tokens, tz, ...extra, updatedAt: Date.now() };
        if (next.enabled === undefined) next.enabled = true;
        tx.set(ref, next);
        return next;
      });
    },
    async removeTokens(uid, tokens) {
      await db.doc(`radar_alarms/${uid}`).set({ tokens: FieldValue.arrayRemove(...tokens) }, { merge: true });
    },
    async getReveals(uid, week) {
      const s = await db.doc(`radar_reveals/${uid}`).get();
      return s.exists && s.get('week') === week ? (s.get('ids') ?? []) : [];
    },
    /** Haftalık açma hakkı: sığarsa eklenir ve liste döner, hak bittiyse null. */
    async addReveal(uid, week, id, limit) {
      const ref = db.doc(`radar_reveals/${uid}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const ids = s.exists && s.get('week') === week ? (s.get('ids') ?? []) : [];
        if (ids.includes(id)) return ids;
        if (ids.length >= limit) return null;
        const next = [...ids, id];
        tx.set(ref, { week, ids: next, updatedAt: Date.now() });
        return next;
      });
    },
  };
}

export { RADAR, TYPE_INFO };
