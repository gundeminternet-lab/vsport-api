// ESPN (resmi olmayan, herkese açık) uç noktaları için istemci + ayrıştırıcılar.
// Ayrıştırıcılar ağdan bağımsız saf fonksiyonlardır, bu yüzden ayrıca test edilebilir.

import { ESPN } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ESPN skoru bazen "2", bazen 2, bazen {value: 2, displayValue: "2"} olarak verir.
function num(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'object') return num(v.value ?? v.displayValue);
  if (typeof v === 'string' && v.trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function parseTeams(json) {
  const teams = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  return teams
    .map((t) => t.team)
    .filter(Boolean)
    .map((t) => ({
      id: String(t.id),
      name: t.displayName ?? t.name,
      shortName: t.shortDisplayName ?? t.displayName,
      abbreviation: t.abbreviation,
      logo: t.logos?.[0]?.href ?? null,
      // ESPN renkleri '#' olmadan verir ("e63946"). Forma rengi için kullanılır; geçersizse null.
      color: hexColor(t.color),
      alternateColor: hexColor(t.alternateColor),
    }));
}

function hexColor(v) {
  const s = String(v ?? '').replace(/^#/, '');
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s.toLowerCase()}` : null;
}

export function parseStandings(json) {
  const tables = json?.children?.length ? json.children.map((c) => c.standings) : [json?.standings];
  const entries = new Map();
  for (const table of tables) {
    for (const e of table?.entries ?? []) {
      const stat = (name) => num(e.stats?.find((s) => s.name === name)?.value);
      const played = stat('gamesPlayed');
      const points = stat('points');
      entries.set(String(e.team?.id), {
        teamId: String(e.team?.id),
        name: e.team?.displayName ?? e.team?.name,
        logo: e.team?.logos?.[0]?.href ?? null,
        rank: stat('rank'),
        played,
        wins: stat('wins'),
        draws: stat('ties'),
        losses: stat('losses'),
        gf: stat('pointsFor'),
        ga: stat('pointsAgainst'),
        points,
        // ESPN'nin "ppg" alanı güvenilir değil (0 geliyor), kendimiz hesaplıyoruz
        ppg: played > 0 ? points / played : NaN,
      });
    }
  }
  let gf = 0;
  let played = 0;
  for (const e of entries.values()) {
    if (Number.isFinite(e.gf) && Number.isFinite(e.played)) {
      gf += e.gf;
      played += e.played;
    }
  }
  return {
    entries,
    teamCount: entries.size,
    // takım başı, maç başı gol ortalaması (lig seviyesi)
    leagueAvgGoals: played >= 20 ? gf / played : null,
  };
}

// Takım programı / günlük fikstür yanıtlarını ortak biçime çevirir.
export function parseEvents(json, { league = null, includeUpcoming = false } = {}) {
  const out = [];
  for (const ev of json?.events ?? []) {
    const comp = ev.competitions?.[0];
    const competitors = comp?.competitors ?? [];
    const home = competitors.find((c) => c.homeAway === 'home');
    const away = competitors.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;

    const status = comp.status?.type ?? ev.status?.type ?? {};
    // Ertelenen/iptal maçlar ESPN'de 'post' olabilir ama 'completed' değildir; bitmiş sayılmaz.
    const completed = status.completed === true;
    const date = ev.date ?? comp.date;
    const base = {
      id: String(ev.id ?? comp.id),
      date,
      timestamp: Date.parse(date),
      league: league ?? ev.league?.slug ?? null,
      homeId: String(home.team?.id ?? home.id),
      awayId: String(away.team?.id ?? away.id),
      homeName: home.team?.displayName ?? home.team?.name,
      awayName: away.team?.displayName ?? away.team?.name,
      homeLogo: home.team?.logos?.[0]?.href ?? home.team?.logo ?? null,
      awayLogo: away.team?.logos?.[0]?.href ?? away.team?.logo ?? null,
    };
    // Tarafsız saha (final, turnuva maçı): ev sahibi avantajı uygulanmaz
    if (comp.neutralSite === true) base.neutral = true;
    const hg = num(home.score);
    const ag = num(away.score);
    if (completed && Number.isFinite(hg) && Number.isFinite(ag)) {
      out.push({ ...base, homeGoals: hg, awayGoals: ag, completed: true });
    } else if (includeUpcoming && !completed) {
      out.push({ ...base, completed: false });
    }
  }
  return out;
}

/** summary?event= yanıtındaki maç başlığını fikstürdeki maç biçimine çevirir. */
export function parseSummaryEvent(json, { league = null, eventId = null } = {}) {
  const comp = json?.header?.competitions?.[0];
  if (!comp) return null;
  const id = String(json.header.id ?? comp.id ?? eventId);
  const [m] = parseEvents({ events: [{ id, date: comp.date, competitions: [comp] }] }, { league, includeUpcoming: true });
  return m ?? null;
}

/**
 * Skor tablosu yanıtını parseEvents'in okuduğu alanlara indirger (önbellekte bellek tasarrufu; ESPN olay başına
 * onlarca KB istatistik, haber ve yayın bilgisi döndürür). Sonuç parseEvents ile aynı maç listesini verir.
 */
export function slimScoreboard(json) {
  const team = (t) => (t ? { id: t.id, displayName: t.displayName, name: t.name, logo: t.logo, logos: t.logos?.[0] ? [{ href: t.logos[0].href }] : undefined } : undefined);
  const status = (s) => (s?.type ? { type: { completed: s.type.completed, state: s.type.state, name: s.type.name } } : undefined);
  return {
    events: (json?.events ?? []).map((ev) => {
      const comp = ev.competitions?.[0];
      return {
        id: ev.id,
        date: ev.date,
        league: ev.league?.slug ? { slug: ev.league.slug } : undefined,
        status: status(ev.status),
        competitions: comp
          ? [
              {
                id: comp.id,
                date: comp.date,
                status: status(comp.status),
                neutralSite: comp.neutralSite === true ? true : undefined,
                competitors: (comp.competitors ?? []).map((c) => ({ id: c.id, homeAway: c.homeAway, score: c.score, team: team(c.team) })),
              },
            ]
          : [],
      };
    }),
  };
}

export class EspnClient {
  constructor({ fetchImpl = globalThis.fetch, cacheTtlMs = ESPN.cacheTtlMs, timeoutMs = ESPN.timeoutMs, retries = ESPN.retries } = {}) {
    if (!fetchImpl) throw new Error('fetch bulunamadı (Node 18+ gerekir)');
    this.fetchImpl = fetchImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.cache = new Map();
  }

  /** transform: önbelleğe yazmadan önce yanıtı küçültür (ör. skor tablosundan yalnızca gereken alanlar). */
  async _getJson(url, { maxAgeMs = this.cacheTtlMs, transform = null } = {}) {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.t < maxAgeMs) return hit.json;
    // Aynı adrese eşzamanlı istekler tek istekte birleşir (aynı adres hep aynı transform ile çağrılır)
    this.inflight ??= new Map();
    const pending = this.inflight.get(url);
    if (pending) return pending;
    const p = this._fetchJson(url, transform);
    this.inflight.set(url, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(url);
    }
  }

  async _fetchJson(url, transform) {
    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          signal: ctrl.signal,
          // Bazı sunucular tanımsız istemcileri reddeder; sıradan bir tarayıcı gibi tanıtılır.
          headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (vSport API)' },
        });
        if (res.status === 404) throw Object.assign(new Error(`ESPN 404: ${url}`), { fatal: true });
        if (!res.ok) throw new Error(`ESPN ${res.status}`);
        // Zaman aşımı gövde okunurken de geçerli (yarıda kalan bağlantı isteği sonsuza dek bekletmesin)
        const raw = await res.json();
        clearTimeout(timer);
        const json = transform ? transform(raw) : raw;
        // Uzun süre çalışan sunucuda bellek şişmesin: en eski kayıtlar atılır.
        this.cache.delete(url);
        this.cache.set(url, { t: Date.now(), json });
        while (this.cache.size > 400) this.cache.delete(this.cache.keys().next().value);
        return json;
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
        if (e.fatal) break;
        await sleep(300 * (attempt + 1));
      }
    }
    throw new Error(`ESPN isteği başarısız (${url}): ${lastError?.message}`);
  }

  async getTeams(league, { maxAgeMs } = {}) {
    // Takım listeleri seyrek değişir: genel önbellekten (skor tablosu dilimleriyle dolup taşan) ayrı tutulur
    if (maxAgeMs) {
      this.teamsCache ??= new Map();
      const hit = this.teamsCache.get(league);
      // Alınamayan liste (ör. veri sağlayıcısında olmayan lig) yarım saat yeniden istenmez
      if (hit && Date.now() - hit.t < (hit.failed ? 30 * 60e3 : maxAgeMs)) {
        if (hit.failed) throw new Error(`${league} takım listesi alınamadı`);
        return hit.teams;
      }
      try {
        const teams = parseTeams(await this._getJson(`${ESPN.siteApi}/${league}/teams`, { maxAgeMs }));
        this.teamsCache.set(league, { t: Date.now(), teams });
        return teams;
      } catch (e) {
        this.teamsCache.set(league, { t: Date.now(), teams: [], failed: true });
        throw e;
      }
    }
    return parseTeams(await this._getJson(`${ESPN.siteApi}/${league}/teams`));
  }

  async getStandings(league) {
    return parseStandings(await this._getJson(`${ESPN.tableApi}/${league}/standings`));
  }

  // Bir takımın o sezondaki TAMAMLANMIŞ maçları
  async getTeamMatches(league, teamId, season) {
    const q = season ? `?season=${season}` : '';
    const json = await this._getJson(`${ESPN.siteApi}/${league}/teams/${teamId}/schedule${q}`);
    return parseEvents(json, { league });
  }

  // Maçın ham özet verisi (canlı takip için kısa önbellekle).
  async getSummary(league, eventId, { maxAgeMs = 20000 } = {}) {
    return this._getJson(`${ESPN.siteApi}/${league}/summary?event=${encodeURIComponent(eventId)}`, { maxAgeMs });
  }

  // Tek maç, kimliğiyle (tarihten bağımsız). Bulunamazsa null.
  async getEvent(league, eventId) {
    const json = await this._getJson(`${ESPN.siteApi}/${league}/summary?event=${encodeURIComponent(eventId)}`);
    return parseSummaryEvent(json, { league, eventId });
  }

  /**
   * Bir ligin son `days` gündeki TAMAMLANMIŞ maçları (lig geneli güç hesabı için). Gün aralıklı skor tablosu çağrıları
   * 30'ar günlük dilimlerle yapılır; tek bir dilim yanıtı kırpılsa bile (ESPN sınırı) diğer dilimler etkilenmez.
   * Sonuç lig başına bellekte tutulur (varsayılan 2 saat).
   */
  async getLeagueMatches(league, { days = 620, now = Date.now(), maxAgeMs = 2 * 3600 * 1000 } = {}) {
    this.leagueCache ??= new Map();
    const hit = this.leagueCache.get(league);
    if (hit && Date.now() - hit.t < maxAgeMs && hit.days >= days) return hit.matches;
    if (hit?.pending && hit.days >= days) return hit.pending;

    const pending = (async () => {
      const DAY = 86400000;
      const fmt = (t) => new Date(t).toISOString().slice(0, 10).replaceAll('-', '');
      const windows = [];
      for (let end = now; end > now - days * DAY; end -= 30 * DAY) windows.push([Math.max(end - 30 * DAY + DAY, now - days * DAY), end]);
      const byId = new Map();
      let failed = 0;
      let truncated = 0;
      let next = 0;
      const worker = async () => {
        while (next < windows.length) {
          const [from, to] = windows[next++];
          try {
            const json = await this._getJson(`${ESPN.siteApi}/${league}/scoreboard?dates=${fmt(from)}-${fmt(to)}&limit=500`, {
              // Geçmiş dilimler değişmez; son dilim sık yenilenir
              maxAgeMs: to >= now - DAY ? 20 * 60 * 1000 : 6 * 3600 * 1000,
              // 30 günlük dilim yanıtları büyük: önbellekte yalnızca maç listesi için gereken alanlar tutulur
              transform: slimScoreboard,
            });
            if ((json?.events?.length ?? 0) >= 495) truncated++;
            for (const m of parseEvents(json, { league })) byId.set(m.id, m);
          } catch {
            failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      // Çoğu dilim alınamadıysa veri güvenilmez: üst katman eski yönteme döner
      if (failed > windows.length / 3) throw new Error(`${league} lig verisi eksik alındı (${failed}/${windows.length} dilim başarısız)`);
      const matches = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
      matches.meta = { windows: windows.length, failed, truncated };
      return matches;
    })();
    this.leagueCache.set(league, { t: Date.now(), days, pending });
    try {
      const matches = await pending;
      this.leagueCache.set(league, { t: Date.now(), days, matches });
      return matches;
    } catch (e) {
      this.leagueCache.delete(league);
      throw e;
    }
  }

  // Gün aralığındaki fikstür. from/to: Date nesnesi
  async getFixtures(league, from, to = from) {
    const fmt = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
    const range = fmt(from) === fmt(to) ? fmt(from) : `${fmt(from)}-${fmt(to)}`;
    const json = await this._getJson(`${ESPN.siteApi}/${league}/scoreboard?dates=${range}`, { transform: slimScoreboard });
    return parseEvents(json, { league, includeUpcoming: true });
  }
}
