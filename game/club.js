// Benim 11'im kulübü: kadro kurmadan önce kulüp kurulur (ad, kısaltma, arma, taraftar grubu). Kulübün dört tesisi
// vardır ve krediyle süreli olarak yükseltilir (aynı anda tek inşaat). Antrenman sahasında oyuncular geliştirilir.
// Krediler yalnızca oyunlarla kazanılır; burada harcanır (taraftar mağazasının günlük geliri de oyun içi kazançtır).
//
//   game_profiles/{uid}.club   { name, short, fans, crest: { shape, primary, secondary, symbol, pattern }, foundedAt,
//                                levels: { stadium, training, academy, fanshop }, build: { facility, to, startedAt, endsAt } | null,
//                                shopDay }
//   club_names/{ad}            { uid }   kulüp adı tekil
//   game_profiles/{uid}/cards/{id}.dev   { xp, plus, base }   oyuncu gelişimi (puan kazandıkça r ve özellikler artar)
//   game_profiles/{uid}/daily/{gün}.training   o gün yapılan antrenman sayısı

import { AppError } from '../errors.js';
import { trDay } from '../progress.js';
import { tierOf } from './pool.js';
import { slotsOf, teamPower, validateSquad } from './squad.js';

export const CLUB = {
  nameMin: 3,
  nameMax: 22,
  fansMin: 3,
  fansMax: 26,
  shapes: 6,
  colors: 14,
  symbols: 16,
  patterns: 5,
  /** Kuruluş hediyesi (kredi). */
  foundingGift: 300,
};

/** Tesisler. base: ilk yükseltmenin temel fiyatı; fiyat seviyeyle artar. */
export const FACILITIES = {
  stadium: { id: 'stadium', name: 'Stadyum', maxLevel: 10, base: 400 },
  training: { id: 'training', name: 'Antrenman Sahası', maxLevel: 10, base: 300 },
  academy: { id: 'academy', name: 'Altyapı Akademisi', maxLevel: 10, base: 350 },
  fanshop: { id: 'fanshop', name: 'Taraftar Mağazası', maxLevel: 10, base: 250 },
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
  return {
    stadium: { capacity: 5000 + (st - 1) * 6000, incomePct: (st - 1) * 8 },
    training: { sessions: 3 + Math.floor((tr - 1) / 2), xpPct: (tr - 1) * 10 },
    academy: { cap: 3 + ac },
    fanshop: { daily: 40 + (fs - 1) * 30 },
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
    const today = trDay(now);
    return {
      name: c.name,
      short: c.short,
      fans: c.fans,
      crest: c.crest,
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
        left: Math.max(0, eff.training.sessions - trainingToday),
        daily: eff.training.sessions,
        xpPct: eff.training.xpPct,
        cap: eff.academy.cap,
        baseXp: TRAIN.baseXp,
        drills: Object.values(DRILLS).map((d) => ({ id: d.id, name: d.name, xp: d.xp, extraCost: d.extraCost ?? 1 })),
      },
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

  /** Kulüp kur: ad (tekil), kısaltma, taraftar grubu, arma. Bir kez kurulur; kuruluş hediyesi verilir. */
  async create({ uid, guest = false, name, short = null, fans, crest }) {
    this.game._member(uid, guest);
    const p = await this.game._profile(uid);
    if (p.club) throw new AppError('failed-precondition', 'Kulübün zaten kurulu.');
    const n = checkText(name, { min: CLUB.nameMin, max: CLUB.nameMax, what: 'Kulüp adı' });
    const f = checkText(fans, { min: CLUB.fansMin, max: CLUB.fansMax, what: 'Taraftar grubu adı' });
    const c = checkCrest(crest);
    const key = nameKey(n);
    if (key.length < 3) throw new AppError('invalid-argument', 'Kulüp adı en az 3 harf içermeli.');
    const ok = await this.store.claimClubName(key, uid);
    if (!ok) throw new AppError('failed-precondition', 'Bu kulüp adı alınmış; başka bir ad dene.');
    const club = {
      name: n,
      short: shortOf(n, short),
      fans: f,
      crest: c,
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

  /** Arma ve taraftar grubu değiştirilebilir (kulüp adı kalıcıdır). */
  async edit({ uid, guest = false, fans = null, crest = null, short = null }) {
    const p = await this._club(uid, guest);
    const club = { ...p.club };
    if (fans != null) club.fans = checkText(fans, { min: CLUB.fansMin, max: CLUB.fansMax, what: 'Taraftar grubu adı' });
    if (crest != null) club.crest = checkCrest(crest);
    if (short != null) club.short = shortOf(club.name, short);
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
    const used = Number(daily?.training ?? 0);
    if (used >= eff.training.sessions) throw new AppError('resource-exhausted', `Bugünkü ${eff.training.sessions} antrenman hakkın bitti; Antrenman Sahası'nı geliştirerek hak artar.`);
    const card = cards.find((c) => c.id === cardId);
    if (!card) throw new AppError('not-found', 'Oyuncu bulunamadı.');
    const dev = { xp: Number(card.dev?.xp ?? 0), plus: Number(card.dev?.plus ?? 0), base: Number(card.dev?.base ?? card.r) };
    if (dev.plus >= eff.academy.cap || card.r >= 99) {
      throw new AppError('failed-precondition', `${card.s ?? card.n} gelişim sınırında (+${eff.academy.cap}); Altyapı Akademisi'ni geliştirerek sınır yükselir.`);
    }
    const cost = trainCost(card.r, drill);
    const balance = await this.store.changeCredits(uid, -cost, { earn: false });
    await this.store.incrementDaily(uid, day, 'training', 1);
    const gain = Math.round(TRAIN.baseXp * d.xp * (1 + eff.training.xpPct / 100));
    let xp = dev.xp + gain;
    let r = Number(card.r);
    let plus = dev.plus;
    const st = Array.isArray(card.st) ? [...card.st] : [];
    const raised = [];
    while (xp >= xpNeed(r) && plus < eff.academy.cap && r < 99) {
      xp -= xpNeed(r);
      r++;
      plus++;
      for (const i of card.g === 'KL' ? d.keeper : d.field) {
        if (i < st.length) st[i] = Math.min(99, Number(st[i]) + 1);
      }
      raised.push(r);
    }
    if (plus >= eff.academy.cap) xp = 0;
    const patch = { r, st, tier: tierOf(r), dev: { xp, plus, base: dev.base } };
    await this.store.updateCard(uid, cardId, patch);
    // Güç arttıysa oyuncunun bulunduğu kadroların gücü yenilenir
    if (raised.length) await this._refreshSquads(uid, p, cards.map((c) => (c.id === cardId ? { ...c, ...patch } : c)));
    return {
      card: { id: cardId, r, st, tier: tierOf(r), dev: patch.dev, need: xpNeed(r) },
      gain,
      levelUp: raised.length,
      cost,
      balance,
      left: Math.max(0, eff.training.sessions - used - 1),
    };
  }

  async _refreshSquads(uid, p, cards) {
    const owned = new Map(cards.map((c) => [c.id, c]));
    const squads = await this.store.listSquads(uid);
    for (const s of squads) {
      const v = validateSquad(s, owned);
      if (!v.ok) continue;
      const clean = Object.fromEntries(slotsOf(s.formation).map((x) => [x.key, s.slots[x.key]]));
      await this.store.saveSquad(uid, s.id, { name: s.name, formation: s.formation, slots: clean, chemistry: v.ev.chemistry, rating: v.ev.rating, power: Math.round(teamPower(v.ev) * 10) / 10 });
    }
    await this.game._duelSummary(uid, p, await this.store.listSquads(uid), cards).catch(() => {});
  }
}
