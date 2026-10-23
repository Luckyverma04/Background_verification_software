"use strict";

/**
 * Tiny wall-clock timing helper for the BGV pipeline.
 * Records durations in ms per named phase and prints ONE concise structured
 * line per phase. It never receives candidate data - only phase names and
 * counts - so nothing sensitive can reach the log.
 */
const createTimings = (label = "bgv") => {
  const startedAt = Date.now();
  const phases = {};
  const counts = {};

  const log = (phase, extra) => {
    if (process.env.PERF_LOG === "false") return;
    console.log(`[perf] ${label} ${phase} ${JSON.stringify(extra || {})}`);
  };

  return {
    phases,
    counts,
    /** await timings.time("enrichment", () => doWork(), (r) => ({ n: r.count })) */
    async time(phase, fn, summarize) {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        const ms = Date.now() - t0;
        phases[phase] = (phases[phase] || 0) + ms;
        let extra = {};
        try { extra = (summarize && summarize()) || {}; } catch (e) { extra = {}; }
        log(phase, { ms, ...extra });
      }
    },
    add(phase, ms) {
      phases[phase] = (phases[phase] || 0) + ms;
    },
    count(name, n = 1) {
      counts[name] = (counts[name] || 0) + n;
    },
    set(name, v) {
      counts[name] = v;
    },
    snapshot() {
      return { totalMs: Date.now() - startedAt, phasesMs: { ...phases }, counts: { ...counts } };
    },
    log,
  };
};

module.exports = { createTimings };
