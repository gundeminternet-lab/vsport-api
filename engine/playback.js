// Oynatıcı: hazır maç zaman çizelgesini gerçek zamana yayar (varsayılan 60 saniye).
// Maç saati lineer akar; devre arası için halftimeSeconds kadar duraklar.
//
// onEvent(event)   : her olay zamanı gelince (gol, kart, şut...). event.score o anki skoru taşır.
// onTick(info)     : her tickMs'de bir: { clock, label, progress, stats } -> saha/top animasyonu için.
//                    stats.pressure (-1..+1) topun hangi yarı sahada olacağını yönlendirebilir.
// onHalftime/onFinish: devre arası ve maç sonu.

import { SIM } from './config.js';

export function playTimeline(
  timeline,
  { durationSeconds = SIM.durationSeconds, halftimeSeconds = SIM.halftimeSeconds, tickMs = 100, onEvent, onTick, onHalftime, onFinish } = {},
) {
  const { events, totalClock: total, firstHalfClock: fh, minuteStats } = timeline;
  let idx = 0;
  let stopped = false;
  let halftimeFired = false;
  let timer = null;

  const finish = () => {
    while (idx < events.length) {
      const e = events[idx++]; // indeks önce artırılır: onEvent verilmese de döngü ilerler
      onEvent?.(e);
    }
    onFinish?.({ score: timeline.score, stats: timeline.stats });
  };

  // Anlık modu: bekleme yok
  if (durationSeconds <= 0) {
    finish();
    return { stop() {}, done: Promise.resolve({ stopped: false }) };
  }

  const { realToClock } = makeClockMap(timeline, durationSeconds, halftimeSeconds);

  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
    const t0 = performance.now();

    const step = () => {
      if (stopped) return resolve({ stopped: true });
      const sec = (performance.now() - t0) / 1000;
      const clock = Math.min(total, realToClock(sec));

      // Devre arasında fh'ye eşit saatteki olayları tutmak için kesin küçüktür kullanılır
      while (idx < events.length && events[idx].clock < clock && events[idx].type !== 'fulltime') {
        const e = events[idx++];
        onEvent?.(e);
      }

      if (clock >= fh && !halftimeFired) {
        halftimeFired = true;
        onHalftime?.({ score: timeline.halftimeScore });
      }

      const si = clamp(Math.floor(clock) - 1, 0, minuteStats.length - 1);
      onTick?.({
        clock,
        label: minuteStats[clamp(Math.floor(clock), 0, minuteStats.length - 1)].label,
        progress: Math.min(1, sec / durationSeconds),
        stats: clock < 1 ? null : minuteStats[si],
      });

      if (sec >= durationSeconds) {
        finish();
        return resolve({ stopped: false });
      }
      timer = setTimeout(step, tickMs);
    };
    step();
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      resolveDone?.({ stopped: true });
    },
    done,
  };
}

// Gerçek saniye <-> maç saati eşlemesi. Oynatıcı ve animasyon aynı eşlemeyi kullanır ki
// ekrandaki hareket ile olay akışı hiç kaymasın.
export function makeClockMap(timeline, durationSeconds = SIM.durationSeconds, halftimeSeconds = SIM.halftimeSeconds) {
  const { totalClock: total, firstHalfClock: fh } = timeline;
  const playSec = Math.max(0.1, durationSeconds - halftimeSeconds);
  const firstHalfSec = playSec * (fh / total);

  const realToClock = (sec) => {
    if (sec <= firstHalfSec) return (sec / playSec) * total;
    if (sec <= firstHalfSec + halftimeSeconds) return fh;
    return ((sec - halftimeSeconds) / playSec) * total;
  };
  const clockToReal = (c) => (c <= fh ? (c / total) * playSec : (c / total) * playSec + halftimeSeconds);

  return { realToClock, clockToReal, playSec, firstHalfSec, durationSeconds, halftimeSeconds };
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}
