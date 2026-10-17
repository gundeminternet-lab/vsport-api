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

export class EspnClient {
  constructor({ fetchImpl = globalThis.fetch, cacheTtlMs = ESPN.cacheTtlMs, timeoutMs = ESPN.timeoutMs, retries = ESPN.retries } = {}) {
    if (!fetchImpl) throw new Error('fetch bulunamadı (Node 18+ gerekir)');
    this.fetchImpl = fetchImpl;
    this.cacheTtlMs = cacheTtlMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.cache = new Map();
  }

  async _getJson(url) {
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.t < this.cacheTtlMs) return hit.json;

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
        clearTimeout(timer);
        if (res.status === 404) throw Object.assign(new Error(`ESPN 404: ${url}`), { fatal: true });
        if (!res.ok) throw new Error(`ESPN ${res.status}`);
        const json = await res.json();
        this.cache.set(url, { t: Date.now(), json });
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

  async getTeams(league) {
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

  // Gün aralığındaki fikstür. from/to: Date nesnesi
  async getFixtures(league, from, to = from) {
    const fmt = (d) => d.toISOString().slice(0, 10).replaceAll('-', '');
    const range = fmt(from) === fmt(to) ? fmt(from) : `${fmt(from)}-${fmt(to)}`;
    const json = await this._getJson(`${ESPN.siteApi}/${league}/scoreboard?dates=${range}`);
    return parseEvents(json, { league, includeUpcoming: true });
  }
}
