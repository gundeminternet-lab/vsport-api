// Kapışma Ligi kümeleri: haftalık lig gerçek kullanıcılarla oynanır (rakip kadrolar başka kullanıcılardan). Kullanıcılar
// kümelere ayrılır; hafta sonunda kümesinin ilk üçü üst kümeye çıkar, sonları düşer, sıraya göre ödül alır.

export const DIVISIONS = [
  { id: 1, name: 'Elit Lig', prize: [3000, 2000, 1500], base: 600 },
  { id: 2, name: 'Altın Lig', prize: [2000, 1400, 1000], base: 400 },
  { id: 3, name: 'Gümüş Lig', prize: [1400, 1000, 700], base: 250 },
  { id: 4, name: 'Bronz Lig', prize: [1000, 700, 500], base: 150 },
  { id: 5, name: 'Çaylak Ligi', prize: [700, 500, 300], base: 80 },
];
export const START_DIV = 5;
/** Yükselmek için en az maç; düşme hattı küme en az bu kadar kişiyse. */
export const RULES = { up: 3, down: 3, minPlayed: 3, minSize: 8 };

export const divOf = (id) => DIVISIONS.find((d) => d.id === Number(id)) ?? DIVISIONS[DIVISIONS.length - 1];

/**
 * Geçen haftanın sonucu (saf). rows: o kümede oynayanlar [{ uid, points, played, gf, ga }], uid: kullanıcı.
 * Döner: { rank, size, move: 1 | 0 | -1, reward, div: yeni küme }
 */
export function settleWeek(rows, uid, div) {
  const list = [...rows].sort((a, b) => b.points - a.points || (b.gf - b.ga) - (a.gf - a.ga) || b.gf - a.gf);
  const i = list.findIndex((r) => r.uid === uid);
  const d = divOf(div);
  if (i < 0) return { rank: null, size: list.length, move: 0, reward: 0, div: d.id };
  const me = list[i];
  const rank = i + 1;
  const size = list.length;
  let move = 0;
  if (d.id > 1 && rank <= RULES.up && Number(me.played) >= RULES.minPlayed) move = 1;
  else if (d.id < DIVISIONS.length && size >= RULES.minSize && rank > size - RULES.down) move = -1;
  const reward = (d.prize[rank - 1] ?? 0) + (Number(me.played) > 0 ? d.base : 0);
  return { rank, size, move, reward, div: d.id - move };
}
