// Futbol bilgi yarışması soruları: sabit bilgi bankası (tarihî ve kesin bilgiler) + oyuncu havuzundan güncel sorular
// (oyuncunun kulübü, uyruğu, mevkisi; bir kulübün oyuncusu). Her soruda 4 seçenek, biri doğru.
//
// Sabit banka yalnızca değişmeyen bilgileri içerir (sponsorlu stat adları gibi değişebilen bilgiler yok).

import { fold } from './pool.js';

/** [soru, doğru, yanlış1, yanlış2, yanlış3] */
export const STATIC_QUESTIONS = [
  ['2022 Dünya Kupası\'nı hangi ülke kazandı?', 'Arjantin', 'Fransa', 'Hırvatistan', 'Fas'],
  ['2018 Dünya Kupası\'nı hangi ülke kazandı?', 'Fransa', 'Hırvatistan', 'Belçika', 'Brezilya'],
  ['2014 Dünya Kupası\'nı hangi ülke kazandı?', 'Almanya', 'Arjantin', 'Brezilya', 'Hollanda'],
  ['2010 Dünya Kupası\'nı hangi ülke kazandı?', 'İspanya', 'Hollanda', 'Almanya', 'Uruguay'],
  ['Türkiye 2002 Dünya Kupası\'nı kaçıncı sırada bitirdi?', 'Üçüncü', 'Dördüncü', 'İkinci', 'Çeyrek finalist'],
  ['2002 Dünya Kupası hangi iki ülkede düzenlendi?', 'Güney Kore ve Japonya', 'Almanya ve Avusturya', 'Fransa ve Belçika', 'ABD ve Meksika'],
  ['Galatasaray UEFA Kupası\'nı hangi yıl kazandı?', '2000', '1999', '2001', '2002'],
  ['Galatasaray 2000 UEFA Süper Kupası\'nda hangi takımı yendi?', 'Real Madrid', 'Barcelona', 'Bayern Münih', 'Manchester United'],
  ['Avrupa kupalarında şampiyon olan tek Türk kulübü hangisidir?', 'Galatasaray', 'Fenerbahçe', 'Beşiktaş', 'Trabzonspor'],
  ['Euro 2016\'yı hangi ülke kazandı?', 'Portekiz', 'Fransa', 'Almanya', 'Galler'],
  ['2021\'de oynanan Euro 2020\'yi hangi ülke kazandı?', 'İtalya', 'İngiltere', 'İspanya', 'Danimarka'],
  ['Euro 2024\'ü hangi ülke kazandı?', 'İspanya', 'İngiltere', 'Fransa', 'Hollanda'],
  ['Euro 2024 hangi ülkede düzenlendi?', 'Almanya', 'Fransa', 'İngiltere', 'İtalya'],
  ['Euro 2004\'ü hangi ülke kazandı?', 'Yunanistan', 'Portekiz', 'Çekya', 'Hollanda'],
  ['Türkiye Euro 2008\'de hangi turda elendi?', 'Yarı final', 'Çeyrek final', 'Grup aşaması', 'Final'],
  ['Türkiye Euro 2008 çeyrek finalinde hangi ülkeyi penaltılarla eledi?', 'Hırvatistan', 'Çekya', 'İsviçre', 'Portekiz'],
  ['İlk Dünya Kupası hangi yıl düzenlendi?', '1930', '1924', '1934', '1950'],
  ['İlk Dünya Kupası\'nı hangi ülke kazandı?', 'Uruguay', 'Arjantin', 'İtalya', 'Brezilya'],
  ['2010 Dünya Kupası hangi ülkede düzenlendi?', 'Güney Afrika', 'Brezilya', 'Almanya', 'Japonya'],
  ['2014 Dünya Kupası hangi ülkede düzenlendi?', 'Brezilya', 'Rusya', 'Güney Afrika', 'Arjantin'],
  ['2018 Dünya Kupası hangi ülkede düzenlendi?', 'Rusya', 'Katar', 'Brezilya', 'Almanya'],
  ['2022 Dünya Kupası hangi ülkede düzenlendi?', 'Katar', 'Rusya', 'Suudi Arabistan', 'Birleşik Arap Emirlikleri'],
  ['2026 Dünya Kupası\'na hangi ülkeler ev sahipliği yaptı?', 'ABD, Kanada ve Meksika', 'ABD ve Kanada', 'Meksika ve Brezilya', 'İspanya, Portekiz ve Fas'],
  ['1958 Dünya Kupası\'nda tek turnuvada 13 gol atan golcü kimdir?', 'Just Fontaine', 'Miroslav Klose', 'Gerd Müller', 'Ronaldo Nazário'],
  ['Pelé hangi ülkenin efsane futbolcusudur?', 'Brezilya', 'Arjantin', 'Portekiz', 'Uruguay'],
  ['Diego Maradona İtalya\'da hangi kulüpte forma giydi?', 'Napoli', 'Juventus', 'Milan', 'Roma'],
  ['Lionel Messi profesyonel kariyerine hangi kulüpte başladı?', 'Barcelona', 'Paris Saint-Germain', 'Espanyol', 'Inter Miami'],
  ['Cristiano Ronaldo\'nun ilk profesyonel kulübü hangisidir?', 'Sporting', 'Benfica', 'Porto', 'Manchester United'],
  ['Hakan Şükür 2002 Dünya Kupası\'nda Güney Kore\'ye karşı golünü yaklaşık kaçıncı saniyede attı?', '11. saniye', '25. saniye', '40. saniye', '58. saniye'],
  ['Şampiyonlar Ligi\'ni en çok kazanan kulüp hangisidir?', 'Real Madrid', 'Milan', 'Bayern Münih', 'Liverpool'],
  ['2005 Şampiyonlar Ligi finali hangi şehirde oynandı?', 'İstanbul', 'Atina', 'Moskova', 'Roma'],
  ['2005\'teki İstanbul finalinde kupayı hangi takım kaldırdı?', 'Liverpool', 'Milan', 'Chelsea', 'Juventus'],
  ['2023 Şampiyonlar Ligi finalini İstanbul\'da hangi takım kazandı?', 'Manchester City', 'Inter', 'Real Madrid', 'Bayern Münih'],
  ['Şampiyonlar Ligi\'nin eski adı nedir?', 'Avrupa Şampiyon Kulüpler Kupası', 'Kupa Galipleri Kupası', 'UEFA Kupası', 'Fuar Şehirleri Kupası'],
  ['2003-04 Premier Lig sezonunu yenilgisiz tamamlayan takım hangisidir?', 'Arsenal', 'Manchester United', 'Chelsea', 'Liverpool'],
  ['Altın Top ödülünü en çok kazanan futbolcu kimdir?', 'Lionel Messi', 'Cristiano Ronaldo', 'Michel Platini', 'Johan Cruyff'],
  ['Bir futbol maçının normal süresi kaç dakikadır?', '90', '80', '100', '70'],
  ['Uzatma devreleri toplam kaç dakikadır?', '30', '20', '15', '40'],
  ['Sahada bir takımdan aynı anda en fazla kaç oyuncu bulunur?', '11', '10', '12', '9'],
  ['Penaltı noktası kale çizgisine kaç metre uzaklıktadır?', '11 metre', '9 metre', '12 metre', '16 metre'],
  ['Hangi durumda ofsayt uygulanmaz?', 'Taç atışından gelen topta', 'Serbest vuruştan gelen topta', 'Kafa vuruşunda', 'Ortada'],
  ['Aynı maçta ikinci sarı kartı gören oyuncuya ne olur?', 'Oyundan atılır', 'Uyarılır', '10 dakika oyun dışı kalır', 'Hiçbir şey olmaz'],
  ['Günümüz kurallarına göre bir takım normal sürede en fazla kaç oyuncu değişikliği yapabilir?', '5', '3', '4', '6'],
  ['VAR kısaltması neyin karşılığıdır?', 'Video Yardımcı Hakem', 'Video Analiz Raporu', 'Varsayılan Atak Rotası', 'Video Arşiv Rehberi'],
  ['Hat-trick ne demektir?', 'Bir oyuncunun bir maçta 3 gol atması', 'Üç kez direkten dönen top', 'Üç asist', 'Üç maç üst üste gol'],
  ['Kaleci topu yalnızca hangi bölgede elle tutabilir?', 'Ceza sahasında', 'Kale alanında', 'Kendi yarı sahasında', 'Her yerde'],
  ['"El Clásico" hangi iki takım arasında oynanır?', 'Real Madrid - Barcelona', 'Atlético Madrid - Real Madrid', 'Barcelona - Espanyol', 'Sevilla - Real Betis'],
  ['Beşiktaş\'ın lakabı nedir?', 'Kara Kartallar', 'Sarı Kanaryalar', 'Bordo-Mavililer', 'Cimbom'],
  ['"Sarı Kanaryalar" hangi kulübün lakabıdır?', 'Fenerbahçe', 'Galatasaray', 'Ankaragücü', 'Kayserispor'],
  ['"Bordo-Mavililer" denince akla gelen kulüp hangisidir?', 'Trabzonspor', 'Beşiktaş', 'Bursaspor', 'Sivasspor'],
  ['Trabzonspor ilk lig şampiyonluğunu hangi sezon kazandı?', '1975-76', '1979-80', '1983-84', '2021-22'],
  ['Trabzonspor 38 yıl sonra gelen şampiyonluğunu hangi sezon kazandı?', '2021-22', '2010-11', '2015-16', '2023-24'],
  ['Real Madrid\'in stadının adı nedir?', 'Santiago Bernabéu', 'Wanda Metropolitano', 'Mestalla', 'Camp Nou'],
  ['"Old Trafford" hangi kulübün stadıdır?', 'Manchester United', 'Manchester City', 'Liverpool', 'Leeds United'],
  ['"Anfield" hangi kulübün stadıdır?', 'Liverpool', 'Everton', 'Arsenal', 'Chelsea'],
  ['San Siro stadını paylaşan iki kulüp hangileridir?', 'Milan ve Inter', 'Juventus ve Torino', 'Roma ve Lazio', 'Napoli ve Salernitana'],
  ['Bayern Münih\'in stadının adı nedir?', 'Allianz Arena', 'Signal Iduna Park', 'Olympiastadion', 'Veltins-Arena'],
  ['"Turuncular" lakabıyla bilinen milli takım hangisidir?', 'Hollanda', 'Fildişi Sahili', 'İrlanda', 'Belçika'],
  ['"La Albiceleste" hangi milli takımın lakabıdır?', 'Arjantin', 'Uruguay', 'İtalya', 'Şili'],
  ['"Les Bleus" hangi milli takımın lakabıdır?', 'Fransa', 'İtalya', 'İskoçya', 'Yunanistan'],
];

const GROUP_NAMES = { KL: 'Kaleci', DEF: 'Defans', OS: 'Orta saha', FV: 'Forvet' };

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Seçenekleri karıştırır; doğru cevabın yeni sırası döner. */
function make(text, correct, wrong, rng, meta = {}) {
  const opts = shuffle([correct, ...wrong.slice(0, 3)], rng);
  return { text, options: opts, answer: opts.indexOf(correct), ...meta };
}

/** Havuzdan güncel bir soru (oyuncu kulübü, uyruğu, mevkisi ya da bir kulübün oyuncusu). Uygun veri yoksa null. */
export function poolQuestion(players, rng) {
  if (players.length < 40) return null;
  const known = players.filter((p) => p.r >= 74);
  const base = known.length >= 20 ? known : players;
  const p = base[rng.int(0, base.length - 1)];
  const kind = rng.int(0, 3);
  if (kind === 0) {
    // Oyuncu hangi kulüpte? Yanlış seçenekler aynı ligin başka kulüpleri
    const clubs = [...new Set(players.filter((x) => x.l === p.l && x.c !== p.c).map((x) => x.c))];
    if (clubs.length < 3) return null;
    return make(`${p.n} şu an hangi kulüpte oynuyor?`, p.c, shuffle(clubs, rng), rng, { kind: 'club' });
  }
  if (kind === 1 && p.na) {
    const nats = [...new Set(players.filter((x) => x.na && x.na !== p.na).map((x) => x.na))];
    if (nats.length < 3) return null;
    return make(`${p.n} hangi ülkenin oyuncusu?`, p.na, shuffle(nats, rng), rng, { kind: 'nation' });
  }
  if (kind === 2) {
    const wrong = Object.entries(GROUP_NAMES).filter(([g]) => g !== p.g).map(([, n]) => n);
    return make(`${p.n} hangi mevkide oynuyor?`, GROUP_NAMES[p.g], wrong, rng, { kind: 'position' });
  }
  // Hangisi bu kulübün oyuncusu?
  const others = shuffle(players.filter((x) => x.c !== p.c && x.l === p.l && x.r >= 70), rng);
  const names = [...new Set(others.map((x) => x.n))].filter((n) => fold(n) !== fold(p.n));
  if (names.length < 3) return null;
  return make(`Hangisi ${p.c} kadrosunda?`, p.n, names, rng, { kind: 'member' });
}

/** Bir yarışma oturumunun soruları: sabit ve güncel sorular karışık, tekrar yok. */
export function buildQuestions(players, rng, n = 15) {
  const out = [];
  const statics = shuffle(STATIC_QUESTIONS, rng);
  let si = 0;
  const seen = new Set();
  let guard = 0;
  while (out.length < n && guard++ < n * 6) {
    const usePool = players.length >= 40 && rng.next() < 0.45;
    let q = usePool ? poolQuestion(players, rng) : null;
    if (!q && si < statics.length) {
      const [text, correct, ...wrong] = statics[si++];
      q = make(text, correct, wrong, rng, { kind: 'static' });
    }
    if (!q || seen.has(q.text)) continue;
    seen.add(q.text);
    out.push(q);
  }
  return out;
}
