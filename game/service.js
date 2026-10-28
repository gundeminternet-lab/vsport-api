// Oyunlar: kredi, günlük bonus yolu, görevler, Fotoğraftan Bil, bilgi yarışması, Benim 11'im (paketler, kadro,
// kapışma) ve kredi liderleri. Bütün sonuçlar sunucuda belirlenir; uygulama yalnızca gösterir.

import { randomInt } from 'node:crypto';

import { AppError } from '../errors.js';
import { periodIds } from '../league.js';
import { trDay } from '../progress.js';
import { createRng } from '../engine/rng.js';
import { BONUS_PATH, DUEL, MAX_SQUADS, MISSIONS, PACKS, PHOTO, QUIZ, SELL_PRICE, START_CREDITS, TIER_RANGE } from './economy.js';
import { REGIONS } from './nations.js';
import { fold, tierOf } from './pool.js';
import { buildQuestions } from './quiz.js';
import { autoBuild, evaluate, FORMATIONS, slotsOf, teamPower, validateSquad } from './squad.js';
import { simulateDuel } from './duel.js';

const DAY = 86400e3;

/** Kart olarak saklanan alanlar (havuzdaki kompakt oyuncu + oyuncu kimliği + katman). */
const asCard = (p) => ({ pid: p.id, n: p.n, s: p.s, pos: p.pos, g: p.g, r: p.r, st: p.st, c: p.c, ci: p.ci, cl: p.cl ?? null, l: p.l, na: p.na ?? null, ni: p.ni ?? null, ph: p.ph ?? null, tier: tierOf(p.r) });

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
    this._quiz = new Map(); // oturum → { uid, day, questions, index, askedAt, score, pro }
  }

  _member(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Oyunlar için Google ile giriş yap.');
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
    const [p, daily, pro] = await Promise.all([this._profile(uid), this.store.getDaily(uid, day), this._pro(uid)]);
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
      duels: { left: Math.max(0, DUEL.daily - Number(daily?.duels ?? 0)), daily: DUEL.daily, rewards: { win: DUEL.win, draw: DUEL.draw, loss: DUEL.loss }, last: (p.duels ?? []).slice(0, 10) },
      missions: MISSIONS.map((m) => ({ id: m.id, title: m.title, reward: m.reward, done: m.done(daily), claimed: daily?.claimed?.[m.id] === true })),
      packs: Object.values(PACKS).map((k) => ({ id: k.id, name: k.name, cost: k.cost, count: k.count, desc: k.desc, daily: k.daily === true, guaranteed: k.guaranteed ?? 0 })),
      formations: FORMATIONS,
      maxSquads: MAX_SQUADS,
      poolReady: this.pool.ready,
    };
  }

  async claimBonus({ uid, guest = false }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const p = await this._profile(uid);
    if (p.bonus?.lastDay === day) throw new AppError('failed-precondition', 'Bugünün ödülünü zaten topladın; yarın yeni adım seni bekliyor.');
    const step = (Number(p.bonus?.step ?? 0) % BONUS_PATH.length) + 1;
    const reward = BONUS_PATH[step - 1];
    await this.store.updateProfile(uid, { bonus: { step, lastDay: day } });
    await this.store.updateDaily(uid, day, { bonus: true });
    const balance = await this._earn(uid, p, reward, await this._pro(uid));
    return { step, reward, balance, grandFinale: step === BONUS_PATH.length };
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

  _drawPack(pack, rng) {
    const all = this.pool.all();
    if (all.length < 50) throw new AppError('unavailable', 'Oyuncu listesi hazırlanıyor; birkaç dakika sonra tekrar dene.');
    const inTier = (t) => {
      const [lo, hi] = TIER_RANGE[t];
      return (p) => p.r >= lo && p.r <= hi;
    };
    const out = [];
    const taken = new Set();
    const g = pack.guaranteed ?? 0;
    for (let i = 0; i < pack.count; i++) {
      let filter;
      if (i < g) filter = (p) => p.r >= 80;
      else filter = inTier(this._rollTier(pack.weights, rng));
      let [p] = this.pool.pick(filter, rng, 1, taken);
      // O katmanda kart kalmadıysa en yakın katmandan
      if (!p) [p] = this.pool.pick(() => true, rng, 1, taken);
      if (!p) break;
      taken.add(p.id);
      out.push(asCard(p));
    }
    // En iyi kartlar sonda açılır (heyecan)
    return out.sort((a, b) => a.r - b.r);
  }

  async openPack({ uid, guest = false, pack }) {
    this._member(uid, guest);
    const def = PACKS[pack];
    if (!def) throw new AppError('invalid-argument', 'Geçersiz paket.');
    await this.pool.ensure?.();
    const day = trDay(this.now());
    if (def.daily) {
      const daily = await this.store.getDaily(uid, day);
      if (daily?.freePack) throw new AppError('failed-precondition', 'Günlük ücretsiz paketini açtın; yarın yenisi gelir.');
    }
    await this._profile(uid);
    const cards = this._drawPack(def, this.random(`pack:${pack}`));
    const { balance, ids } = await this.store.purchase(uid, def.cost, cards);
    await this.store.updateDaily(uid, day, def.daily ? { freePack: true } : {});
    await this.store.incrementDaily(uid, day, 'packs', 1);
    return { pack: def.id, balance, cards: cards.map((c, i) => ({ id: ids[i], ...c })) };
  }

  /** Hoşgeldin paketi: seçilen bölgenin liginde oynayanlar ve milli takımından 18 oyuncu (2 KL, 6 DEF, 6 OS, 4 FV). */
  async welcomePack({ uid, guest = false, region }) {
    this._member(uid, guest);
    const r = REGIONS[region];
    if (!r) throw new AppError('invalid-argument', 'Geçersiz bölge.');
    const p = await this._profile(uid);
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
    await this.store.deleteCards(uid, ids);
    // Satıştan gelen kredi liderlik tablosuna yazılmaz (oyunla kazanılmadı)
    const balance = await this.store.changeCredits(uid, total, { earn: false });
    return { sold: ids.length, credits: total, balance };
  }

  async _duelSummary(uid, p, squads, cards) {
    const owned = new Map(cards.map((c) => [c.id, c]));
    let best = null;
    for (const s of squads) {
      const v = validateSquad(s, owned);
      if (!v.ok) continue;
      const power = teamPower(v.ev);
      if (!best || power > best.power) best = { s, v, power };
    }
    if (!best) {
      await this.store.deleteDuelPool(uid).catch(() => {});
      return;
    }
    await this.store.upsertDuelPool(uid, {
      username: p.username ?? null,
      name: best.v.name,
      formation: best.s.formation,
      rating: best.v.ev.rating,
      chemistry: best.v.ev.chemistry,
      power: Math.round(best.power * 10) / 10,
      lineup: Object.fromEntries(Object.entries(best.v.lineup).map(([k, c]) => [k, { g: c.g, r: c.r, s: c.s, ci: c.ci, na: c.na, l: c.l }])),
    });
  }

  async saveSquad({ uid, guest = false, id = null, name, formation, slots }) {
    this._member(uid, guest);
    const [cards, squads, p] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    if (!id && squads.length >= MAX_SQUADS) throw new AppError('failed-precondition', `En fazla ${MAX_SQUADS} kadro kurabilirsin.`);
    if (id && !squads.some((s) => s.id === id)) throw new AppError('not-found', 'Kadro bulunamadı.');
    const owned = new Map(cards.map((c) => [c.id, c]));
    const v = validateSquad({ name, formation, slots }, owned);
    if (!v.ok) throw new AppError('invalid-argument', v.error);
    const clean = Object.fromEntries(slotsOf(formation).map((s) => [s.key, slots[s.key]]));
    const data = { name: v.name, formation, slots: clean, chemistry: v.ev.chemistry, rating: v.ev.rating, power: Math.round(teamPower(v.ev) * 10) / 10 };
    const sid = await this.store.saveSquad(uid, id, data);
    const all = [...squads.filter((s) => s.id !== sid), { id: sid, ...data }];
    await this._duelSummary(uid, p, all, cards);
    return { id: sid, ...data };
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
      return { name: o.name, username: o.username ?? null, formation: o.formation, lineup: o.lineup, bot: false };
    }
    const target = Math.round(power - 1);
    const cands = this.pool.pick((p) => Math.abs(p.r - target) <= 5, rng, 40);
    const formation = FORMATIONS[rng.int(0, 3)];
    const lineup = autoBuild(cands.map(asCard), formation, 'balanced');
    return { name: 'Karma Takım', username: null, formation, lineup, bot: true };
  }

  async duel({ uid, guest = false, squadId }) {
    this._member(uid, guest);
    const day = trDay(this.now());
    const [daily, cards, squads, p] = await Promise.all([this.store.getDaily(uid, day), this.store.listCards(uid), this.store.listSquads(uid), this._profile(uid)]);
    if (Number(daily?.duels ?? 0) >= DUEL.daily) throw new AppError('resource-exhausted', 'Bugünkü kapışma hakların bitti; yarın 3 yeni hak.');
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
    await this.store.updateProfile(uid, { duels: [record, ...(p.duels ?? [])].slice(0, 10) });
    const balance = await this._earn(uid, p, reward, await this._pro(uid));
    const oe = evaluate(opp.formation, opp.lineup);
    return {
      ...sim,
      reward,
      balance,
      me: { name: v.name, rating: v.ev.rating, chemistry: v.ev.chemistry },
      opponent: { name: opp.name, username: opp.username, bot: opp.bot, rating: oe.rating, chemistry: oe.chemistry },
      left: DUEL.daily - Number(daily?.duels ?? 0) - 1,
    };
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
