// Lig geneli takım gücü: bir ligin tüm bitmiş maçlarından, her takım için rakibin kalitesine göre
// düzeltilmiş hücum ve savunma gücü ile ligin gerçek ev sahibi avantajını birlikte kestirir.
//
// Neden gerekli: "bir takım maç başı kaç gol atıyor" sayısı rakibe bağlıdır. Zayıf rakiplere 4-0 atan takım
// güçlü görünür; güçlü rakiplere 1-2 kaybeden takım zayıf görünür. Burada her maç, rakibin savunma/hücum
// gücüne ve oynanan sahaya (ev/deplasman) göre beklenen gole oranlanır, değerler birbirine bağlı olarak
// yinelemeli çözülür (Poisson en çok olabilirlik; az maçı olan takım lig ortalamasına doğru çekilir).
//
//   ev sahibi beklenen golü  = mu * evFaktörü  * hücum[ev]  * savunma[dep]
//   deplasman beklenen golü  = mu * depFaktörü * hücum[dep] * savunma[ev]
//
// hücum 1.00 = lig ortalaması, savunma 1.00 = ortalama; savunma > 1 rakibe fazla gol verir.

import { MODEL } from './config.js';

const DAY = 86400000;

// Bir maçta çok yüksek skorlar (8-0 gibi) takım gücünü tek başına şişirmesin
const soften = (g) => (g > 4 ? 4 + (g - 4) * 0.5 : g);

/**
 * newTeam: ligde yeni olan (çoğunlukla üst ligden düşen değil, alt ligden çıkan) takımlar lig ortalamasına değil, daha
 * zayıf bir merkeze çekilir: { days, att, def }. Takımın bu pencerede ilk maçı son [days] gün içindeyse ve lig
 * verisi bundan çok daha eskiye gidiyorsa takım yeni sayılır. Az maçla güçlü görünen yeni takım şişirilmez.
 */
export function fitRatings(matches, { now = Date.now(), halfLifeDays = MODEL.ratingHalfLifeDays, prior = MODEL.ratingPrior, iterations = 60, maxAgeDays = MODEL.ratingMaxAgeDays, newTeam = MODEL.ratingNewTeam ?? null } = {}) {
  const used = [];
  const seen = new Set();
  let oldest = Infinity;
  for (const m of matches) {
    if (!Number.isFinite(m.homeGoals) || !Number.isFinite(m.awayGoals) || !Number.isFinite(m.timestamp)) continue;
    if (m.timestamp > now || now - m.timestamp > maxAgeDays * DAY) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    used.push({
      h: String(m.homeId),
      a: String(m.awayId),
      gh: soften(m.homeGoals),
      ga: soften(m.awayGoals),
      w: 0.5 ** ((now - m.timestamp) / DAY / halfLifeDays),
      t: m.timestamp,
    });
    if (m.timestamp < oldest) oldest = m.timestamp;
  }
  if (used.length < 20) return null;

  let wSum = 0;
  let gSum = 0;
  for (const m of used) {
    wSum += 2 * m.w;
    gSum += m.w * (m.gh + m.ga);
  }
  const mu = gSum / wSum; // takım başı, maç başı gol

  const teams = new Map();
  const team = (id) => {
    let t = teams.get(id);
    if (!t) teams.set(id, (t = { id, att: 1, def: 1, weight: 0, games: 0, first: Infinity, cAtt: 1, cDef: 1, isNew: false }));
    return t;
  };
  for (const m of used) {
    for (const id of [m.h, m.a]) {
      const t = team(id);
      t.weight += m.w;
      t.games++;
      if (m.t < t.first) t.first = m.t;
    }
  }
  // Ligde yeni takımlar: alt ligden çıkan takımın merkezi daha zayıf; üst ligden düşen takım için center() ayrı merkez verebilir.
  const newActive = Boolean(newTeam) && oldest < now - (newTeam.days + 60) * DAY;
  if (newActive) {
    for (const t of teams.values()) {
      if (t.first > now - newTeam.days * DAY) {
        const c = newTeam.center?.(t.id) ?? newTeam;
        t.isNew = true;
        t.cAtt = c.att;
        t.cDef = c.def;
      }
    }
  }

  let homeF = 1.15;
  let awayF = 0.87;
  const pseudo = prior * mu;
  for (let it = 0; it < iterations; it++) {
    // ev / deplasman faktörleri
    let sh = 0, eh = 0, sa = 0, ea = 0;
    for (const m of used) {
      const A = teams.get(m.h);
      const B = teams.get(m.a);
      sh += m.w * m.gh;
      eh += m.w * mu * A.att * B.def;
      sa += m.w * m.ga;
      ea += m.w * mu * B.att * A.def;
    }
    homeF = sh / eh;
    awayF = sa / ea;

    // her takım için hücum ve savunma (rakibi sabit tutarak)
    const sAtt = new Map(), eAtt = new Map(), sDef = new Map(), eDef = new Map();
    const add = (map, id, v) => map.set(id, (map.get(id) ?? 0) + v);
    for (const m of used) {
      const A = teams.get(m.h);
      const B = teams.get(m.a);
      add(sAtt, m.h, m.w * m.gh);
      add(eAtt, m.h, m.w * mu * homeF * B.def);
      add(sDef, m.h, m.w * m.ga);
      add(eDef, m.h, m.w * mu * awayF * B.att);
      add(sAtt, m.a, m.w * m.ga);
      add(eAtt, m.a, m.w * mu * awayF * A.def);
      add(sDef, m.a, m.w * m.gh);
      add(eDef, m.a, m.w * mu * homeF * A.att);
    }
    let attMean = 0, defMean = 0, wTot = 0;
    for (const t of teams.values()) {
      t.att = (sAtt.get(t.id) + pseudo * t.cAtt) / (eAtt.get(t.id) + pseudo);
      t.def = (sDef.get(t.id) + pseudo * t.cDef) / (eDef.get(t.id) + pseudo);
      attMean += t.att * t.weight;
      defMean += t.def * t.weight;
      wTot += t.weight;
    }
    // Ortalamayı 1'de tut (ölçek kayması olmasın; ev/deplasman faktörleri farkı üstlenir)
    attMean /= wTot;
    defMean /= wTot;
    for (const t of teams.values()) {
      t.att /= attMean;
      t.def /= defMean;
    }
  }

  // Sonuçta ev ve deplasman faktörleri son bir kez ölçeğe göre yeniden hesaplanır
  let sh = 0, eh = 0, sa = 0, ea = 0;
  for (const m of used) {
    const A = teams.get(m.h);
    const B = teams.get(m.a);
    sh += m.w * m.gh;
    eh += m.w * mu * A.att * B.def;
    sa += m.w * m.ga;
    ea += m.w * mu * B.att * A.def;
  }
  // newTeam etkinse ligde hiç maçı olmayan takım (sezonun ilk maçı) yeni takım merkezinden tahmin edilebilir
  return { mu, homeF: sh / eh, awayF: sa / ea, teams, matches: used.length, now, newTeam: newActive ? newTeam : null };
}

/**
 * Takımın bu ligdeki gücü. Takım ligde hiç maç oynamamışsa (yeni sezonun ilk maçı) ve yeni takım ön bilgisi etkinse
 * yeni takım merkezinden bir kayıt döner; aksi halde null.
 */
export function ratedTeam(ratings, id) {
  const t = ratings?.teams.get(String(id));
  if (t) return t;
  const nt = ratings?.newTeam;
  if (!nt) return null;
  const c = nt.center?.(String(id)) ?? nt;
  return { id: String(id), att: c.att, def: c.def, weight: 0, games: 0, isNew: true, missing: true };
}

const enoughData = (T, minWeight, minWeightNew) => Boolean(T) && T.weight >= (T.isNew ? minWeightNew : minWeight);

/**
 * İki takım için bu ligde beklenen goller. Takımlardan biri (ya da ikisi) ligde yeterince maç oynamadıysa null döner
 * ve çağıran eski yönteme geçer. Yeni takımın gücü zayıf merkeze çekildiği için daha az maçla da kullanılabilir.
 */
export function ratingLambdas(ratings, homeId, awayId, { neutral = false, minWeight = MODEL.ratingMinWeight, minWeightNew = MODEL.ratingMinWeightNew ?? minWeight } = {}) {
  if (!ratings) return null;
  const H = ratedTeam(ratings, homeId);
  const A = ratedTeam(ratings, awayId);
  if (!enoughData(H, minWeight, minWeightNew) || !enoughData(A, minWeight, minWeightNew)) return null;
  const hf = neutral ? Math.sqrt(ratings.homeF * ratings.awayF) : ratings.homeF;
  const af = neutral ? hf : ratings.awayF;
  return {
    lh: ratings.mu * hf * H.att * A.def,
    la: ratings.mu * af * A.att * H.def,
    // Ligin bu sahadaki maç başı toplam gol beklentisi (toplam gol çekimi için referans)
    base: ratings.mu * (hf + af),
    effHome: H.weight,
    effAway: A.weight,
    newHome: Boolean(H.isNew),
    newAway: Boolean(A.isNew),
    home: { attack: H.att, defense: H.def },
    away: { attack: A.att, defense: A.def },
    homeAdvantage: ratings.homeF / ratings.awayF,
    leagueRatio: 1,
  };
}

/**
 * Farklı liglerden iki takım (Avrupa kupaları, ulusal kupada farklı basamaklar): her takımın gücü kendi liginin
 * tablosundan; ligler arasındaki fark lig güç katsayılarıyla: λev × r, λdep ÷ r, r = (s_ev / s_dep)^k.
 * Ortalama gol ve ev/deplasman faktörleri iki ligin geometrik ortalaması. Hiçbir ligde bulunamayan takım (ör. amatör
 * kulüp) için çağıran { ratings, team: { att, def }, strength } verebilir.
 *
 * side: { ratings, id, strength, team? }
 */
export function crossRatingLambdas(homeSide, awaySide, { neutral = false, strengthExp = MODEL.leagueStrengthExp, minWeight = MODEL.ratingMinWeight, minWeightNew = MODEL.ratingMinWeightNew ?? minWeight } = {}) {
  if (!homeSide?.ratings || !awaySide?.ratings) return null;
  const pick = (side) => side.team ? { att: side.team.att, def: side.team.def, weight: 0, isNew: true, virtual: true } : ratedTeam(side.ratings, side.id);
  const H = pick(homeSide);
  const A = pick(awaySide);
  const ok = (T) => T?.virtual || enoughData(T, minWeight, minWeightNew);
  if (!ok(H) || !ok(A)) return null;
  const Rh = homeSide.ratings;
  const Ra = awaySide.ratings;
  const mu = Math.sqrt(Rh.mu * Ra.mu);
  const homeF = Math.sqrt(Rh.homeF * Ra.homeF);
  const awayF = Math.sqrt(Rh.awayF * Ra.awayF);
  const hf = neutral ? Math.sqrt(homeF * awayF) : homeF;
  const af = neutral ? hf : awayF;
  const r = (homeSide.strength / awaySide.strength) ** strengthExp;
  return {
    // Lig farkı uygulanmadan önceki (aynı ligdeymiş gibi) beklentiler; çağıran lig oranını en sonda uygular
    lh: mu * hf * H.att * A.def,
    la: mu * af * A.att * H.def,
    base: mu * (hf + af),
    effHome: H.weight,
    effAway: A.weight,
    newHome: Boolean(H.isNew),
    newAway: Boolean(A.isNew),
    virtualHome: Boolean(H.virtual),
    virtualAway: Boolean(A.virtual),
    home: { attack: H.att, defense: H.def },
    away: { attack: A.att, defense: A.def },
    homeAdvantage: homeF / awayF,
    leagueRatio: r,
  };
}
