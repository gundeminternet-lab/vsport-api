// Orkestrasyon: ESPN'den veriyi çeker, takım hafızasına yazar, analiz eder, simüle eder, oynatır.

import { EspnClient } from './espn.js';
import { TeamMemory } from './memory.js';
import { analyzeMatch } from './analysis.js';
import { simulateMatch, simulateMany } from './simulator.js';
import { playTimeline } from './playback.js';

// Avrupa sezonu: Temmuz'dan itibaren yeni sezon (2026-27 sezonu için ESPN "2026" kullanır)
export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1;
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

    const analysis = analyzeMatch({
      home: { id: homeId, name: homeName },
      away: { id: awayId, name: awayName },
      homeMatches: this.memory.getMatches(homeId),
      awayMatches: this.memory.getMatches(awayId),
      h2hMatches: this.memory.getHeadToHead(homeId, awayId),
      homeTable,
      awayTable,
      homeLeague: league,
      awayLeague,
      elo,
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
