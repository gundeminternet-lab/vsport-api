// Oyunlar: kredi, günlük bonus yolu, görevler, Fotoğraftan Bil, bilgi yarışması, Benim 11'im (paketler, kadro,
// kapışma) ve kredi liderleri. Bütün sonuçlar sunucuda belirlenir; uygulama yalnızca gösterir.

import { randomInt } from 'node:crypto';

import { AppError } from '../errors.js';
import { periodIds } from '../league.js';
import { trDay } from '../progress.js';
import { createRng } from '../engine/rng.js';
import {
  BONUS_PATH,
  BOSS,
  DUEL,
  LEAGUE_POINTS,
  MAX_SQUADS,
  MISSION_CHEST,
  MISSIONS,
  PACK_ORDER,
  PACKS,
  PITY,
  PHOTO,
  QUIZ,
  SELL_PRICE,
  START_CREDITS,
  STREAK_BONUS,
  TIER_RANGE,
} from './economy.js';
import { REGIONS } from './nations.js';
import { fold, tierOf } from './pool.js';
import { buildQuestions } from './quiz.js';
import { ClubService, defaultKits, effectsOf, kitsOf, randomCrest } from './club.js';
import { autoBuild, evaluate, FORMATIONS, slotsOf, teamPower, validateSquad } from './squad.js';
import { simulateDuel } from './duel.js';
import { adaptTactic, animFormation, compactCard, DUEL_SECONDS, packOf, pickTactic, playDuel, TACTICS } from './match.js';
import { ManagerService, SEASON, checkPlan } from './manager.js';
import { OfficeService } from './office.js';
import { potentialOf } from './staff.js';
import { ENERGY, addEnergy, energyNow, energyPrice, energyView, matchesLeft, spendEnergy } from './energy.js';
import { DIRS, LATE, LATE_MINUTE, momentInputs, momentView, nextMoment, resolvePenalty, syncTime } from './moments.js';
import { awayStadium, homeAdvantage, homeFor, homeStadium } from './venue.js';
import { FOG, maskedGenetics, revealOne } from './fog.js';
import { duoPower, findDuos } from './duos.js';
import { liveCard } from './form.js';
import { ROAD, WIN_STREAK, packCost, streakPct } from './road.js';
import { ProgressionService } from './progression.js';
import { START_DIV } from './divisions.js';

const DAY = 86400e3;

/** Devre arasında bırakılan kapışma bu süreden sonra (ilk yarı taktiğiyle) kendiliğinden biter ve ödülü verilir. */
const PENDING_TTL = 30 * 60e3;

/** Maç türleri: haftalık lig maçı, Günün Meydan Okuması, kariyer ligi. */
const MODES = ['normal', 'boss', 'season', 'friend'];

/** Günün Meydan Okuması dizilişleri (güne göre). */
const BOSS_FORMATIONS = ['4-3-3', '4-2-3-1', '4-4-2', '3-5-2', '4-1-4-1', '3-4-3', '5-3-2'];

const hashOf = (str) => [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Kart olarak saklanan alanlar (havuzdaki kompakt oyuncu + oyuncu kimliği + katman). */
// Havuz boş ya da dar kaldığında rakibin boş yuvaları bu adlarla doldurulur (rakip her zaman 11 kişi çıkar)
const BOT_NAMES = [
  'Kaan Aydın', 'Emre Yıldız', 'Mert Kaya', 'Burak Şahin', 'Can Demir', 'Arda Çelik', 'Oğuz Koç', 'Serkan Polat', 'Umut Arslan',
  'Kerem Doğan', 'Barış Kurt', 'Tolga Özkan', 'Yusuf Aksoy', 'Onur Tekin', 'Eren Güneş', 'Selim Acar', 'Furkan Erdem', 'Cenk Bulut',
];
const shortName = (n) => {
  const parts = n.split(' ');
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : n;
};

/** Eksik yuvaları doldurur: önce havuzdan (genişleyen güç aralığıyla), havuz yetmezse yapay oyuncularla. Saf değil (rng). */
export function fillLineup({ formation, lineup, target, pool, rng, used = new Set() }) {
  const slots = slotsOf(formation) ?? [];
  const out = { ...(lineup ?? {}) };
  for (const c of Object.values(out)) if (c) used.add(c.pid ?? c.id);
  let bot = 0;
  for (const s of slots) {
    if (out[s.key]) continue;
    let pick = null;
    for (const tol of [6, 12, 25, 99]) {
      const list = pool ? pool.pick((p) => p.g === s.g && Math.abs(p.r - target) <= tol && !used.has(p.id), rng, 1) : [];
      if (list.length) {
        pick = asCard(list[0]);
        break;
      }
    }
    if (!pick) {
      const n = BOT_NAMES[(rng.int(0, BOT_NAMES.length - 1) + bot++) % BOT_NAMES.length];
      pick = { pid: `bot-${s.key}-${bot}`, n, s: shortName(n), pos: s.pos, g: s.g, r: Math.max(45, Math.min(92, Math.round(target + rng.int(-3, 3)))), st: null, c: 'Karma Takım', ci: 'karma', cl: null, l: null, na: null, ni: null, ph: null };
      pick.tier = tierOf(pick.r);
    }
    out[s.key] = pick;
    used.add(pick.pid ?? pick.id);
  }
  return out;
}

// Kart: yaş (a) ve potansiyel (pot) menajer modunda gelişim sınırıdır (staff.js → potentialOf)
const asCard = (p) => {
  const c = { pid: p.id, n: p.n, s: p.s, pos: p.pos, g: p.g, r: p.r, st: p.st, c: p.c, ci: p.ci, cl: p.cl ?? null, l: p.l, na: p.na ?? null, ni: p.ni ?? null, ph: p.ph ?? null, tier: tierOf(p.r), a: Number.isFinite(Number(p.a)) && p.a > 0 ? Number(p.a) : null };
  return { ...c, pot: potentialOf(c) };
};

export class GameService {
  /**
   * store: game/store.js   pool: PlayerPool   access: { entitlement(uid) → { subscribed } }
   * random: (seedHint) → rng (test için sabit tohum verilebilir)
   */
  constructor({ store, pool, access = null, now = () => Date.now(), random = null, log = console }) {
    this.store = store;
    this.pool = pool;
    this.access = access;
    this.now = now;
    this.random = random ?? (() => createRng(randomInt(0, 2 ** 31)));
    this.log = log;
    // Kulüp: kuruluş, tesisler, antrenman (club.js)
    this.club = new ClubService({ game: this });
    // Menajer modu: kariyer ligi, altyapı, taktik planı (manager.js)
    this.manager = new ManagerService({ game: this });
    // Kulüp yönetimi: ilişkiler, maç günü gelirleri, olaylar, mesajlar, basın toplantısı (office.js)
    this.office = new OfficeService({ game: this });
    // İlerleme: Sezon Yolu, takvim, özel haftalar, lig kümeleri, albüm, takas, tahmin ödülü (progression.js)
    this.progress = new ProgressionService({ game: this });
    this._quiz = new Map(); // oturum → { uid, day, questions, index, askedAt, score, pro }
  }

  /** Bu haftanın özel teması (road.js THEMES). */
  theme() {
    return this.progress.theme();
  }

  /** Kartların canlı hali: gerçek maçlardaki formuyla güç (form.js). */
  _live(cards) {
    return cards.map((c) => liveCard(c, this.pool));
  }

  _member(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Oyunlar için Google ile giriş yap.');
  }

  /** Kadro, kapışma ve hoşgeldin paketi kulüp ister. */
  _needClub(p) {
    if (!p.club) throw new AppError('failed-precondition', 'Önce kulübünü kur: Benim 11\'im › Kulüp kur.');
  }

  async _pro(uid) {
    if (!this.access) return false;
    try {
      return (await this.access.entitlement(uid)).subscribed === true;
    } catch {
      return false;
    }
  }

  /** Oyun profili; yoksa başlangıç kredisiyle kurulur. Kullanıcı adı ve fotoğraf kullanıcı belgesinden eşitlenir. */
  async _profile(uid) {
    const user = (await this.store.getUser(uid)) ?? {};
    let p = await this.store.getProfile(uid);
    if (!p) {
      p = await this.store.createProfile(uid, {
        credits: START_CREDITS,
        earnedTotal: 0,
        username: user.username ?? null,
        photoURL: user.photoURL ?? null,
        bonus: { step: 0, lastDay: null },
        welcomeDone: false,
        region: null,
        duels: [],
        lastSeenDay: trDay(this.now()),
      });
    } else {
      const patch = {};
      if ((user.username ?? null) !== (p.username ?? null)) patch.username = user.username ?? null;
      if ((user.photoURL ?? null) !== (p.photoURL ?? null)) patch.photoURL = user.photoURL ?? null;
      const today = trDay(this.now());
      if (p.lastSeenDay !== today) patch.lastSeenDay = today;
      if (Object.keys(patch).length) {
        await this.store.updateProfile(uid, patch);
        p = { ...p, ...patch };
      }
    }
    return p;
  }

  _periods() {
    const ids = periodIds(this.now());
    return [`d${trDay(this.now())}`, ids.week, ids.month, 'all'];
  }

  async _earn(uid, profile, amount, pro = false) {
    if (!(amount > 0)) return Number(profile.credits ?? 0);
    return this.store.changeCredits(uid, amount, { periods: this._periods(), user: { username: profile.username, photoURL: profile.photoURL, pro } });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Durum, günlük bonus, görevler
  // ---------------------------------------------------------------------------------------------------------------

  /** Oyunlar ekranının bütün sayıları. */
  async state({ uid, guest = false }) {
    this._member(uid, guest);
    this.pool.ensure?.().catch?.(() => {});
    const day = trDay(this.now());
    let [p, daily, pro] = await Promise.all([this._profile(uid), this.store.getDaily(uid, day), this._pro(uid)]);
    // Devre arasında bırakılıp unutulan kapışma: ilk yarı taktiğiyle biter, ödülü verilir
    if (p.pendingDuel && this.now() - Number(p.pendingDuel.at ?? 0) > PENDING_TTL) {
      try {
        await this._finishDuel(uid, p, p.pendingDuel.id, null);
        [p, daily] = await Promise.all([this._profile(uid), this.store.getDaily(uid, day)]);
      } catch (e) {
        this.log.warn?.('[game] yarım kapışma bitirilemedi', e?.message ?? e);
      }
    }
    // Biten tesis inşaatı seviyeye işlenir
    if (p.club) await this.club.settle(uid, p).catch((e) => this.log.warn?.('[game] inşaat işlenemedi', e?.message ?? e));
    const week = this._week(this.now());
    const board = await this.store.duelBoardEntry(week, uid).catch(() => null);
    // Kapışma Ligi kümesi (yeni haftada geçen hafta sonuçlanır)
    const league = p.club ? await this.progress.league(uid, p).catch((e) => (this.log.warn?.('[game] küme işlenemedi', e?.message ?? e), null)) : null;
    const theme = this.progress.theme();
    const yesterday = trDay(this.now() - DAY);
    const streakAlive = p.streak?.lastDay === day || p.streak?.lastDay === yesterday;
    const allClaimed = MISSIONS.every((m) => daily?.claimed?.[m.id] === true);
    const pd = p.pendingDuel ?? null;
    const bossOf = this._bossInfo(day);
    // Yol: tamamlanan adım sayısı (bu turda). 28. adım alındıktan sonraki gün yol baştan başlar.
    const stepNow = Number(p.bonus?.step ?? 0);
    const claimedToday = p.bonus?.lastDay === day;
    const completed = claimedToday ? stepNow : stepNow % BONUS_PATH.length;
    const nextStep = claimedToday ? null : completed + 1;
    return {
      day,
      credits: Number(p.credits ?? 0),
      earnedTotal: Number(p.earnedTotal ?? 0),
      username: p.username ?? null,
      pro,
      bonus: { completed, claimedToday, nextStep, nextReward: nextStep ? BONUS_PATH[nextStep - 1] : null, path: BONUS_PATH },
      freePack: !daily?.freePack,
      welcome: { done: p.welcomeDone === true, region: p.region ?? null, regions: Object.entries(REGIONS).map(([id, r]) => ({ id, name: r.name, league: r.leagueName, iso: r.iso })) },
      quiz: { left: Math.max(0, QUIZ.dailyPlays - Number(daily?.quiz?.plays ?? 0)), plays: QUIZ.dailyPlays, best: Number(daily?.quiz?.best ?? 0), perCorrect: QUIZ.perCorrect, proBonus: QUIZ.proBonus, seconds: QUIZ.seconds },
      photo: { started: Boolean(daily?.photo?.startedAt), finished: daily?.photo?.finished === true, solved: daily?.photo?.solved === true, reward: Number(daily?.photo?.reward ?? 0), firstReward: PHOTO.firstReward, attempts: PHOTO.attempts },
      // Günlük maç sınırı kaldırıldı: maçlar enerji harcar. left/daily eski uygulama sürümleri için enerjiden hesaplanır.
      duels: { left: matchesLeft(p.energy, this.now(), 'normal'), daily: Math.floor(ENERGY.max / ENERGY.cost.normal), rewards: { win: DUEL.win, draw: DUEL.draw, loss: DUEL.loss }, last: (p.duels ?? []).slice(0, 10) },
      energy: energyView(p.energy, this.now(), daily?.energyBuys ?? 0),
      missions: MISSIONS.map((m) => ({ id: m.id, title: m.title, reward: m.reward, done: m.done(daily), claimed: daily?.claimed?.[m.id] === true })),
      packs: PACK_ORDER.map((id) => PACKS[id]).map((k) => ({
        id: k.id,
        name: k.name,
        cost: packCost(k, theme),
        base: k.cost,
        tokens: Number(p.packTokens?.[k.id] ?? 0),
        count: k.count,
        desc: k.desc,
        daily: k.daily === true,
        guaranteed: k.guaranteed ?? 0,
        // Olasılıklar (arayüzde gösterilir), mevki seçimi, genç paketi kuralları
        odds: k.weights,
        group: k.group === true,
        maxAge: k.maxAge ?? null,
        potGuaranteed: k.potGuaranteed ?? null,
      })),
      // Elit şans sayacı: dolunca sıradaki ücretli pakette elit (85+) garantili
      pity: { value: Number(p.packPity ?? 0), every: PITY.every },
      // İlerleme: Sezon Yolu, menajer takvimi, özel hafta, lig kümesi, galibiyet serisi, takas görevleri
      road: this.progress.roadView(p, pro),
      calendar: this.progress.calendarView(p),
      theme: this.progress.themeView(),
      league,
      winStreak: { count: Number(p.winStreak?.n ?? 0), best: Number(p.winStreak?.best ?? 0), pct: streakPct(Number(p.winStreak?.n ?? 0) + 1), gifts: WIN_STREAK.gifts },
      tokens: p.packTokens ?? {},
      exchanges: this.progress.exchangesView(p),
      duos: (p.duos ?? []).slice(0, 20),
      challenges: (p.challenges ?? []).slice(0, 10),
      formations: FORMATIONS,
      maxSquads: MAX_SQUADS,
      club: this.club.view(p.club ?? null, { trainingToday: Number(daily?.training ?? 0), wins: Number(p.duelTotals?.w ?? 0) }),
      // Kariyer ligi özeti (Benim 11'im menüsü ve maç türü seçimi)
      career: p.club ? this._careerBrief(p, daily) : null,
      // Kulüp yönetimi özeti: ilişkiler, okunmamış mesajlar, yokluklar, bekleyen basın toplantısı
      office: p.club ? this.office.brief(p) : null,
      poolReady: this.pool.ready,
      streak: { count: streakAlive ? Number(p.streak?.count ?? 0) : 0, best: Number(p.streak?.best ?? 0), today: p.streak?.lastDay === day, bonuses: STREAK_BONUS },
      chest: { reward: MISSION_CHEST, ready: allClaimed && daily?.chest !== true, claimed: daily?.chest === true },
      duel: {
        pending: pd ? { duelId: pd.id, mode: pd.mode, at: pd.at, opponent: pd.opp?.name ?? '' } : null,
        boss: { ...bossOf, done: daily?.boss === true, rewards: { win: BOSS.win, draw: BOSS.draw, loss: BOSS.loss } },
        week: { id: week, points: Number(board?.points ?? 0), played: Number(board?.played ?? 0), w: Number(board?.w ?? 0), d: Number(board?.d ?? 0), l: Number(board?.l ?? 0) },
        career: { w: Number(p.duelTotals?.w ?? 0), d: Number(p.duelTotals?.d ?? 0), l: Number(p.duelTotals?.l ?? 0) },
        tactics: Object.values(TACTICS).map((t) => ({ id: t.id, name: t.name })),
        seconds: DUEL_SECONDS,
      },
    };
  }

  _week(ms) {
    return periodIds(ms).week;
  }

  /** Mevcut bütün günlük görevler alındıysa sandık. */
  async claimChest({ uid, guest = false }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const [p, daily] = await Promise.all([this._profile(uid), this.store.getDaily(uid, day)]);
    if (daily?.chest === true) throw new AppError('failed-precondition', 'Bugünün sandığını açtın; yarın yeni görevler!');
    if (!MISSIONS.every((m) => daily?.claimed?.[m.id] === true)) throw new AppError('failed-precondition', 'Sandık için bugünün bütün görevlerini tamamla.');
    await this.store.updateDaily(uid, day, { chest: true });
    const balance = await this._earn(uid, p, MISSION_CHEST, await this._pro(uid));
    return { reward: MISSION_CHEST, balance };
  }

  async claimBonus({ uid, guest = false }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const p = await this._profile(uid);
    if (p.bonus?.lastDay === day) throw new AppError('failed-precondition', 'Bugünün ödülünü zaten topladın; yarın yeni adım seni bekliyor.');
    const step = (Number(p.bonus?.step ?? 0) % BONUS_PATH.length) + 1;
    // Giriş serisi: dün de toplandıysa artar, yoksa 1'den başlar; belirli günlerde ek ödül
    const streak = p.streak?.lastDay === trDay(this.now() - DAY) ? Number(p.streak?.count ?? 0) + 1 : 1;
    const streakBonus = STREAK_BONUS[streak] ?? 0;
    const reward = BONUS_PATH[step - 1] + streakBonus;
    await this.store.updateProfile(uid, { bonus: { step, lastDay: day }, streak: { count: streak, lastDay: day, best: Math.max(streak, Number(p.streak?.best ?? 0)) } });
    await this.store.updateDaily(uid, day, { bonus: true });
    const balance = await this._earn(uid, p, reward, await this._pro(uid));
    return { step, reward, balance, grandFinale: step === BONUS_PATH.length, streak, streakBonus };
  }

  async claimMission({ uid, guest = false, id }) {
    this._member(uid, guest);
    const m = MISSIONS.find((x) => x.id === id);
    if (!m) throw new AppError('invalid-argument', 'Geçersiz görev.');
    const day = trDay(this.now());
    const [p, daily] = await Promise.all([this._profile(uid), this.store.getDaily(uid, day)]);
    if (daily?.claimed?.[id]) throw new AppError('failed-precondition', 'Bu görevin ödülünü aldın.');
    if (!m.done(daily)) throw new AppError('failed-precondition', 'Görev henüz tamamlanmadı.');
    await this.store.updateDaily(uid, day, { claimed: { [id]: true } });
    const balance = await this._earn(uid, p, m.reward, await this._pro(uid));
    return { id, reward: m.reward, balance };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Fotoğraftan Bil
  // ---------------------------------------------------------------------------------------------------------------

  /** Günün oyuncusu (herkes için aynı): ilk soran gün için seçer ve saklar. */
  async _photoPlayer(day) {
    const saved = await this.store.getDay(day);
    const hit = saved?.photo?.pid ? this.pool.byId(saved.photo.pid) ?? saved.photo.player ?? null : null;
    if (hit) return hit;
    await this.pool.ensure?.();
    const rng = createRng(`photo:${day}`);
    const cands = this.pool.all().filter((p) => p.ph && p.r >= 78);
    const list = cands.length >= 10 ? cands : this.pool.all().filter((p) => p.ph);
    if (!list.length) throw new AppError('unavailable', 'Oyuncu listesi hazırlanıyor; birkaç dakika sonra tekrar dene.');
    const p = list[rng.int(0, list.length - 1)];
    await this.store.setDay(day, { photo: { pid: p.id, player: p } });
    return p;
  }

  _photoView(st, player, { reveal = false } = {}) {
    const used = Number(st?.attempts ?? 0);
    return {
      started: Boolean(st?.startedAt),
      finished: st?.finished === true,
      solved: st?.solved === true,
      attemptsLeft: Math.max(0, PHOTO.attempts - used),
      attempts: PHOTO.attempts,
      used,
      // Bulanıklık: her yanlış tahminde azalır (0 = net). Bittiyse net.
      blur: st?.finished ? 0 : Math.max(0, PHOTO.attempts - used) / PHOTO.attempts,
      reward: Number(st?.reward ?? 0),
      potential: Math.max(PHOTO.minReward, PHOTO.firstReward - PHOTO.stepPenalty * used),
      startedAt: st?.startedAt ?? null,
      ms: st?.ms ?? null,
      guesses: st?.guesses ?? [],
      photo: st?.startedAt ? player.ph : null,
      answer: reveal || st?.finished ? { id: player.id, name: player.n, club: player.c } : null,
    };
  }

  async photoState({ uid, guest = false }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const [daily, player] = await Promise.all([this.store.getDaily(uid, day), this._photoPlayer(day)]);
    return { day, ...this._photoView(daily?.photo, player) };
  }

  async photoStart({ uid, guest = false }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const [daily, player] = await Promise.all([this.store.getDaily(uid, day), this._photoPlayer(day)]);
    let st = daily?.photo ?? null;
    if (!st?.startedAt) {
      st = { startedAt: this.now(), attempts: 0, guesses: [], finished: false, solved: false, reward: 0 };
      await this.store.updateDaily(uid, day, { photo: st });
    }
    return { day, ...this._photoView(st, player) };
  }

  async photoGuess({ uid, guest = false, playerId }) {
    this._member(uid, guest);
    if (typeof playerId !== 'string' || !playerId) throw new AppError('invalid-argument', 'Bir oyuncu seç.');
    const day = trDay(this.now());
    const [daily, player, p] = await Promise.all([this.store.getDaily(uid, day), this._photoPlayer(day), this._profile(uid)]);
    const st = daily?.photo;
    if (!st?.startedAt) throw new AppError('failed-precondition', 'Önce oyunu başlat.');
    if (st.finished) throw new AppError('failed-precondition', 'Bugünkü hakkını kullandın; yarın yeni oyuncu.');
    const guessed = this.pool.byId(playerId);
    const correct = playerId === player.id || (guessed && fold(guessed.n) === fold(player.n));
    const attempts = Number(st.attempts ?? 0) + 1;
    const guesses = [...(st.guesses ?? []), { id: playerId, name: guessed?.n ?? '?', club: guessed?.c ?? null, correct }];
    const next = { ...st, attempts, guesses };
    let reward = 0;
    if (correct) {
      reward = Math.max(PHOTO.minReward, PHOTO.firstReward - PHOTO.stepPenalty * (attempts - 1));
      next.finished = true;
      next.solved = true;
      next.reward = reward;
      next.ms = this.now() - Number(st.startedAt);
    } else if (attempts >= PHOTO.attempts) {
      next.finished = true;
    }
    await this.store.updateDaily(uid, day, { photo: next });
    let balance = Number(p.credits ?? 0);
    if (reward) {
      balance = await this._earn(uid, p, reward, await this._pro(uid));
      await this.store.addPhotoScore(day, uid, { ms: next.ms, attempts, username: p.username ?? null, photoURL: p.photoURL ?? null });
    }
    return { day, correct, balance, ...this._photoView(next, player) };
  }

  async photoBoard({ uid, guest = false }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    void guest;
    const day = trDay(this.now());
    return { day, entries: await this.store.topPhoto(day, 20) };
  }

  /** Oyuncu arama (en az 3 harf). Fotoğraf gönderilmez (oyunun cevabını ele vermesin). */
  async searchPlayers({ uid, q }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    await this.pool.ensure?.();
    return { items: this.pool.search(String(q ?? '')).map((p) => ({ id: p.id, name: p.n, club: p.c, league: p.l, pos: p.pos })) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Bilgi yarışması (ücretsiz; her doğru cevap kredi kazandırır, yanlış cevap oyunu bitirir)
  // ---------------------------------------------------------------------------------------------------------------

  _ask(s) {
    const q = s.questions[s.index];
    s.askedAt = this.now();
    return { index: s.index, text: q.text, options: q.options, seconds: QUIZ.seconds };
  }

  async quizStart({ uid, guest = false }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const daily = await this.store.getDaily(uid, day);
    if (Number(daily?.quiz?.plays ?? 0) >= QUIZ.dailyPlays) throw new AppError('resource-exhausted', 'Bugünkü yarışma hakların bitti; yarın 5 yeni hak.');
    this.pool.ensure?.().catch?.(() => {});
    const rng = this.random('quiz');
    const questions = buildQuestions(this.pool.all(), rng, QUIZ.maxQuestions);
    if (!questions.length) throw new AppError('unavailable', 'Sorular hazırlanamadı.');
    await this.store.incrementDaily(uid, day, 'quiz.plays', 1);
    for (const [k, v] of this._quiz) if (this.now() - v.askedAt > 10 * 60e3) this._quiz.delete(k);
    const id = `${uid.slice(0, 8)}${this.now().toString(36)}${randomInt(0, 1e9).toString(36)}`;
    const s = { uid, day, questions, index: 0, askedAt: this.now(), score: 0, pro: await this._pro(uid) };
    this._quiz.set(id, s);
    return { sessionId: id, left: QUIZ.dailyPlays - Number(daily?.quiz?.plays ?? 0) - 1, perCorrect: QUIZ.perCorrect + (s.pro ? QUIZ.proBonus : 0), question: this._ask(s) };
  }

  async quizAnswer({ uid, guest = false, sessionId, index, choice }) {
    this._member(uid, guest);
    const s = this._quiz.get(String(sessionId ?? ''));
    if (!s || s.uid !== uid) throw new AppError('not-found', 'Yarışma oturumu bulunamadı; yeniden başla.');
    if (Number(index) !== s.index) throw new AppError('invalid-argument', 'Soru sırası uyuşmuyor.');
    const q = s.questions[s.index];
    const late = this.now() - s.askedAt > QUIZ.seconds * 1000 + QUIZ.graceMs;
    const correct = !late && Number(choice) === q.answer;
    if (correct) s.score++;
    const last = s.index >= s.questions.length - 1;
    if (correct && !last) {
      s.index++;
      return { correct: true, answer: q.answer, score: s.score, finished: false, question: this._ask(s) };
    }
    // Bitti: yanlış, süre doldu ya da sorular tükendi
    this._quiz.delete(sessionId);
    const per = QUIZ.perCorrect + (s.pro ? QUIZ.proBonus : 0);
    const reward = s.score * per;
    const p = await this._profile(uid);
    const daily = await this.store.getDaily(uid, s.day);
    const best = Math.max(Number(daily?.quiz?.best ?? 0), s.score);
    await this.store.updateDaily(uid, s.day, { quiz: { best } });
    if (s.score > 0) await this.store.incrementDaily(uid, s.day, 'quiz.correct', s.score);
    const balance = reward ? await this._earn(uid, p, reward, s.pro) : Number(p.credits ?? 0);
    if (s.score > 0) await this.store.addQuizScore(s.day, uid, { best: s.score, username: p.username ?? null, photoURL: p.photoURL ?? null });
    return { correct, timeout: late, answer: q.answer, score: s.score, finished: true, reward, balance, best };
  }

  async quizBoard({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const day = trDay(this.now());
    return { day, entries: await this.store.topQuiz(day, 20) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Benim 11'im: paketler, kartlar, kadrolar, kapışma
  // ---------------------------------------------------------------------------------------------------------------

  _rollTier(weights, rng) {
    const entries = Object.entries(weights);
    let x = rng.next() * entries.reduce((a, [, w]) => a + w, 0);
    for (const [t, w] of entries) {
      x -= w;
      if (x <= 0) return t;
    }
    return entries[entries.length - 1][0];
  }

  /**
   * Paket çekilişi. opts: { group (mevki paketi), pity (elit garantisi) }. Genç Yetenek paketinde yalnızca maxAge
   * yaşındakiler (yaşı bilinmeyenler sayılmaz; havuzda yetmezse en yakın) ve bir kart potansiyeli potGuaranteed+.
   */
  _drawPack(pack, rng, { group = null, pity = false } = {}) {
    const all = this.pool.all();
    if (all.length < 50) throw new AppError('unavailable', 'Oyuncu listesi hazırlanıyor; birkaç dakika sonra tekrar dene.');
    const inTier = (t) => {
      const [lo, hi] = TIER_RANGE[t];
      return (p) => p.r >= lo && p.r <= hi;
    };
    const young = (p) => Number.isFinite(Number(p.a)) && p.a > 0 && p.a <= (pack.maxAge ?? 99);
    const base = (p) => (!group || p.g === group) && (!pack.maxAge || young(p));
    const out = [];
    const taken = new Set();
    const g = pack.guaranteed ?? 0;
    for (let i = 0; i < pack.count; i++) {
      let filter;
      if (i === 0 && pity) filter = (p) => base(p) && p.r >= 85;
      else if (i < g) filter = (p) => base(p) && p.r >= 80;
      else if (i === 0 && pack.potGuaranteed) filter = (p) => base(p) && potentialOf(asCard(p)) >= pack.potGuaranteed;
      else {
        const t = inTier(this._rollTier(pack.weights, rng));
        filter = (p) => base(p) && t(p);
      }
      let [p] = this.pool.pick(filter, rng, 1, taken);
      // O katmanda kart kalmadıysa: önce aynı paket kuralıyla herhangi bir kart, sonra en yakın
      if (!p) [p] = this.pool.pick(base, rng, 1, taken);
      if (!p && group) [p] = this.pool.pick((x) => x.g === group, rng, 1, taken);
      if (!p) [p] = this.pool.pick(() => true, rng, 1, taken);
      if (!p) break;
      taken.add(p.id);
      out.push(asCard(p));
    }
    // En iyi kartlar sonda açılır (heyecan)
    return out.sort((a, b) => a.r - b.r);
  }

  async openPack({ uid, guest = false, pack, group = null, token = false }) {
    this._member(uid, guest);
    const def = PACKS[pack];
    if (!def) throw new AppError('invalid-argument', 'Geçersiz paket.');
    if (def.group && !['KL', 'DEF', 'OS', 'FV'].includes(group)) throw new AppError('invalid-argument', 'Mevki paketi için mevki seç (kaleci, defans, orta saha, forvet).');
    await this.pool.ensure?.();
    const day = trDay(this.now());
    if (def.daily) {
      const daily = await this.store.getDaily(uid, day);
      if (daily?.freePack) throw new AppError('failed-precondition', 'Günlük ücretsiz paketini açtın; yarın yenisi gelir.');
    }
    const p = await this._profile(uid);
    // Elit şans sayacı (ücretli paketler)
    const pityNow = Number(p.packPity ?? 0);
    const pity = def.cost > 0 && pityNow >= PITY.every;
    const cards = this._drawPack(def, this.random(`pack:${pack}`), { group: def.group ? group : null, pity });
    // Paket jetonu (Sezon Yolu, takvim, takas ödülü) kredisiz açar; özel haftada indirimli fiyat
    const haveToken = Number(p.packTokens?.[def.id] ?? 0);
    if (token && haveToken < 1) throw new AppError('failed-precondition', 'Bu paket için jetonun yok.');
    const useToken = token && haveToken >= 1;
    const cost = def.daily || useToken ? 0 : packCost(def, this.theme());
    const { balance, ids } = await this.store.purchase(uid, cost, cards);
    if (useToken) await this.store.updateProfile(uid, { packTokens: { ...(p.packTokens ?? {}), [def.id]: haveToken - 1 } });
    await this.store.updateDaily(uid, day, def.daily ? { freePack: true } : {});
    await this.store.incrementDaily(uid, day, 'packs', 1);
    const elite = cards.some((c) => c.r >= 85);
    const packPity = def.cost > 0 ? (elite ? 0 : pityNow + 1) : pityNow;
    if (packPity !== pityNow) await this.store.updateProfile(uid, { packPity });
    const xp = await this.progress.xp(uid, ROAD.xp.pack).catch(() => null);
    return { pack: def.id, balance, cost, token: useToken, cards: cards.map((c, i) => ({ id: ids[i], ...c })), pity: { value: packPity, every: PITY.every, used: pity }, xp };
  }

  /** Hoşgeldin paketi: seçilen bölgenin liginde oynayanlar ve milli takımından 18 oyuncu (2 KL, 6 DEF, 6 OS, 4 FV). */
  async welcomePack({ uid, guest = false, region }) {
    this._member(uid, guest);
    const r = REGIONS[region];
    if (!r) throw new AppError('invalid-argument', 'Geçersiz bölge.');
    const p = await this._profile(uid);
    this._needClub(p);
    if (p.welcomeDone) throw new AppError('failed-precondition', 'Hoşgeldin paketi yalnızca bir kez açılır.');
    await this.pool.ensure?.();
    const rng = this.random(`welcome:${region}`);
    const fromRegion = (x) => x.l === r.league || x.na === r.nation;
    const need = { KL: 2, DEF: 6, OS: 6, FV: 4 };
    const cards = [];
    const taken = new Set();
    let gold = 0;
    for (const [g, n] of Object.entries(need)) {
      for (let i = 0; i < n; i++) {
        const allowGold = gold < 3;
        let [x] = this.pool.pick((c) => fromRegion(c) && c.g === g && (allowGold ? c.r < 85 : c.r < 75), rng, 1, taken);
        if (!x) [x] = this.pool.pick((c) => c.g === g && c.r < 80, rng, 1, taken);
        if (!x) continue;
        if (x.r >= 75) gold++;
        taken.add(x.id);
        cards.push(asCard(x));
      }
    }
    if (cards.length < 11) throw new AppError('unavailable', 'Bu bölgenin oyuncu listesi hazırlanıyor; birkaç dakika sonra tekrar dene.');
    const { ids } = await this.store.purchase(uid, 0, cards);
    await this.store.updateProfile(uid, { welcomeDone: true, region });
    return { region, cards: cards.map((c, i) => ({ id: ids[i], ...c })) };
  }

  async sellCards({ uid, guest = false, ids }) {
    this._member(uid, guest);
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new AppError('invalid-argument', 'Satılacak kartları seç.');
    const [cards, squads] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    const owned = new Map(cards.map((c) => [c.id, c]));
    const inSquad = new Set(squads.flatMap((s) => Object.values(s.slots ?? {})));
    let total = 0;
    for (const id of ids) {
      const c = owned.get(id);
      if (!c) throw new AppError('not-found', 'Kart bulunamadı.');
      if (inSquad.has(id)) throw new AppError('failed-precondition', `${c.s ?? c.n} bir kadroda; önce kadrodan çıkar.`);
      total += SELL_PRICE[c.tier ?? tierOf(c.r)] ?? 100;
    }
    // Özel hafta (Transfer Dönemi): hızlı satış artar
    const sellPct = Number(this.theme()?.sellPct ?? 0);
    if (sellPct) total = Math.round((total * (100 + sellPct)) / 100);
    await this.store.deleteCards(uid, ids);
    // Satıştan gelen kredi liderlik tablosuna yazılmaz (oyunla kazanılmadı)
    const balance = await this.store.changeCredits(uid, total, { earn: false });
    return { sold: ids.length, credits: total, balance };
  }

  /** En güçlü geçerli kadro: { s, v, power } ya da null. */
  _bestSquad(squads, cards) {
    const owned = new Map(cards.map((c) => [c.id, c]));
    let best = null;
    for (const s of squads) {
      const v = validateSquad(s, owned);
      if (!v.ok) continue;
      const power = teamPower(v.ev);
      if (!best || power > best.power) best = { s, v, power };
    }
    return best;
  }

  async _duelSummary(uid, p, squads, cards) {
    const best = this._bestSquad(squads, cards);
    if (!best) {
      await this.store.deleteDuelPool(uid).catch(() => {});
      return;
    }
    await this.store.upsertDuelPool(uid, {
      username: p.username ?? null,
      name: p.club?.name ?? best.v.name,
      // Rakip olarak çıktığında kulübün arması, formaları ve taraftar grubu görünür
      crest: p.club?.crest ?? null,
      kits: kitsOf(p.club),
      fans: p.club?.fans ?? null,
      formation: best.s.formation,
      rating: best.v.ev.rating,
      chemistry: best.v.ev.chemistry,
      power: Math.round(best.power * 10) / 10,
      lineup: Object.fromEntries(Object.entries(best.v.lineup).map(([k, c]) => [k, { g: c.g, r: c.r, s: c.s, ci: c.ci, na: c.na, l: c.l, pid: c.pid ?? null }])),
      // Deplasmanda rakip bu kulübün stadyumuna gelir
      stadium: p.club ? { level: Number(p.club.levels?.stadium ?? 1), capacity: effectsOf(p.club.levels).stadium.capacity, name: `${p.club.name} Stadyumu`, short: p.club.short ?? null } : null,
      div: Number(p.league?.div ?? START_DIV),
    });
  }

  async saveSquad({ uid, guest = false, id = null, name, formation, slots }) {
    this._member(uid, guest);
    const [cards, squads, p] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    this._needClub(p);
    if (!id && squads.length >= MAX_SQUADS) throw new AppError('failed-precondition', `En fazla ${MAX_SQUADS} kadro kurabilirsin.`);
    if (id && !squads.some((s) => s.id === id)) throw new AppError('not-found', 'Kadro bulunamadı.');
    const owned = new Map(cards.map((c) => [c.id, c]));
    const v = validateSquad({ name, formation, slots }, owned);
    if (!v.ok) throw new AppError('invalid-argument', v.error);
    const clean = Object.fromEntries(slotsOf(formation).map((s) => [s.key, slots[s.key]]));
    const data = { name: v.name, formation, slots: clean, chemistry: v.ev.chemistry, rating: v.ev.rating, power: Math.round(teamPower(v.ev) * 10) / 10 };
    // Taktik planı kadro düzenlenince korunur
    const prev = id ? squads.find((s) => s.id === id) : null;
    if (prev?.plan) data.plan = checkPlan(prev.plan);
    const sid = await this.store.saveSquad(uid, id, data);
    const all = [...squads.filter((s) => s.id !== sid), { id: sid, ...data }];
    await this._duelSummary(uid, p, all, cards);
    return { id: sid, ...data };
  }

  /**
   * Kartlar ve kadrolar (Benim 11'im). İstemci normalde Firestore'dan canlı okur; Firestore kuralları yayında
   * değilse ya da okuma reddedilirse liste buradan alınır. Zaman damgaları gönderilmez.
   */
  async collection({ uid, guest = false }) {
    this._member(uid, guest);
    const [cards, squads] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    const plain = ({ at, updatedAt, ...rest }) => rest;
    return {
      cards: cards.map(plain).sort((a, b) => Number(b.r ?? 0) - Number(a.r ?? 0)),
      squads: squads.map(plain),
      maxSquads: MAX_SQUADS,
    };
  }

  async deleteSquad({ uid, guest = false, id }) {
    this._member(uid, guest);
    const [cards, squads, p] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    if (!squads.some((s) => s.id === id)) throw new AppError('not-found', 'Kadro bulunamadı.');
    await this.store.deleteSquad(uid, id);
    await this._duelSummary(uid, p, squads.filter((s) => s.id !== id), cards);
    return { ok: true };
  }

  /** Rakip: gücü yakın bir kullanıcı kadrosu; yoksa havuzdan aynı güçte kurulan bir takım. */
  async _opponent(uid, power, rng) {
    let list = [];
    try {
      list = (await this.store.queryDuelPool(power - 4, power + 4, 25)).filter((x) => x.uid !== uid && x.lineup);
    } catch {
      list = [];
    }
    if (list.length) {
      const o = list[rng.int(0, list.length - 1)];
      const lineup = fillLineup({ formation: o.formation, lineup: o.lineup, target: Math.round(power), pool: this.pool, rng });
      const crest = o.crest ?? null;
      return { name: o.name, username: o.username ?? null, formation: o.formation, lineup, bot: false, crest, kits: o.kits?.home ? o.kits : crest ? defaultKits(crest) : null, fans: o.fans ?? null, stadium: o.stadium ?? null };
    }
    const target = Math.round(power - 1);
    const cands = this.pool.pick((p) => Math.abs(p.r - target) <= 5, rng, 40);
    const formation = FORMATIONS[rng.int(0, 3)];
    // Rastgele seçilen adaylarda bir mevki eksik kalabilir: boş yuvalar doldurulur (rakip her zaman 11 kişi)
    const lineup = fillLineup({ formation, lineup: autoBuild(cands.map(asCard), formation, 'balanced'), target, pool: this.pool, rng });
    const crest = randomCrest(createRng(`bot:${this.now()}:${target}`));
    return { name: 'Karma Takım', username: null, formation, lineup, bot: true, crest, kits: defaultKits(crest), fans: null };
  }

  async duel({ uid, guest = false, squadId }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const [daily, cards, squads, p] = await Promise.all([this.store.getDaily(uid, day), this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    this._needClub(p);
    const energy = spendEnergy(p.energy, ENERGY.cost.normal, this.now());
    const squad = squads.find((s) => s.id === squadId);
    if (!squad) throw new AppError('not-found', 'Kadro bulunamadı.');
    const v = validateSquad(squad, new Map(cards.map((c) => [c.id, c])));
    if (!v.ok) throw new AppError('failed-precondition', v.error);
    await this.pool.ensure?.();
    const rng = this.random('duel');
    const me = { formation: squad.formation, lineup: v.lineup };
    const opp = await this._opponent(uid, teamPower(v.ev), rng);
    const sim = simulateDuel(me, opp, rng);
    const reward = sim.result === 'W' ? DUEL.win : sim.result === 'D' ? DUEL.draw : DUEL.loss;
    await this.store.incrementDaily(uid, day, 'duels', 1);
    const record = { at: this.now(), squad: v.name, opponent: opp.name, opponentUser: opp.username, score: sim.score, result: sim.result, reward };
    await this.store.updateProfile(uid, { duels: [record, ...(p.duels ?? [])].slice(0, 10), energy });
    const balance = await this._earn(uid, p, reward, await this._pro(uid));
    const oe = evaluate(opp.formation, opp.lineup);
    return {
      ...sim,
      reward,
      balance,
      me: { name: v.name, rating: v.ev.rating, chemistry: v.ev.chemistry },
      opponent: { name: opp.name, username: opp.username, bot: opp.bot, rating: oe.rating, chemistry: oe.chemistry },
      left: matchesLeft(energy, this.now(), 'normal'),
      energy: energyView(energy, this.now(), daily?.energyBuys ?? 0),
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Kapışma (stadyumda maç): taktik seç → ilk yarı → devre arasında taktik → ikinci yarı → ödül
  // ---------------------------------------------------------------------------------------------------------------

  /** Günün Meydan Okuması rakibinin kimliği (herkes için aynı gün aynı lig). */
  _bossInfo(day) {
    const keys = Object.keys(REGIONS);
    const reg = REGIONS[keys[hashOf(`boss:${day}`) % keys.length]];
    return { name: `${reg.leagueName} Yıldızları`, league: reg.leagueName, iso: reg.iso, formation: BOSS_FORMATIONS[hashOf(`bossf:${day}`) % BOSS_FORMATIONS.length] };
  }

  /** Günün Meydan Okuması kadrosu: günün liginden, kullanıcının gücünün biraz üstünde. */
  _boss(day, power) {
    const info = this._bossInfo(day);
    const reg = Object.values(REGIONS).find((r) => r.leagueName === info.league);
    const target = Math.max(62, Math.min(90, Math.round(power + BOSS.edge)));
    const rng = createRng(`boss:${day}:${target}`);
    const near = (x) => Math.abs(x.r - target) <= 4;
    let cands = this.pool.pick((x) => x.l === reg.league && near(x), rng, 70);
    if (cands.length < 40) cands = cands.concat(this.pool.pick(near, rng, 70, new Set(cands.map((c) => c.id))));
    const lineup = fillLineup({ formation: info.formation, lineup: autoBuild(cands.map(asCard), info.formation, 'chem'), target, pool: this.pool, rng });
    const crest = randomCrest(createRng(`bossc:${day}`));
    return { name: info.name, username: null, formation: info.formation, lineup, bot: true, boss: true, league: info.league, iso: info.iso, tactic: pickTactic(createRng(`bosst:${day}`)), crest, kits: defaultKits(crest) };
  }

  /** Kadronun maç ekranındaki görünümü (yuva sırasıyla 11 oyuncu). */
  _teamView(t, tactic) {
    const form = animFormation(t.formation);
    const slots = slotsOf(form.name);
    return {
      name: t.name,
      username: t.username ?? null,
      bot: t.bot === true,
      boss: t.boss === true,
      league: t.league ?? null,
      iso: t.iso ?? null,
      rating: t.rating,
      chemistry: t.chemistry,
      power: t.power,
      formation: form.name,
      tactic,
      kit: t.kit ?? null,
      // Kulüp formaları (ev sahibi, deplasman, kaleci) ve bu maçta giyilen
      kits: t.kits ?? null,
      wear: t.wear === 'away' ? 'away' : 'home',
      fans: t.fans ?? null,
      crest: t.crest ?? null,
      short: t.short ?? null,
      lineup: slots.map((s, i) => {
        const c = t.lineup?.[s.key];
        return { slot: s.key, pos: s.pos, num: form.slots[i].num, name: c?.s ?? '', r: Number(c?.r ?? 0), ph: c?.ph ?? null };
      }),
    };
  }

  /** Sıradaki maçın rakibi: gün içinde maç oynanana kadar aynı kalır (profilde metin olarak saklanır). */
  async _nextOpponent(uid, p, day, power) {
    const saved = p.nextDuel;
    if (saved?.day === day && typeof saved.opp === 'string') {
      try {
        const o = JSON.parse(saved.opp);
        if (o?.formation && o.lineup && Object.keys(o.lineup).length >= 11) return o;
      } catch {
        // bozuk kayıt: yeni rakip
      }
    }
    const opp = await this._opponent(uid, power, this.random('duel'));
    // İç saha / deplasman rakip belirlenirken bir kez seçilir (maç öncesi ekranı ile maç aynı stadyumda)
    const compact = { ...opp, home: homeFor(`${uid}:${this.now()}:${opp.name}`), lineup: Object.fromEntries(Object.entries(opp.lineup).filter(([, c]) => c).map(([k, c]) => [k, compactCard(c)])) };
    await this.store.updateProfile(uid, { nextDuel: { day, at: this.now(), opp: JSON.stringify(compact) } });
    p.nextDuel = { day, opp: JSON.stringify(compact) };
    return compact;
  }

  /**
   * Sıradaki maç (maç öncesi ekranı): rakip, stadyum ve ödüller. Normal maçta rakip önceden belirlenir ve maç
   * başlayınca aynı rakiple oynanır; Günün Meydan Okuması güne bağlıdır.
   */
  async duelNext({ uid, guest = false, mode = 'normal', friend = null }) {
    this._member(uid, guest);
    if (!MODES.includes(mode)) throw new AppError('invalid-argument', 'Geçersiz maç türü.');
    const day = trDay(this.now());
    const p = await this._profile(uid);
    this._needClub(p);
    const [cards, squads, daily] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid), this.store.getDaily(uid, day)]);
    await this.pool.ensure?.();
    const best = this._bestSquad(squads, this._live(cards));
    if (!best) throw new AppError('failed-precondition', 'Maça çıkmak için önce 11 kişilik bir kadro kur.');
    const opp = await this._modeOpponent(uid, p, day, best.power, mode, friend);
    const oe = evaluate(opp.formation, opp.lineup);
    const eff = effectsOf(p.club?.levels);
    const ven = this._venue(p, opp, mode, teamPower(oe), `next:${uid}:${day}:${opp.name}`);
    const R = mode === 'boss' ? BOSS : mode === 'season' ? SEASON : DUEL;
    return {
      mode,
      friend: mode === 'friend' ? opp.username ?? friend : null,
      opponent: {
        name: opp.name,
        username: opp.username ?? null,
        bot: opp.bot === true,
        boss: opp.boss === true,
        league: opp.league ?? null,
        iso: opp.iso ?? null,
        formation: opp.formation,
        power: Math.round(teamPower(oe) * 10) / 10,
        rating: oe.rating,
        chemistry: oe.chemistry,
        crest: opp.crest ?? null,
        kits: opp.kits ?? null,
        fans: opp.fans ?? null,
      },
      venue: { name: ven.stadium.name, capacity: ven.stadium.capacity, incomePct: ven.home ? eff.stadium.incomePct : 0 },
      // Ev sahibi kim, stadyum (maç ekranı bu stadyumda oynanır) ve saha avantajı
      home: ven.home,
      stadium: ven.stadium,
      advantage: ven.home ? ven.adv.me : ven.adv.opp,
      theme: this.progress.themeView(),
      rewards: [R.win, R.draw, R.loss],
      left: this._left(mode, daily, p),
      energy: energyView(p.energy, this.now(), daily?.energyBuys ?? 0),
      energyCost: mode === 'friend' ? ENERGY.cost.normal : (ENERGY.cost[mode] ?? 0),
      // Kariyer maçı: hafta ve ev sahibi/deplasman
      fixture: opp.fixture ? { week: opp.fixture.week, weeks: SEASON.weeks, home: opp.fixture.meHome, league: opp.league } : null,
      // Kariyer maçında oynayamayacaklar (sakat, cezalı, kadro dışı)
      absent: mode === 'season' ? this.office.brief(p).absent : [],
    };
  }

  /** Maç türüne göre kalan hak. */
  _left(mode, daily, p) {
    if (mode === 'boss') return daily?.boss === true ? 0 : 1;
    return matchesLeft(p?.energy, this.now(), mode === 'season' ? 'season' : 'normal');
  }

  /** Maç türünün rakibi: normal (sıradaki rakip), boss (günün yıldızları), season (kariyer ligi fikstürü). */
  async _modeOpponent(uid, p, day, power, mode, friend = null) {
    if (mode === 'boss') return this._boss(day, power);
    if (mode === 'season') return this.manager.opponentFor(uid, p);
    if (mode === 'friend') return this._friendOpponent(uid, friend, power);
    return this._nextOpponent(uid, p, day, power);
  }

  /** Arkadaşa meydan okuma: arkadaşın en güçlü kadrosu (kendi stadyumunda). */
  async _friendOpponent(uid, friend, power) {
    const fid = await this.store.uidByUsername(friend);
    if (!fid) throw new AppError('not-found', 'Bu kullanıcı adıyla bir oyuncu bulunamadı.');
    if (fid === uid) throw new AppError('invalid-argument', 'Kendine meydan okuyamazsın.');
    const o = await this.store.getDuelPoolEntry(fid);
    if (!o?.lineup) throw new AppError('failed-precondition', 'Arkadaşının hazır bir kadrosu yok.');
    const rng = createRng(`friend:${fid}:${trDay(this.now())}`);
    const lineup = fillLineup({ formation: o.formation, lineup: o.lineup, target: Math.round(o.power ?? power), pool: this.pool, rng });
    const crest = o.crest ?? null;
    return { name: o.name, username: o.username ?? null, uid: fid, formation: o.formation, lineup, bot: false, crest, kits: o.kits?.home ? o.kits : crest ? defaultKits(crest) : null, fans: o.fans ?? null, stadium: o.stadium ?? null, home: false };
  }

  /** Maçın stadyumu: ev sahibinin stadyumu ve saha avantajı. */
  _venue(p, opp, mode, power, seed) {
    let home = true;
    if (mode === 'season') home = opp.fixture?.meHome !== false;
    else if (mode === 'boss' || mode === 'friend') home = false;
    else if (opp.home === false) home = false;
    const stadium = home
      ? homeStadium(p, this.office.homeCrowd(p))
      : awayStadium(mode === 'boss' ? { ...opp, stadium: { level: 10, name: 'Yıldızlar Arenası' } } : opp, power, seed);
    const adv = homeAdvantage(stadium.level, stadium.fill);
    return { home, stadium, adv: { me: home ? adv : 1, opp: home ? 1 : adv } };
  }

  /** Kurgusal takım (kariyer ligi rakibi): adı, arması ve gücü verilen, aynı tohumla hep aynı 11. */
  _aiTeam({ name, crest, power, seed }) {
    const rng = createRng(`ai:${seed}`);
    const target = Math.round(power);
    const formation = BOSS_FORMATIONS[hashOf(`aif:${seed}`) % BOSS_FORMATIONS.length];
    const cands = this.pool.pick((x) => Math.abs(x.r - target) <= 4, rng, 60);
    const lineup = fillLineup({ formation, lineup: autoBuild(cands.map(asCard), formation, 'balanced'), target, pool: this.pool, rng });
    const compact = Object.fromEntries(Object.entries(lineup).filter(([, c]) => c).map(([k, c]) => [k, compactCard(c)]));
    return { name, username: null, formation, lineup: compact, bot: true, crest: crest ?? null, kits: crest ? defaultKits(crest) : null, fans: null, tactic: pickTactic(createRng(`ait:${seed}`)) };
  }

  /** Durum ekranı için kariyer özeti. */
  _careerBrief(p, daily) {
    const v = this.manager.careerView(p, daily);
    const s = v.season;
    const me = s?.table.find((t) => t.me);
    return {
      division: v.division,
      manager: v.manager,
      left: v.left,
      daily: v.daily,
      rewards: v.rewards,
      season: s ? { no: s.no, week: s.week, weeks: s.weeks, done: s.done, rank: me?.rank ?? null, points: me?.pts ?? 0, next: s.next } : null,
    };
  }

  /**
   * Kapışmayı başlatır: rakip bulunur, ilk yarı oynanır. Döner: ilk yarının paketi (devre arasında biter), iki takım ve
   * rakibin ikinci yarı planı. Hak maç başlarken düşer. Yarım kalmış kapışma varsa önce o biter (ödülü verilir).
   */
  async duelStart({ uid, guest = false, squadId, tactic = 'dengeli', mode = 'normal', kit = null, friend = null }) {
    this._member(uid, guest);
    if (!TACTICS[tactic]) throw new AppError('invalid-argument', 'Geçersiz taktik.');
    if (!MODES.includes(mode)) throw new AppError('invalid-argument', 'Geçersiz maç türü.');
    const day = trDay(this.now());
    let p = await this._profile(uid);
    this._needClub(p);
    let resolved = null;
    if (p.pendingDuel) {
      resolved = await this._finishDuel(uid, p, p.pendingDuel.id, null).catch(() => null);
      p = await this._profile(uid);
    }
    const [daily, cards, squads] = await Promise.all([this.store.getDaily(uid, day), this.store.listCards(uid), this.store.listSquads(uid)]);
    if (mode === 'boss' && daily?.boss === true) throw new AppError('resource-exhausted', 'Günün Meydan Okuması bugün oynandı; yarın yeni rakip seni bekliyor.');
    // Günlük maç sınırı yok: normal ve kariyer maçı enerji harcar (önce yetip yetmediğine bakılır)
    const energyCost = mode === 'friend' ? ENERGY.cost.normal : (ENERGY.cost[mode] ?? 0);
    if (energyCost) spendEnergy(p.energy, energyCost, this.now());
    const squad = squads.find((x) => x.id === squadId);
    if (!squad) throw new AppError('not-found', 'Kadro bulunamadı.');
    await this.pool.ensure?.();
    // Canlı kartlar: gerçek maçlardaki formuyla güçlenmiş kartlar sahaya çıkar
    const v = validateSquad(squad, new Map(this._live(cards).map((c) => [c.id, c])));
    if (!v.ok) throw new AppError('failed-precondition', v.error);
    // Kariyer maçında sakat, cezalı ve kadro dışı oyuncular oynayamaz
    if (mode === 'season') {
      const out = this.office.unavailableIn(p, squad.slots);
      if (out.length) throw new AppError('failed-precondition', `Kariyer maçında oynayamazlar: ${out.map((a) => `${a.name} (${a.label.toLocaleLowerCase('tr')}${a.type === 'dropped' ? '' : `, ${a.left} maç`})`).join(', ')}. Kadroyu düzenle.`);
    }
    const rng = this.random('duel');
    // Gizli ikililer: uyumlu çiftler takımın gücünü artırır (maçtan sonra keşfedilir)
    const duos = findDuos(v.lineup);
    const power = teamPower(v.ev) + duoPower(duos);
    // Normal maçta sıradaki maçın rakibi (maç öncesi ekranında gösterilen), kariyerde fikstürdeki rakip sahaya çıkar
    const opp = await this._modeOpponent(uid, p, day, power, mode, friend);
    const oe = evaluate(opp.formation, opp.lineup);
    // Stadyum: ev sahibinin stadyumu (maç ekranında görünür) ve saha avantajı
    const ven = this._venue(p, opp, mode, teamPower(oe), `next:${uid}:${day}:${opp.name}`);
    const kitOk = (k) => (Number.isInteger(k) && k >= 0 && k < 32 ? k : null);
    const me = {
      // Takım sahada kulübün adıyla çıkar; taraftar grubu ve arma maç ekranında görünür
      name: p.club?.name ?? v.name,
      squad: v.name,
      fans: p.club?.fans ?? null,
      crest: p.club?.crest ?? null,
      short: p.club?.short ?? null,
      // Takım kulübün formasıyla çıkar: ev sahibi (varsayılan) ya da deplasman
      kits: kitsOf(p.club),
      wear: kit === 'away' ? 'away' : 'home',
      formation: squad.formation,
      power: Math.round(power * 10) / 10,
      rating: v.ev.rating,
      chemistry: v.ev.chemistry,
      kit: kitOk(kit),
      // Kadronun taktik planı (pres, savunma çizgisi, genişlik, tempo)
      plan: squad.plan ? checkPlan(squad.plan) : null,
      adv: ven.adv.me,
      lineup: Object.fromEntries(Object.entries(v.lineup).map(([k, c]) => [k, compactCard(c)])),
      // Yuva → kart kimliği (kariyer maçında sakatlık ve kırmızı kart cezası için)
      ids: Object.fromEntries(Object.entries(v.lineup).map(([k, c]) => [k, c?.id ?? null])),
    };
    const oppT1 = opp.tactic ?? pickTactic(rng);
    const them = {
      name: opp.name,
      username: opp.username ?? null,
      bot: opp.bot === true,
      boss: opp.boss === true,
      league: opp.league ?? null,
      iso: opp.iso ?? null,
      formation: opp.formation,
      power: Math.round(teamPower(oe) * 10) / 10,
      rating: oe.rating,
      chemistry: oe.chemistry,
      kit: rng.int(0, 11),
      crest: opp.crest ?? null,
      kits: opp.kits ?? null,
      fans: opp.fans ?? null,
      adv: ven.adv.opp,
      lineup: Object.fromEntries(Object.entries(opp.lineup).filter(([, c]) => c).map(([k, c]) => [k, compactCard(c)])),
    };
    const seed = `duel-${this.now()}-${rng.int(0, 1e9)}`;
    const first = playDuel({ me, opp: them, seed, tactics: { me1: tactic, opp1: oppT1 } });
    const ht = first.timeline.halftimeScore;
    const oppT2 = adaptTactic(oppT1, ht.away, ht.home);
    const pending = {
      id: seed.slice(5),
      day,
      mode,
      at: this.now(),
      seed,
      squadId,
      me: { ...me, tactic },
      opp: { ...them, tactic: oppT1, tacticHT: oppT2 },
      // Kariyer maçı: hafta, iç saha/deplasman ve lig
      fixture: opp.fixture ? { week: opp.fixture.week, home: opp.fixture.meHome === true, div: Number(p.career?.season?.div ?? 0) } : null,
      home: ven.home,
      stadium: ven.stadium,
      duos,
      friend: mode === 'friend' ? { uid: opp.uid, username: opp.username ?? null } : null,
    };
    if (mode === 'normal' || mode === 'friend') await this.store.incrementDaily(uid, day, 'duels', 1);
    else if (mode === 'season') await this.store.incrementDaily(uid, day, 'season', 1);
    else await this.store.updateDaily(uid, day, { boss: true });
    // Enerji düşer (normal ve kariyer maçı)
    const energy = energyCost ? spendEnergy(p.energy, energyCost, this.now()) : (p.energy ?? null);
    // Rakip sahaya çıktı: sıradaki maç için yeni rakip belirlenir
    await this.store.updateProfile(uid, { pendingDuel: pending, nextDuel: null, ...(energyCost ? { energy } : {}) });
    p.energy = energy;
    const name2 = TACTICS[oppT2].name;
    return {
      duelId: pending.id,
      mode,
      seconds: DUEL_SECONDS,
      venue: ven.stadium.name,
      home: ven.home,
      stadium: ven.stadium,
      pack: packOf(first, { firstHalf: true }),
      me: this._teamView(me, tactic),
      opponent: this._teamView(them, oppT1),
      halftime: {
        score: [ht.home, ht.away],
        opponentTactic: oppT2,
        hint: oppT2 === oppT1 ? `Rakip planını değiştirmeyecek gibi: ikinci yarı da ${name2}.` : `Rakip ikinci yarı ${name2} oynayacak gibi görünüyor.`,
      },
      left: mode === 'boss' ? null : matchesLeft(energy, this.now(), mode),
      energy: energyView(energy, this.now(), daily?.energyBuys ?? 0),
      resolved: resolved ? { result: resolved.result, score: resolved.score, reward: resolved.reward, opponent: resolved.opponent.name } : null,
    };
  }

  /** Devre arasında seçilen taktikle ikinci yarıyı oynar; ödülü verir. tactic yoksa ilk yarının taktiği sürer. */
  /**
   * Devre arasında seçilen taktikle ikinci yarıyı oynar; ödülü verir. tactic yoksa ilk yarının taktiği sürer.
   * moments: true ise maç ikinci yarının kritik anında (penaltı, 70. dakika) durur; seçim duelMoment ile yapılır.
   */
  async duelFinish({ uid, guest = false, duelId, tactic = null, moments = false }) {
    this._member(uid, guest);
    if (tactic != null && !TACTICS[tactic]) throw new AppError('invalid-argument', 'Geçersiz taktik.');
    const p = await this._profile(uid);
    const pd = p.pendingDuel;
    if (!pd || pd.id !== duelId) throw new AppError('not-found', 'Bu maç bitmiş ya da bulunamadı.');
    if (moments === true) {
      // Daha önce durmuş maç: aynı anı yeniden gösterir (bağlantı koptuysa)
      const mo = pd.moments ?? { tactic2: tactic && TACTICS[tactic] ? tactic : pd.me.tactic, choices: {}, pending: null, last: null };
      const match = this._replay(pd, mo);
      const m = nextMoment(match, { after: this._resumeAt(match, mo) ?? 0, state: mo });
      if (m) {
        const next = { ...mo, pending: m };
        if (!pd.moments?.pending) await this.store.updateProfile(uid, { pendingDuel: { ...pd, moments: next } });
        return this._pausedView(pd, match, next);
      }
      return this._finishDuel(uid, p, duelId, null, mo);
    }
    return this._finishDuel(uid, p, duelId, tactic);
  }

  /** Kritik anda seçim: maç seçime göre sürer; sıradaki an varsa orada yeniden durur, yoksa biter. */
  async duelMoment({ uid, guest = false, duelId, choice }) {
    this._member(uid, guest);
    const p = await this._profile(uid);
    const pd = p.pendingDuel;
    if (!pd || pd.id !== duelId) throw new AppError('not-found', 'Bu maç bitmiş ya da bulunamadı.');
    const mo = pd.moments;
    const m = mo?.pending;
    if (!m) throw new AppError('failed-precondition', 'Şu an verilecek bir karar yok.');
    let picked;
    let penalty = null;
    if (m.type === 'late') {
      if (!LATE[choice]) throw new AppError('invalid-argument', 'Geçersiz seçim.');
      picked = { id: choice, from: m.from ?? LATE_MINUTE };
    } else {
      if (!DIRS.includes(choice)) throw new AppError('invalid-argument', 'Geçersiz yön.');
      penalty = resolvePenalty({ seed: pd.seed, n: m.n, type: m.type, choice });
      picked = { ...penalty, choice };
    }
    const state = { ...mo, choices: { ...(mo.choices ?? {}), [m.id]: picked }, pending: null, last: m.id };
    const match = this._replay(pd, state);
    const nm = nextMoment(match, { after: this._resumeAt(match, state) ?? m.cut, state });
    const answered = { id: m.id, type: m.type, choice, ...(penalty ? { outcome: penalty.outcome, dir: penalty.dir, keeper: penalty.keeper } : { plan: LATE[choice].name }) };
    if (nm) {
      const next = { ...state, pending: nm };
      await this.store.updateProfile(uid, { pendingDuel: { ...pd, moments: next } });
      return { ...this._pausedView(pd, match, next), answered };
    }
    const fin = await this._finishDuel(uid, p, duelId, null, state);
    return { ...fin, answered };
  }

  /** Bekleyen maçı seçimlerle yeniden oynatır (aynı tohum). mo yoksa kritik an modu kapalı. */
  _replay(pd, mo, me2 = mo?.tactic2 ?? pd.me.tactic) {
    return playDuel({ me: pd.me, opp: pd.opp, seed: pd.seed, tactics: { me1: pd.me.tactic, opp1: pd.opp.tactic, me2, opp2: pd.opp.tacticHT }, moments: mo ? momentInputs(mo, pd.opp.tacticHT) : null });
  }

  /** Uygulamanın bu pakette oynatmaya başlayacağı saniye: son cevaplanan anın bu maçtaki yeri (yoksa devre arası sonu). */
  _resumeAt(match, mo) {
    return mo?.last ? syncTime(match, mo.last) : (match.breakAt?.end ?? null);
  }

  /** Kritik anda durmuş maç: o ana kadarki paket ve soru. */
  _pausedView(pd, match, mo) {
    const m = mo.pending;
    const pack = packOf(match, { cutAt: m.cut, resumeAt: this._resumeAt(match, mo) });
    return {
      duelId: pd.id,
      mode: pd.mode,
      paused: true,
      pack,
      moment: momentView(m, [pack.finalScore.home, pack.finalScore.away]),
      tactics: { me: [pd.me.tactic, mo.tactic2] },
      // Yarım kalan maç sürdürülürken sahneyi kurmak için takımlar ve stadyum
      me: this._teamView(pd.me, mo.tactic2),
      opponent: this._teamView(pd.opp, pd.opp.tacticHT),
      home: pd.home !== false,
      stadium: pd.stadium ?? null,
    };
  }

  async _finishDuel(uid, p, duelId, tactic, moState = undefined) {
    const pd = await this.store.takePendingDuel(uid, duelId);
    if (!pd) throw new AppError('not-found', 'Bu maç bitmiş ya da bulunamadı.');
    // Kritik anlar: verilen seçimler maça işlenir (cevaplanmamış an motorun kendi sonucuyla oynanır)
    const mo = moState !== undefined ? moState : (pd.moments ?? null);
    const me2 = mo?.tactic2 ?? (tactic && TACTICS[tactic] ? tactic : pd.me.tactic);
    const match = this._replay(pd, mo, me2);
    const sc = match.timeline.score;
    const result = sc.home > sc.away ? 'W' : sc.home === sc.away ? 'D' : 'L';
    const friendly = pd.mode === 'friend';
    const R = pd.mode === 'boss' ? BOSS : pd.mode === 'season' ? SEASON : DUEL;
    const baseReward = result === 'W' ? R.win : result === 'D' ? R.draw : R.loss;
    // Stadyum geliri: iç saha maçında stadyum seviyesine göre maç ödülüne yüzde eklenir
    const home = pd.home !== false;
    const incomePct = p.club && home ? effectsOf(p.club.levels).stadium.incomePct : 0;
    const stadiumBonus = Math.round((baseReward * incomePct) / 100);
    // Özel hafta: gol haftası (atılan gol başına), derbi haftası (galibiyete yüzde)
    const theme = this.theme();
    const goalBonus = pd.mode !== 'season' && theme.goalBonus ? sc.home * theme.goalBonus : 0;
    const themeBonus = result === 'W' && theme.winPct ? Math.round((baseReward * theme.winPct) / 100) : 0;
    // Galibiyet serisi (dostluk maçı seriyi etkilemez): art arda galibiyet ödülü artırır, 3/5/10'da hediye
    const ws = { n: Number(p.winStreak?.n ?? 0), best: Number(p.winStreak?.best ?? 0) };
    const streakN = friendly ? ws.n : result === 'W' ? ws.n + 1 : 0;
    const streakBonus = !friendly && result === 'W' ? Math.round((baseReward * streakPct(streakN)) / 100) : 0;
    const gift = !friendly && result === 'W' ? (WIN_STREAK.gifts[streakN] ?? null) : null;
    const winStreak = { n: streakN, best: Math.max(ws.best, streakN) };
    const reward = baseReward + stadiumBonus + goalBonus + themeBonus + streakBonus;
    const totals = { w: Number(p.duelTotals?.w ?? 0), d: Number(p.duelTotals?.d ?? 0), l: Number(p.duelTotals?.l ?? 0) };
    totals[result === 'W' ? 'w' : result === 'D' ? 'd' : 'l']++;
    const record = { at: this.now(), squad: pd.me.squad ?? pd.me.name, opponent: pd.opp.name, opponentUser: pd.opp.username ?? null, score: [sc.home, sc.away], result, reward, mode: pd.mode, home };
    // Gizli ikililer: bu maçta birlikte oynayan uyumlu çiftler keşfedilir
    const known = new Set((p.duos ?? []).map((d) => d.key));
    const found = (pd.duos ?? []).filter((d) => !known.has(d.key)).map((d) => ({ ...d, at: this.now() }));
    await this.store.updateProfile(uid, {
      duels: [record, ...(p.duels ?? [])].slice(0, 10),
      duelTotals: totals,
      winStreak,
      ...(found.length ? { duos: [...found, ...(p.duos ?? [])].slice(0, 40) } : {}),
    });
    if (result === 'W') await this.store.incrementDaily(uid, pd.day, 'duelWins', 1);
    const week = this._week(Number(pd.at ?? this.now()));
    // Kariyer maçı haftalık Kapışma Ligi'ne değil, kariyer ligine yazılır
    // Dostluk maçı da lige yazılmaz (arkadaşa meydan okuma)
    const pts = pd.mode === 'season' || friendly ? 0 : LEAGUE_POINTS[result];
    if (pd.mode !== 'season' && !friendly) {
      await this.store
        .addDuelBoard(week, uid, { points: pts, played: 1, w: result === 'W' ? 1 : 0, d: result === 'D' ? 1 : 0, l: result === 'L' ? 1 : 0, gf: sc.home, ga: sc.away }, { username: p.username, photoURL: p.photoURL, div: Number(p.league?.div ?? START_DIV) })
        .catch((e) => this.log.warn?.('[game] lig tablosu yazılamadı', e?.message ?? e));
    }
    // Arkadaşa meydan okuma: sonuç arkadaşın gelen kutusuna düşer (rövanş için)
    if (friendly && pd.friend?.uid) {
      const fp = await this.store.getProfile(pd.friend.uid).catch(() => null);
      if (fp) {
        const ch = { at: this.now(), from: p.username ?? null, club: p.club?.name ?? null, score: [sc.away, sc.home], result: result === 'W' ? 'L' : result === 'L' ? 'W' : 'D' };
        await this.store.updateProfile(pd.friend.uid, { challenges: [ch, ...(fp.challenges ?? [])].slice(0, 10) }).catch(() => null);
      }
    }
    const season = pd.mode === 'season' ? await this.manager.record(uid, p, sc.home, sc.away).catch((e) => (this.log.warn?.('[game] kariyer sonucu yazılamadı', e?.message ?? e), null)) : null;
    // Kulüp yönetimi: maç günü gelirleri, ilişkiler, sakatlık/ceza, mesajlar, basın toplantısı
    const office =
      pd.mode === 'season' && p.club
        ? await this.office.afterMatch(uid, p, { pd, match, my: sc.home, opp: sc.away, season }).catch((e) => (this.log.warn?.('[game] kulüp yönetimi işlenemedi', e?.message ?? e), null))
        : null;
    const pro = await this._pro(uid);
    let balance = await this._earn(uid, p, reward, pro);
    // Galibiyet serisi hediyesi (enerji ya da paket jetonu)
    const giftApplied = gift ? await this.progress.grant(uid, p, gift, pro).catch(() => null) : null;
    // Genetik sisi: maçta oynayan oyuncuların genetiğinden bir parça açılabilir
    const reveals = await this._matchReveals(uid, pd).catch((e) => (this.log.warn?.('[game] genetik açılamadı', e?.message ?? e), []));
    // Sezon Yolu XP'si
    const xp = await this.progress.xp(uid, ROAD.xp.match + (result === 'W' ? ROAD.xp.win : 0)).catch(() => null);
    const entry = await this.store.duelBoardEntry(week, uid).catch(() => null);
    const rank = entry ? await this.store.duelBoardRank(week, Number(entry.points ?? 0)).catch(() => null) : null;
    const daily = await this.store.getDaily(uid, trDay(this.now()));
    const after = (await this.store.getProfile(uid)) ?? p;
    if (giftApplied?.balance != null) balance = giftApplied.balance;
    return {
      duelId,
      mode: pd.mode,
      pack: packOf(match, mo?.last ? { resumeAt: this._resumeAt(match, mo) } : {}),
      // Maçın oynandığı stadyum (ev sahibinin) ve iç saha/deplasman
      home,
      stadium: pd.stadium ?? null,
      venue: pd.stadium?.name ?? null,
      friendly,
      bonuses: { stadium: stadiumBonus, goals: goalBonus, theme: themeBonus, streak: streakBonus },
      theme: this.progress.themeView(),
      streak: { count: winStreak.n, best: winStreak.best, pct: !friendly && result === 'W' ? streakPct(streakN) : 0, gift: giftApplied ? { type: gift.type, amount: gift.amount ?? 1, pack: gift.pack ?? null } : null },
      reveals,
      duos: { found: found.map(({ key, a, b }) => ({ key, a, b })), active: (pd.duos ?? []).length },
      xp,
      moments: Object.entries(mo?.choices ?? {}).map(([id, v]) => (id === 'late' ? { id, choice: v?.id ?? v, plan: LATE[v?.id ?? v]?.name ?? null } : { id, choice: v.choice ?? v.dir, outcome: v.outcome, dir: v.dir, keeper: v.keeper })),
      score: [sc.home, sc.away],
      halftimeScore: [match.timeline.halftimeScore.home, match.timeline.halftimeScore.away],
      result,
      reward,
      stadiumBonus,
      balance,
      goals: match.goals,
      reds: match.reds,
      stats: match.stats,
      motm: match.motm,
      ratings: { me: match.ratings.home, opponent: match.ratings.away },
      me: this._teamView(pd.me, me2),
      opponent: this._teamView(pd.opp, pd.opp.tacticHT),
      tactics: { me: [pd.me.tactic, me2], opponent: [pd.opp.tactic, pd.opp.tacticHT] },
      week: { id: week, points: Number(entry?.points ?? 0), played: Number(entry?.played ?? 0), w: Number(entry?.w ?? 0), d: Number(entry?.d ?? 0), l: Number(entry?.l ?? 0), rank, gained: pts },
      career: totals,
      left: matchesLeft(after.energy, this.now(), 'normal'),
      energy: energyView(after.energy, this.now(), daily?.energyBuys ?? 0),
      bossDone: daily?.boss === true,
      // Kariyer maçı: lig tablosu, hafta ve (sezon bittiyse) sezon sonucu
      season: season ? { final: season.final, prize: season.prize, managerXp: season.managerXp, career: season.view } : null,
      // Kariyer maçı: maç günü gelirleri, ilişkiler, olaylar ve basın toplantısı
      office,
    };
  }

  /** Maçta oynayan kartların genetiğinden parça açar (her oyuncu için FOG.matchChance). */
  async _matchReveals(uid, pd) {
    const ids = Object.values(pd.me?.ids ?? {}).filter(Boolean);
    if (!ids.length) return [];
    const cards = new Map((await this.store.listCards(uid)).map((c) => [c.id, c]));
    const rng = this.random('fog');
    const out = [];
    for (const id of ids) {
      const c = cards.get(id);
      if (!c || !rng.chance(FOG.matchChance)) continue;
      const rev = revealOne(c, rng);
      if (!rev) continue;
      await this.store.updateCard(uid, id, { gx: rev.gx });
      out.push({ cardId: id, name: c.s ?? c.n ?? '', part: rev.part, gx: rev.gx, genetics: maskedGenetics({ ...c, gx: rev.gx }, rev.gx) });
    }
    return out;
  }

  /** Gözlemci raporu: kartın bütün genetiğini açar (oyun kredisiyle). */
  async geneScout({ uid, guest = false, cardId }) {
    this._member(uid, guest);
    const p = await this._profile(uid);
    this._needClub(p);
    const cards = await this.store.listCards(uid);
    const c = cards.find((x) => x.id === cardId);
    if (!c) throw new AppError('not-found', 'Kart bulunamadı.');
    if ((Number(c.gx ?? 0) & FOG.all) === FOG.all) throw new AppError('failed-precondition', 'Bu oyuncunun genetiği zaten açık.');
    const balance = await this.store.changeCredits(uid, -FOG.scoutCost, { earn: false });
    await this.store.updateCard(uid, cardId, { gx: FOG.all });
    return { cardId, cost: FOG.scoutCost, balance, genetics: maskedGenetics({ ...c, gx: FOG.all }, FOG.all) };
  }

  /** Canlı form: gerçek maçlarda formda olan oyuncular (havuzdan) ve kullanıcının formdaki kartları. */
  async liveForm({ uid, guest = false, limit = 20 }) {
    this._member(uid, guest);
    await this.pool.ensure?.();
    const players = (this.pool.all?.() ?? []).filter((x) => Number(x.fm ?? 0) > 0);
    players.sort((a, b) => Number(b.fm) - Number(a.fm) || Number(b.r ?? 0) - Number(a.r ?? 0));
    const cards = uid ? await this.store.listCards(uid) : [];
    const mine = this._live(cards).filter((c) => c.form).map((c) => ({ cardId: c.id, pid: c.pid ?? null, name: c.s ?? c.n ?? '', form: c.form, r: c.r }));
    const n = Math.min(50, Math.max(1, Number(limit) || 20));
    return { top: players.slice(0, n).map((x) => ({ pid: x.id, name: x.s ?? x.n ?? '', team: x.c ?? null, g: x.g ?? null, r: x.r, form: x.fm })), mine };
  }

  /** Mağaza: oyun kredisiyle enerji (fiyat o gün her alımda artar). */
  async energyBuy({ uid, guest = false, item }) {
    this._member(uid, guest);
    const it = ENERGY.shop.find((x) => x.id === item);
    if (!it) throw new AppError('invalid-argument', 'Geçersiz ürün.');
    const p = await this._profile(uid);
    const now = this.now();
    const day = trDay(now);
    const daily = await this.store.getDaily(uid, day);
    const bought = Number(daily?.energyBuys ?? 0);
    const cur = energyNow(p.energy, now);
    if (cur.v >= ENERGY.cap) throw new AppError('failed-precondition', `Enerji deposu dolu (${ENERGY.cap}).`);
    const price = energyPrice(it, bought);
    // Harcama: liderlik tablosunu etkilemez
    const balance = await this.store.changeCredits(uid, -price, { earn: false });
    const energy = addEnergy(p.energy, it.amount, now);
    await this.store.updateProfile(uid, { energy });
    await this.store.incrementDaily(uid, day, 'energyBuys', 1);
    return { energy: energyView(energy, now, bought + 1), added: energy.v - cur.v, price, balance };
  }

  /** Haftalık Kapışma Ligi: ilk 50 ve kullanıcının sırası. */
  async duelBoard({ uid, guest = false }) {
    this._member(uid, guest);
    const week = this._week(this.now());
    // Küme ligi: kullanıcı yalnızca kendi kümesindeki rakiplerle sıralanır
    const p = await this._profile(uid);
    const division = await this.progress.league(uid, p);
    const [all, mine] = await Promise.all([this.store.duelBoardTop(week, 500), this.store.duelBoardEntry(week, uid)]);
    const top = all.filter((e) => Number(e.div ?? START_DIV) === Number(division.div));
    const row = (e, rank) => ({
      rank,
      uid: e.uid,
      username: e.username ?? null,
      photoURL: e.photoURL ?? null,
      points: Number(e.points ?? 0),
      played: Number(e.played ?? 0),
      w: Number(e.w ?? 0),
      d: Number(e.d ?? 0),
      l: Number(e.l ?? 0),
      gf: Number(e.gf ?? 0),
      ga: Number(e.ga ?? 0),
      me: e.uid === uid,
    });
    // Sıralama: eşit puanda averaj, sonra atılan gol
    const sorted = [...top].sort((a, b) => Number(b.points ?? 0) - Number(a.points ?? 0) || Number(b.gf ?? 0) - Number(b.ga ?? 0) - (Number(a.gf ?? 0) - Number(a.ga ?? 0)) || Number(b.gf ?? 0) - Number(a.gf ?? 0));
    const myIdx = sorted.findIndex((e) => e.uid === uid);
    const me = mine ? row(mine, myIdx >= 0 ? myIdx + 1 : null) : null;
    const size = sorted.length;
    // Bölge (settleWeek ile aynı kural): ilk RULES.up yükselir (en az minPlayed maç), son RULES.down düşer (küme kalabalıksa)
    const R = division.rules;
    const zone = (rank, played) => (rank <= R.up && division.div > 1 && played >= R.minPlayed ? 'up' : size >= R.minSize && rank > size - R.down && division.div < START_DIV ? 'down' : null);
    return { week, top: sorted.slice(0, 50).map((e, i) => { const r = row(e, i + 1); return { ...r, zone: zone(r.rank, r.played) }; }), me: me ? { ...me, zone: me.rank ? zone(me.rank, me.played) : null } : null, size, division, resetsAt: this._weekEnd() };
  }

  /** Bu haftanın bittiği an (Türkiye saatiyle pazartesi 00:00). */
  _weekEnd() {
    const local = this.now() + 3 * 3600e3;
    const d = new Date(local);
    const dow = (d.getUTCDay() + 6) % 7; // pazartesi 0
    const startLocal = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY;
    return startLocal + 7 * DAY - 3 * 3600e3;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Kredi liderleri
  // ---------------------------------------------------------------------------------------------------------------

  /** period: 'day' | 'week' | 'month' | 'all'. q: kullanıcı adı araması (tüm zamanlar tablosunda). */
  async leaders({ uid, period = 'all', q = null }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const [d, w, m, all] = this._periods();
    const pid = { day: d, week: w, month: m, all }[period];
    if (!pid) throw new AppError('invalid-argument', 'Geçersiz dönem.');
    if (q && String(q).trim().length >= 2) {
      return { period, search: true, top: await this.store.boardSearch(String(q).trim(), 15), me: null };
    }
    const top = await this.store.boardTop(pid, 50);
    const mine = await this.store.boardEntry(pid, uid);
    const me = mine ? { ...mine, rank: await this.store.boardRank(pid, Number(mine.earned ?? 0)) } : null;
    return { period, top, me };
  }
}

export { DAY };
