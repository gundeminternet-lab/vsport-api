// Takım hafızası: her takımın geçmiş maçlarını kalıcı olarak saklar.
// Depolama bir "adaptör"dür: { load(): Promise<obj|null>, save(obj): Promise<void> }
//  - Node/VS Code testleri için FileStorage
//  - Mobil uygulamada AsyncStorage/MMKV ile aynı iki metodu yazman yeterli

const VERSION = 1;

export class MemoryStorage {
  constructor(initial = null) {
    this.data = initial;
  }
  async load() {
    return this.data ? JSON.parse(JSON.stringify(this.data)) : null;
  }
  async save(data) {
    this.data = JSON.parse(JSON.stringify(data));
  }
}

export class FileStorage {
  constructor(path) {
    this.path = path;
  }
  async load() {
    const fs = await import('node:fs/promises');
    try {
      return JSON.parse(await fs.readFile(this.path, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
  async save(data) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.path);
  }
}

export class TeamMemory {
  constructor({ storage = new MemoryStorage(), maxMatches = 80, maxSimulations = 200 } = {}) {
    this.storage = storage;
    this.maxMatches = maxMatches;
    this.maxSimulations = maxSimulations;
    this.data = { version: VERSION, teams: {}, simulations: [] };
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return this;
    const saved = await this.storage.load();
    if (saved && saved.version === VERSION) this.data = saved;
    this.loaded = true;
    return this;
  }

  _team(id, name) {
    const key = String(id);
    let t = this.data.teams[key];
    if (!t) t = this.data.teams[key] = { id: key, name: name || key, matches: [], syncedSeasons: {} };
    if (name) t.name = name;
    return t;
  }

  getMatches(teamId) {
    return this.data.teams[String(teamId)]?.matches ?? [];
  }

  // Yeni maçları ekler; aynı maç id'si tekrar gelirse üzerine yazar (skor düzeltmeleri için)
  async remember(teamId, name, matches, season = null) {
    const t = this._team(teamId, name);
    const byId = new Map(t.matches.map((m) => [m.id, m]));
    for (const m of matches) byId.set(m.id, m);
    t.matches = [...byId.values()].sort((a, b) => b.timestamp - a.timestamp).slice(0, this.maxMatches);
    if (season !== null) t.syncedSeasons[season] = Date.now();
    await this.flush();
  }

  isSynced(teamId, season, maxAgeMs = Infinity) {
    const ts = this.data.teams[String(teamId)]?.syncedSeasons?.[season];
    return ts !== undefined && Date.now() - ts <= maxAgeMs;
  }

  // İki takımın birbirine karşı oynadığı maçlar (iki takımın hafızası birleştirilir)
  getHeadToHead(teamA, teamB, limit = 8) {
    const a = String(teamA);
    const b = String(teamB);
    const seen = new Map();
    for (const m of [...this.getMatches(a), ...this.getMatches(b)]) {
      const pair = (m.homeId === a && m.awayId === b) || (m.homeId === b && m.awayId === a);
      if (pair) seen.set(m.id, m);
    }
    return [...seen.values()].sort((x, y) => y.timestamp - x.timestamp).slice(0, limit);
  }

  // Simülasyon sonuçları ayrı tutulur; gerçek maç istatistiklerini kirletmez.
  async recordSimulation(entry) {
    this.data.simulations.unshift({ at: Date.now(), ...entry });
    this.data.simulations = this.data.simulations.slice(0, this.maxSimulations);
    await this.flush();
  }

  async flush() {
    await this.storage.save(this.data);
  }
}
