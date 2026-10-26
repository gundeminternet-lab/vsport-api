// Özel Yorum: kullanıcının jetonla istediği, AI Yorumcu analizinden farklı ve daha ayrıntılı maç başlıkları.
//
//   corners : korner beklentisi (takım başı, toplam, alt/üst çizgileri, ilk korner)
//   htscore : ilk yarı skor beklentisi
//   htft    : İY/MS dokuzlusu ve sürpriz senaryolar (1/2, 2/1 ...)
//   btts    : KG var senaryoları (ilk yarı, ikinci yarı, iki yarıda da)
//
// Tüm hesaplar saf fonksiyondur (ağ yok): gol beklentileri (λ, belirsizlik) ve isteğe bağlı korner örneklerinden üretilir.
// Her başlık aynı biçimde döner; ekran tek bir kartla hepsini çizer:
//   { topic, title, headline, big, facts:[{label,value}], groups:[{title, rows:[{label,pct,note?}]}], summary:[...],
//     speech, mood, note }
//
// Dil: takım adlarına ek getirilmez (özne ya da "ile/için" ile kullanılır); yüzdeler ekranda "%62", seste "yüzde 62".

import { baseMatrix, mixtureNodes } from './engine/analysis.js';
import { MODEL } from './engine/config.js';
import { cornerDistribution, expectedCorners } from './engine/corners.js';
import { markets, phraser } from './content.js';

export const SPECIAL_TOPICS = ['corners', 'htscore', 'htft', 'btts'];
export const SPECIAL_LABELS = {
  corners: 'Korner beklentisi',
  htscore: 'İlk yarı skoru',
  htft: 'İY/MS sürprizleri',
  btts: 'KG var senaryoları',
};
// Özel Yorumlar ayrıca satılmaz: abonelikte ve AI paketinin içindedir (jeton fiyatı kaldırıldı).
export const SPECIAL_VERSION = 1;

/** İlk yarıda atılan gol payı (content.js markets ile aynı). */
const HT_SHARE = 0.45;

const pct = (p) => Math.round(p * 100);
const tr1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
const lineText = (line) => String(line).replace('.', ',');
const outIdx = (i, j) => (i > j ? 0 : i === j ? 1 : 2);
const SYM = ['1', 'X', '2'];

/**
 * İki yarının birleşik dağılımı. Her yarı kendi gol beklentisiyle (ilk yarı %45, ikinci yarı %55) modellenir; güç farkı
 * belirsizliği iki yarıda aynı senaryoyla işler (yarılar bağımsız değil, aynı maçın parçası). İY/MS tablosu, ana
 * modelin İY ve MS sonuç olasılıklarına oranlanarak (IPF) tutarlı hale getirilir.
 */
export function halfModel({ lambdaHome, lambdaAway, sigma = 0 }) {
  const { p } = markets(lambdaHome, lambdaAway, sigma);
  const maxG = 7;
  const J = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let bttsHt = 0;
  let bttsSh = 0;
  let bttsBoth = 0;
  for (const node of mixtureNodes(lambdaHome, lambdaAway, sigma)) {
    const h1 = baseMatrix(node.lh * HT_SHARE, node.la * HT_SHARE, MODEL.dcRho, maxG);
    const h2 = baseMatrix(node.lh * (1 - HT_SHARE), node.la * (1 - HT_SHARE), MODEL.dcRho, maxG);
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i <= maxG; i++) {
      for (let j = 0; j <= maxG; j++) {
        const pa = h1[i][j];
        if (i > 0 && j > 0) b1 += pa;
        if (pa < 1e-9) continue;
        for (let k = 0; k <= maxG; k++) {
          for (let l = 0; l <= maxG; l++) {
            J[outIdx(i, j)][outIdx(i + k, j + l)] += node.w * pa * h2[k][l];
          }
        }
      }
    }
    for (let k = 0; k <= maxG; k++) for (let l = 0; l <= maxG; l++) if (k > 0 && l > 0) b2 += h2[k][l];
    bttsHt += node.w * b1;
    bttsSh += node.w * b2;
    bttsBoth += node.w * b1 * b2;
  }
  const total = J.flat().reduce((a, b) => a + b, 0);
  for (const row of J) for (let c = 0; c < 3; c++) row[c] /= total;

  // IPF: satır toplamları İY sonucuna, sütun toplamları MS sonucuna eşitlenir.
  const rowT = [p.iy1, p.iyX, p.iy2];
  const colT = [p.ms1, p.msX, p.ms2];
  for (let it = 0; it < 80; it++) {
    for (let r = 0; r < 3; r++) {
      const s = J[r][0] + J[r][1] + J[r][2];
      if (s > 0) for (let c = 0; c < 3; c++) J[r][c] *= rowT[r] / s;
    }
    for (let c = 0; c < 3; c++) {
      const s = J[0][c] + J[1][c] + J[2][c];
      if (s > 0) for (let r = 0; r < 3; r++) J[r][c] *= colT[c] / s;
    }
  }
  const grid = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) grid.push({ ht: SYM[r], ft: SYM[c], key: `${SYM[r]}/${SYM[c]}`, p: J[r][c] });

  const bttsFt = p.kgVar;
  // Birleşik olaylar bileşenlerinden büyük olamaz.
  const both = Math.min(bttsBoth, bttsHt, bttsSh, bttsFt);
  return { grid, bttsHt, bttsSh, bttsBoth: both, bttsFt, markets: p };
}

// ---------------------------------------------------------------------------------------------------
// İY/MS cümleleri
// ---------------------------------------------------------------------------------------------------
function htftPhrase(key, H, A) {
  switch (key) {
    case '1/1':
      return `${H} hem ilk yarıyı hem maçı kazanır`;
    case '2/2':
      return `${A} hem ilk yarıyı hem maçı kazanır`;
    case 'X/1':
      return `ilk yarı berabere biter, maçı ${H} kazanır`;
    case 'X/2':
      return `ilk yarı berabere biter, maçı ${A} kazanır`;
    case 'X/X':
      return 'hem ilk yarı hem maç berabere biter';
    case '1/X':
      return `${H} ilk yarıyı önde kapatır ama maç berabere biter`;
    case '2/X':
      return `${A} ilk yarıyı önde kapatır ama maç berabere biter`;
    case '1/2':
      return `${H} ilk yarıyı önde kapatır, maçı ${A} kazanır`;
    default:
      return `${A} ilk yarıyı önde kapatır, maçı ${H} kazanır`;
  }
}

const htftLabel = (key) => `İY ${key.split('/')[0]} / MS ${key.split('/')[1]}`;

// ---------------------------------------------------------------------------------------------------
// Başlık üreticileri
// ---------------------------------------------------------------------------------------------------
function cornersTopic({ H, A, say, corners, lambdaHome, lambdaAway }) {
  const exp = corners ?? expectedCorners({ lambdaHome, lambdaAway });
  const dist = cornerDistribution(exp.home, exp.away);
  const total = exp.home + exp.away;

  // Öne çıkan çizgi: en dengeli (%50'ye yakın) değil, modelin daha net konuştuğu çizgi (≈%65).
  let pick = null;
  for (const l of dist.lines) {
    for (const [side, p] of [['üst', l.over], ['alt', l.under]]) {
      if (p >= 0.52 && (!pick || Math.abs(p - 0.66) < Math.abs(pick.p - 0.66))) pick = { line: l.line, side, p };
    }
  }
  const pickTxt = pick ? `${lineText(pick.line)} korner ${pick.side}` : null;

  const more = dist.homeMore >= dist.awayMore ? { T: H, p: dist.homeMore } : { T: A, p: dist.awayMore };
  const close = Math.abs(dist.homeMore - dist.awayMore) < 0.1;
  const first = exp.home / total;
  const firstTeam = first >= 0.5 ? H : A;
  const firstPct = Math.max(first, 1 - first);

  const summary = [
    say('co.exp', [
      `Model ${H} için ${tr1(exp.home)}, ${A} için ${tr1(exp.away)} korner öngörüyor; toplam yaklaşık ${tr1(total)}.`,
      `${H} maç başına ${tr1(exp.home)}, ${A} ${tr1(exp.away)} korner kullanabilir; ikisi birlikte ${tr1(total)} eder.`,
      `Beklenen korner dağılımı: ${H} ${tr1(exp.home)}, ${A} ${tr1(exp.away)}; maç toplamı ${tr1(total)} civarı.`,
    ]),
    `En olası toplam aralığı ${dist.range.from}-${dist.range.to} korner (%${pct(dist.range.p)}).`,
    close
      ? say('co.close', ['Korner sayısında iki takım başa baş gidiyor.', 'Hangi takımın daha çok korner kullanacağı belirsiz; denge var.'])
      : say('co.more', [`${more.T} daha fazla korner kullanır (%${pct(more.p)}).`, `Korner üstünlüğü ${more.T} tarafında görünüyor (%${pct(more.p)}).`]),
    say('co.first', [`İlk korneri ${firstTeam} kazanır (%${pct(firstPct)}).`, `İlk kornerin ${firstTeam} tarafından gelme ihtimali %${pct(firstPct)}.`]),
  ];
  if (pick) {
    summary.push(
      say('co.pick', [
        `Modelin en net okuması: ${pickTxt} (%${pct(pick.p)}).`,
        `Çizgiler arasında en güvenli görünen: ${pickTxt} (%${pct(pick.p)}).`,
      ]),
    );
  }

  const note =
    exp.source === 'data'
      ? `Hesap, iki takımın son ${Math.min(exp.nHome, exp.nAway)}-${Math.max(exp.nHome, exp.nAway)} maçındaki korner verisine dayanıyor.`
      : 'Takımların korner geçmişi bulunamadığı için beklenti gol modelinden türetildi; güven daha düşük.';

  const speech = [
    say('co.s.exp', [
      `Korner tarafında ${H} için ${tr1(exp.home)}, ${A} için ${tr1(exp.away)} korner bekliyorum. Toplam ${tr1(total)} civarı.`,
      `${H} yaklaşık ${tr1(exp.home)}, ${A} yaklaşık ${tr1(exp.away)} korner kullanır. Maç toplamı ${tr1(total)} dolayında.`,
    ]),
    `En olası aralık ${dist.range.from} ile ${dist.range.to} korner arası, ihtimali yüzde ${pct(dist.range.p)}.`,
    close ? 'Hangi takımın önde olacağı belirsiz; korner sayısında denge var.' : `${more.T} daha çok korner kullanır, ihtimali yüzde ${pct(more.p)}.`,
    pick ? `En net okuma ${pickTxt}, yüzde ${pct(pick.p)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    topic: 'corners',
    title: SPECIAL_LABELS.corners,
    headline: close
      ? say('co.head.close', [`Toplam ${tr1(total)} korner, iki takım başa baş`, `Korner dengesi: toplam ${tr1(total)}`])
      : say('co.head', [
          `Toplam ${tr1(total)} korner bekleniyor`,
          `Korner sayısı ${dist.range.from}-${dist.range.to} aralığında yoğunlaşıyor`,
          `${more.T} korner üstünlüğünde, toplam ${tr1(total)}`,
        ]),
    big: `${dist.range.from}-${dist.range.to}`,
    bigCaption: 'en olası toplam korner',
    facts: [
      { label: H, value: tr1(exp.home) },
      { label: A, value: tr1(exp.away) },
      { label: 'Toplam', value: tr1(total) },
    ],
    groups: [
      {
        title: 'Toplam korner çizgileri',
        rows: dist.lines.map((l) => ({ label: `${lineText(l.line)} üst`, pct: pct(l.over), note: `alt %${pct(l.under)}` })),
      },
      {
        title: 'Hangi takım daha çok korner kullanır?',
        rows: [
          { label: H, pct: pct(dist.homeMore) },
          { label: 'Eşit', pct: pct(dist.equal) },
          { label: A, pct: pct(dist.awayMore) },
        ],
      },
    ],
    summary,
    speech,
    mood: 'warm',
    note,
    meta: { source: exp.source, home: Math.round(exp.home * 100) / 100, away: Math.round(exp.away * 100) / 100, pick: pick ? { line: pick.line, side: pick.side, pct: pct(pick.p) } : null },
  };
}

function htscoreTopic({ H, A, say, lambdaHome, lambdaAway, sigma }) {
  const lh1 = lambdaHome * HT_SHARE;
  const la1 = lambdaAway * HT_SHARE;
  // İlk yarı skor tablosu: content.js markets ile aynı model (aynı belirsizlik karışımı)
  const nodes = mixtureNodes(lh1, la1, sigma);
  const maxG = 6;
  const m = Array.from({ length: maxG + 1 }, () => new Array(maxG + 1).fill(0));
  for (const n of nodes) {
    const b = baseMatrix(n.lh, n.la, MODEL.dcRho, maxG);
    for (let i = 0; i <= maxG; i++) for (let j = 0; j <= maxG; j++) m[i][j] += n.w * b[i][j];
  }
  const scores = [];
  let win = 0;
  let draw = 0;
  let lose = 0;
  let over05 = 0;
  let over15 = 0;
  for (let i = 0; i <= maxG; i++) {
    for (let j = 0; j <= maxG; j++) {
      scores.push({ score: `${i}-${j}`, p: m[i][j] });
      if (i > j) win += m[i][j];
      else if (i === j) draw += m[i][j];
      else lose += m[i][j];
      if (i + j >= 1) over05 += m[i][j];
      if (i + j >= 2) over15 += m[i][j];
    }
  }
  scores.sort((a, b) => b.p - a.p);
  const top = scores.slice(0, 5);
  const best = top[0];
  const tot = lh1 + la1;

  const lead = win >= lose ? { T: H, p: win } : { T: A, p: lose };
  const summary = [
    say('hs.exp', [
      `İlk yarıda ${H} için ${tr1(lh1)}, ${A} için ${tr1(la1)} gol bekleniyor.`,
      `Model ilk 45 dakikaya ${H} ${tr1(lh1)}, ${A} ${tr1(la1)} gol yazıyor.`,
    ]),
    say('hs.top', [
      `En olası ilk yarı skoru ${best.score} (%${pct(best.p)}); ardından ${top[1].score} (%${pct(top[1].p)}) ve ${top[2].score} (%${pct(top[2].p)}) geliyor.`,
      `İlk yarı için ilk sırada ${best.score} var (%${pct(best.p)}), sonra ${top[1].score} (%${pct(top[1].p)}) ve ${top[2].score} (%${pct(top[2].p)}).`,
    ]),
    `İlk yarıda en az bir gol ihtimali %${pct(over05)}, en az iki gol ihtimali %${pct(over15)}.`,
    draw >= Math.max(win, lose)
      ? say('hs.draw', ['Devreye beraberlikle girmek en güçlü senaryo.', 'İlk yarı büyük ihtimalle eşitlikle kapanır.'])
      : say('hs.lead', [`Devreyi ${lead.T} önde kapatma ihtimali %${pct(lead.p)}.`, `İlk yarı sonunda ${lead.T} üstünlüğü %${pct(lead.p)} ihtimalle görünüyor.`]),
  ];

  const speech = [
    say('hs.s.top', [
      `İlk yarının en olası skoru ${spokenScore(best.score)}, ihtimali yüzde ${pct(best.p)}.`,
      `İlk yarıda en çok ${spokenScore(best.score)} bekliyorum, ihtimali yüzde ${pct(best.p)}.`,
    ]),
    `İlk yarıda en az bir gol ihtimali yüzde ${pct(over05)}.`,
    draw >= Math.max(win, lose) ? 'Devreye büyük ihtimalle eşit gidilir.' : `Devreyi ${lead.T} önde kapatma ihtimali yüzde ${pct(lead.p)}.`,
  ].join(' ');

  return {
    topic: 'htscore',
    title: SPECIAL_LABELS.htscore,
    headline: say('hs.head', [`İlk yarı için en olası skor ${best.score}`, `Devre arası skoru ${best.score} olabilir`, `İlk 45 dakika: ${best.score} öne çıkıyor`]),
    big: best.score.replace('-', ' - '),
    bigCaption: 'en olası ilk yarı skoru',
    facts: [
      { label: H, value: tr1(lh1) },
      { label: A, value: tr1(la1) },
      { label: 'İY gol', value: tr1(tot) },
    ],
    groups: [
      { title: 'İlk yarı skorları', rows: top.map((s) => ({ label: s.score, pct: pct(s.p) })) },
      {
        title: 'İlk yarı sonucu',
        rows: [
          { label: `${H} önde`, pct: pct(win) },
          { label: 'Berabere', pct: pct(draw) },
          { label: `${A} önde`, pct: pct(lose) },
        ],
      },
      {
        title: 'İlk yarı gol sayısı',
        rows: [
          { label: '0,5 üst', pct: pct(over05) },
          { label: '1,5 üst', pct: pct(over15) },
        ],
      },
    ],
    summary,
    speech,
    mood: 'warm',
    note: null,
    meta: { topScore: best.score },
  };
}

/** "1-0" → "bir sıfır" gibi konuşma biçimi (rakamlar TTS'te "1-0" diye okunmasın). */
export function spokenScore(score) {
  const w = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz', 'on'];
  const [a, b] = score.split('-').map(Number);
  return `${w[a] ?? a} ${w[b] ?? b}`;
}

function htftTopic({ H, A, say, half }) {
  const rows = half.grid.map((g) => ({ ...g, label: htftLabel(g.key) }));
  const sorted = [...rows].sort((a, b) => b.p - a.p);
  const top = sorted.slice(0, 3);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  const rev = [by['1/2'], by['2/1']].sort((a, b) => b.p - a.p);
  const revTotal = by['1/2'].p + by['2/1'].p;
  const slip = [by['1/X'], by['2/X']].sort((a, b) => b.p - a.p)[0];
  const best = top[0];

  const summary = [
    say('hf.top', [
      `En olası İY/MS ${htftLabel(best.key)} (%${pct(best.p)}): ${htftPhrase(best.key, H, A)}.`,
      `Dokuzlu tabloda zirve ${htftLabel(best.key)} (%${pct(best.p)}); yani ${htftPhrase(best.key, H, A)}.`,
    ]),
    `Ardından ${htftLabel(top[1].key)} (%${pct(top[1].p)}) ve ${htftLabel(top[2].key)} (%${pct(top[2].p)}) geliyor.`,
    say('hf.sur', [
      `Büyük sürpriz senaryoları: ${htftLabel(rev[0].key)} %${pct(rev[0].p)}, ${htftLabel(rev[1].key)} %${pct(rev[1].p)}. Toplamları %${pct(revTotal)}.`,
      `Devrede önde olan tarafın maçı kaybettiği (1/2 ya da 2/1) senaryoların toplamı %${pct(revTotal)}; en olası olanı ${htftLabel(rev[0].key)} (%${pct(rev[0].p)}).`,
    ]),
    `Önde girilen devreden sonra beraberliğe düşme ihtimali: ${htftLabel(slip.key)} %${pct(slip.p)}.`,
  ];
  const speech = [
    `En olası ilk yarı maç sonu birleşimi: ${htftPhrase(best.key, H, A)}, ihtimali yüzde ${pct(best.p)}.`,
    `Sürpriz arayanlar için: ${htftPhrase(rev[0].key, H, A)} senaryosu yüzde ${pct(rev[0].p)}.`,
    `İlk yarıda öndeki takımın maçı kaybetme ihtimali, iki yönde toplam yüzde ${pct(revTotal)}.`,
  ].join(' ');

  return {
    topic: 'htft',
    title: SPECIAL_LABELS.htft,
    headline: say('hf.head', [`En olası İY/MS: ${htftLabel(best.key)}`, `Dokuzlu tabloda zirve ${htftLabel(best.key)}`, `${htftLabel(best.key)} öne çıkıyor, sürprizler %${pct(revTotal)}`]),
    big: best.key,
    bigCaption: 'en olası İY / MS',
    facts: [
      { label: 'En olası', value: `%${pct(best.p)}` },
      { label: 'Sürpriz (1/2 + 2/1)', value: `%${pct(revTotal)}` },
    ],
    groups: [
      { title: 'İY/MS dokuzlusu', rows: sorted.map((r) => ({ label: htftLabel(r.key), pct: pct(r.p), note: htftPhrase(r.key, H, A) })) },
      { title: 'Sürpriz senaryolar', rows: [by['1/2'], by['2/1'], by['1/X'], by['2/X']].map((r) => ({ label: htftLabel(r.key), pct: pct(r.p), note: htftPhrase(r.key, H, A) })) },
    ],
    summary,
    speech,
    mood: 'excited',
    note: null,
    meta: { best: best.key, reversalPct: pct(revTotal) },
  };
}

function bttsTopic({ H, A, say, half }) {
  const ht = pct(half.bttsHt);
  const sh = pct(half.bttsSh);
  const both = pct(half.bttsBoth);
  const ft = pct(half.bttsFt);
  const tone =
    half.bttsBoth >= 0.22
      ? say('bt.high', ['İki yarıda da karşılıklı gol, bu maçta masadaki güçlü bir senaryo.', 'İki takımın da iki yarıda gol bulması hiç uzak değil.'])
      : half.bttsBoth <= 0.07
        ? say('bt.low', ['İki yarıda da karşılıklı gol nadir görülecek bir senaryo.', 'Her iki devrede de iki takımın gol bulması düşük ihtimal.'])
        : say('bt.mid', ['İki yarıda da karşılıklı gol mümkün ama garanti değil.', 'İki yarıda birden karşılıklı gol, orta düzeyde bir ihtimal.']);
  const summary = [
    say('bt.sum', [
      `İlk yarıda iki takımın da gol bulma ihtimali %${ht}, ikinci yarıda %${sh}.`,
      `${H} ile ${A} ilk yarıda birlikte gol atar mı? İhtimal %${ht}. İkinci yarıda bu ihtimal %${sh}.`,
    ]),
    `İki yarıda da iki takımın gol atması: %${both}. Maç genelinde karşılıklı gol: %${ft}.`,
    tone,
  ];
  const speech = [
    `İlk yarıda iki takımın da gol bulma ihtimali yüzde ${ht}. İkinci yarıda yüzde ${sh}.`,
    `İki yarıda da karşılıklı gol yüzde ${both}, maç genelinde yüzde ${ft}.`,
    tone,
  ].join(' ');
  return {
    topic: 'btts',
    title: SPECIAL_LABELS.btts,
    headline: say('bt.head', [`İki yarıda da karşılıklı gol: %${both}`, `Karşılıklı gol: ilk yarı %${ht}, ikinci yarı %${sh}`, `KG var senaryosu: iki yarıda %${both}`]),
    big: `%${both}`,
    bigCaption: 'iki yarıda da KG var',
    facts: [
      { label: 'İlk yarı', value: `%${ht}` },
      { label: 'İkinci yarı', value: `%${sh}` },
      { label: 'Maç sonu', value: `%${ft}` },
    ],
    groups: [
      {
        title: 'KG var senaryoları',
        rows: [
          { label: 'İlk yarı KG var', pct: ht },
          { label: 'İkinci yarı KG var', pct: sh },
          { label: 'İki yarıda da KG var', pct: both },
          { label: 'Maç sonu KG var', pct: ft },
        ],
      },
    ],
    summary,
    speech,
    mood: 'warm',
    note: null,
    meta: { ht, sh, both, ft },
  };
}

/**
 * İstenen başlıkları üretir.
 * model: { lambdaHome, lambdaAway, sigma }, corners: expectedCorners() sonucu (korner verisi alınabildiyse; yoksa null).
 */
export function buildSpecial(topics, { homeName, awayName, model, corners = null, seed }) {
  const H = homeName;
  const A = awayName;
  const { lambdaHome, lambdaAway, sigma = 0 } = model;
  const half = topics.some((t) => t === 'htft' || t === 'btts') ? halfModel({ lambdaHome, lambdaAway, sigma }) : null;
  const out = {};
  for (const t of topics) {
    if (!SPECIAL_TOPICS.includes(t)) continue;
    const say = phraser(`${seed}|special|${t}`);
    const args = { H, A, say, lambdaHome, lambdaAway, sigma, half, corners };
    out[t] = t === 'corners' ? cornersTopic(args) : t === 'htscore' ? htscoreTopic(args) : t === 'htft' ? htftTopic(args) : bttsTopic(args);
  }
  return out;
}
