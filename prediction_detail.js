// Tahmin detayı (saf): bir maçın bütün tahmin türleri, seçeneklerin olasılıkları ve kısa gerekçeler. Uygulamada
// tahmin kartına dokununca açılan "hangi tahmini merak ediyorsun?" sayfası bunu gösterir.
//
// Gol beklentileri maçın geçerli (son) tahmininden gelir: canlı güncelleme olduysa birleştirilmiş λ, yoksa modelin
// kendi λ'sı. Günlük beş tahmin (ms, iy, au, kg, iyg) kartla birebir aynı seçim ve yüzdeyi gösterir.
// Oran gösterilmez. Takım adlarına ek getirilmez (ad ayrı yazılır: "Galatasaray: 1,6").

import { markets as marketProbs, HT_SHARE } from './content.js';
import { scoreMatrix } from './engine/analysis.js';
import { MODEL } from './engine/config.js';
import { settleMarket } from './settle.js';

const pct = (p) => Math.round(p * 100);
const num1 = (x) => (Number.isFinite(x) ? x.toFixed(1).replace('.', ',') : '-');
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** Detay sayfasındaki türler ve başlıkları (sıra arayüzdeki sıradır). */
export const DETAIL_MARKETS = [
  { id: 'ms', title: 'Maç sonucu' },
  { id: 'cs', title: 'Çifte şans' },
  { id: 'iy', title: 'İlk yarı sonucu' },
  { id: 'au', title: '2,5 gol alt/üst' },
  { id: 'au15', title: '1,5 gol alt/üst' },
  { id: 'au35', title: '3,5 gol alt/üst' },
  { id: 'kg', title: 'Karşılıklı gol' },
  { id: 'iyg', title: 'İlk yarıda gol' },
  { id: 'skor', title: 'Skor' },
];

const titleOf = (id) => DETAIL_MARKETS.find((m) => m.id === id)?.title ?? id;

/** Maçın geçerli gol beklentileri: canlı (birleştirilmiş) → kayıttaki model → içerikteki model. */
export function lambdasOf(entry, contentModel = null) {
  const l = entry?.live?.lambdas;
  if (l && fin(l.home) && fin(l.away)) return { home: l.home, away: l.away, sigma: fin(entry.live.sigma) ? entry.live.sigma : 0, live: true };
  const m = entry?.model;
  if (m && fin(m.lh) && fin(m.la)) return { home: m.lh, away: m.la, sigma: fin(m.sigma) ? m.sigma : 0, live: false };
  if (contentModel && fin(contentModel.lambdaHome) && fin(contentModel.lambdaAway)) {
    return { home: contentModel.lambdaHome, away: contentModel.lambdaAway, sigma: contentModel.sigma ?? 0, live: false };
  }
  return null;
}

/** Ortak gerekçe satırları (içerik modeli yoksa yalnızca gol beklentisi). */
function facts(H, A, lam, cm) {
  const out = {};
  out.xg = `Gol beklentisi — ${H}: ${num1(lam.home)} · ${A}: ${num1(lam.away)}`;
  if (cm) {
    if (fin(cm.homeRank) && fin(cm.awayRank)) out.rank = `Puan durumu — ${H}: ${cm.homeRank}. sıra · ${A}: ${cm.awayRank}. sıra`;
    if (cm.homeForm || cm.awayForm) {
      const f = (s, p) => (s ? `${s}${fin(p) ? ` (${p} puan)` : ''}` : '-');
      out.form = `Son maçlar — ${H}: ${f(cm.homeForm, cm.homeFormPoints)} · ${A}: ${f(cm.awayForm, cm.awayFormPoints)}`;
    }
    const h2h = cm.h2h ?? {};
    if (h2h.n > 0) out.h2h = `Son ${h2h.n} karşılaşma — ${H}: ${h2h.homeWins} galibiyet · ${h2h.draws} beraberlik · ${A}: ${h2h.awayWins} galibiyet`;
    if (fin(cm.homeGf) && fin(cm.awayGf)) {
      out.goals = `Maç başı attığı / yediği gol — ${H}: ${num1(cm.homeGf)} / ${num1(cm.homeGa)} · ${A}: ${num1(cm.awayGf)} / ${num1(cm.awayGa)}`;
    }
    if (cm.neutral) out.neutral = 'Maç tarafsız sahada; ev sahibi avantajı uygulanmadı.';
  }
  return out;
}

/**
 * Detay (saf).
 *   entry: daily_preds kaydı    final: { markets, best, confidence } (daily.js → finalOf)
 *   contentModel: AI içeriğindeki model alanı (form, sıra, gol ortalamaları; yoksa null)
 * Döner: { expected, markets: [{ id, title, pick, pct, options: [{ label, caption, pct }], why: [..], hit }] }
 */
export function predictionDetail(entry, final, contentModel = null) {
  const H = entry.home?.name ?? 'Ev sahibi';
  const A = entry.away?.name ?? 'Deplasman';
  const lam = lambdasOf(entry, contentModel);
  const done = entry.result?.status === 'done' ? entry.result : null;
  const settle = (pick) => (done ? settleMarket(pick, { home: done.home, away: done.away, ht: done.ht ?? null }) : null);
  const card = new Map((final?.markets ?? []).map((m) => [m.id, m]));
  const first = new Map((entry.markets ?? []).map((m) => [m.id, m]));
  const moved = Boolean(entry.live?.markets?.length);

  // Gol beklentisi yoksa (çok eski kayıt) yalnızca kartın beş tahmini, seçeneksiz
  if (!lam) {
    return {
      expected: null,
      markets: [...card.values()].map((m) => ({ id: m.id, title: titleOf(m.id), pick: m.pick, pct: m.pct, options: [], why: [], hit: entry.hits?.[m.id] ?? settle(m.pick) })),
    };
  }

  const { p, topScores } = marketProbs(lam.home, lam.away, lam.sigma);
  const ft = scoreMatrix(lam.home, lam.away, MODEL.dcRho, 10, lam.sigma);
  // ft[i][j]: ev sahibi i, deplasman j gol. Ev sahibinin gol atamaması 0. satır, deplasmanınki 0. sütun.
  const homeZero = ft[0].reduce((s, x) => s + x, 0);
  const awayZero = ft.reduce((s, row) => s + row[0], 0);
  const f = facts(H, A, lam, contentModel);
  const keep = (...xs) => xs.filter(Boolean);

  /** Kartın beş tahmininden biriyse kartla aynı seçim ve yüzde; güncellendiyse ilk tahminle fark gerekçeye eklenir. */
  const fromCard = (id, computed) => {
    const c = card.get(id);
    const pick = c?.pick ?? computed.pick;
    const value = c?.pct ?? computed.pct;
    const extra = [];
    const f0 = first.get(id);
    if (moved && f0 && c) {
      if (f0.pick !== c.pick) extra.push(`Tahmin güncel verilerle değişti: ilk tahmin ${f0.pick.replace('.', ',')} (%${f0.pct}) idi.`);
      else if (f0.pct !== c.pct) extra.push(`Güncel verilerle güncellendi: ilk tahmin %${f0.pct}, şimdi %${c.pct}.`);
    }
    return { pick, pct: value, extra };
  };

  const two = (yes, no, prob) => (prob >= 0.5 ? { pick: yes, pct: pct(prob) } : { pick: no, pct: pct(1 - prob) });
  const out = [];
  const add = (id, computed, options, why) => {
    const c = ['ms', 'iy', 'au', 'kg', 'iyg'].includes(id) ? fromCard(id, computed) : { ...computed, extra: [] };
    // Kart seçimi seçenekler arasında aynı yüzdeyle görünsün; diğerleri toplam 100 olacak biçimde ölçeklenir
    let opts = options;
    const picked = options.find((o) => o.pick === c.pick);
    if (picked && picked.pct !== c.pct && options.length > 1) {
      const rest = options.filter((o) => o !== picked);
      const restSum = rest.reduce((s, o) => s + o.pct, 0);
      const left = Math.max(0, 100 - c.pct);
      opts = options.map((o) => (o === picked ? { ...o, pct: c.pct } : { ...o, pct: restSum > 0 ? Math.round((o.pct / restSum) * left) : Math.round(left / rest.length) }));
    }
    opts = opts.map(({ pick: _p, ...o }) => o);
    out.push({
      id,
      title: titleOf(id),
      pick: c.pick,
      pct: c.pct,
      options: opts,
      why: [...c.extra, ...why],
      hit: entry.hits?.[id] ?? settle(c.pick),
    });
  };

  // Maç sonucu
  {
    const probs = [
      ['1', p.ms1],
      ['X', p.msX],
      ['2', p.ms2],
    ];
    const best = probs.reduce((a, b) => (b[1] > a[1] ? b : a));
    add(
      'ms',
      { pick: `MS ${best[0]}`, pct: pct(best[1]) },
      [
        { pick: 'MS 1', label: '1', caption: H, pct: pct(p.ms1) },
        { pick: 'MS X', label: 'X', caption: 'Beraberlik', pct: pct(p.msX) },
        { pick: 'MS 2', label: '2', caption: A, pct: pct(p.ms2) },
      ],
      keep(f.xg, f.rank, f.form, f.h2h, f.neutral),
    );
  }
  // Çifte şans
  {
    const cs = [
      ['1-X', p.ms1 + p.msX, `${H} kaybetmez`],
      ['1-2', p.ms1 + p.ms2, 'Beraberlik olmaz'],
      ['X-2', p.msX + p.ms2, `${A} kaybetmez`],
    ];
    const best = cs.reduce((a, b) => (b[1] > a[1] ? b : a));
    add(
      'cs',
      { pick: `Çifte şans ${best[0]}`, pct: pct(best[1]) },
      cs.map(([k, v, cap]) => ({ pick: `Çifte şans ${k}`, label: k, caption: cap, pct: pct(v) })),
      keep(`İki sonucu birlikte kapsar; en güçlüsü ${best[0]} (%${pct(best[1])}).`, f.xg, f.form),
    );
  }
  // İlk yarı
  {
    const iy = [
      ['1', p.iy1],
      ['X', p.iyX],
      ['2', p.iy2],
    ];
    const best = iy.reduce((a, b) => (b[1] > a[1] ? b : a));
    add(
      'iy',
      { pick: `İY ${best[0]}`, pct: pct(best[1]) },
      [
        { pick: 'İY 1', label: '1', caption: H, pct: pct(p.iy1) },
        { pick: 'İY X', label: 'X', caption: 'Beraberlik', pct: pct(p.iyX) },
        { pick: 'İY 2', label: '2', caption: A, pct: pct(p.iy2) },
      ],
      keep(
        `İlk yarı gol beklentisi — ${H}: ${num1(lam.home * HT_SHARE)} · ${A}: ${num1(lam.away * HT_SHARE)}`,
        `İlk yarılar daha az gollü geçer; beraberlikle bitme ihtimali %${pct(p.iyX)}.`,
      ),
    );
  }
  // Toplam gol
  const totalWhy = keep(`Toplam gol beklentisi ${num1(lam.home + lam.away)}`, f.goals, `En olası skorlar: ${topScores.slice(0, 3).map((s) => s.score).join(', ')}`);
  for (const [id, line, over] of [
    ['au', '2.5', p.over25],
    ['au15', '1.5', p.over15],
    ['au35', '3.5', p.over35],
  ]) {
    add(
      id,
      two(`${line} Üst`, `${line} Alt`, over),
      [
        { pick: `${line} Üst`, label: 'Üst', caption: `${Number(line) + 0.5} ve üzeri gol`.replace('.', ','), pct: pct(over) },
        { pick: `${line} Alt`, label: 'Alt', caption: `${Number(line) - 0.5} ve altı gol`.replace('.', ','), pct: pct(1 - over) },
      ],
      totalWhy,
    );
  }
  // Karşılıklı gol
  add(
    'kg',
    two('KG Var', 'KG Yok', p.kgVar),
    [
      { pick: 'KG Var', label: 'Var', caption: 'İki takım da gol atar', pct: pct(p.kgVar) },
      { pick: 'KG Yok', label: 'Yok', caption: 'En az bir takım gol atamaz', pct: pct(1 - p.kgVar) },
    ],
    keep(`Gol atma ihtimali — ${H}: %${pct(1 - homeZero)} · ${A}: %${pct(1 - awayZero)}`, f.goals),
  );
  // İlk yarıda gol
  add(
    'iyg',
    two('İY 0.5 Üst', 'İY 0.5 Alt', p.iyOver05),
    [
      { pick: 'İY 0.5 Üst', label: 'Üst', caption: 'İlk yarıda gol olur', pct: pct(p.iyOver05) },
      { pick: 'İY 0.5 Alt', label: 'Alt', caption: 'İlk yarı golsüz', pct: pct(1 - p.iyOver05) },
    ],
    keep(`İlk yarı toplam gol beklentisi ${num1((lam.home + lam.away) * HT_SHARE)}`, 'Gollerin yaklaşık %45\'i ilk yarıda atılır.'),
  );
  // Skor
  {
    const top = topScores.slice(0, 5);
    const sum = top.reduce((s, x) => s + x.p, 0);
    const actual = done ? `${done.home}-${done.away}` : null;
    out.push({
      id: 'skor',
      title: titleOf('skor'),
      pick: top[0].score,
      pct: pct(top[0].p),
      options: top.map((s) => ({ label: s.score, caption: null, pct: pct(s.p) })),
      why: keep(`Skor tahmini en zor tahmindir: en olası beş skorun toplamı %${pct(sum)}.`, f.xg),
      hit: actual ? actual === top[0].score : null,
    });
  }

  return { expected: { home: Math.round(lam.home * 100) / 100, away: Math.round(lam.away * 100) / 100 }, markets: out };
}
