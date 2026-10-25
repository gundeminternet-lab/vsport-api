// Ücretli içerik iş kuralları. Firebase'e doğrudan bağlı değil: veri katmanı (store) ve ESPN istemcisi dışarıdan
// verilir. Böylece kurallar bilgisayarda Firebase olmadan test edilebilir (test/logic.test.js).
//
// store arayüzü:
//   getContent(key) -> içerik | null
//   saveContent(key, content) -> kaydedilen içerik (aynı anda iki kez üretilirse ilk kaydedilen döner)
//   getEditorComment(key) -> metin | null
//   hasUnlock(uid, key, type) -> bool
//   getTokens(uid) -> number
//   hasUnlockId(uid, unlockId) -> bool
//   purchase({ uid, unlockId, price, record }) -> { charged, balance }  (tek işlemde: bakiye kontrolü, düşüm, kilit kaydı)

import { MatchSimulator } from './engine/service.js';
import { TeamMemory } from './engine/memory.js';
import { PRICES, RETIRED_TYPES, CONTENT_VERSION, buildAi, buildOdds, buildSim, buildReview, modelOf } from './content.js';
import { storyForContent } from './story.js';
import { SPECIAL_TOPICS, SPECIAL_VERSION, specialPrice, buildSpecial } from './special.js';
import { collectCornerSamples, expectedCorners } from './engine/corners.js';
import { pendingEntry } from './track.js';

export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'invalid-argument' | 'not-found' | 'failed-precondition' | 'permission-denied'
  }
}

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
  constructor({ store, espn, now = () => Date.now(), memoryFactory = () => new TeamMemory(), leagues = LEAGUES, track = null }) {
    this.track = track; // tahmin karnesi (TrackService): maç öncesi üretilen tahmin kaydedilir
    this.leagues = new Set(leagues);
    this.store = store;
    this.espn = espn;
    this.now = now;
    this.memoryFactory = memoryFactory;
  }

  validate({ league, eventId, kickoff, type }, { needType = true } = {}) {
    if (typeof league !== 'string' || !this.leagues.has(league)) throw new AppError('invalid-argument', 'Geçersiz lig.');
    if (typeof eventId !== 'string' || !/^[0-9A-Za-z-]{1,30}$/.test(eventId)) throw new AppError('invalid-argument', 'Geçersiz maç.');
    if (!Number.isFinite(Date.parse(kickoff))) throw new AppError('invalid-argument', 'Geçersiz maç saati.');
    if (needType && !Object.hasOwn(PRICES, type)) throw new AppError('invalid-argument', 'Geçersiz içerik türü.');
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
   * Kullanıcının bu içeriği görme hakkı var mı? AI paketi (ai) simülasyonu ve Özel Yorum başlıklarını (sp_*) da kapsar.
   */
  async covers(uid, key, type) {
    if (await this.store.hasUnlock(uid, key, type)) return true;
    if (type === 'ai') return false;
    return (type === 'sim' || type.startsWith('sp_')) && this.store.hasUnlock(uid, key, 'ai');
  }

  /** Kilit aç: maç başlamamış olmalı. Daha önce açıldıysa (ya da AI paketi kapsıyorsa) tekrar ücret alınmaz. */
  async unlock({ uid, league, eventId, kickoff, type }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff, type });
    const key = matchKey(league, eventId);
    const already = await this.covers(uid, key, type);
    if (!already && RETIRED_TYPES.includes(type)) throw new AppError('failed-precondition', 'Bu içerik artık sunulmuyor.');
    const match = await this.findMatch({ league, eventId, kickoff });
    if (!already && (match.completed || match.timestamp <= this.now())) {
      throw new AppError('failed-precondition', 'Maç başladı; ücretli içerikler yalnızca maç öncesi satın alınabilir.');
    }
    // Bakiyesi yetmeyen kullanıcı içerik üretimini (ESPN istekleri, hesaplama) tetikleyemez.
    // Asıl kontrol yine satın alma işleminin içinde yapılır.
    if (!already && (await this.store.getTokens(uid)) < PRICES[type]) {
      throw new AppError('failed-precondition', `Yetersiz token: ${PRICES[type]} gerekli.`);
    }
    // Önce içerik üretilir: ESPN'e ulaşılamazsa kullanıcıdan ücret alınmaz.
    const started = match.timestamp <= this.now();
    const content = await this.contentFor(match, started ? { asOf: match.timestamp - 60000 } : {});
    const { charged, balance } = already
      ? { charged: false, balance: null }
      : await this.store.purchase({
          uid,
          unlockId: `${key}_${type}`,
          price: PRICES[type],
          record: {
            key,
            type,
            league: match.league,
            eventId: String(match.id),
            title: `${match.homeName} - ${match.awayName}`,
            kickoff: new Date(match.timestamp).toISOString(),
          },
        });
    return { type, key, charged, balance, price: PRICES[type], data: await this.part(content, type) };
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
    if (!match.completed) throw new AppError('permission-denied', 'Bu içerik kilitli.');
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

  /** Özel Yorum satın al: tek başlık 40, dört başlığın tamamı 120 token. Daha önce açılan başlıklar için tekrar ücret alınmaz. */
  async unlockSpecial({ uid, league, eventId, kickoff, topics }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff }, { needType: false });
    const want = this.specialTopics(topics);
    const match = await this.findMatch({ league, eventId, kickoff });
    const key = matchKey(league, eventId);
    const flags = await Promise.all(want.map((t) => this.covers(uid, key, `sp_${t}`)));
    const missing = want.filter((_, i) => !flags[i]);
    if (missing.length && (match.completed || match.timestamp <= this.now())) {
      throw new AppError('failed-precondition', 'Maç başladı; Özel Yorum yalnızca maç öncesi satın alınabilir.');
    }
    const price = specialPrice(missing.length);
    if (missing.length && (await this.store.getTokens(uid)) < price) {
      throw new AppError('failed-precondition', `Yetersiz token: ${price} gerekli.`);
    }
    // Önce içerik üretilir: ESPN'e ulaşılamazsa kullanıcıdan ücret alınmaz.
    const data = await this.specialFor(match, want);
    let charged = false;
    let balance = null;
    if (missing.length) {
      ({ charged, balance } = await this.store.purchaseBundle({
        uid,
        priceFor: specialPrice,
        items: missing.map((t) => ({
          unlockId: `${key}_sp_${t}`,
          record: {
            key,
            type: `sp_${t}`,
            league: match.league,
            eventId: String(match.id),
            title: `${match.homeName} - ${match.awayName}`,
            kickoff: new Date(match.timestamp).toISOString(),
          },
        })),
      }));
    }
    return { key, topics: want, charged, balance, price: missing.length ? price : 0, data };
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
