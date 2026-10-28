// Kapışma: iki kadro karşılaşır (saf). Güç = ortalama puan + kimya katkısı; gol beklentisi güç farkıyla değişir,
// goller Poisson ile çekilir; gol atanlar forvet ve orta sahalardan puana göre seçilir.

import { evaluate, teamPower } from './squad.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function scorer(lineup, rng) {
  const cands = Object.values(lineup).filter((c) => c && (c.g === 'FV' || c.g === 'OS' || c.g === 'DEF'));
  const w = cands.map((c) => (c.g === 'FV' ? 3 : c.g === 'OS' ? 1.5 : 0.35) * Math.pow(c.r / 70, 3));
  const total = w.reduce((a, b) => a + b, 0);
  let x = rng.next() * total;
  for (let i = 0; i < cands.length; i++) {
    x -= w[i];
    if (x <= 0) return cands[i];
  }
  return cands[cands.length - 1] ?? null;
}

/** a, b: { formation, lineup } → { score: [ga, gb], events: [{ side, minute, name }], result: 'W'|'D'|'L', power: [pa, pb] } */
export function simulateDuel(a, b, rng) {
  const ea = evaluate(a.formation, a.lineup);
  const eb = evaluate(b.formation, b.lineup);
  const pa = teamPower(ea);
  const pb = teamPower(eb);
  const la = clamp(1.35 * Math.exp(0.07 * (pa - pb)), 0.25, 4);
  const lb = clamp(1.35 * Math.exp(0.07 * (pb - pa)), 0.25, 4);
  const ga = rng.poisson(la);
  const gb = rng.poisson(lb);
  const events = [];
  for (let i = 0; i < ga; i++) events.push({ side: 0, minute: rng.int(1, 90), name: scorer(a.lineup, rng)?.s ?? '' });
  for (let i = 0; i < gb; i++) events.push({ side: 1, minute: rng.int(1, 90), name: scorer(b.lineup, rng)?.s ?? '' });
  events.sort((x, y) => x.minute - y.minute);
  return { score: [ga, gb], events, result: ga > gb ? 'W' : ga === gb ? 'D' : 'L', power: [Math.round(pa * 10) / 10, Math.round(pb * 10) / 10] };
}
