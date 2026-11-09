// Tek senaryo: AI analizi, simülasyon, AI Yorumcu videosu ve Özel Yorum aynı skoru anlatsın.
//
// "Tahmin edilen skor" tablonun genel zirvesi değil (çoğu maçta 1-1), modelin öne sürdüğü bütün güçlü öngörülerle
// çelişmeyen en olası skordur: sonuç tahmini (1/X/2) her zaman, 2,5 gol alt/üst ve karşılıklı gol ise ihtimali
// [SCENARIO_MIN] ve üstündeyse. Böylece "ev sahibi kazanır, en az 3 gol, iki takım da atar" diyen analiz 2-1
// gösterir; simülasyon da tam bu skorla biter. Öngörüler birbiriyle bağdaşmazsa (ör. 1 + KG Var + 2,5 Alt) en zayıf
// olan bırakılır.

export const SCENARIO_MIN = 0.55;

const outcomeOf = (i, j) => (i > j ? '1' : i < j ? '2' : 'X');

/**
 * matrix: skor tablosu (satır ev golü). outcome: '1' | 'X' | '2'. over25 / btts: gösterilen (kalibre) ihtimaller.
 * Döner: { home, away, score, p, constraints: ['over25'|'under25'|'btts'|'nobtts'] }.
 */
export function coherentScore(matrix, { outcome, over25 = null, btts = null, min = SCENARIO_MIN } = {}) {
  const cons = [];
  if (Number.isFinite(over25) && Math.max(over25, 1 - over25) >= min) {
    cons.push(over25 >= 0.5 ? { k: 'over25', s: over25, f: (i, j) => i + j >= 3 } : { k: 'under25', s: 1 - over25, f: (i, j) => i + j <= 2 });
  }
  if (Number.isFinite(btts) && Math.max(btts, 1 - btts) >= min) {
    cons.push(btts >= 0.5 ? { k: 'btts', s: btts, f: (i, j) => i > 0 && j > 0 } : { k: 'nobtts', s: 1 - btts, f: (i, j) => i === 0 || j === 0 });
  }
  cons.sort((a, b) => b.s - a.s);
  for (let n = cons.length; n >= 0; n--) {
    const active = cons.slice(0, n);
    let best = null;
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        if (outcome && outcomeOf(i, j) !== outcome) continue;
        if (!active.every((c) => c.f(i, j))) continue;
        if (!best || matrix[i][j] > best.p) best = { home: i, away: j, score: `${i}-${j}`, p: matrix[i][j], constraints: active.map((c) => c.k) };
      }
    }
    if (best) return best;
  }
  return { home: 1, away: 1, score: '1-1', p: 0, constraints: [] };
}

/**
 * Devre skoru, maç sonu skoruyla uyumlu (her iki tarafta da maç sonundan fazla değil). htScores: olasılığa göre sıralı
 * [{ home, away, p }]; preferred: ilk yarı tahmini (uyumluysa o). Uyumlu yoksa null.
 */
export function compatibleHalf(htScores, target, preferred = null) {
  const fits = (s) => s && s.home <= target.home && s.away <= target.away;
  if (fits(preferred)) return { home: preferred.home, away: preferred.away };
  const s = (htScores ?? []).find(fits);
  return s ? { home: s.home, away: s.away } : null;
}
