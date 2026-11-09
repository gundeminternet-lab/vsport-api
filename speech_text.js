// Sesli okuma için metin düzeltmesi. Türkçe sesler kısaltmaları kendi bildiği gibi okur: "MS 1" → "milattan sonra 1",
// "MS X" → "milattan sonra 10" (Roma rakamı), "KG Var" → "kilogram var", "2.5" → tarih. Ses üretilmeden önce bahis ve
// maç kısaltmaları açık Türkçeye çevrilir. Ekranda görünen metin değişmez; yalnızca okunan metin.
// Uygulamadaki eşi: lib/services/speech_text.dart (telefon sesi için). İkisi aynı kuralları uygular.

const L = '\\p{L}\\p{N}';
const B = `(?<![${L}])`; // kelime başı (Türkçe harflerle)
const E = `(?![${L}])`; // kelime sonu
const re = (s) => new RegExp(s, 'gu');

const SIDE = { 1: 'bir', X: 'beraberlik', 2: 'iki' };
const side = (x) => SIDE[String(x).toUpperCase()] ?? x;

const RULES = [
  // İY/MS 2/1 → ilk yarı iki, maç sonu bir
  [re(`${B}İY\\s*/\\s*MS\\s+([12X])\\s*/\\s*([12X])${E}`), (_, a, b) => `ilk yarı ${side(a)}, maç sonu ${side(b)}`],
  [re(`${B}İY\\s*/\\s*MS${E}`), () => 'ilk yarı maç sonu'],
  // MS 1 · MS X · İY 2
  [re(`${B}MS\\s+([12X])${E}`), (_, a) => `maç sonu ${side(a)}`],
  [re(`${B}İY\\s+([12X])${E}`), (_, a) => `ilk yarı ${side(a)}`],
  // Çifte şans 1-X · X-2 (beraberlikli) ve 1-2
  [re(`${B}([12]-X|X-[12])${E}`), (m) => m.split('-').map(side).join(' ya da ')],
  [re(`${B}([Çç]ifte şans)\\s+1\\s*-\\s*2${E}`), (_, w) => `${w} bir ya da iki`],
  // KG Var / Yok
  [re(`${B}KG\\s+(Var|Yok|var|yok)${E}`), (_, v) => `karşılıklı gol ${v.toLowerCase()}`],
  [re(`${B}KG${E}`), () => 'karşılıklı gol'],
  [re(`${B}İY${E}`), () => 'ilk yarı'],
  [re(`${B}MS${E}`), () => 'maç sonu'],
  [re(`${B}xG${E}`), () => 'gol beklentisi'],
  [re(`${B}(\\d+)\\s*dk\\.?${E}`), (_, n) => `${n} dakika`],
  // Dakika işareti: 90+3' → 90 artı 3. dakika; 63' → 63. dakika (63'te gibi eklere dokunulmaz)
  [re(`(\\d+)\\+(\\d+)['’](?![${L}])`), (_, a, b) => `${a} artı ${b}. dakika`],
  [re(`(\\d+)['’](?![${L}])`), (_, a) => `${a}. dakika`],
  // Yüzde
  [re(`%\\s?(\\d+(?:[.,]\\d+)?)`), (_, n) => `yüzde ${n}`],
  // Saat: 20.45 → 20:45 (ondalık sayıyla karışmasın diye yalnızca 10-23 arası saatler)
  [re(`(?<![\\d.,])(1\\d|2[0-3])\\.([0-5]\\d)(?![\\d.,])`), (_, h, m) => `${h}:${m}`],
  // Buçuklu çizgiler: 2.5 · 2,5 → 2 buçuk
  [re(`(?<![\\d.,])(\\d+)[.,]5(?![\\d])`), (_, n) => `${n} buçuk`],
  // Diğer ondalıklar: nokta yerine virgül (2.35 tarih gibi okunmasın)
  [re(`(?<![\\d.,])(\\d+)\\.(\\d+)(?![\\d.])`), (_, a, b) => `${a},${b}`],
  // Skorlar: 2-1 → 2 1 ("iki tire bir" değil)
  [re(`(?<![\\d.,-])(\\d{1,2})\\s*-\\s*(\\d{1,2})(?![\\d.,])`), (_, a, b) => `${a} ${b}`],
];

/** Okunacak metin: kısaltmalar ve işaretler Türkçe söylenişe çevrilir. Aynı metne iki kez uygulanabilir. */
export function speechText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [pattern, fn] of RULES) out = out.replace(pattern, fn);
  return out.replace(/[ \t]{2,}/g, ' ');
}
