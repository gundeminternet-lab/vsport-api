// AI seçim kuralları (saf, bağımlılıksız): günlük AI kuponları (ai_coupons.js) ve maçın AI analizindeki "AI seçimleri"
// (content.js), AI Yorumcu ve AI Asistan aynı kuralla seçer. Eşikler 2023-26 geriye dönük testiyle ayarlandı
// (ai_coupons.js başı).

export const lineText = (l) => String(l).replace('.', ',');

/** Seçimin kısa adı ve okunur hâli (takım adlarına ek getirilmez). */
export function pickText(market, H, A) {
  let x;
  if ((x = /^MS ([1X2])$/.exec(market))) return { short: market, label: x[1] === 'X' ? 'Beraberlik' : `${x[1] === '1' ? H : A} kazanır` };
  if ((x = /^Çifte şans ([1X2])-([1X2])$/.exec(market))) {
    const k = `${x[1]}-${x[2]}`;
    return { short: `ÇŞ ${k}`, label: k === '1-X' ? `${H} kaybetmez` : k === 'X-2' ? `${A} kaybetmez` : 'Beraberlik çıkmaz' };
  }
  if ((x = /^İY (\d\.5) (Üst|Alt)$/.exec(market))) return { short: `İY ${lineText(x[1])} ${x[2]}`, label: x[2] === 'Üst' ? 'İlk yarıda gol olur' : 'İlk yarı golsüz biter' };
  if ((x = /^(\d\.5) (Üst|Alt)$/.exec(market))) {
    const l = Number(x[1]);
    return { short: `${lineText(x[1])} ${x[2]}`, label: x[2] === 'Üst' ? `En az ${Math.ceil(l)} gol` : `En çok ${Math.floor(l)} gol` };
  }
  if (market === 'KG Var') return { short: 'KG Var', label: 'İki takım da gol atar' };
  if (market === 'KG Yok') return { short: 'KG Yok', label: 'En az bir takım gol atamaz' };
  if (market === 'İY KG Var') return { short: 'İY KG Var', label: 'İlk yarıda iki takım da gol atar' };
  if ((x = /^İY\/MS ([1X2])\/([1X2])$/.exec(market))) {
    const w = { '1': H, X: 'beraberlik', '2': A };
    return { short: `İY/MS ${x[1]}/${x[2]}`, label: `İlk yarı ${w[x[1]]}, maç sonu ${w[x[2]]}` };
  }
  if ((x = /^İY ([1X2])$/.exec(market))) return { short: market, label: x[1] === 'X' ? 'İlk yarı berabere' : `İlk yarıda önde: ${x[1] === '1' ? H : A}` };
  return { short: market, label: market };
}

/** Gol kuponunda türlerin en düşük ihtimali. */
export const GOAL_MIN = { '1.5 Üst': 0.78, '2.5 Üst': 0.62, 'KG Var': 0.62, 'İY 0.5 Üst': 0.76 };
export const SAFE = new Set(['Çifte şans 1-X', 'Çifte şans X-2', 'Çifte şans 1-2', '1.5 Üst', '3.5 Alt', 'MS 1', 'MS 2', 'İY 0.5 Üst']);
export const BOLD = new Set(['MS 1', 'MS 2', '2.5 Üst', '2.5 Alt', 'KG Var', 'Çifte şans 1-2']);

/** Kupon türlerinin seçim kuralı (ok) ve puanı (büyük iyi). */
export const RULES = {
  banko: { ok: (c) => c.group === 'main' && SAFE.has(c.market) && c.p >= 0.8 && c.p <= 0.95, score: (c) => c.p },
  gunun: { ok: (c) => c.group === 'main' && !c.market.startsWith('İY') && c.p >= 0.68 && c.p < 0.86 && c.odds >= 1.22 && c.odds <= 1.9, score: (c) => c.p * Math.sqrt(c.odds) },
  gol: { ok: (c) => c.market in GOAL_MIN && c.p >= GOAL_MIN[c.market] && c.p < 0.9, score: (c) => c.p * c.odds ** 0.6 },
  surpriz: { ok: (c) => c.group === 'main' && BOLD.has(c.market) && c.p >= 0.47 && c.p < 0.66 && c.odds >= 1.6, score: (c) => c.p * c.odds },
};

/** Maçın AI seçimlerinin türleri (kupon türleriyle aynı adlar). */
export const PICK_KINDS = [
  { kind: 'banko', title: 'Banko' },
  { kind: 'gunun', title: 'Günün seçimi' },
  { kind: 'gol', title: 'Gol tercihi' },
  { kind: 'surpriz', title: 'Sürpriz' },
];

/** Gol ve sonuç ihtimallerinden (content.js → markets().p) ana seçim adayları; oran yoksa AI oranı (1/ihtimal). */
export function mainCandidates(p, H, A, oddsOf = null) {
  const out = [];
  const add = (market, prob) => {
    if (!(prob > 0 && prob < 1)) return;
    const o = oddsOf?.(market) ?? null;
    out.push({ market, ...pickText(market, H, A), group: 'main', p: prob, odds: Math.round((o ?? Math.max(1.01, 1 / prob)) * 100) / 100, source: o ? 'market' : 'ai' });
  };
  add('MS 1', p.ms1);
  add('MS X', p.msX);
  add('MS 2', p.ms2);
  add('Çifte şans 1-X', p.ms1 + p.msX);
  add('Çifte şans 1-2', p.ms1 + p.ms2);
  add('Çifte şans X-2', p.msX + p.ms2);
  for (const [l, v] of [[1.5, p.over15], [2.5, p.over25], [3.5, p.over35]]) {
    add(`${l} Üst`, v);
    add(`${l} Alt`, 1 - v);
  }
  add('KG Var', p.kgVar);
  add('KG Yok', 1 - p.kgVar);
  add('İY 0.5 Üst', p.iyOver05);
  return out;
}

/**
 * Tek maçın AI seçimleri: her tür için kuralına uyan en iyi aday (bir seçim yalnızca bir türde). Uygun aday yoksa o
 * tür çıkmaz. Dönen: [{ kind, title, market, short, label, pct }].
 */
export function aiPicks(p, H, A, { oddsOf = null } = {}) {
  const cands = mainCandidates(p, H, A, oddsOf);
  const used = new Set();
  const out = [];
  for (const { kind, title } of PICK_KINDS) {
    const rule = RULES[kind];
    const best = cands.filter((c) => !used.has(c.market) && rule.ok(c)).sort((a, b) => rule.score(b) - rule.score(a))[0];
    if (!best) continue;
    used.add(best.market);
    out.push({ kind, title, market: best.market, short: best.short, label: best.label, pct: Math.round(best.p * 100) });
  }
  return out;
}
