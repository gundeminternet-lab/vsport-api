// Kalibrasyon katsayılarını (engine/calibration.js) yeniden bulur. Veri: openfootball/football.json'dan çevrilmiş tek
// dosya ([{ league, timestamp, homeId, awayId, homeGoals, awayGoals, htHome, htAway }]).
//   node scripts/calibrate.js matches.json
// Model her hafta, o haftadan önce bilinen maçlarla yeniden kurulur; eğitim 2017-22, doğrulama 2022-26. Katsayılar
// doğrulamada iyileşme getiriyorsa engine/calibration.js'e "tümü" satırındaki değerler yazılır. ÖNEMLİ: ham olasılıkla
// çalışmak için önce engine/calibration.js'teki CALIBRATION boş bırakılarak (CAL_OFF=1) çalıştırılır.
import fs from 'node:fs';
import { fitRatings } from '../engine/ratings.js';
import { analyzeMatch } from '../engine/analysis.js';
import { MODEL } from '../engine/config.js';
import { markets as marketProbs } from '../content.js';
import { CALIBRATION } from '../engine/calibration.js';

if (process.env.CAL_OFF) for (const k of Object.keys(CALIBRATION)) delete CALIBRATION[k];
const DAY = 86400000;
const data = JSON.parse(fs.readFileSync(process.argv[2]));
const by = new Map();
for (const m of data) (by.get(m.league) ?? by.set(m.league, []).get(m.league)).push(m);
const leagues = (process.env.LEAGUES ?? 'en.1,de.1,es.1,it.1,fr.1,nl.1,pt.1,tr.1,en.2,de.2,it.2,es.2,fr.2').split(',');
function collect(from, to) {
  const rows = [];
  for (const lg of leagues) {
    const ms = by.get(lg) ?? [];
    const [cc, t] = lg.split('.');
    const upper = by.get(`${cc}.${+t - 1}`);
    const weekOf = (x) => Math.floor((x / DAY + 3) / 7);
    const weeks = [...new Set(ms.filter((m) => m.timestamp >= from && m.timestamp < to).map((m) => weekOf(m.timestamp)))];
    for (const w of weeks) {
      const now = (w * 7 - 3) * DAY;
      const hist = ms.filter((m) => m.timestamp < now && m.timestamp > now - 620 * DAY);
      let newTeam = MODEL.ratingNewTeam;
      if (newTeam && +t > 1) {
        const rec = new Set();
        if (upper) for (const x of upper) if (x.timestamp < now && x.timestamp > now - 400 * DAY) { rec.add(x.homeId); rec.add(x.awayId); }
        newTeam = { ...newTeam, center: (id) => (rec.has(id) ? MODEL.ratingRelegatedTeam : null) };
      }
      const R = fitRatings(hist, { now, newTeam });
      if (!R) continue;
      for (const m of ms) {
        if (weekOf(m.timestamp) !== w || m.timestamp < from || m.timestamp >= to || m.htHome == null) continue;
        const own = (id) => hist.filter((x) => x.homeId === id || x.awayId === id).slice(-40);
        const h2h = hist.filter((x) => (x.homeId === m.homeId && x.awayId === m.awayId) || (x.homeId === m.awayId && x.awayId === m.homeId)).slice(-8).reverse();
        const a = analyzeMatch({ home: { id: m.homeId, name: 'E' }, away: { id: m.awayId, name: 'D' }, homeMatches: own(m.homeId), awayMatches: own(m.awayId), h2hMatches: h2h, ratings: R, now });
        rows.push({ p: marketProbs(a.lambdaHome, a.lambdaAway, a.sigma).p, facts: { home: m.homeGoals, away: m.awayGoals, ht: [m.htHome, m.htAway] } });
      }
    }
  }
  return rows;
}
const tr = collect(Date.parse('2017-07-01'), Date.parse('2022-07-01'));
const va = collect(Date.parse('2022-07-01'), Date.parse('2026-07-01'));
const all = tr.concat(va);
const lg = (p) => Math.log(p / (1 - p)), sg = (x) => 1 / (1 + Math.exp(-x));
const cl = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));
const BIN = {
  over25: (f) => f.home + f.away >= 3,
  kgVar: (f) => f.home > 0 && f.away > 0,
  iyOver05: (f) => f.ht[0] + f.ht[1] >= 1,
  over15: (f) => f.home + f.away >= 2,
  over35: (f) => f.home + f.away >= 4,
};
function fitBin(rows, key) {
  let a = 0, b = 1;
  for (let it = 0; it < 400; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (const r of rows) {
      const x = lg(cl(r.p[key])), y = +BIN[key](r.facts), q = sg(a + b * x), w = q * (1 - q);
      ga += q - y; gb += (q - y) * x; haa += w; hab += w * x; hbb += w * x * x;
    }
    const det = haa * hbb - hab * hab; a -= (hbb * ga - hab * gb) / det; b -= (haa * gb - hab * ga) / det;
  }
  return { a: +a.toFixed(4), b: +b.toFixed(4) };
}
const llBin = (rows, key, c) => rows.reduce((s, r) => { const y = +BIN[key](r.facts); const q = c ? sg(c.a + c.b * lg(cl(r.p[key]))) : r.p[key]; return s - Math.log(cl(y ? q : 1 - q)); }, 0) / rows.length;
const TRI = { ms: ['ms1', 'msX', 'ms2'], iy: ['iy1', 'iyX', 'iy2'] };
const resOf = (k, f) => { const [h, a] = k === 'ms' ? [f.home, f.away] : f.ht; return h > a ? 0 : h === a ? 1 : 2; };
const triP = (r, k, c) => { const ps = TRI[k].map((x) => cl(r.p[x])); if (!c) return ps; const z = ps.map((p, i) => Math.exp(c.b[i] + c.t * Math.log(p))); const s = z.reduce((x, y) => x + y); return z.map((v) => v / s); };
const llTri = (rows, k, c) => rows.reduce((s, r) => s - Math.log(triP(r, k, c)[resOf(k, r.facts)]), 0) / rows.length;
function fitTri(rows, k) {
  let best = { t: 1, b: [0, 0, 0] }, bl = llTri(rows, k, best);
  for (let step of [0.1, 0.03, 0.01, 0.003]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const d of [[step, 0, 0], [-step, 0, 0], [0, step, 0], [0, -step, 0]]) {
        const c = { t: best.t + d[0], b: [0, best.b[1] + d[1], best.b[2] + d[2]] };
        const l = llTri(rows, k, c); if (l < bl - 1e-7) { bl = l; best = c; improved = true; }
      }
      for (const d of [step, -step]) { const c = { t: best.t, b: [0, best.b[1], best.b[2] + d] }; const l = llTri(rows, k, c); if (l < bl - 1e-7) { bl = l; best = c; improved = true; } }
    }
  }
  return { t: +best.t.toFixed(3), b: best.b.map((x) => +x.toFixed(3)) };
}
const out = {};
for (const k of Object.keys(BIN)) {
  const c = fitBin(tr, k);
  console.log(k.padEnd(9), JSON.stringify(c), 'val ham', llBin(va, k).toFixed(5), 'val kal', llBin(va, k, c).toFixed(5), '| tümü', JSON.stringify(out[k] = fitBin(all, k)));
}
for (const k of Object.keys(TRI)) {
  const c = fitTri(tr, k);
  console.log(k.padEnd(9), JSON.stringify(c), 'val ham', llTri(va, k).toFixed(5), 'val kal', llTri(va, k, c).toFixed(5), '| tümü', JSON.stringify(out[k] = fitTri(all, k)));
}
console.log('\nengine/calibration.js için:', JSON.stringify(out));
