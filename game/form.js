// Canlı kartlar: gerçek maçlardaki performans karta yansır. Oyuncu havuzu haftada bir veri kaynağından yenilenir;
// iki yenileme arasında oyuncunun sezon golü, asisti ve maç sayısındaki artış o haftanın formudur.
//   form 0-3 (alev): kart gücüne +0/+1/+2/+3 (o hafta; kartın kayıtlı puanı değişmez)

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const FORM = { boost: [0, 1, 2, 3] };

/** İki yenileme arasındaki form (saf). prev/cur: { sg: gol, sa: asist, sp: maç } */
export function formOf(prev, cur, group = 'OS') {
  if (!prev || !cur) return 0;
  const dg = Math.max(0, Number(cur.sg ?? 0) - Number(prev.sg ?? 0));
  const da = Math.max(0, Number(cur.sa ?? 0) - Number(prev.sa ?? 0));
  const dp = Math.max(0, Number(cur.sp ?? 0) - Number(prev.sp ?? 0));
  if (dg + da + dp === 0) return 0;
  // Savunma ve kaleci: forma maç sayısı daha çok katkı verir (gol nadir)
  const playW = group === 'KL' || group === 'DEF' ? 0.9 : 0.4;
  const score = dg * 2 + da * 1.2 + Math.min(dp, 3) * playW;
  return score >= 4 ? 3 : score >= 2.2 ? 2 : score >= 0.9 ? 1 : 0;
}

/** Yeni havuza önceki havuzdan formu işler (yerinde). */
export function applyForm(players, previous) {
  const old = new Map((previous ?? []).map((p) => [String(p.id), p]));
  for (const p of players) p.fm = formOf(old.get(String(p.id)), p, p.g);
  return players;
}

export const formBoost = (fm) => FORM.boost[clamp(Number(fm) || 0, 0, 3)];

/** Kartın canlı hali: havuzdaki formuyla güç (r) artar; form kartta 'form' olarak görünür. */
export function liveCard(card, pool) {
  const p = pool?.byId?.(card?.pid ?? card?.id);
  const fm = clamp(Number(p?.fm ?? 0), 0, 3);
  if (!fm) return card;
  return { ...card, r: Math.min(99, Number(card.r) + formBoost(fm)), form: fm };
}
