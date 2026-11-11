// Sosyal bölümün saf kuralları: @bahsetme, gönderi ekleri (anket, skor düellosu, alıntı, Benim 11'im, kupon,
// oyuncu puanları), tepkiler, düello puanı, görev tanımları ve hafta kimliği. Firestore'a dokunmaz; test edilir.

import { periodIds } from './league.js';
import { trDay } from './progress.js';

/** Tepkiler: alev, gol, şaşkın, gülme. */
export const REACTIONS = ['fire', 'goal', 'wow', 'lol'];

/** Skor düellosu ödülü (yalnızca kazanılır; kredi ortaya konmaz). Günlük üst sınır kötüye kullanımı önler. */
export const DUEL = { exact: 300, outcome: 100, dailyCap: 600, minLeadMs: 5 * 60e3, maxGoals: 15 };

/** Anket süresi (saat) seçenekleri. */
export const POLL_HOURS = [1, 6, 24, 72];

/** Görevler. Günlük görevler her gün, haftalık görevler Pazartesi yenilenir. Ödüller yalnızca kazanılır. */
export const MISSIONS = {
  daily: [
    { id: 'post', title: 'Bir gönderi paylaş', target: 1, reward: { type: 'credits', amount: 30 } },
    { id: 'vote', title: 'Bir ankete oy ver', target: 1, reward: { type: 'credits', amount: 20 } },
    { id: 'react', title: '5 gönderiye tepki bırak', target: 5, reward: { type: 'credits', amount: 25 } },
    { id: 'comment', title: 'Bir gönderiye yorum yap', target: 1, reward: { type: 'credits', amount: 25 } },
  ],
  weekly: [
    { id: 'duelWin', title: '3 skor düellosu kazan', target: 3, reward: { type: 'credits', amount: 150 } },
    { id: 'reactsRecv', title: 'Gönderilerin 50 tepki toplasın', target: 50, reward: { type: 'credits', amount: 100 } },
    { id: 'rated', title: '4 maçta oyuncuları puanla', target: 4, reward: { type: 'token', pack: 'gumus', amount: 1 } },
  ],
  /** Her gün en az bir günlük görev ödülü alınınca seri artar; 7. günde Gümüş Paket jetonu. */
  streak: { days: 7, reward: { type: 'token', pack: 'gumus', amount: 1 } },
};

/** Sosyal rozetler (sayaçlar social_profiles belgesinde). */
export const SOCIAL_BADGES = [
  { id: 'commenter', title: 'Yorumcu', field: 'comments', target: 50 },
  { id: 'crowd', title: 'Kalabalık', field: 'followers', target: 100 },
  { id: 'dueler', title: 'Düellocu', field: 'duelWins', target: 10 },
  { id: 'rater', title: 'Puan Ustası', field: 'rated', target: 30 },
];

/** Taraftar Savaşı: sıralamaya girmek için haftalık en az tahmin; kazanan topluluğa Altın Paket jetonu. */
export const WAR = { minPredictions: 20, prize: { type: 'token', pack: 'altin', amount: 1 }, switchCooldownMs: 7 * 86400e3 };

export const weekOf = (ms) => periodIds(ms).week;
export const dayOf = (ms) => trDay(ms);
export const prevWeekOf = (ms) => periodIds(ms - 7 * 86400e3).week;

const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, n) : null);
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** "@mertcan sen ne dersin @aslı" → ['mertcan'] (geçerli kullanıcı adları, küçük harf, en çok 5). */
export function extractMentions(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/(^|[^\p{L}\p{N}_@])@([A-Za-z0-9_]{3,20})(?![\p{L}\p{N}_])/gu)) {
    const k = m[2].toLowerCase();
    if (!out.includes(k)) out.push(k);
    if (out.length >= 5) break;
  }
  return out;
}

/** Anket: 2-4 seçenek (en çok 40 harf), süre saat cinsinden. */
export function cleanPoll(p, nowMs) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.options)) return null;
  const options = [];
  for (const o of p.options) {
    const t = str(o, 40);
    if (t && !options.some((x) => x.toLocaleLowerCase('tr') === t.toLocaleLowerCase('tr'))) options.push(t);
  }
  if (options.length < 2 || options.length > 4) return null;
  const hours = POLL_HOURS.includes(p.hours) ? p.hours : 24;
  return { options, counts: Object.fromEntries(options.map((_, i) => [String(i), 0])), total: 0, closesMs: nowMs + hours * 3600e3 };
}

/** Skor tahmini (0-15). */
export function cleanScore(s) {
  if (!s || typeof s !== 'object') return null;
  const home = int(s.home, 0, DUEL.maxGoals);
  const away = int(s.away, 0, DUEL.maxGoals);
  return home === null || away === null ? null : { home, away };
}

/** Düello puanı: tam skor, doğru sonuç ya da ıska. */
export function duelResult(guess, final) {
  if (!guess || !final) return 'miss';
  if (guess.home === final.home && guess.away === final.away) return 'exact';
  return Math.sign(guess.home - guess.away) === Math.sign(final.home - final.away) ? 'outcome' : 'miss';
}

export function duelReward(result) {
  return result === 'exact' ? DUEL.exact : result === 'outcome' ? DUEL.outcome : 0;
}

/** Alıntılanan gönderi özeti. */
export function quoteOf(id, post) {
  if (!post) return null;
  return { id, uid: post.uid ?? null, username: str(post.username, 30) ?? 'kullanıcı', text: str(post.text, 200) ?? '' };
}

/** Benim 11'im kadro kartı. */
export function cleanSquad(s) {
  if (!s || typeof s !== 'object') return null;
  const name = str(s.name, 30);
  if (!name) return null;
  return {
    name,
    divName: str(s.divName, 20),
    power: int(s.power, 0, 150),
    streak: int(s.streak, 0, 999),
    last: str(s.last, 60),
    color: typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : null,
  };
}

/** Kupon kartı: seçimler ve oranlar (kitapçı adı ya da bağlantı yok). */
export function cleanCoupon(c) {
  if (!c || typeof c !== 'object' || !Array.isArray(c.picks)) return null;
  const picks = [];
  for (const p of c.picks.slice(0, 10)) {
    const label = str(p?.label, 60);
    const odd = typeof p?.odd === 'number' && Number.isFinite(p.odd) && p.odd >= 1.01 && p.odd <= 100 ? Math.round(p.odd * 100) / 100 : null;
    if (label) picks.push({ label, odd });
  }
  if (!picks.length) return null;
  const total = picks.every((p) => p.odd) ? Math.round(picks.reduce((a, p) => a * p.odd, 1) * 100) / 100 : null;
  return { title: str(c.title, 40) ?? 'Kupon', picks, total };
}

/** Maç sonu puan kartı: en çok 11 oyuncu ve puanları. */
export function cleanRatings(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.list)) return null;
  const list = [];
  for (const x of r.list.slice(0, 11)) {
    const p = str(x?.p, 40);
    const v = int(x?.r, 1, 10);
    if (p && v !== null) list.push({ p, r: v });
  }
  if (!list.length) return null;
  return { home: str(r.home, 40) ?? '', away: str(r.away, 40) ?? '', score: str(r.score, 9), list };
}

/** Sistem kartı için takım adı ve logo. */
export function teamOf(t) {
  if (!t || typeof t !== 'object') return { name: '', logo: null };
  return { name: str(t.name, 40) ?? '', logo: typeof t.logo === 'string' && /^https:\/\//.test(t.logo) ? t.logo.slice(0, 300) : null };
}

/** Görev durumu: gün/hafta değiştiyse sayaçlar sıfırlanır. */
export function missionState(doc, nowMs) {
  const day = dayOf(nowMs);
  const week = weekOf(nowMs);
  const d = doc?.day === day ? { ...(doc.d ?? {}) } : {};
  const dc = doc?.day === day ? [...(doc.dc ?? [])] : [];
  const w = doc?.week === week ? { ...(doc.w ?? {}) } : {};
  const wc = doc?.week === week ? [...(doc.wc ?? [])] : [];
  const yesterday = dayOf(nowMs - 86400e3);
  const last = doc?.streak?.last ?? null;
  const alive = last === day || last === yesterday;
  const streak = { n: alive ? Number(doc?.streak?.n ?? 0) : 0, last: alive ? last : null };
  const duelCredits = doc?.duelCredits?.day === day ? Number(doc.duelCredits.amt ?? 0) : 0;
  return { day, week, d, dc, w, wc, streak, duelCredits };
}

/** İstemciye gösterilen görev listesi. */
export function missionView(st) {
  const row = (m, counts, claimed) => {
    const progress = Math.min(m.target, Number(counts[m.id] ?? 0));
    return { id: m.id, title: m.title, target: m.target, progress, done: progress >= m.target, claimed: claimed.includes(m.id), reward: m.reward };
  };
  return {
    daily: MISSIONS.daily.map((m) => row(m, st.d, st.dc)),
    weekly: MISSIONS.weekly.map((m) => row(m, st.w, st.wc)),
    streak: { n: st.streak.n, today: st.streak.last === st.day, days: MISSIONS.streak.days, reward: MISSIONS.streak.reward },
    day: st.day,
    week: st.week,
  };
}

/** Topluluk isabeti (yüzde) ve sıralama anahtarı. */
export function accuracy(n, hits) {
  return n > 0 ? Math.round((hits / n) * 100) : null;
}

/** Taraftar Savaşı sırası: en az WAR.minPredictions tahmin; isabet, sonra tam skor, sonra tahmin sayısı. */
export function warTable(teams, min = WAR.minPredictions) {
  return teams
    .map((t) => ({ ...t, n: Number(t.n ?? 0), hits: Number(t.hits ?? 0), exact: Number(t.exact ?? 0) }))
    .map((t) => ({ ...t, acc: accuracy(t.n, t.hits), ranked: t.n >= min }))
    .sort((a, b) => Number(b.ranked) - Number(a.ranked) || (b.hits / Math.max(1, b.n)) - (a.hits / Math.max(1, a.n)) || b.exact - a.exact || b.n - a.n);
}

/** Topluluk kimliği: ESPN takım numarası. */
export function cleanTeam(t) {
  if (!t || typeof t !== 'object') return null;
  const id = typeof t.id === 'string' && /^[0-9]{1,10}$/.test(t.id) ? t.id : null;
  const name = str(t.name, 40);
  if (!id || !name) return null;
  const league = typeof t.league === 'string' && /^[a-z0-9._]{2,30}$/i.test(t.league) ? t.league : null;
  return { id, name, logo: teamOf(t).logo, league };
}

/** İki kullanıcının konuşma kimliği (sıralı). */
export function pairOf(a, b) {
  return [a, b].sort().join('_');
}

/** Mesaj eki: maç, skor düellosu daveti ya da Benim 11'im. */
export function cleanAttach(a, cleanMatch) {
  if (!a || typeof a !== 'object') return null;
  if (a.kind === 'match') {
    const m = cleanMatch(a.match);
    return m ? { kind: 'match', match: m } : null;
  }
  if (a.kind === 'duel') {
    const m = cleanMatch(a.match);
    const postId = typeof a.postId === 'string' && /^[A-Za-z0-9_-]{4,60}$/.test(a.postId) ? a.postId : null;
    const g = cleanScore(a.guess);
    return m && postId ? { kind: 'duel', postId, match: m, guess: g } : null;
  }
  if (a.kind === 'squad') {
    const s = cleanSquad(a.squad);
    return s ? { kind: 'squad', squad: s } : null;
  }
  return null;
}
