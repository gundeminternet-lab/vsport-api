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
import { PRICES, CONTENT_VERSION, buildAi, buildOdds, buildSim, buildReview } from './content.js';

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
  constructor({ store, espn, now = () => Date.now(), memoryFactory = () => new TeamMemory(), leagues = LEAGUES }) {
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

  /** İçerik maç başına bir kez üretilir ve saklanır; herkes aynı analizi ve aynı simülasyonu görür. */
  async contentFor(match, { asOf } = {}) {
    const key = matchKey(match.league, match.id);
    const cached = await this.store.getContent(key);
    if (cached && cached.version === CONTENT_VERSION) return cached;

    const sim = new MatchSimulator({ espn: this.espn, memory: this.memoryFactory() });
    const analysis = await sim.prepare({
      league: match.league,
      homeId: match.homeId,
      awayId: match.awayId,
      homeName: match.homeName,
      awayName: match.awayName,
      // Maç bittikten sonra üretiliyorsa yalnızca maç öncesi veriler kullanılır.
      now: asOf ?? this.now(),
    });
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
      ai: buildAi(analysis, { seed: key }),
      odds: buildOdds(analysis),
      sim: buildSim(analysis, { seed: key }),
    };
    return this.store.saveContent(key, content);
  }

  async part(content, type) {
    if (type === 'ai') {
      const editorComment = await this.store.getEditorComment(content.key);
      return { ...content.ai, editorComment };
    }
    return content[type];
  }

  /** Kilit aç: maç başlamamış olmalı. Daha önce açıldıysa tekrar ücret alınmaz. */
  async unlock({ uid, league, eventId, kickoff, type }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    this.validate({ league, eventId, kickoff, type });
    const match = await this.findMatch({ league, eventId, kickoff });
    const key = matchKey(league, eventId);
    const already = await this.store.hasUnlock(uid, key, type);
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
    const unlocked = await this.store.hasUnlock(uid, key, type);
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
