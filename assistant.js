// AI Asistan (aylık ve yıllık abonelere özel): kullanıcı bir maç sorar; asistan istatistiğe ve maçın önemine göre
// analiz yapar ve bunu sahne sahne bir "video" (uygulamadaki sahne oynatıcısı) olarak sunar.
//
// Asistan yeni bir model kurmaz: maçın AI analizi (content.model), Özel Yorum başlıkları (special.js) ve maç önemi
// (importance.js) bir araya getirilir. Maç oynanıyorsa güncel skor ve dakikaya göre olasılıklar yeniden hesaplanır.
// Sahneler uygulamadaki CommentaryScene ile aynı alanlara sahiptir (lib/screens/paid/commentary_script.dart).

import { AppError, matchKey } from './logic.js';
import { phraser, streakOf } from './content.js';
import { importanceOf } from './importance.js';
import { SPECIAL_TOPICS } from './special.js';
import { ASSISTANT_DAILY_LIMIT, dayKeyTr, hasAssistantAccess } from './subscription.js';
import { intentOf, followUpAnswer, reviewOf, swingText, suggestionsFor } from './chat.js';
import { Narrator } from './narrator.js';
import { liveForecast } from './engine/live_model.js';

const pct = (p) => Math.round(p * 100);
const tr1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const norm = (s) =>
  String(s ?? '')
    .replaceAll('İ', 'i')
    .toLowerCase()
    .replaceAll('ç', 'c')
    .replaceAll('ğ', 'g')
    .replaceAll('ı', 'i')
    .replaceAll('ö', 'o')
    .replaceAll('ş', 's')
    .replaceAll('ü', 'u');

/** Sorudaki anahtar sözcüklere göre öne çıkarılacak Özel Yorum başlıkları (sırayla). */
export function focusOf(question) {
  const t = norm(question);
  if (!t.trim()) return [];
  const out = [];
  const add = (k) => out.includes(k) || out.push(k);
  if (/korner/.test(t)) add('corners');
  if (/(iy\s*\/?\s*ms|ilk yari.{0,12}(mac sonu|ms)|surpriz|1\s*\/\s*2|2\s*\/\s*1)/.test(t)) add('htft');
  if (/(ilk yari|devre|\biy\b)/.test(t) && /(skor|gol|sonuc)/.test(t)) add('htscore');
  if (/(\bkg\b|karsilikli|iki takim.{0,10}gol)/.test(t)) add('btts');
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Canlı durum
// ---------------------------------------------------------------------------------------------------
const num = (v) => {
  const n = Number(typeof v === 'object' && v !== null ? (v.value ?? v.displayValue) : v);
  return Number.isFinite(n) ? n : null;
};

/**
 * ESPN maç özetinden güncel durum: { state: 'pre'|'in'|'post', home, away, minute, period, halftime, stats, reds }.
 * stats: { home: { shots, onTarget }, away: {...} } ya da null (şut verisi yok). reds: [ev, dep] kırmızı kart.
 */
export function parseLive(json) {
  const comp = json?.header?.competitions?.[0];
  if (!comp) return null;
  const type = comp.status?.type ?? {};
  const competitor = (s) => comp.competitors?.find((c) => c.homeAway === s);
  const side = (s) => num(competitor(s)?.score);
  let minute = null;
  const m = String(comp.status?.displayClock ?? '').match(/(\d+)(?:'?\s*\+\s*(\d+))?/);
  if (m) minute = Number(m[1]) + Number(m[2] ?? 0);
  const halftime = type.name === 'STATUS_HALFTIME';
  if (halftime) minute = 45;
  // Devre: ESPN "period" verir; yoksa durum adından (STATUS_FIRST_HALF / STATUS_SECOND_HALF)
  let period = num(comp.status?.period) ?? 0;
  if (!period) period = /FIRST_HALF|HALFTIME/.test(type.name ?? '') ? 1 : /SECOND_HALF/.test(type.name ?? '') ? 2 : 0;

  const ids = { home: String(competitor('home')?.team?.id ?? competitor('home')?.id ?? ''), away: String(competitor('away')?.team?.id ?? competitor('away')?.id ?? '') };
  // Şutlar: boxscore istatistikleri
  const statOf = (teamId, name) => {
    const t = (json?.boxscore?.teams ?? []).find((x) => String(x?.team?.id ?? '') === teamId);
    const st = (t?.statistics ?? []).find((x) => x?.name === name);
    return st ? num(st.displayValue ?? st.value) : null;
  };
  const shots = (id) => ({ shots: statOf(id, 'totalShots'), onTarget: statOf(id, 'shotsOnTarget') });
  const hs = shots(ids.home);
  const as = shots(ids.away);
  const stats =
    ids.home && ids.away && hs.shots !== null && as.shots !== null
      ? { home: { shots: hs.shots, onTarget: hs.onTarget ?? 0 }, away: { shots: as.shots, onTarget: as.onTarget ?? 0 } }
      : null;
  // Kırmızı kartlar: olaylardan (ikinci sarı dahil), yoksa istatistikten
  const reds = [0, 0];
  for (const e of json?.keyEvents ?? []) {
    const t = String(e?.type?.text ?? e?.type?.type ?? '').toLowerCase();
    if (!(e?.redCard === true || t.includes('red card') || t.includes('second yellow') || t.includes('yellow-red'))) continue;
    const id = String(e?.team?.id ?? '');
    if (id && id === ids.home) reds[0] += 1;
    else if (id && id === ids.away) reds[1] += 1;
  }
  reds[0] = Math.max(reds[0], statOf(ids.home, 'redCards') ?? 0);
  reds[1] = Math.max(reds[1], statOf(ids.away, 'redCards') ?? 0);
  return { state: type.state ?? 'pre', home: side('home') ?? 0, away: side('away') ?? 0, minute, period, halftime, stats, reds };
}

/**
 * Maç sürerken olasılıklar: tek canlı model (engine/live_model.js). Canlı kart ve AI yorumcu da aynı modeli kullanır.
 * live: { minute, home, away, period?, halftime?, stats?, reds? }. Dönen alanlar: p1, pX, p2, over25, btts, noMoreGoals,
 * moreGoals, nextGoal, topFinals, topScore, expected, remainingGoals, rem.
 */
export function liveProbabilities(model, live) {
  return liveForecast(model, live);
}

// ---------------------------------------------------------------------------------------------------
// Sahneler
// ---------------------------------------------------------------------------------------------------
const outcomeText = (pick, H, A) => (pick === '1' ? `${H} kazanır` : pick === '2' ? `${A} kazanır` : 'beraberlik çıkar');

function teamPlan({ T, gf, ga, form, say, key }) {
  const parts = [];
  if (Number.isFinite(gf) && gf >= 1.7) parts.push(say(`${key}.atk`, [`Hücumda çok etkili: maç başına ${tr1(gf)} gol buluyor.`, `Hücum hattı üretken, maçta ortalama ${tr1(gf)} gol atıyor.`]));
  else if (Number.isFinite(gf) && gf <= 0.9) parts.push(say(`${key}.atk0`, [`Gol bulmakta zorlanıyor: maç başına ${tr1(gf)} gol.`, `Hücumda sıkıntı var, maç başına yalnızca ${tr1(gf)} gol atabiliyor.`]));
  if (Number.isFinite(ga) && ga <= 0.9) parts.push(say(`${key}.def`, [`Savunması sağlam: maçta ${tr1(ga)} gol yiyor.`, `Kolay gol yemiyor, maç başına ${tr1(ga)} gol.`]));
  else if (Number.isFinite(ga) && ga >= 1.5) parts.push(say(`${key}.def0`, [`Savunmada açık veriyor: maç başına ${tr1(ga)} gol yiyor.`, `Arka hat kırılgan, maçta ${tr1(ga)} gol yedi.`]));
  const st = streakOf(form);
  if (st) {
    if (st.last === 'G' && st.run >= 3) parts.push(`Üst üste ${st.run} galibiyetle geliyor.`);
    else if (st.unbeaten >= 4) parts.push(`${st.unbeaten} maçtır yenilmiyor.`);
    else if (st.last === 'M' && st.run >= 2) parts.push(`Son ${st.run} maçını kaybetti.`);
    else if (st.winless >= 4) parts.push(`${st.winless} maçtır kazanamıyor.`);
  }
  if (!parts.length) parts.push(say(`${key}.none`, [`${T} için belirgin bir uç nokta yok; dengeli bir profil.`, 'Verilere göre ortalama bir profil çiziyor.']));
  return parts.join(' ');
}

const SCENE_ICON = { corners: 'flag', htscore: 'timer', htft: 'swap_horiz', btts: 'sports_soccer' };

function specialScene(topic, t) {
  return {
    kind: 'forecast',
    title: t.title,
    icon: SCENE_ICON[topic] ?? 'auto_awesome',
    kicker: t.bigCaption ?? t.title,
    big: t.big,
    chips: t.facts.map((f) => [f.label, f.value]),
    speech: t.speech,
    body: t.summary.join(' '),
    mood: t.mood ?? 'warm',
  };
}

/**
 * Asistanın cevabı: kısa sohbet metni + sahneler.
 * girdi: { match, content, model, specials, importance, live, focus, seed }
 */
export function buildAssistantReply({ match, content, model, specials, importance, live, focus = [], seed, state }) {
  const H = match.homeName;
  const A = match.awayName;
  const say = phraser(`${seed}|asistan`);
  const ai = content.ai;
  const lh = model.lambdaHome;
  const la = model.lambdaAway;
  const scenes = [];

  // 1) Tanıtım
  scenes.push({
    kind: 'intro',
    title: `${H} - ${A}`,
    icon: 'auto_awesome',
    speech: say('as.intro', [
      `Merhaba, ben vSport Asistan. ${H} ile ${A} maçını senin için inceledim. Önce maçın önemine, sonra rakamlara bakalım.`,
      `Selam, ${H} ile ${A} karşılaşmasını istatistiklerle ve maçın önemiyle birlikte değerlendirdim. Başlayalım.`,
      `Hazırım. ${H} ile ${A} maçında hem rakamlar hem de maçın ağırlığı var; hepsini sırayla anlatıyorum.`,
    ]),
    mood: 'warm',
  });

  // 2) Canlı durum / sonuç
  if (state === 'live' && live) {
    const lp = live.probs;
    scenes.push({
      kind: 'forecast',
      title: 'Maçta son durum',
      icon: 'sensors',
      kicker: live.halftime ? 'DEVRE ARASI' : `CANLI · ${live.minute}'`,
      big: `${live.home} - ${live.away}`,
      chips: [
        ['Galibiyet', `${H} %${pct(lp.p1)}`],
        ['Beraberlik', `%${pct(lp.pX)}`],
        ['Galibiyet', `${A} %${pct(lp.p2)}`],
        ['Skor böyle biter', `%${pct(lp.noMoreGoals)}`],
      ],
      speech: say('as.live', [
        `Maç şu anda ${spokenPair(live.home, live.away)}${live.halftime ? ', devre arasındayız' : `, ${live.minute}. dakikadayız`}. Kalan süre hesaba katıldığında ${H} yüzde ${pct(lp.p1)}, beraberlik yüzde ${pct(lp.pX)}, ${A} yüzde ${pct(lp.p2)} görünüyor.`,
        `Canlı tabloya bakıyorum: skor ${spokenPair(live.home, live.away)}${live.halftime ? ', devre arası' : `, dakika ${live.minute}`}. Güncel olasılıklar ${H} için yüzde ${pct(lp.p1)}, beraberlik için yüzde ${pct(lp.pX)}, ${A} için yüzde ${pct(lp.p2)}.`,
      ]),
      mood: 'excited',
    });
  } else if (state === 'post') {
    const actual = match.homeGoals > match.awayGoals ? '1' : match.homeGoals < match.awayGoals ? '2' : 'X';
    const hit = actual === ai.pick;
    scenes.push({
      kind: 'forecast',
      title: 'Maç bitti',
      icon: 'flag',
      kicker: 'MAÇ SONUCU',
      big: `${match.homeGoals} - ${match.awayGoals}`,
      chips: [
        ['Modelin tahmini', ai.topScore],
        ['Sonuç tahmini', hit ? 'Tuttu' : 'Tutmadı'],
      ],
      speech: say('as.post', [
        `Maç ${spokenPair(match.homeGoals, match.awayGoals)} bitti. Modelin maç öncesi sonuç tahmini ${hit ? 'tuttu' : 'tutmadı'}, tahmin edilen skor ${spokenScore(ai.topScore)} idi.`,
        `Final skoru ${spokenPair(match.homeGoals, match.awayGoals)}. Maç öncesi model ${hit ? 'doğru sonucu görmüştü' : 'bu sonucu öngörememişti'}; skor tahmini ${spokenScore(ai.topScore)} idi.`,
      ]),
      mood: hit ? 'warm' : 'serious',
    });
  }

  // 3) Maçın önemi
  scenes.push({
    kind: 'section',
    title: `Maçın önemi: ${importance.label}`,
    icon: 'bolt',
    body: `${importance.score}/100 · ${importance.reasons.join(' ')}`,
    speech: `${say('as.imp', [
      `Bu maçın önem puanı yüz üzerinden ${importance.score}, yani ${importance.label.toLowerCase()}.`,
      `Maçın ağırlığına bakıyorum: önem puanı ${importance.score}, seviye ${importance.label.toLowerCase()}.`,
    ])} ${importance.reasons.slice(0, 2).join(' ')}`,
    mood: importance.score >= 65 ? 'excited' : 'calm',
  });

  // 4) Kıyas
  const rows = [];
  const add = (label, h, a) => Number.isFinite(h) && Number.isFinite(a) && rows.push([label, Math.round(h * 100) / 100, Math.round(a * 100) / 100]);
  add('Maç başı puan', model.homePpg, model.awayPpg);
  add('Attığı gol (maç başı)', model.homeGf, model.awayGf);
  add('Yediği gol (maç başı)', model.homeGa, model.awayGa);
  if (model.homeFormMatches >= 3 && model.awayFormMatches >= 3) add('Son maçlarda puan', model.homeFormPoints, model.awayFormPoints);
  if (rows.length >= 2) {
    scenes.push({
      kind: 'stats',
      title: 'İstatistik kıyası',
      icon: 'compare_arrows',
      stats: rows,
      speech: say('as.cmp', [
        `İstatistiklere bakınca ${H} maç başına ${tr1(lh)}, ${A} ${tr1(la)} gol beklentisiyle sahaya çıkıyor.`,
        `Rakamları yan yana koydum. Model ${H} için ${tr1(lh)}, ${A} için ${tr1(la)} gol öngörüyor.`,
      ]),
      mood: 'calm',
    });
  }

  // 5) Güç dengesi
  scenes.push({
    kind: 'dominance',
    title: 'Güç dengesi',
    icon: 'balance',
    value: Math.round(clamp(((lh - la) / (lh + la)) * 1.6, -1, 1) * 100) / 100,
    body: say('as.dom', [
      `Gol beklentisi ${H} ${tr1(lh)}, ${A} ${tr1(la)}.`,
      `Model sahadaki ağırlığı ${H} ${tr1(lh)} - ${tr1(la)} ${A} olarak ölçüyor.`,
    ]),
    speech: lh > la * 1.25 ? `Güç dengesi ${H} tarafına kayıyor.` : la > lh * 1.25 ? `Güç dengesi ${A} tarafına kayıyor.` : 'Güçler birbirine çok yakın.',
    mood: 'calm',
  });

  // 6) Olasılıklar (canlıysa güncel)
  const live1 = state === 'live' && live ? live.probs : null;
  const probs = live1
    ? [['1', H, pct(live1.p1)], ['X', 'Beraberlik', pct(live1.pX)], ['2', A, pct(live1.p2)]]
    : [['1', H, ai.probabilities.home], ['X', 'Beraberlik', ai.probabilities.draw], ['2', A, ai.probabilities.away]];
  scenes.push({
    kind: 'probabilities',
    title: live1 ? 'Güncel olasılıklar' : 'Maç sonucu olasılıkları',
    icon: 'bar_chart',
    probs,
    speech: `${H} yüzde ${probs[0][2]}, beraberlik yüzde ${probs[1][2]}, ${A} yüzde ${probs[2][2]}. ${say('as.pick', [`Modelin tercihi: ${outcomeText(ai.pick, H, A)}.`, `Öne çıkan sonuç: ${outcomeText(ai.pick, H, A)}.`])}`,
    mood: 'warm',
  });

  // 7) Skor tahmini. Canlıda tek skor yerine: skorun böyle bitme ihtimali, en az bir gol daha ve en olası finaller.
  if (live1) {
    const finals = live1.topFinals.map((f) => [f.score.replace('-', ' - '), `%${pct(f.p)}`]);
    const ng = live1.nextGoal;
    scenes.push({
      kind: 'forecast',
      title: 'Maç nasıl biter?',
      icon: 'scoreboard',
      kicker: `Skor böyle biter %${pct(live1.noMoreGoals)} · En az bir gol daha %${pct(live1.moreGoals)}`,
      big: live1.topFinals[0].score.replace('-', ' - '),
      chips: [
        ...finals.slice(1),
        ['Sıradaki gol', `${H} %${pct(ng.home)} · ${A} %${pct(ng.away)}`],
        ['Beklenen final', `${tr1(live1.expected.home)} - ${tr1(live1.expected.away)}`],
      ],
      speech: `Skorun böyle bitme ihtimali yüzde ${pct(live1.noMoreGoals)}, en az bir gol daha görme ihtimali yüzde ${pct(live1.moreGoals)}. Sıradaki golü ${
        ng.home >= ng.away ? H : A
      } atmaya daha yakın: yüzde ${pct(Math.max(ng.home, ng.away))}. En olası finaller ${live1.topFinals.map((f) => spokenScore(f.score)).join(', ')}.`,
      mood: 'warm',
    });
  } else {
    scenes.push({
      kind: 'forecast',
      title: 'Skor beklentisi',
      icon: 'scoreboard',
      kicker: 'Tahmini final skoru',
      big: ai.topScore.replace('-', ' - '),
      chips: [
        ['Beklenen gol', `${tr1(lh)} - ${tr1(la)}`],
        ['Veri güveni', ai.confidence],
      ],
      speech: `Tahmini final skoru ${spokenScore(ai.topScore)}. Veri güveni ${ai.confidence}.`,
      mood: 'warm',
    });
  }

  // 8) Özel Yorum başlıkları: sorulan konu önce gelir; canlı maçta maç öncesi korner/İY başlıkları atlanır
  if (specials) {
    const order = [...focus.filter((t) => specials[t]), ...SPECIAL_TOPICS.filter((t) => specials[t] && !focus.includes(t))];
    for (const t of order) {
      if (state === 'live' && (t === 'htscore' || t === 'htft')) continue;
      if (state === 'post' && (t === 'htscore' || t === 'htft')) continue;
      scenes.push(specialScene(t, specials[t]));
    }
  }

  // 9) Takım notları
  scenes.push({
    kind: 'plan',
    title: 'Takımlara bakış',
    icon: 'groups',
    plans: [
      [1, teamPlan({ T: H, gf: model.homeGf, ga: model.homeGa, form: model.homeForm, say, key: 'as.h' })],
      [-1, teamPlan({ T: A, gf: model.awayGf, ga: model.awayGa, form: model.awayForm, say, key: 'as.a' })],
    ],
    speech: `${H} için: ${teamPlan({ T: H, gf: model.homeGf, ga: model.homeGa, form: model.homeForm, say, key: 'as.h' })} ${A} için: ${teamPlan({ T: A, gf: model.awayGf, ga: model.awayGa, form: model.awayForm, say, key: 'as.a' })}`,
    mood: 'calm',
  });

  // 10) Kapanış
  scenes.push({
    kind: 'outro',
    title: 'Özet',
    icon: 'check_circle',
    body: 'İstatistiksel tahmindir; sonucu garanti etmez.',
    speech: `${say('as.out', [
      `Özetle: maçın önemi ${importance.label.toLowerCase()}, model ${outcomeText(ai.pick, H, A)} diyor.`,
      `Kısaca toparlayayım: önem seviyesi ${importance.label.toLowerCase()}, model ${outcomeText(ai.pick, H, A)} diyor.`,
    ])} İstatistiksel tahmindir, sonucu garanti etmez. İyi seyirler.`,
    mood: 'calm',
  });

  // Sohbet balonundaki kısa yanıt
  const lead = focus.length && specials?.[focus[0]] ? `${specials[focus[0]].title}: ${specials[focus[0]].headline}. ` : '';
  const answer = live1
    ? `${lead}${H} ${live.home}-${live.away} ${A}, ${live.halftime ? 'devre arası' : `${live.minute}. dakika`}. Kalan süreye göre ${outcomeLabel(live1, H, A)}. Maçın önemi ${importance.label.toLowerCase()} (${importance.score}/100).`
    : `${lead}Maçın önemi ${importance.label.toLowerCase()} (${importance.score}/100). Model ${outcomeText(ai.pick, H, A)} diyor, tahmini skor ${ai.topScore}.`;

  return { headline: `${H} - ${A}`, answer, scenes };
}

function outcomeLabel(lp, H, A) {
  const best = Math.max(lp.p1, lp.pX, lp.p2);
  const who = best === lp.p1 ? `${H} önde (%${pct(lp.p1)})` : best === lp.p2 ? `${A} önde (%${pct(lp.p2)})` : `beraberlik öne çıkıyor (%${pct(lp.pX)})`;
  return who;
}

const WORDS = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz', 'on'];
const spokenPair = (a, b) => `${WORDS[a] ?? a} ${WORDS[b] ?? b}`;
const spokenScore = (s) => {
  const [a, b] = String(s).split('-').map(Number);
  return spokenPair(a, b);
};

// ---------------------------------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------------------------------
export class AssistantService {
  /** requireSubscription: false ise abonelik aranmaz (deneme dönemi); günlük sınır yine uygulanır. */
  constructor({ paid, store, now = () => Date.now(), dailyLimit = ASSISTANT_DAILY_LIMIT, narrator = new Narrator(), requireSubscription = true }) {
    this.requireSubscription = requireSubscription;
    this.paid = paid;
    this.store = store;
    this.narrator = narrator;
    this.now = now;
    this.dailyLimit = dailyLimit;
  }

  async analyze({ uid, league, eventId, kickoff, question = '' }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (this.requireSubscription && !hasAssistantAccess(await this.store.getSubscription(uid), this.now())) {
      throw new AppError('permission-denied', 'AI Asistan, aylık ve yıllık abonelere özel.');
    }
    this.paid.validate({ league, eventId, kickoff }, { needType: false });
    if (typeof question !== 'string' || question.length > 200) throw new AppError('invalid-argument', 'Soru en fazla 200 karakter olabilir.');

    const day = dayKeyTr(this.now());
    const used = await this.store.getAssistantUsage(uid, day);
    if (used >= this.dailyLimit) {
      throw new AppError('resource-exhausted', `Bugünkü ${this.dailyLimit} analiz hakkın doldu; yarın yenilenir.`);
    }

    const match = await this.paid.findMatch({ league, eventId, kickoff });
    const key = matchKey(league, eventId);
    const started = match.timestamp <= this.now();
    const opts = started ? { asOf: match.timestamp - 60000 } : {};
    const content = await this.paid.contentFor(match, opts);
    const model = await this.paid.modelFor(match, content, opts);
    const specials = await this.paid.specialFor(match, SPECIAL_TOPICS, opts);

    let state = 'pre';
    let live = null;
    if (match.completed) {
      state = 'post';
    } else if (started) {
      // Maç oynanıyor olabilir: güncel skor ve dakikayı çek; alınamazsa maç öncesi görünüm sunulur.
      try {
        const info = parseLive(await this.paid.espn.getSummary(league, eventId, { maxAgeMs: 15000 }));
        if (info?.state === 'in' && info.minute !== null) {
          state = 'live';
          live = { ...info, probs: liveProbabilities(model, info) };
        } else if (info?.state === 'post') {
          state = 'post';
          match.homeGoals = info.home;
          match.awayGoals = info.away;
        }
      } catch {
        // canlı veri yok → maç öncesi
      }
    }

    const importance = importanceOf({
      league,
      homeName: match.homeName,
      awayName: match.awayName,
      homeRank: model.homeRank,
      awayRank: model.awayRank,
      homePpg: model.homePpg,
      awayPpg: model.awayPpg,
      homePlayed: model.homePlayed,
      awayPlayed: model.awayPlayed,
      teamCount: model.teamCount,
    });
    const focus = focusOf(question);
    const intent = question.trim() ? intentOf(question) : 'general';
    // Takip sorusu (neden, skor, kaç gol...) aynı maçın rakamlarından kısa yanıtlanır; özel konu (korner, İY/MS, KG) tam yanıta gider.
    const follow = !focus.length && intent !== 'general'
      ? followUpAnswer({
          intent,
          question,
          H: match.homeName,
          A: match.awayName,
          model,
          content,
          importance,
          state,
          live,
          homeGoals: match.homeGoals ?? null,
          awayGoals: match.awayGoals ?? null,
          // Senaryolar canlı durumun devre, şut ve kart bilgisiyle hesaplanır (ekrandakiyle aynı başlangıç)
          probAt: (sc) =>
            liveProbabilities(model, live ? { period: live.period, halftime: live.halftime, stats: live.stats, reds: live.reds, ...sc } : sc),
        })
      : null;
    let reply = follow
      ? { headline: `${match.homeName} - ${match.awayName}`, answer: follow.answer, scenes: [] }
      : buildAssistantReply({ match, content, model, specials, importance, live, focus, seed: key, state });
    // Tam yanıtı maçın durumuna göre zenginleştir: maç bittiyse değerlendirme, sürüyorsa olasılık değişimi.
    if (!follow && !focus.length && state === 'post' && Number.isFinite(match.homeGoals) && Number.isFinite(match.awayGoals)) {
      const review = reviewOf({ H: match.homeName, A: match.awayName, model, content, homeGoals: match.homeGoals, awayGoals: match.awayGoals });
      reply = { ...reply, answer: review.text };
    } else if (!follow && state === 'live' && live) {
      reply = { ...reply, answer: `${reply.answer} ${swingText({ H: match.homeName, A: match.awayName, content, live })}`.trim() };
    }
    const suggestions = follow ? follow.suggestions : suggestionsFor(state);
    // Anlatım: şablon yanıtı dil modeliyle yeniden yazılabilir (kapalıysa aynen kalır). Rakamlar motordan gelir.
    const narrated = await this.narrator.rewrite({
      draft: reply.answer,
      facts: narrationFacts({ match, state, live, content, model, importance }),
    });
    const bumped = await this.store.bumpAssistantUsage(uid, day, this.dailyLimit);

    return {
      key,
      state,
      match: {
        league,
        eventId: String(match.id),
        kickoff: new Date(match.timestamp).toISOString(),
        home: { id: match.homeId, name: match.homeName },
        away: { id: match.awayId, name: match.awayName },
      },
      importance,
      focus,
      intent,
      followUp: Boolean(follow),
      suggestions,
      live: live ? { minute: live.minute, home: live.home, away: live.away, halftime: live.halftime } : null,
      headline: reply.headline,
      answer: narrated.text,
      narration: narrated.source,
      scenes: reply.scenes,
      usage: { used: bumped.used, limit: this.dailyLimit },
    };
  }
}

/** Anlatıcıya verilen veri: yalnızca motorun ürettiği değerler (metin olarak, virgüllü ondalıkla). */
export function narrationFacts({ match, state, live, content, model, importance }) {
  const r1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
  const pr = content.ai.probabilities;
  const facts = {
    maç: `${match.homeName} - ${match.awayName}`,
    durum: state,
    olasılıklar: `ev ${pr.home} / beraberlik ${pr.draw} / deplasman ${pr.away}`,
    tahminiSkor: content.ai.topScore,
    beklenenGol: `${r1(model.lambdaHome)} / ${r1(model.lambdaAway)}`,
    önem: `${importance.label} ${importance.score}/100`,
  };
  if (live) {
    facts.canlı = `${live.home}-${live.away}, ${live.minute}. dakika`;
    const lp = live.probs;
    if (lp?.topFinals) {
      // Canlı rakamlar tek canlı modelden; anlatıcı "tahmini skor" yerine bunları kullanmalı
      facts.canlıOlasılıklar = `ev ${Math.round(lp.p1 * 100)} / beraberlik ${Math.round(lp.pX * 100)} / deplasman ${Math.round(lp.p2 * 100)}`;
      facts.skorBöyleBiter = `%${Math.round(lp.noMoreGoals * 100)}`;
      facts.enAzBirGolDaha = `%${Math.round(lp.moreGoals * 100)}`;
      facts.sıradakiGol = `ev ${Math.round(lp.nextGoal.home * 100)} / deplasman ${Math.round(lp.nextGoal.away * 100)} / gol yok ${Math.round(lp.nextGoal.none * 100)}`;
      facts.olasıFinaller = lp.topFinals.map((f) => `${f.score} %${Math.round(f.p * 100)}`).join(', ');
    }
  }
  return facts;
}
