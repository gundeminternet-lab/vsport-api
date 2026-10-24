// Haftalık bülten: kullanıcının takip ettiği takımlar için son 7 günün sonuçları ve önümüzdeki 7 günün maçları.
// Bülten kişiseldir ama bildirim değildir: uygulama açıldığında istemci ister (anlık bildirim token'ı tutulmaz).
//
// buildBulletin saf fonksiyondur (test edilir). BulletinService ESPN ve Firestore'dan veriyi toplar.

const DAY = 24 * 3600e3;
const MAX_ITEMS = 10;
const MAX_TEAMS = 15;

/** Takım takibi anahtarı, istemcideki FollowedTeam.key ile aynı biçimde: "tur_1_123". */
export const teamKey = (league, teamId) => `${String(league ?? '').replace(/[^a-zA-Z0-9]/g, '_')}_${teamId}`;

/**
 * Bülten verisini kurar.
 * teams:    [{ league, teamId, name }]  takip edilen takımlar
 * fixtures: [{ id, league, timestamp, homeId, homeName, awayId, awayName, completed, homeGoals?, awayGoals? }]
 * now:      ms
 * Dönen: { followed, upcoming: [...], results: [...], headline }
 */
export function buildBulletin({ teams = [], fixtures = [], now = Date.now() }) {
  const keys = new Set(teams.map((t) => teamKey(t.league, t.teamId)));
  const names = new Map(teams.map((t) => [teamKey(t.league, t.teamId), t.name]));
  const followedIn = (f) => (keys.has(teamKey(f.league, f.homeId)) ? f.homeId : keys.has(teamKey(f.league, f.awayId)) ? f.awayId : null);

  const mine = fixtures.filter((f) => followedIn(f) !== null && Number.isFinite(f.timestamp));

  const upcoming = mine
    .filter((f) => !f.completed && f.timestamp >= now && f.timestamp <= now + 7 * DAY)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, MAX_ITEMS)
    .map((f) => ({ id: f.id, league: f.league, kickoff: new Date(f.timestamp).toISOString(), home: f.homeName, away: f.awayName }));

  const results = mine
    .filter((f) => f.completed && Number.isFinite(f.homeGoals) && Number.isFinite(f.awayGoals) && f.timestamp <= now && f.timestamp >= now - 7 * DAY)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_ITEMS)
    .map((f) => {
      // Sonuç, takip edilen takımın bakışıyla: 'W' galibiyet, 'D' beraberlik, 'L' mağlubiyet.
      const home = followedIn(f) === f.homeId;
      const ownGoals = home ? f.homeGoals : f.awayGoals;
      const rivalGoals = home ? f.awayGoals : f.homeGoals;
      const outcome = ownGoals > rivalGoals ? 'W' : ownGoals < rivalGoals ? 'L' : 'D';
      return {
        id: f.id,
        league: f.league,
        kickoff: new Date(f.timestamp).toISOString(),
        home: f.homeName,
        away: f.awayName,
        scoreLine: `${f.homeGoals}-${f.awayGoals}`,
        outcome,
        followedName: names.get(teamKey(f.league, followedIn(f))) ?? null,
      };
    });

  let headline;
  if (!teams.length) headline = 'Henüz takip ettiğin bir takım yok. Takım takibi açınca haftalık özetin burada olacak.';
  else if (!upcoming.length && !results.length) headline = 'Bu hafta takip ettiklerinin maçı yok.';
  else headline = `${upcoming.length} yaklaşan, ${results.length} tamamlanmış maç.`;

  return { followed: teams.length, upcoming, results, headline };
}

/** Takip edilen takımların maçlarını ESPN'den çeker; lig başına tek fikstür çağrısı yapar. */
export class BulletinService {
  constructor({ espn, db, now = () => Date.now(), cacheMs = 30 * 60e3 }) {
    this.espn = espn;
    this.db = db;
    this.now = now;
    this.cacheMs = cacheMs;
    this._cache = new Map();
  }

  async follows(uid) {
    const snap = await this.db.collection('users').doc(uid).collection('follows').get();
    return snap.docs
      .map((d) => d.data())
      .filter((t) => t?.league && t?.teamId)
      .slice(0, MAX_TEAMS)
      .map((t) => ({ league: String(t.league), teamId: String(t.teamId), name: String(t.name ?? '') }));
  }

  async get({ uid } = {}) {
    if (!uid) throw Object.assign(new Error('Giriş yapmalısınız.'), { code: 'permission-denied' });
    const now = this.now();
    const hit = this._cache.get(uid);
    if (hit && now - hit.at < this.cacheMs) return hit.value;

    const teams = await this.follows(uid);
    let fixtures = [];
    if (teams.length) {
      const leagues = [...new Set(teams.map((t) => t.league))];
      const from = new Date(now - 7 * DAY);
      const to = new Date(now + 7 * DAY);
      // Bir ligin fikstürü alınamazsa diğer ligler yine de gösterilir.
      const settled = await Promise.allSettled(leagues.map((l) => this.espn.getFixtures(l, from, to)));
      fixtures = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    }
    const value = buildBulletin({ teams, fixtures, now });
    this._cache.set(uid, { at: now, value });
    return value;
  }
}
