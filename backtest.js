// Geriye dönük deneme. Kullanım:
//   node scripts/backtest.js            → gerçek gücü bilinen yapay ligler (ağ gerekmez)
//   node scripts/backtest.js tur.1      → gerçek lig: ESPN'den son ~2 yıl çekilir, son 120 gün yürüyen denemeyle ölçülür
//   node scripts/backtest.js eng.1 90   → son 90 gün
// Çıktı: eski ve yeni yöntemin olasılık hatası (düşük = iyi), isabet ve kalibrasyon tablosu.

import { EspnClient } from '../engine/espn.js';
import { makeSyntheticLeague, walkForward, format } from '../engine/backtest.js';

const VARIANTS = {
  'eski (takım geçmişi, ham)': { ratings: false, uncertainty: false, venueAdjust: false },
  'takım geçmişi + düzeltmeler': { ratings: false, uncertainty: true, venueAdjust: true, consistentScore: true },
  'lig gücü + belirsizlik (yeni)': { ratings: true, uncertainty: true, consistentScore: true },
};

const [league, daysArg] = process.argv.slice(2);
const DAY = 86400000;

if (!league) {
  for (const seed of ['a', 'b', 'c']) {
    const { matches } = makeSyntheticLeague({ seed });
    console.log(`Yapay lig "${seed}" (20 takım, 2 sezon, gerçek güçler bilinir)`);
    console.log(format(walkForward(matches, { from: matches[0].timestamp + 400 * DAY, variants: VARIANTS })));
    console.log();
  }
} else {
  const days = Number(daysArg) || 120;
  const espn = new EspnClient();
  console.log(`${league}: ESPN'den lig maçları alınıyor (birkaç saniye sürebilir)...`);
  const matches = await espn.getLeagueMatches(league, { days: 700 });
  console.log(`${matches.length} bitmiş maç alındı`, matches.meta ?? '');
  if (matches.meta?.truncated) console.log('UYARI: bazı dilimler ESPN sınırında kırpılmış olabilir.');
  const from = Date.now() - days * DAY;
  console.log(format(walkForward(matches, { from, variants: VARIANTS })));
}
