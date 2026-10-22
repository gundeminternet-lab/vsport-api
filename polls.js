// Maç sohbet odasında otomatik anketler: penaltı, kırmızı kart, VAR ve gol iptali anlarında 5 dakikalık oylama.
//   chats/match_{matchKey}/polls/{id}

export const AUTO_POLL_MINUTES = 5;

/** Bildirim türüne göre anket (yoksa null). */
export function autoPollFor(note) {
  const teams = note.title.includes('·') ? note.title.split('·').pop().trim() : '';
  const suffix = teams ? ` (${teams})` : '';
  switch (note.type) {
    case 'penalty':
      return { question: `Penaltı kararı doğru mu?${suffix}`.slice(0, 120), options: ['Doğru', 'Yanlış', 'Emin değilim'] };
    case 'red_card':
      return { question: `Kırmızı kart kararı doğru mu?${suffix}`.slice(0, 120), options: ['Doğru', 'Yanlış', 'Sarı yeterdi'] };
    case 'var':
      return { question: `VAR kararına katılıyor musun?${suffix}`.slice(0, 120), options: ['Katılıyorum', 'Katılmıyorum'] };
    case 'goal_disallowed':
      return { question: `Gol iptali doğru mu?${suffix}`.slice(0, 120), options: ['Doğru', 'Gol geçerliydi'] };
    default:
      return null;
  }
}

export function createPollStore(db, FieldValue, Timestamp, now = () => Date.now()) {
  return {
    async autoPoll({ key, note }) {
      const poll = autoPollFor(note);
      if (!poll) return null;
      const ref = await db.collection(`chats/match_${key}/polls`).add({
        ...poll,
        createdBy: 'system',
        createdByName: 'vSport',
        createdAt: FieldValue.serverTimestamp(),
        closesAt: Timestamp.fromMillis(now() + AUTO_POLL_MINUTES * 60e3),
        auto: true,
      });
      return ref.id;
    },
  };
}
