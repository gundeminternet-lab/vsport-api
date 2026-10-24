// Günün Maçı: editörün (ya da yöneticinin) seçtiği, liste başında parlak kartla gösterilen maç.
// Gün başına tek kayıt: featured/{YYYY-MM-DD} (maçın Türkiye saatine göre günü). Uygulama okur, yalnızca sunucu yazar.

import { AppError } from './logic.js';
import { dayKeyTr } from './subscription.js';

const HOUR = 3600e3;
const DAY = 86400e3;
const MAX_NOTE = 140;

/** Kayıt belgesini üretir (saf; test edilebilir). */
export function featuredDoc(match, { editorUid, editorName, note, now }) {
  const text = typeof note === 'string' ? note.trim().replace(/\s+/g, ' ') : '';
  if (text.length > MAX_NOTE) throw new AppError('invalid-argument', `Not en fazla ${MAX_NOTE} karakter olabilir.`);
  return {
    dayKey: dayKeyTr(match.timestamp),
    league: match.league,
    eventId: String(match.id),
    kickoffMs: match.timestamp,
    home: { id: String(match.homeId), name: match.homeName, logo: match.homeLogo ?? null },
    away: { id: String(match.awayId), name: match.awayName, logo: match.awayLogo ?? null },
    note: text || null,
    editorUid,
    editorName: editorName ?? 'Editör',
    setAtMs: now,
  };
}

export function createFeaturedService({ db, FieldValue, Timestamp, paid, now = () => Date.now() }) {
  async function requireEditor(uid) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    const s = await db.doc(`users/${uid}`).get();
    const role = s.exists ? s.get('role') : null;
    if (role !== 'editor' && role !== 'admin') throw new AppError('permission-denied', 'Bu işlem için editör yetkisi gerekli.');
    return s.get('username') ?? s.get('displayName') ?? 'Editör';
  }

  return {
    /** Günün maçını belirle (aynı güne daha önce seçilen varsa değişir). */
    async set({ uid, league, eventId, kickoff, note }) {
      const editorName = await requireEditor(uid);
      paid.validate({ league, eventId, kickoff }, { needType: false });
      const match = await paid.findMatch({ league, eventId, kickoff });
      const t = now();
      if (match.completed) throw new AppError('failed-precondition', 'Biten maç günün maçı seçilemez.');
      if (match.timestamp < t - 3 * HOUR || match.timestamp > t + 8 * DAY) {
        throw new AppError('failed-precondition', 'Günün maçı, önümüzdeki 8 gün içindeki bir maç olmalı.');
      }
      const doc = featuredDoc(match, { editorUid: uid, editorName, note, now: t });
      await db.doc(`featured/${doc.dayKey}`).set({
        ...doc,
        kickoffAt: Timestamp.fromMillis(doc.kickoffMs),
        setAt: FieldValue.serverTimestamp(),
      });
      return { dayKey: doc.dayKey };
    },

    /** O günün seçimini kaldır. */
    async clear({ uid, dayKey }) {
      await requireEditor(uid);
      if (typeof dayKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new AppError('invalid-argument', 'Geçersiz gün.');
      await db.doc(`featured/${dayKey}`).delete();
      return { dayKey };
    },
  };
}
