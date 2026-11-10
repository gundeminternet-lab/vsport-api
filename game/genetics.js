// Oyuncu genetiği: her oyuncunun değişmeyen, doğuştan gelen özellikleri. Kartın kimliğinden (pid) sabit bir özetle
// hesaplanır; kaydedilmez, uygulama da aynı hesabı yapar (lib/game/genetics.dart).
//
//   growth   Gelişim hızı: Hızlı gelişen (antrenman ×1.25), Normal, Geç açılan (×0.85)
//   body     Fiziksel yapı: Demir adam (sakatlık riski −%50), Normal, Kırılgan (risk +%60, sakatlık 1 maç uzun)
//   peak     Zirve yaşı (26-31): bu yaştan sonra gelişim yavaşlar (×0.7); 21 yaş ve altı hızlı öğrenir (×1.15)
//   traits   0-2 doğuştan yetenek: ilgili özellik antrenmanda fazladan gelişir; uyan antrenmanda +%10 gelişim
//   grade    Genetik notu (A+ … D): hepsinin özeti
// Altyapıdan gelen gençlerin (youth) genetiği daha şanslıdır.

import { hashStr } from './staff.js';

export const GROWTH = {
  hizli: { id: 'hizli', name: 'Hızlı gelişen', k: 1.25 },
  normal: { id: 'normal', name: 'Normal gelişim', k: 1 },
  gec: { id: 'gec', name: 'Geç açılan', k: 0.85 },
};

export const BODY = {
  demir: { id: 'demir', name: 'Demir adam', injury: 0.5, extra: 0 },
  normal: { id: 'normal', name: 'Normal yapı', injury: 1, extra: 0 },
  kirilgan: { id: 'kirilgan', name: 'Kırılgan', injury: 1.6, extra: 1 },
};

/** Doğuştan yetenekler. stat: kart özelliği (0 HIZ, 1 ŞUT, 2 PAS, 3 DRİ, 4 DEF, 5 FİZ); kaleci için kStat. */
export const TRAITS = {
  patlayici: { id: 'patlayici', name: 'Patlayıcı hız', stat: 0, kStat: 0, desc: 'Hız antrenmandan fazladan gelişir' },
  bitirici: { id: 'bitirici', name: 'Soğukkanlı bitirici', stat: 1, kStat: 1, desc: 'Şut fazladan gelişir' },
  oyunakli: { id: 'oyunakli', name: 'Oyun aklı', stat: 2, kStat: 2, desc: 'Pas fazladan gelişir' },
  kivrak: { id: 'kivrak', name: 'Kıvrak teknik', stat: 3, kStat: 3, desc: 'Dripling fazladan gelişir' },
  duvar: { id: 'duvar', name: 'Duvar', stat: 4, kStat: 4, desc: 'Savunma fazladan gelişir' },
  ciger: { id: 'ciger', name: 'Demir ciğer', stat: 5, kStat: 5, desc: 'Fizik fazladan gelişir' },
  lider: { id: 'lider', name: 'Doğuştan lider', stat: null, kStat: null, desc: 'Disiplin sorunu çıkarmaz' },
};
const TRAIT_IDS = Object.keys(TRAITS);

/** Kartın genetik anahtarı: oyuncunun kimliği (aynı oyuncu her kartta aynı genetik). */
export const geneKey = (card) => String(card?.pid ?? card?.gk ?? card?.id ?? card?.n ?? '');

// 32 bit çarpma; 16 bitlik parçalarla (Dart'ta da web'de de aynı sonucu verir).
const mul32 = (a, b) => ((a & 0xffff) * b + ((((a >>> 16) * b) & 0xffff) * 65536)) >>> 0;
/** murmur3 fmix32: komşu anahtarların sonuçları birbirine benzemesin. */
export function mix32(x) {
  let h = x >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = mul32(h, 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = mul32(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Anahtardan k. bağımsız zar (0-99). */
export const geneRoll = (h, k) => mix32((h + k * 0x9e3779b9) % 4294967296) % 100;

/** Oyuncunun genetiği (saf, sabit). */
export function geneticsOf(card) {
  const h = hashStr(`gen:${geneKey(card)}`);
  const youth = card?.youth === true;
  const g1 = geneRoll(h, 1);
  const growth = g1 < (youth ? 40 : 22) ? GROWTH.hizli : g1 < (youth ? 88 : 78) ? GROWTH.normal : GROWTH.gec;
  const b1 = geneRoll(h, 2);
  const body = b1 < 20 ? BODY.demir : b1 < 85 ? BODY.normal : BODY.kirilgan;
  const peak = 26 + (geneRoll(h, 3) % 6);
  const t1 = geneRoll(h, 4);
  const t2 = geneRoll(h, 5);
  const traits = [];
  if (t1 < (youth ? 60 : 45)) traits.push(TRAITS[TRAIT_IDS[t1 % TRAIT_IDS.length]]);
  if (t2 < (youth ? 25 : 15)) {
    const t = TRAITS[TRAIT_IDS[(t2 + 3) % TRAIT_IDS.length]];
    if (!traits.includes(t)) traits.push(t);
  }
  // Not: gelişim, yapı ve yetenek sayısından
  const score = (growth.id === 'hizli' ? 2 : growth.id === 'normal' ? 1 : 0) + (body.id === 'demir' ? 1 : body.id === 'normal' ? 0.5 : 0) + traits.length;
  const grade = score >= 4 ? 'A+' : score >= 3 ? 'A' : score >= 2.5 ? 'B+' : score >= 1.5 ? 'B' : score >= 1 ? 'C' : 'D';
  return { growth, body, peak, traits, grade };
}

/** Yaşa göre gelişim katsayısı ve açıklaması. */
export function ageFactor(card, gen = geneticsOf(card)) {
  const a = Number(card?.a ?? card?.age);
  if (!Number.isFinite(a) || a <= 0) return { k: 1, text: null };
  if (a <= 21) return { k: 1.15, text: 'Genç: hızlı öğrenir' };
  if (a > gen.peak) return { k: 0.7, text: `Zirve yaşını (${gen.peak}) geçti` };
  return { k: 1, text: null };
}

/**
 * Bir antrenmandaki gelişim katsayısı (saf): gelişim hızı × yaş × (antrenman genetik yeteneğe uyuyorsa +%10).
 * drillStats: antrenmanın geliştirdiği özellikler (kaleci/oyuncu).
 */
export function trainFactor(card, drillStats = []) {
  const gen = geneticsOf(card);
  const age = ageFactor(card, gen);
  const keeper = card?.g === 'KL';
  const fits = gen.traits.some((t) => {
    const s = keeper ? t.kStat : t.stat;
    return s != null && drillStats.includes(s);
  });
  const k = Math.round(gen.growth.k * age.k * (fits ? 1.1 : 1) * 1000) / 1000;
  return { k, gen, age, fits };
}

/** Genetik yeteneklerin özellik numaraları (seviye atlayınca fazladan +1). */
export function traitStats(card, gen = geneticsOf(card)) {
  const keeper = card?.g === 'KL';
  return gen.traits.map((t) => (keeper ? t.kStat : t.stat)).filter((s) => s != null);
}

/** Uygulamaya giden kısa görünüm. */
export function geneticsView(card) {
  const g = geneticsOf(card);
  return { growth: g.growth.id, body: g.body.id, peak: g.peak, traits: g.traits.map((t) => t.id), grade: g.grade };
}
