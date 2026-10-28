// Tüm ayarlanabilir sabitler tek yerde. Modeli kendi verine göre buradan ince ayar yapabilirsin.

export const ESPN = {
  siteApi: 'https://site.api.espn.com/apis/site/v2/sports/soccer',
  tableApi: 'https://site.api.espn.com/apis/v2/sports/soccer',
  coreApi: 'https://sports.core.api.espn.com/v2/sports/soccer/leagues',
  timeoutMs: 10000,
  retries: 2,
  cacheTtlMs: 5 * 60 * 1000,
};

// Lig güç katsayıları: SADECE farklı liglerden takımlar karşılaşırsa (Avrupa kupaları, ulusal kupada farklı basamaklar)
// kullanılır. Etkisi (s_ev / s_dep)^leagueStrengthExp. Üst ligler kabaca tahmindir (Şampiyonlar Ligi maçlarıyla
// sınandı); aynı ülkenin alt basamakları 2010-2025 arası çıkan/düşen takımların iki sezondaki gücünden ölçüldü
// (ör. Championship takımı Premier Lig'e çıkınca güç farkı ≈ 1.38 kat).
export const LEAGUES = {
  'eng.1': { name: 'Premier League', strength: 1.0 },
  'esp.1': { name: 'La Liga', strength: 0.97 },
  'ger.1': { name: 'Bundesliga', strength: 0.93 },
  'ita.1': { name: 'Serie A', strength: 0.93 },
  'fra.1': { name: 'Ligue 1', strength: 0.86 },
  'por.1': { name: 'Liga Portugal', strength: 0.82 },
  'ned.1': { name: 'Eredivisie', strength: 0.8 },
  'tur.1': { name: 'Süper Lig', strength: 0.8 },
  'bel.1': { name: 'Belçika Pro Lig', strength: 0.74 },
  'sco.1': { name: 'İskoç Premiership', strength: 0.7 },
  'gre.1': { name: 'Yunanistan Süper Ligi', strength: 0.7 },
  // Alt ligler ve diğer ülkeler (yalnızca farklı liglerin takımları karşılaşırsa kullanılır; kabaca tahmin)
  'eng.2': { name: 'Championship', strength: 0.72 },
  'esp.2': { name: 'La Liga 2', strength: 0.76 },
  'ita.2': { name: 'Serie B', strength: 0.7 },
  'ger.2': { name: '2. Bundesliga', strength: 0.72 },
  'ger.3': { name: '3. Liga', strength: 0.59 },
  'fra.2': { name: 'Ligue 2', strength: 0.66 },
  'eng.3': { name: 'League One', strength: 0.585 },
  'eng.4': { name: 'League Two', strength: 0.505 },
  'tur.2': { name: 'TFF 1. Lig', strength: 0.62 },
  'rus.1': { name: 'Rusya Premier Ligi', strength: 0.68 },
  'aut.1': { name: 'Avusturya Bundesliga', strength: 0.66 },
  'sui.1': { name: 'İsviçre Süper Ligi', strength: 0.62 },
  'den.1': { name: 'Danimarka Superliga', strength: 0.62 },
  'swe.1': { name: 'İsveç Allsvenskan', strength: 0.56 },
  'nor.1': { name: 'Norveç Eliteserien', strength: 0.56 },
  'usa.1': { name: 'MLS', strength: 0.66 },
  'mex.1': { name: 'Liga MX', strength: 0.7 },
  'bra.1': { name: 'Brezilya Serie A', strength: 0.78 },
  'arg.1': { name: 'Arjantin Ligi', strength: 0.74 },
  'col.1': { name: 'Kolombiya Ligi', strength: 0.55 },
  'chi.1': { name: 'Şili Ligi', strength: 0.5 },
  'uru.1': { name: 'Uruguay Ligi', strength: 0.5 },
  'ksa.1': { name: 'Suudi Pro Lig', strength: 0.62 },
  'jpn.1': { name: 'Japonya J1 Lig', strength: 0.6 },
  'kor.1': { name: 'Güney Kore K Lig 1', strength: 0.55 },
  'chn.1': { name: 'Çin Süper Ligi', strength: 0.45 },
  'aus.1': { name: 'Avustralya A-League', strength: 0.45 },
};

export const MODEL = {
  defaultLeagueAvg: 1.4, // lig tablosu yoksa takım başı maç başı gol
  unknownLeagueStrength: 0.7,

  // Geçmiş maç ağırlıkları
  maxMatches: 40,
  halfLifeMatches: 6, // her 6 maçta ağırlık yarıya iner
  halfLifeDays: 400, // her ~13 ayda ağırlık yarıya iner
  shrinkMatches: 4, // az maçta lig ortalamasına çekme gücü (sahte maç sayısı)
  tableWeight: 0.35, // sezon tablosundaki gol verisinin payı

  venueAdjust: true, // geçmiş maçlardaki goller ev/deplasman etkisinden arındırılır
  homeAdvantage: 0.13, // ev sahibi +%13, deplasman -%13 (oran ≈ 1.30)

  // Form
  formNeutral: 0.47,
  formWeight: 0.2,
  formAttackExp: 0.7,
  formDefenseExp: -0.3,

  // Puan durumu etkisi (puan ortalaması farkı başına)
  tableTilt: 0.04,
  tableTiltMax: 0.08,

  // İkili geçmiş (H2H)
  h2hMax: 8,
  h2hWeightPerMatch: 0.03,
  h2hMaxWeight: 0.15,

  // Lig güç oranının üssü. Şampiyonlar Ligi (434 maç) ve Almanya Kupası (118 maç) geriye dönük testinde 1.2-1.5
  // aralığı en iyi; 0.6 güçlü lig takımlarını belirgin biçimde küçümsüyordu.
  leagueStrengthExp: 1.4,
  eloK: 0.0008, // her iki takıma yarı yarıya uygulanan Elo farkı katsayısı

  // Lig geneli takım gücü (engine/ratings.js)
  ratingHalfLifeDays: 300, // maçın ağırlığı her ~10 ayda yarıya iner
  ratingMaxAgeDays: 620, // bundan eski maçlar kullanılmaz
  ratingPrior: 8, // az maçı olan takımı lig ortalamasına çeken "sahte maç" sayısı
  ratingMinWeight: 5, // takımın ligde en az bu kadar (ağırlıklı) maçı olmalı, yoksa eski yönteme dönülür
  ratingFormWeight: 0.1, // güç zaten güncel maçlara ağırlık verir; son 5 maç formu yalnızca hafif etkiler
  ratingH2hMaxWeight: 0.03, // ikili geçmiş lig gücünün üstüne çok az bilgi ekliyor (test)
  // Toplam gol beklentisi ligin ortalamasına çekilir, güç farkı biraz açılır (analysis.shapeLambdas). 2017-2026
  // arası 15 ligde haftalık yeniden kurulan modelle ayarlandı (eğitim 2017-22, doğrulama 2022-26).
  ratingTotalK: 0.6,
  ratingSupK: 1.1,
  ratingUncMul: 0.3, // aynı ligde belirsizlik katmanının payı (tam katman olasılıkları gereğinden fazla ortaya çekiyordu)
  // Ligde yeni takım (son 300 günde ligde ilk maçı): az maçta lig ortalamasına değil, daha zayıf bir merkeze çekilir
  // (alt ligden çıkan takımlar ortalamanın altındadır). Sezonun ilk maçında bile lig gücü kullanılabilir.
  ratingNewTeam: { days: 300, att: 0.9, def: 1.1 },
  // Alt basamakta yeni takım üst ligden düşmüşse güçlü merkez (çıkan/düşen ayrımı geriye dönük testte belirgin fark etti)
  ratingRelegatedTeam: { att: 1.1, def: 0.9 },
  ratingMinWeightNew: 0,
  // Kupada listedeki hiçbir ligde bulunamayan takım: ülkenin en alt basamağından bu kat zayıf (amatör/bölgesel lig)
  unknownTierGap: 1.3,
  // Kıta turnuvasında listede olmayan ligin takımı: o ligin üst sıralarında (turnuvaya katılmış) varsayılır
  unknownContinentalStrength: 0.55,
  unknownContinentalTeam: { att: 1.25, def: 0.8 },

  // Belirsizlik: iki takımın güç farkı kesin bilinmez. Olasılıklar bu belirsizlik üzerinden ortalanır
  // (aşırı iddialı %80'lik tahminleri gerçeğe yaklaştırır). sigma = uncBase + uncScale / sqrt(etkin maç + 2)
  uncBase: 0.07,
  uncScale: 0.55,
  uncMin: 0.1,
  uncMax: 0.3,

  lambdaMin: 0.3,
  lambdaMax: 3.8,
  // Dixon-Coles düşük skor düzeltmesi (yalnızca olasılık tablosunda). 2017-22 verisi -0.1'i, son sezonlar (beraberlik
  // oranı düştü) -0.04'ü seçiyor; ikisinin arası.
  dcRho: -0.06,
  // Yarı skorlarında düşük skor bağımlılığı daha zayıf: tam düzeltme ilk yarı 0-0 ihtimalini gerçekte görülenden
  // (~%27-30) yukarı itiyordu.
  dcRhoHalf: -0.015,

  // Dış tahmin verisiyle birleştirme (engine/blend.js): modelin ve piyasanın gol beklentileri log uzayında ağırlıklı
  // ortalanır. weight 2. aşamadaki geriye dönük testle ayarlanacak; şimdilik yaygın bulgu esas (piyasanın kapanış
  // görüşü tek başına çoğu modelden iyidir, ikisinin birleşimi her ikisinden de iyidir). Veri zayıfsa ağırlık azalır:
  // tek kaynak (× singleSource), kaynaklar ayrışıyor (spread > spreadMax → ×0.5), λ çözümü zorlandı (fitErrorMax →
  // ×0.5), veri eski (staleHours → ×0.5; iki katından eskiyse kullanılmaz).
  marketBlend: { weight: 0.5, max: 0.65, singleSource: 0.8, spreadMax: 0.06, fitErrorMax: 0.03, staleHours: 12 },
};

export const SIM = {
  durationSeconds: 60, // maçın gerçek süre karşılığı
  halftimeSeconds: 2, // 60 saniyenin içinden devre arasına ayrılan süre
  // Olay oranları (takım başı, maç başı)
  yellowPerTeam: 1.9,
  redPerTeam: 0.045,
  penaltyPerTeam: 0.11,
  penaltyConversion: 0.77,
  varDisallowChance: 0.035,
  cornersPerShot: 0.36,
};
