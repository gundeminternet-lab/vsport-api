// Özel Yorum: model doğruluğu, anlatım dili ve erişim (abonelik ya da maçın AI paketi).
import test from 'node:test';
import assert from 'node:assert/strict';

import { PaidContentService } from '../logic.js';
import { markets } from '../content.js';
import { buildSpecial, halfModel, SPECIAL_TOPICS, spokenScore } from '../special.js';
import { NOW, FUTURE, makeEspn, makeStore, subscribed, fixture, finished } from './helpers.js';

const model = { lambdaHome: 1.8, lambdaAway: 1.2, sigma: 0.15 };
const all = () => buildSpecial(SPECIAL_TOPICS, { homeName: 'Galatasaray', awayName: 'Fenerbahçe', model, seed: 'tur_1_1' });

test('İY/MS dokuzlusu: toplam 1, satır ve sütun toplamları ana modelle aynı', () => {
  const half = halfModel(model);
  const p = markets(model.lambdaHome, model.lambdaAway, model.sigma).p;
  assert.equal(half.grid.length, 9);
  assert.ok(Math.abs(half.grid.reduce((s, g) => s + g.p, 0) - 1) < 1e-6);
  const by = (f) => half.grid.filter(f).reduce((s, g) => s + g.p, 0);
  assert.ok(Math.abs(by((g) => g.ht === '1') - p.iy1) < 1e-4);
  assert.ok(Math.abs(by((g) => g.ht === 'X') - p.iyX) < 1e-4);
  assert.ok(Math.abs(by((g) => g.ft === '1') - p.ms1) < 1e-4);
  assert.ok(Math.abs(by((g) => g.ft === '2') - p.ms2) < 1e-4);
  // Sürpriz sonuçlar nadirdir: 1/2 ve 2/1 en küçük dilimler arasında
  const sorted = [...half.grid].sort((a, b) => a.p - b.p);
  assert.ok(['1/2', '2/1'].includes(sorted[0].key));
});

test('KG var: iki yarıda birden, tek yarıdan ve maç sonu KG var değerinden büyük olamaz', () => {
  for (const [lh, la] of [[1.8, 1.2], [0.6, 0.5], [3, 2.5], [1, 1]]) {
    const h = halfModel({ lambdaHome: lh, lambdaAway: la, sigma: 0.2 });
    assert.ok(h.bttsBoth <= h.bttsHt + 1e-9 && h.bttsBoth <= h.bttsSh + 1e-9 && h.bttsBoth <= h.bttsFt + 1e-9);
    assert.ok(h.bttsHt < h.bttsSh, 'ikinci yarıda daha çok gol beklenir');
  }
  // Çok gollü maçta senaryolar daha olası
  assert.ok(halfModel({ lambdaHome: 3, lambdaAway: 2.5, sigma: 0 }).bttsBoth > halfModel({ lambdaHome: 0.7, lambdaAway: 0.6, sigma: 0 }).bttsBoth);
});

test('dört başlık aynı biçimde üretilir; metinler temiz, bahis dili ve yer tutucu yok', () => {
  const out = all();
  assert.deepEqual(Object.keys(out), SPECIAL_TOPICS);
  for (const t of SPECIAL_TOPICS) {
    const x = out[t];
    assert.equal(x.topic, t);
    assert.ok(x.title && x.headline && x.big && x.speech);
    assert.ok(x.facts.length >= 2 && x.groups.length >= 1 && x.summary.length >= 3);
    for (const g of x.groups) for (const r of g.rows) assert.ok(Number.isInteger(r.pct) && r.pct >= 0 && r.pct <= 100, `${t}: ${r.label}=${r.pct}`);
    const text = [x.headline, x.speech, ...x.summary, x.note ?? ''].join(' ');
    assert.ok(!/\{\w+\}|undefined|NaN|null/.test(text), text);
    assert.ok(!/\b(bahis|kupon|oran)\b/i.test(text), text);
    assert.ok(!/\d\s*-\s*\d/.test(x.speech), `seste rakam-çizgi-rakam olmamalı: ${x.speech}`);
    assert.ok(!/%/.test(x.speech), `seste yüzde işareti olmamalı: ${x.speech}`);
  }
  assert.equal(out.corners.meta.source, 'model');
  assert.match(out.corners.note, /gol modelinden/);
});

test('aynı maç aynı metni, farklı maçlar farklı kalıpları kullanır', () => {
  const run = (seed) => buildSpecial(SPECIAL_TOPICS, { homeName: 'A', awayName: 'B', model, seed });
  assert.deepEqual(run('x1'), run('x1'));
  const heads = new Set();
  for (let i = 0; i < 40; i++) {
    const o = run(`k${i}`);
    heads.add(o.corners.headline.replace(/[\d,]+/g, '#') + o.htscore.headline.replace(/[\d-]+/g, '#') + o.btts.headline.replace(/\d+/g, '#'));
  }
  assert.ok(heads.size >= 4, `çeşitlilik: ${heads.size}`);
});

test('korner verisi varsa veriye dayalı not ve beklenti', () => {
  const corners = { home: 7.2, away: 3.9, source: 'data', nHome: 8, nAway: 7 };
  const c = buildSpecial(['corners'], { homeName: 'A', awayName: 'B', model, corners, seed: 's' }).corners;
  assert.equal(c.meta.source, 'data');
  assert.match(c.note, /korner verisine dayanıyor/);
  assert.equal(c.facts[0].value, '7,2');
  assert.equal(c.facts[2].value, '11,1');
});

test('konuşma biçimi skor okur', () => {
  assert.equal(spokenScore('1-0'), 'bir sıfır');
  assert.equal(spokenScore('0-0'), 'sıfır sıfır');
});

// ---------------------------------------------------------------------------------------------------
// Satın alma akışı
// ---------------------------------------------------------------------------------------------------
const svc = (store, opts = {}) => new PaidContentService({ leagues: ['demo.1'], store, espn: makeEspn(), now: () => NOW, ...opts });

test('abone: başlıklar ücretsiz açılır; aynı başlık tekrar üretilmez, eksik olan eklenir', async () => {
  const store = makeStore({ subscription: subscribed('weekly') });
  const s = svc(store);
  const r = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners'] });
  assert.deepEqual(r.topics, ['corners']);
  assert.ok(r.data.corners.headline);
  assert.equal(r.price, undefined, 'ücret yok');

  await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners'] });
  assert.equal(store.specialSaves, 1);

  const second = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners', 'btts'] });
  assert.equal(store.specialSaves, 2, 'yalnızca eksik başlık üretilip eklendi');
  assert.deepEqual(Object.keys(second.data), ['corners', 'btts']);
  assert.equal(second.data.corners.headline, r.data.corners.headline, 'aynı rakamlar');
});

test('deneme hakkıyla açılan AI paketi Özel Yorumları kapsar; eski kayıtlı içerik modelsiz olsa da çalışır', async () => {
  const store = makeStore();
  const s = svc(store);
  await s.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  const key = [...store.contents.keys()][0];
  delete store.contents.get(key).model;
  const r = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: 'all' });
  assert.deepEqual(Object.keys(r.data), SPECIAL_TOPICS);
  assert.equal(store.users.u1.trialUsed, 1, 'Özel Yorumlar ayrı hak harcamaz');
});

test('abone değil ve paket açık değilse reddedilir; geçersiz başlık ve girişsiz kullanıcı reddedilir', async () => {
  const free = makeStore();
  await assert.rejects(svc(free).unlockSpecial({ uid: 'u1', ...fixture, topics: 'all' }), (e) => e.code === 'subscription-required');
  assert.equal(free.specialSaves, 0, 'yetkisiz kullanıcı içerik üretimini tetikleyemez');

  const store = makeStore({ subscription: subscribed() });
  await assert.rejects(svc(store).unlockSpecial({ uid: 'u1', ...fixture, topics: ['x'] }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc(store).unlockSpecial({ uid: 'u1', ...fixture, topics: [] }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc(store).unlockSpecial({ uid: null, ...fixture, topics: ['corners'] }), (e) => e.code === 'permission-denied');
  // Abone maç başladıktan sonra da açabilir (maç öncesi veriyle)
  const late = await svc(store, { now: () => FUTURE + 60000 }).unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners'] });
  assert.ok(late.data.corners);
});

test('getSpecial: abone her başlığı alır, abone olmayan almaz; biten maçta hepsi ücretsiz', async () => {
  const free = makeStore();
  assert.deepEqual((await svc(free).getSpecial({ uid: 'u1', ...fixture })).topics, []);
  const after = await svc(free).getSpecial({ uid: 'u1', ...finished });
  assert.deepEqual(after.topics, SPECIAL_TOPICS, 'biten maçta ücretsiz');

  const sub = makeStore({ subscription: subscribed() });
  const got = await svc(sub).getSpecial({ uid: 'u1', ...fixture });
  assert.deepEqual(got.topics, SPECIAL_TOPICS);
});

test('ilk yarı skoru: tek skor olarak hep 0-0 değil; favori varsa 1-0/0-1, dengeli ve az gollü maçta 0-0', () => {
  const ht = (lambdaHome, lambdaAway) =>
    buildSpecial(['htscore'], { homeName: 'Ev', awayName: 'Dep', model: { lambdaHome, lambdaAway, sigma: 0.15 }, seed: 'x' }).htscore;
  const fav = ht(2.1, 0.8);
  assert.equal(fav.big, '1 - 0');
  assert.equal(fav.meta.predicted, '1-0');
  assert.equal(fav.bigCaption, 'tahmini ilk yarı skoru');
  assert.equal(ht(0.8, 2.1).meta.predicted, '0-1');
  const even = ht(1.1, 1.1);
  assert.equal(even.meta.predicted, '0-0');
  assert.equal(even.meta.scenario, 'nil');
  // Senaryo tablosu: dört senaryo toplamı ~%100
  const sc = fav.groups.find((g) => g.title === 'İlk yarı senaryoları').rows.reduce((a, r) => a + r.pct, 0);
  assert.ok(sc >= 98 && sc <= 102, String(sc));
  // Tahmin en sık tek skordan farklıysa açıklanır
  if (fav.meta.topScore !== fav.meta.predicted) assert.ok(fav.summary.some((l) => l.includes(`Tek skor olarak en sık görülen ${fav.meta.topScore}`)));
});
