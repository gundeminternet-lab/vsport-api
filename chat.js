// AI Asistan takip soruları. Kullanıcı aynı maç hakkında kısa bir soru sorduğunda (ör. "neden?", "kaç gol?", "ikinci yarı?")
// maç yeniden aranmaz; soru niyeti anlaşılır ve aynı rakamlardan kısa, sayıya dayalı bir yanıt üretilir.
// Sohbet geçmişi sunucuda tutulmaz: istemci aynı maçı yeniden gönderir.
//
// Niyetler: why (neden), score (skor), goals (gol sayısı), second (ikinci yarı), winner (kim kazanır), importance (önem).
// Bunlardan biri yoksa (ya da korner, İY/MS, KG gibi Özel Yorum konusu varsa) mevcut tam yanıt kullanılır.

import { markets } from './content.js';

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
  ['why', /\b(neden|niye|nedeni|sebep|sebebi)\b/],
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
  general: ['Kim kazanır?', 'Skor tahmini?', 'Kaç gol?', 'Korner beklentisi?'],
};

/**
 * Takip yanıtı. girdi: { intent, H, A, model, content, importance, state, live }.
 * Dönen: { answer, suggestions } ya da niyet desteklenmiyorsa null.
 */
export function followUpAnswer({ intent, H, A, model, content, importance, state, live }) {
  if (intent === 'general') return null;
  const lh = model.lambdaHome;
  const la = model.lambdaAway;
  const total = lh + la;
  const sigma = model.sigma ?? 0;
  const m = markets(lh, la, sigma);
  const ai = content.ai;
  const outcome = (pick) => (pick === '1' ? `${H} kazanır` : pick === '2' ? `${A} kazanır` : 'beraberlik çıkar');
  const post = state === 'post' ? 'Maç bitti; maç öncesi tahmine göre ' : '';

  switch (intent) {
    case 'winner': {
      const p = live?.probs ?? null;
      const h = p ? pct(p.p1) : ai.probabilities.home;
      const x = p ? pct(p.pX) : ai.probabilities.draw;
      const a = p ? pct(p.p2) : ai.probabilities.away;
      const head = state === 'live' ? 'Canlı durumda ' : '';
      const verdict = state === 'post' ? `Maç bitti; maç öncesi model ${outcome(ai.pick)} diyordu` : `Model ${outcome(ai.pick)} diyor`;
      return {
        answer: `${head}${H} %${h}, beraberlik %${x}, ${A} %${a}. ${verdict}.`.replace(/\s+/g, ' '),
        suggestions: SUGGESTIONS.winner,
      };
    }
    case 'score': {
      const next = m.topScores.filter((x) => x.score !== ai.topScore).slice(0, 2).map((x) => `${x.score} (%${pct(x.p)})`);
      const lead = post ? `${post}en olası skor` : 'En olası skor';
      return {
        answer: `${lead} ${ai.topScore}.${next.length ? ` Sıradakiler: ${next.join(', ')}.` : ''}`,
        suggestions: SUGGESTIONS.score,
      };
    }
    case 'goals':
      return {
        answer: `Beklenen toplam gol ${tr1(total)}: ${H} ${tr1(lh)}, ${A} ${tr1(la)}. Maçta en az üç gol olma ihtimali %${pct(m.p.over25)}.`,
        suggestions: SUGGESTIONS.goals,
      };
    case 'second': {
      // İlk yarıda gollerin %45'i atılır (ana model ile aynı oran); ikinci yarı kalanıdır.
      const h1 = 1 - Math.exp(-0.45 * total);
      const h2 = 1 - Math.exp(-0.55 * total);
      return {
        answer: `İlk yarıda beklenen gol ${tr1(total * 0.45)}, ikinci yarıda ${tr1(total * 0.55)}. Kabaca, ilk yarıda en az bir gol %${pct(h1)}, ikinci yarıda en az bir gol %${pct(h2)} ihtimalle.`,
        suggestions: SUGGESTIONS.second,
      };
    }
    case 'why': {
      const reasons = (importance?.reasons ?? []).slice(0, 2).join(' ');
      const ppg =
        model.homePpg != null && model.awayPpg != null ? ` Puan ortalaması: ${H} ${tr1(model.homePpg)}, ${A} ${tr1(model.awayPpg)}.` : '';
      return {
        answer: `Beklenen gol: ${H} ${tr1(lh)}, ${A} ${tr1(la)}.${ppg} ${reasons} Tahmin bu rakamlardan çıkıyor.`.replace(/\s+/g, ' ').trim(),
        suggestions: SUGGESTIONS.why,
      };
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
