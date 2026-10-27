// Favori maçları canlı izler ve bildirim gönderir. Sunucu (server.js) çalıştığı sürece dakikada bir döner.
//   watched/{matchKey}: uygulama bir maçı favoriye eklediğinde oluşturur (lig, maç no, başlama saati).
//   Takip: başlamadan 10 dk önce → başladıktan 4 saat sonrasına kadar ya da maç bitene kadar.

import { evaluate, readSummary } from './notify.js';
import { LEAGUES } from './logic.js';

const KEY_RE = /^[A-Za-z0-9_]{3,80}$/;

export class MatchWatcher {
  constructor({ store, espn, send, onFinished = null, onTick = null, onNote = null, now = () => Date.now(), log = console, leagues = LEAGUES, concurrency = 4 }) {
    this.onFinished = onFinished; // async ({key, homeGoals, awayGoals, kickoffMs}) — tahmin ligi puanlaması
    this.onTick = onTick; // her turda (haftalık ödül kontrolü)
    this.onNote = onNote; // async ({key, note}) — maç odasında otomatik anket
    this.store = store;
    this.espn = espn;
    this.send = send; // async ({topic, title, body, data}) => void
    this.now = now;
    this.log = log;
    this.leagues = new Set(leagues);
    this.concurrency = concurrency;
    this.active = 0; // son turda izlenen maç sayısı (uyku önleme için)
    this.sent = 0;
    this._timer = null;
    this._busy = false;
  }

  async tick() {
    const now = this.now();
    if (this.onTick) {
      try {
        await this.onTick(now);
      } catch (e) {
        this.log.error?.(`[watcher] periyodik görev başarısız: ${e?.message ?? e}`);
      }
    }
    // Maç bitip tahminler puanlanana kadar izlenir (sunucu bir süre kapalı kaldıysa 8 saate kadar telafi eder).
    const list = await this.store.listWatched(new Date(now - 8 * 3600e3), new Date(now + 10 * 60e3));
    const todo = list.filter(
      (w) => !(w.state?.done === true && w.state?.scored !== false) && this.leagues.has(w.league) && /^[0-9A-Za-z-]{1,30}$/.test(w.eventId) && KEY_RE.test(w.key),
    );
    this.active = todo.length;
    let i = 0;
    const worker = async () => {
      while (i < todo.length) await this.check(todo[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, todo.length) }, worker));
    return todo.length;
  }

  async check(w) {
    let summary;
    try {
      summary = await this.espn.getSummary(w.league, w.eventId);
    } catch (e) {
      this.log.error?.(`[watcher] ${w.key} özet alınamadı: ${e?.message ?? e}`);
      return;
    }
    const result = evaluate(summary, w.state);
    const { notes, state } = result;
    let changed = result.changed;
    // Maç bitti: tahmin ligi puanlaması (başarısız olursa sonraki turda tekrar denenir).
    if (state.done) {
      const s = readSummary(summary);
      if (s.completed && this.onFinished && w.state?.scored !== true) {
        try {
          await this.onFinished({ key: w.key, homeGoals: s.score[0], awayGoals: s.score[1], kickoffMs: s.date ?? this.now() });
          state.scored = true;
        } catch (e) {
          state.scored = false;
          this.log.error?.(`[watcher] ${w.key} tahminler puanlanamadı: ${e?.message ?? e}`);
        }
      } else {
        state.scored = true;
      }
      changed = changed || state.scored !== w.state?.scored;
    }
    for (const n of notes) {
      try {
        await this.send({
          topic: `${w.key}_${n.type}`,
          title: n.title,
          body: n.body,
          data: { matchKey: w.key, league: w.league, eventId: w.eventId, type: n.type },
        });
        this.sent++;
      } catch (e) {
        this.log.error?.(`[watcher] ${w.key} bildirim gönderilemedi: ${e?.message ?? e}`);
      }
      if (this.onNote) {
        try {
          await this.onNote({ key: w.key, note: n });
        } catch (e) {
          this.log.error?.(`[watcher] ${w.key} anket açılamadı: ${e?.message ?? e}`);
        }
      }
    }
    if (changed) {
      try {
        await this.store.saveWatchState(w.key, state);
      } catch (e) {
        this.log.error?.(`[watcher] ${w.key} durum kaydedilemedi: ${e?.message ?? e}`);
      }
    }
  }

  start(intervalMs = 60000) {
    const loop = async () => {
      if (!this._busy) {
        this._busy = true;
        let timer;
        try {
          // Bir istek takılırsa tur sonsuza dek beklemesin: 5 dakikada bitmeyen tur bırakılır, izleme sürer
          await Promise.race([
            this.tick(),
            new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('tur 5 dakikada bitmedi')), 5 * 60e3))),
          ]);
        } catch (e) {
          this.log.error?.(`[watcher] tur başarısız: ${e?.message ?? e}`);
        } finally {
          clearTimeout(timer);
          this._busy = false;
        }
      }
      this._timer = setTimeout(loop, intervalMs);
    };
    this._timer = setTimeout(loop, 5000);
  }

  stop() {
    clearTimeout(this._timer);
  }
}
