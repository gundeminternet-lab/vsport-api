// Canlı maç bildirimleri: maç özetindeki değişikliklerden bildirim üretir (saf fonksiyonlar; test edilebilir).
//
// Bildirim türleri uygulamadaki tercihlerle aynıdır (lib/models/app_user.dart → notificationTypes):
//   kickoff, goal, goal_disallowed, var, penalty, red_card, half_time, second_half, added_time, full_time
// Her bildirim "{matchKey}_{tür}" konusuna (FCM topic) gönderilir; telefon yalnızca favori maçlarının ve
// açık tuttuğu türlerin konularına abonedir.

export const NOTIFY_TYPES = [
  'kickoff', 'goal', 'goal_disallowed', 'var', 'penalty', 'red_card', 'half_time', 'second_half', 'added_time', 'full_time',
];

/**
 * Olay başına Android bildirim kanalı ve özel ses. Android 8+ sesi kanal belirler, bu yüzden her sesin ayrı kanalı vardır;
 * kanallar uygulamada oluşturulur (android/app/src/main/kotlin/.../MainActivity.kt) ve ses dosyaları
 * android/app/src/main/res/raw/<ses>.ogg içindedir. Ses ya da kanal değişirse kanal adının sonundaki sürümü artırın
 * (Android bir kanalın sesini sonradan değiştirmeye izin vermez).
 * `sound` Android 7 ve altında bildirimin kendi sesidir (uzantısız dosya adı).
 */
export const SOUND_CHANNELS = {
  goal: { channelId: 'ev_goal_v1', sound: 'snd_goal' },
  red_card: { channelId: 'ev_red_card_v1', sound: 'snd_red_card' },
  penalty: { channelId: 'ev_penalty_v1', sound: 'snd_penalty' },
  kickoff: { channelId: 'ev_kickoff_v1', sound: 'snd_kickoff' },
  half_time: { channelId: 'ev_half_time_v1', sound: 'snd_half_time' },
  second_half: { channelId: 'ev_second_half_v1', sound: 'snd_second_half' },
  full_time: { channelId: 'ev_full_time_v1', sound: 'snd_full_time' },
};

/** Özel sesi olmayan türler (VAR, gol iptali, uzatma) varsayılan bildirim sesini kullanır. */
export const DEFAULT_CHANNEL = { channelId: 'match_events', sound: 'default' };

export const channelFor = (type) => SOUND_CHANNELS[type] ?? DEFAULT_CHANNEL;

/** FCM mesajı: konuya giden bildirim + olay türüne uygun kanal ve ses. `data.type` bildirim türüdür. */
export function fcmMessage({ topic, title, body, data }) {
  const { channelId, sound } = channelFor(data?.type);
  return {
    topic,
    notification: { title, body },
    data,
    android: { priority: 'high', notification: { channelId, sound } },
  };
}

const str = (v) => (v === null || v === undefined ? '' : String(v)).trim();
const num = (v) => {
  const n = Number(typeof v === 'object' && v !== null ? v.value ?? v.displayValue : v);
  return Number.isFinite(n) ? n : null;
};

/** Özetten maçın o anki durumu. */
export function readSummary(json) {
  const comp = json?.header?.competitions?.[0] ?? {};
  const cs = comp.competitors ?? [];
  const home = cs.find((c) => c.homeAway === 'home') ?? cs[0] ?? {};
  const away = cs.find((c) => c.homeAway === 'away') ?? cs[1] ?? {};
  const st = comp.status ?? json?.header?.status ?? {};
  const type = st.type ?? {};
  const team = (c) => ({
    id: str(c.team?.id ?? c.id),
    name: str(c.team?.shortDisplayName ?? c.team?.displayName ?? c.team?.name) || '?',
  });
  return {
    date: Date.parse(comp.date ?? json?.header?.date ?? '') || null,
    home: team(home),
    away: team(away),
    score: [num(home.score) ?? 0, num(away.score) ?? 0],
    state: str(type.state), // pre | in | post
    statusName: str(type.name), // STATUS_FIRST_HALF, STATUS_HALFTIME, ...
    completed: type.completed === true,
    period: num(st.period) ?? 0,
    clock: str(st.displayClock),
    events: (json?.keyEvents ?? []).map((e) => ({
      id: str(e.id),
      type: str(e.type?.text ?? e.type?.type).toLowerCase(),
      text: str(e.text ?? e.shortText),
      clock: str(e.clock?.displayValue),
      teamId: str(e.team?.id),
      player: str(e.participants?.[0]?.athlete?.displayName ?? e.participants?.[0]?.athlete?.shortName),
      scoring: e.scoringPlay === true,
      ownGoal: e.ownGoal === true,
      penalty: e.penaltyKick === true,
      red: e.redCard === true,
    })),
  };
}

/** ESPN olay türünü bildirim türlerine çevirir (bir olay birden çok bildirim doğurabilir: penaltı golü). */
export function classifyEvent(e) {
  const t = e.type;
  const out = [];
  const disallowed = /disallow|ruled out|overturn|cancel/.test(t) || /disallow|ruled out|overturn/.test(e.text.toLowerCase());
  if (disallowed) return ['goal_disallowed'];
  if (/\bvar\b|video/.test(t)) out.push('var');
  const penaltyEvent = t.includes('penalty') || e.penalty;
  if (penaltyEvent) out.push('penalty');
  const missedPenalty = penaltyEvent && /miss|saved/.test(t);
  if (!missedPenalty && (e.scoring || e.ownGoal || t === 'goal' || t.startsWith('goal') || t.includes('own goal') || (penaltyEvent && t.includes('scored')))) {
    out.push('goal');
  }
  if (e.red || t.includes('red card') || t.includes('second yellow') || t.includes('yellow-red') || t.includes('yellow red')) out.push('red_card');
  return out;
}

const minute = (c) => (c ? `${c} ` : '');
const scoreLine = (s) => `${s.home.name} ${s.score[0]}-${s.score[1]} ${s.away.name}`;
const teamName = (s, id) => (id === s.home.id ? s.home.name : id === s.away.id ? s.away.name : '');

function eventNote(type, e, s) {
  const team = teamName(s, e.teamId);
  const who = [e.player, team && `(${team})`].filter(Boolean).join(' ');
  switch (type) {
    case 'goal': {
      const extra = e.ownGoal || e.type.includes('own goal') ? ' (kendi kalesine)' : e.penalty || e.type.includes('penalty') ? ' (penaltı)' : '';
      return { title: `⚽ GOL! ${scoreLine(s)}`, body: `${minute(e.clock)}${who || team}${extra}`.trim() };
    }
    case 'penalty': {
      const result = /miss/.test(e.type) ? 'Penaltı kaçtı' : /saved/.test(e.type) ? 'Penaltı kurtarıldı' : /scored/.test(e.type) || e.scoring || e.type.startsWith('goal') ? 'Penaltı golü' : 'Penaltı kararı';
      return { title: `Penaltı! ${s.home.name} - ${s.away.name}`, body: `${minute(e.clock)}${result}${team ? ` · ${team}` : ''}${e.player ? ` · ${e.player}` : ''}` };
    }
    case 'red_card':
      return { title: `🟥 Kırmızı kart · ${s.home.name} - ${s.away.name}`, body: `${minute(e.clock)}${who || team}`.trim() };
    case 'var':
      return { title: `VAR incelemesi · ${s.home.name} - ${s.away.name}`, body: `${minute(e.clock)}${e.text || 'Pozisyon VAR ile inceleniyor.'}`.slice(0, 180) };
    case 'goal_disallowed':
      return { title: `Gol iptal edildi · ${s.home.name} - ${s.away.name}`, body: `${minute(e.clock)}${scoreLine(s)}` };
    default:
      return null;
  }
}

/**
 * Önceki duruma göre yeni bildirimleri üretir.
 * @param json  maç özeti (summary?event=)
 * @param prev  saklanan durum ya da null (ilk kez bakılıyor)
 * @returns {{notes: {type,title,body}[], state: object, changed: boolean}}
 */
export function evaluate(json, prev) {
  const s = readSummary(json);
  const state = {
    phases: { ...(prev?.phases ?? {}) },
    seen: [...(prev?.seen ?? [])],
    score: prev?.score ?? s.score,
    done: false,
  };
  const notes = [];
  const first = !prev;

  // Ertelenen ya da iptal edilen maç: takip biter, bildirim yok.
  if (s.state === 'post' && !s.completed) {
    return { notes, state: { ...state, done: true }, changed: true };
  }

  const phase = (key, type, title, body, when) => {
    if (!when || state.phases[key]) return;
    state.phases[key] = true;
    if (!first) notes.push({ type, title, body });
  };
  const live = s.state === 'in' || s.state === 'post';
  const halftime = s.statusName === 'STATUS_HALFTIME';
  const secondHalf = live && s.period >= 2 && !halftime;
  const ended = s.completed || s.statusName === 'STATUS_FULL_TIME' || s.statusName === 'STATUS_FINAL';

  phase('kickoff', 'kickoff', `Maç başladı · ${s.home.name} - ${s.away.name}`, 'Hakem ilk düdüğü çaldı. İyi seyirler!', live);
  phase('added_1', 'added_time', `Uzatma dakikaları · ${s.home.name} - ${s.away.name}`,
    `İlk yarıda uzatma dakikaları oynanıyor (${s.clock}). ${scoreLine(s)}`, live && s.period === 1 && s.clock.includes('+'));
  // Devre arası görülmeden ikinci yarı başladıysa devre arası bildirimi atlanır (geç kalmış olur).
  if (secondHalf && !state.phases.half_time) state.phases.half_time = true;
  phase('half_time', 'half_time', `Devre arası · ${s.home.name} - ${s.away.name}`, `İlk yarı sonucu: ${scoreLine(s)}`, halftime);
  phase('second_half', 'second_half', `İkinci yarı başladı · ${s.home.name} - ${s.away.name}`, scoreLine(s), secondHalf && !ended);
  phase('added_2', 'added_time', `Uzatma dakikaları · ${s.home.name} - ${s.away.name}`,
    `İkinci yarıda uzatma dakikaları oynanıyor (${s.clock}). ${scoreLine(s)}`, live && s.period === 2 && s.clock.includes('+') && !ended);

  // Olaylar (gol, penaltı, kart, VAR) — her olay bir kez
  const seen = new Set(state.seen);
  for (const e of s.events) {
    if (!e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    if (first) continue;
    for (const type of classifyEvent(e)) {
      const n = eventNote(type, e, s);
      if (n) notes.push({ type, ...n });
    }
  }
  state.seen = [...seen].slice(-200);

  // Skor geriye gittiyse bir gol iptal edilmiştir (VAR sonrası ESPN olayı siler).
  const [ph, pa] = state.score;
  if (!first && (s.score[0] < ph || s.score[1] < pa) && !notes.some((n) => n.type === 'goal_disallowed')) {
    notes.push({ type: 'goal_disallowed', title: `Gol iptal edildi · ${s.home.name} - ${s.away.name}`, body: `Skor: ${scoreLine(s)}` });
  }
  state.score = s.score;

  // Maç sonu bildirimi diğerlerinden sonra gelsin.
  phase('full_time', 'full_time', `Maç bitti · ${s.home.name} - ${s.away.name}`, `Maç sonucu: ${scoreLine(s)}`, ended);
  if (ended) state.done = true;

  const norm = (x) => JSON.stringify([Object.keys(x?.phases ?? {}).sort(), x?.seen ?? [], x?.score ?? [], x?.done === true]);
  const changed = first || notes.length > 0 || norm(state) !== norm(prev);
  return { notes, state, changed };
}
