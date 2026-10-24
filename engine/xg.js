// xG (beklenen gol) birleştirme katmanı. Saf fonksiyonlar; henüz analiz motoruna BAĞLI DEĞİL.
//
// Neden bağlı değil: xG kaynağı (lisans ve kapsam) henüz seçilmedi ve geçmiş xG verisiyle backtest yapılmadan
// ana modelin ağırlıkları değiştirilmemeli. Bağlanacağı yer: engine/analysis.js içinde attH/defA çarpanları.
//
// Fikir: gol bazlı hızın yanında xG bazlı hız da vardır. xG daha az gürültülüdür, ama az maçta güvenilmez.
// Bu yüzden iki oran, maç sayısına göre ağırlıklandırılır: çok maç varsa xG, az maç varsa gol bazlı oran daha çok sayılır.

export const XG_PRIOR_MATCHES = 10; // xG'nin tam güvenilir sayılması için gereken yaklaşık maç sayısı

/**
 * Bir takımın maçlarından gol ve xG toplamları.
 * matches: [{ homeId, awayId, homeGoals, awayGoals, homeXg?, awayXg? }] (tamamlanmış maçlar)
 * Dönen: { goalsFor, goalsAgainst, goalsN, xgFor, xgAgainst, xgN }  (xgN: xG verisi olan maç sayısı)
 */
export function teamSplit(matches, teamId) {
  const id = String(teamId);
  const out = { goalsFor: 0, goalsAgainst: 0, goalsN: 0, xgFor: 0, xgAgainst: 0, xgN: 0 };
  for (const m of matches) {
    const home = String(m.homeId) === id;
    const away = String(m.awayId) === id;
    if (!home && !away) continue;
    const gf = home ? m.homeGoals : m.awayGoals;
    const ga = home ? m.awayGoals : m.homeGoals;
    if (!Number.isFinite(gf) || !Number.isFinite(ga)) continue;
    out.goalsFor += gf;
    out.goalsAgainst += ga;
    out.goalsN += 1;
    const xf = home ? m.homeXg : m.awayXg;
    const xa = home ? m.awayXg : m.homeXg;
    if (Number.isFinite(xf) && Number.isFinite(xa)) {
      out.xgFor += xf;
      out.xgAgainst += xa;
      out.xgN += 1;
    }
  }
  return out;
}

/**
 * Hücum çarpanı: takımın maç başı ürettiği hızın lig ortalamasına oranı.
 * Gol ve xG oranları xG maç sayısına göre karıştırılır. xG yoksa yalnızca gol oranı kullanılır.
 * Maç yoksa 1 (nötr) döner.
 */
export function attackMultiplier({ goalsFor, goalsN, xgFor = 0, xgN = 0, leagueAvgGoals, leagueAvgXg = null, prior = XG_PRIOR_MATCHES }) {
  if (!goalsN || !leagueAvgGoals) return 1;
  const goalRatio = goalsFor / goalsN / leagueAvgGoals;
  if (!xgN || !leagueAvgXg) return goalRatio;
  const xgRatio = xgFor / xgN / leagueAvgXg;
  const w = xgN / (xgN + prior);
  return w * xgRatio + (1 - w) * goalRatio;
}
