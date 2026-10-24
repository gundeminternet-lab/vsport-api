// Ücretli içeriklerin üretimi (Firebase'den bağımsız, saf fonksiyonlar; test edilebilir).
//
//   ai   : istatistik motorunun yazdığı maç analizi (form, gol, lig, H2H, favori, öne çıkan tercih)
//   odds : kazanabilecek bahis ihtimalleri (MS, çifte şans, KG, alt/üst, İY, en olası skorlar, adil oran)
//   sim  : 60 saniyelik simülasyon; oyuncu/top konumları kare kare hazırlanır, telefon yalnızca çizer

import { scoreMatrix, scoresForOutcome } from './engine/analysis.js';
import { simulateMatch, simulateToScore } from './engine/simulator.js';
import { createRng, seedToInt } from './engine/rng.js';
import { MODEL } from './engine/config.js';
import { buildChoreography } from './engine/animation/choreography.js';
import { buildPlayers } from './engine/animation/players.js';

export const PRICES = { ai: 50, odds: 50, sim: 100 };
// 2: lig geneli güç modeli, belirsizlik katmanı, tahminle tutarlı skor ve simülasyon
// 3: zengin anlatım dili (cümle çeşitliliği, seri/form yorumları, "Maçın anahtarı" bölümü)
export const CONTENT_VERSION = 3;

const pct = (p) => Math.round(p * 100);
const r2 = (x) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------------
// Olasılıklar
// ---------------------------------------------------------------------------------------------------
function sumMatrix(m, pred) {
  let s = 0;
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (pred(i, j)) s += m[i][j];
  return s;
}

export function markets(lambdaHome, lambdaAway, sigma = 0) {
  const ft = scoreMatrix(lambdaHome, lambdaAway, MODEL.dcRho, 10, sigma);
  // İlk yarıda gollerin ~%45'i atılır.
  const ht = scoreMatrix(lambdaHome * 0.45, lambdaAway * 0.45, MODEL.dcRho, 10, sigma);
  const p = {
    ms1: sumMatrix(ft, (i, j) => i > j),
    msX: sumMatrix(ft, (i, j) => i === j),
    ms2: sumMatrix(ft, (i, j) => i < j),
    kgVar: sumMatrix(ft, (i, j) => i > 0 && j > 0),
    over15: sumMatrix(ft, (i, j) => i + j >= 2),
    over25: sumMatrix(ft, (i, j) => i + j >= 3),
    over35: sumMatrix(ft, (i, j) => i + j >= 4),
    iy1: sumMatrix(ht, (i, j) => i > j),
    iyX: sumMatrix(ht, (i, j) => i === j),
    iy2: sumMatrix(ht, (i, j) => i < j),
    iyOver05: sumMatrix(ht, (i, j) => i + j >= 1),
  };
  const scores = [];
  for (let i = 0; i < ft.length; i++) for (let j = 0; j < ft[i].length; j++) scores.push({ score: `${i}-${j}`, p: ft[i][j] });
  scores.sort((a, b) => b.p - a.p);
  return { p, topScores: scores.slice(0, 6) };
}

const fairOdd = (p) => (p > 0.01 ? Math.round((1 / p) * 100) / 100 : null);

export function buildOdds(analysis) {
  const { p, topScores } = markets(analysis.lambdaHome, analysis.lambdaAway, analysis.sigma);
  const predicted = predictedScore(analysis);
  const row = (key, label, prob) => ({ key, label, pct: pct(prob), fairOdd: fairOdd(prob) });
  const groups = [
    { title: 'Maç sonucu', items: [row('ms1', 'MS 1', p.ms1), row('msX', 'MS X', p.msX), row('ms2', 'MS 2', p.ms2)] },
    {
      title: 'Çifte şans',
      items: [row('cs1X', '1-X', p.ms1 + p.msX), row('cs12', '1-2', p.ms1 + p.ms2), row('csX2', 'X-2', p.msX + p.ms2)],
    },
    { title: 'Karşılıklı gol', items: [row('kgVar', 'KG Var', p.kgVar), row('kgYok', 'KG Yok', 1 - p.kgVar)] },
    {
      title: 'Toplam gol',
      items: [
        row('o15', '1.5 Üst', p.over15),
        row('u15', '1.5 Alt', 1 - p.over15),
        row('o25', '2.5 Üst', p.over25),
        row('u25', '2.5 Alt', 1 - p.over25),
        row('o35', '3.5 Üst', p.over35),
        row('u35', '3.5 Alt', 1 - p.over35),
      ],
    },
    {
      title: 'İlk yarı',
      items: [row('iy1', 'İY 1', p.iy1), row('iyX', 'İY X', p.iyX), row('iy2', 'İY 2', p.iy2), row('iyO05', 'İY 0.5 Üst', p.iyOver05)],
    },
  ];
  // Öne çıkanlar: olasılığı en az %60 olanlardan, birbirinin aynısı olmayan en güçlü 4 tercih
  const all = groups.flatMap((g) => g.items).filter((i) => i.pct >= 60 && i.pct <= 95);
  all.sort((a, b) => b.pct - a.pct);
  return {
    groups,
    highlights: all.slice(0, 4),
    topScores: topScores.map((s) => ({ score: s.score, pct: Math.round(s.p * 1000) / 10 })),
    predictedScore: predicted.score,
    expectedGoals: { home: r2(analysis.lambdaHome), away: r2(analysis.lambdaAway) },
    note: 'Olasılıklar istatistik modelinden hesaplanır; adil oran = 1 / olasılık. Gerçek sonucu veya kazancı garanti etmez.',
  };
}

// ---------------------------------------------------------------------------------------------------
// AI analizi (istatistik motoru)
// ---------------------------------------------------------------------------------------------------
const formWord = (pts, n) => {
  if (!n) return 'veri yok';
  const r = pts / (3 * n);
  return r >= 0.73 ? 'çok iyi' : r >= 0.53 ? 'iyi' : r >= 0.33 ? 'orta' : 'kötü';
};

/** Skor tablosu: model belirsizliği dahil, tahmin için kullanılan tek tablo. */
export function matrixOf(analysis) {
  return scoreMatrix(analysis.lambdaHome, analysis.lambdaAway, MODEL.dcRho, 10, analysis.sigma ?? 0);
}

/**
 * "En olası skor": tahmin edilen sonuçla (1/X/2) uyumlu en olası skor. Tablonun genel zirvesi çoğu zaman 1-1 olur;
 * model "ev sahibi kazanır" derken 1-1 göstermek tutarsızdır.
 */
export function predictedScore(analysis) {
  return scoresForOutcome(matrixOf(analysis), predictedOutcome(analysis))[0];
}

export function predictedOutcome(analysis) {
  const { homeWin, draw, awayWin } = analysis.probabilities;
  if (homeWin >= draw && homeWin >= awayWin) return '1';
  if (awayWin >= draw && awayWin >= homeWin) return '2';
  return 'X';
}

// ---------------------------------------------------------------------------------------------------
// Anlatım dili: aynı bilgi her maçta aynı kalıpla söylenmesin
// ---------------------------------------------------------------------------------------------------

/**
 * Kararlı cümle seçici: aynı tohum ve anahtar her zaman aynı seçeneği verir (aynı maçın analizi hep aynı okunur),
 * farklı maçlar farklı kalıplarla anlatılır. Şablonlarda `{ad}` yer tutucuları doldurulur.
 * Takım adlarına ek getirilmez: adlar özne olarak ya da ayrı yazılan sözcüklerle ("ile", "için") kullanılır.
 */
export function phraser(seed) {
  return (key, options, vars = {}) => {
    const i = seedToInt(`${seed}|${key}`) % options.length;
    return options[i].replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  };
}

/** Form dizisinden (eskiden yeniye "GGBMG") seri bilgisi. */
export function streakOf(form = '') {
  if (!form) return null;
  const last = form[form.length - 1];
  let run = 0;
  for (let i = form.length - 1; i >= 0 && form[i] === last; i--) run++;
  let unbeaten = 0;
  for (let i = form.length - 1; i >= 0 && form[i] !== 'M'; i--) unbeaten++;
  let winless = 0;
  for (let i = form.length - 1; i >= 0 && form[i] !== 'G'; i--) winless++;
  return { last, run, unbeaten, winless };
}

function streakNote(say, key, team, form) {
  const st = streakOf(form);
  if (!st) return '';
  const v = { T: team };
  if (st.last === 'G' && st.run >= 3) {
    return say(`${key}.win`, ['{T} üst üste {k} galibiyet aldı.', '{T} son {k} maçını da kazandı.', '{T} {k} maçlık galibiyet serisinde.'], { ...v, k: st.run });
  }
  if (st.unbeaten >= 4) return say(`${key}.unb`, ['{T} {k} maçtır yenilmiyor.', '{T} son {k} maçta mağlubiyet yüzü görmedi.'], { ...v, k: st.unbeaten });
  if (st.last === 'M' && st.run >= 2) return say(`${key}.loss`, ['{T} son {k} maçını kaybetti.', '{T} {k} maçlık mağlubiyet serisinde.'], { ...v, k: st.run });
  if (st.winless >= 4) return say(`${key}.nowin`, ['{T} {k} maçtır galibiyet yüzü göremiyor.', '{T} son {k} maçta kazanamadı.'], { ...v, k: st.winless });
  return '';
}

/** Öne çıkan öngörülerin düz Türkçe karşılığı (sunucudaki sınıflandırma anahtarından). */
function pickPhrase(key, H, A) {
  const map = {
    ms1: `${H} galibiyeti`,
    msX: 'beraberlik',
    ms2: `${A} galibiyeti`,
    cs1X: `${H} kazanır ya da berabere kalır`,
    cs12: 'maçın berabere bitmemesi',
    csX2: `${A} kazanır ya da berabere kalır`,
    kgVar: 'iki takımın da gol bulması',
    kgYok: 'en az bir takımın gol bulamaması',
    o15: 'en az iki gol atılması',
    u15: 'en fazla bir gol atılması',
    o25: 'en az üç gol atılması',
    u25: 'en fazla iki gol atılması',
    o35: 'en az dört gol atılması',
    u35: 'en fazla üç gol atılması',
    iy1: `ilk yarıda ${H} üstünlüğü`,
    iyX: 'ilk yarıda beraberlik',
    iy2: `ilk yarıda ${A} üstünlüğü`,
    iyO05: 'ilk yarıda en az bir gol',
  };
  return map[key] ?? null;
}

const fin = (x) => (Number.isFinite(x) ? x : null);

/**
 * Analizden saklanan, tahminin dayandığı sayılar (Özel Yorum ve Asistan aynı rakamları kullansın diye içeriğe yazılır).
 * Sayısal olmayan değerler null olur (Firestore ve JSON için güvenli).
 */
export function modelOf(analysis) {
  const ph = analysis.home.profile;
  const pa = analysis.away.profile;
  const h2h = analysis.h2h ?? {};
  return {
    lambdaHome: analysis.lambdaHome,
    lambdaAway: analysis.lambdaAway,
    sigma: analysis.sigma ?? 0,
    homeRank: fin(ph.rank),
    awayRank: fin(pa.rank),
    homePlayed: fin(ph.played),
    awayPlayed: fin(pa.played),
    homePpg: fin(ph.ppg),
    awayPpg: fin(pa.ppg),
    teamCount: fin(analysis.dataQuality.tableTeams),
    confidence: analysis.dataQuality.confidence,
    homeGf: fin(ph.goalsForPerGame),
    homeGa: fin(ph.goalsAgainstPerGame),
    awayGf: fin(pa.goalsForPerGame),
    awayGa: fin(pa.goalsAgainstPerGame),
    homeForm: ph.form.string ?? '',
    awayForm: pa.form.string ?? '',
    homeFormPoints: fin(ph.form.points),
    awayFormPoints: fin(pa.form.points),
    homeFormMatches: fin(ph.form.matches),
    awayFormMatches: fin(pa.form.matches),
    h2h: { n: fin(h2h.n) ?? 0, homeWins: fin(h2h.homeWins) ?? 0, draws: fin(h2h.draws) ?? 0, awayWins: fin(h2h.awayWins) ?? 0 },
  };
}

export function buildAi(analysis, { editorComment = null, seed = null } = {}) {
  const H = analysis.home.name;
  const A = analysis.away.name;
  const pH = analysis.home.profile;
  const pA = analysis.away.profile;
  const pr = analysis.probabilities;
  const { p } = markets(analysis.lambdaHome, analysis.lambdaAway, analysis.sigma);
  const say = phraser(seed ?? `${analysis.home.id}|${analysis.away.id}`);
  const sections = [];
  const hp = pct(pr.homeWin);
  const dp = pct(pr.draw);
  const ap = pct(pr.awayWin);

  // Genel bakış
  const gap = pr.homeWin - pr.awayWin;
  let overview;
  if (Math.abs(gap) < 0.08) {
    overview = say(
      'ov.even',
      [
        'Kâğıt üzerinde iki takım birbirine çok yakın: {H} %{h}, beraberlik %{d}, {A} %{a}. Beraberlik ciddi bir ihtimal.',
        'Bu maçta net bir favori yok. {H} %{h}, beraberlik %{d}, {A} %{a}; küçük detaylar sonucu belirleyebilir.',
        'Güçler dengede: {H} için %{h}, {A} için %{a}, beraberlik için %{d} ihtimal görünüyor. Sürprize açık bir karşılaşma.',
      ],
      { H, A, h: hp, d: dp, a: ap },
    );
  } else {
    const fav = gap > 0 ? H : A;
    const other = gap > 0 ? A : H;
    const fp = gap > 0 ? hp : ap;
    const op = gap > 0 ? ap : hp;
    overview =
      Math.abs(gap) > 0.25
        ? say(
            'ov.big',
            [
              '{F} bu maça açık favori olarak giriyor: kazanma ihtimali %{f}, beraberlik %{d}, {O} %{o}.',
              'Tablo {F} lehine net: %{f} kazanma ihtimali var; beraberlik %{d}, {O} %{o}.',
              'Model {F} tarafında: galibiyet ihtimali %{f}. {O} için %{o}, beraberlik için %{d}.',
            ],
            { F: fav, O: other, f: fp, o: op, d: dp },
          )
        : say(
            'ov.small',
            [
              '{F} hafif favori: kazanma ihtimali %{f}, beraberlik %{d}, {O} %{o}.',
              'İbre {F} tarafına hafifçe kayıyor (%{f}); ama {O} (%{o}) de sürpriz yapabilir, beraberlik %{d}.',
              '{F} bir adım önde başlıyor: %{f}. Beraberlik %{d}, {O} ise %{o}.',
            ],
            { F: fav, O: other, f: fp, o: op, d: dp },
          );
  }
  sections.push({ title: 'Genel bakış', text: overview });

  // Form
  const formPart = (T, prof, key) => {
    if (!prof.form.matches) return say(`${key}.none`, ['{T} için yeterli maç verisi yok.', '{T} tarafında form okumak için yeterli veri yok.'], { T });
    const intro = say(
      `${key}.intro`,
      [
        '{T} son {n} maçta {pts} puan topladı ({str}; {w} formda).',
        '{T} son {n} maçı {pts} puanla kapattı ({str}; {w} formda).',
        '{T} için son {n} maçın hesabı {pts} puan ({str}; {w} formda).',
      ],
      { T, n: prof.form.matches, pts: prof.form.points, str: prof.form.string || '-', w: formWord(prof.form.points, prof.form.matches) },
    );
    return `${intro} ${streakNote(say, key, T, prof.form.string)}`.trim();
  };
  const fi = (x) => (Number.isFinite(x) ? x : null);
  let formCmp = '';
  if (fi(pH.form.index) !== null && fi(pA.form.index) !== null && pH.form.matches >= 3 && pA.form.matches >= 3) {
    const d = pH.form.index - pA.form.index;
    if (Math.abs(d) >= 0.25) {
      formCmp = say('form.cmp', ['Formda {T} bir adım önde.', 'Son haftaların tablosu {T} lehine.', 'Form grafiği {T} tarafında.'], { T: d > 0 ? H : A });
    } else {
      formCmp = say('form.even', ['Formlar birbirine yakın.', 'İki takımın son haftalardaki performansı benzer.']);
    }
  }
  sections.push({ title: 'Form durumu', text: [formPart(H, pH, 'fh'), formPart(A, pA, 'fa'), formCmp].filter(Boolean).join(' ') });

  // Gol profili
  const lH = analysis.lambdaHome;
  const lA = analysis.lambdaAway;
  const total = lH + lA;
  const goalTone =
    total >= 3
      ? say('gp.high', ['Bol gollü bir karşılaşma bekleniyor.', 'Kaleler rahat etmeyebilir; gol yağabilir.'])
      : total <= 2.1
        ? say('gp.low', ['Savunmaların öne çıkacağı, gollerin zor geleceği bir maç olabilir.', 'Kapalı geçmesi muhtemel bir maç; tek gol belirleyici olabilir.'])
        : say('gp.mid', ['Gol sayısı açısından orta tempolu bir maç görünüyor.', 'Ne çok gollü ne de çok kapalı; dengeli tempolu bir maç bekleniyor.']);
  sections.push({
    title: 'Gol profili',
    text:
      say(
        'gp.rates',
        [
          '{H} maç başına {a} gol atıp {b} gol yiyor; {A} {c} atıp {d} yiyor.',
          'Hücum ve savunma karnesi: {H} maçta {a} gol atıyor, {b} gol yiyor; {A} ise {c} atıp {d} yiyor.',
        ],
        { H, A, a: r2(pH.goalsForPerGame), b: r2(pH.goalsAgainstPerGame), c: r2(pA.goalsForPerGame), d: r2(pA.goalsAgainstPerGame) },
      ) +
      ` Model bu maç için ${H} ${r2(lH)} – ${r2(lA)} ${A} gol bekliyor. ${goalTone} ` +
      `En az üç gol atılma ihtimali %${pct(p.over25)}; iki takımın da gol bulma ihtimali %${pct(p.kgVar)}.`,
  });

  // Lig durumu
  if (pH.rank && pA.rank) {
    const ppg = (x) => (Number.isFinite(x) && x > 0 ? ` (maç başı ${r2(x)} puan)` : '');
    const rd = Math.abs(pH.rank - pA.rank);
    const cmp =
      rd >= 8
        ? say('ld.far', ['Aralarında {d} basamak var; ama sıralama tek başına sonucu belirlemez.', 'Tabloda {d} basamak fark var, yine de bu fark sahaya her zaman yansımaz.'], { d: rd })
        : rd <= 2
          ? say('ld.near', ['İki takım tabloda yan yana; bu maç sıralamayı doğrudan etkileyebilir.', 'Tabloda komşular, kazanan taraf sıralamada fark atabilir.'])
          : '';
    sections.push({
      title: 'Lig durumu',
      text: `${H} ligde ${pH.rank}. sırada${ppg(pH.ppg)}, ${A} ${pA.rank}. sırada${ppg(pA.ppg)}. ${cmp}`.trim(),
    });
  }

  // Aralarındaki maçlar
  const h = analysis.h2h;
  let h2hText;
  if (h.n > 0) {
    const avgTotal = (h.homeGoalsAvg ?? 0) + (h.awayGoalsAvg ?? 0);
    const tone =
      h.homeWins >= h.awayWins + 2
        ? say('h2h.h', ['Geçmişte üstünlük {T} tarafında.', 'Bu eşleşmede {T} daha çok gülmüş.'], { T: H })
        : h.awayWins >= h.homeWins + 2
          ? say('h2h.a', ['Geçmişte üstünlük {T} tarafında.', 'Bu eşleşmede {T} daha çok gülmüş.'], { T: A })
          : say('h2h.even', ['Rekabet dengeli.', 'Geçmişte kimse net bir üstünlük kuramamış.']);
    const flow = avgTotal >= 3 ? ' Maçlar genelde gollü geçiyor.' : avgTotal <= 2 ? ' Maçlar genelde az gollü geçiyor.' : '';
    h2hText =
      `Son ${h.n} karşılaşmada ${H} ${h.homeWins} galibiyet, ${h.draws} beraberlik, ${h.awayWins} mağlubiyet aldı; ` +
      `ortalama skor ${r2(h.homeGoalsAvg)}-${r2(h.awayGoalsAvg)}. ${tone}${flow}`;
  } else {
    h2hText = say('h2h.none', [
      'İki takımın yakın geçmişte karşılaşması bulunamadı; tahmin form ve lig verisine dayanıyor.',
      'Aralarında yakın tarihli bir maç yok, bu yüzden tahmin form ve lig verilerinden besleniyor.',
    ]);
  }
  sections.push({ title: 'Aralarındaki maçlar', text: h2hText });

  // Maçın anahtarı
  const factors = [];
  for (const [T, O, mine, theirs, k] of [
    [H, A, pH, pA, 'h'],
    [A, H, pA, pH, 'a'],
  ]) {
    if (fi(mine.attack) !== null && fi(theirs.defense) !== null && mine.attack >= 1.2 && theirs.defense >= 1.1) {
      factors.push({
        w: mine.attack - 1 + (theirs.defense - 1),
        text: say(`kf.atk.${k}`, ['{T} hücumu, {O} savunmasının açık verdiği noktalara denk geliyor.', '{T} hücum gücü, {O} savunmasının zayıf karnını yoklayabilir.'], { T, O }),
      });
    }
    if (fi(mine.defense) !== null && mine.defense <= 0.8) {
      factors.push({
        w: 1 - mine.defense,
        text: say(`kf.def.${k}`, ['{T} savunması sağlam; kolay gol yemiyor.', '{T} defansı lig ortalamasının belirgin biçimde iyisinde.'], { T }),
      });
    }
    const gapForm = (mine.form.index ?? NaN) - (theirs.form.index ?? NaN);
    if (mine.form.matches >= 3 && theirs.form.matches >= 3 && gapForm >= 0.3) {
      factors.push({
        w: gapForm,
        text: say(`kf.form.${k}`, ['{T} formda bir adım önde; son maçlardaki özgüven sahaya yansıyabilir.', '{T} son haftalarda daha formda, bu özgüven fark yaratabilir.'], { T }),
      });
    }
  }
  const under = Math.min(pr.homeWin, pr.awayWin);
  if (Math.abs(gap) > 0.2 && under >= 0.2) {
    factors.push({
      w: 0.3,
      text: say('kf.upset', ['Sürpriz payı küçümsenmemeli: {T} için kazanma ihtimali %{p}.', '{T} için %{p} gibi bir ihtimal var, sürpriz kapıda olabilir.'], {
        T: gap > 0 ? A : H,
        p: pct(under),
      }),
    });
  }
  if (pr.draw >= 0.3) {
    factors.push({ w: pr.draw, text: say('kf.draw', ['Beraberlik ihtimali yüksek; iki takım da risk almak yerine puanı seçebilir.', 'Beraberlik güçlü bir senaryo; temkinli bir maç olabilir.']) });
  }
  factors.sort((x, y) => y.w - x.w);
  const firstHome = Math.round((lH / (lH + lA)) * 100);
  const firstTeam = firstHome >= 50 ? H : A;
  const firstPct = firstHome >= 50 ? firstHome : 100 - firstHome;
  const firstGoal = say(
    'kf.first',
    [
      'İlk golün {T} tarafından gelme ihtimali yaklaşık %{p}; erken gol maçın planını baştan değiştirebilir.',
      'Gol gelirse ilk golü {T} atar diyorum (%{p}); skoru ilk açan taraf maçı rahatlatabilir.',
    ],
    { T: firstTeam, p: firstPct },
  );
  const keyTexts = factors.slice(0, 2).map((f) => f.text);
  if (!keyTexts.length) keyTexts.push(say('kf.none', ['Maçı küçük detaylar belirleyebilir: duran toplar ve ilk gol kritik olacak.', 'Net bir fark görünmüyor; kilit detaylar duran toplarda ve ilk golde saklı.']));
  sections.push({ title: 'Maçın anahtarı', text: `${keyTexts.join(' ')} ${firstGoal}` });

  // Öne çıkan tercih
  const odds = buildOdds(analysis);
  const best = odds.highlights[0];
  const phrase = best ? pickPhrase(best.key, H, A) : null;
  sections.push({
    title: 'Öne çıkan tercih',
    text:
      best && phrase
        ? say(
            'pick.best',
            [
              'Modelin en güvendiği öngörü: {x} (%{p}). Tahmin edilen skor {s}.',
              'Rakamların en net söylediği şey: {x} (%{p}). Tahmin edilen skor {s}.',
            ],
            { x: phrase, p: best.pct, s: odds.predictedScore },
          )
        : say('pick.none', ['Belirgin bir öngörü yok; tahmin edilen skor {s}.', 'Net bir öne çıkan nokta yok, yine de tahmin edilen skor {s}.'], { s: odds.predictedScore }),
  });

  const conf = analysis.dataQuality.confidence;
  const confNote =
    conf === 'yüksek'
      ? 'Örneklem geniş, tahmine rahatça güvenilebilir.'
      : conf === 'orta'
        ? 'Örneklem orta düzeyde, küçük sapmalar olabilir.'
        : 'Örneklem sınırlı, tahmini temkinle okumak gerekir.';
  sections.push({
    title: 'Veri güveni',
    text:
      `Analiz ${analysis.dataQuality.homeMatches} + ${analysis.dataQuality.awayMatches} geçmiş maça ve ${analysis.dataQuality.h2hMatches} ikili karşılaşmaya dayanıyor. ` +
      `Güven: ${conf}. ${confNote}`,
  });

  return {
    pick: predictedOutcome(analysis),
    probabilities: { home: pct(pr.homeWin), draw: pct(pr.draw), away: pct(pr.awayWin) },
    topScore: odds.predictedScore,
    confidence: conf,
    sections,
    editorComment,
  };
}

// ---------------------------------------------------------------------------------------------------
// Simülasyon paketi
// ---------------------------------------------------------------------------------------------------
export const SIM_FPS = 10;

// Konumlar 0..65535 aralığına sıkıştırılır: x,y ∈ [-0.1, 1.1], yön açısı ∈ [-π, π], top yüksekliği ∈ [0, 1].
const qPos = (v) => Math.max(0, Math.min(65535, Math.round(((v + 0.1) / 1.2) * 65535)));
const qAng = (a) => Math.max(0, Math.min(65535, Math.round(((a + Math.PI) / (2 * Math.PI)) * 65535)));
const qZ = (z) => Math.max(0, Math.min(65535, Math.round(Math.min(1, Math.max(0, z || 0)) * 65535)));

/** Bir karedeki değer sırası: top x,y,z · 11 ev sahibi (x,y,yön) · 11 deplasman (x,y,yön) · hakem x,y  = 71 değer */
export const VALUES_PER_FRAME = 3 + 11 * 3 * 2 + 2;

/**
 * Simülasyonun varacağı skor. AI'nın tahmin ettiği sonucla (1/X/2) uyumlu, makul skorlar arasından, olasılığa göre
 * (en olası skorlara öncelik verilerek) seçilir; böylece ekranda izlenen maç, AI'nın anlattığı hikâyeyle çelişmez
 * ve 6-0 gibi aşırı uçlar çıkmaz. Aynı tohum her zaman aynı skoru verir.
 */
export function pickSimTarget(analysis, seed) {
  const cands = scoresForOutcome(matrixOf(analysis), predictedOutcome(analysis));
  const best = cands[0].p;
  const plausible = cands.filter((c) => c.p >= best * 0.25);
  const weights = plausible.map((c) => c.p ** 1.6);
  const rng = createRng(`${seed}|hedef`);
  return rng.pickWeighted(plausible, weights);
}

export function buildSim(analysis, { seed, durationSeconds = 60 } = {}) {
  const target = pickSimTarget(analysis, seed);
  const timeline = simulateToScore(analysis, { seed, target: { home: target.home, away: target.away } });
  const choreo = buildChoreography(timeline, { durationSeconds });
  const form = (l) => (l >= 1.6 ? '4-3-3' : '4-4-2');
  const players = buildPlayers(choreo, { homeFormation: form(analysis.lambdaHome), awayFormation: form(analysis.lambdaAway) });

  const frames = Math.round(durationSeconds * SIM_FPS) + 1;
  const buf = Buffer.alloc(frames * VALUES_PER_FRAME * 2);
  let o = 0;
  const put = (v) => {
    buf.writeUInt16LE(v, o);
    o += 2;
  };
  for (let f = 0; f < frames; f++) {
    const a = players.at(f / SIM_FPS);
    put(qPos(a.ball.x));
    put(qPos(a.ball.y));
    put(qZ(a.ball.z));
    for (const side of ['home', 'away']) {
      for (const pl of a[side]) {
        put(qPos(pl.x));
        put(qPos(pl.y));
        put(qAng(pl.face ?? 0));
      }
    }
    put(qPos(a.ref.x));
    put(qPos(a.ref.y));
  }

  const showInTicker = (f) => !f.skipped || /card|penalty|var|goal/.test(f.type);
  // Saat etiketleri: 0,5 sn'de bir (ekrandaki "34'" yazısı)
  const labels = [];
  for (let t = 0; t <= durationSeconds + 1e-9; t += 0.5) {
    const l = choreo.labelAt(t);
    if (!labels.length || labels[labels.length - 1].label !== l) labels.push({ t: r2(t), label: l });
  }
  const stats = [];
  for (let s = 0; s <= durationSeconds; s++) {
    const st = choreo.statsAt(s);
    if (st) stats.push({ t: s, possession: st.possession.home, home: st.home, away: st.away });
  }

  return {
    version: CONTENT_VERSION,
    fps: SIM_FPS,
    duration: durationSeconds,
    frames,
    valuesPerFrame: VALUES_PER_FRAME,
    positions: buf.toString('base64'),
    formations: { home: players.formations.home, away: players.formations.away },
    roles: {
      home: players.slots.home.map((s) => ({ role: s.role, num: s.num })),
      away: players.slots.away.map((s) => ({ role: s.role, num: s.num })),
    },
    scores: choreo.scoreChanges.map((c) => ({ t: r2(c.t), home: c.score.home, away: c.score.away })),
    labels,
    banners: choreo.fx
      .filter((f) => ['goal', 'var', 'penalty', 'halftime', 'fulltime', 'kickoff', 'red_card', 'yellow_card'].includes(f.type))
      .map((f) => ({ type: f.type, t: r2(f.t), dur: r2(f.dur), side: f.side ?? null, score: f.score ?? null })),
    feed: choreo.feed
      .filter(showInTicker)
      .map((f) => ({ t: r2(f.t), type: f.type, side: f.side ?? null, label: f.label ?? '', text: f.text ?? '' })),
    stats,
    finalScore: { ...timeline.score },
    halftimeScore: { ...timeline.halftimeScore },
  };
}

// ---------------------------------------------------------------------------------------------------
// Sonuç karşılaştırması (maç bittikten sonra, ücretsiz)
// ---------------------------------------------------------------------------------------------------
const outcomeOf = (h, a) => (h > a ? '1' : h < a ? '2' : 'X');

export function buildReview({ ai, sim, actual }) {
  const actualOutcome = outcomeOf(actual.home, actual.away);
  const actualScore = `${actual.home}-${actual.away}`;
  const simScore = `${sim.finalScore.home}-${sim.finalScore.away}`;
  return {
    actual: { score: actualScore, outcome: actualOutcome },
    ai: {
      pick: ai.pick,
      topScore: ai.topScore,
      outcomeHit: ai.pick === actualOutcome,
      scoreHit: ai.topScore === actualScore,
    },
    sim: {
      score: simScore,
      outcome: outcomeOf(sim.finalScore.home, sim.finalScore.away),
      outcomeHit: outcomeOf(sim.finalScore.home, sim.finalScore.away) === actualOutcome,
      scoreHit: simScore === actualScore,
    },
  };
}
