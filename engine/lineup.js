// Kadro ve eksik oyuncu düzeltmesi. ESPN maç özetindeki kadro (rosters) okunur; takımın son maçlarındaki ilk 11'lerinden
// "düzenli oyuncular" çıkarılır. Bu maçta kadroda olmayan düzenli oyuncular (sakatlık, ceza, bilinmeyen sebep) için
// beklenen gol hafifçe düzeltilir.
//
// Not: Sakatlık ve ceza bilgisi ayrı bir kaynaktan güvenilir biçimde alınamadığı için yalnızca "kadroda yok" bilgisi kullanılır.
//
// Düzeltmeler bilinçli olarak küçük tutulmuştur (ampirik kalibrasyon yapılmadı): her eksik hücum oyuncusu kendi takımının
// beklenen golünü %6 azaltır (en fazla %15); her eksik defans oyuncusu rakibin beklenen golünü %3 artırır (en fazla %10);
// eksik kaleci rakibe %5 ekler. Yedekte bekleyen düzenli oyuncu, eksikin yarısı kadar etki eder.

export const LINEUP_SAMPLE = 8; // kaç son maç taranır
export const REGULAR_MIN_STARTS = 3; // düzenli sayılmak için en az ilk 11 sayısı
export const REGULAR_SHARE = 0.5; // ... ve taranan maçların en az bu kadarında ilk 11'de olmalı

const ATTACK = new Set(['F', 'FW', 'ST', 'CF', 'LW', 'RW', 'AM', 'SS', 'LF', 'RF']);
const DEFENCE = new Set(['D', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'SW']);
const KEEPER = new Set(['G', 'GK']);

import { matchProbabilities, scoreMatrix, scoresForOutcome } from './analysis.js';
import { MODEL } from './config.js';

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Maç özetinden bir takımın kadrosu. Kadro açıklanmamışsa (ilk 11 yoksa) null. */
export function parseLineup(json, teamId) {
  const id = String(teamId);
  for (const r of json?.rosters ?? []) {
    if (String(r?.team?.id ?? '') !== id) continue;
    const starters = [];
    const bench = [];
    for (const p of r.roster ?? []) {
      const name = str(p?.athlete?.displayName) ?? str(p?.athlete?.fullName);
      if (!name) continue;
      const pos = str(p?.position?.abbreviation)?.toUpperCase() ?? null;
      (p.starter === true ? starters : bench).push({ name, pos });
    }
    if (!starters.length) return null;
    return { starters, bench };
  }
  return null;
}

/**
 * Son maçların ilk 11'lerinden düzenli oyuncular. samples: [{ starters:[{name,pos}] }] (en yeni önce).
 * Dönen: [{ name, pos, starts }] — yalnızca düzenli olanlar, ilk 11 sayısına göre sıralı.
 */
export function regularPlayers(samples) {
  const n = samples.length;
  if (n < REGULAR_MIN_STARTS) return [];
  const counts = new Map();
  for (const s of samples) {
    for (const p of s.starters ?? []) {
      const c = counts.get(p.name) ?? { name: p.name, pos: p.pos ?? null, starts: 0 };
      c.starts++;
      if (!c.pos && p.pos) c.pos = p.pos;
      counts.set(p.name, c);
    }
  }
  return [...counts.values()]
    .filter((c) => c.starts >= REGULAR_MIN_STARTS && c.starts / n >= REGULAR_SHARE)
    .sort((a, b) => b.starts - a.starts || a.name.localeCompare(b.name, 'tr'));
}

/** Bu maçın kadrosuna göre düzenli oyuncuların durumu: kadroda yok (missing) ya da yedekte (benched). */
export function absences({ regulars, lineup }) {
  const starters = new Set((lineup?.starters ?? []).map((p) => p.name));
  const bench = new Set((lineup?.bench ?? []).map((p) => p.name));
  const missing = [];
  const benched = [];
  for (const r of regulars) {
    if (starters.has(r.name)) continue;
    if (bench.has(r.name)) benched.push(r);
    else missing.push(r);
  }
  return { missing, benched };
}

const group = (pos) => (pos && ATTACK.has(pos) ? 'attack' : pos && DEFENCE.has(pos) ? 'defence' : pos && KEEPER.has(pos) ? 'keeper' : 'other');

/**
 * Bir takımın kadro düzeltmesi. attackFactor: kendi beklenen golüne çarpan; concedeFactor: rakibin beklenen golüne çarpan.
 * Konum bilinmeyen eksikler hücum sayılmaz (yalnızca kadrodan düşer, düzeltme uygulanmaz).
 */
export function lineupEffect({ missing, benched }) {
  const w = (list) => list.reduce((s, p) => s + (group(p.pos) === 'attack' ? 1 : 0), 0);
  const d = (list) => list.reduce((s, p) => s + (group(p.pos) === 'defence' ? 1 : 0), 0);
  const k = (list) => list.reduce((s, p) => s + (group(p.pos) === 'keeper' ? 1 : 0), 0);
  const attackOut = w(missing) + 0.5 * w(benched);
  const defenceOut = d(missing) + 0.5 * d(benched);
  const keeperOut = k(missing);
  const attackFactor = Math.max(0.85, 1 - 0.06 * attackOut);
  const concedeFactor = Math.min(1.1, 1 + 0.03 * defenceOut + 0.05 * keeperOut);
  return { attackFactor, concedeFactor, attackOut, defenceOut, keeperOut };
}

/**
 * Kadro düzeltmesinden sonra güncel tahmin. base: { lambdaHome, lambdaAway, sigma }.
 * Dönen: { lambdaHome, lambdaAway, probabilities:{home,draw,away} (%), pick, topScore }.
 */
export function applyLineupAdjustment({ base, homeEffect, awayEffect, sigma = 0 }) {
  // Ev sahibinin golü: kendi hücumu × deplasmanın defans zaafı. Deplasmanın golü tersi.
  const lh = base.lambdaHome * homeEffect.attackFactor * awayEffect.concedeFactor;
  const la = base.lambdaAway * awayEffect.attackFactor * homeEffect.concedeFactor;
  const pr = matchProbabilities(lh, la, sigma);
  const probabilities = { home: Math.round(pr.homeWin * 100), draw: Math.round(pr.draw * 100), away: Math.round(pr.awayWin * 100) };
  // İçerikteki tahminle aynı kural (content.js → predictedOutcome).
  const pick = pr.homeWin >= pr.draw && pr.homeWin >= pr.awayWin ? '1' : pr.awayWin >= pr.draw && pr.awayWin >= pr.homeWin ? '2' : 'X';
  const top = scoresForOutcome(scoreMatrix(lh, la, MODEL.dcRho, 10, sigma), pick)[0];
  return { lambdaHome: lh, lambdaAway: la, probabilities, pick, topScore: top?.score ?? null };
}
