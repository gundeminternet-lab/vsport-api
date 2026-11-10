// Mevkiler ve mevkiye göre güç (saf). Kartın gücü (r) kendi mevkisindeki gücüdür; başka bir mevkideki gücü altı
// özelliğin o mevkinin ağırlıklarıyla farkından hesaplanır (örneğin hızlı ve şutu iyi bir orta saha kanatta daha
// güçlüdür). Uygulamadaki lib/game/positions.dart aynı tabloyu kullanır.
//
// Saha oyuncusu özellikleri: [HIZ, ŞUT, PAS, DRİ, DEF, FİZ]. Kaleci yalnızca kalede oynar.

export const POSITIONS = {
  KL: { id: 'KL', name: 'Kaleci', g: 'KL' },
  STP: { id: 'STP', name: 'Stoper', g: 'DEF' },
  SLB: { id: 'SLB', name: 'Sol bek', g: 'DEF' },
  SĞB: { id: 'SĞB', name: 'Sağ bek', g: 'DEF' },
  DOS: { id: 'DOS', name: 'Defansif orta saha', g: 'OS' },
  MOS: { id: 'MOS', name: 'Merkez orta saha', g: 'OS' },
  OOS: { id: 'OOS', name: 'Ofansif orta saha', g: 'OS' },
  SLO: { id: 'SLO', name: 'Sol orta saha', g: 'OS' },
  SĞO: { id: 'SĞO', name: 'Sağ orta saha', g: 'OS' },
  SLK: { id: 'SLK', name: 'Sol kanat', g: 'FV' },
  SĞK: { id: 'SĞK', name: 'Sağ kanat', g: 'FV' },
  SNT: { id: 'SNT', name: 'Santrfor', g: 'FV' },
};
export const FIELD_POSITIONS = Object.keys(POSITIONS).filter((p) => p !== 'KL');

/** Mevki ağırlıkları (toplam 1): HIZ ŞUT PAS DRİ DEF FİZ. */
export const WEIGHTS = {
  STP: [0.12, 0.02, 0.1, 0.04, 0.45, 0.27],
  SLB: [0.24, 0.03, 0.17, 0.12, 0.3, 0.14],
  SĞB: [0.24, 0.03, 0.17, 0.12, 0.3, 0.14],
  DOS: [0.08, 0.05, 0.27, 0.12, 0.3, 0.18],
  MOS: [0.1, 0.1, 0.34, 0.22, 0.12, 0.12],
  OOS: [0.12, 0.2, 0.3, 0.3, 0.02, 0.06],
  SLO: [0.24, 0.12, 0.25, 0.25, 0.06, 0.08],
  SĞO: [0.24, 0.12, 0.25, 0.25, 0.06, 0.08],
  SLK: [0.3, 0.2, 0.15, 0.3, 0.0, 0.05],
  SĞK: [0.3, 0.2, 0.15, 0.3, 0.0, 0.05],
  SNT: [0.2, 0.4, 0.06, 0.16, 0.0, 0.18],
};

/** Birbirine yakın mevkiler (yakın mevkide küçük kayıp). */
export const NEAR = {
  STP: ['DOS', 'SLB', 'SĞB'],
  SLB: ['SLO', 'STP'],
  SĞB: ['SĞO', 'STP'],
  DOS: ['MOS', 'STP'],
  MOS: ['DOS', 'OOS'],
  OOS: ['MOS', 'SNT'],
  SLO: ['SLK', 'SLB', 'MOS'],
  SĞO: ['SĞK', 'SĞB', 'MOS'],
  SLK: ['SLO', 'SNT', 'SĞK'],
  SĞK: ['SĞO', 'SNT', 'SLK'],
  SNT: ['OOS', 'SLK', 'SĞK'],
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const score = (st, pos) => (WEIGHTS[pos] ?? WEIGHTS.MOS).reduce((a, w, i) => a + w * Number(st?.[i] ?? 50), 0);

/** Kartın bir mevkideki gücü. Kendi mevkisinde r. Kaleci kalede, saha oyuncusu sahada oynar. */
export function positionRating(card, pos) {
  const r = Number(card?.r ?? 50);
  const own = POSITIONS[card?.pos] ? card.pos : card?.g === 'KL' ? 'KL' : 'MOS';
  if (pos === own) return r;
  if (own === 'KL' || pos === 'KL') return clamp(Math.round(r * 0.4), 20, 60);
  const st = Array.isArray(card?.st) ? card.st : [];
  const delta = score(st, pos) - score(st, own);
  // Özellik farkının yarısı + mevkiye alışma kaybı (yakın mevki az, uzak mevki çok)
  const loss = (NEAR[own] ?? []).includes(pos) ? 1 : POSITIONS[pos].g === POSITIONS[own].g ? 3 : 7;
  return clamp(Math.round(r + delta * 0.5 - loss), 30, 99);
}

/** Kartın en iyi üç mevkisi: [{ pos, r }] (ilk kendi mevkisi ya da daha iyisi). */
export function bestPositions(card, n = 3) {
  if (card?.g === 'KL' || card?.pos === 'KL') return [{ pos: 'KL', r: Number(card?.r ?? 50) }];
  return FIELD_POSITIONS.map((pos) => ({ pos, r: positionRating(card, pos) }))
    .sort((a, b) => b.r - a.r || (a.pos === card?.pos ? -1 : b.pos === card?.pos ? 1 : 0))
    .slice(0, n);
}

/** Kart bu yuvaya ne kadar uygun: 'tam' (kendi mevkisi), 'yakın', 'grup' (aynı grup), 'uzak'. */
export function fitOf(cardPos, slotPos) {
  if (cardPos === slotPos) return 'tam';
  if ((NEAR[cardPos] ?? []).includes(slotPos)) return 'yakın';
  if (POSITIONS[cardPos] && POSITIONS[slotPos] && POSITIONS[cardPos].g === POSITIONS[slotPos].g) return 'grup';
  return 'uzak';
}
