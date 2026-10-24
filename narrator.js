// Doğal dil anlatımı: AI Asistan'ın şablon yanıtını bir dil modeliyle daha akıcı yeniden yazar.
//
// Kurallar:
//  - Sayılar motordan gelir; model yalnızca verilen rakamları kullanabilir. Yeni bir rakam yazarsa taslak kullanılır.
//  - Yasaklı sözcükler (bahis, oran, kupon) ve aşırı uzun metinler reddedilir.
//  - Model kapalıysa (NARRATOR_API_KEY yok), hata verirse ya da zaman aşımına uğrarsa taslak aynen döner.
//  - Günlük çağrı sınırı (NARRATOR_DAILY_MAX, varsayılan 300) ve 30 dakikalık önbellek maliyeti sınırlar.
//
// Model ve bütçe kararı için bkz. README "Doğal dil anlatımı".

const FORBIDDEN = /\b(bahis|oran|kupon|iddaa)\w*/i;
const NUMBER = /\d+(?:[.,]\d+)?/g;

/** Metindeki sayıları ondalık virgüllü biçimde kümeye çevirir. */
export function numbersIn(text) {
  return new Set(String(text ?? '').match(NUMBER)?.map((n) => n.replace('.', ',')) ?? []);
}

/** Modelin yanıtı kabul edilebilir mi? Yeni rakam, yasaklı sözcük ya da uzunluk aşımı varsa hayır. */
export function acceptable(output, { draft, facts }) {
  if (!output || output.length > Math.max(400, draft.length * 2)) return false;
  if (FORBIDDEN.test(output)) return false;
  const allowed = new Set([...numbersIn(draft), ...numbersIn(facts)]);
  for (const n of numbersIn(output)) if (!allowed.has(n)) return false;
  return true;
}

const SYSTEM = [
  'Sen Türkçe yazan bir futbol yorumcususun.',
  'Sana verilen taslağı ve maç verilerini kullanarak 2-4 kısa cümlelik akıcı bir yorum yaz.',
  'Yalnızca verilen rakamları kullan; yeni rakam, skor, istatistik, oyuncu adı ya da takım ekleme.',
  'Olasılıkları yüzde olarak yaz. Bahis, oran ya da kupon sözcüklerini kullanma.',
  'Yalnızca yorum metnini döndür; başlık, madde işareti ya da açıklama ekleme.',
].join(' ');

/** Anthropic Messages API'sine çağrı yapan üretici. fetchImpl test için değiştirilebilir. */
export function anthropicGenerator({ apiKey, model = 'claude-haiku-5-5', fetchImpl = fetch }) {
  return async ({ system, user, timeoutMs }) => {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`model HTTP ${res.status}`);
    const json = await res.json();
    return (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  };
}

export class Narrator {
  /**
   * generate: async ({system, user, timeoutMs}) => metin. Yoksa anlatım her zaman taslaktır.
   * dailyMax: bir gündeki en fazla model çağrısı (günlük sayaç bellekte tutulur).
   */
  constructor({ generate = null, timeoutMs = 4000, dailyMax = 300, now = () => Date.now(), cacheMs = 30 * 60e3 } = {}) {
    this.generate = generate;
    this.timeoutMs = timeoutMs;
    this.dailyMax = dailyMax;
    this.now = now;
    this.cacheMs = cacheMs;
    this._cache = new Map();
    this._day = null;
    this._count = 0;
  }

  get enabled() {
    return Boolean(this.generate);
  }

  /** Taslağı döndürür ya da modelin kabul edilebilir yeniden yazımını. Asla hata fırlatmaz. */
  async rewrite({ draft, facts = {} }) {
    if (!this.generate || !draft) return { text: draft, source: 'template' };
    const factText = Object.entries(facts)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const cacheKey = `${draft}|${factText}`;
    const now = this.now();
    const hit = this._cache.get(cacheKey);
    if (hit && now - hit.at < this.cacheMs) return { text: hit.text, source: 'model' };

    const day = new Date(now + 3 * 3600e3).toISOString().slice(0, 10);
    if (day !== this._day) {
      this._day = day;
      this._count = 0;
    }
    if (this._count >= this.dailyMax) return { text: draft, source: 'template' };
    this._count += 1;

    try {
      const out = await this.generate({
        system: SYSTEM,
        user: `Taslak:\n${draft}\n\nMaç verileri:\n${factText}`,
        timeoutMs: this.timeoutMs,
      });
      if (!acceptable(out, { draft, facts: factText })) return { text: draft, source: 'template' };
      if (this._cache.size > 500) this._cache.clear();
      this._cache.set(cacheKey, { at: now, text: out });
      return { text: out, source: 'model' };
    } catch {
      return { text: draft, source: 'template' };
    }
  }
}

/** Ortam değişkenlerinden anlatıcı kurar. NARRATOR_API_KEY yoksa kapalıdır. */
export function narratorFromEnv(env = process.env) {
  const apiKey = env.NARRATOR_API_KEY;
  if (!apiKey) return new Narrator();
  return new Narrator({
    generate: anthropicGenerator({ apiKey, model: env.NARRATOR_MODEL || 'claude-haiku-5-5' }),
    dailyMax: Number(env.NARRATOR_DAILY_MAX) || 300,
  });
}
