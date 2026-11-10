// Genetik sisi: oyuncunun genetiği başta gizlidir; parça parça keşfedilir (antrenman, maç, gözlemci raporu).
// Gizli olsa da etkisi vardır (antrenman, sakatlık); keşfedilince görünür. Kartta: gx (bit maskesi).
//   1 gelişim hızı · 2 fiziksel yapı · 4 zirve yaşı · 8 doğuştan yetenekler (15: tamamı; not ancak tamamı açılınca)

import { geneticsView } from './genetics.js';

export const FOG = {
  bits: { growth: 1, body: 2, peak: 4, traits: 8 },
  all: 15,
  /** Antrenmanda bir parçanın açılma ihtimali; maçta oynayan her oyuncu için. */
  trainChance: 0.6,
  matchChance: 0.12,
  /** Gözlemci raporu: bütün genetiği açar (oyun kredisiyle). */
  scoutCost: 350,
};
export const PARTS = { 1: 'growth', 2: 'body', 4: 'peak', 8: 'traits' };
export const PART_NAMES = { growth: 'Gelişim hızı', body: 'Fiziksel yapı', peak: 'Zirve yaşı', traits: 'Doğuştan yetenek' };

export const revealedBits = (card) => Number(card?.gx ?? 0) & FOG.all;

/** Altyapı genci: akademi seviyesi ne kadarını gösterir (gözlemci raporu). */
export const youthBits = (academyLevel) => {
  const l = Number(academyLevel) || 1;
  return (l >= 1 ? 1 : 0) | (l >= 3 ? 2 : 0) | (l >= 5 ? 8 : 0) | (l >= 7 ? 4 : 0);
};

/** Görünür genetik: açılmamış parçalar null. */
export function maskedGenetics(card, bits = revealedBits(card)) {
  const v = geneticsView(card);
  return {
    growth: bits & 1 ? v.growth : null,
    body: bits & 2 ? v.body : null,
    peak: bits & 4 ? v.peak : null,
    traits: bits & 8 ? v.traits : null,
    grade: bits === FOG.all ? v.grade : null,
    gx: bits,
  };
}

/** Rastgele bir gizli parçayı açar. Döner: { gx, part } ya da null (hepsi açık). */
export function revealOne(card, rng) {
  const gx = revealedBits(card);
  const hidden = [1, 2, 4, 8].filter((b) => !(gx & b));
  if (!hidden.length) return null;
  const b = hidden[rng.int(0, hidden.length - 1)];
  return { gx: gx | b, part: PARTS[b] };
}
