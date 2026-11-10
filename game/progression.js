// Oyunda ilerleme: Sezon Yolu, menajer takvimi, özel haftalar, Kapışma Ligi kümeleri, koleksiyon albümü, takas
// görevleri, doğru tahmin ödülü ve ödül dağıtımı (kredi, enerji, paket jetonu). Kurallar road.js, divisions.js, album.js.

import { AppError } from '../errors.js';
import { trDay } from '../progress.js';
import { createRng } from '../engine/rng.js';
import { addEnergy, energyView } from './energy.js';
import { CALENDAR, ROAD, addRoadXp, calendarStep, mysteryReward, roadReward, roadState, roadView, themeEnds, themeOf, tierOf } from './road.js';
import { DIVISIONS, RULES, START_DIV, divOf, settleWeek } from './divisions.js';
import { albumPages, checkExchange, safeKey, weeklyExchanges } from './album.js';
import { PACKS } from './economy.js';

const DAY = 86400e3;

/** Doğru skor tahmini: tahmin puanı başına oyun kredisi (günde en çok cap). */
export const PREDICTION = { perPoint: 20, cap: 400 };

const albumKey = (kind, key) => `${kind}_${safeKey(key)}`;

export class ProgressionService {
  constructor({ game }) {
    this.game = game;
  }

  get store() {
    return this.game.store;
  }

  now() {
    return this.game.now();
  }

  theme() {
    return themeOf(this.now());
  }

  themeView() {
    const t = this.theme();
    return { id: t.id, name: t.name, desc: t.desc, endsAt: themeEnds(this.now()) };
  }

  /** Ödül verir: kredi (oyunla kazanılmış sayılır), enerji (depoyu aşabilir) ya da paket jetonu. */
  async grant(uid, p, reward, pro = null) {
    if (!reward) return null;
    if (reward.type === 'credits') {
      const balance = await this.game._earn(uid, p, reward.amount, pro ?? (await this.game._pro(uid)));
      return { ...reward, balance };
    }
    const fresh = (await this.store.getProfile(uid)) ?? {};
    if (reward.type === 'energy') {
      const energy = addEnergy(fresh.energy, reward.amount, this.now());
      await this.store.updateProfile(uid, { energy });
      return { ...reward, energy: energyView(energy, this.now()) };
    }
    if (reward.type === 'token' && PACKS[reward.pack]) {
      const tokens = { ...(fresh.packTokens ?? {}) };
      tokens[reward.pack] = Number(tokens[reward.pack] ?? 0) + Number(reward.amount ?? 1);
      await this.store.updateProfile(uid, { packTokens: tokens });
      return { ...reward, tokens };
    }
    return null;
  }

  /** Sezon Yolu XP'si. Kademe atlayınca bedava enerji. */
  async xp(uid, amount) {
    if (!(amount > 0)) return null;
    const fresh = (await this.store.getProfile(uid)) ?? {};
    const { road, tiersUp } = addRoadXp(fresh.road, amount, this.now());
    const patch = { road };
    if (tiersUp > 0) patch.energy = addEnergy(fresh.energy, ROAD.levelEnergy * tiersUp, this.now());
    await this.store.updateProfile(uid, patch);
    return { gained: amount, xp: road.xp, tier: tierOf(road.xp), tiersUp, energy: tiersUp > 0 ? ROAD.levelEnergy * tiersUp : 0 };
  }

  roadView(p, pro) {
    return roadView(p.road, this.now(), pro);
  }

  async roadClaim({ uid, guest = false, tier, track = 'free' }) {
    this.game._member(uid, guest);
    const t = Number(tier);
    if (!Number.isInteger(t) || t < 1 || t > ROAD.tiers) throw new AppError('invalid-argument', 'Geçersiz kademe.');
    if (track !== 'free' && track !== 'pro') throw new AppError('invalid-argument', 'Geçersiz yol.');
    const p = await this.game._profile(uid);
    const pro = await this.game._pro(uid);
    if (track === 'pro' && !pro) throw new AppError('permission-denied', 'PRO yol ödülleri PRO üyelere özel.');
    const cur = roadState(p.road, this.now());
    if (tierOf(cur.xp) < t) throw new AppError('failed-precondition', `Bu ödül için ${t}. kademeye ulaş.`);
    const key = `${track === 'pro' ? 'p' : 'f'}${t}`;
    if (cur.claimed?.[key]) throw new AppError('failed-precondition', 'Bu ödülü aldın.');
    await this.store.updateProfile(uid, { road: { ...cur, claimed: { ...(cur.claimed ?? {}), [key]: true } } });
    const reward = await this.grant(uid, p, roadReward(t, track), pro);
    const after = await this.game._profile(uid);
    return { tier: t, track, reward, road: roadView(after.road, this.now(), pro) };
  }

  // ---- Menajer takvimi ----------------------------------------------------------------------------------------
  calendarView(p) {
    const today = trDay(this.now());
    const { step, claimed } = calendarStep(p.cal, today, trDay(this.now() - DAY));
    return {
      step,
      claimed,
      days: CALENDAR.map((r, i) => ({ day: i + 1, reward: r, done: claimed ? i < step : i < step - 1, today: i === step - 1 })),
    };
  }

  async calendarClaim({ uid, guest = false }) {
    this.game._member(uid, guest);
    const p = await this.game._profile(uid);
    const today = trDay(this.now());
    const { step, claimed } = calendarStep(p.cal, today, trDay(this.now() - DAY));
    if (claimed) throw new AppError('failed-precondition', 'Bugünün takvim ödülünü aldın; yarın yeni gün.');
    let reward = CALENDAR[step - 1];
    if (reward.type === 'mystery') reward = { ...mysteryReward(createRng(`cal:${uid}:${today}`)), mystery: true };
    await this.store.updateProfile(uid, { cal: { step, lastDay: today } });
    const applied = await this.grant(uid, p, reward);
    const xp = await this.xp(uid, ROAD.xp.login);
    const after = await this.game._profile(uid);
    return { step, reward: applied, xp, calendar: this.calendarView(after) };
  }

  // ---- Kapışma Ligi kümeleri ----------------------------------------------------------------------------------
  /** Küme bilgisi; yeni haftada geçen haftayı sonuçlandırır (çıkma/düşme, ödül). */
  async league(uid, p) {
    const week = this.game._week(this.now());
    const lg = p.league ?? null;
    if (!lg?.week) {
      const fresh = { div: START_DIV, week };
      await this.store.updateProfile(uid, { league: fresh });
      p.league = fresh;
      return this._leagueView(fresh);
    }
    if (lg.week === week) return this._leagueView(lg);
    const rows = (await this.store.duelBoardTop(lg.week, 500).catch(() => [])).filter((r) => Number(r.div ?? START_DIV) === Number(lg.div));
    const res = settleWeek(rows, uid, lg.div);
    if (res.reward > 0) await this.game._earn(uid, p, res.reward, await this.game._pro(uid));
    const next = { div: res.div, week, last: { week: lg.week, from: Number(lg.div), rank: res.rank, size: res.size, move: res.move, reward: res.reward } };
    await this.store.updateProfile(uid, { league: next });
    p.league = next;
    return this._leagueView(next);
  }

  _leagueView(lg) {
    const d = divOf(lg.div);
    return { div: d.id, name: d.name, prize: d.prize, base: d.base, rules: RULES, divisions: DIVISIONS.map((x) => ({ id: x.id, name: x.name })), last: lg.last ?? null };
  }

  // ---- Koleksiyon albümü --------------------------------------------------------------------------------------
  async album({ uid, guest = false, kind = 'club' }) {
    this.game._member(uid, guest);
    if (kind !== 'club' && kind !== 'nation') throw new AppError('invalid-argument', 'Geçersiz albüm.');
    await this.game.pool.ensure?.();
    const [p, cards] = await Promise.all([this.game._profile(uid), this.store.listCards(uid)]);
    const claimed = this._albumClaimed(p, kind);
    const pages = albumPages(kind, this.game.pool.all(), cards, claimed);
    const mine = pages.filter((pg) => pg.owned > 0);
    return {
      kind,
      pages: mine.slice(0, 80),
      completed: mine.filter((pg) => pg.tiers.length && pg.tiers.every((t) => t.done)).length,
      ready: mine.reduce((a, pg) => a + pg.tiers.filter((t) => t.done && !t.claimed).length, 0),
      total: pages.length,
    };
  }

  _albumClaimed(p, kind) {
    const out = {};
    for (const [k, v] of Object.entries(p.album ?? {})) if (k.startsWith(`${kind}_`)) out[`${kind}:${k.slice(kind.length + 1)}`] = v;
    return out;
  }

  async albumClaim({ uid, guest = false, kind = 'club', key, tier }) {
    this.game._member(uid, guest);
    const t = Number(tier);
    await this.game.pool.ensure?.();
    const [p, cards] = await Promise.all([this.game._profile(uid), this.store.listCards(uid)]);
    const pages = albumPages(kind, this.game.pool.all(), cards, this._albumClaimed(p, kind));
    const page = pages.find((pg) => safeKey(pg.key) === safeKey(key));
    if (!page) throw new AppError('not-found', 'Albüm sayfası bulunamadı.');
    const row = page.tiers[t - 1];
    if (!row) throw new AppError('invalid-argument', 'Geçersiz kademe.');
    if (row.claimed) throw new AppError('failed-precondition', 'Bu ödülü aldın.');
    if (!row.done) throw new AppError('failed-precondition', `Bu ödül için ${row.need} farklı oyuncu topla (${page.owned}/${row.need}).`);
    if (t > 1 && !page.tiers[t - 2].claimed) throw new AppError('failed-precondition', 'Önce önceki kademenin ödülünü al.');
    await this.store.updateProfile(uid, { album: { ...(p.album ?? {}), [albumKey(kind, page.key)]: t } });
    const reward = await this.grant(uid, p, row.reward);
    const xp = await this.xp(uid, ROAD.xp.album);
    return { kind, key: page.key, tier: t, reward, xp };
  }

  // ---- Takas görevleri ----------------------------------------------------------------------------------------
  exchangesView(p) {
    const week = this.game._week(this.now());
    const done = p.exchanges?.week === week ? (p.exchanges.done ?? []) : [];
    return { week, list: weeklyExchanges(week).map((e) => ({ id: e.id, title: e.title, need: e.need, reward: e.reward, done: done.includes(e.id) })) };
  }

  async exchangeSubmit({ uid, guest = false, id, cards: ids }) {
    this.game._member(uid, guest);
    const week = this.game._week(this.now());
    const ex = weeklyExchanges(week).find((e) => e.id === id);
    if (!ex) throw new AppError('not-found', 'Bu hafta böyle bir takas görevi yok.');
    if (!Array.isArray(ids) || new Set(ids).size !== ids.length) throw new AppError('invalid-argument', 'Kartları seç.');
    const [p, cards, squads] = await Promise.all([this.game._profile(uid), this.store.listCards(uid), this.store.listSquads(uid)]);
    const done = p.exchanges?.week === week ? (p.exchanges.done ?? []) : [];
    if (done.includes(id)) throw new AppError('failed-precondition', 'Bu takası bu hafta yaptın.');
    const owned = new Map(cards.map((c) => [c.id, c]));
    const inSquad = new Set(squads.flatMap((s) => Object.values(s.slots ?? {})));
    const chosen = [];
    for (const cid of ids) {
      const c = owned.get(cid);
      if (!c) throw new AppError('not-found', 'Kart bulunamadı.');
      if (inSquad.has(cid)) throw new AppError('failed-precondition', `${c.s ?? c.n} bir kadroda; önce kadrodan çıkar.`);
      chosen.push(c);
    }
    const err = checkExchange(ex, chosen);
    if (err) throw new AppError('failed-precondition', err);
    await this.store.deleteCards(uid, ids);
    await this.store.updateProfile(uid, { exchanges: { week, done: [...done, id] } });
    const reward = await this.grant(uid, p, ex.reward);
    const xp = await this.xp(uid, ROAD.xp.exchange);
    return { id, given: ids.length, reward, xp };
  }

  // ---- Doğru tahmin → oyun kredisi ----------------------------------------------------------------------------
  /** Skor tahmini puanlanınca (tahmin ligi çağırır): puan başına kredi, günde en çok PREDICTION.cap. */
  async predictionReward({ uid, points, exact = false }) {
    if (!uid || !(points > 0)) return null;
    const day = trDay(this.now());
    const daily = await this.store.getDaily(uid, day);
    const got = Number(daily?.predCredits ?? 0);
    const amount = Math.min(PREDICTION.cap - got, Math.round(points * PREDICTION.perPoint));
    if (amount <= 0) return null;
    const p = await this.store.getProfile(uid);
    if (!p) return null; // oyuna hiç girmemiş kullanıcıya profil açılmaz
    await this.store.incrementDaily(uid, day, 'predCredits', amount);
    const balance = await this.game._earn(uid, p, amount, await this.game._pro(uid));
    await this.xp(uid, ROAD.xp.prediction).catch(() => null);
    return { amount, exact, balance };
  }
}
