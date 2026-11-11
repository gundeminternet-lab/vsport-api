// Sosyal görevler: günlük (paylaş, oy ver, tepki bırak, yorum yap) ve haftalık (düello kazan, tepki topla, oyuncu
// puanla) görevler, günlük seri (7. gün Gümüş Paket jetonu) ve skor düellosu kredisinin günlük üst sınırı.
// Ödüller yalnızca kazanılır (kredi satın alınmaz, ortaya konmaz).
//
//   social_missions/{uid}  { day, d: { post, vote, react, comment }, dc: [alınan], week, w: { duelWin, reactsRecv, rated },
//                            wc: [alınan], streak: { n, last }, duelCredits: { day, amt } }

import { AppError } from './errors.js';
import { DUEL, MISSIONS, missionState, missionView } from './social_rules.js';

const DAILY = new Set(MISSIONS.daily.map((m) => m.id));
const WEEKLY = new Set(MISSIONS.weekly.map((m) => m.id));

const pack = (st) => ({ day: st.day, d: st.d, dc: st.dc, week: st.week, w: st.w, wc: st.wc, streak: st.streak, duelCredits: { day: st.day, amt: st.duelCredits } });

export class MissionService {
  /** reward: async (uid, ödül) → verilen ödül (kredi ya da paket jetonu). */
  constructor({ store, now = () => Date.now(), reward = null, log = console }) {
    this.store = store;
    this.now = now;
    this.reward = reward;
    this.log = log;
  }

  /** Sayaç artırır (gün/hafta değiştiyse önce sıfırlanır). */
  async track(uid, kind, n = 1) {
    if (!uid || !(n > 0) || (!DAILY.has(kind) && !WEEKLY.has(kind))) return null;
    return this.store.mutateMissions(uid, (doc) => {
      const st = missionState(doc, this.now());
      const bag = DAILY.has(kind) ? st.d : st.w;
      bag[kind] = Number(bag[kind] ?? 0) + n;
      return { doc: pack(st), result: bag[kind] };
    });
  }

  async weekCount(uid, kind) {
    const st = missionState(await this.store.getMissions(uid), this.now());
    return Number(st.w[kind] ?? 0);
  }

  /** Düello kredisi: günlük üst sınıra kadar verilir; verilebilecek miktarı döner ve sayaca işler. */
  async duelAllowance(uid, amount) {
    return this.store.mutateMissions(uid, (doc) => {
      const st = missionState(doc, this.now());
      const give = Math.max(0, Math.min(amount, DUEL.dailyCap - st.duelCredits));
      st.duelCredits += give;
      return { doc: give > 0 ? pack(st) : null, result: give };
    });
  }

  async state({ uid, guest = false }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Görevler için Google ile giriş yap.');
    return missionView(missionState(await this.store.getMissions(uid), this.now()));
  }

  /** Tamamlanan görevin ödülünü alır. Günlük görevde seri işlenir; 7. günde seri ödülü de verilir. */
  async claim({ uid, guest = false, id }) {
    if (!uid) throw new AppError('permission-denied', 'Giriş yapmalısınız.');
    if (guest) throw new AppError('unauthenticated', 'Görevler için Google ile giriş yap.');
    const daily = MISSIONS.daily.find((m) => m.id === id);
    const weekly = MISSIONS.weekly.find((m) => m.id === id);
    const m = daily ?? weekly;
    if (!m) throw new AppError('invalid-argument', 'Geçersiz görev.');
    const out = await this.store.mutateMissions(uid, (doc) => {
      const st = missionState(doc, this.now());
      const counts = daily ? st.d : st.w;
      const claimed = daily ? st.dc : st.wc;
      if (claimed.includes(id)) return { doc: null, result: 'claimed' };
      if (Number(counts[id] ?? 0) < m.target) return { doc: null, result: 'todo' };
      claimed.push(id);
      let streakDone = false;
      if (daily && st.streak.last !== st.day) {
        st.streak = { n: st.streak.n + 1, last: st.day };
        streakDone = st.streak.n % MISSIONS.streak.days === 0;
      }
      return { doc: pack(st), result: { st, streakDone } };
    });
    if (out === 'claimed') throw new AppError('failed-precondition', 'Bu ödülü zaten aldın.');
    if (out === 'todo') throw new AppError('failed-precondition', 'Görev henüz tamamlanmadı.');
    const give = async (r) => {
      if (!this.reward) return r;
      try {
        return (await this.reward(uid, r)) ?? r;
      } catch (e) {
        this.log.warn?.('[missions] ödül verilemedi', e?.message ?? e);
        return null;
      }
    };
    const reward = await give(m.reward);
    const streakReward = out.streakDone ? await give(MISSIONS.streak.reward) : null;
    return { id, reward, streakReward, missions: missionView(out.st) };
  }
}

export function createMissionStore(db) {
  const ref = (uid) => db.doc(`social_missions/${uid}`);
  return {
    async getMissions(uid) {
      const s = await ref(uid).get();
      return s.exists ? s.data() : null;
    },
    /** fn(doc) → { doc: yeni belge | null (yazma), result }. */
    async mutateMissions(uid, fn) {
      return db.runTransaction(async (tx) => {
        const s = await tx.get(ref(uid));
        const { doc, result } = fn(s.exists ? s.data() : null);
        if (doc) tx.set(ref(uid), doc);
        return result;
      });
    },
  };
}
