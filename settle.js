// Kupon sonuçlandırma ve editör karnesi.
//   Maçları biten kuponlar sunucuda sonuçlandırılır: coupons/{id}.result
//   Editör istatistikleri: editor_stats/{editorUid}  (tutma oranı, kâr/zarar birimi, seri, son sonuçlar)
// Listeden kaldırılan kuponlar da sayılır (kaybeden kuponu silerek karneyi düzeltmek mümkün olmasın).

import { readSummary } from './notify.js';

/** Maç özeti → sonuç bilgileri (İY skoru dahil). */
export function matchFacts(json) {
  const s = readSummary(json);
  const comp = json?.header?.competitions?.[0] ?? {};
  const postponed = s.state === 'post' && !s.completed;
  let ht = null;
  const cs = comp.competitors ?? [];
  const home = cs.find((c) => c.homeAway === 'home');
  const away = cs.find((c) => c.homeAway === 'away');
  const ls = (c) => {
    const v = c?.linescores?.[0];
    const n = Number(typeof v === 'object' && v !== null ? v.value ?? v.displayValue : v);
    return Number.isFinite(n) ? n : null;
  };
  if (ls(home) !== null && ls(away) !== null) {
    ht = [ls(home), ls(away)];
  } else if (s.completed) {
    // Gol olaylarından: "45'+2'" ilk yarı, 46' ve sonrası ikinci yarı
    let h = 0, a = 0, any = false;
    for (const e of json?.keyEvents ?? []) {
      const t = String(e.type?.text ?? '').toLowerCase();
      const goal = e.scoringPlay === true || t.startsWith('goal') || t.includes('own goal') || (t.includes('penalty') && t.includes('scored'));
      if (!goal || e.shootout) continue;
      any = true;
      const minute = parseInt(String(e.clock?.displayValue ?? ''), 10);
      if (!Number.isFinite(minute) || minute > 45) continue;
      if (String(e.team?.id) === s.home.id) h++;
      else if (String(e.team?.id) === s.away.id) a++;
    }
    if (any || s.score[0] + s.score[1] === 0) ht = [h, a];
  }
  return { completed: s.completed, postponed, home: s.score[0], away: s.score[1], ht };
}

/** Tek tahmin: true (tuttu), false (yattı), null (karar verilemedi — İY bilgisi yok gibi). */
export function settleMarket(market, f) {
  const { home: h, away: a, ht } = f;
  const total = h + a;
  const res = h > a ? '1' : h === a ? 'X' : '2';
  const htRes = ht ? (ht[0] > ht[1] ? '1' : ht[0] === ht[1] ? 'X' : '2') : null;
  const m = market.trim();
  let x;
  if ((x = /^MS ([1X2])$/.exec(m))) return res === x[1];
  if ((x = /^Çifte şans ([1X2])-([1X2])$/.exec(m))) return res === x[1] || res === x[2];
  if (m === 'KG Var') return h > 0 && a > 0;
  if (m === 'KG Yok') return !(h > 0 && a > 0);
  if ((x = /^İY (\d\.5) (Üst|Alt)$/.exec(m))) {
    if (!ht) return null;
    const line = Number(x[1]);
    return x[2] === 'Üst' ? ht[0] + ht[1] > line : ht[0] + ht[1] < line;
  }
  if ((x = /^(\d\.5) (Üst|Alt)$/.exec(m))) {
    const line = Number(x[1]);
    return x[2] === 'Üst' ? total > line : total < line;
  }
  if ((x = /^İY ([1X2])$/.exec(m))) return htRes === null ? null : htRes === x[1];
  if ((x = /^İY\/MS ([1X2])\/([1X2])$/.exec(m))) return htRes === null ? null : htRes === x[1] && res === x[2];
  return null;
}

function combinations(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) return out.push([...acc]);
    for (let i = start; i < n; i++) {
      acc.push(i);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}

/**
 * Kupon sonucu. results: her seçim için 'won' | 'lost' | 'void' (ertelenen maç: oran 1 sayılır).
 * Birim: kupona toplam 1 birim yatırıldığı varsayılır (sistemde kombinasyonlara eşit bölünür).
 */
export function couponOutcome({ odds, results, system = false, sizes = [] }) {
  const ok = (i) => results[i] === 'won' || results[i] === 'void';
  const odd = (i) => (results[i] === 'void' ? 1 : odds[i]);
  let combos;
  if (!system) combos = [odds.map((_, i) => i)];
  else combos = [...new Set(sizes)].filter((k) => k >= 1 && k <= odds.length).flatMap((k) => combinations(odds.length, k));
  if (!combos.length) return { status: 'lost', returnUnits: 0, profit: -1, winningCombos: 0, combos: 0 };
  let ret = 0, wins = 0;
  for (const c of combos) {
    if (c.every(ok)) {
      wins++;
      ret += c.reduce((p, i) => p * odd(i), 1) / combos.length;
    }
  }
  const r = Math.round(ret * 100) / 100;
  const status = r > 1 ? 'won' : r > 0 ? 'partial' : 'lost';
  return { status, returnUnits: r, profit: Math.round((r - 1) * 100) / 100, winningCombos: wins, combos: combos.length };
}

/** Karne güncellemesi (saf). */
export function applyReport(prev, outcome, avgOdd) {
  const s = { settled: 0, won: 0, partial: 0, lost: 0, profitUnits: 0, oddsSum: 0, streak: 0, bestStreak: 0, recent: [], ...prev };
  s.settled += 1;
  s[outcome.status] += 1;
  s.profitUnits = Math.round((s.profitUnits + outcome.profit) * 100) / 100;
  s.oddsSum = Math.round((s.oddsSum + avgOdd) * 100) / 100;
  s.streak = outcome.status === 'won' ? s.streak + 1 : 0;
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  s.recent = [...s.recent, outcome.status === 'won' ? 'W' : outcome.status === 'partial' ? 'P' : 'L'].slice(-10);
  return s;
}

export class CouponSettler {
  /**
   * store: { listUnsettled(fromMs, toMs), getPicks(id), saveResult(id, coupon, result, report) }
   * espn: getSummary(league, eventId, {maxAgeMs})
   */
  constructor({ store, espn, now = () => Date.now(), log = console }) {
    this.store = store;
    this.espn = espn;
    this.now = now;
    this.log = log;
  }

  async run() {
    const now = this.now();
    const coupons = await this.store.listUnsettled(now - 10 * 86400e3, now - 100 * 60e3);
    let settled = 0;
    for (const c of coupons) {
      try {
        if (await this.settleOne(c, now)) settled++;
      } catch (e) {
        this.log.error?.(`[settle] ${c.id}: ${e?.message ?? e}`);
      }
    }
    return settled;
  }

  async settleOne(coupon, now) {
    const picks = await this.store.getPicks(coupon.id);
    const sel = picks?.selections ?? [];
    if (!sel.length) return false;
    const results = [];
    for (const s of sel) {
      const kickoff = Date.parse(s.kickoff);
      if (!Number.isFinite(kickoff) || kickoff + 100 * 60e3 > now) return false; // henüz bitmemiş olabilir
      let facts;
      try {
        facts = matchFacts(await this.espn.getSummary(s.league, s.eventId, { maxAgeMs: 10 * 60e3 }));
      } catch {
        return false;
      }
      if (facts.postponed) {
        results.push('void');
        continue;
      }
      if (!facts.completed) {
        // 1 günden uzun süredir bitmediyse (iptal/bilinmiyor) geçersiz say
        if (now - kickoff > 86400e3) {
          results.push('void');
          continue;
        }
        return false;
      }
      const r = settleMarket(String(s.market ?? ''), facts);
      results.push(r === null ? 'void' : r ? 'won' : 'lost');
    }
    const odds = sel.map((s) => Number(s.odd) || 1);
    const outcome = couponOutcome({ odds, results, system: coupon.type === 'system', sizes: coupon.systemSizes ?? [] });
    const avgOdd = odds.reduce((a, b) => a + b, 0) / odds.length;
    await this.store.saveResult(coupon.id, coupon, { ...outcome, results, settledAt: now }, (prev) => applyReport(prev, outcome, avgOdd));
    return true;
  }
}

export function createSettleStore(db, FieldValue) {
  return {
    async listUnsettled(fromMs, toMs) {
      const q = await db
        .collection('coupons')
        .where('firstKickoffAt', '>=', new Date(fromMs))
        .where('firstKickoffAt', '<=', new Date(toMs))
        .limit(300)
        .get();
      return q.docs.filter((d) => !d.get('result')).map((d) => ({ id: d.id, ...d.data() }));
    },
    async getPicks(id) {
      const s = await db.doc(`coupons/${id}/private/picks`).get();
      return s.exists ? s.data() : null;
    },
    /** Kupon sonucu ve karne aynı işlemde (iki kez sayılmaz). */
    async saveResult(id, coupon, result, nextReport) {
      const couponRef = db.doc(`coupons/${id}`);
      const statsRef = db.doc(`editor_stats/${coupon.editorUid}`);
      await db.runTransaction(async (tx) => {
        const [c, st] = await Promise.all([tx.get(couponRef), tx.get(statsRef)]);
        if (!c.exists || c.get('result')) return;
        tx.update(couponRef, { result: { ...result, settledAt: FieldValue.serverTimestamp() } });
        tx.set(statsRef, { ...nextReport(st.exists ? st.data() : {}), editorName: coupon.editorName ?? null, editorPhoto: coupon.editorPhoto ?? null, updatedAt: FieldValue.serverTimestamp() });
      });
    },
  };
}
