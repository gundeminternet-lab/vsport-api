// AI Asistan takip soruları. Kullanıcı aynı maç hakkında kısa bir soru sorduğunda (ör. "neden?", "kaç gol?", "ikinci yarı?")
// maç yeniden aranmaz; soru niyeti anlaşılır ve aynı rakamlardan kısa, sayıya dayalı bir yanıt üretilir.
// Sohbet geçmişi sunucuda tutulmaz: istemci aynı maçı yeniden gönderir.
//
// Niyetler: review (tahmin tuttu mu), whatif (ya şöyle olursa), why (neden), score (skor), goals (gol sayısı),
// second (ikinci yarı), winner (kim kazanır), importance (önem).
// Bunlardan biri yoksa (ya da korner, İY/MS, KG gibi Özel Yorum konusu varsa) mevcut tam yanıt kullanılır.

import { HT_SHARE, halfTimeTable, markets } from './content.js';
import { scoreMatrix } from './engine/analysis.js';
import { MODEL, LEAGUES } from './engine/config.js';

const pct = (p) => Math.round(p * 100);
const tr1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');

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

/** Kurallar sırayla denenir; ilk eşleşen niyet geçerlidir. */
const RULES = [
  // Önce özel sorular: "neden tutmadı" bir değerlendirme, "gol atarsa" bir senaryo sorusudur.
  ['review', /\b(tuttu|tutmadi|nasil bitti|degerlendir\w*|isabet\w*)\b/],
  ['whatif', /\b(atarsa|bulursa|olursa|yerse|gelirse)\b/],
  ['why', /\b(neden|niye|nedeni|sebep|sebebi)\b/],
  // İlk yarı soruları ("ilk yarı kim önde", "devreyi kim alır"); skor/gol içerenler Özel Yorum'a (htscore) gider
  ['first', /(\bilk yari\w*|\bilk devre\w*|\bdevre arasi\w*|\bdevreyi\b|\biy\b)/],
  ['score', /\b(skor|kac kac|kacar|en olasi skor|tahmini skor)\b/],
  ['goals', /\b(kac gol|gol sayisi|kac tane gol|gollu|toplam gol|ust|alt|2 5|2,5)\b/],
  ['second', /\b(ikinci yari|2 yari|2\. yari|ikinci devre|ikinci yarida)\b/],
  ['winner', /\b(kazanir|kazanacak|galip|kim onde|kim kazanir|sonuc ne|beraber|berabere)\b/],
  ['importance', /\b(onem|onemli|derbi|onem derecesi|ne kadar onemli)\b/],
];

/** Sorunun niyeti. Tanınmıyorsa 'general'. */
export function intentOf(question) {
  const t = norm(question).replace(/[.,?!]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'general';
  for (const [name, re] of RULES) if (re.test(t)) return name;
  return 'general';
}

/** Her niyetin altında önerilen takip soruları (istemcide düğme olarak gösterilir). */
export const SUGGESTIONS = {
  winner: ['Skor tahmini?', 'Kaç gol?', 'Neden?'],
  score: ['Kim kazanır?', 'Kaç gol?'],
  goals: ['İkinci yarı?', 'Kim kazanır?'],
  second: ['Kaç gol?', 'Kim kazanır?'],
  why: ['Maçın önemi?', 'Kim kazanır?'],
  importance: ['Neden?', 'Kim kazanır?'],
  first: ['İkinci yarı?', 'Kim kazanır?', 'Kaç gol?'],
  general: ['Kim kazanır?', 'Skor tahmini?', 'Kaç gol?', 'Korner beklentisi?'],
  review: ['Skor tahmini?', 'Kaç gol?'],
  whatif: ['Deplasman gol atarsa?', 'Kim kazanır?'],
};

/** Tam analizden sonra önerilecek sorular: maçın durumuna göre. */
export function suggestionsFor(state) {
  if (state === 'post') return ['Tahmin tuttu mu?', 'Neden?', 'Skor tahmini?'];
  if (state === 'live') return ['Kim kazanır?', 'Ev sahibi gol atarsa?', 'Deplasman gol atarsa?'];
  return ['Kim kazanır?', 'Skor tahmini?', 'Ev sahibi gol atarsa?', 'Korner beklentisi?'];
}

/**
 * Takip yanıtı. girdi: { intent, question, H, A, model, content, importance, state, live, homeGoals, awayGoals, probAt }.
 * probAt({minute, home, away}) → {p1, pX, p2}: belirli dakika ve skordan sonra olasılıklar (senaryolar için).
 * Dönen: { answer, suggestions } ya da niyet desteklenmiyorsa null.
 */
export function followUpAnswer({ intent, question = '', H, A, model, content, importance, state, live, homeGoals = null, awayGoals = null, probAt = null }) {
  if (intent === 'general') return null;
  const lh = model.lambdaHome;
  const la = model.lambdaAway;
  const total = lh + la;
  const sigma = model.sigma ?? 0;
  const m = markets(lh, la, sigma);
  const ai = content.ai;
  const outcome = (pick) => (pick === '1' ? `${H} kazanır` : pick === '2' ? `${A} kazanır` : 'beraberlik çıkar');
  const post = state === 'post' ? 'Maç bitti; maç öncesi tahmine göre ' : '';

  // Maç bittiyse "neden?" sorusu tahminin neden tuttuğu/tutmadığı sorusudur.
  if (state === 'post' && intent === 'why') intent = 'review';

  switch (intent) {
    case 'review': {
      if (state !== 'post' || !Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) {
        return { answer: 'Maç henüz bitmedi; tahminin değerlendirmesini maç bitince yapabilirim.', suggestions: SUGGESTIONS.winner };
      }
      return { answer: reviewOf({ H, A, model, content, homeGoals, awayGoals }).text, suggestions: SUGGESTIONS.review };
    }
    case 'whatif': {
      if (state === 'post') return { answer: 'Maç bitti; senaryo sorularını maç öncesinde ya da maç sırasında yanıtlayabilirim.', suggestions: SUGGESTIONS.review };
      if (!probAt) return null;
      const base = state === 'live' && live ? { minute: live.halftime ? 45 : live.minute ?? 0, home: live.home, away: live.away } : { minute: 0, home: 0, away: 0 };
      const sc = scenarioOf(question, { H, A, base });
      if (!sc) {
        return {
          answer: 'Hangi takımın gol attığını ya da hangi skoru merak ettiğini yaz; örneğin "ev sahibi gol atarsa?" ya da "1-1 olursa?".',
          suggestions: ['Ev sahibi gol atarsa?', 'Deplasman gol atarsa?'],
        };
      }
      const before = probAt(base);
      const after = probAt(sc);
      const when = sc.minute !== base.minute ? `${sc.minute}. dakikada` : state === 'live' ? `${base.minute}. dakikada` : 'maçın başında';
      const arrow = (a, b) => `%${pct(a)} → %${pct(b)}`;
      return {
        answer: `${sc.label} (${when}): ${H} ${arrow(before.p1, after.p1)}, beraberlik ${arrow(before.pX, after.pX)}, ${A} ${arrow(before.p2, after.p2)}.`,
        suggestions: SUGGESTIONS.whatif,
      };
    }
    case 'winner': {
      const p = live?.probs ?? null;
      const h = p ? pct(p.p1) : ai.probabilities.home;
      const x = p ? pct(p.pX) : ai.probabilities.draw;
      const a = p ? pct(p.p2) : ai.probabilities.away;
      const head = state === 'live' ? 'Canlı durumda ' : '';
      const verdict = state === 'post' ? `Maç bitti; maç öncesi model ${outcome(ai.pick)} diyordu` : `Model ${outcome(ai.pick)} diyor`;
      const swing = state === 'live' ? ` ${swingText({ H, A, content, live })}` : '';
      return {
        answer: `${head}${H} %${h}, beraberlik %${x}, ${A} %${a}. ${verdict}.${swing}`.replace(/\s+/g, ' ').trim(),
        suggestions: SUGGESTIONS.winner,
      };
    }
    case 'score': {
      if (state === 'live' && live?.probs?.topFinals) {
        const lp = live.probs;
        const finals = lp.topFinals.map((f) => `${f.score} (%${pct(f.p)})`).join(', ');
        return {
          answer: `Skorun böyle bitme ihtimali %${pct(lp.noMoreGoals)}, en az bir gol daha %${pct(lp.moreGoals)}. En olası finaller: ${finals}.`,
          suggestions: SUGGESTIONS.score,
        };
      }
      const next = m.topScores.filter((x) => x.score !== ai.topScore).slice(0, 2).map((x) => `${x.score} (%${pct(x.p)})`);
      const lead = post ? `${post}en olası skor` : 'En olası skor';
      return {
        answer: `${lead} ${ai.topScore}.${next.length ? ` Sıradakiler: ${next.join(', ')}.` : ''}`,
        suggestions: SUGGESTIONS.score,
      };
    }
    case 'goals':
      if (state === 'live' && live?.probs?.remainingGoals) {
        const lp = live.probs;
        return {
          answer: `Kalan sürede beklenen gol: ${H} ${tr1(lp.remainingGoals.home)}, ${A} ${tr1(lp.remainingGoals.away)}. En az bir gol daha %${pct(lp.moreGoals)}; maç sonunda en az üç gol %${pct(lp.over25)}.`,
          suggestions: SUGGESTIONS.goals,
        };
      }
      return {
        answer: `Beklenen toplam gol ${tr1(total)}: ${H} ${tr1(lh)}, ${A} ${tr1(la)}. Maçta en az üç gol olma ihtimali %${pct(m.p.over25)}.`,
        suggestions: SUGGESTIONS.goals,
      };
    case 'second': {
      // Canlı maçta ikinci yarı (ya da devre arası): kalan süre canlı modelden
      if (state === 'live' && live?.probs?.remainingGoals && (live.halftime || (live.period ?? 0) >= 2 || (live.minute ?? 0) > 45)) {
        const lp = live.probs;
        return {
          answer: `${live.halftime ? 'İkinci yarıda' : 'Kalan sürede'} beklenen gol: ${H} ${tr1(lp.remainingGoals.home)}, ${A} ${tr1(lp.remainingGoals.away)}. En az bir gol daha %${pct(lp.moreGoals)}; sıradaki golü ${lp.nextGoal.home >= lp.nextGoal.away ? H : A} atmaya daha yakın (%${pct(Math.max(lp.nextGoal.home, lp.nextGoal.away))}).`,
          suggestions: SUGGESTIONS.second,
        };
      }
      // Maç öncesi: yarıların gol beklentisi ve en az bir gol ihtimali ana modelle aynı tablolardan (belirsizlik dahil)
      const ht = halfTimeTable(lh, la, sigma);
      const sh = scoreMatrix(lh * (1 - HT_SHARE), la * (1 - HT_SHARE), MODEL.dcRhoHalf, 8, sigma);
      return {
        answer: `${post}İlk yarıda beklenen gol ${tr1(total * HT_SHARE)}, ikinci yarıda ${tr1(total * (1 - HT_SHARE))}. İlk yarıda en az bir gol %${pct(ht.over05)}, ikinci yarıda en az bir gol %${pct(1 - sh[0][0])} ihtimalle; ikinci yarılar genelde daha gollü geçer.`,
        suggestions: SUGGESTIONS.second,
      };
    }
    case 'first': {
      const ht = halfTimeTable(lh, la, sigma);
      const table = `${H} önde %${pct(ht.win)}, beraberlik %${pct(ht.draw)}, ${A} önde %${pct(ht.lose)}`;
      const guess = `tahmini devre skoru ${ht.predicted.score}, ilk yarıda en az bir gol %${pct(ht.over05)}`;
      if (state === 'live' && live) {
        if (live.halftime) return { answer: `İlk yarı ${live.home}-${live.away} bitti. Maç öncesi ilk yarı tahmini: ${table}; ${guess}.`, suggestions: SUGGESTIONS.first };
        if ((live.period ?? 0) >= 2 || (live.minute ?? 0) > 45) return { answer: `İlk yarı tamamlandı; maç ${live.minute}. dakikada ${live.home}-${live.away}. Maç öncesi ilk yarı tahmini: ${table}.`, suggestions: SUGGESTIONS.first };
        return { answer: `Maç ${live.minute}. dakikada ${live.home}-${live.away}. Maç öncesi ilk yarı tahmini: ${table}; ${guess}.`, suggestions: SUGGESTIONS.first };
      }
      return { answer: `${post ? 'Maç bitti; maç öncesi ilk yarı tahmini: ' : 'İlk yarı: '}${table}; ${guess}.`, suggestions: SUGGESTIONS.first };
    }
    case 'why': {
      return { answer: whyAnswer({ H, A, model, content, importance }), suggestions: SUGGESTIONS.why };
    }
    case 'importance':
      return {
        answer: `Maçın önemi ${importance.label.toLowerCase()} (${importance.score}/100). ${(importance.reasons ?? []).join(' ')}`.trim(),
        suggestions: SUGGESTIONS.importance,
      };
    default:
      return null;
  }
}

/**
 * Maç sonu değerlendirmesi: maç öncesi tahmin, sonuç, beklenen gol ile gerçekleşen gol farkı ve (tutmadıysa)
 * sonucun maç öncesi ihtimali. Yalnızca maç öncesi motor rakamlarını kullanır.
 */
export function reviewOf({ H, A, model, content, homeGoals, awayGoals }) {
  const ai = content.ai;
  const lh = model.lambdaHome;
  const la = model.lambdaAway;
  const actual = homeGoals > awayGoals ? '1' : homeGoals < awayGoals ? '2' : 'X';
  const hit = actual === ai.pick;
  const scoreHit = `${homeGoals}-${awayGoals}` === ai.topScore;
  const pr = ai.probabilities;
  const pActual = actual === '1' ? pr.home : actual === '2' ? pr.away : pr.draw;
  const said = ai.pick === '1' ? `${H} kazanır` : ai.pick === '2' ? `${A} kazanır` : 'beraberlik çıkar';
  const vs = (g, l) => (g - l >= 1 ? 'beklenenden fazla attı' : l - g >= 1 ? 'beklenenden az attı' : 'beklentiye yakın oynadı');
  const parts = [
    `Maç ${homeGoals}-${awayGoals} bitti.`,
    `Model maç öncesi ${said} demişti; sonuç tahmini ${hit ? 'tuttu' : 'tutmadı'}${scoreHit ? ', skor tahmini de tuttu' : ''}.`,
    `Beklenen gol ${H} ${tr1(lh)}, ${A} ${tr1(la)} idi: ${H} ${vs(homeGoals, lh)} (${homeGoals}), ${A} ${vs(awayGoals, la)} (${awayGoals}).`,
  ];
  if (!hit) {
    parts.push(pActual < 25 ? `Bu sonucun maç öncesi ihtimali %${pActual} idi; sürpriz sayılır.` : `Bu sonucun maç öncesi ihtimali %${pActual} idi; düşük bir ihtimal değildi.`);
  }
  return { hit, scoreHit, text: parts.join(' ') };
}

/** Canlı maçta maç öncesi tahmine göre en çok değişen tarafın kazanma ihtimali. */
export function swingText({ H, A, content, live }) {
  if (!live?.probs) return '';
  const pr = content.ai.probabilities;
  const nowH = pct(live.probs.p1);
  const nowA = pct(live.probs.p2);
  const [T, before, after] = Math.abs(nowH - pr.home) >= Math.abs(nowA - pr.away) ? [H, pr.home, nowH] : [A, pr.away, nowA];
  if (Math.abs(after - before) < 5) return 'Olasılıklar maç öncesi tahmine yakın.';
  return `Maç öncesi ${T} için %${before} olan kazanma ihtimali şimdi %${after}.`;
}

/** Sorudaki takım: "ev sahibi" / "deplasman" ya da takım adındaki 4+ harfli sözcükler. İkisi de ya da hiçbiri yoksa null. */
function sideOf(t, H, A) {
  const words = (name) => norm(name).split(/\s+/).filter((w) => w.length >= 4);
  const has = (name) => words(name).some((w) => t.includes(w));
  const home = /\bev sahibi\b|\bev\b/.test(t) || has(H);
  const away = /\bdeplasman\b|\bkonuk\b/.test(t) || has(A);
  if (home && !away) return 'home';
  if (away && !home) return 'away';
  return null;
}

/**
 * Senaryo: "X gol atarsa", "X gol yerse" ya da "1-1 olursa". base: { minute, home, away }.
 * Dönen: { minute, home, away, label } ya da anlaşılamazsa null.
 */
export function scenarioOf(question, { H, A, base }) {
  let t = norm(question);
  // "75. dakikada", "75 dk", "75'te": senaryonun dakikası (şimdiden önce olamaz, 95'i geçemez)
  let minute = base.minute;
  // Skorun parçası olan sayı ("2-1'de") dakika sayılmaz
  const dk = t.match(/(?<![-:\d]\s*)(\d{1,3})\s*(?:\.|'|’)?\s*(?:dk|dakika\w*|te\b|de\b|da\b|ta\b)/);
  if (dk) {
    const v = Number(dk[1]);
    if (v >= 1 && v <= 95) {
      // "10 dk sonra" göreli, "75. dakikada" mutlak dakikadır
      const relative = /^\s*sonra\b/.test(t.slice(dk.index + dk[0].length));
      minute = relative ? Math.min(95, base.minute + v) : Math.max(base.minute, v);
      t = t.replace(dk[0], ' ');
    }
  }
  const exact = t.match(/(\d+)\s*[-:]\s*(\d+)/);
  if (exact) {
    const home = Number(exact[1]);
    const away = Number(exact[2]);
    // Skor geri gidemez: mevcut skordan düşük senaryo anlamsızdır.
    if (home < base.home || away < base.away || home > 9 || away > 9) return null;
    return { minute, home, away, label: `Skor ${home}-${away} olursa` };
  }
  const side = sideOf(t, H, A);
  if (!side) return null;
  const concedes = /\byerse\b/.test(t);
  const scorer = concedes ? (side === 'home' ? 'away' : 'home') : side;
  return {
    minute,
    home: base.home + (scorer === 'home' ? 1 : 0),
    away: base.away + (scorer === 'away' ? 1 : 0),
    label: `${scorer === 'home' ? H : A} gol atarsa`,
  };
}

/**
 * "Neden?" yanıtı: tahmini en çok etkileyen etkenler, büyüklüklerine göre sıralı (gol beklentisi, puan ortalaması ve
 * sıra, hücum/savunma, form, ev sahibi avantajı, aralarındaki maçlar). Tercih edilen sonucu destekleyenler önce gelir;
 * karşı yöndeki güçlü bir etken de dürüstçe söylenir.
 */
export function whyAnswer({ H, A, model, content, importance }) {
  const ai = content.ai;
  const lh = model.lambdaHome;
  const la = model.lambdaAway;
  const said = ai.pick === '1' ? `${H} kazanır` : ai.pick === '2' ? `${A} kazanır` : 'beraberlik çıkar';
  const fin = (x) => Number.isFinite(x);
  const items = []; // { side: +1 ev lehine / -1 deplasman lehine / 0 denge, w, text }
  const ratio = lh / la;
  items.push({
    side: ratio > 1.08 ? 1 : ratio < 0.93 ? -1 : 0,
    w: Math.abs(Math.log(ratio)) * 2 + 0.01,
    text: `gol beklentisi ${H} ${tr1(lh)}, ${A} ${tr1(la)}`,
  });
  if (fin(model.homePpg) && fin(model.awayPpg) && Math.abs(model.homePpg - model.awayPpg) >= 0.25) {
    const d = model.homePpg - model.awayPpg;
    const rank = fin(model.homeRank) && fin(model.awayRank) ? ` (${H} ${model.homeRank}., ${A} ${model.awayRank}.)` : '';
    items.push({ side: Math.sign(d), w: Math.abs(d), text: `puan ortalaması ${H} ${tr1(model.homePpg)}, ${A} ${tr1(model.awayPpg)}${rank}` });
  }
  if (fin(model.homeGf) && fin(model.awayGa) && fin(model.awayGf) && fin(model.homeGa)) {
    const hEdge = model.homeGf - model.awayGa; // ev hücumu, deplasmanın yediğinden ne kadar fazla
    const aEdge = model.awayGf - model.homeGa;
    const d = model.homeGf - model.homeGa - (model.awayGf - model.awayGa);
    if (Math.abs(d) >= 0.4) {
      items.push({
        side: Math.sign(d),
        w: Math.abs(d) * 0.8,
        text: `gol averajı (maç başı) ${H} ${tr1(model.homeGf)}/${tr1(model.homeGa)}, ${A} ${tr1(model.awayGf)}/${tr1(model.awayGa)}`,
      });
    } else if (Math.max(hEdge, aEdge) >= 0.6) {
      items.push({ side: 0, w: 0.3, text: 'iki takımın da hücumu rakibin savunmasını zorlayacak düzeyde' });
    }
  }
  if (model.homeFormMatches >= 3 && model.awayFormMatches >= 3 && fin(model.homeFormPoints) && fin(model.awayFormPoints)) {
    const fh = model.homeFormPoints / (3 * model.homeFormMatches);
    const fa = model.awayFormPoints / (3 * model.awayFormMatches);
    if (Math.abs(fh - fa) >= 0.2) {
      items.push({
        side: Math.sign(fh - fa),
        w: Math.abs(fh - fa),
        text: `son maçlar: ${H} ${model.homeFormPoints}/${model.homeFormMatches * 3}, ${A} ${model.awayFormPoints}/${model.awayFormMatches * 3} puan`,
      });
    }
  }
  // Farklı liglerin takımları (Avrupa kupası, ulusal kupa): lig gücü farkı
  if (fin(model.leagueRatio) && Math.abs(Math.log(model.leagueRatio)) > 0.05) {
    const name = (slug) => (slug ? LEAGUES[slug]?.name ?? slug : 'farklı bir lig');
    const homeStronger = model.leagueRatio > 1;
    items.push({
      side: homeStronger ? 1 : -1,
      w: Math.abs(Math.log(model.leagueRatio)) * 1.5,
      text: `lig gücü: ${homeStronger ? H : A} daha güçlü bir ligden (${H}: ${name(model.homeLeague)}, ${A}: ${name(model.awayLeague)})`,
    });
  }
  if (!model.neutral) items.push({ side: 1, w: 0.15, text: `${H} kendi sahasında oynuyor (ev sahibi avantajı)` });
  else items.push({ side: 0, w: 0.1, text: 'maç tarafsız sahada (ev sahibi avantajı yok)' });
  const h2h = model.h2h ?? {};
  if (h2h.n >= 3 && Math.abs(h2h.homeWins - h2h.awayWins) >= 2) {
    items.push({
      side: Math.sign(h2h.homeWins - h2h.awayWins),
      w: 0.1 * Math.abs(h2h.homeWins - h2h.awayWins),
      text: `son ${h2h.n} karşılaşmada ${H} ${h2h.homeWins}, ${A} ${h2h.awayWins} galibiyet`,
    });
  }
  const dir = ai.pick === '1' ? 1 : ai.pick === '2' ? -1 : 0;
  const support = items.filter((x) => (dir === 0 ? x.side === 0 || x.w < 0.3 : x.side === dir)).sort((a, b) => b.w - a.w).slice(0, 3);
  const against = dir === 0 ? null : items.filter((x) => x.side === -dir && x.w >= 0.3).sort((a, b) => b.w - a.w)[0];
  const list = (support.length ? support : items.slice(0, 2)).map((x) => x.text);
  const reason = (importance?.reasons ?? [])[0];
  const parts = [
    `Model ${said} diyor (${H} %${ai.probabilities.home}, beraberlik %${ai.probabilities.draw}, ${A} %${ai.probabilities.away}).`,
    `Başlıca nedenler: ${list.join('; ')}.`,
  ];
  if (against) parts.push(`Karşı yönde: ${against.text}; bu yüzden tahmin kesin değil.`);
  if (reason) parts.push(reason);
  return parts.join(' ');
}
