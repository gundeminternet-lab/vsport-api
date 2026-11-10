// Maçın oynandığı stadyum: ev sahibinin stadyumu. İç sahada kulübün geliştirdiği stadyum (seviyesi, kapasitesi, bilet
// fiyatına göre dolan tribün), deplasmanda rakibin stadyumu (başka kullanıcının kulübü ya da kurgusal takım).
// Stadyum maçı da etkiler: ev sahibinin gol beklentisi stadyum seviyesi ve doluluğuyla artar (saha avantajı).

import { effectsOf } from './club.js';
import { hashStr } from './staff.js';

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Kurgusal takımın (rakip bot, kariyer rakibi) stadyum seviyesi: gücüyle. */
export const botStadiumLevel = (power) => clamp(Math.round((Number(power) - 58) / 3.2), 1, 10);

/** Saha avantajı çarpanı: 1,02 + seviye × doluluk etkisi (en çok ~1,09). */
export const homeAdvantage = (level, fill) => Math.round((1.02 + 0.007 * clamp(Number(level) || 1, 1, 10) * clamp(Number(fill) || 0, 0, 1)) * 1000) / 1000;

/** Normal maçta iç saha / deplasman: rakip belirlenirken bir kez (tohumla, %55 iç saha). */
export const homeFor = (seed) => hashStr(`ha:${seed}`) % 100 < 55;

/** Uygulamaya giden stadyum görünümü. */
export function stadiumView({ host, name, level, capacity, attendance, crest = null, short = null, fans = null }) {
  const cap = Math.max(0, Math.round(capacity));
  const att = clamp(Math.round(attendance), 0, cap);
  return {
    host, // 'me' | 'opp'
    name,
    level: clamp(Math.round(level), 1, 10),
    capacity: cap,
    attendance: att,
    fill: cap ? Math.round((att / cap) * 100) / 100 : 0,
    crest,
    short,
    fans,
  };
}

/** İç saha: kulübün stadyumu, bilet fiyatına göre seyirci. */
export function homeStadium(p, crowd) {
  const levels = p.club?.levels ?? {};
  const capacity = effectsOf(levels).stadium.capacity;
  return stadiumView({ host: 'me', name: `${p.club?.name ?? 'Kulüp'} Stadyumu`, level: Number(levels.stadium ?? 1), capacity, attendance: crowd?.attendance ?? capacity * 0.6, crest: p.club?.crest ?? null, short: p.club?.short ?? null, fans: p.club?.fans ?? null });
}

/** Deplasman: rakibin stadyumu (kullanıcı kulübünün anlık görüntüsü ya da gücünden kurgusal stadyum). */
export function awayStadium(opp, power, seed) {
  const st = opp.stadium ?? null;
  const level = st?.level ?? botStadiumLevel(power);
  const capacity = st?.capacity ?? effectsOf({ stadium: level }).stadium.capacity;
  // Deplasman tribünü: %55-95 dolu (tohumla sabit)
  const fill = 0.55 + (hashStr(`fill:${seed}`) % 41) / 100;
  return stadiumView({ host: 'opp', name: st?.name ?? `${opp.name} Arena`, level, capacity, attendance: capacity * fill, crest: opp.crest ?? null, short: st?.short ?? null, fans: opp.fans ?? null });
}
