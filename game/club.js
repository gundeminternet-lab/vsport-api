// Benim 11'im kulübü: kadro kurmadan önce kulüp kurulur (ad, kısaltma, arma, taraftar grubu). Kulübün dört tesisi
// vardır ve krediyle süreli olarak yükseltilir (aynı anda tek inşaat). Antrenman sahasında oyuncular geliştirilir.
// Krediler yalnızca oyunlarla kazanılır; burada harcanır (taraftar mağazasının günlük geliri de oyun içi kazançtır).
//
//   game_profiles/{uid}.club   { name, short, fans, crest: { shape, primary, secondary, symbol, pattern }, foundedAt,
//                                kits: { home, away, gk } (her biri { pattern, shirt, second, shorts, socks }),
//                                levels: { stadium, training, academy, fanshop, parking, food, megastore }, build: { facility, to, startedAt, endsAt } | null,
//                                shopDay }
//   Kulüp kimliği (ad, kısaltma, arma, taraftar grubu, formalar) kuruluşta belirlenir ve sonra değişmez.
//   club_names/{ad}            { uid }   kulüp adı tekil
//   game_profiles/{uid}/cards/{id}.dev   { xp, plus, base }   oyuncu gelişimi (puan kazandıkça r ve özellikler artar)
//   game_profiles/{uid}/daily/{gün}.training   o gün yapılan antrenman sayısı
//   club.staff   { kl, def, os, fv, fit, scout }   teknik ekip seviyeleri (0-5; staff.js)
//   Antrenmanda oyuncu potansiyelini (staff.js → potentialOf) aşamaz; grubun antrenörü gelişimi ve sınırı artırır.

import { AppError } from '../errors.js';
import { geneticsView, trainFactor, traitStats } from './genetics.js';
import { trDay } from '../progress.js';
import { tierOf } from './pool.js';
import { slotsOf, teamPower, validateSquad } from './squad.js';
import { GROUP_STAFF, STAFF, STAFF_IDS, STAFF_MAX, potentialOf, staffCost, staffEffects, staffLevels, staffText } from './staff.js';

export const CLUB = {
  nameMin: 3,
  nameMax: 22,
  fansMin: 3,
  fansMax: 26,
  shapes: 6,
  colors: 14,
  symbols: 16,
  patterns: 5,
  /** Forma desenleri: düz, dikey çizgili, yarım, yatay çizgili, çapraz kuşak (uygulamadaki KitPattern sırası). */
  kitPatterns: 5,
  /** Kuruluş hediyesi (kredi). */
  foundingGift: 300,
};

/** Tesisler. base: ilk yükseltmenin temel fiyatı; fiyat seviyeyle artar. */
export const FACILITIES = {
  stadium: { id: 'stadium', name: 'Stadyum', maxLevel: 10, base: 400 },
  training: { id: 'training', name: 'Antrenman Sahası', maxLevel: 10, base: 300 },
  academy: { id: 'academy', name: 'Altyapı Akademisi', maxLevel: 10, base: 350 },
  fanshop: { id: 'fanshop', name: 'Taraftar Mağazası', maxLevel: 10, base: 250 },
  // Maç günü gelirleri (office.js → matchdayIncome): ev maçlarında seyirciden gelir
  parking: { id: 'parking', name: 'Otopark', maxLevel: 10, base: 200 },
  food: { id: 'food', name: 'Yeme-İçme Alanı', maxLevel: 10, base: 220 },
  megastore: { id: 'megastore', name: 'Forma Mağazası', maxLevel: 10, base: 260 },
};
export const FACILITY_IDS = Object.keys(FACILITIES);

/** Bir sonraki seviyeye inşaat süresi (dakika); dizin = şimdiki seviye. */
export const BUILD_MINUTES = [0, 2, 10, 20, 30, 45, 60, 90, 120, 180];

export const upgradeCost = (facility, level) => Math.round((FACILITIES[facility].base * Math.pow(level, 1.45)) / 10) * 10;
export const buildMs = (level) => (BUILD_MINUTES[level] ?? 180) * 60e3;

/** Tesis seviyelerinin etkileri (saf). */
export function effectsOf(levels = {}) {
  const lv = (f) => Math.max(1, Math.min(FACILITIES[f].maxLevel, Number(levels[f] ?? 1)));
  const st = lv('stadium'), tr = lv('training'), ac = lv('academy'), fs = lv('fanshop');
  const pk = lv('parking'), fd = lv('food'), ms = lv('megastore');
  return {
    stadium: { capacity: 5000 + (st - 1) * 6000, incomePct: (st - 1) * 8 },
    training: { sessions: 3 + Math.floor((tr - 1) / 2), xpPct: (tr - 1) * 10 },
    academy: { cap: 3 + ac },
    fanshop: { daily: 40 + (fs - 1) * 30 },
    parking: { spaces: 400 + (pk - 1) * 400 },
    food: { stalls: 4 + (fd - 1) * 3, perHead: Math.round((0.008 + 0.003 * (fd - 1)) * 1000) / 1000 },
    megastore: { sharePct: Math.round((0.4 + 0.15 * (ms - 1)) * 100) / 100 },
  };
}

/** Bir seviyedeki etkinin kısa metni (uygulamada "şimdi → sonraki"). */
export function effectText(facility, level) {
  const e = effectsOf({ [facility]: level })[facility];
  switch (facility) {
    case 'stadium':
      return `${e.capacity.toLocaleString('tr-TR')} kişilik · maç geliri +%${e.incomePct}`;
    case 'training':
      return `Günde ${e.sessions} antrenman · gelişim +%${e.xpPct}`;
    case 'academy':
      return `Oyuncu başına en çok +${e.cap} güç`;
    case 'parking':
      return `${e.spaces.toLocaleString('tr-TR')} araçlık otopark · maç günü geliri`;
    case 'food':
      return `${e.stalls} büfe · seyirci başı harcama artar`;
    case 'megastore':
      return `Seyircinin %${e.sharePct} kadarı forma alır`;
    default:
      return `Günlük ${e.daily} kredi taraftar geliri`;
  }
}

/** Antrenman türleri. stats: geliştirdiği özellik sırası (saha oyuncusu / kaleci), xp: kazanç çarpanı. */
export const DRILLS = {
  fizik: { id: 'fizik', name: 'Fizik', field: [0, 5], keeper: [4, 5], xp: 1.0 },
  teknik: { id: 'teknik', name: 'Teknik', field: [1, 2, 3], keeper: [1, 2], xp: 1.0 },
  taktik: { id: 'taktik', name: 'Taktik', field: [4, 2], keeper: [0, 3], xp: 1.0 },
  mac: { id: 'mac', name: 'Maç provası', field: [0, 1, 2, 3, 4, 5], keeper: [0, 1, 2, 3, 4, 5], xp: 1.3, extraCost: 1.6 },
};

export const TRAIN = { baseXp: 45, baseCost: 25 };

/** Bir güç puanı için gereken gelişim puanı (saf; uygulama da aynı formülü kullanır). */
export const xpNeed = (r) => 120 + 8 * Math.max(0, Number(r) - 55);
export const trainCost = (r, drill = 'fizik') => Math.round((TRAIN.baseCost + 2 * Math.max(0, Number(r) - 60)) * (DRILLS[drill]?.extraCost ?? 1));

/** Kulüp seviyesi: tesislerin toplam yükselişi + 1. */
export const clubLevel = (levels = {}) => 1 + FACILITY_IDS.reduce((a, f) => a + Math.max(0, Number(levels[f] ?? 1) - 1), 0);

/** Taraftar sayısı (görünüm): stadyum, kulüp seviyesi ve galibiyetlerle büyür. */
export const fanCount = (levels, wins = 0) => Math.round(1200 + 0.35 * effectsOf(levels).stadium.capacity + 25 * wins + 200 * clubLevel(levels));

// ---- Ad denetimi ----------------------------------------------------------------------------------------------

const BANNED = ['amk', 'aq', 'orospu', 'piç', 'sik', 'yarrak', 'göt', 'pezevenk', 'kahpe', 'ibne', 'gavat', 'şerefsiz', 'admin', 'vsport'];
const NAME_RE = /^[\p{L}\p{N} .'&-]+$/u;

export const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const nameKey = (s) =>
  cleanName(s)
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 40);

function checkText(raw, { min, max, what }) {
  const v = cleanName(raw);
  if (v.length < min || v.length > max) throw new AppError('invalid-argument', `${what} ${min}-${max} karakter olmalı.`);
  if (!NAME_RE.test(v)) throw new AppError('invalid-argument', `${what} yalnızca harf, rakam ve boşluk içerebilir.`);
  const low = v.toLocaleLowerCase('tr');
  if (BANNED.some((w) => low.split(/[^\p{L}]+/u).includes(w) || (w.length >= 4 && low.includes(w)))) {
    throw new AppError('invalid-argument', `Bu ${what.toLocaleLowerCase('tr')} kullanılamaz.`);
  }
  return v;
}

/** Kısaltma: 2-4 büyük harf; verilmezse addan üretilir. */
export function shortOf(name, given = null) {
  const up = (s) => s.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
  const pick = (s) => up(String(s ?? '').replace(/[^\p{L}]/gu, ''));
  if (given) {
    const g = pick(given);
    if (g.length >= 2 && g.length <= 4) return g;
  }
  const words = cleanName(name).split(' ').filter(Boolean);
  const initials = pick(words.map((w) => w[0]).join(''));
  if (initials.length >= 3) return initials.slice(0, 3);
  return pick(cleanName(name)).slice(0, 3).padEnd(3, 'X');
}

function checkCrest(c) {
  const n = (v, max) => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0 || x >= max) throw new AppError('invalid-argument', 'Geçersiz arma.');
    return x;
  };
  const crest = {
    shape: n(c?.shape ?? 0, CLUB.shapes),
    primary: n(c?.primary ?? 0, CLUB.colors),
    secondary: n(c?.secondary ?? 1, CLUB.colors),
    symbol: n(c?.symbol ?? 0, CLUB.symbols),
    pattern: n(c?.pattern ?? 0, CLUB.patterns),
  };
  if (crest.primary === crest.secondary) throw new AppError('invalid-argument', 'Armanın iki rengi farklı olmalı.');
  return crest;
}

// ---- Formalar ---------------------------------------------------------------------------------------------------

const WHITE = 4;
const BLACK = 5;
/** Arma deseni → forma deseni (düz, dikey, yatay şerit → yatay çizgili, çapraz kuşak, iki renk → yarım). */
const CREST_TO_KIT = [0, 1, 3, 4, 2];
/** Kaleci forması için ayrışan renkler: mor, turuncu, yeşil, açık mavi, sarı, koyu yeşil, siyah. */
const GK_COLORS = [9, 8, 3, 12, 2, 13, 5];

function checkKit(k, what) {
  const n = (v, max) => {
    const x = Number(v);
    if (!Number.isInteger(x) || x < 0 || x >= max) throw new AppError('invalid-argument', `Geçersiz ${what}.`);
    return x;
  };
  const kit = { pattern: n(k?.pattern ?? 0, CLUB.kitPatterns), shirt: n(k?.shirt, CLUB.colors), second: n(k?.second, CLUB.colors), shorts: n(k?.shorts, CLUB.colors), socks: n(k?.socks, CLUB.colors) };
  if (kit.pattern !== 0 && kit.shirt === kit.second) throw new AppError('invalid-argument', `${what[0].toLocaleUpperCase('tr')}${what.slice(1)}: desenin iki rengi farklı olmalı.`);
  return kit;
}

/** Ev sahibi, deplasman ve kaleci formaları (kuruluşta). */
export function checkKits(raw) {
  if (!raw || typeof raw !== 'object') throw new AppError('invalid-argument', 'Kulübünün formalarını seç.');
  const home = checkKit(raw.home, 'ev sahibi forması');
  const away = checkKit(raw.away, 'deplasman forması');
  const gk = checkKit(raw.gk, 'kaleci forması');
  if (home.shirt === away.shirt) throw new AppError('invalid-argument', 'Ev sahibi ve deplasman formalarının ana rengi farklı olmalı.');
  if (gk.shirt === home.shirt || gk.shirt === away.shirt) throw new AppError('invalid-argument', 'Kaleci forması takım formalarından farklı renkte olmalı.');
  return { home, away, gk };
}

/** Armadan türetilen formalar (formasız eski kulüpler ve rakip takımlar için). */
export function defaultKits(crest) {
  const p = Number(crest?.primary ?? 0);
  const s0 = Number(crest?.secondary ?? WHITE);
  const sec = s0 === p ? (p === WHITE ? BLACK : WHITE) : s0;
  const home = { pattern: CREST_TO_KIT[Number(crest?.pattern ?? 0)] ?? 0, shirt: p, second: sec, shorts: p, socks: p };
  const away = { pattern: 0, shirt: sec, second: p, shorts: sec, socks: sec };
  const g = GK_COLORS.find((c) => c !== home.shirt && c !== away.shirt && c !== home.second) ?? 9;
  const gk = { pattern: 0, shirt: g, second: g === BLACK ? WHITE : BLACK, shorts: g, socks: g };
  return { home, away, gk };
}

/** Rastgele arma (karma takımlar ve günün rakibi için; rng: createRng). */
export function randomCrest(rng) {
  const primary = rng.int(0, CLUB.colors - 1);
  const secondary = (primary + 1 + rng.int(0, CLUB.colors - 2)) % CLUB.colors;
  return { shape: rng.int(0, CLUB.shapes - 1), primary, secondary, symbol: rng.int(0, CLUB.symbols - 1), pattern: rng.int(0, CLUB.patterns - 1) };
}

/** Kulübün formaları; kuruluşta seçilmemişse armadan. */
export const kitsOf = (club) => (club?.kits?.home ? club.kits : club?.crest ? defaultKits(club.crest) : null);

// ---- Servis ---------------------------------------------------------------------------------------------------

/**
 * Kulüp işlemleri. game: GameService (profil, kredi ve günlük kayıt için). store: oyun deposu; ek olarak
 * claimClubName(key, uid) → bool, updateCard(uid, id, patch).
 */
export class ClubService {
  constructor({ game }) {
    this.game = game;
  }

  get store() {
    return this.game.store;
  }

  now() {
    return this.game.now();
  }

  /** Bitmiş inşaatı seviyeye işler (profil okunduktan sonra çağrılır). Döner: güncel kulüp. */
  async settle(uid, p) {
    const c = p.club;
    if (!c?.build || Number(c.build.endsAt) > this.now()) return c ?? null;
    const levels = { ...c.levels, [c.build.facility]: Number(c.build.to) };
    const club = { ...c, levels, build: null };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return club;
  }

  /** Uygulamaya giden kulüp görünümü (saf; settle'dan sonra). */
  view(c, { trainingToday = 0, wins = 0 } = {}) {
    if (!c) return null;
    const now = this.now();
    const levels = Object.fromEntries(FACILITY_IDS.map((f) => [f, Number(c.levels?.[f] ?? 1)]));
    const eff = effectsOf(levels);
    const staff = staffLevels(c);
    const se = staffEffects(staff);
    const sessions = eff.training.sessions + se.sessions;
    const today = trDay(now);
    return {
      name: c.name,
      short: c.short,
      fans: c.fans,
      crest: c.crest,
      kits: kitsOf(c),
      // Eski kulüplerde formalar bir kez seçilebilir
      kitsChosen: Boolean(c.kits?.home),
      venue: `${c.name} Stadyumu`,
      foundedAt: c.foundedAt ? new Date(c.foundedAt).toISOString() : null,
      level: clubLevel(levels),
      supporters: fanCount(levels, wins),
      build: c.build ? { facility: c.build.facility, to: c.build.to, startedAt: new Date(c.build.startedAt).toISOString(), endsAt: new Date(c.build.endsAt).toISOString() } : null,
      facilities: FACILITY_IDS.map((f) => {
        const lvl = levels[f];
        const max = FACILITIES[f].maxLevel;
        return {
          id: f,
          name: FACILITIES[f].name,
          level: lvl,
          maxLevel: max,
          effect: effectText(f, lvl),
          next: lvl < max ? effectText(f, lvl + 1) : null,
          cost: lvl < max ? upgradeCost(f, lvl) : null,
          minutes: lvl < max ? BUILD_MINUTES[lvl] ?? 180 : null,
        };
      }),
      training: {
        left: Math.max(0, sessions - trainingToday),
        daily: sessions,
        xpPct: eff.training.xpPct,
        cap: eff.academy.cap,
        // Mevki grubuna göre: antrenörün ek gelişim yüzdesi ve gelişim sınırı
        groupXpPct: se.xpPct,
        groupCap: Object.fromEntries(Object.keys(GROUP_STAFF).map((g) => [g, eff.academy.cap + se.capBonus[g]])),
        baseXp: TRAIN.baseXp,
        drills: Object.values(DRILLS).map((d) => ({ id: d.id, name: d.name, xp: d.xp, extraCost: d.extraCost ?? 1 })),
      },
      staff: STAFF_IDS.map((id) => ({
        id,
        name: STAFF[id].name,
        group: STAFF[id].g,
        level: staff[id],
        maxLevel: STAFF_MAX,
        effect: staffText(id, staff[id]),
        next: staff[id] < STAFF_MAX ? staffText(id, staff[id] + 1) : null,
        cost: staff[id] < STAFF_MAX ? staffCost(staff[id]) : null,
      })),
      shop: { daily: eff.fanshop.daily, ready: c.shopDay !== today },
      incomePct: eff.stadium.incomePct,
    };
  }

  async _club(uid, guest) {
    this.game._member(uid, guest);
    const p = await this.game._profile(uid);
    if (!p.club) throw new AppError('failed-precondition', 'Önce kulübünü kur.');
    await this.settle(uid, p);
    return p;
  }

  async _view(uid, p) {
    const daily = await this.store.getDaily(uid, trDay(this.now()));
    return this.view(p.club, { trainingToday: Number(daily?.training ?? 0), wins: Number(p.duelTotals?.w ?? 0) });
  }

  /** Kulüp kur: ad (tekil), kısaltma, taraftar grubu, arma, formalar. Bir kez kurulur ve değişmez; kuruluş hediyesi verilir. */
  async create({ uid, guest = false, name, short = null, fans, crest, kits = null }) {
    this.game._member(uid, guest);
    const p = await this.game._profile(uid);
    if (p.club) throw new AppError('failed-precondition', 'Kulübün zaten kurulu.');
    const n = checkText(name, { min: CLUB.nameMin, max: CLUB.nameMax, what: 'Kulüp adı' });
    const f = checkText(fans, { min: CLUB.fansMin, max: CLUB.fansMax, what: 'Taraftar grubu adı' });
    const c = checkCrest(crest);
    // Formalar seçilmediyse (eski uygulama) armadan türetilir
    const k = kits ? checkKits(kits) : defaultKits(c);
    const key = nameKey(n);
    if (key.length < 3) throw new AppError('invalid-argument', 'Kulüp adı en az 3 harf içermeli.');
    const ok = await this.store.claimClubName(key, uid);
    if (!ok) throw new AppError('failed-precondition', 'Bu kulüp adı alınmış; başka bir ad dene.');
    const club = {
      name: n,
      short: shortOf(n, short),
      fans: f,
      crest: c,
      kits: k,
      foundedAt: this.now(),
      levels: Object.fromEntries(FACILITY_IDS.map((x) => [x, 1])),
      build: null,
      shopDay: null,
    };
    await this.store.updateProfile(uid, { club });
    const balance = await this.game._earn(uid, p, CLUB.foundingGift, await this.game._pro(uid));
    p.club = club;
    return { club: await this._view(uid, p), gift: CLUB.foundingGift, balance };
  }

  /** Kulüp kimliği kuruluştan sonra değişmez (ad, arma, taraftar grubu, formalar). */
  async edit({ uid, guest = false }) {
    await this._club(uid, guest);
    throw new AppError('failed-precondition', 'Kulüp adı, arması ve formaları kuruluştan sonra değiştirilemez.');
  }

  /** Formalar seçilmeden kurulmuş (eski) kulüpler formalarını bir kez seçer. */
  async setKits({ uid, guest = false, kits }) {
    const p = await this._club(uid, guest);
    if (p.club.kits?.home) throw new AppError('failed-precondition', 'Formalar kuruluşta seçildi; değiştirilemez.');
    const club = { ...p.club, kits: checkKits(kits) };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return { club: await this._view(uid, p) };
  }

  async get({ uid, guest = false }) {
    const p = await this._club(uid, guest);
    return { club: await this._view(uid, p), credits: Number(p.credits ?? 0) };
  }

  /** Tesis yükselt: kredi düşer, inşaat süresi başlar. Aynı anda tek inşaat. */
  async upgrade({ uid, guest = false, facility }) {
    if (!FACILITIES[facility]) throw new AppError('invalid-argument', 'Geçersiz tesis.');
    const p = await this._club(uid, guest);
    const c = p.club;
    if (c.build) throw new AppError('failed-precondition', `${FACILITIES[c.build.facility].name} inşaatı sürüyor; bitince yeni inşaat başlar.`);
    const lvl = Number(c.levels?.[facility] ?? 1);
    if (lvl >= FACILITIES[facility].maxLevel) throw new AppError('failed-precondition', 'Bu tesis en üst seviyede.');
    const cost = upgradeCost(facility, lvl);
    const balance = await this.store.changeCredits(uid, -cost, { earn: false });
    const now = this.now();
    const club = { ...c, build: { facility, to: lvl + 1, startedAt: now, endsAt: now + buildMs(lvl) } };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return { club: await this._view(uid, p), cost, balance };
  }

  /** Taraftar mağazasının günlük geliri (günde bir kez). */
  async collect({ uid, guest = false }) {
    const p = await this._club(uid, guest);
    const today = trDay(this.now());
    if (p.club.shopDay === today) throw new AppError('failed-precondition', 'Bugünün taraftar geliri alındı; yarın yine gel.');
    const amount = effectsOf(p.club.levels).fanshop.daily;
    const club = { ...p.club, shopDay: today };
    await this.store.updateProfile(uid, { club });
    const balance = await this.game._earn(uid, p, amount, await this.game._pro(uid));
    p.club = club;
    return { club: await this._view(uid, p), amount, balance };
  }

  /**
   * Antrenman: bir oyuncu, bir antrenman türü. Gelişim puanı birikir; eşik aşılınca oyuncunun gücü 1 artar
   * (akademinin izin verdiği sınıra kadar) ve antrenman türünün özellikleri yükselir.
   */
  async train({ uid, guest = false, cardId, drill = 'fizik' }) {
    const d = DRILLS[drill];
    if (!d) throw new AppError('invalid-argument', 'Geçersiz antrenman.');
    if (typeof cardId !== 'string' || !cardId) throw new AppError('invalid-argument', 'Oyuncu seç.');
    const p = await this._club(uid, guest);
    const day = trDay(this.now());
    const [daily, cards] = await Promise.all([this.store.getDaily(uid, day), this.store.listCards(uid)]);
    const eff = effectsOf(p.club.levels);
    const se = staffEffects(staffLevels(p.club));
    const sessions = eff.training.sessions + se.sessions;
    const used = Number(daily?.training ?? 0);
    if (used >= sessions) throw new AppError('resource-exhausted', `Bugünkü ${sessions} antrenman hakkın bitti; Antrenman Sahası'nı ya da kondisyoneri geliştirerek hak artar.`);
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new AppError('not-found', 'Oyuncu bulunamadı.');
    const dev = { xp: Number(card.dev?.xp ?? 0), plus: Number(card.dev?.plus ?? 0), base: Number(card.dev?.base ?? card.r) };
    // Gelişim sınırı: akademi + mevki grubunun antrenörü; oyuncu potansiyelini aşamaz
    const cap = eff.academy.cap + (se.capBonus[card.g] ?? 0);
    const pot = potentialOf(card);
    if (card.r >= pot) throw new AppError('failed-precondition', `${card.s ?? card.n} potansiyeline ulaştı (${pot}).`);
    if (dev.plus >= cap || card.r >= 99) {
      throw new AppError('failed-precondition', `${card.s ?? card.n} gelişim sınırında (+${cap}); Altyapı Akademisi'ni ya da ${STAFF[GROUP_STAFF[card.g] ?? 'os'].name.toLocaleLowerCase('tr')}nü geliştirerek sınır yükselir.`);
    }
    const cost = trainCost(card.r, drill);
    const balance = await this.store.changeCredits(uid, -cost, { earn: false });
    await this.store.incrementDaily(uid, day, 'training', 1);
    // Genetik: gelişim hızı × yaş × (antrenman doğuştan yeteneğe uyuyorsa +%10)
    const tf = trainFactor(card, card.g === 'KL' ? d.keeper : d.field);
    const gain = Math.round(TRAIN.baseXp * d.xp * (1 + (eff.training.xpPct + (se.xpPct[card.g] ?? 0)) / 100) * tf.k);
    let xp = dev.xp + gain;
    let r = Number(card.r);
    let plus = dev.plus;
    const st = Array.isArray(card.st) ? [...card.st] : [];
    const raised = [];
    while (xp >= xpNeed(r) && plus < cap && r < 99 && r < pot) {
      xp -= xpNeed(r);
      r++;
      plus++;
      for (const i of card.g === 'KL' ? d.keeper : d.field) {
        if (i < st.length) st[i] = Math.min(99, Number(st[i]) + 1);
      }
      // Doğuştan yetenek: ilgili özellik her seviyede fazladan +1
      for (const i of traitStats(card, tf.gen)) {
        if (i < st.length) st[i] = Math.min(99, Number(st[i]) + 1);
      }
      raised.push(r);
    }
    if (plus >= cap || r >= pot) xp = 0;
    const patch = { r, st, tier: tierOf(r), pot, dev: { xp, plus, base: dev.base } };
    await this.store.updateCard(uid, cardId, patch);
    // Güç arttıysa oyuncunun bulunduğu kadroların gücü yenilenir
    if (raised.length) await this._refreshSquads(uid, p, cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)));
    return {
      card: { id: cardId, r, st, tier: tierOf(r), pot, dev: patch.dev, need: xpNeed(r) },
      gain,
      // Genetik etkisi (uygulama kart üstünde gösterir)
      genetics: { ...geneticsView(card), factor: tf.k, fits: tf.fits, age: tf.age.text },
      levelUp: raised.length,
      cost,
      balance,
      left: Math.max(0, sessions - used - 1),
    };
  }

  /** Teknik ekip: bir antrenörü işe al ya da bir seviye geliştir (kredi düşer, hemen etkili). */
  async hireStaff({ uid, guest = false, staff }) {
    if (!STAFF[staff]) throw new AppError('invalid-argument', 'Geçersiz antrenör.');
    const p = await this._club(uid, guest);
    const levels = staffLevels(p.club);
    const lvl = levels[staff];
    if (lvl >= STAFF_MAX) throw new AppError('failed-precondition', `${STAFF[staff].name} en üst seviyede.`);
    const cost = staffCost(lvl);
    const balance = await this.store.changeCredits(uid, -cost, { earn: false });
    const club = { ...p.club, staff: { ...levels, [staff]: lvl + 1 } };
    await this.store.updateProfile(uid, { club });
    p.club = club;
    return { club: await this._view(uid, p), staff, level: lvl + 1, cost, balance };
  }

  async _refreshSquads(uid, p, cards) {
    const owned = new Map(cards.map((c) => [c.id, c]));
    const squads = await this.store.listSquads(uid);
    for (const s of squads) {
      const v = validateSquad(s, owned);
      if (!v.ok) continue;
      const clean = Object.fromEntries(slotsOf(s.formation).map((x) => [x.key, s.slots[x.key]]));
      await this.store.saveSquad(uid, s.id, {
        name: s.name,
        formation: s.formation,
        slots: clean,
        chemistry: v.ev.chemistry,
        rating: v.ev.rating,
        power: Math.round(teamPower(v.ev) * 10) / 10,
        ...(s.plan ? { plan: s.plan } : {}),
      });
    }
    await this.game._duelSummary(uid, p, await this.store.listSquads(uid), cards).catch(() => {});
  }
}
