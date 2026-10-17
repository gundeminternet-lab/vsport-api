// Tüm ayarlanabilir sabitler tek yerde. Modeli kendi verine göre buradan ince ayar yapabilirsin.

export const ESPN = {
  siteApi: 'https://site.api.espn.com/apis/site/v2/sports/soccer',
  tableApi: 'https://site.api.espn.com/apis/v2/sports/soccer',
  timeoutMs: 10000,
  retries: 2,
  cacheTtlMs: 5 * 60 * 1000,
};

// Lig güç katsayıları: SADECE farklı liglerden takımlar karşılaşırsa (Şampiyonlar Ligi vb.) kullanılır.
// Bunlar resmi değil, kabaca tahmindir; kendi Elo/UEFA verinle değiştirebilirsin.
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
  'gre.1': { name: 'Yunan Süper Ligi', strength: 0.7 },
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

  leagueStrengthExp: 0.6,
  eloK: 0.0008, // her iki takıma yarı yarıya uygulanan Elo farkı katsayısı

  lambdaMin: 0.25,
  lambdaMax: 4.2,
  dcRho: -0.06, // Dixon-Coles düşük skor düzeltmesi (yalnızca olasılık tablosunda)
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
