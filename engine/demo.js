// Çevrimdışı demo/test verisi: ESPN istemcisiyle aynı arayüzü taklit eder.
// Takımlar ve sonuçlar tamamen SAHTEDİR (gerçek kulüp verisi değil); yalnızca motoru denemek içindir.

import { createRng } from './rng.js';
import { currentSeason } from './service.js';

const DAY = 86400000;

export class DemoEspn {
  constructor({ now = Date.now(), seed = 'demo' } = {}) {
    this.now = now;
    this.calls = { teams: 0, standings: 0, matches: 0 };
    const rng = createRng(seed);

    // [id, ad, hücum, savunma(yediği)]
    this.teams = [
      { id: '1001', name: 'Demo Ev FK', attack: 1.15, defense: 0.85 },
      { id: '1002', name: 'Demo Dep SK', attack: 0.95, defense: 1.1 },
      ...[3, 4, 5, 6, 7, 8].map((n) => ({
        id: String(1000 + n),
        name: `Demo Takım ${n}`,
        attack: 0.8 + rng.next() * 0.4,
        defense: 0.85 + rng.next() * 0.35,
      })),
    ];
    this.matches = this._generate(rng);
  }

  _generate(rng) {
    const out = [];
    const cur = currentSeason(new Date(this.now));
    let counter = 1;
    for (let s = cur; s > cur - 3; s--) {
      const start = Date.UTC(s, 7, 10); // 10 Ağustos
      let k = 0;
      for (const h of this.teams) {
        for (const a of this.teams) {
          if (h === a) continue;
          const ts = start + Math.floor(k / 4) * 7 * DAY + (k % 4) * DAY;
          k++;
          if (ts > this.now) continue; // gelecekteki maçlar oynanmadı
          const lh = 1.4 * 1.13 * h.attack * a.defense;
          const la = 1.4 * 0.87 * a.attack * h.defense;
          out.push({
            id: `demo-${counter++}`,
            date: new Date(ts).toISOString(),
            timestamp: ts,
            league: 'demo.1',
            season: s,
            homeId: h.id,
            awayId: a.id,
            homeName: h.name,
            awayName: a.name,
            homeGoals: rng.poisson(lh),
            awayGoals: rng.poisson(la),
            completed: true,
          });
        }
      }
    }
    return out;
  }

  async getTeams() {
    this.calls.teams++;
    return this.teams.map((t) => ({ id: t.id, name: t.name, shortName: t.name, abbreviation: t.name.slice(0, 3).toUpperCase(), logo: null }));
  }

  async getTeamMatches(_league, teamId, season) {
    this.calls.matches++;
    return this.matches.filter((m) => m.season === season && (m.homeId === teamId || m.awayId === teamId)).map(({ season: _s, ...m }) => m);
  }

  async getStandings() {
    this.calls.standings++;
    const cur = currentSeason(new Date(this.now));
    const rows = new Map(this.teams.map((t) => [t.id, { teamId: t.id, name: t.name, logo: null, played: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 }]));
    for (const m of this.matches.filter((x) => x.season === cur)) {
      const h = rows.get(m.homeId);
      const a = rows.get(m.awayId);
      h.played++; a.played++;
      h.gf += m.homeGoals; h.ga += m.awayGoals;
      a.gf += m.awayGoals; a.ga += m.homeGoals;
      if (m.homeGoals > m.awayGoals) { h.wins++; h.points += 3; a.losses++; }
      else if (m.homeGoals < m.awayGoals) { a.wins++; a.points += 3; h.losses++; }
      else { h.draws++; a.draws++; h.points++; a.points++; }
    }
    const sorted = [...rows.values()].sort((x, y) => y.points - x.points || y.gf - y.ga - (x.gf - x.ga));
    sorted.forEach((r, i) => {
      r.rank = i + 1;
      r.ppg = r.played ? r.points / r.played : NaN;
    });
    const entries = new Map(sorted.map((r) => [r.teamId, r]));
    const gf = sorted.reduce((s, r) => s + r.gf, 0);
    const played = sorted.reduce((s, r) => s + r.played, 0);
    return { entries, teamCount: entries.size, leagueAvgGoals: played >= 20 ? gf / played : null };
  }
}
