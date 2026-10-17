// Tohumlanabilir rastgele sayı üreteci: aynı seed = aynı maç (test ve tekrar oynatma için).

export function seedToInt(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRng(seed) {
  const s = seed === undefined || seed === null ? (Math.random() * 2 ** 32) >>> 0 : seedToInt(seed);
  const next = mulberry32(s);
  return {
    seed: s,
    next,
    int(lo, hi) {
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    chance(p) {
      return next() < p;
    },
    // Knuth yöntemi: küçük λ değerleri için yeterli ve hızlı
    poisson(lambda) {
      if (lambda <= 0) return 0;
      const limit = Math.exp(-lambda);
      let k = 0;
      let p = 1;
      do {
        k++;
        p *= next();
      } while (p > limit);
      return k - 1;
    },
    pickWeighted(values, weights) {
      const total = weights.reduce((a, b) => a + b, 0);
      let r = next() * total;
      for (let i = 0; i < values.length; i++) {
        r -= weights[i];
        if (r <= 0) return values[i];
      }
      return values[values.length - 1];
    },
  };
}
