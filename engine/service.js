// Orkestrasyon: ESPN'den veriyi çeker, takım hafızasına yazar, analiz eder, simüle eder, oynatır.

import { EspnClient } from './espn.js';
import { TeamMemory } from './memory.js';
import { analyzeMatch, leagueStrength } from './analysis.js';
import { fitRatings } from './ratings.js';
import { LEAGUES, MODEL } from './config.js';
import { simulateMatch, simulateMany } from './simulator.js';
import { playTimeline } from './playback.js';

// Avrupa sezonu: Temmuz'dan itibaren yeni sezon (2026-27 sezonu için ESPN "2026" kullanır)
export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1;
}

const DAY = 86400000;
const DOMESTIC = /^[a-z]{3}\.\d$/;

// Ülke → lig basamakları (güç tablosundaki yerel ligler): { eng: ['eng.1', 'eng.2', ...], ... }
const TIERS = {};
for (const slug of Object.keys(LEAGUES).sort()) {
  const [cc] = slug.split('.');
  (TIERS[cc] ??= []).push(slug);
}
const EUROPE_CC = ['eng', 'esp', 'ger', 'ita', 'fra', 'por', 'ned', 'tur', 'bel', 'sco', 'gre', 'rus', 'aut', 'sui', 'den', 'swe', 'nor'];
// Önce üst ligler (kıta turnuvalarındaki takımların çoğu), sonra alt basamaklar
const byTier = (ccs) => [...ccs.flatMap((cc) => (TIERS[cc] ?? []).slice(0, 1)), ...ccs.flatMap((cc) => (TIERS[cc] ?? []).slice(1))];
const CONTINENTAL = {
  uefa: byTier(EUROPE_CC),
  conmebol: byTier(['bra', 'arg', 'col', 'chi', 'uru']),
  concacaf: byTier(['usa', 'mex']),
  afc: byTier(['ksa', 'jpn', 'kor', 'chn', 'aus']),
};
// Milli takım turnuvaları kulüp ligleriyle eşleşmez
const NATIONAL = /^(fifa\.|uefa\.(nations|euro)|conmebol\.america|concacaf\.(gold|nations)|afc\.asian|caf\.nations)/;

/** Kupa / kıta turnuvası için takımların aranacağı yerel ligler (sıralı). Yerel lig ya da milli takım turnuvasıysa boş. */
export function candidateLeagues(league) {
  if (DOMESTIC.test(league) || NATIONAL.test(league)) return [];
  const [cc] = league.split('.');
  if (TIERS[cc]) return TIERS[cc]; // ulusal kupa: eng.fa, ger.dfb_pokal, esp.copa_del_rey...
  return CONTINENTAL[cc] ?? [];
}

/** Takımın lig maçlarındaki son 5 maç formu (alınan puan / alınabilecek puan); 3 maçtan azsa null. */
export function leagueForm(matches, teamId, now) {
  const id = String(teamId);
  const pts = [];
  for (let i = matches.length - 1; i >= 0 && pts.length < 5; i--) {
    const m = matches[i];
    if (m.timestamp >= now) continue;
    const home = String(m.homeId) === id;
    if (!home && String(m.awayId) !== id) continue;
    const gf = home ? m.homeGoals : m.awayGoals;
    const ga = home ? m.awayGoals : m.homeGoals;
    pts.push(gf > ga ? 3 : gf === ga ? 1 : 0);
  }
  return pts.length >= 3 ? pts.reduce((a, b) => a + b, 0) / (3 * pts.length) : null;
}

export class MatchSimulator {
  constructor({ espn = new EspnClient(), memory = new TeamMemory(), historySeasons = 3, syncMaxAgeMs = 6 * 3600 * 1000, log = () => {} } = {}) {
    this.espn = espn;
    this.memory = memory;
    this.historySeasons = historySeasons;
    this.syncMaxAgeMs = syncMaxAgeMs;
    this.log = log;
  }

  // Takımın maç geçmişini hafızaya alır. Geçmiş sezonlar bir kez çekilir, güncel sezon periyodik yenilenir.
  async syncTeam(league, teamId, name, warnings) {
    await this.memory.init();
    const cur = currentSeason();
    for (let i = 0; i < this.historySeasons; i++) {
      const season = cur - i;
      const fresh = i === 0 ? this.memory.isSynced(teamId, season, this.syncMaxAgeMs) : this.memory.isSynced(teamId, season);
      if (fresh) continue;
      try {
        const matches = await this.espn.getTeamMatches(league, teamId, season);
        await this.memory.remember(teamId, name, matches, season);
        this.log(`${name ?? teamId} ${season}: ${matches.length} maç hafızaya alındı`);
      } catch (e) {
        warnings.push(`${name ?? teamId} ${season} sezonu alınamadı: ${e.message}`);
      }
    }
  }

  async _table(league, warnings) {
    try {
      return await this.espn.getStandings(league);
    } catch (e) {
      warnings.push(`${league} puan durumu alınamadı: ${e.message}`);
      return null;
    }
  }

  // Yerel ligler ("tur.1", "eng.2" gibi) için lig geneli güç. Kupalarda ve kıta turnuvalarında takımların kendi
  // liglerinin gücü kullanılır (_cross).
  async _ratings(league, now, warnings) {
    if (!DOMESTIC.test(league) || typeof this.espn.getLeagueMatches !== 'function') return null;
    try {
      const matches = await this.espn.getLeagueMatches(league);
      const ratings = fitRatings(matches, { now, newTeam: await this._newTeam(league, now) });
      if (!ratings) warnings.push(`${league} için yeterli lig verisi yok; takım geçmişi kullanıldı`);
      else ratings.matchList = matches;
      return ratings;
    } catch (e) {
      warnings.push(`${league} lig verisi alınamadı: ${e.message}`);
      return null;
    }
  }

  /**
   * Ligde yeni takım ön bilgisi. Üst ligde (".1") yeni takım alt ligden çıkmıştır: zayıf merkez. Alt basamaklarda yeni
   * takım üst ligden düşmüş de olabilir; üst ligin son maçlarında görünen takım güçlü merkezden başlar. Üst lig verisi
   * alınamazsa alt basamakta ön bilgi kullanılmaz (düşen takımı zayıf saymaktansa ortalama saymak daha güvenli).
   */
  async _newTeam(league, now) {
    const base = MODEL.ratingNewTeam;
    if (!base) return null;
    const [cc, n] = league.split('.');
    const tier = Number(n);
    if (tier <= 1) return base;
    const upper = `${cc}.${tier - 1}`;
    if (!LEAGUES[upper] || !MODEL.ratingRelegatedTeam) return null;
    try {
      const up = await this.espn.getLeagueMatches(upper);
      const recent = new Set();
      for (const m of up) {
        if (m.timestamp < now && m.timestamp > now - 400 * DAY) {
          recent.add(String(m.homeId));
          recent.add(String(m.awayId));
        }
      }
      return { ...base, center: (id) => (recent.has(String(id)) ? MODEL.ratingRelegatedTeam : null) };
    } catch {
      return null;
    }
  }

  /** Takımın bu sezon oynadığı yerel lig (adaylar sırayla denenir; takım listeleri 12 saat önbellekte). */
  async _teamLeague(teamId, candidates) {
    if (typeof this.espn.getTeams !== 'function') return null;
    const id = String(teamId);
    for (const league of candidates) {
      try {
        const teams = await this.espn.getTeams(league, { maxAgeMs: 12 * 3600 * 1000 });
        if (teams.some((t) => t.id === id)) return league;
      } catch {
        // lig listesi alınamadı: sonraki aday
      }
    }
    return null;
  }

  /**
   * Kupa ve kıta turnuvası maçları: her takım kendi liginin gücüyle değerlendirilir, ligler arası fark lig güç
   * katsayısıyla eklenir. İki takım aynı ligdeyse o ligin güç tablosu doğrudan kullanılır.
   * Dönüş: { ratings } (aynı lig) | { cross } | null (eski yönteme dönülür).
   */
  async _crossLeague(league, homeId, awayId, now, warnings) {
    const candidates = candidateLeagues(league);
    if (!candidates.length) return null;
    const [hl, al] = await Promise.all([this._teamLeague(homeId, candidates), this._teamLeague(awayId, candidates)]);
    if (!hl && !al) return null;
    if (hl && al && hl === al) {
      const ratings = await this._ratings(hl, now, warnings);
      return ratings ? { ratings, leagues: { home: hl, away: al } } : null;
    }
    const [Rh, Ra] = await Promise.all([hl ? this._ratings(hl, now, warnings) : null, al ? this._ratings(al, now, warnings) : null]);
    if ((hl && !Rh) || (al && !Ra)) return null;
    const side = (id, lg, R) => ({ ratings: R, id: String(id), league: lg, strength: leagueStrength(lg), form: leagueForm(R.matchList ?? [], id, now) });
    // Hiçbir ligde bulunamayan takım: ulusal kupada en alt basamağın da altında (amatör/bölgesel), kıta turnuvasında
    // listemizde olmayan bir ligin üst sıralarındaki takım varsayılır.
    const unknown = (R) => {
      const national = Boolean(TIERS[league.split('.')[0]]);
      if (national) {
        const lowest = TIERS[league.split('.')[0]].at(-1);
        return { ratings: R, team: { att: 1, def: 1 }, league: null, strength: leagueStrength(lowest) / MODEL.unknownTierGap };
      }
      return { ratings: R, team: MODEL.unknownContinentalTeam, league: null, strength: MODEL.unknownContinentalStrength };
    };
    const home = hl ? side(homeId, hl, Rh) : unknown(Ra);
    const away = al ? side(awayId, al, Ra) : unknown(Rh);
    if (!hl || !al) warnings.push('Takımlardan biri listedeki liglerde bulunamadı; gücü tahmini');
    const kind = TIERS[league.split('.')[0]] ? 'national' : 'continental';
    return { cross: { home, away, kind }, leagues: { home: hl, away: al } };
  }

  // Maç öncesi analiz. awayLeague farklıysa (ör. Avrupa maçı) lig gücü oranı uygulanır.
  // now: analizde yalnızca bu andan ÖNCEKİ maçlar kullanılır (biten maçın tahminini sonradan dürüstçe üretmek için).
  async prepare({ league, homeId, awayId, homeName, awayName, awayLeague = league, elo = null, neutral = false, now = Date.now() }) {
    await this.memory.init();
    const warnings = [];
    homeId = String(homeId);
    awayId = String(awayId);

    const homeTable = await this._table(league, warnings);
    const awayTable = awayLeague === league ? homeTable : await this._table(awayLeague, warnings);

    homeName = homeName ?? homeTable?.entries.get(homeId)?.name ?? this.memory.data.teams[homeId]?.name ?? homeId;
    awayName = awayName ?? awayTable?.entries.get(awayId)?.name ?? this.memory.data.teams[awayId]?.name ?? awayId;

    await Promise.all([
      this.syncTeam(league, homeId, homeName, warnings),
      this.syncTeam(awayLeague, awayId, awayName, warnings),
    ]);

    // Aynı ligdeki (yerel lig) iki takım için lig geneli güç; kupa ve kıta turnuvasında takımların kendi ligleri.
    // Alınamazsa eski yönteme (takım geçmişi) dönülür.
    let ratings = awayLeague === league ? await this._ratings(league, now, warnings) : null;
    let cross = null;
    let homeMatches = this.memory.getMatches(homeId);
    let awayMatches = this.memory.getMatches(awayId);
    if (!ratings && awayLeague === league && !DOMESTIC.test(league)) {
      const x = await this._crossLeague(league, homeId, awayId, now, warnings).catch((e) => {
        warnings.push(`lig gücü alınamadı: ${e.message}`);
        return null;
      });
      if (x?.ratings) ratings = x.ratings;
      if (x?.cross) cross = x.cross;
      // Form ve gol ortalamaları kupa maçlarıyla sınırlı kalmasın: takımın kendi ligindeki maçları da eklenir
      const lists = { home: x?.cross?.home?.ratings?.matchList ?? x?.ratings?.matchList, away: x?.cross?.away?.ratings?.matchList ?? x?.ratings?.matchList };
      const merge = (own, list, id, lg) => {
        if (!lg || !list) return own;
        const byId = new Map(own.map((m) => [m.id, m]));
        for (const m of list) if (String(m.homeId) === id || String(m.awayId) === id) byId.set(m.id, m);
        return [...byId.values()].sort((a, b) => b.timestamp - a.timestamp);
      };
      homeMatches = merge(homeMatches, lists.home, homeId, x?.leagues?.home);
      awayMatches = merge(awayMatches, lists.away, awayId, x?.leagues?.away);
    }

    const analysis = analyzeMatch({
      home: { id: homeId, name: homeName },
      away: { id: awayId, name: awayName },
      homeMatches,
      awayMatches,
      h2hMatches: this.memory.getHeadToHead(homeId, awayId),
      homeTable,
      awayTable,
      homeLeague: league,
      awayLeague,
      elo,
      ratings,
      cross,
      neutral,
      now,
    });
    analysis.dataQuality.warnings = warnings;
    return analysis;
  }

  async simulate(opts, { seed } = {}) {
    const analysis = await this.prepare(opts);
    const timeline = simulateMatch(analysis, { seed });
    await this.memory.recordSimulation({
      homeId: analysis.home.id,
      awayId: analysis.away.id,
      score: timeline.score,
      seed: timeline.seed,
    });
    return { analysis, timeline };
  }

  // Hazırlar + simüle eder + gerçek zamanlı oynatır
  async play(opts, { seed, ...playOptions } = {}) {
    const { analysis, timeline } = await this.simulate(opts, { seed });
    const player = playTimeline(timeline, playOptions);
    return { analysis, timeline, ...player };
  }

  // Monte Carlo özeti (ör. "bu maç 1000 kez oynansa" ekranı)
  async monteCarlo(opts, n = 1000, seed) {
    const analysis = await this.prepare(opts);
    return { analysis, summary: simulateMany(analysis, n, seed) };
  }
}
