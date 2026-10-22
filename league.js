// Tahmin ligi: skor tahminlerini puanlar, haftalık/aylık/tüm zamanlar sıralamasını ve haftalık ödülleri yönetir.
//
//   matches/{matchKey}/scores/{uid}           kullanıcının skor tahmini (uygulama yazar, maç başlayınca kilitlenir)
//   leaderboards/{dönem}/entries/{uid}        puan tablosu (yalnızca sunucu yazar)
//   leaderboards/{hafta}                      { awarded: true } haftalık ödüller dağıtıldı mı
// Dönemler: "w2026-43" (ISO hafta, Türkiye saatiyle), "m2026-10" (ay), "all" (tüm zamanlar).

export const POINTS = { exact: 5, difference: 3, outcome: 2 };
export const WEEKLY_PRIZES = [500, 250, 100];
const TR_OFFSET = 3 * 3600e3; // Türkiye UTC+3 (yaz saati yok)

/** Tahmin puanı: tam skor 5, doğru gol farkı (beraberlik hariç) 3, doğru sonuç 2, diğer 0. */
export function scorePrediction(pred, final) {
  const ph = Number(pred.home), pa = Number(pred.away);
  const fh = Number(final.home), fa = Number(final.away);
  if (![ph, pa, fh, fa].every(Number.isInteger)) return { points: 0, exact: false };
  if (ph === fh && pa === fa) return { points: POINTS.exact, exact: true };
  const sign = (x) => Math.sign(x);
  if (sign(ph - pa) !== sign(fh - fa)) return { points: 0, exact: false };
  if (ph - pa === fh - fa && fh !== fa) return { points: POINTS.difference, exact: false };
  return { points: POINTS.outcome, exact: false };
}

/** ISO hafta numarası (Pazartesi başlar). */
export function isoWeek(ms) {
  const d = new Date(ms);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // haftanın perşembesi
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil(((date - yearStart) / 86400000 + 1) / 7) };
}

/** Maç saatine göre dönem kimlikleri (Türkiye saati). */
export function periodIds(kickoffMs) {
  const local = kickoffMs + TR_OFFSET;
  const { year, week } = isoWeek(local);
  const d = new Date(local);
  return {
    week: `w${year}-${String(week).padStart(2, '0')}`,
    month: `m${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
    all: 'all',
  };
}

/** Bir önceki haftanın kimliği (ödül dağıtımı için). */
export function previousWeekId(nowMs) {
  return periodIds(nowMs - 7 * 86400e3).week;
}

/** Firestore'a yazan kısım. db: Admin Firestore, FieldValue: firebase-admin/firestore. */
export function createLeagueStore(db, FieldValue) {
  return {
    /** Biten maçın tahminlerini puanlar. Maç başladıktan sonra değiştirilen tahminler 0 puan alır (geçersiz). */
    async scoreMatch({ key, homeGoals, awayGoals, kickoffMs }) {
      const periods = periodIds(kickoffMs);
      let scored = 0;
      for (;;) {
        const q = await db.collection(`matches/${key}/scores`).where('scored', '==', false).limit(200).get();
        if (q.empty) break;
        const batch = db.batch();
        for (const doc of q.docs) {
          const p = doc.data();
          const at = p.updatedAt?.toMillis?.() ?? 0;
          const late = !at || at >= kickoffMs;
          const { points, exact } = late ? { points: 0, exact: false } : scorePrediction(p, { home: homeGoals, away: awayGoals });
          batch.update(doc.ref, { scored: true, points, exact, late, final: `${homeGoals}-${awayGoals}`, scoredAt: FieldValue.serverTimestamp() });
          if (late) continue;
          for (const period of Object.values(periods)) {
            batch.set(
              db.doc(`leaderboards/${period}/entries/${doc.id}`),
              {
                uid: doc.id,
                username: p.username ?? null,
                photoURL: p.photoURL ?? null,
                points: FieldValue.increment(points),
                exact: FieldValue.increment(exact ? 1 : 0),
                played: FieldValue.increment(1),
                updatedAt: FieldValue.serverTimestamp(),
              },
              { merge: true },
            );
          }
          scored++;
        }
        await batch.commit();
        if (q.size < 200) break;
      }
      return scored;
    },

    /** Geçen haftanın ilk üçüne token ödülü (bir kez). */
    async awardWeek(weekId, prizes = WEEKLY_PRIZES) {
      const marker = db.doc(`leaderboards/${weekId}`);
      // Tek alanlı sıralama (ek dizin gerekmez); eşitlikte tam skor sayısı belirler.
      const q = await db.collection(`leaderboards/${weekId}/entries`).orderBy('points', 'desc').limit(prizes.length + 10).get();
      const top = q.docs
        .sort((a, b) => (b.get('points') ?? 0) - (a.get('points') ?? 0) || (b.get('exact') ?? 0) - (a.get('exact') ?? 0))
        .slice(0, prizes.length);
      return db.runTransaction(async (tx) => {
        const m = await tx.get(marker);
        if (m.exists && m.data().awarded) return [];
        const winners = [];
        top.forEach((d, i) => {
          if ((d.data().points ?? 0) <= 0) return;
          const amount = prizes[i];
          tx.update(db.doc(`users/${d.id}`), { tokens: FieldValue.increment(amount) });
          tx.create(db.collection(`users/${d.id}/token_ledger`).doc(), {
            delta: amount,
            reason: 'league_prize',
            key: `${weekId}_${i + 1}`,
            at: FieldValue.serverTimestamp(),
          });
          winners.push({ uid: d.id, rank: i + 1, amount, username: d.data().username ?? null, points: d.data().points });
        });
        tx.set(marker, { awarded: true, winners, awardedAt: FieldValue.serverTimestamp() }, { merge: true });
        return winners;
      });
    },
  };
}
