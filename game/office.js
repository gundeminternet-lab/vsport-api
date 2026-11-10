// Kulüp yönetimi (menajer modu): başkan, taraftar ve medya ile ilişkiler; maç günü gelirleri ve bilet fiyatı;
// sakatlık, kırmızı kart cezası ve kadro dışı; transfer teklifleri; kulübün mesaj kutusu (SMS); maç sonu basın
// toplantısı; yönetimden transfer bütçesi ve taraftardan destek talebi. Bütün tutarlar oyun içi kredidir
// (krediler satın alınamaz; yalnızca oyunla kazanılır).
//
//   game_profiles/{uid}.club.office = {
//     rel: { board, fans, media }                 0-100
//     ticket                                      bilet fiyatı (oyun içi ₺)
//     inbox: [{ id, at, from, text, read, act? }]  en yeni başta, en çok 30
//     absent: { kartId: { type, left, name, note } }  type: injury | red | dropped; left: kalan kariyer maçı
//     press: { id, at, result, score, opp, q, options, answered? } | null
//     matchday: { ... son ev maçının gelirleri } | null
//     asks: { board, fans }                       son talep zamanları (ms)
//     warned                                      başkanın son uyarısı gönderildi mi
//     seq                                         mesaj sayacı
//   }
//   Sakat, cezalı ve kadro dışı oyuncular kariyer maçlarında oynayamaz; her kariyer maçından sonra süre bir azalır.

import { AppError } from '../errors.js';
import { createRng } from '../engine/rng.js';
import { effectsOf, fanCount } from './club.js';
import { SELL_PRICE } from './economy.js';
import { tierOf } from './pool.js';
import { hashStr, staffLevels } from './staff.js';
import { geneticsOf } from './genetics.js';

export const REL_KEYS = ['board', 'fans', 'media'];
export const REL_NAMES = { board: 'Başkan', fans: 'Taraftar', media: 'Medya' };
export const REL_START = { board: 60, fans: 60, media: 50 };

/** Bilet: oyun içi ₺. fair: ligin olağan bilet fiyatı (Amatör → Süper Lig). */
export const TICKET = { min: 20, max: 600, step: 10, fair: [60, 90, 130, 180, 250] };

/** Maç günü gelir katsayıları (kredi). */
export const MATCHDAY = {
  /** Gişe: seyirci × bilet / gateDiv kredi. */
  gateDiv: 2500,
  /** Otopark: yer = 400 + 400 (seviye − 1); araçla gelen seyirci oranı; araç başına kredi. */
  parkBase: 400,
  parkStep: 400,
  carShare: 0.3,
  perCar: 0.05,
  /** Yeme-içme: kişi başı harcama (kredi) = 0.008 + 0.003 (seviye − 1). */
  foodBase: 0.008,
  foodStep: 0.003,
  /** Forma mağazası: seyirci başına satış = 0.004 + 0.0015 (seviye − 1); galibiyette ×1.3. */
  shirtBase: 0.004,
  shirtStep: 0.0015,
};

export const ASK = {
  boardCooldown: 3 * 86400e3,
  fansCooldown: 7 * 86400e3,
  /** Yönetim bu güvenin altında bütçe vermez. */
  boardMin: 55,
  /** Taraftar desteği yalnızca kulüp zor durumdayken (kredi bu tutarın altında) istenebilir. */
  fansNeedBelow: 1500,
  fansMin: 25,
};

export const INBOX_MAX = 30;
const OFFER_DAYS = 3;

export const clampRel = (v) => Math.max(0, Math.min(100, Math.round(Number(v))));

/** İlişkinin sözle karşılığı. */
export function relMood(v) {
  const x = Number(v);
  if (x >= 80) return 'Çok iyi';
  if (x >= 60) return 'İyi';
  if (x >= 40) return 'Orta';
  if (x >= 20) return 'Gergin';
  return 'Kriz';
}

/** Bilet fiyatını sınırlar içine ve adıma oturtur. */
export function checkTicket(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new AppError('invalid-argument', 'Geçersiz bilet fiyatı.');
  return Math.max(TICKET.min, Math.min(TICKET.max, Math.round(v / TICKET.step) * TICKET.step));
}

export const fairTicket = (div) => TICKET.fair[Math.max(0, Math.min(TICKET.fair.length - 1, Number(div) || 0))];

/**
 * Seyirci (saf): talep taraftar sayısına, taraftarın ruh haline ve forma; doluluk bilet fiyatına bağlıdır.
 * Olağan fiyatın 2 katında tribünler neredeyse boştur.
 */
export function attendanceOf({ capacity, supporters, fans = 60, price, div = 0, form = 0 }) {
  const x = Number(price) / fairTicket(div);
  const priceK = 1.15 / (1 + Math.exp((x - 1.35) * 4));
  const moodK = 0.6 + (0.8 * clampRel(fans)) / 100;
  const formK = 1 + 0.04 * Math.max(-3, Math.min(3, Number(form) || 0));
  const demand = Number(supporters) * 1.6 * moodK * formK;
  return Math.max(0, Math.round(Math.min(Number(capacity), demand * priceK)));
}

/** Maç günü gelirleri (saf): gişe, otopark, yeme-içme, forma mağazası. levels: tesis seviyeleri. */
export function matchdayIncome({ attendance, price, levels = {}, fans = 60, win = false }) {
  const lv = (f) => Math.max(1, Math.min(10, Number(levels[f] ?? 1)));
  const A = Math.max(0, Number(attendance));
  const moodK = 0.6 + (0.8 * clampRel(fans)) / 100;
  const spaces = MATCHDAY.parkBase + MATCHDAY.parkStep * (lv('parking') - 1);
  const cars = Math.round(A * MATCHDAY.carShare);
  const parked = Math.min(cars, spaces);
  const gate = Math.round((A * Number(price)) / MATCHDAY.gateDiv);
  const parking = Math.round(parked * MATCHDAY.perCar);
  const food = Math.round(A * (MATCHDAY.foodBase + MATCHDAY.foodStep * (lv('food') - 1)));
  const shirts = Math.round(A * (MATCHDAY.shirtBase + MATCHDAY.shirtStep * (lv('megastore') - 1)) * moodK * (win ? 1.3 : 1));
  return { gate, parking, food, shirts, total: gate + parking + food + shirts, cars, spaces, parked };
}

/** Sonuca göre ilişki değişimi (saf). margin: gol farkı (kulübün gözünden), stronger: rakip daha güçlü müydü. */
export function resultDeltas(result, margin = 0, stronger = false) {
  const base = result === 'W' ? { board: 3, fans: 4, media: 2 } : result === 'D' ? { board: 0, fans: 1, media: 0 } : { board: -3, fans: -4, media: -2 };
  const k = Math.abs(margin) >= 3 ? 1.5 : 1;
  const out = Object.fromEntries(REL_KEYS.map((r) => [r, Math.round(base[r] * k)]));
  if (stronger && result === 'W') {
    out.fans += 1;
    out.board += 1;
  }
  if (stronger && result === 'D') out.fans += 1;
  return out;
}

/** Bilet fiyatının taraftara etkisi (her ev maçında): ucuz bilet sevindirir, pahalı bilet kızdırır. */
export function ticketMood(price, div) {
  const x = Number(price) / fairTicket(div);
  if (x <= 0.7) return 2;
  if (x <= 1.05) return 0;
  if (x <= 1.4) return -1;
  if (x <= 1.8) return -3;
  return -5;
}

// ---------------------------------------------------------------------------------------------------------------
// Basın toplantısı
// ---------------------------------------------------------------------------------------------------------------

/** Soru türü: büyük galibiyet, galibiyet, beraberlik, mağlubiyet, ağır mağlubiyet. */
export function pressKind(my, opp) {
  const d = Number(my) - Number(opp);
  if (d >= 3) return 'bigwin';
  if (d > 0) return 'win';
  if (d === 0) return 'draw';
  if (d <= -3) return 'bigloss';
  return 'loss';
}

/** Gazeteciler ve soruları; cevapların ilişkilere etkisi. {opp}: rakip, {score}: skor. */
export const PRESS = {
  bigwin: {
    q: ['{opp} karşısında {score}! Bu skoru bekliyor muydunuz?', 'Farklı bir galibiyet: takımın bu performansı nereden geliyor?'],
    options: [
      { id: 'fans', text: 'Bu galibiyet tribündeki her taraftarımızın. Onlar için oynadık.', d: { fans: 4, media: 1, board: 0 } },
      { id: 'team', text: 'Oyuncularım planı harfiyen uyguladı; övgüyü onlar hak ediyor.', d: { fans: 1, media: 3, board: 1 } },
      { id: 'calm', text: 'Ayaklarımız yere basmalı; daha önümüzde çok maç var.', d: { fans: 0, media: 1, board: 3 } },
    ],
  },
  win: {
    q: ['{opp} karşısında {score} kazandınız. Galibiyetin anahtarı neydi?', 'Zor bir maçtan üç puanla çıktınız; neler söylemek istersiniz?'],
    options: [
      { id: 'team', text: 'Takım ruhu kazandırdı. Oyuncularımı tebrik ediyorum.', d: { fans: 1, media: 2, board: 1 } },
      { id: 'fans', text: 'Taraftarımız bizi ayakta tuttu; üç puan onlara armağan olsun.', d: { fans: 3, media: 0, board: 0 } },
      { id: 'calm', text: 'İyi oynamadık ama kazanmayı bildik. Düzeltmemiz gereken çok şey var.', d: { fans: -1, media: 1, board: 2 } },
    ],
  },
  draw: {
    q: ['{opp} ile {score} berabere kaldınız. Bir puan sizi mutlu etti mi?', 'Beraberlik: kazanılmış bir puan mı, kaybedilmiş iki puan mı?'],
    options: [
      { id: 'calm', text: 'Deplasmanda ya da evde, her puan değerli. Yolumuza devam ediyoruz.', d: { fans: 0, media: 1, board: 1 } },
      { id: 'self', text: 'Kazanmamız gereken bir maçtı; sorumluluk bende.', d: { fans: 1, media: 2, board: 1 } },
      { id: 'ref', text: 'Hakem kararları bizi iki puandan etti.', d: { fans: 2, media: -3, board: -1 } },
    ],
  },
  loss: {
    q: ['{opp} karşısında {score} kaybettiniz. Ne ters gitti?', 'Mağlubiyet sonrası taraftar tepkili; ne söylemek istersiniz?'],
    options: [
      { id: 'self', text: 'Sorumluluk bende. Hafta içi eksiklerimizi çalışacağız.', d: { fans: 1, media: 2, board: 2 } },
      { id: 'ref', text: 'Hakem kararları maçın kaderini belirledi.', d: { fans: 2, media: -3, board: -1 } },
      { id: 'players', text: 'Bazı oyuncularım beklentimin çok altında kaldı.', d: { fans: -1, media: 1, board: 1 } },
    ],
  },
  bigloss: {
    q: ['{score}: ağır bir mağlubiyet. Görevi bırakmayı düşünüyor musunuz?', 'Takım {opp} karşısında dağıldı; açıklamanız nedir?'],
    options: [
      { id: 'self', text: 'Taraftarımızdan özür dilerim. Bu tablo benim sorumluluğumda.', d: { fans: 2, media: 2, board: 1 } },
      { id: 'fight', text: 'Bırakmak yok. Bu takımı ayağa kaldıracağız.', d: { fans: 1, media: 0, board: 2 } },
      { id: 'board', text: 'Kadroyu güçlendirmeden bu ligde rekabet etmek zor.', d: { fans: 0, media: 1, board: -4 } },
    ],
  },
};

/** Haber kaynakları (kurgusal). */
export const OUTLETS = ['Spor Manşet', 'Tribün Gazetesi', 'Saha Kenarı TV'];
/** Soruyu soran muhabir (kurgusal). */
export const REPORTERS = ['Selin Aydın', 'Murat Kaya', 'Deniz Yalçın', 'Emre Koç', 'Ayşe Demir', 'Burak Şahin', 'Ece Arslan', 'Kerem Öztürk'];

/** Basın toplantısı (saf): soru ve seçenekler. */
export function makePress({ id, at, my, opp, oppName, week, seed }) {
  const kind = pressKind(my, opp);
  const P = PRESS[kind];
  const rng = createRng(`press:${seed}`);
  const q = P.q[rng.int(0, P.q.length - 1)].replace('{opp}', oppName).replace('{score}', `${my}-${opp}`);
  return {
    id,
    at,
    kind,
    week: Number(week ?? 0),
    result: Number(my) > Number(opp) ? 'W' : Number(my) === Number(opp) ? 'D' : 'L',
    score: `${my}-${opp}`,
    opp: oppName,
    outlet: OUTLETS[rng.int(0, OUTLETS.length - 1)],
    reporter: REPORTERS[rng.int(0, REPORTERS.length - 1)],
    q,
    options: P.options.map((o) => ({ id: o.id, text: o.text, d: o.d })),
  };
}

/** Açıklamanın manşete girecek kısa parçası: ilk cümle, en çok 60 karakter. */
export function quoteOf(text) {
  const first = String(text ?? '').split(/[.;!?]/)[0].trim();
  if (first.length <= 60) return first;
  const cut = first.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60)}…`;
}

/** Cevaba göre manşetler (saf): alıntı, teknik direktörün seçtiği açıklamadan alınır. */
export function headlinesFor(press, optionId, clubName) {
  const o = press.options.find((x) => x.id === optionId);
  const tone = o?.id;
  const q = `“${quoteOf(o?.text)}”`;
  const lines = {
    fans: `${clubName} hocası: ${q}`,
    team: `Teknik direktörden oyunculara övgü: ${q}`,
    calm: `${clubName} kulübesinde soğukkanlı mesaj: ${q}`,
    self: `${clubName} hocası sorumluluğu üstlendi: ${q}`,
    ref: `Hakem tartışması büyüyor: ${clubName} cephesi tepkili`,
    players: `Soyunma odasında gerginlik: hoca oyuncularını eleştirdi`,
    fight: `${q}: ${clubName} hocası geri adım atmıyor`,
    board: `Yönetime açık çağrı: ${q}`,
  };
  return [
    { outlet: press.outlet, text: lines[tone] ?? `${clubName}: maç sonu açıklaması` },
    { outlet: OUTLETS[(OUTLETS.indexOf(press.outlet) + 1) % OUTLETS.length], text: `${press.opp} maçının ardından: ${press.score}` },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Maç sonrası olaylar
// ---------------------------------------------------------------------------------------------------------------

const INJURIES = ['arka adale zorlanması', 'ayak bileği burkulması', 'diz bağı zorlanması', 'kas yorgunluğu', 'kasık ağrısı', 'darbeye bağlı ödem'];
/** Sakatlığın vücuttaki yeri (uygulamada sakatlık raporundaki vücut haritası için), INJURIES ile aynı sırada. */
export const INJURY_PARTS = ['hamstring', 'ankle', 'knee', 'calf', 'groin', 'thigh'];
export const PART_LABELS = { hamstring: 'Arka adale', ankle: 'Ayak bileği', knee: 'Diz', calf: 'Baldır', groin: 'Kasık', thigh: 'Uyluk' };
const DISCIPLINE = ['antrenmana geç kaldı ve yardımcı antrenörle tartıştı', 'kamp kurallarını çiğnedi', 'oyundan alınınca kulübeye gitmeden soyunma odasına girdi', 'sosyal medyada takım arkadaşlarını eleştirdi'];
const BUYERS = ['Kartal Birlik', 'Liman FK', 'Başkent Gücü', 'Sahil Spor', 'Boğaz SK', 'Anadolu Yıldızı', 'Ege Gençlik', 'Karadeniz FK'];

/** Ad (kısa ad öncelikli). */
const nameOf = (c) => String(c?.s ?? c?.n ?? 'Oyuncu');

/**
 * Maçtan sonra olaylar (saf): sakatlık, kırmızı kart cezası, disiplin olayı, transfer teklifi.
 * lineup: { slot: kart (id'li) }, reds: kulübün kırmızı kart gören oyuncu adları, plan: taktik planı, fit: kondisyoner.
 * Döner: { injuries: [{id,name,left,note}], reds: [...], discipline: {id,name,note}|null, offer: {...}|null }
 */
export function matchEvents({ seed, lineup, reds = [], plan = null, fit = 0, cards = [], absent = {} }) {
  const rng = createRng(`events:${seed}`);
  const list = Object.values(lineup ?? {}).filter((c) => c?.id);
  const outfield = list.filter((c) => c.g !== 'KL' && !absent[c.id]);
  const out = { injuries: [], reds: [], discipline: null, offer: null };
  // Kırmızı kart: 1 maç ceza
  for (const n of reds) {
    const c = list.find((x) => nameOf(x) === n || x.n === n);
    if (c && !out.reds.some((r) => r.id === c.id)) out.reds.push({ id: c.id, name: nameOf(c), left: 1, note: 'kırmızı kart cezası' });
  }
  // Sakatlık: yoğun pres ve tempo riski artırır, kondisyoner azaltır
  const intensity = plan ? Number(plan.press ?? 3) + Number(plan.tempo ?? 3) - 6 : 0;
  const pInj = Math.max(0.05, 0.14 + 0.02 * intensity - 0.02 * Number(fit || 0));
  // Genetik yapı: demir adam daha az, kırılgan daha çok ve daha uzun sakatlanır
  if (outfield.length) {
    const c = outfield[rng.int(0, outfield.length - 1)];
    const body = geneticsOf(c).body;
    if (rng.chance(pInj * body.injury) && !out.reds.some((r) => r.id === c.id)) {
      const left = rng.pickWeighted([1, 2, 3], [5, 3, 2]) + body.extra;
      const k = rng.int(0, INJURIES.length - 1);
      // Yer, taraf ve dakika (animasyon için) tohumdan: olay çekilişlerini değiştirmez
      const h = hashStr(`inj:${seed}:${c.id}`);
      out.injuries.push({ id: c.id, name: nameOf(c), left, note: INJURIES[k], body: body.id, part: INJURY_PARTS[k], side: h % 2 ? 'sag' : 'sol', minute: 12 + (h % 74), g: c.g ?? null });
    }
  }
  // Disiplin olayı
  if (outfield.length && rng.chance(0.07)) {
    const c = outfield[rng.int(0, outfield.length - 1)];
    // Doğuştan lider disiplin sorunu çıkarmaz
    const leader = geneticsOf(c).traits.some((t) => t.id === 'lider');
    if (!leader && !out.injuries.some((x) => x.id === c.id) && !out.reds.some((x) => x.id === c.id)) {
      out.discipline = { id: c.id, name: nameOf(c), note: DISCIPLINE[rng.int(0, DISCIPLINE.length - 1)] };
    }
  }
  // Transfer teklifi: kulübün güçlü (altyapı dışı) oyuncularından birine
  const market = cards.filter((c) => !c.youth && !absent[c.id]).sort((a, b) => Number(b.r) - Number(a.r));
  if (market.length >= 12 && rng.chance(0.12)) {
    const top = market.slice(0, Math.max(3, Math.round(market.length * 0.6)));
    const c = top[rng.int(0, top.length - 1)];
    const base = SELL_PRICE[c.tier ?? tierOf(c.r)] ?? 100;
    const price = Math.round((base * (2.5 + rng.next() * 2)) / 50) * 50;
    out.offer = { id: c.id, name: nameOf(c), r: Number(c.r), buyer: BUYERS[rng.int(0, BUYERS.length - 1)], price };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------------------------------------------

export class OfficeService {
  /** game: GameService */
  constructor({ game }) {
    this.game = game;
  }

  get store() {
    return this.game.store;
  }

  now() {
    return this.game.now();
  }

  /** Kulübün yönetim kaydı (eksikleri varsayılanla). */
  office(club) {
    const o = club?.office ?? {};
    const rel = Object.fromEntries(REL_KEYS.map((k) => [k, clampRel(o.rel?.[k] ?? REL_START[k])]));
    return {
      rel,
      ticket: Number.isFinite(Number(o.ticket)) && o.ticket > 0 ? Number(o.ticket) : null,
      inbox: Array.isArray(o.inbox) ? o.inbox : [],
      absent: o.absent && typeof o.absent === 'object' ? o.absent : {},
      press: o.press ?? null,
      matchday: o.matchday ?? null,
      asks: { board: Number(o.asks?.board ?? 0), fans: Number(o.asks?.fans ?? 0) },
      warned: o.warned === true,
      seq: Number(o.seq ?? 0),
      started: o.started === true,
    };
  }

  _div(p) {
    return Number(p.career?.div ?? 0);
  }

  /** Mesaj ekler (en yeni başta). */
  _push(o, msg) {
    o.seq += 1;
    o.inbox = [{ id: `m${o.seq}`, at: this.now(), read: false, ...msg }, ...o.inbox].slice(0, INBOX_MAX);
  }

  _apply(o, d) {
    for (const k of REL_KEYS) if (d?.[k]) o.rel[k] = clampRel(o.rel[k] + d[k]);
  }

  /** İlk açılışta başkanın hoş geldin mesajı. */
  _ensure(p, o) {
    if (o.started) return false;
    o.started = true;
    const obj = p.career?.season?.objective?.text;
    this._push(o, { from: 'board', text: `Hocam, ${p.club.name} ailesine hoş geldiniz. ${obj ? `Bu sezon hedefimiz: ${obj.toLocaleLowerCase('tr')}.` : 'Kariyer ekranından sezona başladığınızda hedefimizi konuşalım.'} Kapım her zaman açık.` });
    this._push(o, { from: 'fans', text: `${p.club.fans} olarak tribünde sizinleyiz! Bilet fiyatlarını unutmayın hocam, cebimize göre olsun.` });
    return true;
  }

  async _save(uid, p, o) {
    const club = { ...p.club, office: { rel: o.rel, ticket: o.ticket, inbox: o.inbox, absent: o.absent, press: o.press, matchday: o.matchday, asks: o.asks, warned: o.warned, seq: o.seq, started: o.started } };
    await this.store.updateProfile(uid, { club });
    p.club = club;
  }

  /** Kart kimliği → yokluk görünümü. */
  absentList(o) {
    const TYPE = { injury: 'Sakat', red: 'Cezalı', dropped: 'Kadro dışı' };
    return Object.entries(o.absent).map(([id, a]) => ({ id, name: a.name, type: a.type, label: TYPE[a.type] ?? a.type, left: Number(a.left ?? 1), note: a.note ?? '' }));
  }

  /** Talep düğmelerinin durumu. */
  _asks(p, o) {
    const now = this.now();
    const credits = Number(p.credits ?? 0);
    const bWait = Math.max(0, o.asks.board + ASK.boardCooldown - now);
    const fWait = Math.max(0, o.asks.fans + ASK.fansCooldown - now);
    return {
      board: { ready: bWait === 0, waitMs: bWait, likely: o.rel.board >= ASK.boardMin },
      fans: { ready: fWait === 0 && credits < ASK.fansNeedBelow, waitMs: fWait, needBelow: ASK.fansNeedBelow, inNeed: credits < ASK.fansNeedBelow, likely: o.rel.fans >= ASK.fansMin },
    };
  }

  /** Kısa özet (kulüp görünümünde ve Benim 11'im ekranında). */
  brief(p) {
    const o = this.office(p.club);
    const div = this._div(p);
    return {
      relations: REL_KEYS.map((k) => ({ id: k, name: REL_NAMES[k], value: o.rel[k], mood: relMood(o.rel[k]) })),
      ticket: o.ticket ?? fairTicket(div),
      fair: fairTicket(div),
      unread: o.inbox.filter((m) => !m.read).length + (o.inbox.length === 0 && !o.started ? 2 : 0),
      last: o.inbox[0] ? { from: o.inbox[0].from, text: o.inbox[0].text, at: new Date(o.inbox[0].at).toISOString() } : null,
      absent: this.absentList(o),
      press: o.press && !o.press.answered ? { id: o.press.id, opp: o.press.opp, score: o.press.score } : null,
      matchday: o.matchday,
    };
  }

  /** İç saha maçında tribün: güncel bilet fiyatıyla beklenen seyirci ve doluluk (maç ekranındaki stadyum için). */
  homeCrowd(p) {
    if (!p?.club) return { attendance: 0, capacity: 0, fill: 0 };
    const o = this.office(p.club);
    const price = o.ticket ?? fairTicket(this._div(p));
    const f = this.forecast(p, o, price);
    return { attendance: f.attendance, capacity: f.capacity, fill: f.fill, price };
  }

  /** Bilet tahmini: fiyata göre seyirci ve gelir (Finans ekranındaki kaydırıcı için birkaç nokta). */
  forecast(p, o, price) {
    const levels = p.club.levels ?? {};
    const capacity = effectsOf(levels).stadium.capacity;
    const supporters = fanCount(levels, Number(p.duelTotals?.w ?? 0));
    const div = this._div(p);
    const A = attendanceOf({ capacity, supporters, fans: o.rel.fans, price, div, form: this._form(p) });
    const inc = matchdayIncome({ attendance: A, price, levels, fans: o.rel.fans });
    return { price, attendance: A, capacity, fill: capacity ? Math.round((A / capacity) * 100) : 0, income: inc };
  }

  /** Tahmin formülünün girdileri. */
  _model(p, o) {
    const levels = p.club.levels ?? {};
    return {
      capacity: effectsOf(levels).stadium.capacity,
      supporters: fanCount(levels, Number(p.duelTotals?.w ?? 0)),
      fans: o.rel.fans,
      div: this._div(p),
      form: this._form(p),
      levels: { parking: Number(levels.parking ?? 1), food: Number(levels.food ?? 1), megastore: Number(levels.megastore ?? 1) },
    };
  }

  /** Son maçların formu: G +1, M −1 (son 5 kariyer maçı). */
  _form(p) {
    const s = p.career?.season;
    if (!s?.results || !Array.isArray(s.teams)) return 0;
    const me = s.teams.findIndex((t) => t.me);
    const mine = s.results.filter((r) => r.h === me || r.a === me).slice(-5);
    return mine.reduce((a, r) => {
      const my = r.h === me ? r.hg : r.ag, op = r.h === me ? r.ag : r.hg;
      return a + (my > op ? 1 : my < op ? -1 : 0);
    }, 0);
  }

  /** Yönetim ekranı: ilişkiler, mesajlar, bilet ve tahmin, yokluklar, basın toplantısı, talepler. */
  async state({ uid, guest = false }) {
    const p = await this.game.club._club(uid, guest);
    const o = this.office(p.club);
    if (this._ensure(p, o)) await this._save(uid, p, o);
    return this._view(p, o);
  }

  _view(p, o) {
    const div = this._div(p);
    const price = o.ticket ?? fairTicket(div);
    const fair = fairTicket(div);
    const pts = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((k) => checkTicket(fair * k));
    return {
      relations: REL_KEYS.map((k) => ({ id: k, name: REL_NAMES[k], value: o.rel[k], mood: relMood(o.rel[k]) })),
      inbox: o.inbox.map((m) => ({ ...m, at: new Date(m.at).toISOString() })),
      ticket: {
        price,
        fair,
        min: TICKET.min,
        max: TICKET.max,
        step: TICKET.step,
        forecast: this.forecast(p, o, price),
        curve: [...new Set(pts)].map((x) => this.forecast(p, o, x)),
        // Uygulama kaydırıcıda tahmini aynı formülle hesaplar (attendanceOf, matchdayIncome)
        model: this._model(p, o),
      },
      absent: this.absentList(o),
      press: o.press && !o.press.answered ? o.press : null,
      matchday: o.matchday,
      asks: this._asks(p, o),
      credits: Number(p.credits ?? 0),
    };
  }

  /** Mesajları okundu say. */
  async read({ uid, guest = false }) {
    const p = await this.game.club._club(uid, guest);
    const o = this.office(p.club);
    this._ensure(p, o);
    o.inbox = o.inbox.map((m) => ({ ...m, read: true }));
    await this._save(uid, p, o);
    return this._view(p, o);
  }

  /** Bilet fiyatı (bir sonraki ev maçından geçerli). */
  async setTicket({ uid, guest = false, price }) {
    const p = await this.game.club._club(uid, guest);
    const o = this.office(p.club);
    this._ensure(p, o);
    o.ticket = checkTicket(price);
    await this._save(uid, p, o);
    return this._view(p, o);
  }

  /** Mesajdaki karar: transfer teklifi (accept | reject), disiplin (drop | warn). */
  async act({ uid, guest = false, id, choice }) {
    const p = await this.game.club._club(uid, guest);
    const o = this.office(p.club);
    const m = o.inbox.find((x) => x.id === id);
    if (!m?.act || m.act.state !== 'open') throw new AppError('failed-precondition', 'Bu mesajda bekleyen bir karar yok.');
    const a = m.act;
    const now = this.now();
    let balance = Number(p.credits ?? 0);
    if (a.kind === 'offer') {
      if (!['accept', 'reject'].includes(choice)) throw new AppError('invalid-argument', 'Geçersiz karar.');
      if (Number(a.expires) < now) {
        a.state = 'expired';
        await this._save(uid, p, o);
        throw new AppError('failed-precondition', 'Teklifin süresi doldu.');
      }
      if (choice === 'accept') {
        const [cards, squads] = await Promise.all([this.store.listCards(uid), this.store.listSquads(uid)]);
        const card = cards.find((c) => c.id === a.cardId);
        if (!card) {
          a.state = 'expired';
          await this._save(uid, p, o);
          throw new AppError('not-found', 'Oyuncu artık kulüpte değil.');
        }
        if (squads.some((s) => Object.values(s.slots ?? {}).includes(a.cardId))) throw new AppError('failed-precondition', `${a.name} bir kadroda; önce kadrodan çıkar, sonra teklifi kabul et.`);
        await this.store.deleteCards(uid, [a.cardId]);
        // Satış geliri liderlik tablosuna yazılmaz (oyunla kazanılmadı)
        balance = await this.store.changeCredits(uid, a.price, { earn: false });
        delete o.absent[a.cardId];
        const avg = cards.length ? cards.reduce((s, c) => s + Number(c.r), 0) / cards.length : 60;
        this._apply(o, Number(card.r) >= avg + 3 ? { fans: -3, board: 2 } : { board: 1 });
        a.state = 'accepted';
        this._push(o, { from: 'transfer', text: `${a.name} ${a.buyer} kulübüne ${a.price.toLocaleString('tr-TR')} krediye transfer oldu. Bonservis bedeli kasaya girdi.` });
      } else {
        a.state = 'rejected';
        this._push(o, { from: 'transfer', text: `${a.buyer} teklifini reddettik; ${a.name} kulüpte kalıyor.` });
      }
    } else if (a.kind === 'discipline') {
      if (!['drop', 'warn'].includes(choice)) throw new AppError('invalid-argument', 'Geçersiz karar.');
      if (choice === 'drop') {
        o.absent[a.cardId] = { type: 'dropped', left: 2, name: a.name, note: 'disiplin cezası' };
        this._apply(o, { board: 2, media: 2 });
        a.state = 'dropped';
        this._push(o, { from: 'media', text: `Son dakika: ${p.club.name} ${a.name} oyuncusunu disiplin gerekçesiyle 2 maç kadro dışı bıraktı.` });
      } else {
        this._apply(o, { board: -1, media: -1 });
        a.state = 'warned';
        this._push(o, { from: 'captain', text: `Hocam ${a.name} ile konuştum, özür diledi. Soyunma odası sakin.` });
      }
    } else {
      throw new AppError('failed-precondition', 'Bu mesajda bekleyen bir karar yok.');
    }
    m.read = true;
    await this._save(uid, p, o);
    return { ...this._view(p, o), balance };
  }

  /** Basın toplantısında cevap: ilişkiler değişir, manşetler çıkar. */
  async press({ uid, guest = false, id, answer }) {
    const p = await this.game.club._club(uid, guest);
    const o = this.office(p.club);
    const pr = o.press;
    if (!pr || pr.id !== id || pr.answered) throw new AppError('failed-precondition', 'Bekleyen bir basın toplantısı yok.');
    const opt = pr.options.find((x) => x.id === answer);
    if (!opt) throw new AppError('invalid-argument', 'Geçersiz cevap.');
    const before = { ...o.rel };
    this._apply(o, opt.d);
    const headlines = headlinesFor(pr, answer, p.club.name);
    o.press = { ...pr, answered: answer };
    this._push(o, { from: 'media', text: `${headlines[0].outlet}: ${headlines[0].text}` });
    await this._save(uid, p, o);
    return { statement: opt.text, headlines, delta: Object.fromEntries(REL_KEYS.map((k) => [k, o.rel[k] - before[k]])), relations: this._view(p, o).relations };
  }

  /** Talep: board (yönetimden transfer bütçesi) | fans (taraftardan maddi destek; kulüp zor durumdayken). */
  async ask({ uid, guest = false, kind }) {
    const p = await this.game.club._club(uid, guest);
    const o = this.office(p.club);
    this._ensure(p, o);
    const now = this.now();
    const st = this._asks(p, o);
    let amount = 0;
    let balance = Number(p.credits ?? 0);
    const div = this._div(p);
    if (kind === 'board') {
      if (!st.board.ready) throw new AppError('resource-exhausted', 'Başkanla yakın zamanda görüştün; birkaç gün sonra tekrar iste.');
      o.asks.board = now;
      this._push(o, { from: 'me', text: 'Başkanım, kadroyu güçlendirmek için transfer bütçesine ihtiyacımız var.' });
      if (o.rel.board >= ASK.boardMin) {
        amount = Math.round(((600 + 400 * div) * (o.rel.board / 80)) / 50) * 50;
        balance = await this.store.changeCredits(uid, amount, { earn: false });
        this._apply(o, { board: -4 });
        this._push(o, { from: 'board', text: `Hocam bütçeyi onayladık: ${amount.toLocaleString('tr-TR')} kredi kasaya aktarıldı. Karşılığını sahada görmek istiyoruz.` });
      } else {
        this._apply(o, { board: -2 });
        this._push(o, { from: 'board', text: 'Şu an bütçe veremeyiz hocam. Önce sonuç görmek istiyoruz.' });
      }
    } else if (kind === 'fans') {
      if (!st.fans.inNeed) throw new AppError('failed-precondition', `Taraftardan destek yalnızca kulüp zor durumdayken istenebilir (kasa ${ASK.fansNeedBelow.toLocaleString('tr-TR')} kredinin altında).`);
      if (!st.fans.ready) throw new AppError('resource-exhausted', 'Taraftar kampanyası yakın zamanda yapıldı; birkaç gün sonra tekrar iste.');
      o.asks.fans = now;
      this._push(o, { from: 'me', text: `${p.club.fans}, kulübümüz zor günlerden geçiyor. Desteğinize ihtiyacımız var.` });
      if (o.rel.fans >= ASK.fansMin) {
        const supporters = fanCount(p.club.levels ?? {}, Number(p.duelTotals?.w ?? 0));
        amount = Math.max(200, Math.min(2500, Math.round((supporters * (0.05 + (0.15 * o.rel.fans) / 100)) / 50) * 50));
        balance = await this.store.changeCredits(uid, amount, { earn: false });
        this._apply(o, { fans: o.rel.fans >= 80 ? -2 : -5 });
        this._push(o, { from: 'fans', text: `Kampanya tamam hocam! ${p.club.fans} ${amount.toLocaleString('tr-TR')} kredi topladı. Bu arma için her şey!` });
      } else {
        this._apply(o, { fans: -2 });
        this._push(o, { from: 'fans', text: 'Tribün küskün hocam. Önce sahada mücadele görmek istiyoruz.' });
      }
    } else {
      throw new AppError('invalid-argument', 'Geçersiz talep.');
    }
    await this._save(uid, p, o);
    return { ...this._view(p, o), amount, balance };
  }

  /** Kariyer maçında oynayamayacak oyuncular (sakat, cezalı, kadro dışı) kadroda mı? */
  unavailableIn(p, slots) {
    const o = this.office(p.club);
    const ids = new Set(Object.values(slots ?? {}));
    return this.absentList(o).filter((a) => ids.has(a.id));
  }

  /**
   * Kariyer maçından sonra: yokluk süreleri azalır; ev maçında gelirler; ilişkiler; olaylar ve mesajlar; basın
   * toplantısı. pd: bitmiş maçın kaydı; match: maç motoru çıktısı. Döner: maç sonu ekranına giden özet.
   */
  async afterMatch(uid, p, { pd, match, my, opp, season }) {
    const o = this.office(p.club);
    this._ensure(p, o);
    const now = this.now();
    const result = my > opp ? 'W' : my === opp ? 'D' : 'L';
    const div = Number(pd.fixture?.div ?? this._div(p));
    const home = pd.fixture?.home !== false;
    // Basın toplantısına çıkılmadıysa medya küser
    if (o.press && !o.press.answered) this._apply(o, { media: -2 });
    // Yokluklar bir maç azalır
    for (const [id, a] of Object.entries(o.absent)) {
      const left = Number(a.left ?? 1) - 1;
      if (left <= 0) delete o.absent[id];
      else o.absent[id] = { ...a, left };
    }
    // Süresi geçen kararlar
    for (const m of o.inbox) {
      if (m.act?.state === 'open' && Number(m.act.expires ?? Infinity) < now) {
        m.act.state = 'expired';
        if (m.act.kind === 'discipline') this._apply(o, { board: -1 });
      }
    }
    // İlişkiler: sonuç
    const stronger = Number(pd.opp?.power ?? 0) > Number(pd.me?.power ?? 0) + 1;
    const before = { ...o.rel };
    this._apply(o, resultDeltas(result, my - opp, stronger));
    // Maç günü gelirleri (ev maçı)
    let matchday = null;
    if (home) {
      const levels = p.club.levels ?? {};
      const capacity = effectsOf(levels).stadium.capacity;
      const supporters = fanCount(levels, Number(p.duelTotals?.w ?? 0));
      const price = o.ticket ?? fairTicket(div);
      const attendance = attendanceOf({ capacity, supporters, fans: before.fans, price, div, form: this._form(p) });
      const inc = matchdayIncome({ attendance, price, levels, fans: before.fans, win: result === 'W' });
      this._apply(o, { fans: ticketMood(price, div) });
      matchday = { at: now, opp: pd.opp?.name ?? '', score: `${my}-${opp}`, price, attendance, capacity, fill: capacity ? Math.round((attendance / capacity) * 100) : 0, ...inc };
      o.matchday = matchday;
      if (inc.total > 0) await this.game._earn(uid, p, inc.total, await this.game._pro(uid));
      this._push(o, { from: 'finance', text: `Maç günü geliri: ${inc.total.toLocaleString('tr-TR')} kredi · ${attendance.toLocaleString('tr-TR')} seyirci (%${matchday.fill} doluluk). Gişe ${inc.gate}, otopark ${inc.parking}, yeme-içme ${inc.food}, forma ${inc.shirts}.` });
      if (matchday.fill < 40 && price > fairTicket(div)) this._push(o, { from: 'fans', text: `Tribünler bomboştu hocam! ${price} ₺ bilet bu ligde çok pahalı, cebimiz yetmiyor.` });
    }
    // Maç haberi
    const outlet = OUTLETS[Math.abs(Number(pd.fixture?.week ?? 0)) % OUTLETS.length];
    const oppName = pd.opp?.name ?? 'rakip';
    this._push(o, {
      from: 'media',
      text: `${outlet}: ${p.club.name}, ${home ? 'evinde' : 'deplasmanda'} ${oppName} karşısında ${my}-${opp} ${result === 'W' ? 'kazandı' : result === 'D' ? 'berabere kaldı' : 'mağlup oldu'}.`,
    });
    // Olaylar
    const ids = pd.me?.ids ?? {};
    const lineup = Object.fromEntries(Object.entries(pd.me?.lineup ?? {}).map(([k, c]) => [k, c ? { ...c, id: ids[k] ?? null } : null]));
    const myReds = (match?.reds ?? []).filter((r) => r.side === 'home').map((r) => r.name);
    const cards = await this.store.listCards(uid).catch(() => []);
    const fit = staffLevels(p.club).fit;
    const ev = matchEvents({ seed: `${pd.seed}:${uid}`, lineup, reds: myReds, plan: pd.me?.plan ?? null, fit, cards, absent: o.absent });
    for (const r of ev.reds) {
      o.absent[r.id] = { type: 'red', left: 1, name: r.name, note: r.note };
      this._push(o, { from: 'disiplin', text: `Disiplin Kurulu: ${r.name} gördüğü kırmızı kart nedeniyle 1 maç cezalandırıldı.` });
    }
    for (const i of ev.injuries) {
      o.absent[i.id] = { type: 'injury', left: i.left, name: i.name, note: i.note, part: i.part ?? null, side: i.side ?? null };
      this._push(o, { from: 'medical', text: `Sağlık ekibi: ${i.name} maçta sakatlandı (${i.note}). Tahmini dönüş: ${i.left} maç sonra.` });
    }
    if (ev.discipline) {
      const d = ev.discipline;
      this._push(o, { from: 'captain', text: `Hocam, ${d.name} ${d.note}. Ne yapalım?`, act: { kind: 'discipline', cardId: d.id, name: d.name, state: 'open', expires: now + OFFER_DAYS * 86400e3 } });
    }
    if (ev.offer) {
      const f = ev.offer;
      this._push(o, { from: 'transfer', text: `${f.buyer}, ${f.name} (${f.r}) için ${f.price.toLocaleString('tr-TR')} kredi teklif etti. Teklif ${OFFER_DAYS} gün geçerli.`, act: { kind: 'offer', cardId: f.id, name: f.name, buyer: f.buyer, price: f.price, state: 'open', expires: now + OFFER_DAYS * 86400e3 } });
    }
    // Taraftar ve medya tepkisi (büyük sonuçlarda)
    if (my - opp >= 3) this._push(o, { from: 'fans', text: `${my}-${opp}! Tribünler yıkıldı hocam, bu takım şampiyonluk kokuyor!` });
    else if (opp - my >= 3) this._push(o, { from: 'fans', text: `${my}-${opp}... Bu formayı terletmeyen gitsin! Taraftar hesap soruyor.` });
    // Sezon sonu
    const f = season?.final;
    if (f) {
      const d = { board: 0, fans: 0, media: 0 };
      if (f.promoted) Object.assign(d, { board: 15, fans: 12, media: 8 });
      if (f.champion) (d.board += 5), (d.fans += 5);
      if (f.objectiveMet) d.board += 8;
      else d.board -= 10;
      if (f.relegated) (d.board -= 20), (d.fans -= 10);
      this._apply(o, d);
      this._push(o, {
        from: 'board',
        text: f.champion
          ? 'Şampiyonluk! Hocam bu kulübün tarihine geçtiniz. Yeni sezonda daha büyük hedefler.'
          : f.promoted
            ? 'Üst lige çıktık! Yönetim olarak teşekkür ederiz; yeni ligde kalıcı olmalıyız.'
            : f.relegated
              ? 'Küme düştük. Bu tablo kabul edilemez; yeni sezonda hemen geri dönmeliyiz.'
              : f.objectiveMet
                ? 'Sezon hedefini tutturdunuz hocam, tebrikler.'
                : 'Sezon hedefinin gerisinde kaldık. Yeni sezonda daha iyisini bekliyoruz.',
      });
      o.warned = false;
    }
    // Başkanın uyarısı
    if (o.rel.board < 25 && !o.warned) {
      o.warned = true;
      this._push(o, { from: 'board', text: 'Hocam sabrımız tükeniyor. Sonuçlar düzelmezse yollarımızı ayırmayı konuşacağız.' });
    } else if (o.rel.board >= 40) o.warned = false;
    // Basın toplantısı
    o.press = makePress({ id: `p${now}`, at: now, my, opp, oppName: pd.opp?.name ?? 'Rakip', week: pd.fixture?.week, seed: `${pd.seed}:${uid}` });
    await this._save(uid, p, o);
    return {
      relations: REL_KEYS.map((k) => ({ id: k, name: REL_NAMES[k], value: o.rel[k], mood: relMood(o.rel[k]), delta: o.rel[k] - before[k] })),
      matchday,
      events: [
        ...ev.reds.map((r) => ({ type: 'red', text: `${r.name}: kırmızı kart, 1 maç ceza` })),
        ...ev.injuries.map((i) => ({ type: 'injury', text: `${i.name} sakatlandı (${i.note}), ${i.left} maç yok`, injury: { id: i.id, name: i.name, note: i.note, part: i.part, partName: PART_LABELS[i.part] ?? null, side: i.side, minute: i.minute, left: i.left, g: i.g } })),
        ...(ev.discipline ? [{ type: 'discipline', text: `${ev.discipline.name}: disiplin sorunu, kararını bekliyor` }] : []),
        ...(ev.offer ? [{ type: 'offer', text: `${ev.offer.buyer}, ${ev.offer.name} için ${ev.offer.price.toLocaleString('tr-TR')} kredi teklif etti` }] : []),
      ],
      press: o.press,
      unread: o.inbox.filter((m) => !m.read).length,
    };
  }
}
