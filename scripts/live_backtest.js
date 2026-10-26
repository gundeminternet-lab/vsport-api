// Canlı modeli yapay maçlarda eski hesaplarla karşılaştırır.  Çalıştırma:  npm run backtest:live  (≈1 dk)
// Not: gerçek maçların dakikalık şut/gol akışı olmadan yapılan bir kontroldür; sonuçlar "yapay maçlarda" okunmalıdır.
import { runLiveBacktest } from '../engine/live_backtest.js';

const n = Number(process.argv[2]) || 2000;
for (const assume of [true, false]) {
  const r = runLiveBacktest({ n, assume, seed: 'cli' });
  console.log(assume ? '\nGerçekçi maçlar (zaman eğrisi + skor etkisi + kırmızı kart):' : '\nVarsayımsız maçlar (bu etkiler yokken):');
  console.log('dakika | model | log kaybı (1-X-2, düşük iyi) | "skor böyle biter" Brier (düşük iyi)');
  for (const label of [30, 'HT', 60, 75]) {
    for (const [k, v] of Object.entries(r[label])) {
      console.log(`${String(label).padEnd(6)} | ${k.padEnd(5)} | ${v.logLoss.toFixed(4).padEnd(27)} | ${v.brierStay.toFixed(4)}`);
    }
  }
}
