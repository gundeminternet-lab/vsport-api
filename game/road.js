// Sezon Yolu, menajer takvimi, özel haftalar ve galibiyet serisi (saf kurallar; servis uygular).
//
// Sezon Yolu: 28 günlük sezonlar. Maç, galibiyet, antrenman, paket, takas, doğru tahmin ve günlük giriş XP verir;
// her 300 XP bir kademe (30 kademe). Her kademede ücretsiz yol ödülü, PRO abonelere ek PRO yol ödülü. Kademe atlayınca
// bedava enerji. Ödüller: oyun kredisi, enerji, paket jetonu (paketi kredisiz açar). Kredi satın alınmaz.

const DAY = 86400e3;
const EPOCH = Date.UTC(2026, 0, 5); // Pazartesi

export const ROAD = {
  days: 28,
  tiers: 30,
  xpPerTier: 300,
  xp: { match: 40, win: 30, train: 15, pack: 10, mission: 20, login: 25, exchange: 40, prediction: 10, album: 30 },
  /** Kademe atlayınca bedava enerji (depoyu aşabilir, sınır 200). */
  levelEnergy: 30,
};

/** Kademe ödülleri (saf, sabit). type: credits | energy | token */
export function roadReward(tier, track) {
  const t = Number(tier);
  if (track === 'pro') {
    if (t === ROAD.tiers) return { type: 'token', pack: 'vsport', amount: 1 };
    if (t % 10 === 0) return { type: 'token', pack: 'altin', amount: 1 };
    if (t % 5 === 0) return { type: 'token', pack: 'genc', amount: 1 };
    if (t % 3 === 0) return { type: 'energy', amount: 40 };
    if (t % 2 === 0) return { type: 'token', pack: 'gumus', amount: 1 };
    return { type: 'credits', amount: 300 + t * 15 };
  }
  if (t === ROAD.tiers) return { type: 'token', pack: 'altin', amount: 1 };
  if (t % 10 === 0) return { type: 'token', pack: 'gumus', amount: 1 };
  if (t % 5 === 0) return { type: 'token', pack: 'mevki', amount: 1 };
  if (t % 3 === 0) return { type: 'energy', amount: 20 };
  if (t % 4 === 0) return { type: 'token', pack: 'bronz', amount: 1 };
  return { type: 'credits', amount: 120 + t * 8 };
}

export const roadSeasonOf = (now) => Math.floor((now - EPOCH) / (ROAD.days * DAY));
export const roadSeasonEnd = (season) => EPOCH + (season + 1) * ROAD.days * DAY;

/** Sezona göre güncel kayıt (yeni sezon: sıfırdan). */
export function roadState(road, now) {
  const season = roadSeasonOf(now);
  if (!road || Number(road.season) !== season) return { season, xp: 0, claimed: {} };
  return { season, xp: Number(road.xp ?? 0), claimed: road.claimed ?? {} };
}

export const tierOf = (xp) => Math.min(ROAD.tiers, Math.floor(Number(xp) / ROAD.xpPerTier));

/** XP ekler. Döner: { road, tiersUp } */
export function addRoadXp(road, amount, now) {
  const cur = roadState(road, now);
  const before = tierOf(cur.xp);
  const xp = Math.min(ROAD.tiers * ROAD.xpPerTier, cur.xp + Math.max(0, Math.round(amount)));
  const next = { ...cur, xp };
  return { road: next, tiersUp: tierOf(xp) - before };
}

export function roadView(road, now, pro) {
  const cur = roadState(road, now);
  const tier = tierOf(cur.xp);
  return {
    season: cur.season,
    endsAt: roadSeasonEnd(cur.season),
    xp: cur.xp,
    tier,
    tiers: ROAD.tiers,
    xpPerTier: ROAD.xpPerTier,
    inTier: cur.xp - tier * ROAD.xpPerTier,
    pro,
    levelEnergy: ROAD.levelEnergy,
    xpTable: ROAD.xp,
    rows: Array.from({ length: ROAD.tiers }, (_, i) => {
      const t = i + 1;
      return { tier: t, free: roadReward(t, 'free'), pro: roadReward(t, 'pro'), reached: tier >= t, freeClaimed: cur.claimed?.[`f${t}`] === true, proClaimed: cur.claimed?.[`p${t}`] === true };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Menajer takvimi: 7 günlük giriş ödülü (bir gün kaçarsa baştan). 7. gün sürpriz.
// ---------------------------------------------------------------------------------------------------------------
export const CALENDAR = [
  { type: 'credits', amount: 200 },
  { type: 'energy', amount: 15 },
  { type: 'credits', amount: 400 },
  { type: 'token', pack: 'bronz', amount: 1 },
  { type: 'energy', amount: 30 },
  { type: 'credits', amount: 800 },
  { type: 'mystery' },
];
/** 7. günün sürprizi (tohumla). */
export function mysteryReward(rng) {
  const x = rng.next();
  if (x < 0.15) return { type: 'token', pack: 'altin', amount: 1 };
  if (x < 0.4) return { type: 'credits', amount: 1500 };
  return { type: 'token', pack: 'gumus', amount: 1 };
}
/** Bugün alınacak adım (1-7) ve dün alınmadıysa baştan. */
export function calendarStep(cal, today, yesterday) {
  if (cal?.lastDay === today) return { step: Number(cal.step ?? 0), claimed: true };
  const cont = cal?.lastDay === yesterday && Number(cal.step ?? 0) < CALENDAR.length;
  return { step: cont ? Number(cal.step) + 1 : 1, claimed: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Özel haftalar: her hafta değişen tema.
// ---------------------------------------------------------------------------------------------------------------
export const THEMES = [
  { id: 'gol', name: 'Gol Haftası', desc: 'Lig maçlarında attığın her gol +25 kredi', goalBonus: 25 },
  { id: 'derbi', name: 'Derbi Haftası', desc: 'Maç galibiyetleri %25 fazla kredi', winPct: 25 },
  { id: 'genc', name: 'Gençlik Haftası', desc: 'Genç Yetenek Paketi %20 indirimli, antrenmanda gelişim +%20', packDiscount: { genc: 20 }, trainPct: 20 },
  { id: 'transfer', name: 'Transfer Dönemi', desc: 'Mevki Paketi %20 indirimli, hızlı satış +%25', packDiscount: { mevki: 20 }, sellPct: 25 },
];
export const themeOf = (now) => THEMES[((Math.floor((now - EPOCH) / (7 * DAY)) % THEMES.length) + THEMES.length) % THEMES.length];
export const themeEnds = (now) => EPOCH + (Math.floor((now - EPOCH) / (7 * DAY)) + 1) * 7 * DAY;
export const packCost = (pack, theme) => Math.round((pack.cost * (100 - (theme?.packDiscount?.[pack.id] ?? 0))) / 100 / 10) * 10;

// ---------------------------------------------------------------------------------------------------------------
// Galibiyet serisi: art arda galibiyetler ödülü artırır; belirli serilerde hediye.
// ---------------------------------------------------------------------------------------------------------------
export const WIN_STREAK = {
  pctPerWin: 10,
  maxPct: 50,
  gifts: { 3: { type: 'energy', amount: 15 }, 5: { type: 'token', pack: 'bronz', amount: 1 }, 10: { type: 'token', pack: 'gumus', amount: 1 } },
};
/** Seri yüzdesi (bu galibiyetle n. galibiyet). */
export const streakPct = (n) => Math.min(WIN_STREAK.maxPct, Math.max(0, n - 1) * WIN_STREAK.pctPerWin);
