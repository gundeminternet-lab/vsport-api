// Sosyal: tepkiler, @bahsetme ve bildirimler, yanıtlar, anket, skor düellosu ve sonuçlanması, profil, odalar,
// kendiliğinden kartlar, görevler, topluluklar ve Taraftar Savaşı, oyuncu puanlama, özel mesajlar.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SocialService, SYSTEM_UID } from '../social.js';
import { MissionService } from '../social_missions.js';
import { CommunityService, RatingService, playerKey } from '../social_community.js';
import { DmService } from '../social_dm.js';
import { DUEL, cleanCoupon, cleanPoll, duelResult, extractMentions, missionState, pairOf, warTable, weekOf } from '../social_rules.js';
import { memSocial } from './social_fakes.js';

const NOW = Date.UTC(2026, 10, 11, 9); // Çarşamba 12:00 TSİ
const A = 'userAAAA01';
const B = 'userBBBB02';
const C = 'userCCCC03';
const users = {
  [A]: { username: 'tostcu23', photoURL: 'p' },
  [B]: { username: 'mertcan' },
  [C]: { username: 'asli_gs' },
};

function make({ stats = {} } = {}) {
  let now = NOW;
  const store = memSocial(users, stats);
  const rewards = [];
  const reward = async (uid, r) => {
    rewards.push({ uid, ...r });
    return r;
  };
  const clock = () => now;
  const missions = new MissionService({ store, now: clock, reward });
  const community = new CommunityService({ store, now: clock, reward });
  const social = new SocialService({ store, now: clock, missions, community, reward, brief: async () => ({ club: { name: 'Kuzey Yıldızı' }, creditRank: 38 }) });
  const ratings = new RatingService({ store, now: clock, missions, matchState: async () => 'post' });
  const dm = new DmService({ store, now: clock });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { store, social, missions, community, ratings, dm, rewards, flush, tick: (ms) => (now += ms), at: (ms) => (now = ms) };
}

const MATCH = { league: 'tur.1', eventId: '401', home: 'Galatasaray', away: 'Fenerbahçe', kickoff: new Date(NOW + 6 * 3600e3).toISOString() };

test('kurallar: bahsetme, anket, kupon, düello sonucu, görev sıfırlama, savaş tablosu', () => {
  assert.deepEqual(extractMentions('@mertcan bak @asli_gs, e-posta a@b.com @mertcan'), ['mertcan', 'asli_gs']);
  const p = cleanPoll({ options: ['Evet', 'evet', 'Hayır', ''], hours: 6 }, NOW);
  assert.deepEqual(p.options, ['Evet', 'Hayır']);
  assert.equal(p.closesMs, NOW + 6 * 3600e3);
  assert.equal(cleanPoll({ options: ['tek'] }, NOW), null);
  const c = cleanCoupon({ title: 'Günün', picks: [{ label: 'GS MS 1', odd: 2.1 }, { label: 'KG Var', odd: 1.7 }] });
  assert.equal(c.total, 3.57);
  assert.equal(duelResult({ home: 2, away: 1 }, { home: 2, away: 1 }), 'exact');
  assert.equal(duelResult({ home: 1, away: 0 }, { home: 3, away: 1 }), 'outcome');
  assert.equal(duelResult({ home: 1, away: 1 }, { home: 3, away: 1 }), 'miss');
  const st = missionState({ day: '2026-11-10', d: { post: 1 }, dc: ['post'], streak: { n: 3, last: '2026-11-10' } }, NOW);
  assert.deepEqual(st.d, {});
  assert.equal(st.streak.n, 3);
  assert.equal(missionState({ streak: { n: 3, last: '2026-11-08' } }, NOW).streak.n, 0);
  const t = warTable([{ id: '1', n: 30, hits: 18 }, { id: '2', n: 25, hits: 17 }, { id: '3', n: 5, hits: 5 }]);
  assert.deepEqual(t.map((x) => x.id), ['2', '1', '3']);
  assert.equal(t[2].ranked, false);
  assert.equal(pairOf(B, A), `${A}_${B}`);
});

test('gönderi: bahsedilene bildirim, seviye ve isabet rozeti, tek ek kuralı', async () => {
  const { social, store } = make({ stats: { [A]: { xp: 1000 } } });
  store.profiles.set(A, { n: 10, hits: 7 });
  const p = await social.post({ uid: A, text: 'Bu maç 3-1 biter @mertcan sen ne dersin? #Derbi' });
  assert.equal(p.level, 5);
  assert.equal(p.acc, 70);
  assert.deepEqual(p.tags, ['derbi']);
  assert.deepEqual(p.mentions, [B]);
  const n = store.notifs.get(B)[0];
  assert.equal(n.type, 'mention');
  assert.equal(n.from.username, 'tostcu23');
  assert.equal(store.profiles.get(B).unread, 1);
  await assert.rejects(
    social.post({ uid: B, text: 'iki ek', poll: { options: ['a', 'b'] }, squad: { name: 'X' } }),
    /tek ek/,
  );
});

test('tepkiler: tür değişir, sayılar tutarlı; bildirim gönderi başına tek satırda toplanır', async () => {
  const { social, store, flush } = make();
  const p = await social.post({ uid: A, text: 'Gol!' });
  let r = await social.react({ uid: B, postId: p.id, reaction: 'fire' });
  assert.deepEqual(r.reactions, { fire: 1, goal: 0, wow: 0, lol: 0 });
  r = await social.react({ uid: B, postId: p.id + '', reaction: 'goal' }).catch((e) => e);
  assert.match(String(r.message ?? ''), /yavaş/);
  const later = make();
  const q = await later.social.post({ uid: A, text: 'Merhaba' });
  await later.social.react({ uid: B, postId: q.id, reaction: 'fire' });
  later.tick(1000);
  r = await later.social.react({ uid: B, postId: q.id, reaction: 'goal' });
  assert.deepEqual(r.reactions, { fire: 0, goal: 1, wow: 0, lol: 0 });
  assert.equal(r.likeCount, 1);
  await later.social.react({ uid: C, postId: q.id, reaction: 'lol' });
  const notifs = later.store.notifs.get(A).filter((x) => x.type === 'react');
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].n, 2);
  assert.deepEqual(notifs[0].names, ['asli_gs', 'mertcan']);
  assert.equal(later.store.profiles.get(A).unread, 1);
  later.tick(1000);
  r = await later.social.react({ uid: B, postId: q.id, reaction: null });
  assert.equal(r.likeCount, 1);
  // eski beğeni ucu: alev; var olan farklı tepkiye dokunmaz
  assert.deepEqual(await later.social.like({ uid: C, postId: q.id, like: true }), { liked: true, likeCount: 1 });
  await flush();
  assert.equal(later.store.missions.get(B).d.react, 1);
  assert.equal(later.store.missions.get(A).w.reactsRecv, 2);
  void store;
});

test('yorum ve yanıt: yanıtlanan ve gönderi sahibi bildirim alır, yanıt ilk yoruma bağlanır', async () => {
  const { social, store, tick } = make();
  const p = await social.post({ uid: A, text: 'Derbi' });
  const c1 = await social.comment({ uid: B, postId: p.id, text: '2-2 biter' });
  tick(6e3);
  const c2 = await social.comment({ uid: C, postId: p.id, text: 'katılmıyorum', replyTo: c1.id });
  tick(6e3);
  await social.comment({ uid: A, postId: p.id, text: 'görürüz @mertcan', replyTo: c2.id });
  const list = store.comments.get(p.id);
  assert.equal(list[1].replyTo.id, c1.id);
  assert.equal(list[2].replyTo.id, c1.id);
  assert.equal(list[2].replyTo.username, 'asli_gs');
  const typesA = store.notifs.get(A).map((n) => n.type);
  assert.deepEqual(typesA, ['comment', 'comment']);
  assert.deepEqual(store.notifs.get(C).map((n) => n.type), ['reply']);
  assert.deepEqual(store.notifs.get(B).map((n) => n.type), ['mention', 'reply']);
  assert.equal(store.profiles.get(B).comments, 1);
});

test('anket: bir kez oy, kapanınca oy yok', async () => {
  const { social, tick } = make();
  const p = await social.post({ uid: A, text: 'Haftanın golü?', poll: { options: ['Frikik', 'Rövaşata', 'Vole'], hours: 1 } });
  const v = await social.vote({ uid: B, postId: p.id, option: 1 });
  assert.equal(v.total, 1);
  assert.equal(v.counts['1'], 1);
  const again = await social.vote({ uid: B, postId: p.id, option: 2 });
  assert.equal(again.option, 1);
  await assert.rejects(social.vote({ uid: C, postId: p.id, option: 3 }), /Geçersiz/);
  tick(3600e3 + 1);
  await assert.rejects(social.vote({ uid: C, postId: p.id, option: 0 }), /kapandı/);
});

test('skor düellosu: katılım, kilit, maç sonu ödül (maç başına bir kez, günlük sınır), geçmiş ve bildirim', async () => {
  const { social, store, rewards, at, flush } = make();
  await assert.rejects(social.post({ uid: A, text: 'x', match: MATCH }).then(() => social.post({ uid: A, text: 'düello', match: { ...MATCH, kickoff: new Date(NOW + 60e3).toISOString() }, duel: { home: 1, away: 0 } })), /5 dakika/);
  const fresh = make();
  const p = await fresh.social.post({ uid: A, text: 'Bu maç 3-1 biter', match: MATCH, duel: { home: 3, away: 1 } });
  assert.equal(p.duel.n, 1);
  assert.ok(fresh.store.watched.has('tur_1_401'));
  const j = await fresh.social.duelJoin({ uid: B, postId: p.id, home: 2, away: 2 });
  assert.equal(j.n, 2);
  await assert.rejects(fresh.social.duelJoin({ uid: B, postId: p.id, home: 1, away: 1 }), /kilitli/);
  await fresh.social.duelJoin({ uid: C, postId: p.id, home: 2, away: 1 });
  assert.equal(fresh.store.notifs.get(A).filter((n) => n.type === 'duel_join')[0].n, 2);
  // ikinci gönderide aynı maç: ödül maç başına bir kez
  fresh.tick(21e3);
  const p2 = await fresh.social.post({ uid: B, text: 'rövanş', match: MATCH, duel: { home: 3, away: 1 } });
  await fresh.social.duelJoin({ uid: A, postId: p2.id, home: 3, away: 1 });
  fresh.at(NOW + 6 * 3600e3 + 1);
  await assert.rejects(fresh.social.duelJoin({ uid: C, postId: p2.id, home: 0, away: 0 }), /kapandı/);
  const n = await fresh.social.settleMatch({ key: 'tur_1_401', homeGoals: 3, awayGoals: 1 });
  assert.equal(n, 2);
  await flush();
  const got = fresh.rewards.filter((r) => r.type === 'credits');
  assert.deepEqual(got.map((r) => [r.uid, r.amount]).sort(), [[A, DUEL.exact], [B, DUEL.exact], [C, DUEL.outcome]].sort());
  assert.equal(fresh.store.posts.get(p.id).duel.status, 'done');
  assert.equal(fresh.store.posts.get(p.id).duel.final, '3-1');
  assert.equal(fresh.store.history.get(`${A}/${p.id}`).result, 'exact');
  assert.equal(fresh.store.history.get(`${A}/${p2.id}`).result, 'exact');
  assert.equal(fresh.store.history.get(`${A}/${p2.id}`).reward + fresh.store.history.get(`${A}/${p.id}`).reward, DUEL.exact); // aynı maç ikinci kez ödül yok
  assert.equal(fresh.store.profiles.get(A).duelWins, 2);
  assert.equal(fresh.store.profiles.get(B).duelPlayed, 2);
  assert.equal(fresh.store.notifs.get(C).at(0).type, 'duel_result');
  assert.equal(fresh.store.missions.get(A).w.duelWin, 2);
  assert.equal(fresh.store.profiles.get(A).n, 2); // isabet sayacına işlendi
  assert.equal(fresh.store.week.get(weekOf(NOW)).duel.wins, 2);
  void store;
  void rewards;
  void at;
});

test('düello kredisi günlük sınırı aşmaz', async () => {
  const { missions } = make();
  assert.equal(await missions.duelAllowance(A, 300), 300);
  assert.equal(await missions.duelAllowance(A, 300), 300);
  assert.equal(await missions.duelAllowance(A, 300), 0);
});

test('takip bildirimi, okundu, profil kaydı ve herkese açık profil', async () => {
  const { social, store } = make({ stats: { [B]: { xp: 4600, badges: ['sharp_10'] } } });
  await social.follow({ uid: A, target: B });
  await social.follow({ uid: C, target: B });
  assert.equal(store.notifs.get(B).length, 2);
  await social.notifRead({ uid: B });
  assert.equal(store.profiles.get(B).unread, 0);
  await assert.rejects(social.profileSave({ uid: B, bio: 'x'.repeat(200) }), /en fazla/);
  await social.profileSave({ uid: B, bio: '  Derbileri   kaçırmam ', dmOpen: 'following' });
  const u = await social.user({ uid: A, target: B });
  assert.equal(u.bio, 'Derbileri kaçırmam');
  assert.equal(u.followers, 2);
  assert.equal(u.level.level, 10);
  assert.deepEqual(u.badges, ['sharp_10']);
  assert.equal(u.club.name, 'Kuzey Yıldızı');
  assert.equal(u.creditRank, 38);
  assert.equal(u.dmOpen, 'following');
  await assert.rejects(social.user({ uid: A, target: 'yok_boyle' }), /Geçersiz/);
  await assert.rejects(social.follow({ uid: A, target: SYSTEM_UID }), /Geçersiz/);
});

test('maç odaları: kişi sayısı ve 3 dakika sonra düşme', async () => {
  const { social, tick } = make();
  await social.roomPing({ uid: A, room: 'match_tur_1_401' });
  await social.roomPing({ uid: B, room: 'match_tur_1_401' });
  let r = await social.rooms({ uid: C, rooms: ['match_tur_1_401', 'match_eng_1_9'] });
  assert.equal(r.rooms.match_tur_1_401.n, 2);
  assert.deepEqual(r.rooms.match_tur_1_401.uids.sort(), [A, B].sort());
  assert.equal(r.rooms.match_eng_1_9.n, 0);
  tick(2 * 60e3);
  await social.roomPing({ uid: A, room: 'match_tur_1_401' });
  tick(2 * 60e3);
  r = await social.rooms({ uid: C, rooms: ['match_tur_1_401'] });
  assert.equal(r.rooms.match_tur_1_401.n, 1);
  await assert.rejects(social.roomPing({ uid: A, room: '../x' }), /Geçersiz/);
});

test('kendiliğinden kartlar: büyük ligde gol ve maç sonu (tekrar yok), günün AI maçı anketli ve tahminsiz', async () => {
  const { social, store } = make();
  const summary = { home: { id: '1', name: 'Galatasaray' }, away: { id: '2', name: 'Fenerbahçe' }, score: [2, 1], state: 'in' };
  const raw = { header: { competitions: [{ competitors: [{ homeAway: 'home', team: { logo: 'https://x/gs.png' } }, { homeAway: 'away', team: {} }] }] } };
  const note = { type: 'goal', title: 'GOL', body: "67' Icardi (Galatasaray)" };
  const id = await social.autoNote({ key: 'tur_1_401', note, league: 'tur.1', eventId: '401', summary, raw });
  assert.ok(id);
  const post = store.posts.get(id);
  assert.equal(post.uid, SYSTEM_UID);
  assert.equal(post.auto.minute, "67'");
  assert.equal(post.auto.desc, 'Icardi (Galatasaray)');
  assert.equal(post.match.homeLogo, 'https://x/gs.png');
  assert.equal(await social.autoNote({ key: 'tur_1_401', note, league: 'tur.1', eventId: '401', summary }), null);
  assert.equal(await social.autoNote({ key: 'x_1', note, league: 'tur.2', eventId: '1', summary }), null);
  const ft = await social.autoNote({ key: 'tur_1_401', note: { type: 'full_time' }, league: 'tur.1', eventId: '401', summary });
  assert.equal(store.posts.get(ft).auto.type, 'ft');
  const rows = [
    { key: 'esp_1_7', league: 'esp.1', eventId: '7', home: { name: 'Real Madrid' }, away: { name: 'Barcelona' }, kickoffMs: NOW + 9 * 3600e3, confidence: 78, best: 'kg' },
    { key: 'ned_1_8', league: 'ned.1', eventId: '8', home: { name: 'Ajax' }, away: { name: 'PSV' }, kickoffMs: NOW + 3 * 3600e3, confidence: 90, best: 'ms' },
  ];
  const ai = await social.dailyPick(rows);
  const card = store.posts.get(ai);
  assert.equal(card.auto.type, 'ai');
  assert.equal(card.auto.confidence, 78);
  assert.deepEqual(card.poll.options, ['Real Madrid', 'Beraberlik', 'Barcelona']);
  assert.equal(card.poll.closesMs, NOW + 9 * 3600e3);
  assert.ok(!JSON.stringify(card).includes('"best"'));
  assert.equal(await social.dailyPick(rows), null);
});

test('görevler: sayaç, ödül bir kez, seri 7. günde jeton', async () => {
  const { social, missions, rewards, flush, at } = make();
  await social.post({ uid: A, text: 'ilk gönderi' });
  await flush();
  let st = await missions.state({ uid: A });
  assert.equal(st.daily.find((m) => m.id === 'post').done, true);
  await assert.rejects(missions.claim({ uid: A, id: 'vote' }), /tamamlanmadı/);
  const c = await missions.claim({ uid: A, id: 'post' });
  assert.equal(c.reward.amount, 30);
  assert.equal(c.missions.streak.n, 1);
  await assert.rejects(missions.claim({ uid: A, id: 'post' }), /zaten/);
  // 6 gün daha: her gün bir görev
  for (let d = 1; d <= 6; d++) {
    at(NOW + d * 86400e3);
    await missions.track(A, 'post');
    const r = await missions.claim({ uid: A, id: 'post' });
    if (d === 6) {
      assert.equal(r.missions.streak.n, 7);
      assert.deepEqual(r.streakReward, { type: 'token', pack: 'gumus', amount: 1 });
    } else assert.equal(r.streakReward, null);
  }
  assert.equal(rewards.filter((r) => r.type === 'token').length, 1);
  st = await missions.state({ uid: A });
  assert.equal(st.streak.today, true);
});

test('topluluk: katıl, 7 gün değiştirme sınırı, savaş tablosu, sıram, haftanın tahmincisi, geçen haftanın ödülü', async () => {
  const { community, social, store, rewards, at } = make();
  const gs = { id: '432', name: 'Galatasaray', league: 'tur.1', logo: 'https://x/gs.png' };
  const fb = { id: '436', name: 'Fenerbahçe', league: 'tur.1' };
  await community.join({ uid: A, team: gs });
  await community.join({ uid: B, team: gs });
  await community.join({ uid: C, team: fb });
  await assert.rejects(community.join({ uid: A, team: fb }), /gün sonra/);
  assert.equal(store.communities.get('432').members, 2);
  // GS: 20 tahminde 15 isabet; FB: 20 tahminde 12
  for (let i = 0; i < 20; i++) {
    await community.record({ uid: i % 2 ? A : B, hit: i < 15, exact: i < 3, username: i % 2 ? 'tostcu23' : 'mertcan' });
    await community.record({ uid: C, hit: i < 12, username: 'asli_gs' });
  }
  await social.post({ uid: A, text: 'Topluluk gönderisi #Derbi' });
  assert.deepEqual([...store.posts.values()].at(-1).tags, ['derbi', 'team_432']);
  const st = await community.state({ uid: A });
  assert.equal(st.table[0].id, '432');
  assert.equal(st.table[0].acc, 75);
  assert.equal(st.me.n, 10);
  assert.equal(st.community.members, 2);
  assert.ok(st.top.uid === A || st.top.uid === B);
  assert.ok(st.me.rank >= 1);
  const list = await community.list({ uid: A });
  assert.equal(list.communities[0].id, '432');
  // gelecek hafta: GS kazanmış; tahmin yapan üye jeton alır, bir kez
  at(NOW + 7 * 86400e3);
  const next = await community.state({ uid: A });
  assert.equal(next.lastWinner.id, '432');
  assert.equal(next.prize.eligible, true);
  const r = await community.claim({ uid: A });
  assert.deepEqual(r.reward, { type: 'token', pack: 'altin', amount: 1 });
  await assert.rejects(community.claim({ uid: A }), /zaten/);
  await assert.rejects(community.claim({ uid: C }), /kazanan topluluğun/);
  assert.equal(rewards.filter((x) => x.pack === 'altin').length, 1);
});

test('oyuncu puanlama: taraftara göre ayrı ortalama, puan değişince eski puan düşer, maç başına görev', async () => {
  const { ratings, community, store, flush } = make();
  await community.join({ uid: A, team: { id: '432', name: 'Galatasaray' } });
  const base = { league: 'tur.1', eventId: '401', homeId: '432', awayId: '436' };
  await assert.rejects(ratings.rate({ uid: A, ...base, list: [{ player: 'Icardi', teamId: '999', score: 9 }] }), /Geçerli puan yok/);
  const r = await ratings.rate({ uid: A, ...base, list: [{ player: 'Icardi', teamId: '432', score: 9 }, { player: 'En-Nesyri', teamId: '436', score: 6 }] });
  assert.equal(r.first, true);
  await ratings.rate({ uid: A, ...base, list: [{ player: 'Icardi', teamId: '432', score: 8 }] });
  await ratings.rate({ uid: B, ...base, list: [{ player: 'Icardi', teamId: '432', score: 6 }] });
  const agg = store.ratings.get('tur_1_401');
  const ic = agg.players[playerKey('432', 'Icardi')];
  assert.equal(ic.sum, 14);
  assert.equal(ic.n, 2);
  assert.deepEqual(ic.f['432'], { sum: 8, n: 1 });
  assert.deepEqual(ic.f.x, { sum: 6, n: 1 });
  assert.equal(agg.raters, 2);
  await flush();
  assert.equal(store.profiles.get(A).rated, 1);
  assert.equal(store.missions.get(A).w.rated, 1);
  const pre = new RatingService({ store, matchState: async () => 'pre' });
  await assert.rejects(pre.rate({ uid: C, ...base, list: [{ player: 'Icardi', teamId: '432', score: 7 }] }), /başladıktan/);
});

test('özel mesaj: takip etmeyene istek (en çok 3), yanıt kabul sayılır, engel ve gizlilik', async () => {
  const { dm, store, tick } = make();
  const r1 = await dm.send({ uid: A, to: B, text: 'Derbi için ne diyorsun?' });
  assert.equal(r1.state, 'request');
  for (let i = 0; i < 2; i++) {
    tick(2000);
    await dm.send({ uid: A, to: B, text: `ek ${i}` });
  }
  tick(2000);
  await assert.rejects(dm.send({ uid: A, to: B, text: 'dördüncü' }), /en çok 3/);
  tick(2000);
  const reply = await dm.send({ uid: B, to: A, text: 'Bence beraberlik', attach: { kind: 'duel', postId: 'post1234', match: MATCH, guess: { home: 1, away: 1 } } });
  assert.equal(reply.state, 'active');
  const conv = store.convs.get(pairOf(A, B));
  assert.equal(conv.unread[A], 1);
  await dm.read({ uid: A, pair: pairOf(A, B) });
  assert.equal(store.convs.get(pairOf(A, B)).unread[A], 0);
  tick(2000);
  await dm.send({ uid: A, to: B, text: 'artık serbest' });
  // engel
  await dm.block({ uid: C, target: A });
  tick(2000);
  await assert.rejects(dm.send({ uid: A, to: C, text: 'selam' }), /gönderemezsin/);
  // yalnızca takip ettiklerim
  await store.saveProfile(C, { dmOpen: 'following' });
  await dm.block({ uid: C, target: A, block: false });
  tick(2000);
  await assert.rejects(dm.send({ uid: B, to: C, text: 'selam' }), /yalnızca takip/);
  // red
  tick(2000);
  await dm.send({ uid: C, to: B, text: 'merhaba' });
  await dm.decline({ uid: B, pair: pairOf(B, C) });
  tick(2000);
  await assert.rejects(dm.send({ uid: C, to: B, text: 'tekrar' }), /reddetti/);
  await assert.rejects(dm.read({ uid: A, pair: pairOf(B, C) }), /Geçersiz/);
  await dm.report({ uid: A, kind: 'user', target: C, reason: 'spam' });
  assert.equal(store.reports.length, 1);
});
