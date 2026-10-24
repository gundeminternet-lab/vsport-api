// Maçın önemi (0-100): yarışma türü, puan tablosundaki konum, sezonun hangi evresinde olunduğu ve derbi/rekabet.
// Saf fonksiyon; Asistan bu skoru ve gerekçeleri maç analizinin öncelik sırasını belirlemek için kullanır.

const norm = (s) =>
  String(s ?? '')
    .replaceAll('İ', 'i')
    .toLowerCase()
    .replaceAll('ç', 'c')
    .replaceAll('ğ', 'g')
    .replaceAll('ı', 'i')
    .replaceAll('ö', 'o')
    .replaceAll('ş', 's')
    .replaceAll('ü', 'u');

/** Yarışmanın kendi ağırlığı (0-100 ölçeğinde taban puan). */
const COMPETITION = {
  'fifa.world': 90,
  'uefa.euro': 88,
  'uefa.champions': 72,
  'conmebol.libertadores': 68,
  'uefa.europa': 62,
  'eng.fa': 58,
  'uefa.europa.conf': 55,
  'esp.copa_del_rey': 55,
  'ger.dfb_pokal': 55,
  'uefa.nations': 55,
  'conmebol.sudamericana': 55,
  'concacaf.champions': 55,
  'afc.champions': 55,
  'caf.champions': 55,
  'ita.coppa_italia': 52,
  'fra.coupe_de_france': 50,
  'eng.league_cup': 48,
  'fifa.friendly': 25,
};
const BIG_LEAGUES = new Set(['tur.1', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1']);
const CUPS = new Set(['eng.fa', 'esp.copa_del_rey', 'ger.dfb_pokal', 'ita.coppa_italia', 'fra.coupe_de_france', 'eng.league_cup']);

/** Derbi / büyük rekabet çiftleri (normalize edilmiş takım adı parçaları). */
const DERBIES = [
  ['galatasaray', 'fenerbahce', 'Dev derbi'],
  ['galatasaray', 'besiktas', 'Dev derbi'],
  ['fenerbahce', 'besiktas', 'Dev derbi'],
  ['trabzonspor', 'fenerbahce', 'Büyük rekabet'],
  ['trabzonspor', 'galatasaray', 'Büyük rekabet'],
  ['trabzonspor', 'besiktas', 'Büyük rekabet'],
  ['real madrid', 'barcelona', 'El Clásico'],
  ['real madrid', 'atletico', 'Madrid derbisi'],
  ['sevilla', 'betis', 'Sevilla derbisi'],
  ['barcelona', 'espanyol', 'Katalonya derbisi'],
  ['arsenal', 'tottenham', 'Kuzey Londra derbisi'],
  ['liverpool', 'everton', 'Merseyside derbisi'],
  ['manchester united', 'manchester city', 'Manchester derbisi'],
  ['liverpool', 'manchester united', 'İngiltere\'nin dev rekabeti'],
  ['chelsea', 'arsenal', 'Londra derbisi'],
  ['chelsea', 'tottenham', 'Londra derbisi'],
  ['inter milan', 'ac milan', 'Milano derbisi'],
  ['juventus', 'inter milan', 'İtalya derbisi'],
  ['juventus', 'ac milan', 'Büyük rekabet'],
  ['roma', 'lazio', 'Roma derbisi'],
  ['bayern', 'dortmund', 'Almanya\'nın dev rekabeti'],
  ['dortmund', 'schalke', 'Ruhr derbisi'],
  ['celtic', 'rangers', 'Old Firm derbisi'],
  ['benfica', 'porto', 'Portekiz klasiği'],
  ['benfica', 'sporting', 'Lizbon derbisi'],
  ['sporting', 'porto', 'Portekiz klasiği'],
  ['ajax', 'feyenoord', 'De Klassieker'],
  ['paris saint', 'marseille', 'Le Classique'],
  ['olympiakos', 'panathinaikos', 'Ebedi derbi'],
  ['boca', 'river', 'Superclásico'],
  ['flamengo', 'fluminense', 'Fla-Flu derbisi'],
];

/** İki takım arasında bilinen bir derbi/rekabet varsa adını döndürür. */
export function derbyOf(homeName, awayName) {
  const h = norm(homeName);
  const a = norm(awayName);
  for (const [x, y, label] of DERBIES) {
    if ((h.includes(x) && a.includes(y)) || (h.includes(y) && a.includes(x))) return label;
  }
  return null;
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function competitionBase(league) {
  if (Object.hasOwn(COMPETITION, league)) return COMPETITION[league];
  if (BIG_LEAGUES.has(league)) return 50;
  if (/^[a-z]{3}\.1$/.test(league)) return 42;
  if (/^[a-z]{3}\.[2-9]$/.test(league)) return 32;
  return 40;
}

/**
 * Maç önemi.
 * girdi: { league, homeName, awayName, homeRank, awayRank, homePpg, awayPpg, homePlayed, awayPlayed, teamCount }
 * çıktı: { score, level: 'mega'|'high'|'medium'|'low', label, reasons: [], tags: [] }
 */
export function importanceOf({ league, homeName, awayName, homeRank = null, awayRank = null, homePpg = null, awayPpg = null, homePlayed = null, awayPlayed = null, teamCount = null }) {
  const reasons = [];
  const tags = [];
  let score = competitionBase(league);

  if (/^uefa\.(champions|europa|europa\.conf)$/.test(league)) {
    reasons.push('Avrupa kupası gecesi: sonuç, kupadaki yolculuğu doğrudan etkiler.');
    tags.push('avrupa');
  } else if (CUPS.has(league)) {
    reasons.push('Kupa maçı: tek mağlubiyet yolculuğu bitirebilir.');
    tags.push('kupa');
  } else if (league === 'fifa.world' || league === 'uefa.euro') {
    reasons.push('Büyük turnuva maçı.');
    tags.push('turnuva');
  } else if (league === 'fifa.friendly') {
    reasons.push('Hazırlık maçı: sonucun puan etkisi yok.');
    tags.push('hazirlik');
  }

  const derby = derbyOf(homeName, awayName);
  if (derby) {
    score += 18;
    reasons.push(`${derby}: form ve sıralama ikinci planda kalabilir.`);
    tags.push('derbi');
  }

  const domestic = /^[a-z]{3}\.[1-9]$/.test(league);
  if (domestic && homeRank && awayRank && teamCount && teamCount >= 8) {
    const played = Math.max(homePlayed ?? 0, awayPlayed ?? 0);
    const progress = clamp(played / (2 * (teamCount - 1)), 0, 1);
    const m = 0.5 + 0.5 * progress; // sezonun sonuna doğru tablo baskısı artar
    const lo = Math.min(homeRank, awayRank);
    const hi = Math.max(homeRank, awayRank);
    const bottom = teamCount - 3; // son dört sıra

    if (hi <= 3) {
      score += 25 * m;
      reasons.push(lo === 1 && hi === 2 ? 'Lider ile ikinci sıra karşı karşıya: şampiyonluk yarışının kalbi.' : 'Şampiyonluk yarışının iki adayı birbiriyle oynuyor.');
      tags.push('sampiyonluk');
    } else if (lo <= 3 && hi <= 6) {
      score += 12 * m;
      reasons.push('Zirve yarışındaki bir takım, ilk altıdaki rakibiyle karşılaşıyor.');
      tags.push('zirve');
    } else if (lo >= 3 && hi <= 7) {
      score += 10 * m;
      reasons.push('Avrupa kupası yarışındaki iki takımın doğrudan rekabeti.');
      tags.push('avrupa-yarisi');
    }
    if (lo >= bottom) {
      score += 18 * m;
      reasons.push('Düşme hattında iki takım doğrudan rekabet ediyor: puan çok değerli.');
      tags.push('dusme');
    } else if (hi >= bottom && lo >= teamCount - 6) {
      score += 8 * m;
      reasons.push('Alt sıralardaki mücadele: kazanan nefes alacak.');
      tags.push('alt-sira');
    }
    if (hi - lo <= 2 && hi <= Math.ceil(teamCount / 2)) {
      score += 5;
      reasons.push('İki takım tabloda yan yana; kazanan sıralamada fark atabilir.');
    }
    if (Number.isFinite(homePpg) && Number.isFinite(awayPpg) && hi <= 6 && Math.abs(homePpg - awayPpg) <= 0.25) {
      score += 4;
    }
    if (progress >= 0.75 && (tags.includes('sampiyonluk') || tags.includes('dusme'))) {
      reasons.push('Sezonun kritik virajı: her puan hesabı değiştirebilir.');
    }
  }

  score = Math.round(clamp(score, 5, 100));
  if (!reasons.length) reasons.push(domestic ? 'Tablo açısından dengeli bir hafta maçı.' : 'Standart bir karşılaşma.');
  const level = score >= 80 ? 'mega' : score >= 65 ? 'high' : score >= 48 ? 'medium' : 'low';
  const label = { mega: 'Çok yüksek', high: 'Yüksek', medium: 'Orta', low: 'Düşük' }[level];
  return { score, level, label, reasons, tags };
}
