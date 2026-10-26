// Seviye (XP) ve rozetler. Hepsi sunucuda hesaplanır; kullanıcı kendi puanını değiştiremez.
//   user_stats/{uid}: { xp, predictions, exact, leaguePoints, podiums, wins, unlocks, streak, bestStreak, lastDay, badges: [] }
// Uygulama seviyeyi xp'den hesaplar (lib/models/progress.dart, aynı formül).

export const XP = { checkIn: 10, streakBonusPer7: 20, prediction: 5, perPoint: 10, unlock: 20, podium: [200, 100, 50] };

/** Rozetler: kimlik → koşul. Uygulamadaki adlar ve açıklamalar lib/models/progress.dart'ta. */
export const BADGES = {
  first_prediction: (s) => s.predictions >= 1,
  predictor_50: (s) => s.predictions >= 50,
  sharp_10: (s) => s.exact >= 10,
  oracle_25: (s) => s.exact >= 25,
  streak_7: (s) => s.bestStreak >= 7,
  streak_30: (s) => s.bestStreak >= 30,
  podium: (s) => s.podiums >= 1,
  champion: (s) => s.wins >= 1,
  analyst_10: (s) => s.unlocks >= 10,
  level_10: (s) => levelOf(s.xp).level >= 10,
};

const FIELDS = ['xp', 'predictions', 'exact', 'leaguePoints', 'podiums', 'wins', 'unlocks', 'streak', 'bestStreak'];

/** Seviye L'ye ulaşmak için toplam xp: 50·L·(L−1) → 2: 100, 3: 300, 5: 1000, 10: 4500. */
export function levelOf(xp) {
  let level = 1;
  while (50 * (level + 1) * level <= xp) level++;
  const from = 50 * level * (level - 1);
  const to = 50 * (level + 1) * level;
  return { level, from, to };
}

/** Durum + artışlar → yeni durum ve yeni kazanılan rozetler. */
export function applyProgress(prev, delta) {
  const s = { badges: [], ...prev };
  for (const f of FIELDS) s[f] = Number(s[f] ?? 0);
  for (const [k, v] of Object.entries(delta)) {
    if (FIELDS.includes(k) && Number.isFinite(v)) s[k] += v;
  }
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  const had = new Set(s.badges);
  const earned = Object.entries(BADGES).filter(([id, test]) => !had.has(id) && test(s)).map(([id]) => id);
  s.badges = [...s.badges, ...earned];
  return { stats: s, earned };
}

/** Türkiye saatiyle gün ("2026-10-22"). */
export function trDay(ms) {
  return new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
}

/** Günlük giriş: aynı gün tekrar sayılmaz; dün girdiyse seri artar, değilse 1'den başlar. */
export function checkInDelta(prev, nowMs) {
  const today = trDay(nowMs);
  if (prev?.lastDay === today) return null;
  const yesterday = trDay(nowMs - 86400e3);
  const streak = prev?.lastDay === yesterday ? Number(prev.streak ?? 0) + 1 : 1;
  const bonus = streak % 7 === 0 ? XP.streakBonusPer7 : 0;
  return { delta: { streak: streak - Number(prev?.streak ?? 0), xp: XP.checkIn + bonus }, lastDay: today, streak };
}

export function createProgressStore(db, FieldValue, now = () => Date.now(), rewards = null) {
  const ref = (uid) => db.doc(`user_stats/${uid}`);
  return {
    async add(uid, delta) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(uid));
        const { stats, earned } = applyProgress(snap.exists ? snap.data() : {}, delta);
        tx.set(ref(uid), { ...stats, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return earned;
      });
    },
    async checkIn({ uid }) {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(uid));
        const prev = snap.exists ? snap.data() : {};
        const c = checkInDelta(prev, now());
        if (!c) return { already: true, streak: Number(prev.streak ?? 0), earned: [] };
        const { stats, earned } = applyProgress(prev, c.delta);
        stats.lastDay = c.lastDay;
        tx.set(ref(uid), { ...stats, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { already: false, streak: c.streak, xp: c.delta.xp, earned };
      });
    },
  };
}
