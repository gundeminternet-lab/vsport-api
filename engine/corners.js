// Korner modeli. ESPN maç özetindeki "wonCorners" (kazanılan korner) verisinden takımların son maçlardaki korner
// sayıları okunur; maç için takım başı beklenti hesaplanır ve negatif binom dağılımıyla toplam/çizgi olasılıkları çıkar.
//
// Veri yetersizse (yeni kupa maçı, ESPN korner vermiyor) gol beklentilerinden türetilen kaba bir model kullanılır ve
// sonuç "model" kaynaklı olarak işaretlenir; ekran bunu açıkça belirtir.

/** Lig geneli takım başı maç başı korner ortalaması (kabaca; veri azsa bu değere doğru çekilir). */
export const CORNER_BASE = 5.0;
/** Negatif binom dağılım parametresi: büyük = Poisson'a yakın. Gerçek korner sayıları hafif aşırı dağılımlıdır. */
export const CORNER_DISPERSION = 18;

/** Maç özeti yanıtından { takımId: korner } çıkarır; veri yoksa null. */
export function parseCorners(json) {
  const out = {};
  for (const t of json?.boxscore?.teams ?? []) {
    const id = t?.team?.id;
    const stat = (t?.statistics ?? []).find((s) => s?.name === 'wonCorners');
    const v = Number(stat?.displayValue ?? stat?.value);
    if (id !== undefined && id !== null && Number.isFinite(v) && v >= 0 && v <= 40) out[String(id)] = v;
  }
  return Object.keys(out).length >= 2 ? out : null;
}

const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

/**
 * Bir takımın son maçlarındaki korner sayıları: [{ for, against }]. Özeti alınamayan maçlar atlanır.
 * matches: takım hafızasındaki maçlar (id, league, homeId, awayId, timestamp); en yeni önce olmalıdır.
 */
export async function collectCornerSamples({ espn, teamId, matches, before, max = 8 }) {
  const id = String(teamId);
  const recent = matches
    .filter((m) => m.completed !== false && m.timestamp < before && (String(m.homeId) === id || String(m.awayId) === id))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, max);
  if (typeof espn.getSummary !== 'function') return [];
  const results = await mapLimit(recent, 4, async (m) => {
    try {
      const json = await espn.getSummary(m.league, m.id, { maxAgeMs: 24 * 3600 * 1000 });
      const c = parseCorners(json);
      if (!c) return null;
      const opp = String(m.homeId) === id ? String(m.awayId) : String(m.homeId);
      if (c[id] === undefined || c[opp] === undefined) return null;
      return { for: c[id], against: c[opp] };
    } catch {
      return null;
    }
  });
  return results.filter(Boolean);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Gol beklentilerinden türetilen kaba korner beklentisi (veri yokken). Üstün taraf daha çok korner kullanır. */
export function modelCorners(lambdaHome, lambdaAway) {
  return {
    home: 5.5 * Math.sqrt(Math.max(0.2, lambdaHome) / 1.45),
    away: 4.5 * Math.sqrt(Math.max(0.2, lambdaAway) / 1.15),
  };
}

/**
 * Maç için takım başı korner beklentisi.
 * homeSamples / awaySamples: [{ for, against }] (en az 2 maç anlamlıdır).
 * Karışım: veri ağırlığı örnek sayısıyla artar (0 → yalnızca model, 8 → ağırlıklı veri).
 */
export function expectedCorners({ lambdaHome, lambdaAway, homeSamples = [], awaySamples = [] }) {
  const model = modelCorners(lambdaHome, lambdaAway);
  const usable = homeSamples.length >= 2 && awaySamples.length >= 2;
  if (!usable) {
    return { home: model.home, away: model.away, source: 'model', nHome: homeSamples.length, nAway: awaySamples.length };
  }
  const k = 4; // lig ortalamasına çeken sahte maç sayısı
  const shrink = (xs, key) => (xs.reduce((s, x) => s + x[key], 0) + k * CORNER_BASE) / (xs.length + k);
  const hFor = shrink(homeSamples, 'for');
  const hAgainst = shrink(homeSamples, 'against');
  const aFor = shrink(awaySamples, 'for');
  const aAgainst = shrink(awaySamples, 'against');
  // Ev sahibinin korneri: kendi üretimi ile rakibin verdiği ortalaması; ev avantajı hafif.
  const dataHome = ((hFor + aAgainst) / 2) * 1.06;
  const dataAway = ((aFor + hAgainst) / 2) * 0.94;
  const wData = Math.min(0.75, 0.25 + 0.06 * Math.min(homeSamples.length, awaySamples.length));
  return {
    home: wData * dataHome + (1 - wData) * model.home,
    away: wData * dataAway + (1 - wData) * model.away,
    source: 'data',
    nHome: homeSamples.length,
    nAway: awaySamples.length,
    avgHome: { for: mean(homeSamples.map((s) => s.for)), against: mean(homeSamples.map((s) => s.against)) },
    avgAway: { for: mean(awaySamples.map((s) => s.for)), against: mean(awaySamples.map((s) => s.against)) },
  };
}

/** Negatif binom olasılık kütle fonksiyonu (0..maxK), ortalama mu, dağılım r. */
export function nbPmf(mu, r = CORNER_DISPERSION, maxK = 40) {
  const m = Math.max(0.05, mu);
  const p = r / (r + m); // başarı olasılığı
  const out = [Math.pow(p, r)];
  for (let k = 1; k <= maxK; k++) out.push((out[k - 1] * (k - 1 + r) * (1 - p)) / k);
  const total = out.reduce((a, b) => a + b, 0);
  return out.map((x) => x / total);
}

function convolve(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) out[i + j] += a[i] * b[j];
  return out;
}

/** Korner dağılımları: takım başı, toplam, çizgiler (alt/üst) ve "hangi takım daha çok korner kullanır". */
export function cornerDistribution(homeMean, awayMean, { lines = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5] } = {}) {
  const h = nbPmf(homeMean);
  const a = nbPmf(awayMean);
  const total = convolve(h, a);
  const over = (line) => total.reduce((s, p, k) => s + (k > line ? p : 0), 0);
  let homeMore = 0;
  let equal = 0;
  let awayMore = 0;
  for (let i = 0; i < h.length; i++) {
    for (let j = 0; j < a.length; j++) {
      const p = h[i] * a[j];
      if (i > j) homeMore += p;
      else if (i === j) equal += p;
      else awayMore += p;
    }
  }
  // En olası 3'lü toplam aralığı (ör. 9-11): kayan pencereyle en yüksek olasılık
  let best = { from: 0, p: 0 };
  for (let k = 0; k + 2 < total.length; k++) {
    const p = total[k] + total[k + 1] + total[k + 2];
    if (p > best.p) best = { from: k, p };
  }
  return {
    total,
    lines: lines.map((line) => ({ line, over: over(line), under: 1 - over(line) })),
    homeMore,
    equal,
    awayMore,
    range: { from: best.from, to: best.from + 2, p: best.p },
    homeOver: (line) => h.reduce((s, p, k) => s + (k > line ? p : 0), 0),
    awayOver: (line) => a.reduce((s, p, k) => s + (k > line ? p : 0), 0),
  };
}
