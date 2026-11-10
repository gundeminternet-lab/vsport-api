// Maç içi kritik anlar: devre arası taktiğinden sonra ikinci yarıda oyuncunun karar verdiği anlar. Maç o anda durur,
// oyuncu seçer, maç seçimine göre sürer (aynı tohum: o ana kadarki her şey birebir aynı kalır).
//
//   pen_for      lehimize penaltı: atış yönü (sol / orta / sağ; atanın bakışıyla)
//   pen_against  aleyhimize penaltı: kalecinin atlayacağı yön
//   late         70. dakika: son 20 dakika planı (kalemizi koru / dengede kal / gol için yüklen)
// İkinci yarıdaki ilk penaltı ve 70. dakika sorulur (en çok iki an); diğerleri motorun kendi sonucuyla oynanır.

import { createRng } from '../engine/rng.js';

export const LATE_MINUTE = 70;
export const DIRS = ['sol', 'orta', 'sag'];
export const DIR_NAMES = { sol: 'Sol', orta: 'Orta', sag: 'Sağ' };
/** Son 20 dakika seçenekleri → taktik. */
export const LATE = {
  savun: { id: 'savun', name: 'Kalemizi koru', tactic: 'savunma', desc: 'Geride kal, skoru koru' },
  dengede: { id: 'dengede', name: 'Dengede kal', tactic: 'dengeli', desc: 'Planı bozmadan oyna' },
  yuklen: { id: 'yuklen', name: 'Gol için yüklen', tactic: 'hucum', desc: 'Öne çık, risk al' },
};

const r2 = (x) => Math.round(x * 100) / 100;

/** Tohumdan ve seçimden penaltı sonucu (saf). */
export function resolvePenalty({ seed, n, type, choice }) {
  const rng = createRng(`${seed}|pen${n}`);
  const forUs = type === 'pen_for';
  const other = rng.pickWeighted(DIRS, forUs ? [0.42, 0.16, 0.42] : [0.4, 0.2, 0.4]);
  const roll = rng.next();
  if (forUs) {
    // Seçilen: atış yönü, diğeri: kalecinin atladığı yön
    const outcome = choice === other ? (roll < 0.8 ? 'saved' : 'goal') : roll < 0.94 ? 'goal' : 'missed';
    return { outcome, dir: choice, keeper: other };
  }
  // Seçilen: bizim kalecinin atladığı yön, diğeri: rakibin atış yönü
  const outcome = choice === other ? (roll < 0.72 ? 'saved' : 'goal') : roll < 0.95 ? 'goal' : 'missed';
  return { outcome, dir: other, keeper: choice };
}

/**
 * Bekleyen seçimlerden motorun maç içi girdileri (playDuel moments). Kritik an modunda maç 70. dakikada her zaman
 * durur (pauseMinute): böylece seçimden önceki her şey, sonraki olaylardan bağımsız olarak birebir aynı kalır.
 */
export function momentInputs(state, oppTactic) {
  if (!state) return null;
  const out = { pauseMinute: LATE_MINUTE };
  const pens = Object.entries(state.choices ?? {}).filter(([k]) => k.startsWith('pen'));
  if (pens.length) {
    out.penaltyOutcome = {};
    out.penaltyDir = {};
    for (const [k, v] of pens) {
      const n = Number(k.slice(3));
      out.penaltyOutcome[n] = v.outcome;
      out.penaltyDir[n] = v.dir;
    }
  }
  // late: { id, from } — from: kararın geçerli olduğu dakika (oyun 70. dakikanın başında durur)
  const late = state.choices?.late;
  const id = typeof late === 'string' ? late : late?.id;
  if (id && LATE[id]) out.phase3 = { fromMinute: Math.max(LATE_MINUTE, Number(late?.from) || LATE_MINUTE), me: LATE[id].tactic, opp: oppTactic };
  return out;
}

/** Saat etiketinden dakika ("71'" → 71, "90+2'" → 90). */
export const minuteOfLabel = (label) => parseInt(String(label ?? '0'), 10) || 0;

/** Bu maçtaki kritik anın kesme saniyesi (animasyon): penaltıda atıştan hemen önce, 70'te top taça çıkınca. */
export function syncTime(match, id) {
  const ms = match.choreo.moments;
  if (id === 'late') {
    const m = ms.find((x) => x.kind === 'pause' && x.id === 'late');
    return m ? r2(m.tC + 0.1) : null;
  }
  if (String(id).startsWith('pen')) {
    const n = Number(String(id).slice(3));
    const m = ms.find((x) => x.kind === 'penalty' && x.n === n);
    return m ? r2(m.tShot - 0.16) : null;
  }
  return null;
}

/**
 * Maçta bekleyen ilk kritik an. after: bu animasyon saniyesinden sonra; state: önceki seçimler.
 * Döner: { id, type, cut, minute, side, n?, from? } ya da null.
 */
export function nextMoment(match, { after = 0, state = null } = {}) {
  const { choreo, timeline, durationSeconds } = match;
  const choices = state?.choices ?? {};
  const list = [];
  // İkinci yarının ilk penaltısı (bir kez sorulur)
  if (!Object.keys(choices).some((k) => k.startsWith('pen'))) {
    const pm = choreo.moments.filter((m) => m.kind === 'penalty' && m.n != null).sort((a, b) => a.tStart - b.tStart)[0];
    const e = pm ? timeline.events.find((x) => x.type === 'penalty_awarded' && x.n === pm.n) : null;
    if (pm && e && pm.tShot < durationSeconds - 1) list.push({ id: `pen${pm.n}`, n: pm.n, type: e.side === 'home' ? 'pen_for' : 'pen_against', cut: r2(pm.tShot - 0.16), minute: e.label, side: e.side });
  }
  // 70. dakika: son 20 dakika planı
  if (!choices.late) {
    const pz = choreo.moments.find((m) => m.kind === 'pause' && m.id === 'late');
    if (pz && pz.tC < durationSeconds - 1.5) list.push({ id: 'late', type: 'late', cut: r2(pz.tC + 0.1), minute: `${LATE_MINUTE}'`, from: LATE_MINUTE });
  }
  return list.filter((m) => m.cut > after + 0.05).sort((a, b) => a.cut - b.cut)[0] ?? null;
}

/** Uygulamaya giden an. */
export function momentView(m, score) {
  if (!m) return null;
  const base = { id: m.id, type: m.type, minute: m.minute, cut: m.cut, score };
  if (m.type === 'late') return { ...base, title: 'Son 20 dakika', text: 'Maçın kaderi senin elinde. Son bölüm için planını seç.', options: Object.values(LATE).map((o) => ({ id: o.id, name: o.name, desc: o.desc })) };
  const forUs = m.type === 'pen_for';
  return {
    ...base,
    title: forUs ? 'Penaltı bizim!' : 'Rakip penaltı kazandı',
    text: forUs ? 'Atışın yönünü seç: kaleci nereye atlayacak?' : 'Kalecin hangi köşeye atlasın?',
    options: DIRS.map((d) => ({ id: d, name: DIR_NAMES[d] })),
  };
}
