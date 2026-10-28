// Oyun ekonomisi: kredi yalnızca oyunlarla kazanılır, satın alınmaz ve hiçbir oyunda ortaya konmaz (kaybedilen kredi
// yok). Krediler market paketlerine harcanır. Sayılar tek yerde; uygulama gameState'ten okur.

/** Başlangıç kredisi (ilk açılış). */
export const START_CREDITS = 500;

/** 28 günlük giriş yolu: her giriş yapılan gün bir adım (ardışık olması gerekmez). 28. adım büyük final. */
export const BONUS_PATH = Array.from({ length: 28 }, (_, i) => {
  const day = i + 1;
  if (day === 28) return 10000;
  if (day === 21) return 2000;
  if (day === 14) return 1000;
  if (day === 7) return 500;
  return 100;
});

/**
 * Paketler. weights: kart katmanlarının olasılığı (bronz < 65, gümüş 65-74, altın 75-84, elit 85+).
 * guaranteed: en az kaç kart 80+ (vSport paketi).
 */
export const PACKS = {
  gunluk: { id: 'gunluk', name: 'Günlük Paket', cost: 0, count: 5, weights: { bronze: 0.85, silver: 0.14, gold: 0.01 }, daily: true, desc: 'Her gün bir kez ücretsiz.' },
  bronz: { id: 'bronz', name: 'Bronz Paket', cost: 2500, count: 7, weights: { bronze: 0.8, silver: 0.18, gold: 0.02 }, desc: 'Bronz ağırlıklı, kadronu tamamlamak için uygun fiyatlı paket.' },
  gumus: { id: 'gumus', name: 'Gümüş Paket', cost: 5000, count: 10, weights: { bronze: 0.2, silver: 0.65, gold: 0.15 }, desc: 'Gümüş ağırlıklı; altın kart çıkma şansı yüksek.' },
  altin: { id: 'altin', name: 'Altın Paket', cost: 10000, count: 12, weights: { bronze: 0.05, silver: 0.45, gold: 0.45, elite: 0.05 }, desc: 'Altın ağırlıklı; elit kart çıkabilir.' },
  vsport: { id: 'vsport', name: 'vSport Paket', cost: 20000, count: 8, weights: { silver: 0.3, gold: 0.55, elite: 0.15 }, guaranteed: 3, desc: '3 yıldız (80+) oyuncu garantili, en güçlü paket.' },
};

/** Hızlı satış: kadroda olmayan kart krediye çevrilir. */
export const SELL_PRICE = { bronze: 100, silver: 250, gold: 600, elite: 1500 };

/** Günlük oyun hakları ve ödüller. */
export const PHOTO = { attempts: 10, firstReward: 1000, stepPenalty: 100, minReward: 100 };
export const QUIZ = { dailyPlays: 5, perCorrect: 50, proBonus: 10, seconds: 5, graceMs: 2500, maxQuestions: 15 };
export const DUEL = { daily: 3, win: 300, draw: 120, loss: 40 };

/** Günlük görevler: koşul günlük kayıttan okunur. */
export const MISSIONS = [
  { id: 'bonus', title: 'Günlük bonusunu topla', reward: 50, done: (d) => d?.bonus === true },
  { id: 'photo', title: 'Fotoğraftan Bil\'i oyna', reward: 100, done: (d) => d?.photo?.finished === true },
  { id: 'quiz5', title: 'Bilgi yarışmasında 5 doğru yap', reward: 150, done: (d) => (d?.quiz?.correct ?? 0) >= 5 },
  { id: 'duel', title: 'Bir kapışma yap', reward: 100, done: (d) => (d?.duels ?? 0) >= 1 },
  { id: 'pack', title: 'Bir paket aç', reward: 100, done: (d) => (d?.packs ?? 0) >= 1 },
];

/** Kart katmanı adı (arayüzde). */
export const TIER_NAMES = { bronze: 'Bronz', silver: 'Gümüş', gold: 'Altın', elite: 'Elit' };

/** Katman sınırları (puan). */
export const TIER_RANGE = { bronze: [47, 64], silver: [65, 74], gold: [75, 84], elite: [85, 99] };

/** En çok kaç kadro kaydedilebilir. */
export const MAX_SQUADS = 3;
