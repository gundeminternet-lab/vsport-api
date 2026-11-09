// Kişiye özel yorum: kullanıcı maç için bir tahmin türü (maç sonucu, toplam gol, karşılıklı gol, ilk yarı, İY/MS,
// takım golü, skor, korner) ve kendi beklentisini seçer; AI o seçimi o maçın verileriyle tartar.
//
// Herkese aynı metni vermez: yorum seçilen türe ve kullanıcının seçimine göre kurulur (seçimin ihtimali, AI'ın o türdeki
// görüşü, seçimi destekleyen ve zorlayan veriler, seçimi en çok değiştiren maç içi senaryolar, devre arası takibi).
// Cümle kalıpları kullanıcıya göre de değişir (seed: kullanıcı + maç + seçim).
//
// Hesaplar saf fonksiyondur. Yüzdeler uygulamanın her yerinde görülen tahmin yüzdeleriyle aynıdır (content.js →
// markets, kalibrasyon dahil); koşullu senaryolar iki yarının birleşik dağılımından gelir ve aynı ayara oturtulur.
// Dil: takım adlarına ek getirilmez. Arayüz metinlerinde "bahis/kupon/oran" geçmez.

import { baseMatrix, mixtureNodes, scoreMatrix } from './engine/analysis.js';
import { MODEL } from './engine/config.js';
import { cornerDistribution, expectedCorners } from './engine/corners.js';
import { HT_SHARE, markets, phraser } from './content.js';
import { halfModel } from './special.js';

export const ASK_VERSION = 1;

const MAXG = 6;
const pct = (p) => Math.round(Math.max(0, Math.min(1, p)) * 100);
const tr1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
const lineText = (l) => String(l).replace('.', ',');
const clampP = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const logit = (p) => Math.log(clampP(p) / (1 - clampP(p)));
const sig = (x) => 1 / (1 + Math.exp(-x));

/** İki yarının birleşik dağılımı: [{ p, i, j, k, l }] (i,j ilk yarı golleri; k,l ikinci yarı). */
export function jointHalves({ lambdaHome, lambdaAway, sigma = 0 }) {
  const cells = [];
  let total = 0;
  for (const n of mixtureNodes(lambdaHome, lambdaAway, sigma)) {
    const h1 = baseMatrix(n.lh * HT_SHARE, n.la * HT_SHARE, MODEL.dcRhoHalf, MAXG);
    const h2 = baseMatrix(n.lh * (1 - HT_SHARE), n.la * (1 - HT_SHARE), MODEL.dcRhoHalf, MAXG);
    for (let i = 0; i <= MAXG; i++) {
      for (let j = 0; j <= MAXG; j++) {
        const a = n.w * h1[i][j];
        if (a < 1e-8) continue;
        for (let k = 0; k <= MAXG; k++) {
          for (let l = 0; l <= MAXG; l++) {
            const p = a * h2[k][l];
            if (p < 1e-9) continue;
            cells.push({ p, i, j, k, l, h: i + k, a: j + l });
            total += p;
          }
        }
      }
    }
  }
  for (const c of cells) c.p /= total;
  return cells;
}

const sum = (cells, test) => cells.reduce((s, c) => (test(c) ? s + c.p : s), 0);

/** P(olay | koşul). Koşulun ihtimali çok küçükse null. */
function cond(cells, test, given, weight = null) {
  let num = 0;
  let den = 0;
  for (const c of cells) {
    const w = weight ? weight(c) : given(c) ? 1 : 0;
    if (!w) continue;
    den += c.p * w;
    if (test(c)) num += c.p * w;
  }
  return den > 1e-6 ? { p: num / den, given: den } : null;
}

// -----------------------------------------------------------------------------------------------------------------
// Tahmin türleri ve seçenekleri
// -----------------------------------------------------------------------------------------------------------------
const SIDE = { '1': 1, X: 0, '2': -1 };
const outcome = (h, a) => (h > a ? '1' : h === a ? 'X' : '2');

/** Türler (uygulamadaki seçim ekranı da bu listeyi kullanır). */
export const ASK_MARKETS = [
  { id: 'ms', title: 'Maç sonucu', hint: 'Kim kazanır?' },
  { id: 'dc', title: 'Çifte şans', hint: 'İki sonuçtan biri' },
  { id: 'au', title: 'Toplam gol', hint: '1,5 · 2,5 · 3,5 alt/üst' },
  { id: 'kg', title: 'Karşılıklı gol', hint: 'İki takım da gol atar mı?' },
  { id: 'tg', title: 'Takım golü', hint: 'Bir takımın gol sayısı' },
  { id: 'iy', title: 'İlk yarı sonucu', hint: 'Devre arası kim önde?' },
  { id: 'iyg', title: 'İlk yarı gol', hint: 'İlk 45 dakikada gol' },
  { id: 'iyms', title: 'İlk yarı / maç sonu', hint: 'Dokuz birleşimden biri' },
  { id: 'score', title: 'Skor', hint: 'Maç kaç kaç biter?' },
  { id: 'corners', title: 'Korner', hint: 'Toplam korner alt/üst' },
];
export const ASK_MARKET_IDS = ASK_MARKETS.map((m) => m.id);

/**
 * Bir türün seçenekleri: { id, label, short, test(c), official(ctx), lean }. lean: seçimin yönü (verileri destek/karşı diye
 * ayırmak için): side (+ ev sahibi), draw, goals (+ gollü), hs / as (ev sahibi / deplasman gol atar), first (ilk yarı ağırlıklı).
 */
function optionsOf(market, { H, A, ctx }) {
  const p = ctx.p;
  switch (market) {
    case 'ms':
      return [
        { id: '1', label: `${H} kazanır`, short: 'MS 1', test: (c) => c.h > c.a, official: () => p.ms1, lean: { side: 1, draw: -0.5 } },
        { id: 'X', label: 'Berabere biter', short: 'MS X', test: (c) => c.h === c.a, official: () => p.msX, lean: { draw: 1, goals: -0.3 } },
        { id: '2', label: `${A} kazanır`, short: 'MS 2', test: (c) => c.h < c.a, official: () => p.ms2, lean: { side: -1, draw: -0.5 } },
      ];
    case 'dc':
      return [
        { id: '1X', label: `${H} kaybetmez`, short: 'Çifte şans 1-X', test: (c) => c.h >= c.a, official: () => p.ms1 + p.msX, lean: { side: 0.6, draw: 0.3 } },
        { id: '12', label: 'Beraberlik çıkmaz', short: 'Çifte şans 1-2', test: (c) => c.h !== c.a, official: () => p.ms1 + p.ms2, lean: { draw: -1, goals: 0.3 } },
        { id: 'X2', label: `${A} kaybetmez`, short: 'Çifte şans X-2', test: (c) => c.h <= c.a, official: () => p.ms2 + p.msX, lean: { side: -0.6, draw: 0.3 } },
      ];
    case 'au': {
      const off = { 1.5: p.over15, 2.5: p.over25, 3.5: p.over35 };
      return [1.5, 2.5, 3.5].flatMap((line) => [
        { id: `${line} Üst`, label: `${lineText(line)} üst: en az ${Math.ceil(line)} gol`, short: `${lineText(line)} Üst`, test: (c) => c.h + c.a > line, official: () => off[line], lean: { goals: 1 } },
        { id: `${line} Alt`, label: `${lineText(line)} alt: en çok ${Math.floor(line)} gol`, short: `${lineText(line)} Alt`, test: (c) => c.h + c.a < line, official: () => 1 - off[line], lean: { goals: -1 } },
      ]);
    }
    case 'kg':
      return [
        { id: 'Var', label: 'İki takım da gol atar', short: 'KG Var', test: (c) => c.h > 0 && c.a > 0, official: () => p.kgVar, lean: { hs: 1, as: 1, goals: 0.5 } },
        { id: 'Yok', label: 'En az bir takım gol atamaz', short: 'KG Yok', test: (c) => !(c.h > 0 && c.a > 0), official: () => 1 - p.kgVar, lean: { hs: -0.7, as: -0.7, goals: -0.5 } },
      ];
    case 'tg':
      return [
        { id: 'H1', label: `${H} gol atar`, short: `${H} 0,5 üst`, test: (c) => c.h >= 1, official: null, lean: { hs: 1 } },
        { id: 'H2', label: `${H} en az 2 gol atar`, short: `${H} 1,5 üst`, test: (c) => c.h >= 2, official: null, lean: { hs: 1.3, side: 0.4 } },
        { id: 'H0', label: `${H} gol atamaz`, short: `${H} 0,5 alt`, test: (c) => c.h === 0, official: null, lean: { hs: -1 } },
        { id: 'A1', label: `${A} gol atar`, short: `${A} 0,5 üst`, test: (c) => c.a >= 1, official: null, lean: { as: 1 } },
        { id: 'A2', label: `${A} en az 2 gol atar`, short: `${A} 1,5 üst`, test: (c) => c.a >= 2, official: null, lean: { as: 1.3, side: -0.4 } },
        { id: 'A0', label: `${A} gol atamaz`, short: `${A} 0,5 alt`, test: (c) => c.a === 0, official: null, lean: { as: -1 } },
      ];
    case 'iy':
      return [
        { id: '1', label: `${H} ilk yarıyı önde kapatır`, short: 'İY 1', test: (c) => c.i > c.j, official: () => p.iy1, lean: { side: 1, first: 1 } },
        { id: 'X', label: 'İlk yarı berabere biter', short: 'İY X', test: (c) => c.i === c.j, official: () => p.iyX, lean: { draw: 1, goals: -0.5, first: 1 } },
        { id: '2', label: `${A} ilk yarıyı önde kapatır`, short: 'İY 2', test: (c) => c.i < c.j, official: () => p.iy2, lean: { side: -1, first: 1 } },
      ];
    case 'iyg':
      return [
        { id: '0.5 Üst', label: 'İlk yarıda gol olur', short: 'İY 0,5 Üst', test: (c) => c.i + c.j >= 1, official: () => p.iyOver05, lean: { goals: 1, first: 1 } },
        { id: '0.5 Alt', label: 'İlk yarı golsüz biter', short: 'İY 0,5 Alt', test: (c) => c.i + c.j === 0, official: () => 1 - p.iyOver05, lean: { goals: -1, first: 1 } },
        { id: '1.5 Üst', label: 'İlk yarıda en az 2 gol', short: 'İY 1,5 Üst', test: (c) => c.i + c.j >= 2, official: null, lean: { goals: 1.3, first: 1 } },
        { id: '1.5 Alt', label: 'İlk yarıda en çok 1 gol', short: 'İY 1,5 Alt', test: (c) => c.i + c.j <= 1, official: null, lean: { goals: -0.8, first: 1 } },
      ];
    case 'iyms': {
      const grid = Object.fromEntries(ctx.half().grid.map((g) => [g.key, g.p]));
      const word = { '1': H, X: 'beraberlik', '2': A };
      return ['1', 'X', '2'].flatMap((x) =>
        ['1', 'X', '2'].map((y) => ({
          id: `${x}/${y}`,
          label: x === y ? (x === 'X' ? 'İlk yarı da maç da berabere' : `${word[x]} iki yarıyı da önde bitirir`) : `İlk yarı ${word[x]}, maç sonu ${word[y]}`,
          short: `İY/MS ${x}/${y}`,
          test: (c) => outcome(c.i, c.j) === x && outcome(c.h, c.a) === y,
          official: () => grid[`${x}/${y}`],
          lean: { side: (SIDE[x] + SIDE[y]) / 2, draw: (x === 'X' ? 0.5 : 0) + (y === 'X' ? 0.5 : 0), first: 0.5 },
        })),
      );
    }
    case 'score': {
      const m = ctx.ft();
      const list = [];
      for (let i = 0; i <= 5; i++) for (let j = 0; j <= 5; j++) list.push({ i, j, p: m[i][j] });
      return list.map(({ i, j, p: q }) => ({
        id: `${i}-${j}`,
        label: `${H} ${i} - ${j} ${A}`,
        short: `Skor ${i}-${j}`,
        test: (c) => c.h === i && c.a === j,
        official: () => q,
        lean: { side: Math.sign(i - j) * Math.min(1, Math.abs(i - j) / 2), draw: i === j ? 1 : -0.3, goals: (i + j - 2.5) / 2, hs: i > 0 ? 0.5 : -1, as: j > 0 ? 0.5 : -1 },
      }));
    }
    default:
      return [];
  }
}

// -----------------------------------------------------------------------------------------------------------------
// Veriler: her biri yönlerle etiketlenir (seçimi destekliyor mu, zorluyor mu)
// -----------------------------------------------------------------------------------------------------------------
function factsOf({ H, A, model, cells, say }) {
  const out = [];
  const lh = model.lambdaHome;
  const la = model.lambdaAway;
  const d = Math.log(lh / la);
  const tot = lh + la;
  const pHs = 1 - sum(cells, (c) => c.h === 0);
  const pAs = 1 - sum(cells, (c) => c.a === 0);
  const fin = (x) => Number.isFinite(x);

  if (Math.abs(d) >= 0.22) {
    const fav = d > 0 ? H : A;
    out.push({
      tags: { side: Math.sign(d) * Math.min(1, Math.abs(d) / 0.6), draw: -0.4 },
      text: say('f.str', [`Gol beklentisinde ${fav} önde: ${H} ${tr1(lh)} – ${tr1(la)} ${A}.`, `Model ${H} için ${tr1(lh)}, ${A} için ${tr1(la)} gol bekliyor; terazi ${fav} tarafında.`]),
    });
  } else {
    out.push({
      tags: { draw: 0.8, side: 0 },
      text: say('f.eq', [`Güçler çok yakın: ${H} ${tr1(lh)} – ${tr1(la)} ${A} gol beklentisi. Beraberliğe açık bir maç.`, `İki takımın gol beklentisi neredeyse eşit (${tr1(lh)} – ${tr1(la)}); küçük detaylar belirleyici olur.`]),
    });
  }
  if (tot >= 2.9) {
    out.push({ tags: { goals: 1, hs: 0.3, as: 0.3 }, text: say('f.hi', [`Toplam gol beklentisi ${tr1(tot)}: gollü bir maç bekleniyor.`, `Model bu maça toplam ${tr1(tot)} gol yazıyor; kaleler rahat etmeyebilir.`]) });
  } else if (tot <= 2.3) {
    out.push({ tags: { goals: -1, draw: 0.3 }, text: say('f.lo', [`Toplam gol beklentisi ${tr1(tot)}: kapalı geçmeye aday bir maç.`, `Model yalnızca ${tr1(tot)} gol bekliyor; tek gol maçı belirleyebilir.`]) });
  } else {
    out.push({ tags: {}, text: `Toplam gol beklentisi ${tr1(tot)}: ne çok gollü ne çok kapalı.` });
  }
  out.push({
    tags: { hs: pHs >= 0.72 ? 0.8 : pHs <= 0.58 ? -0.8 : 0, as: pAs >= 0.72 ? 0.8 : pAs <= 0.58 ? -0.8 : 0 },
    text: `${H} gol bulma ihtimali %${pct(pHs)}, ${A} için %${pct(pAs)}.`,
  });
  if (fin(model.awayGa) && model.awayGa >= 1.5) out.push({ tags: { hs: 0.7, goals: 0.4, side: 0.2 }, text: `${A} maç başına ${tr1(model.awayGa)} gol yiyor; savunması açık veriyor.` });
  if (fin(model.homeGa) && model.homeGa >= 1.5) out.push({ tags: { as: 0.7, goals: 0.4, side: -0.2 }, text: `${H} maç başına ${tr1(model.homeGa)} gol yiyor; savunması açık veriyor.` });
  if (fin(model.awayGa) && model.awayGa <= 0.9) out.push({ tags: { hs: -0.6, goals: -0.4 }, text: `${A} maç başına yalnızca ${tr1(model.awayGa)} gol yiyor; savunması sağlam.` });
  if (fin(model.homeGa) && model.homeGa <= 0.9) out.push({ tags: { as: -0.6, goals: -0.4 }, text: `${H} maç başına yalnızca ${tr1(model.homeGa)} gol yiyor; savunması sağlam.` });
  if (fin(model.homeGf) && model.homeGf >= 1.9) out.push({ tags: { hs: 0.6, goals: 0.4, side: 0.3 }, text: `${H} maç başına ${tr1(model.homeGf)} gol atıyor.` });
  if (fin(model.awayGf) && model.awayGf >= 1.9) out.push({ tags: { as: 0.6, goals: 0.4, side: -0.3 }, text: `${A} maç başına ${tr1(model.awayGf)} gol atıyor.` });
  if (fin(model.homeGf) && model.homeGf <= 0.9) out.push({ tags: { hs: -0.6, goals: -0.3 }, text: `${H} maç başına ${tr1(model.homeGf)} golde kalıyor; hücumu kısır.` });
  if (fin(model.awayGf) && model.awayGf <= 0.9) out.push({ tags: { as: -0.6, goals: -0.3 }, text: `${A} maç başına ${tr1(model.awayGf)} golde kalıyor; hücumu kısır.` });

  const formOf = (pts, n) => (fin(pts) && fin(n) && n >= 3 ? pts / n : null);
  const fh = formOf(model.homeFormPoints, model.homeFormMatches);
  const fa = formOf(model.awayFormPoints, model.awayFormMatches);
  if (fh !== null && fa !== null && Math.abs(fh - fa) >= 0.8) {
    const better = fh > fa ? H : A;
    out.push({
      tags: { side: fh > fa ? 0.5 : -0.5 },
      text: `Form ${better} tarafında: ${H} son ${model.homeFormMatches} maçta ${model.homeFormPoints} puan${model.homeForm ? ` (${model.homeForm})` : ''}, ${A} ${model.awayFormPoints} puan${model.awayForm ? ` (${model.awayForm})` : ''}.`,
    });
  }
  if (fin(model.homeRank) && fin(model.awayRank) && Math.abs(model.homeRank - model.awayRank) >= 5) {
    out.push({
      tags: { side: model.homeRank < model.awayRank ? 0.4 : -0.4 },
      text: `Puan durumunda ${H} ${model.homeRank}. sırada, ${A} ${model.awayRank}. sırada.`,
    });
  }
  const h2h = model.h2h ?? {};
  if ((h2h.n ?? 0) >= 3) {
    const diff = (h2h.homeWins ?? 0) - (h2h.awayWins ?? 0);
    const tags = Math.abs(diff) >= 2 ? { side: Math.sign(diff) * 0.4 } : (h2h.draws ?? 0) * 2 >= h2h.n ? { draw: 0.5 } : {};
    out.push({ tags, text: `Son ${h2h.n} karşılaşmada ${H} ${h2h.homeWins}, ${A} ${h2h.awayWins} galibiyet aldı; ${h2h.draws} maç berabere bitti.` });
  }
  // İlk yarı
  const p00 = sum(cells, (c) => c.i + c.j === 0);
  out.push({
    tags: { first: 1, goals: p00 >= 0.33 ? -0.6 : p00 <= 0.25 ? 0.6 : 0, draw: p00 >= 0.33 ? 0.5 : 0 },
    first: true,
    text: `İlk yarıda ${H} ${tr1(lh * HT_SHARE)}, ${A} ${tr1(la * HT_SHARE)} gol bekleniyor; golsüz devre ihtimali %${pct(p00)}.`,
  });
  return { list: out, pHs, pAs, p00 };
}

/** Verinin seçime etkisi: + destekler, − zorlar. */
function support(tags, lean) {
  let s = 0;
  for (const k of ['side', 'draw', 'goals', 'hs', 'as']) s += (tags[k] ?? 0) * (lean[k] ?? 0);
  return s;
}

// -----------------------------------------------------------------------------------------------------------------
// Ana üretici
// -----------------------------------------------------------------------------------------------------------------

/**
 * market: ASK_MARKET_IDS, choice: seçenek kimliği (skor için "2-1"), model: modelOf() çıktısı (λ, sigma, profiller),
 * corners: { home, away } korner beklentisi (korner türü için), seed: kullanıcı+maç, facts: biten maçın sonucu
 * ({ home, away, ht: [h, a], corners? }).
 */
export function buildAsk({ market, choice, homeName: H, awayName: A, model, corners = null, seed = '', facts = null, aiScore = null }) {
  if (!ASK_MARKET_IDS.includes(market)) throw new Error('bad market');
  const say = phraser(`${seed}|ask|${market}|${choice}`);
  if (market === 'corners') return cornersAsk({ choice, H, A, corners, say, facts, model });

  const cells = jointHalves(model);
  const { p } = markets(model.lambdaHome, model.lambdaAway, model.sigma ?? 0);
  let ftM = null;
  let half = null;
  const ctx = {
    p,
    ft: () => (ftM ??= scoreMatrix(model.lambdaHome, model.lambdaAway, MODEL.dcRho, 10, model.sigma ?? 0)),
    half: () => (half ??= halfModel(model)),
  };
  const options = optionsOf(market, { H, A, ctx });
  const mine = options.find((o) => o.id === choice);
  if (!mine) throw new Error('bad choice');
  const offOf = (o) => (o.official ? o.official() : sum(cells, o.test));
  const rows = options.map((o) => ({ o, p: offOf(o) }));
  // AI'ın bu türdeki seçimi: en olası seçenek (skor türünde AI analizinin skoru)
  let ai = rows.reduce((a, b) => (b.p > a.p ? b : a));
  if (market === 'score' && aiScore) ai = rows.find((r) => r.o.id === aiScore) ?? ai;
  if (market === 'au' || market === 'iyg' || market === 'tg') {
    // Çizgili türlerde AI'ın seçimi kullanıcının çizgisinde (2,5 sorana 2,5 cevabı)
    const pair = rows.filter((r) => r.o.id !== mine.id && sameLine(market, r.o.id, mine.id));
    const mineRow = rows.find((r) => r.o.id === mine.id);
    ai = pair.length && pair[0].p > mineRow.p ? pair[0] : mineRow;
  }
  const pMine = offOf(mine);
  const rawMine = sum(cells, mine.test);
  const shift = logit(pMine) - logit(rawMine);
  const adj = (q) => (q <= 1e-4 || q >= 1 - 1e-4 ? q : sig(logit(q) + shift));
  const agree = ai.o.id === mine.id;

  // Seviye: seçimin ihtimali ve türdeki en iyi seçeneğe yakınlığı
  const best = Math.max(...rows.map((r) => r.p));
  const level = agree ? (pMine >= 0.6 || (rows.length > 3 && pMine >= best * 0.98) ? 'güçlü' : 'makul') : pMine >= best * 0.8 ? 'makul' : pMine >= best * 0.45 ? 'riskli' : 'zor';

  // Senaryolar: ilk gol, devre arası durumları
  const scen = [];
  const add = (text, r) => {
    if (!r || r.given < 0.04) return;
    const q = adj(r.p);
    scen.push({ text, pct: pct(q), delta: pct(q) - pct(pMine), given: pct(r.given) });
  };
  add(`İlk golü ${H} atarsa`, cond(cells, mine.test, null, (c) => (c.h + c.a > 0 ? c.h / (c.h + c.a) : 0)));
  add(`İlk golü ${A} atarsa`, cond(cells, mine.test, null, (c) => (c.h + c.a > 0 ? c.a / (c.h + c.a) : 0)));
  if (market !== 'iy' && market !== 'iyg') {
    add('Devre 0-0 biterse', cond(cells, mine.test, (c) => c.i === 0 && c.j === 0));
    add(`${H} devreyi önde kapatırsa`, cond(cells, mine.test, (c) => c.i > c.j));
    add(`${A} devreyi önde kapatırsa`, cond(cells, mine.test, (c) => c.i < c.j));
    add('Devre gollü beraberlikle biterse', cond(cells, mine.test, (c) => c.i === c.j && c.i > 0));
  }
  const strong = [...scen].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).filter((s) => Math.abs(s.delta) >= 4);
  const scenarios = strong.slice(0, 4);
  const worst = [...scen].sort((a, b) => a.delta - b.delta)[0];
  const bestScen = [...scen].sort((a, b) => b.delta - a.delta)[0];

  // Veriler
  const F = factsOf({ H, A, model, cells, say });
  const firstHalf = market === 'iy' || market === 'iyg' || market === 'iyms';
  const reasons = [];
  for (const f of F.list) {
    if (f.first && !firstHalf) continue;
    const s = support(f.tags, mine.lean);
    if (Math.abs(s) >= 0.15) reasons.push({ kind: s > 0 ? 'for' : 'against', text: f.text, w: Math.abs(s) });
  }
  reasons.sort((a, b) => (a.kind === b.kind ? b.w - a.w : a.kind === 'for' ? -1 : 1));
  const forN = reasons.filter((r) => r.kind === 'for').length;
  const againstN = reasons.length - forN;
  if (!reasons.length) reasons.push({ kind: 'info', text: F.list[0].text, w: 0 });
  // Maç bağlamı (lig durumu, play-off, rotasyon, yorgunluk): AI analiziyle aynı gerekçeler
  const ctxNotes = Array.isArray(model?.context?.notes) ? model.context.notes.slice(0, 2) : [];
  reasons.splice(Math.min(reasons.length, 4), 0, ...ctxNotes.map((text) => ({ kind: 'info', text, w: 0 })));

  const label = mine.short;
  const aiLabel = ai.o.short;
  const verdict = agree
    ? say('v.agree', [
        `AI seninle aynı yönde: ${label} ihtimali %${pct(pMine)}. Bu türde en olası seçenek de bu.`,
        `Seçimin AI'ın okumasıyla örtüşüyor: ${label}, %${pct(pMine)} ile bu türde öne çıkan seçenek.`,
      ])
    : say('v.diff', [
        `AI farklı düşünüyor: senin seçimin ${label} %${pct(pMine)}, AI'ın tercihi ${aiLabel} %${pct(ai.p)}.`,
        `Seçimin ${label} için ihtimal %${pct(pMine)}. AI bu türde ${aiLabel} tarafında (%${pct(ai.p)}).`,
      ]);
  const headline = {
    güçlü: say('h.g', [`${label}: güçlü bir seçim`, `${label} için veriler arkanda`]),
    makul: say('h.m', [`${label}: makul, ama garanti değil`, `${label}: dengeli bir seçim`]),
    riskli: say('h.r', [`${label}: riskli bir seçim`, `${label}: sürpriz isteyen bir seçim`]),
    zor: say('h.z', [`${label}: zor bir seçim`, `${label}: verilere göre uzak ihtimal`]),
  }[level];
  const after = (s) => (s.pct <= 0 ? 'seçimin artık tutmaz' : s.pct >= 100 ? 'seçimin tutmuş olur' : `ihtimal %${s.pct} olur`);
  const risk = worst && worst.delta < -3 ? `Seçimini en çok zorlayan durum: ${worst.text}, ${after(worst)}.` : null;
  const watch = [];
  if (bestScen && bestScen.delta >= 4) watch.push(bestScen.pct >= 100 ? `${bestScen.text} seçimin tutar.` : `${bestScen.text} seçimin güçlenir: ihtimal %${bestScen.pct} olur.`);
  if (worst && worst.delta <= -4) watch.push(`${worst.text} ${after(worst)}.`);
  const summary = [
    verdict,
    forN || againstN ? `Seçimini destekleyen ${forN}, zorlayan ${againstN} veri var.` : null,
    risk,
  ].filter(Boolean);

  const result = facts ? resultOf(mine, facts) : null;
  return {
    version: ASK_VERSION,
    market,
    marketTitle: ASK_MARKETS.find((m) => m.id === market).title,
    choice: mine.id,
    choiceLabel: mine.label,
    short: label,
    pct: pct(pMine),
    level,
    agree,
    ai: { id: ai.o.id, label: ai.o.label, short: aiLabel, pct: pct(ai.p) },
    headline,
    verdict,
    options: rows
      .filter((r) => market !== 'score' || r.o.id === mine.id || r.o.id === ai.o.id || r.p >= rows.map((x) => x.p).sort((a, b) => b - a)[5])
      .sort((a, b) => (market === 'au' || market === 'iyg' || market === 'tg' ? 0 : b.p - a.p))
      .map((r) => ({ id: r.o.id, label: r.o.short, pct: pct(r.p), mine: r.o.id === mine.id, ai: r.o.id === ai.o.id })),
    reasons: reasons.slice(0, 6).map(({ kind, text }) => ({ kind, text })),
    scenarios,
    watch,
    risk,
    summary,
    speech: summary.join(' ').replace(/%(\d+)/g, 'yüzde $1'),
    result,
  };
}

function sameLine(market, a, b) {
  if (market === 'tg') return a[0] === b[0] && ((a[1] === '0' && b[1] === '1') || (a[1] === '1' && b[1] === '0'));
  return a.split(' ')[0] === b.split(' ')[0];
}

function resultOf(option, f) {
  if (!f || !Number.isFinite(f.home) || !Number.isFinite(f.away)) return null;
  const ht = Array.isArray(f.ht) ? f.ht : null;
  const needsHt = /^İY/.test(option.short);
  if (needsHt && !ht) return { done: true, hit: null, score: `${f.home}-${f.away}` };
  const i = ht ? ht[0] : 0;
  const j = ht ? ht[1] : 0;
  const c = { i, j, k: f.home - i, l: f.away - j, h: f.home, a: f.away };
  return { done: true, hit: option.test(c), score: `${f.home}-${f.away}`, ht: ht ? `${ht[0]}-${ht[1]}` : null };
}

// -----------------------------------------------------------------------------------------------------------------
// Korner
// -----------------------------------------------------------------------------------------------------------------
export const CORNER_LINES = [7.5, 8.5, 9.5, 10.5, 11.5];

function cornersAsk({ choice, H, A, corners, say, facts, model }) {
  const exp = corners && Number.isFinite(corners.home) ? corners : expectedCorners({ lambdaHome: model.lambdaHome, lambdaAway: model.lambdaAway });
  const dist = cornerDistribution(exp.home, exp.away, { lines: CORNER_LINES });
  const opts = dist.lines.flatMap((l) => [
    { id: `${l.line} Üst`, short: `${lineText(l.line)} korner üst`, label: `En az ${Math.ceil(l.line)} korner`, p: l.over },
    { id: `${l.line} Alt`, short: `${lineText(l.line)} korner alt`, label: `En çok ${Math.floor(l.line)} korner`, p: l.under },
  ]);
  const mine = opts.find((o) => o.id === choice);
  if (!mine) throw new Error('bad choice');
  const pair = opts.find((o) => o.id !== mine.id && o.id.split(' ')[0] === mine.id.split(' ')[0]);
  const ai = pair.p > mine.p ? pair : mine;
  const agree = ai === mine;
  const total = exp.home + exp.away;
  const over = /Üst$/.test(mine.id);
  const line = Number(mine.id.split(' ')[0]);
  const level = agree ? (mine.p >= 0.6 ? 'güçlü' : 'makul') : mine.p >= ai.p * 0.8 ? 'makul' : mine.p >= ai.p * 0.45 ? 'riskli' : 'zor';
  const reasons = [
    {
      kind: (total > line) === over ? 'for' : 'against',
      text: `Beklenen korner: ${H} ${tr1(exp.home)}, ${A} ${tr1(exp.away)}; toplam ${tr1(total)}.`,
    },
    {
      kind: 'info',
      text: `En olası toplam aralığı ${dist.range.from}-${dist.range.to} korner (%${pct(dist.range.p)}).`,
    },
    {
      kind: 'info',
      text: Math.abs(dist.homeMore - dist.awayMore) < 0.1 ? 'Korner sayısında iki takım başa baş.' : `${dist.homeMore > dist.awayMore ? H : A} daha çok korner kullanır (%${pct(Math.max(dist.homeMore, dist.awayMore))}).`,
    },
  ];
  if (exp.source !== 'data') reasons.push({ kind: 'info', text: 'Takımların korner geçmişi alınamadı; beklenti gol modelinden türetildi, güven daha düşük.' });
  const verdict = agree
    ? `AI seninle aynı yönde: ${mine.short} ihtimali %${pct(mine.p)}.`
    : `AI farklı düşünüyor: ${mine.short} %${pct(mine.p)}, AI'ın tercihi ${ai.short} %${pct(ai.p)}.`;
  const summary = [verdict, `Model toplam ${tr1(total)} korner bekliyor.`];
  const cornersDone = facts && Number.isFinite(facts.corners);
  return {
    version: ASK_VERSION,
    market: 'corners',
    marketTitle: 'Korner',
    choice: mine.id,
    choiceLabel: mine.label,
    short: mine.short,
    pct: pct(mine.p),
    level,
    agree,
    ai: { id: ai.id, label: ai.label, short: ai.short, pct: pct(ai.p) },
    headline: say('c.h', [`${mine.short}: ${level === 'güçlü' ? 'güçlü bir seçim' : level === 'makul' ? 'makul bir seçim' : level === 'riskli' ? 'riskli bir seçim' : 'zor bir seçim'}`]),
    verdict,
    options: opts.map((o) => ({ id: o.id, label: o.short, pct: pct(o.p), mine: o === mine, ai: o === ai })),
    reasons,
    scenarios: [],
    watch: [`Devre arasında korner sayısına bak: kornerlerin yaklaşık yarısı ilk yarıda gelir; devrede ${Math.max(1, Math.round(total * 0.45))} kornerin üstü ${over ? 'seçimini güçlendirir' : 'seçimini zorlar'}.`],
    risk: null,
    summary,
    speech: summary.join(' ').replace(/%(\d+)/g, 'yüzde $1'),
    result: cornersDone ? { done: true, hit: over ? facts.corners > line : facts.corners < line, score: `${facts.corners} korner` } : null,
  };
}

/** Seçimin geçerli mi (tür ve seçenek): uygulamadan gelen isteği doğrular. */
export function validChoice(market, choice) {
  if (!ASK_MARKET_IDS.includes(market) || typeof choice !== 'string' || choice.length > 12) return false;
  switch (market) {
    case 'ms':
    case 'iy':
      return ['1', 'X', '2'].includes(choice);
    case 'dc':
      return ['1X', '12', 'X2'].includes(choice);
    case 'au':
      return /^[123]\.5 (Üst|Alt)$/.test(choice);
    case 'kg':
      return choice === 'Var' || choice === 'Yok';
    case 'tg':
      return /^[HA][012]$/.test(choice);
    case 'iyg':
      return /^[01]\.5 (Üst|Alt)$/.test(choice);
    case 'iyms':
      return /^[1X2]\/[1X2]$/.test(choice);
    case 'score':
      return /^[0-5]-[0-5]$/.test(choice);
    case 'corners':
      return CORNER_LINES.some((l) => choice === `${l} Üst` || choice === `${l} Alt`);
    default:
      return false;
  }
}
