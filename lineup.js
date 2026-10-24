// Kadro açıklandığında güncel tahmin (maç başlamadan önce). Ana tahmin (karnede kayıtlı olan) değişmez;
// bu yalnızca "kadro açıklandı" kartında, ilk tahminle yan yana gösterilir.
//   Akış: kadro (ESPN özeti) → düzenli oyuncular (son maçların ilk 11'leri) → bu maçta kadroda olmayanlar → yeni λ → yeni tahmin.

import { MatchSimulator } from './engine/service.js';
import { parseLineup, regularPlayers, absences, lineupEffect, applyLineupAdjustment, LINEUP_SAMPLE } from './engine/lineup.js';
import { matchKey, AppError } from './logic.js';

const CACHE_MS = 5 * 60e3;
const DAY = 86400e3;

const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

const names = (list) => list.map((p) => p.name);

/** Kadro değişikliklerini Türkçe kısa notlara çevirir. Takım adları kullanılmaz (ev sahibi / deplasman). */
export function buildNotes({ homeMissing, awayMissing, homeBenched, awayBenched }) {
  const notes = [];
  const line = (label, missing, benched) => {
    if (missing.length) notes.push(`${label} kadroda yok: ${names(missing).join(', ')}.`);
    if (benched.length) notes.push(`${label} ilk 11'de yer almıyor, yedekte: ${names(benched).join(', ')}.`);
  };
  line('Ev sahibinde düzenli oyunculardan', homeMissing, homeBenched);
  line('Deplasmanda düzenli oyunculardan', awayMissing, awayBenched);
  if (!notes.length) notes.push('Her iki takımın düzenli oyuncuları bu maçın kadrosunda.');
  return notes;
}

export class LineupService {
  /**
   * paid: PaidContentService (contentFor, findMatch, validate, memoryFactory). espn: ESPN istemcisi.
   * samplesFor(match, teamId) → [{ starters }] (en yeni önce); testlerde verilebilir.
   */
  constructor({ paid, espn, now = () => Date.now(), samplesFor = null }) {
    this.paid = paid;
    this.espn = espn;
    this.now = now;
    this._samplesFor = samplesFor;
    this._cache = new Map();
  }

  async update({ uid, league, eventId, kickoff }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.paid.validate({ league, eventId, kickoff }, { needType: false });
    const match = await this.paid.findMatch({ league, eventId, kickoff });
    if (match.completed || match.timestamp <= this.now()) {
      throw new AppError('failed-precondition', 'Kadro güncellemesi yalnızca maç başlamadan önce gösterilir.');
    }
    const key = matchKey(league, eventId);
    const hit = this._cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value;

    const value = await this._compute(match, key);
    this._cache.set(key, { at: this.now(), value });
    return value;
  }

  async _compute(match, key) {
    const json = await this.espn.getSummary(match.league, match.id, { maxAgeMs: 2 * 60e3 });
    const home = parseLineup(json, match.homeId);
    const away = parseLineup(json, match.awayId);
    if (!home || !away) return { available: false, key, reason: 'Kadrolar henüz açıklanmadı.' };

    const content = await this.paid.contentFor(match);
    const model = content?.model;
    if (!model || !content.ai) return { available: false, key, reason: 'Tahmin verisi hazır değil.' };

    const [hs, as] = await Promise.all([this.samples(match, match.homeId), this.samples(match, match.awayId)]);
    const hAbs = absences({ regulars: regularPlayers(hs), lineup: home });
    const aAbs = absences({ regulars: regularPlayers(as), lineup: away });
    const updated = applyLineupAdjustment({
      base: { lambdaHome: model.lambdaHome, lambdaAway: model.lambdaAway },
      homeEffect: lineupEffect(hAbs),
      awayEffect: lineupEffect(aAbs),
      sigma: model.sigma ?? 0,
    });
    const base = { pick: content.ai.pick, probabilities: content.ai.probabilities, topScore: content.ai.topScore };
    const pl = (list) => list.map((p) => ({ name: p.name, pos: p.pos ?? null }));
    return {
      available: true,
      key,
      sample: { home: hs.length, away: as.length },
      base,
      updated: { pick: updated.pick, probabilities: updated.probabilities, topScore: updated.topScore },
      changed: updated.pick !== base.pick || updated.topScore !== base.topScore,
      missing: { home: pl(hAbs.missing), away: pl(aAbs.missing) },
      benched: { home: pl(hAbs.benched), away: pl(aAbs.benched) },
      notes: buildNotes({ homeMissing: hAbs.missing, awayMissing: aAbs.missing, homeBenched: hAbs.benched, awayBenched: aAbs.benched }),
    };
  }

  /** Bir takımın son maçlarındaki ilk 11'ler (özeti alınamayan maçlar atlanır). */
  async samples(match, teamId) {
    if (this._samplesFor) return this._samplesFor(match, teamId);
    const sim = new MatchSimulator({ espn: this.espn, memory: this.paid.memoryFactory() });
    const id = String(teamId);
    const name = id === String(match.homeId) ? match.homeName : match.awayName;
    await sim.syncTeam(match.league, id, name, []);
    const before = this.now();
    const recent = sim.memory
      .getMatches(id)
      .filter((m) => m.completed !== false && m.timestamp < before)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, LINEUP_SAMPLE);
    const lineups = await mapLimit(recent, 4, async (m) => {
      try {
        const json = await this.espn.getSummary(m.league, m.id, { maxAgeMs: DAY });
        return parseLineup(json, id);
      } catch {
        return null;
      }
    });
    return lineups.filter(Boolean);
  }
}
