// Ücretli içerik iş kuralları. Firebase'e doğrudan bağlı değil: veri katmanı (store) ve ESPN istemcisi dışarıdan
// verilir. Böylece kurallar bilgisayarda Firebase olmadan test edilebilir (test/logic.test.js).
//
// store arayüzü:
//   getContent(key) -> içerik | null
//   saveContent(key, content) -> kaydedilen içerik (aynı anda iki kez üretilirse ilk kaydedilen döner)
//   getEditorComment(key) -> metin | null
//   hasUnlock(uid, key, type) -> bool
//   hasUnlockId(uid, unlockId) -> bool
//   getAccess(uid) -> { subscription, trialUsed }
//   recordUnlock({ uid, unlockId, record }) -> { created }      (abonenin açtığı içerik geçmişe yazılır; ücret yok)
//   useTrial({ uid, unlockId, record, limit }) -> { used, trialLeft }  (deneme hakkı: tek işlemde sayaç + kilit)
//   useWheelCredit({ uid, prize, unlockId, record, now }) -> { used, left } (günlük çark hakkı: tek işlemde hak + kilit)
//
// Erişim: abonelik (subscription.js → AccessService). Jeton/token sistemi kaldırıldı.

import { MatchSimulator } from './engine/service.js';
import { TeamMemory } from './engine/memory.js';
import { CONTENT_TYPES, RETIRED_TYPES, CONTENT_VERSION, buildAi, buildOdds, buildSim, buildReview, modelOf } from './content.js';
import { storyForContent } from './story.js';
import { SPECIAL_TOPICS, SPECIAL_VERSION, buildSpecial } from './special.js';
import { collectCornerSamples, expectedCorners } from './engine/corners.js';
import { pendingEntry } from './track.js';
import { AppError } from './errors.js';
import { AccessService, TRIAL_MATCHES, subscriptionRequired } from './subscription.js';
import { CREDIT_TARGET, CREDIT_TYPES } from './wheel.js';

export { AppError };

/** Uygulamada gösterilen ligler (lib/models/league_catalog.dart ile aynı olmalı; Flutter testi bunu denetler). Başka lig için içerik üretilmez. */
export const LEAGUES = [
  'tur.1', 'tur.2', 'uefa.champions', 'uefa.europa', 'uefa.europa.conf', 'eng.1',
  'eng.2', 'eng.fa', 'eng.league_cup', 'eng.3', 'eng.4', 'esp.1',
  'esp.copa_del_rey', 'esp.2', 'ita.1', 'ita.coppa_italia', 'ita.2', 'ger.1',
  'ger.dfb_pokal', 'ger.2', 'fra.1', 'fra.coupe_de_france', 'fra.2', 'por.1',
  'ned.1', 'bel.1', 'sco.1', 'gre.1', 'rus.1', 'aut.1',
  'sui.1', 'den.1', 'swe.1', 'nor.1', 'usa.1', 'mex.1',
  'bra.1', 'arg.1', 'conmebol.libertadores', 'conmebol.sudamericana', 'concacaf.champions', 'col.1',
  'chi.1', 'uru.1', 'ksa.1', 'jpn.1', 'kor.1', 'chn.1',
  'aus.1', 'afc.champions', 'caf.champions', 'uefa.nations', 'fifa.friendly', 'fifa.world',
  'uefa.euro',
];

/** Uygulamadaki MatchItem.key ile aynı: "tur_1_401888391" */
export const matchKey = (league, id) => `${String(league).replace(/[^a-zA-Z0-9]/g, '_')}_${String(id).replace(/[^a-zA-Z0-9]/g, '_')}`;

const DAY = 86400000;
const utcDay = (ms) => new Date(Math.floor(ms / DAY) * DAY);

export class PaidContentService {
  constructor({ store, espn, now = () => Date.now(), memoryFactory = () => new TeamMemory(), leagues = LEAGUES, track = null, access = null }) {
    this.track = track; // tahmin karnesi (TrackService): maç öncesi üretilen tahmin kaydedilir
    this.leagues = new Set(leagues);
    this.store = store;
    this.espn = espn;
    this.now = now;
    this.memoryFactory = memoryFactory;
    // Abonelik denetimi (Google Play yenilemesi dahil); verilmezse yalnızca kayıttaki abonelik okunur
    this.access = access ?? new AccessService({ store, now });
  }

  validate({ league, eventId, kickoff, type }, { needType = true } = {}) {
    if (typeof league !== 'string' || !this.leagues.has(league)) throw new AppError('invalid-argument', 'Geçersiz lig.');
    if (typeof eventId !== 'string' || !/^[0-9A-Za-z-]{1,30}$/.test(eventId)) throw new AppError('invalid-argument', 'Geçersiz maç.');
    if (!Number.isFinite(Date.parse(kickoff))) throw new AppError('invalid-argument', 'Geçersiz maç saati.');
    if (needType && !CONTENT_TYPES.includes(type)) throw new AppError('invalid-argument', 'Geçersiz içerik türü.');
  }

  /** Maçı ESPN'den doğrular (istemcinin gönderdiği takım/saat bilgisine güvenilmez). Önce maç kimliğiyle
   *  doğrudan aranır; olmazsa fikstürde (ESPN günleri ABD Doğu saatine göre saydığı için ±1 gün) aranır. */
  async findMatch({ league, eventId, kickoff }) {
    const errors = [];
    if (typeof this.espn.getEvent === 'function') {
      try {
        const m = await this.espn.getEvent(league, eventId);
        if (m && String(m.id) === String(eventId)) return m;
      } catch (e) {
        errors.push(e);
      }
    }
    const t = Date.parse(kickoff);
    const days = [utcDay(t), utcDay(t - DAY), utcDay(t + DAY)];
    for (const d of days) {
      let list;
      try {
        list = await this.espn.getFixtures(league, d);
      } catch (e) {
        errors.push(e);
        continue;
      }
      const m = list.find((e) => String(e.id) === String(eventId));
      if (m) return m;
    }
    if (errors.length) console.error(`[findMatch] ${league}/${eventId}:`, errors.map((e) => e?.message ?? e).join(' | '));
    // Tüm istekler başarısızsa sorun maçta değil, ESPN'e erişimde.
    if (errors.length > days.length) throw new AppError('unavailable', 'Maç verisine şu an ulaşılamıyor. Biraz sonra tekrar deneyin.');
    throw new AppError('not-found', 'Maç bilgisi bulunamadı.');
  }

  /** Maç öncesi analiz (yalnızca `asOf` anından önceki veriler). */
  async _analyze(match, asOf) {
    const sim = new MatchSimulator({ espn: this.espn, memory: this.memoryFactory() });
    return sim.prepare({
      league: match.league,
      homeId: match.homeId,
      awayId: match.awayId,
      homeName: match.homeName,
      awayName: match.awayName,
      // Maç bittikten sonra üretiliyorsa yalnızca maç öncesi veriler kullanılır.
      now: asOf ?? this.now(),
    });
  }

  /** İçerik maç başına bir kez üretilir ve saklanır; herkes aynı analizi ve aynı simülasyonu görür. */
  async contentFor(match, { asOf } = {}) {
    const key = matchKey(match.league, match.id);
    const cached = await this.store.getContent(key);
    if (cached && cached.version === CONTENT_VERSION) return cached;

    const analysis = await this._analyze(match, asOf);
    const content = {
      version: CONTENT_VERSION,
      key,
      league: match.league,
      eventId: String(match.id),
      kickoff: new Date(match.timestamp).toISOString(),
      home: { id: match.homeId, name: match.homeName },
      away: { id: match.awayId, name: match.awayName },
      createdAt: new Date(this.now()).toISOString(),
      // true: içerik maç başlamadan üretildi (biri maç öncesi satın aldı). false: maç bittikten sonra, yalnızca maç öncesi veriyle üretildi.
      generatedBeforeKickoff: this.now() < match.timestamp,
      model: modelOf(analysis),
      ai: buildAi(analysis, { seed: key }),
      odds: buildOdds(analysis),
      sim: buildSim(analysis, { seed: key }),
    };
    const saved = await this.store.saveContent(key, content);
    // Tahmin karnesi: yalnızca maç başlamadan üretilen içerik kaydedilir (sonradan üretilen tahmin karneye girmez).
    if (saved.generatedBeforeKickoff && this.track) {
      const entry = pendingEntry({
        key,
        league: match.league,
        eventId: String(match.id),
        kickoffMs: match.timestamp,
        homeName: match.homeName,
        awayName: match.awayName,
        ai: saved.ai,
      });
      await this.track.recordPending(entry).catch((e) => console.error('[track]', e?.message ?? e));
    }
    return saved;
  }

  /** Tahminin dayandığı sayılar. Eski içeriklerde (model alanı eklenmeden üretilmiş) analiz yeniden çalıştırılır. */
  async modelFor(match, content, { asOf } = {}) {
    if (content?.model) return content.model;
    return modelOf(await this._analyze(match, asOf));
  }

  /** İki takımın son maçlarındaki korner örnekleri (ESPN maç özetlerinden). */
  async _cornerSamples(match, asOf) {
    const sim = new MatchSimulator({ espn: this.espn, memory: this.memoryFactory() });
    const warnings = [];
    await Promise.all([
      sim.syncTeam(match.league, String(match.homeId), match.homeName, warnings),
      sim.syncTeam(match.league, String(match.awayId), match.awayName, warnings),
    ]);
    const before = asOf ?? this.now();
    const [homeSamples, awaySamples] = await Promise.all([
      collectCornerSamples({ espn: this.espn, teamId: match.homeId, matches: sim.memory.getMatches(match.homeId), before }),
      collectCornerSamples({ espn: this.espn, teamId: match.awayId, matches: sim.memory.getMatches(match.awayId), before }),
    ]);
    return { homeSamples, awaySamples };
  }

  /**
   * Özel Yorum başlıkları (maç başına bir kez üretilir ve saklanır; herkes aynı rakamları görür).
   * Eksik başlıklar üretilip belgeye eklenir.
   */
  async specialFor(match, topics, { asOf } = {}) {
    const key = matchKey(match.league, match.id);
    const doc = typeof this.store.getSpecial === 'function' ? await this.store.getSpecial(key) : null;
    const valid = doc && doc.version === SPECIAL_VERSION;
    const have = valid ? { ...(doc.topics ?? {}) } : {};
    const missing = topics.filter((t) => !have[t]);
    if (missing.length) {
      const base = await this.contentFor(match, asOf ? { asOf } : {});
      const model = (valid && doc.model) || (await this.modelFor(match, base, { asOf }));
      let corners = null;
      if (missing.includes('corners')) {
        const samples = await this._cornerSamples(match, asOf);
        corners = expectedCorners({ lambdaHome: model.lambdaHome, lambdaAway: model.lambdaAway, ...samples });
      }
      const built = buildSpecial(missing, { homeName: match.homeName, awayName: match.awayName, model, corners, seed: key });
      if (typeof this.store.saveSpecial === 'function') {
        await this.store.saveSpecial(key, { version: SPECIAL_VERSION, key, model, createdAt: new Date(this.now()).toISOString(), topics: built });
      }
      Object.assign(have, built);
    }
    return Object.fromEntries(topics.map((t) => [t, have[t]]));
  }

  async part(content, type) {
    if (type === 'ai') {
      const editorComment = await this.store.getEditorComment(content.key);
      // Video hikâyesi (50.000 simülasyon) saklanmaz; modelin beklenen gollerinden tohumlu olarak türetilir.
      return { ...content.ai, editorComment, story: storyForContent(content) };
    }
    return content[type];
  }

  /**
   * Abonelik dışında açılmış kilit: AI paketi (…_ai: deneme, çark "tüm özellikler" ya da eski jeton dönemi) simülasyonu
   * ve Özel Yorum başlıklarını (sp_*) da kapsar; çarktan "AI Yorumcu" (…_aic) yalnızca AI analizi ve videosunu açar.
   */
  async _ownUnlock(uid, key, type) {
    if (await this.store.hasUnlock(uid, key, type)) return true;
    if (type === 'ai') return this.store.hasUnlock(uid, key, 'aic');
    if (type === 'sim' || type.startsWith('sp_')) return this.store.hasUnlock(uid, key, 'ai');
    return false;
  }

  /** Kullanıcının bu içeriği görme hakkı var mı? Abonelik her şeyi kapsar; değilse açılmış kilit. */
  async covers(uid, key, type) {
    if (await this._ownUnlock(uid, key, type)) return true;
    return this.access.isSubscriber(uid);
  }

  /** Kilit kaydı (açılan içerik geçmişi) için maç bilgisi. */
  _record(match, key, type, extra = {}) {
    return {
      key,
      type,
      league: match.league,
      eventId: String(match.id),
      title: `${match.homeName} - ${match.awayName}`,
      kickoff: new Date(match.timestamp).toISOString(),
      ...extra,
    };
  }

  /**
   * İçeriği aç. Abone: her zaman (maç başladıysa maç öncesi veriyle). Abone değil: daha önce açtığı içerik, deneme hakkı
   * (AI paketi, TRIAL_MATCHES maç) ya da günlük çarktan kazanılan hak (use: 'full' | 'commentator' | 'sim').
   * Ücretsiz haklar yalnızca maç başlamadan kullanılır. Hiçbir durumda ücret alınmaz.
   *   use: 'trial' | 'full' | 'commentator' | 'sim'; verilmezse (eski sürüm) AI paketi için deneme hakkı.
   */
  async unlock({ uid, league, eventId, kickoff, type, use = null }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff, type });
    if (use !== null && !Object.hasOwn(CREDIT_TYPES, use)) throw new AppError('invalid-argument', 'Geçersiz hak.');
    const key = matchKey(league, eventId);
    if (RETIRED_TYPES.includes(type) && !(await this.store.hasUnlock(uid, key, type))) {
      throw new AppError('failed-precondition', 'Bu içerik artık sunulmuyor.');
    }
    const how = use ?? (type === 'ai' ? 'trial' : null);
    const packageUse = how === 'trial' || how === 'full';
    // Paket hakkı istenmişse (AI Yorumcu ya da simülasyon açık olsa da) paketin kendisi açık mı bakılır.
    const unlocked = packageUse && use !== null ? await this.store.hasUnlock(uid, key, 'ai') : await this._ownUnlock(uid, key, type);
    const ent = unlocked ? null : await this.access.entitlement(uid);

    let via = unlocked ? 'unlock' : null;
    if (!via && ent.subscribed) via = 'subscription';
    if (!via) {
      if (!how || !CREDIT_TYPES[how].includes(type)) throw subscriptionRequired();
      if (how === 'trial' && ent.trialLeft <= 0) throw subscriptionRequired();
      if (how !== 'trial' && !(ent.wheel?.credits?.[how] > 0)) throw subscriptionRequired('Bu çark ödülü hakkın yok ya da süresi doldu.');
      via = how === 'trial' ? 'trial' : 'wheel';
    }
    const match = await this.findMatch({ league, eventId, kickoff });
    const started = match.completed || match.timestamp <= this.now();
    if (via === 'trial' && started) throw new AppError('failed-precondition', 'Maç başladı; ücretsiz deneme yalnızca maç öncesi kullanılabilir.');
    if (via === 'wheel' && started) throw new AppError('failed-precondition', 'Maç başladı; çark ödülleri yalnızca maç başlamadan kullanılabilir.');
    // Önce içerik üretilir: ESPN'e ulaşılamazsa deneme/çark hakkı harcanmaz.
    const content = await this.contentFor(match, started ? { asOf: match.timestamp - 60000 } : {});
    let trialLeft = ent?.trialLeft ?? null;
    let creditsLeft = null;
    if (via === 'trial') {
      ({ trialLeft } = await this.store.useTrial({ uid, unlockId: `${key}_ai`, record: this._record(match, key, 'ai', { via: 'trial' }), limit: TRIAL_MATCHES }));
    } else if (via === 'wheel') {
      const target = CREDIT_TARGET[how];
      ({ left: creditsLeft } = await this.store.useWheelCredit({
        uid,
        prize: how,
        unlockId: `${key}_${target}`,
        record: this._record(match, key, target, { via: 'wheel', prize: how }),
        now: this.now(),
      }));
    } else if (via === 'subscription') {
      // Abonenin açtığı maçlar "açtıklarım" listesinde ve kilit durumunda görünsün (ücret yok)
      await this.store.recordUnlock?.({ uid, unlockId: `${key}_${type}`, record: this._record(match, key, type, { via: 'subscription' }) });
    }
    return { type, key, via, use: via === 'wheel' || via === 'trial' ? how : null, trialLeft, creditsLeft, data: await this.part(content, type) };
  }

  /** Açılmış içeriği tekrar getir. Maç bittiyse herkese ücretsiz. */
  async get({ uid, league, eventId, kickoff, type }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff, type });
    const key = matchKey(league, eventId);
    const unlocked = await this.covers(uid, key, type);
    if (unlocked) {
      const cached = await this.store.getContent(key);
      if (cached) return { type, key, data: await this.part(cached, type) };
    }
    const match = await this.findMatch({ league, eventId, kickoff });
    if (unlocked) {
      // Kilit açık ama içerik silinmiş/eski sürüm: yeniden üret (maç başladıysa yalnızca maç öncesi veriyle).
      const started = match.timestamp <= this.now();
      const content = await this.contentFor(match, started ? { asOf: match.timestamp - 60000 } : {});
      return { type, key, data: await this.part(content, type) };
    }
    if (!match.completed) throw subscriptionRequired();
    const content = await this.contentFor(match, { asOf: match.timestamp - 60000 });
    return { type, key, data: await this.part(content, type) };
  }

  /** İstekteki başlıkları doğrular: 'all' ya da başlık listesi → tekrarsız, geçerli başlıklar. */
  specialTopics(topics) {
    const list = topics === 'all' || (Array.isArray(topics) && topics.includes('all')) ? SPECIAL_TOPICS : topics;
    if (!Array.isArray(list) || list.length === 0 || list.length > SPECIAL_TOPICS.length) throw new AppError('invalid-argument', 'Geçersiz başlık.');
    const out = [];
    for (const t of list) {
      if (!SPECIAL_TOPICS.includes(t)) throw new AppError('invalid-argument', 'Geçersiz başlık.');
      if (!out.includes(t)) out.push(t);
    }
    return SPECIAL_TOPICS.filter((t) => out.includes(t));
  }

  /** Özel Yorum: aboneler ve bu maçın AI paketini (deneme hakkı ya da çarkın "tüm özellikler" ödülüyle) açanlar için; ücret yok. */
  async unlockSpecial({ uid, league, eventId, kickoff, topics }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff }, { needType: false });
    const want = this.specialTopics(topics);
    const key = matchKey(league, eventId);
    const flags = await Promise.all(want.map((t) => this.covers(uid, key, `sp_${t}`)));
    if (flags.some((f) => !f)) throw subscriptionRequired('Özel Yorumlar abonelere özel (ya da bu maçın AI paketini açanlara).');
    const match = await this.findMatch({ league, eventId, kickoff });
    const started = match.completed || match.timestamp <= this.now();
    const data = await this.specialFor(match, want, started ? { asOf: match.timestamp - 60000 } : {});
    return { key, topics: want, data };
  }

  /** Açılmış Özel Yorum başlıklarını getir (maç bittiyse hepsi ücretsiz). */
  async getSpecial({ uid, league, eventId, kickoff }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff }, { needType: false });
    const key = matchKey(league, eventId);
    const flags = await Promise.all(SPECIAL_TOPICS.map((t) => this.covers(uid, key, `sp_${t}`)));
    let open = SPECIAL_TOPICS.filter((_, i) => flags[i]);
    // Satın alınanlar zaten saklıysa ESPN'e hiç gitmeden döner.
    if (open.length && typeof this.store.getSpecial === 'function') {
      const doc = await this.store.getSpecial(key);
      if (doc?.version === SPECIAL_VERSION && open.every((t) => doc.topics?.[t])) {
        return { key, topics: open, data: Object.fromEntries(open.map((t) => [t, doc.topics[t]])) };
      }
    }
    const match = await this.findMatch({ league, eventId, kickoff });
    if (match.completed) open = [...SPECIAL_TOPICS];
    if (!open.length) return { key, topics: [], data: {} };
    const started = match.timestamp <= this.now();
    const data = await this.specialFor(match, open, started ? { asOf: match.timestamp - 60000 } : {});
    return { key, topics: open, data };
  }

  /** Biten maçta AI tahmini ve simülasyon sonucunun gerçek sonuçla karşılaştırması (ücretsiz). */
  async review({ uid, league, eventId, kickoff }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff }, { needType: false });
    const match = await this.findMatch({ league, eventId, kickoff });
    if (!match.completed) throw new AppError('failed-precondition', 'Maç henüz bitmedi.');
    const content = await this.contentFor(match, { asOf: match.timestamp - 60000 });
    return {
      key: content.key,
      generatedBeforeKickoff: content.generatedBeforeKickoff,
      ai: { pick: content.ai.pick, probabilities: content.ai.probabilities, topScore: content.ai.topScore },
      simScore: content.sim.finalScore,
      review: buildReview({ ai: content.ai, sim: content.sim, actual: { home: match.homeGoals, away: match.awayGoals } }),
    };
  }
}
