// Sosyal akış: gönderi (metin + isteğe bağlı maç kartı, anket, skor düellosu, alıntı, Benim 11'im, kupon, puan kartı),
// tepkiler (alev, gol, şaşkın, gülme), yanıtlı yorumlar, @bahsetme, takip, bildirimler, kullanıcı profili, maç odası
// sayıları ve kendiliğinden düşen kartlar (gol, maç sonu, günün AI maçı). Yazma işlemleri sunucudan (sayaçlar tutarlı
// kalsın); okuma istemciden.
//
//   posts/{id}                    { uid, username, photoURL, level, acc, team, text, tags, mentions, match?, poll?, duel?,
//                                   quote?, squad?, coupon?, ratings?, auto?, reactions, likeCount, commentCount, createdMs }
//   posts/{id}/likes/{uid}        { at, r }   (tepki türü r: fire | goal | wow | lol)
//   posts/{id}/comments/{id}      { uid, username, photoURL, text, replyTo?, createdAt }
//   posts/{id}/votes/{uid}        { o, at }   posts/{id}/duel/{uid} { home, away, username, photoURL, at, result?, reward? }
//   social_follows/{uid}          { following: [uid] }
//   social_profiles/{uid}         { followers, following, posts, comments, bio, team, dmOpen, n, hits, exact, duelWins,
//                                   duelPlayed, rated, unread, readAt, lastSeenMs }
//   social_profiles/{uid}/duels/{postId}   skor düellosu geçmişi
//   social_notifs/{uid}/items/{id}         bildirimler (tepkiler gönderi başına tek satırda toplanır)
//   social_tags/{gün}             { counts: { etiket: { n, label } } }     presence/{uid} { at, day }

import { AppError } from './errors.js';
import { levelOf, trDay } from './progress.js';
import {
  DUEL,
  REACTIONS,
  accuracy,
  cleanCoupon,
  cleanPoll,
  cleanRatings,
  cleanScore,
  cleanSquad,
  duelResult,
  duelReward,
  extractMentions,
  quoteOf,
  teamOf,
  weekOf,
} from './social_rules.js';

export const POST_MAX = 500;
export const COMMENT_MAX = 300;
export const BIO_MAX = 160;
const POST_GAP_MS = 20e3;
const COMMENT_GAP_MS = 5e3;
const ACTION_GAP_MS = 700;
const MAX_FOLLOWING = 500;
export const SYSTEM_UID = 'vsport';

/** Kendiliğinden gol ve maç sonu kartı açılan ligler (akış dolsun ama boğulmasın). */
export const AUTO_LEAGUES = new Set(['tur.1', 'eng.1', 'esp.1', 'ita.1', 'ger.1', 'fra.1', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'uefa.nations', 'fifa.world', 'uefa.euro']);

/** "#Galatasaray maçı #SüperLig" → [{ key: 'galatasaray', label: '#Galatasaray' }, ...] (en çok 5, tekrar yok). */
export function extractTags(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(/#([\p{L}\p{N}_]{2,30})/gu)) {
    const key = m[1].toLocaleLowerCase('tr');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: `#${m[1]}` });
    if (out.length >= 5) break;
  }
  return out;
}

/** Gönderiye eklenen maç kartı: yalnızca bilinen alanlar, kısaltılmış. */
export function cleanMatch(m) {
  if (!m || typeof m !== 'object') return null;
  const s = (v, n = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const league = s(m.league, 30);
  const eventId = s(m.eventId, 20);
  if (!league || !eventId || !/^[a-z0-9._]+$/i.test(league) || !/^[0-9]+$/.test(eventId)) return null;
  const kickoff = s(m.kickoff, 30);
  return {
    key: `${league.replace(/[^a-zA-Z0-9]/g, '_')}_${eventId}`,
    league,
    eventId,
    home: s(m.home) ?? '',
    away: s(m.away) ?? '',
    homeLogo: s(m.homeLogo, 300),
    awayLogo: s(m.awayLogo, 300),
    kickoff: kickoff && Number.isFinite(Date.parse(kickoff)) ? kickoff : null,
    pick: s(m.pick, 30),
    pct: Number.isInteger(m.pct) && m.pct >= 0 && m.pct <= 100 ? m.pct : null,
  };
}

const snippet = (t, n = 80) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export class SocialService {
  /**
   * store: createSocialStore.  isAdmin: async (uid) → bool.
   * missions: MissionService (görev sayaçları), community: CommunityService (topluluk ve Taraftar Savaşı),
   * reward: async (uid, ödül) → düello kredisi, brief: async (uid) → { club, creditRank } (profil için).
   */
  constructor({ store, now = () => Date.now(), isAdmin = null, missions = null, community = null, reward = null, brief = null, log = console }) {
    this.store = store;
    this.now = now;
    this.isAdmin = isAdmin;
    this.missions = missions;
    this.community = community;
    this.reward = reward;
    this.brief = brief;
    this.log = log;
    this._lastPost = new Map();
    this._lastComment = new Map();
    this._lastAction = new Map();
    this._presence = new Map();
    this._seen = new Map();
    this._rooms = new Map();
    this._users = new Map();
    this._stats = null;
  }

  async _author(uid, guest) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Paylaşmak için Google ile giriş yap.');
    const u = await this.store.getUser(uid);
    if (!u) throw new AppError('permission-denied', 'Profil bulunamadı.');
    if (u.banned === true) throw new AppError('permission-denied', 'Hesabın paylaşıma kapalı.');
    if (!u.username) throw new AppError('failed-precondition', 'Önce kullanıcı adını belirle.');
    return u;
  }

  _member(uid, guest, what = 'Bunun için') {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', `${what} Google ile giriş yap.`);
  }

  _gap(map, uid, ms, message) {
    const at = map.get(uid) ?? 0;
    if (this.now() - at < ms) throw new AppError('resource-exhausted', message);
    map.set(uid, this.now());
    if (map.size > 5000) map.clear();
  }

  _track(uid, kind, n = 1) {
    if (!this.missions || !uid || uid === SYSTEM_UID) return;
    this.missions.track(uid, kind, n).catch((e) => this.log.warn?.('[social] görev sayacı', e?.message ?? e));
  }

  async _notify(uid, item, agg = null) {
    if (!uid || uid === SYSTEM_UID || uid === item.from?.uid) return;
    try {
      await this.store.notify(uid, { ...item, at: this.now() }, agg);
    } catch (e) {
      this.log.warn?.('[social] bildirim yazılamadı', e?.message ?? e);
    }
  }

  _from(uid, u) {
    return { uid, username: u.username, photoURL: u.photoURL ?? null };
  }

  /** @bahsetmeler → kullanıcı kimlikleri (kendisi hariç, en çok 5). */
  async _mentions(text, self) {
    const names = extractMentions(text);
    const out = [];
    for (const n of names) {
      const id = await this.store.uidOfUsername(n).catch(() => null);
      if (id && id !== self && !out.includes(id)) out.push(id);
    }
    return out;
  }

  /** Yazarın gönderiye işlenen kimliği: seviye, tahmin isabeti, topluluk. */
  async _badge(uid) {
    const [stats, prof] = await Promise.all([this.store.getStats(uid).catch(() => null), this.store.getProfile(uid).catch(() => null)]);
    const n = Number(prof?.n ?? 0);
    return {
      level: levelOf(Number(stats?.xp ?? 0)).level,
      acc: n >= 5 ? accuracy(n, Number(prof?.hits ?? 0)) : null,
      team: prof?.team?.id ?? null,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Gönderi
  // ---------------------------------------------------------------------------------------------------------------

  async post({ uid, guest = false, text, match = null, poll = null, duel = null, quoteId = null, squad = null, coupon = null, ratings = null }) {
    const u = await this._author(uid, guest);
    const body = String(text ?? '').trim();
    const now = this.now();
    const extras = {
      poll: poll ? cleanPoll(poll, now) : null,
      squad: squad ? cleanSquad(squad) : null,
      coupon: coupon ? cleanCoupon(coupon) : null,
      ratings: ratings ? cleanRatings(ratings) : null,
    };
    if (poll && !extras.poll) throw new AppError('invalid-argument', 'Anket 2-4 farklı seçenek ister.');
    if (squad && !extras.squad) throw new AppError('invalid-argument', 'Kadro kartı okunamadı.');
    if (coupon && !extras.coupon) throw new AppError('invalid-argument', 'Kupon okunamadı.');
    if (ratings && !extras.ratings) throw new AppError('invalid-argument', 'Puan kartı okunamadı.');
    const m = cleanMatch(match);
    let duelDoc = null;
    let guess = null;
    if (duel) {
      guess = cleanScore(duel);
      const kickoffMs = m?.kickoff ? Date.parse(m.kickoff) : NaN;
      if (!m || !guess) throw new AppError('invalid-argument', 'Skor düellosu için maç ve skor tahmini seç.');
      if (!(kickoffMs - now >= DUEL.minLeadMs)) throw new AppError('failed-precondition', 'Düello maç başlamadan en az 5 dakika önce açılır.');
      duelDoc = { key: m.key, kickoffMs, status: 'open', n: 1, top: [{ username: u.username, h: guess.home, a: guess.away }], final: null };
    }
    let quote = null;
    if (quoteId) {
      if (typeof quoteId !== 'string' || !/^[A-Za-z0-9_-]{4,60}$/.test(quoteId)) throw new AppError('invalid-argument', 'Geçersiz gönderi.');
      quote = quoteOf(quoteId, await this.store.getPost(quoteId));
      if (!quote) throw new AppError('not-found', 'Alıntılanan gönderi bulunamadı.');
    }
    const attached = [extras.poll, duelDoc, quote, extras.squad, extras.coupon, extras.ratings].filter(Boolean).length;
    if (attached > 1) throw new AppError('invalid-argument', 'Bir gönderiye tek ek eklenebilir.');
    if (!body && !attached) throw new AppError('invalid-argument', 'Bir şeyler yaz.');
    if (extras.poll && body.length < 3) throw new AppError('invalid-argument', 'Anket sorusunu yaz.');
    if (body.length > POST_MAX) throw new AppError('invalid-argument', `Gönderi en fazla ${POST_MAX} karakter olabilir.`);
    this._gap(this._lastPost, uid, POST_GAP_MS, 'Biraz bekle; art arda gönderi paylaşılamaz.');
    const tags = extractTags(body);
    const [mentions, badge] = await Promise.all([this._mentions(body, uid), this._badge(uid)]);
    const doc = {
      uid,
      username: u.username,
      photoURL: u.photoURL ?? null,
      level: badge.level,
      acc: badge.acc,
      team: badge.team,
      text: body,
      // Topluluk akışı için gizli etiket (etiket dizini kullanılır, gündeme sayılmaz)
      tags: [...tags.map((t) => t.key), ...(badge.team ? [`team_${badge.team}`] : [])],
      mentions,
      match: m,
      poll: extras.poll,
      duel: duelDoc,
      quote,
      squad: extras.squad,
      coupon: extras.coupon,
      ratings: extras.ratings,
      reactions: Object.fromEntries(REACTIONS.map((r) => [r, 0])),
      likeCount: 0,
      commentCount: 0,
      createdMs: now,
    };
    const id = await this.store.addPost(doc);
    if (duelDoc) {
      await this.store.addDuelEntry(id, uid, { home: guess.home, away: guess.away, username: u.username, photoURL: u.photoURL ?? null, at: now });
      await this.store.ensureWatched({ key: m.key, league: m.league, eventId: m.eventId, kickoffMs: duelDoc.kickoffMs }).catch(() => null);
    }
    if (tags.length) await this.store.countTags(trDay(now), tags);
    await this.store.bumpProfile(uid, { posts: 1 });
    const from = this._from(uid, u);
    for (const target of mentions) await this._notify(target, { type: 'mention', from, postId: id, text: snippet(body) });
    if (quote && quote.uid && !mentions.includes(quote.uid)) await this._notify(quote.uid, { type: 'quote', from, postId: id, text: snippet(body) });
    this._track(uid, 'post');
    return { id, ...doc };
  }

  /** Tepki bırak / değiştir / kaldır (reaction: null). */
  async react({ uid, guest = false, postId, reaction }) {
    this._member(uid, guest, 'Tepki için');
    if (typeof postId !== 'string' || !postId) throw new AppError('invalid-argument', 'Geçersiz gönderi.');
    const r = reaction === null ? null : REACTIONS.includes(reaction) ? reaction : undefined;
    if (r === undefined) throw new AppError('invalid-argument', 'Geçersiz tepki.');
    this._gap(this._lastAction, uid, ACTION_GAP_MS, 'Biraz yavaş.');
    const res = await this.store.setReaction(postId, uid, r);
    if (res === null) throw new AppError('not-found', 'Gönderi bulunamadı.');
    if (res.prev === null && r !== null) {
      this._track(uid, 'react');
      if (res.author && res.author !== uid && res.author !== SYSTEM_UID) {
        this._track(res.author, 'reactsRecv');
        const u = await this.store.getUser(uid).catch(() => null);
        if (u?.username) {
          await this._notify(res.author, { type: 'react', from: this._from(uid, u), postId, text: snippet(res.text), r }, `react_${postId}`);
        }
        if (weekOf(res.createdMs || 0) === weekOf(this.now())) {
          await this.store.weekBestPost(weekOf(this.now()), { postId, uid: res.author, username: res.username ?? null, n: res.likeCount, text: snippet(res.text, 60) }).catch(() => null);
        }
      }
    }
    return { reaction: res.reaction, reactions: res.reactions, likeCount: res.likeCount };
  }

  /** Eski uygulama: beğeni = alev tepkisi. */
  async like({ uid, guest = false, postId, like = true }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Beğenmek için Google ile giriş yap.');
    if (typeof postId !== 'string' || !postId) throw new AppError('invalid-argument', 'Geçersiz gönderi.');
    const res = await this.store.setReaction(postId, uid, like === true ? 'fire' : null, { keep: like === true });
    if (res === null) throw new AppError('not-found', 'Gönderi bulunamadı.');
    if (res.prev === null && res.reaction) this._track(uid, 'react');
    return { liked: res.reaction !== null, likeCount: res.likeCount };
  }

  async comment({ uid, guest = false, postId, text, replyTo = null }) {
    const u = await this._author(uid, guest);
    const body = String(text ?? '').trim();
    if (!body) throw new AppError('invalid-argument', 'Yorum boş olamaz.');
    if (body.length > COMMENT_MAX) throw new AppError('invalid-argument', `Yorum en fazla ${COMMENT_MAX} karakter olabilir.`);
    if (typeof postId !== 'string' || !postId) throw new AppError('invalid-argument', 'Geçersiz gönderi.');
    this._gap(this._lastComment, uid, COMMENT_GAP_MS, 'Biraz bekle; art arda yorum yazılamaz.');
    let reply = null;
    if (replyTo) {
      const parent = typeof replyTo === 'string' && /^[A-Za-z0-9_-]{4,60}$/.test(replyTo) ? await this.store.getComment(postId, replyTo) : null;
      if (!parent) throw new AppError('not-found', 'Yanıtlanan yorum bulunamadı.');
      // Yanıtın yanıtı ilk yoruma bağlanır (tek seviye)
      reply = { id: parent.replyTo?.id ?? replyTo, uid: parent.uid ?? null, username: parent.username ?? 'kullanıcı' };
    }
    const mentions = await this._mentions(body, uid);
    const r = await this.store.addComment(postId, { uid, username: u.username, photoURL: u.photoURL ?? null, text: body, replyTo: reply, mentions });
    if (r === null) throw new AppError('not-found', 'Gönderi bulunamadı.');
    await this.store.bumpProfile(uid, { comments: 1 }).catch(() => null);
    const from = this._from(uid, u);
    const told = new Set([uid]);
    if (reply?.uid && !told.has(reply.uid)) {
      told.add(reply.uid);
      await this._notify(reply.uid, { type: 'reply', from, postId, text: snippet(body) });
    }
    if (r.author && !told.has(r.author)) {
      told.add(r.author);
      await this._notify(r.author, { type: 'comment', from, postId, text: snippet(body) });
    }
    for (const m of mentions) {
      if (told.has(m)) continue;
      told.add(m);
      await this._notify(m, { type: 'mention', from, postId, text: snippet(body) });
    }
    this._track(uid, 'comment');
    return { id: r.id, commentCount: r.commentCount };
  }

  async remove({ uid, postId }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const post = await this.store.getPost(postId);
    if (!post) throw new AppError('not-found', 'Gönderi bulunamadı.');
    if (post.uid !== uid && !(this.isAdmin && (await this.isAdmin(uid).catch(() => false)))) {
      throw new AppError('permission-denied', 'Yalnızca kendi gönderini silebilirsin.');
    }
    if (post.duel?.status === 'open' && post.uid === uid && Number(post.duel.n ?? 0) > 1) {
      throw new AppError('failed-precondition', 'Katılımcısı olan açık düello silinemez; maçtan sonra silebilirsin.');
    }
    await this.store.deletePost(postId);
    if (post.uid !== SYSTEM_UID) await this.store.bumpProfile(post.uid, { posts: -1 });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Anket ve skor düellosu
  // ---------------------------------------------------------------------------------------------------------------

  async vote({ uid, guest = false, postId, option }) {
    this._member(uid, guest, 'Oy vermek için');
    if (typeof postId !== 'string' || !postId || !Number.isInteger(option) || option < 0 || option > 3) throw new AppError('invalid-argument', 'Geçersiz oy.');
    const r = await this.store.vote(postId, uid, option, this.now());
    if (r === null) throw new AppError('not-found', 'Anket bulunamadı.');
    if (r === 'closed') throw new AppError('failed-precondition', 'Anket kapandı.');
    if (r === 'invalid') throw new AppError('invalid-argument', 'Geçersiz seçenek.');
    if (!r.same) this._track(uid, 'vote');
    return { option: r.option, counts: r.counts, total: r.total };
  }

  async duelJoin({ uid, guest = false, postId, home, away }) {
    const u = await this._author(uid, guest);
    const g = cleanScore({ home, away });
    if (!g || typeof postId !== 'string' || !postId) throw new AppError('invalid-argument', 'Skor tahminini seç.');
    const r = await this.store.duelJoin(postId, uid, { home: g.home, away: g.away, username: u.username, photoURL: u.photoURL ?? null, at: this.now() }, this.now());
    if (r === null) throw new AppError('not-found', 'Düello bulunamadı.');
    if (r === 'closed') throw new AppError('failed-precondition', 'Maç başladı; düello kapandı.');
    if (r === 'exists') throw new AppError('failed-precondition', 'Bu düelloya zaten katıldın; tahmin kilitli.');
    if (r.author && r.author !== uid) {
      await this._notify(r.author, { type: 'duel_join', from: this._from(uid, u), postId, text: `${g.home}-${g.away}` }, `duel_${postId}`);
    }
    return { n: r.n, top: r.top };
  }

  /** Maç bitti (izleyici çağırır): o maçın açık düelloları sonuçlanır, kazananlara kredi. */
  async settleMatch({ key, homeGoals, awayGoals }) {
    if (!key || !Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return 0;
    const final = { home: homeGoals, away: awayGoals };
    const posts = await this.store.openDuels(key);
    let settled = 0;
    for (const p of posts) {
      const entries = await this.store.duelEntries(p.id);
      const results = [];
      for (const e of entries) {
        const result = duelResult(e, final);
        let reward = 0;
        const base = duelReward(result);
        if (base > 0 && (await this.store.claimDuelPay(e.uid, key))) {
          reward = this.missions ? await this.missions.duelAllowance(e.uid, base).catch(() => 0) : base;
          if (reward > 0 && this.reward) {
            try {
              await this.reward(e.uid, { type: 'credits', amount: reward });
            } catch (err) {
              this.log.warn?.('[social] düello ödülü verilemedi', err?.message ?? err);
              reward = 0;
            }
          }
        }
        results.push({ uid: e.uid, result, reward });
      }
      await this.store.finishDuel(p.id, `${homeGoals}-${awayGoals}`, results);
      const m = p.duel ?? {};
      const title = p.match ? `${p.match.home} - ${p.match.away}` : '';
      for (const r of results) {
        const e = entries.find((x) => x.uid === r.uid);
        const hit = r.result !== 'miss';
        await this.store
          .addDuelHistory(r.uid, p.id, { key, title, guess: `${e.home}-${e.away}`, final: `${homeGoals}-${awayGoals}`, result: r.result, reward: r.reward, at: this.now(), kickoffMs: m.kickoffMs ?? null })
          .catch(() => null);
        await this.store.bumpProfile(r.uid, { duelPlayed: 1, duelWins: hit ? 1 : 0 }).catch(() => null);
        if (hit) {
          this._track(r.uid, 'duelWin');
          const wins = this.missions ? await this.missions.weekCount(r.uid, 'duelWin').catch(() => 0) : 0;
          if (wins) await this.store.weekDuelMaster(weekOf(this.now()), { uid: r.uid, username: e.username ?? null, wins }).catch(() => null);
        }
        if (this.community) await this.community.record({ uid: r.uid, hit, exact: r.result === 'exact', username: e.username ?? null }).catch(() => null);
        const text =
          r.result === 'exact'
            ? `Tam isabet! ${title} ${homeGoals}-${awayGoals}`
            : r.result === 'outcome'
              ? `Doğru sonuç: ${title} ${homeGoals}-${awayGoals} (tahminin ${e.home}-${e.away})`
              : `${title} ${homeGoals}-${awayGoals} bitti; tahminin ${e.home}-${e.away}`;
        await this._notify(r.uid, { type: 'duel_result', from: null, postId: p.id, text, result: r.result, reward: r.reward });
      }
      settled++;
    }
    return settled;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Takip, bildirim, profil
  // ---------------------------------------------------------------------------------------------------------------

  async follow({ uid, guest = false, target, follow = true }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Takip için Google ile giriş yap.');
    if (typeof target !== 'string' || !target || target === uid || target === SYSTEM_UID) throw new AppError('invalid-argument', 'Geçersiz kullanıcı.');
    const r = await this.store.setFollow(uid, target, follow === true, MAX_FOLLOWING);
    if (r === 'limit') throw new AppError('failed-precondition', `En fazla ${MAX_FOLLOWING} kişiyi takip edebilirsin.`);
    if (r === 'changed' && follow === true) {
      const u = await this.store.getUser(uid).catch(() => null);
      if (u?.username) await this._notify(target, { type: 'follow', from: this._from(uid, u), postId: null, text: '' }, `follow_${uid}`);
    }
    return { following: follow === true, changed: r === 'changed' };
  }

  async notifRead({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    await this.store.markRead(uid, this.now());
    return { ok: true };
  }

  async profileSave({ uid, guest = false, bio, dmOpen }) {
    this._member(uid, guest, 'Profil için');
    const patch = {};
    if (bio !== undefined) {
      const b = String(bio ?? '').replace(/\s+/g, ' ').trim();
      if (b.length > BIO_MAX) throw new AppError('invalid-argument', `Tanıtım en fazla ${BIO_MAX} karakter olabilir.`);
      patch.bio = b;
    }
    if (dmOpen !== undefined) {
      if (dmOpen !== 'all' && dmOpen !== 'following') throw new AppError('invalid-argument', 'Geçersiz ayar.');
      patch.dmOpen = dmOpen;
    }
    if (!Object.keys(patch).length) return { ok: true };
    await this.store.saveProfile(uid, patch);
    this._users.delete(uid);
    return { ok: true, ...patch };
  }

  /** Herkese açık profil: sayılar, seviye, isabet, rozetler, Benim 11'im kulübü ve kredi sırası (1 dakika saklanır). */
  async user({ uid, target }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (typeof target !== 'string' || !/^[A-Za-z0-9]{6,64}$/.test(target)) throw new AppError('invalid-argument', 'Geçersiz kullanıcı.');
    const hit = this._users.get(target);
    if (hit && this.now() - hit.at < 60e3) return hit.value;
    const [u, prof, stats, brief] = await Promise.all([
      this.store.getUser(target),
      this.store.getProfile(target).catch(() => null),
      this.store.getStats(target).catch(() => null),
      this.brief ? this.brief(target).catch(() => null) : null,
    ]);
    if (!u?.username) throw new AppError('not-found', 'Kullanıcı bulunamadı.');
    const p = prof ?? {};
    const xp = Number(stats?.xp ?? 0);
    const lv = levelOf(xp);
    const num = (k) => Math.max(0, Number(p[k] ?? 0));
    const value = {
      uid: target,
      username: u.username,
      photoURL: u.photoURL ?? null,
      bio: p.bio ?? '',
      team: p.team ?? null,
      dmOpen: p.dmOpen ?? 'all',
      followers: num('followers'),
      following: num('following'),
      posts: num('posts'),
      comments: num('comments'),
      rated: num('rated'),
      level: { level: lv.level, xp, from: lv.from, to: lv.to },
      badges: Array.isArray(stats?.badges) ? stats.badges.slice(0, 20) : [],
      predictions: { n: num('n'), hits: num('hits'), exact: num('exact'), acc: num('n') >= 5 ? accuracy(num('n'), num('hits')) : null },
      duels: { played: num('duelPlayed'), wins: num('duelWins') },
      club: brief?.club ?? null,
      creditRank: brief?.creditRank ?? null,
      online: Number(p.lastSeenMs ?? 0) > this.now() - 6 * 60e3,
    };
    this._users.set(target, { at: this.now(), value });
    if (this._users.size > 2000) this._users.clear();
    return value;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Çevrimiçi, maç odaları, topluluk sayıları
  // ---------------------------------------------------------------------------------------------------------------

  /** Uygulama açıkken birkaç dakikada bir: çevrimiçi sayısı için. */
  async presence({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const at = this._presence.get(uid) ?? 0;
    if (this.now() - at >= 60e3) {
      this._presence.set(uid, this.now());
      if (this._presence.size > 20000) this._presence.clear();
      await this.store.setPresence(uid, this.now(), trDay(this.now()));
    }
    const seen = this._seen.get(uid) ?? 0;
    if (this.now() - seen >= 5 * 60e3) {
      this._seen.set(uid, this.now());
      if (this._seen.size > 20000) this._seen.clear();
      await this.store.saveProfile(uid, { lastSeenMs: this.now() }).catch(() => null);
    }
    return { ok: true };
  }

  /** Maç ya da taraftar odasındayken dakikada bir. */
  async roomPing({ uid, room }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (typeof room !== 'string' || !/^(match|team)_[A-Za-z0-9_]{2,80}$/.test(room)) throw new AppError('invalid-argument', 'Geçersiz oda.');
    let m = this._rooms.get(room);
    if (!m) {
      if (this._rooms.size > 3000) this._pruneRooms(true);
      m = new Map();
      this._rooms.set(room, m);
    }
    m.set(uid, this.now());
    return { ok: true };
  }

  _pruneRooms(hard = false) {
    const cut = this.now() - 3 * 60e3;
    for (const [room, m] of this._rooms) {
      for (const [u, at] of m) if (at < cut) m.delete(u);
      if (!m.size || hard) this._rooms.delete(room);
    }
  }

  /** Odalardaki kişi sayıları ve (arkadaş göstermek için) en çok 50 kullanıcı kimliği. */
  async rooms({ uid, rooms = [] }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this._pruneRooms();
    const want = Array.isArray(rooms) ? rooms.filter((r) => typeof r === 'string').slice(0, 60) : [];
    const out = {};
    for (const r of want) {
      const m = this._rooms.get(r);
      out[r] = { n: m?.size ?? 0, uids: m ? [...m.keys()].slice(0, 50) : [] };
    }
    return { rooms: out };
  }

  /** Kayıtlı kullanıcı, bugün aktif ve son 5 dakikada çevrimiçi sayıları (2 dakika saklanır). */
  async stats({ uid }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (this._stats && this.now() - this._stats.at < 120e3) return this._stats.value;
    const [users, today, online] = await Promise.all([
      this.store.countUsers().catch(() => null),
      this.store.countActiveDay(trDay(this.now())).catch(() => null),
      this.store.countOnline(this.now() - 5 * 60e3).catch(() => null),
    ]);
    const value = { users, today, online };
    this._stats = { at: this.now(), value };
    return value;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Kendiliğinden düşen kartlar
  // ---------------------------------------------------------------------------------------------------------------

  _system(extra) {
    const now = this.now();
    return {
      uid: SYSTEM_UID,
      username: 'vSport',
      photoURL: null,
      level: null,
      acc: null,
      team: null,
      text: '',
      tags: [],
      mentions: [],
      match: null,
      poll: null,
      duel: null,
      quote: null,
      squad: null,
      coupon: null,
      ratings: null,
      reactions: Object.fromEntries(REACTIONS.map((r) => [r, 0])),
      likeCount: 0,
      commentCount: 0,
      createdMs: now,
      ...extra,
    };
  }

  /** Canlı maç olayı (izleyici çağırır): büyük liglerde gol ve maç sonu kartı. Aynı skor için tek kart. */
  async autoNote({ key, note, league, eventId, summary, raw = null }) {
    if (!note || !AUTO_LEAGUES.has(league) || !summary?.home || !summary?.away) return null;
    if (note.type !== 'goal' && note.type !== 'full_time') return null;
    const score = Array.isArray(summary.score) ? summary.score.map((x) => Number(x) || 0) : [0, 0];
    const comps = raw?.header?.competitions?.[0]?.competitors ?? [];
    const logoOf = (side) => {
      const c = comps.find((x) => x?.homeAway === side)?.team;
      return c?.logo ?? c?.logos?.[0]?.href ?? null;
    };
    const home = teamOf({ ...summary.home, logo: logoOf('home') });
    const away = teamOf({ ...summary.away, logo: logoOf('away') });
    const goal = note.type === 'goal';
    const id = `auto_${key}_${goal ? `g${score[0]}_${score[1]}` : 'ft'}`.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 120);
    const minute = goal ? String(note.body ?? '').match(/^(\d+'(?:\+\d+')?)/)?.[1] ?? null : null;
    const desc = goal ? String(note.body ?? '').replace(/^\d+'(?:\+\d+')?\s*/, '').slice(0, 120) : '';
    const doc = this._system({
      text: goal ? desc : `Maç sonucu: ${home.name} ${score[0]}-${score[1]} ${away.name}`,
      match: cleanMatch({ league, eventId: String(eventId), home: home.name, away: away.name, homeLogo: home.logo, awayLogo: away.logo }),
      auto: { type: goal ? 'goal' : 'ft', key, score, minute, desc },
    });
    const ok = await this.store.addPostWithId(id, doc);
    return ok ? id : null;
  }

  /**
   * Günün AI maçı (günde bir kart): bugünün en güvenli, en az 30 dakika sonra başlayacak büyük lig maçı.
   * Tahminin kendisi karta yazılmaz (PRO içerik); kartta topluluk anketi (1 / X / 2) ve güven yüzdesi olur.
   */
  async dailyPick(rows) {
    const now = this.now();
    const day = trDay(now);
    const list = (rows ?? [])
      .filter((r) => r && r.kickoffMs - now > 30 * 60e3 && r.kickoffMs - now < 16 * 3600e3 && Number.isFinite(r.confidence ?? r.live?.confidence))
      .map((r) => ({ r, c: Number(r.live?.confidence ?? r.confidence), big: AUTO_LEAGUES.has(r.league) }))
      .sort((a, b) => Number(b.big) - Number(a.big) || b.c - a.c);
    const pick = list[0]?.r;
    if (!pick) return null;
    const home = teamOf(pick.home);
    const away = teamOf(pick.away);
    const doc = this._system({
      text: `${home.name} - ${away.name}: sence kim kazanır?`,
      match: cleanMatch({ league: pick.league, eventId: String(pick.eventId), home: home.name, away: away.name, homeLogo: home.logo, awayLogo: away.logo, kickoff: new Date(pick.kickoffMs).toISOString() }),
      poll: { options: [home.name.slice(0, 40) || 'Ev sahibi', 'Beraberlik', away.name.slice(0, 40) || 'Deplasman'], counts: { 0: 0, 1: 0, 2: 0 }, total: 0, closesMs: pick.kickoffMs },
      auto: { type: 'ai', key: pick.key, confidence: Number(pick.live?.confidence ?? pick.confidence) },
    });
    const ok = await this.store.addPostWithId(`ai_${day}`, doc);
    return ok ? `ai_${day}` : null;
  }
}

export function createSocialStore(db, FieldValue) {
  const profile = (uid) => db.doc(`social_profiles/${uid}`);
  return {
    async getUser(uid) {
      const s = await db.doc(`users/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async getStats(uid) {
      const s = await db.doc(`user_stats/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    async getProfile(uid) {
      const s = await profile(uid).get();
      return s.exists ? s.data() : null;
    },
    async saveProfile(uid, patch) {
      await profile(uid).set(patch, { merge: true });
    },
    async uidOfUsername(name) {
      const s = await db.doc(`usernames/${name.toLowerCase()}`).get();
      return s.exists ? (s.get('uid') ?? null) : null;
    },
    async addPost(doc) {
      const ref = await db.collection('posts').add({ ...doc, createdAt: FieldValue.serverTimestamp() });
      return ref.id;
    },
    async addPostWithId(id, doc) {
      try {
        await db.doc(`posts/${id}`).create({ ...doc, createdAt: FieldValue.serverTimestamp() });
        return true;
      } catch (e) {
        if (e?.code === 6 || /already exists/i.test(e?.message ?? '')) return false;
        throw e;
      }
    },
    async getPost(id) {
      const s = await db.doc(`posts/${id}`).get();
      return s.exists ? s.data() : null;
    },
    async deletePost(id) {
      await db.doc(`posts/${id}`).delete();
    },
    async getComment(postId, id) {
      const s = await db.doc(`posts/${postId}/comments/${id}`).get();
      return s.exists ? s.data() : null;
    },
    /** r: tepki ya da null. keep: aynı tepki varsa dokunma (eski beğeni ucu). */
    async setReaction(postId, uid, r, { keep = false } = {}) {
      const post = db.doc(`posts/${postId}`);
      const ref = db.doc(`posts/${postId}/likes/${uid}`);
      return db.runTransaction(async (tx) => {
        const [p, l] = await Promise.all([tx.get(post), tx.get(ref)]);
        if (!p.exists) return null;
        const prev = l.exists ? (l.get('r') ?? 'fire') : null;
        const reactions = { fire: 0, goal: 0, wow: 0, lol: 0, ...(p.get('reactions') ?? {}) };
        const count = Number(p.get('likeCount') ?? 0);
        const base = { author: p.get('uid') ?? null, username: p.get('username') ?? null, text: p.get('text') ?? '', createdMs: Number(p.get('createdMs') ?? 0) };
        if (prev === r || (keep && prev !== null && r !== null)) return { ...base, prev, reaction: prev, reactions, likeCount: count };
        if (prev) reactions[prev] = Math.max(0, Number(reactions[prev] ?? 0) - 1);
        if (r) reactions[r] = Number(reactions[r] ?? 0) + 1;
        const likeCount = Math.max(0, count + (r ? 1 : 0) - (prev ? 1 : 0));
        if (r) tx.set(ref, { at: FieldValue.serverTimestamp(), r });
        else tx.delete(ref);
        tx.update(post, { reactions, likeCount });
        return { ...base, prev, reaction: r, reactions, likeCount };
      });
    },
    async addComment(postId, c) {
      const post = db.doc(`posts/${postId}`);
      return db.runTransaction(async (tx) => {
        const p = await tx.get(post);
        if (!p.exists) return null;
        const ref = post.collection('comments').doc();
        tx.set(ref, { ...c, createdAt: FieldValue.serverTimestamp() });
        tx.update(post, { commentCount: FieldValue.increment(1) });
        return { id: ref.id, commentCount: Number(p.get('commentCount') ?? 0) + 1, author: p.get('uid') ?? null };
      });
    },
    async vote(postId, uid, option, nowMs) {
      const post = db.doc(`posts/${postId}`);
      const ref = db.doc(`posts/${postId}/votes/${uid}`);
      return db.runTransaction(async (tx) => {
        const [p, v] = await Promise.all([tx.get(post), tx.get(ref)]);
        if (!p.exists || !p.get('poll')) return null;
        const poll = p.get('poll');
        if (v.exists) return { same: true, option: v.get('o'), counts: poll.counts ?? {}, total: Number(poll.total ?? 0) };
        if (Number(poll.closesMs ?? 0) <= nowMs) return 'closed';
        if (option >= (poll.options ?? []).length) return 'invalid';
        tx.set(ref, { o: option, at: FieldValue.serverTimestamp() });
        tx.update(post, { [`poll.counts.${option}`]: FieldValue.increment(1), 'poll.total': FieldValue.increment(1) });
        const counts = { ...(poll.counts ?? {}) };
        counts[String(option)] = Number(counts[String(option)] ?? 0) + 1;
        return { same: false, option, counts, total: Number(poll.total ?? 0) + 1 };
      });
    },
    async addDuelEntry(postId, uid, e) {
      await db.doc(`posts/${postId}/duel/${uid}`).set(e);
    },
    async duelJoin(postId, uid, e, nowMs) {
      const post = db.doc(`posts/${postId}`);
      const ref = db.doc(`posts/${postId}/duel/${uid}`);
      return db.runTransaction(async (tx) => {
        const [p, d] = await Promise.all([tx.get(post), tx.get(ref)]);
        if (!p.exists || !p.get('duel')) return null;
        const duel = p.get('duel');
        if (duel.status !== 'open' || Number(duel.kickoffMs ?? 0) <= nowMs) return 'closed';
        if (d.exists) return 'exists';
        const top = Array.isArray(duel.top) ? [...duel.top] : [];
        if (top.length < 3) top.push({ username: e.username, h: e.home, a: e.away });
        tx.set(ref, e);
        tx.update(post, { 'duel.n': FieldValue.increment(1), 'duel.top': top });
        return { n: Number(duel.n ?? 0) + 1, top, author: p.get('uid') ?? null };
      });
    },
    async openDuels(key) {
      const q = await db.collection('posts').where('duel.key', '==', key).where('duel.status', '==', 'open').limit(200).get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async duelEntries(postId) {
      const q = await db.collection(`posts/${postId}/duel`).limit(1000).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    },
    async finishDuel(postId, final, results) {
      for (let i = 0; i < results.length || i === 0; i += 400) {
        const batch = db.batch();
        if (i === 0) batch.update(db.doc(`posts/${postId}`), { 'duel.status': 'done', 'duel.final': final });
        for (const r of results.slice(i, i + 400)) batch.update(db.doc(`posts/${postId}/duel/${r.uid}`), { result: r.result, reward: r.reward });
        await batch.commit();
      }
    },
    async claimDuelPay(uid, key) {
      try {
        await db.doc(`social_duel_paid/${uid}_${key}`).create({ uid, key, at: FieldValue.serverTimestamp() });
        return true;
      } catch (e) {
        if (e?.code === 6 || /already exists/i.test(e?.message ?? '')) return false;
        throw e;
      }
    },
    async addDuelHistory(uid, postId, item) {
      await db.doc(`social_profiles/${uid}/duels/${postId}`).set(item);
    },
    async ensureWatched({ key, league, eventId, kickoffMs }) {
      const ref = db.doc(`watched/${key}`);
      const s = await ref.get();
      if (s.exists) return;
      await ref.set({ league, eventId: String(eventId), kickoffAt: new Date(kickoffMs), createdAt: FieldValue.serverTimestamp() });
    },
    /** agg verilirse aynı kimlikli bildirim güncellenir (tepki, takip, düello katılımı tek satır). */
    async notify(uid, item, agg = null) {
      const items = db.collection(`social_notifs/${uid}/items`);
      const ref = agg ? items.doc(agg) : items.doc();
      await db.runTransaction(async (tx) => {
        const [prof, old] = await Promise.all([tx.get(profile(uid)), agg ? tx.get(ref) : Promise.resolve(null)]);
        const readAt = Number(prof.exists ? (prof.get('readAt') ?? 0) : 0);
        let doc = { ...item, n: 1, names: item.from?.username ? [item.from.username] : [] };
        let fresh = true;
        if (old?.exists) {
          const prev = old.data();
          const names = [item.from?.username, ...(prev.names ?? [])].filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 2);
          fresh = Number(prev.at ?? 0) <= readAt;
          doc = { ...item, n: fresh ? 1 : Number(prev.n ?? 1) + 1, names };
        }
        tx.set(ref, doc);
        if (fresh) tx.set(profile(uid), { unread: FieldValue.increment(1) }, { merge: true });
      });
    },
    async markRead(uid, nowMs) {
      await profile(uid).set({ unread: 0, readAt: nowMs }, { merge: true });
    },
    async weekBestPost(week, best) {
      const ref = db.doc(`social_week/${week}`);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const cur = s.exists ? s.get('bestPost') : null;
        if (cur && Number(cur.n ?? 0) >= best.n) return;
        tx.set(ref, { bestPost: best }, { merge: true });
      });
    },
    async weekDuelMaster(week, m) {
      const ref = db.doc(`social_week/${week}`);
      await db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        const cur = s.exists ? s.get('duel') : null;
        if (cur && Number(cur.wins ?? 0) >= m.wins) return;
        tx.set(ref, { duel: m }, { merge: true });
      });
    },
    async countTags(day, tags) {
      const counts = Object.fromEntries(tags.map((t) => [t.key, { n: FieldValue.increment(1), label: t.label }]));
      await db.doc(`social_tags/${day}`).set({ day, counts }, { merge: true });
    },
    async bumpProfile(uid, inc) {
      await profile(uid).set(Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, FieldValue.increment(v)])), { merge: true });
    },
    async setFollow(uid, target, follow, max) {
      const mine = db.doc(`social_follows/${uid}`);
      return db.runTransaction(async (tx) => {
        const s = await tx.get(mine);
        const list = s.exists ? s.get('following') ?? [] : [];
        const has = list.includes(target);
        if (has === follow) return 'same';
        if (follow && list.length >= max) return 'limit';
        tx.set(mine, { following: follow ? FieldValue.arrayUnion(target) : FieldValue.arrayRemove(target) }, { merge: true });
        tx.set(profile(target), { followers: FieldValue.increment(follow ? 1 : -1) }, { merge: true });
        tx.set(profile(uid), { following: FieldValue.increment(follow ? 1 : -1) }, { merge: true });
        return 'changed';
      });
    },
    async follows(uid, target) {
      const s = await db.doc(`social_follows/${uid}`).get();
      return s.exists && (s.get('following') ?? []).includes(target);
    },
    async setPresence(uid, at, day) {
      await db.doc(`presence/${uid}`).set({ at, day });
    },
    async countUsers() {
      return (await db.collection('users').count().get()).data().count;
    },
    async countActiveDay(day) {
      return (await db.collection('presence').where('day', '==', day).count().get()).data().count;
    },
    async countOnline(sinceMs) {
      return (await db.collection('presence').where('at', '>=', sinceMs).count().get()).data().count;
    },
  };
}
