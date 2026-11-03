// Uygulamanın gerçekten yayımladığı tahminlerin karnesi (Firestore'daki kayıtlardan). Kullanım (Render kabuğunda ya da
// FIREBASE_SERVICE_ACCOUNT tanımlı bir bilgisayarda):
//   node scripts/review_predictions.js          → son 60 gün
//   node scripts/review_predictions.js 120      → son 120 gün
// Çıktı:
//   1) AI tahmini (MS 1/X/2): isabet, Brier, kalibrasyon (verilen yüzde → gerçekleşen oran)
//   2) Günün tahminleri: beş türün (MS, İY, 2.5, KG, İY 0.5) gösterilen yüzdesi ile tutma oranı, öne çıkan tahmin
//   3) Canlı Radar: tür ve yıldıza göre beklenen tutma (ham ve öğrenilmiş ihtimal) ile gerçekleşen
// Yüzdeler sistematik olarak ayrışıyorsa engine/calibration.js katsayıları (scripts/calibrate.js) yeniden bulunmalı.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const days = Number(process.argv[2]) || 60;
const since = Date.now() - days * 86400e3;
const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('FIREBASE_SERVICE_ACCOUNT tanımlı değil.');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'))) });
const db = getFirestore();

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const bins = () => new Map();
const bump = (m, p, y) => {
  const k = Math.min(9, Math.floor(p * 10));
  const b = m.get(k) ?? { n: 0, p: 0, y: 0 };
  b.n++;
  b.p += p;
  b.y += y ? 1 : 0;
  m.set(k, b);
};
const show = (m) =>
  [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, b]) => b.n >= 5)
    .map(([, b]) => `${Math.round((b.p / b.n) * 100)}→${Math.round((b.y / b.n) * 100)} (${b.n})`)
    .join('  ');

// 1) AI tahmini
{
  const q = await db.collection('predictions').where('kickoffMs', '>=', since).get();
  const rows = q.docs.map((d) => d.data()).filter((r) => r.actual && r.probs);
  const cal = bins();
  let hit = 0;
  let brier = 0;
  for (const r of rows) {
    if (r.outcomeHit) hit++;
    brier += Number(r.brier ?? 0);
    for (const o of ['1', 'X', '2']) bump(cal, Number(r.probs[o]) / 100, r.outcome === o);
  }
  console.log(`\n== AI tahmini (son ${days} gün): ${rows.length} maç`);
  if (rows.length) {
    console.log(`isabet ${pct(hit / rows.length)} · Brier ${(brier / rows.length).toFixed(3)} (her sonuca eşit yüzde: 0,667)`);
    console.log(`kalibrasyon (verilen → gerçekleşen): ${show(cal)}`);
  }
}

// 2) Günün tahminleri
{
  const q = await db.collection('daily_preds').where('kickoffMs', '>=', since).get();
  const rows = q.docs.map((d) => d.data()).filter((r) => r.result?.status === 'done' && r.hits);
  console.log(`\n== Günün tahminleri: ${rows.length} maç`);
  const by = new Map();
  let bestN = 0;
  let bestHit = 0;
  for (const r of rows) {
    const list = r.live?.markets?.length ? r.live.markets : (r.markets ?? []);
    const bestId = r.live?.best ?? r.best;
    for (const m of list) {
      const h = r.hits[m.id];
      if (h === null || h === undefined) continue;
      const t = by.get(m.id) ?? { n: 0, p: 0, y: 0, cal: bins() };
      t.n++;
      t.p += m.pct / 100;
      t.y += h ? 1 : 0;
      bump(t.cal, m.pct / 100, h);
      by.set(m.id, t);
      if (m.id === bestId) {
        bestN++;
        if (h) bestHit++;
      }
    }
  }
  for (const [id, t] of by) console.log(`${id.padEnd(4)} gösterilen ort. ${pct(t.p / t.n)} · tuttu ${pct(t.y / t.n)} · ${show(t.cal)}`);
  if (bestN) console.log(`öne çıkan tahmin: ${bestN} maç, tuttu ${pct(bestHit / bestN)}`);
}

// 3) Canlı Radar
{
  const q = await db.collection('radar_signals').where('createdAt', '>=', since).get();
  const rows = q.docs.map((d) => d.data()).filter((s) => s.status === 'hit' || s.status === 'miss');
  console.log(`\n== Canlı Radar: ${rows.length} sonuçlanan sinyal`);
  const by = new Map();
  for (const s of rows) {
    const k = `${s.type} ${'★'.repeat(s.stars ?? 1)}`;
    const t = by.get(k) ?? { n: 0, hit: 0, raw: 0, shown: 0 };
    t.n++;
    if (s.status === 'hit') t.hit++;
    t.raw += Number(s.chance?.raw ?? s.chance?.p ?? 0);
    t.shown += Number(s.chance?.p ?? 0);
    by.set(k, t);
  }
  for (const [k, t] of [...by.entries()].sort()) {
    console.log(`${k.padEnd(12)} n ${String(t.n).padStart(4)} · tuttu ${pct(t.hit / t.n)} · ham model ${pct(t.raw / t.n)} · gösterilen ${pct(t.shown / t.n)}`);
  }
}
process.exit(0);
