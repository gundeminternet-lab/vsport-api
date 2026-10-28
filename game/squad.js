// Benim 11'im: dizilişler, kimya ve kadro doğrulama (saf). Uygulamadaki lib/game/squad_logic.dart ile aynı kurallar;
// sunucu kaydederken kimya ve gücü yeniden hesaplar (istemcinin gönderdiğine güvenilmez).
//
// Kimya (oyuncu başına 0-3, kadro en çok 33): oyuncu mevki grubuna uygun yuvadaysa
//   kulüp: kadroda aynı kulüpten 1+ arkadaş +1, 3+ arkadaş +2
//   uyruk: aynı uyruktan 2+ arkadaş +1, 4+ arkadaş +2
//   lig:   aynı ligden 3+ arkadaş +1, 6+ arkadaş +2
// toplamı en çok 3. Uygunsuz yuvadaki oyuncu 0 alır.

/** Diziliş → yuvalar ({ key, g: grup, pos: gösterilen mevki }). Sıra: kaleci, savunma, orta saha, forvet. */
const F = {
  '4-3-3': ['KL', 'SLB', 'STP', 'STP', 'SĞB', 'MOS', 'DOS', 'MOS', 'SLK', 'SNT', 'SĞK'],
  '4-4-2': ['KL', 'SLB', 'STP', 'STP', 'SĞB', 'SLO', 'MOS', 'MOS', 'SĞO', 'SNT', 'SNT'],
  '4-2-3-1': ['KL', 'SLB', 'STP', 'STP', 'SĞB', 'DOS', 'DOS', 'SLO', 'OOS', 'SĞO', 'SNT'],
  '4-1-4-1': ['KL', 'SLB', 'STP', 'STP', 'SĞB', 'DOS', 'SLO', 'MOS', 'MOS', 'SĞO', 'SNT'],
  '4-3-2-1': ['KL', 'SLB', 'STP', 'STP', 'SĞB', 'MOS', 'DOS', 'MOS', 'SLK', 'SĞK', 'SNT'],
  '4-5-1': ['KL', 'SLB', 'STP', 'STP', 'SĞB', 'SLO', 'MOS', 'DOS', 'MOS', 'SĞO', 'SNT'],
  '3-5-2': ['KL', 'STP', 'STP', 'STP', 'SLO', 'MOS', 'DOS', 'MOS', 'SĞO', 'SNT', 'SNT'],
  '3-4-3': ['KL', 'STP', 'STP', 'STP', 'SLO', 'MOS', 'MOS', 'SĞO', 'SLK', 'SNT', 'SĞK'],
  '5-3-2': ['KL', 'SLB', 'STP', 'STP', 'STP', 'SĞB', 'MOS', 'DOS', 'MOS', 'SNT', 'SNT'],
  '5-4-1': ['KL', 'SLB', 'STP', 'STP', 'STP', 'SĞB', 'SLO', 'MOS', 'MOS', 'SĞO', 'SNT'],
};

export const FORMATIONS = Object.keys(F);

const GROUP_OF_POS = { KL: 'KL', SLB: 'DEF', STP: 'DEF', SĞB: 'DEF', DOS: 'OS', MOS: 'OS', OOS: 'OS', SLO: 'OS', SĞO: 'OS', SLK: 'FV', SĞK: 'FV', SNT: 'FV' };

export function slotsOf(formation) {
  const list = F[formation];
  if (!list) return null;
  return list.map((pos, i) => ({ key: `s${i}`, pos, g: GROUP_OF_POS[pos] }));
}

/** Kadronun kimyası, gücü ve eksik yuva sayısı. lineup: { s0: kart, ... } (kart: { g, r, c|ci, na, l }). */
export function evaluate(formation, lineup) {
  const slots = slotsOf(formation);
  if (!slots) return null;
  const placed = slots.map((s) => ({ slot: s, card: lineup?.[s.key] ?? null }));
  const cards = placed.filter((x) => x.card);
  const count = (fn) => {
    const m = new Map();
    for (const { card } of cards) {
      const k = fn(card);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const clubs = count((c) => c.ci ?? c.c);
  const nations = count((c) => c.na);
  const leagues = count((c) => c.l);
  const per = {};
  let chemistry = 0;
  let ratingSum = 0;
  for (const { slot, card } of placed) {
    if (!card) continue;
    ratingSum += card.r;
    let pts = 0;
    if (card.g === slot.g) {
      const club = (clubs.get(card.ci ?? card.c) ?? 1) - 1;
      const nat = (nations.get(card.na) ?? 1) - 1;
      const lg = (leagues.get(card.l) ?? 1) - 1;
      pts += club >= 3 ? 2 : club >= 1 ? 1 : 0;
      pts += card.na ? (nat >= 4 ? 2 : nat >= 2 ? 1 : 0) : 0;
      pts += lg >= 6 ? 2 : lg >= 3 ? 1 : 0;
      pts = Math.min(3, pts);
    }
    per[slot.key] = pts;
    chemistry += pts;
  }
  return {
    chemistry,
    rating: cards.length ? Math.round(ratingSum / cards.length) : 0,
    missing: slots.length - cards.length,
    per,
  };
}

/** Kapışma gücü: ortalama puan + kimya katkısı (33 kimya ≈ +3). */
export function teamPower(ev) {
  return ev.rating + ev.chemistry / 11;
}

/**
 * Kaydedilecek kadroyu doğrular. owned: kart kimliği → kart. slots: { s0: kartKimliği, ... }.
 * Döner: { ok: true, lineup, ev } ya da { ok: false, error }.
 */
export function validateSquad({ name, formation, slots }, owned) {
  const nm = String(name ?? '').trim();
  if (nm.length < 2 || nm.length > 30) return { ok: false, error: 'Kadro adı 2-30 karakter olmalı.' };
  const def = slotsOf(formation);
  if (!def) return { ok: false, error: 'Geçersiz diziliş.' };
  const lineup = {};
  const used = new Set();
  for (const s of def) {
    const id = slots?.[s.key];
    if (!id) continue;
    const card = owned.get(String(id));
    if (!card) return { ok: false, error: 'Kadroda sana ait olmayan bir kart var.' };
    if (used.has(card.pid ?? card.id)) return { ok: false, error: 'Aynı oyuncu kadroda iki kez olamaz.' };
    if (card.g !== s.g) return { ok: false, error: `${card.s ?? card.n} bu mevkide oynayamaz.` };
    used.add(card.pid ?? card.id);
    lineup[s.key] = card;
  }
  const ev = evaluate(formation, lineup);
  if (ev.missing > 0) return { ok: false, error: `Kadroda ${ev.missing} eksik oyuncu var.` };
  return { ok: true, lineup, ev, name: nm };
}

/**
 * Otomatik kadro (sunucuda rakip kadro kurmak için; uygulamada aynı mantık Dart'ta). priority: 'power' | 'balanced' | 'chem'.
 * Açgözlü yerleşim + yer değiştirerek iyileştirme. Döner: { s0: kart, ... }.
 */
export function autoBuild(cards, formation, priority = 'balanced') {
  const slots = slotsOf(formation);
  if (!slots) return {};
  const score = (lineup) => {
    const ev = evaluate(formation, lineup);
    const w = priority === 'power' ? 0 : priority === 'chem' ? 12 : 3;
    return ev.rating * 11 + ev.chemistry * w;
  };
  const byGroup = new Map(['KL', 'DEF', 'OS', 'FV'].map((g) => [g, cards.filter((c) => c.g === g).sort((a, b) => b.r - a.r)]));
  const lineup = {};
  const used = new Set();
  for (const s of slots) {
    const pick = byGroup.get(s.g).find((c) => !used.has(c.pid ?? c.id));
    if (pick) {
      lineup[s.key] = pick;
      used.add(pick.pid ?? pick.id);
    }
  }
  if (priority === 'power') return lineup;
  // Yedeklerle yer değiştirerek kimyayı artır (en çok 3 tur)
  for (let round = 0; round < 3; round++) {
    let improved = false;
    for (const s of slots) {
      const cur = lineup[s.key];
      for (const c of byGroup.get(s.g)) {
        const pid = c.pid ?? c.id;
        if (used.has(pid)) continue;
        const trial = { ...lineup, [s.key]: c };
        if (score(trial) > score(lineup)) {
          if (cur) used.delete(cur.pid ?? cur.id);
          lineup[s.key] = c;
          used.add(pid);
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  return lineup;
}
