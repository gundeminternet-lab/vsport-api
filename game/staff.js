// Teknik ekip ve oyuncu potansiyeli (saf). Her mevki grubunun kendi antrenörü vardır: o gruptaki oyuncuların
// antrenmandan aldığı gelişim puanı artar ve gelişim sınırı yükselir. Kondisyoner günlük antrenman hakkını, altyapı
// gözlemcisi genç oyuncuların potansiyelini artırır. Antrenörler kredi ile işe alınır ve geliştirilir (0-5. seviye).
// Uygulamadaki lib/game/potential.dart aynı potansiyel formülünü kullanır.

export const STAFF = {
  kl: { id: 'kl', name: 'Kaleci antrenörü', g: 'KL' },
  def: { id: 'def', name: 'Savunma antrenörü', g: 'DEF' },
  os: { id: 'os', name: 'Orta saha antrenörü', g: 'OS' },
  fv: { id: 'fv', name: 'Hücum antrenörü', g: 'FV' },
  fit: { id: 'fit', name: 'Kondisyoner', g: null },
  scout: { id: 'scout', name: 'Altyapı gözlemcisi', g: null },
};
export const STAFF_IDS = Object.keys(STAFF);
export const STAFF_MAX = 5;
export const GROUP_STAFF = { KL: 'kl', DEF: 'def', OS: 'os', FV: 'fv' };

/** Bir sonraki seviyenin bedeli (şimdiki seviye 0-4): 400, 1300, 2590, 4220, 6170 kredi. */
export const staffCost = (level) => Math.round((400 * Math.pow(Number(level) + 1, 1.7)) / 10) * 10;

export function staffLevels(club) {
  return Object.fromEntries(STAFF_IDS.map((id) => [id, Math.max(0, Math.min(STAFF_MAX, Number(club?.staff?.[id] ?? 0)))]));
}

/**
 * Teknik ekibin etkileri. xpPct: grup → antrenman gelişim yüzdesi; capBonus: grup → gelişim sınırına ek;
 * sessions: ek günlük antrenman; scoutPot: gençlerin potansiyeline ek; scoutExtra: taramada ek aday.
 */
export function staffEffects(levels = {}) {
  const lv = (id) => Math.max(0, Math.min(STAFF_MAX, Number(levels[id] ?? 0)));
  const xpPct = {};
  const capBonus = {};
  for (const [g, id] of Object.entries(GROUP_STAFF)) {
    xpPct[g] = lv(id) * 15;
    capBonus[g] = Math.floor(lv(id) / 2) + (lv(id) === STAFF_MAX ? 1 : 0);
  }
  return { xpPct, capBonus, sessions: Math.floor(lv('fit') / 2), scoutPot: lv('scout') * 3, scoutExtra: lv('scout') >= 3 ? 1 : 0 };
}

/** Bir seviyedeki etkinin kısa metni. */
export function staffText(id, level) {
  const e = staffEffects({ [id]: level });
  if (level <= 0) return 'İşe alınmadı';
  const g = STAFF[id].g;
  if (g) return `Gelişim +%${e.xpPct[g]} · sınır +${e.capBonus[g]}`;
  if (id === 'fit') return e.sessions ? `Günde +${e.sessions} antrenman` : 'Antrenman sonrası toparlanma';
  return `Genç potansiyeli +${e.scoutPot}${e.scoutExtra ? ' · taramada +1 aday' : ''}`;
}

/** 31 bitlik sabit dizgi özeti (uygulamadaki potential.dart ile aynı). */
export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h;
}

/**
 * Oyuncunun potansiyeli: antrenmanla çıkabileceği en yüksek güç. Kartta yazılıysa o; değilse yaşa göre (genç oyuncu
 * daha çok gelişir) ve oyuncuya özgü sabit bir payla. En çok 95.
 */
export function potentialOf(card) {
  const r = Number(card?.r ?? 50);
  const pot = Number(card?.pot);
  if (Number.isFinite(pot) && pot > 0) return Math.max(r, Math.min(99, pot));
  const base = Number(card?.dev?.base ?? r);
  const a = Number(card?.a);
  const [lo, span] = !Number.isFinite(a) || a <= 0 ? [2, 7] : a <= 20 ? [8, 9] : a <= 23 ? [5, 6] : a <= 27 ? [2, 5] : a <= 30 ? [1, 3] : [0, 2];
  const h = hashStr(String(card?.pid ?? card?.id ?? card?.n ?? ''));
  return Math.max(r, Math.min(95, base + lo + (h % span)));
}
