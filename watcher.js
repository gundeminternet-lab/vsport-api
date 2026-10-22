// Favori maçları canlı izler ve bildirim gönderir. Sunucu (server.js) çalıştığı sürece dakikada bir döner.
//   watched/{matchKey}: uygulama bir maçı favoriye eklediğinde oluşturur (lig, maç no, başlama saati).
//   Takip: başlamadan 10 dk önce → başladıktan 4 saat sonrasına kadar ya da maç bitene kadar.

import { evaluate } from './notify.js';
import { LEAGUES } from './logic.js';

const KEY_RE = /^[A-Za-z0-9_]{3,80}$/;

export class MatchWatcher {
  constructor({ store, espn, send, now = () => Date.now(), log = console, leagues = LEAGUES, concurrency = 4 }) {
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
    const list = await this.store.listWatched(new Date(now - 4 * 3600e3), new Date(now + 10 * 60e3));
    const todo = list.filter(
      (w) => w.state?.done !== true && this.leagues.has(w.league) && /^[0-9A-Za-z-]{1,30}$/.test(w.eventId) && KEY_RE.test(w.key),
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
    const { notes, state, changed } = evaluate(summary, w.state);
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
        try {
          await this.tick();
        } catch (e) {
          this.log.error?.(`[watcher] tur başarısız: ${e?.message ?? e}`);
        } finally {
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
