// Tahmin yüzdelerinin son ayarı (kalibrasyon). Model gol beklentisinden olasılık tablosu kurar; bazı türlerde tablonun
// verdiği yüzde gerçekte görülen orandan sistematik olarak ayrışır. Burada her tür için logit uzayında doğrusal bir
// düzeltme uygulanır: p' = σ(a + b·logit(p)).
//
// Katsayılar 2017-2026 arası 13 ligde (en, de, es, it, fr, nl, pt, tr ve ikinci ligler; ~35 bin maç), maçtan önce
// bilinenlerle haftalık yeniden kurulan modelin tahminlerinden bulundu (scripts/calibrate.js). Eğitim 2017-22 /
// doğrulama 2022-26 ayrımında doğrulamada log kaybı:
//   KG var   0.6868 → 0.6849   (model karşılıklı golde fazla iddialıydı: eğim 0.71)
//   2.5 üst  0.6812 → 0.6805
//   1.5 üst  0.5274 → 0.5271,  3.5 üst 0.6059 → 0.6057
// MS (1/X/2), İY sonucu ve İY 0.5 üst için düzeltme doğrulamada iyileşme getirmediği için uygulanmaz.

export const CALIBRATION = {
  kgVar: { a: 0.1009, b: 0.7128 },
  over15: { a: 0.1165, b: 0.9404 },
  over25: { a: 0.0606, b: 0.9544 },
  over35: { a: -0.0132, b: 0.9446 },
};

const clamp = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

/** Tek bir türün yüzdesini düzeltir (bilinmeyen tür olduğu gibi döner). */
export function calibrate(key, p) {
  const c = CALIBRATION[key];
  if (!c || !Number.isFinite(p)) return p;
  const x = Math.log(clamp(p) / (1 - clamp(p)));
  return 1 / (1 + Math.exp(-(c.a + c.b * x)));
}

/** Gol çizgileri sırası korunur: P(1.5 üst) ≥ P(2.5 üst) ≥ P(3.5 üst). */
export function calibrateGoals({ over15, over25, over35 }) {
  const o15 = calibrate('over15', over15);
  const o25 = Math.min(o15, calibrate('over25', over25));
  const o35 = Math.min(o25, calibrate('over35', over35));
  return { over15: o15, over25: o25, over35: o35 };
}

/** Ters düzeltme: gerçek dünyadaki bir yüzdeyi (ör. piyasanın 2.5 üst görüşü) modelin ham tablo uzayına çevirir. */
export function uncalibrate(key, p) {
  const c = CALIBRATION[key];
  if (!c || !Number.isFinite(p)) return p;
  const y = Math.log(clamp(p) / (1 - clamp(p)));
  return 1 / (1 + Math.exp(-((y - c.a) / c.b)));
}
