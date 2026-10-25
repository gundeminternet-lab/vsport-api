// Özel Yorum: model doğruluğu, anlatım dili ve satın alma akışı.
import test from 'node:test';
import assert from 'node:assert/strict';

import { PaidContentService } from '../logic.js';
import { markets } from '../content.js';
import { buildSpecial, halfModel, SPECIAL_TOPICS, SPECIAL_PRICE, SPECIAL_BUNDLE_PRICE, specialPrice, spokenScore } from '../special.js';
import { NOW, FUTURE, makeEspn, makeStore, fixture, finished } from './helpers.js';

const model = { lambdaHome: 1.8, lambdaAway: 1.2, sigma: 0.15 };
const all = () => buildSpecial(SPECIAL_TOPICS, { homeName: 'Galatasaray', awayName: 'Fenerbahçe', model, seed: 'tur_1_1' });

test('fiyat: tek başlık 40, dörtlü paket 120', () => {
  assert.equal(specialPrice(1), SPECIAL_PRICE);
  assert.equal(specialPrice(2), 80);
  assert.equal(specialPrice(3), SPECIAL_BUNDLE_PRICE);
  assert.equal(specialPrice(4), SPECIAL_BUNDLE_PRICE);
  assert.equal(specialPrice(0), 0);
});

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

test('tek başlık 40 token; aynı başlık tekrar ücretsiz; içerik bir kez üretilir', async () => {
  const store = makeStore(300);
  const s = svc(store);
  const r = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners'] });
  assert.equal(r.charged, true);
  assert.equal(r.price, 40);
  assert.equal(store.users.u1.tokens, 260);
  assert.deepEqual(r.topics, ['corners']);
  assert.ok(r.data.corners.headline);

  const again = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners'] });
  assert.equal(again.charged, false);
  assert.equal(store.users.u1.tokens, 260);
  assert.equal(store.specialSaves, 1);

  // İkinci başlık: yalnızca eksik olan için ücret
  const second = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners', 'btts'] });
  assert.equal(second.price, 40);
  assert.equal(store.users.u1.tokens, 220);
  assert.equal(store.specialSaves, 2, 'yalnızca eksik başlık üretilip eklendi');
  assert.deepEqual(Object.keys(second.data), ['corners', 'btts']);
  assert.equal(second.data.corners.headline, r.data.corners.headline, 'aynı rakamlar');
});

test('AI paketi Özel Yorumları kapsar: ücret alınmaz; eski kayıtlı içerik modelsiz olsa da çalışır', async () => {
  const store = makeStore(300);
  const s = svc(store);
  // Model alanı olmayan eski içerik taklidi: önce normal üretilir, sonra model silinir
  await s.unlock({ uid: 'u1', ...fixture, type: 'ai' });
  const key = [...store.contents.keys()][0];
  delete store.contents.get(key).model;
  const tokensBefore = store.users.u1.tokens;
  const r = await s.unlockSpecial({ uid: 'u1', ...fixture, topics: 'all' });
  assert.equal(r.price, 0);
  assert.equal(store.users.u1.tokens, tokensBefore);
  assert.deepEqual(Object.keys(r.data), SPECIAL_TOPICS);
});

test('yetersiz bakiye, başlamış maç, geçersiz başlık ve girişsiz kullanıcı reddedilir', async () => {
  const poor = makeStore(100);
  await assert.rejects(svc(poor).unlockSpecial({ uid: 'u1', ...fixture, topics: 'all' }), (e) => e.code === 'failed-precondition');
  assert.equal(poor.users.u1.tokens, 100);
  assert.equal(poor.specialSaves, 0, 'bakiyesi yetmeyen içerik üretimini tetikleyemez');

  const store = makeStore(500);
  await assert.rejects(svc(store, { now: () => FUTURE + 60000 }).unlockSpecial({ uid: 'u1', ...fixture, topics: ['corners'] }), (e) => e.code === 'failed-precondition');
  await assert.rejects(svc(store).unlockSpecial({ uid: 'u1', ...fixture, topics: ['x'] }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc(store).unlockSpecial({ uid: 'u1', ...fixture, topics: [] }), (e) => e.code === 'invalid-argument');
  await assert.rejects(svc(store).unlockSpecial({ uid: null, ...fixture, topics: ['corners'] }), (e) => e.code === 'permission-denied');
  assert.equal(store.users.u1.tokens, 500);
});

test('açılan başlıklar getSpecial ile gelir; kilitli olanlar gelmez; biten maçta hepsi ücretsiz', async () => {
  const store = makeStore(300);
  const s = svc(store);
  assert.deepEqual((await s.getSpecial({ uid: 'u1', ...fixture })).topics, []);
  await s.unlockSpecial({ uid: 'u1', ...fixture, topics: ['htft'] });
  const got = await s.getSpecial({ uid: 'u1', ...fixture });
  assert.deepEqual(got.topics, ['htft']);
  assert.deepEqual(Object.keys(got.data), ['htft']);

  const after = await s.getSpecial({ uid: 'u1', ...finished });
  assert.deepEqual(after.topics, SPECIAL_TOPICS, 'biten maçta ücretsiz');
  assert.equal(store.users.u1.tokens, 260);
});
