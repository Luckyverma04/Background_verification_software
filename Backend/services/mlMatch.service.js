"use strict";

const axios = require("axios");
const crypto = require("crypto");

const ML_SERVICE_URL =
  process.env.ML_SERVICE_URL || "http://127.0.0.1:8001";

const clampPercent = (value) => {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null; // missing / invalid is "no score", never a similarity of 0
  }

  return Math.max(0, Math.min(100, n));
};

// ---------------------------------------------------------------------
// Reliability layer around the ML service
//  - circuit breaker: after N consecutive failed requests the service is
//    treated as UNAVAILABLE for a cool-down, so the pipeline does not wait
//    on timeouts for every remaining batch
//  - ONE retry for connection resets / 5xx (a reset is often a worker that
//    just restarted); never more, never for 4xx
//  - global concurrency limit (several ranking operations share it)
//  - score cache keyed by model + candidate text + result text, plus
//    in-flight de-duplication so the same pair is never scored twice
// ---------------------------------------------------------------------
const metrics = {
  requests: 0,
  texts: 0,
  failures: 0,
  retries: 0,
  cacheHits: 0,
  dedupedInflight: 0,
  breakerSkips: 0,
  queueMs: 0,
  requestMs: 0,
};
const breaker = { failures: 0, openUntil: 0 };

// Only real text may be sent to the model. null / "" / objects / arrays are NOT
// turned into "" or "[object Object]" (that would be scored as if it were a
// profile); they are reported back as INVALID_INPUT at their original index.
const cleanText = (value) => {
  if (value === null || value === undefined) return { reason: "NULL_TEXT" };
  if (typeof value === "number") return Number.isFinite(value) ? { text: String(value) } : { reason: "INVALID_TYPE" };
  if (typeof value !== "string") return { reason: "INVALID_TYPE" };
  const text = value.trim();
  return text ? { text } : { reason: "EMPTY_TEXT" };
};

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isBreakerOpen = () => Date.now() < breaker.openUntil;
const recordSuccess = () => {
  breaker.failures = 0;
  breaker.openUntil = 0;
};
const recordFailure = () => {
  breaker.failures += 1;
  if (breaker.failures >= num("ML_BREAKER_THRESHOLD", 2)) {
    breaker.openUntil = Date.now() + num("ML_BREAKER_COOLDOWN_MS", 30000);
  }
};

let active = 0;
const waiters = [];
const acquire = async () => {
  const t0 = Date.now();
  if (active >= Math.max(num("ML_CONCURRENCY", 2), 1)) {
    await new Promise((resolve) => waiters.push(resolve));
  } else {
    active += 1;
  }
  metrics.queueMs += Date.now() - t0;
};
const release = () => {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
};

const retryable = (error) => {
  const status = error?.response?.status;
  if (status >= 500 && status <= 599) return true;
  return ["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT"].includes(error?.code);
};

const getMetrics = () => ({ ...metrics, breakerOpen: isBreakerOpen() });
const resetMetrics = () => {
  for (const k of Object.keys(metrics)) metrics[k] = 0;
};
const resetState = () => {
  breaker.failures = 0;
  breaker.openUntil = 0;
  scoreCache.clear();
  inflight.clear();
};

/**
 * Runs BGE-M3 against one candidate and many search results.
 *
 * One batch request is used for the provided search results.
 *
 * If ML service fails:
 * - error is thrown to the caller
 * - caller can mark that batch as failed
 * - normal rule-based ranking can continue
 * - ML contributes 0 points for failed batch
 */
const getMLSimilarities = async ({
  candidateText,
  resultTexts,
  timeoutMs = 120000,
} = {}) => {
  if (
    !candidateText ||
    !Array.isArray(resultTexts) ||
    !resultTexts.length
  ) {
    return [];
  }

  const modelName = process.env.ML_MODEL_NAME || "BAAI/bge-m3";
  const cand = cleanText(candidateText);
  if (cand.reason) {
    const err = new Error(`candidate text is not usable (${cand.reason})`);
    err.code = "ML_BAD_REQUEST";
    throw err;
  }

  // One entry per input, same order. Entries start as "no score".
  const scores = resultTexts.map((raw) => {
    const c = cleanText(raw);
    return c.reason
      ? { similarity: null, similarityPercent: null, status: "INVALID_INPUT", error: { code: c.reason }, model: modelName, _text: null }
      : { similarity: null, similarityPercent: null, status: "UNAVAILABLE", model: modelName, _text: c.text };
  });
  const sendIdx = scores.map((x, i) => (x._text === null ? -1 : i)).filter((i) => i >= 0);
  const strip = () => scores.map(({ _text, ...rest }) => rest);

  if (!sendIdx.length) return strip(); // nothing valid: do not call the ML service

  if (isBreakerOpen()) {
    metrics.breakerSkips += 1;
    const err = new Error("ML service temporarily unavailable (circuit open)");
    err.code = "ML_UNAVAILABLE";
    throw err;
  }

  try {
    const body = {
      candidate_text: cand.text,
      result_texts: sendIdx.map((i) => scores[i]._text),
    };
    let response;
    await acquire();
    const t0 = Date.now();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          metrics.requests += 1;
          metrics.texts += body.result_texts.length;
          response = await axios.post(`${process.env.ML_SERVICE_URL || ML_SERVICE_URL}/match/batch`, body, {
            timeout: timeoutMs,
            headers: { "Content-Type": "application/json" },
          });
          break;
        } catch (error) {
          if (attempt >= 1 || !retryable(error)) throw error;
          metrics.retries += 1;
          await sleep(num("ML_RETRY_DELAY_MS", 400));
        }
      }
    } finally {
      metrics.requestMs += Date.now() - t0;
      release();
    }
    recordSuccess();

    const rows = Array.isArray(response.data?.results)
      ? response.data.results
      : [];
    const respModel = response.data?.model || modelName;

    rows.forEach((row) => {
      const sent = Number(row?.index); // position inside the request we sent
      if (!Number.isInteger(sent) || sent < 0 || sent >= sendIdx.length) return;
      const target = scores[sendIdx[sent]];
      target.model = respModel;

      // per-item failure reported by the service: explicit, never a score
      if (row?.status && row.status !== "OK") {
        target.status = "UNAVAILABLE";
        target.error = { code: row?.error?.code || "ML_ITEM_FAILED" };
        return;
      }
      const similarity = row?.similarity === null || row?.similarity === undefined ? NaN : Number(row.similarity);
      const percent = clampPercent(row?.similarityPercent === undefined ? null : row.similarityPercent);
      if (!Number.isFinite(similarity) || percent === null) {
        target.status = "UNAVAILABLE";
        target.error = { code: "ML_NO_SCORE" };
        return;
      }
      target.similarity = similarity;
      target.similarityPercent = percent;
      target.status = "SCORED";
    });

    return strip();
  } catch (error) {
    const httpStatus = error.response?.status;
    const detail = error.response?.data?.detail;
    if (httpStatus) {
      error.mlStatus = httpStatus;
      error.mlCode = (detail && typeof detail === "object" && detail.code) || undefined;
    }
    if (error.code === "ML_UNAVAILABLE") {
      // circuit-open: already counted
    } else if (httpStatus >= 400 && httpStatus < 500) {
      // The service answered: our REQUEST was bad (422 invalid text, 413 too
      // many). That is not an outage, so it must not trip the breaker.
      error.code = "ML_BAD_REQUEST";
      metrics.failures += 1;
    } else {
      // 503 / 5xx / reset / timeout: the service is the problem
      metrics.failures += 1;
      recordFailure();
      if (httpStatus === 503) error.code = "ML_UNAVAILABLE";
    }
    console.error(
      "BGE-M3 matching failed:",
      httpStatus ? `HTTP ${httpStatus}${error.mlCode ? ` ${error.mlCode}` : ""}` : error.code || error.message
    );

    // IMPORTANT: throw, so the batch-level caller knows this ML request
    // failed. A failure is never converted into a similarity of 0.
    throw error;
  }
};

// ---------------------------------------------------------------------
// Cached, de-duplicated, bounded scoring of many texts against ONE candidate
// ---------------------------------------------------------------------
const scoreCache = new Map(); // key -> similarityPercent
const inflight = new Map(); // key -> Promise<number>

const MODEL_NAME = () => process.env.ML_MODEL_NAME || "BAAI/bge-m3";
const scoreKey = (candidateText, resultText) =>
  crypto
    .createHash("sha1")
    .update(MODEL_NAME())
    .update("\u0000")
    .update(candidateText)
    .update("\u0000")
    .update(resultText)
    .digest("hex");

const cacheSet = (key, value, max) => {
  if (scoreCache.has(key)) scoreCache.delete(key);
  else if (scoreCache.size >= max) scoreCache.delete(scoreCache.keys().next().value);
  scoreCache.set(key, value);
};

/**
 * @returns {Promise<Array<{similarityPercent:number|null,status:string}>>}
 * aligned with resultTexts. status:
 *   SCORED      freshly scored          CACHED  served from cache
 *   UNAVAILABLE the request failed / the service is down: similarityPercent is
 *               null (NOT 0 - a failure is not a similarity) and the caller
 *               falls back to deterministic ranking
 *   INVALID_INPUT the text was not usable (object, array...): never sent, no score
 *   EMPTY       no text to score
 */
const scoreTexts = async ({ candidateText, resultTexts = [], batchSize = 20, cacheMax = 5000, timeoutMs } = {}) => {
  const out = resultTexts.map(() => ({ similarityPercent: null, status: "EMPTY" }));
  if (!candidateText || !resultTexts.length) return out;

  const bs = Math.max(Number(batchSize) || 20, 1);
  const cleaned = resultTexts.map(cleanText);
  const candClean = cleanText(candidateText);
  if (candClean.reason) return resultTexts.map(() => ({ similarityPercent: null, status: "INVALID_INPUT" }));
  const keys = cleaned.map((c) => (c.text ? scoreKey(candClean.text, c.text) : null));
  const mine = []; // indexes this call must request
  const waiting = []; // [index, promise] being scored by another call
  const seenHere = new Map(); // key -> first index (identical texts inside one call)
  const dupes = []; // [index, firstIndex]

  resultTexts.forEach((_raw, i) => {
    // null / "" are EMPTY (nothing to score); objects, arrays, ... are INVALID_INPUT
    if (!cleaned[i].text) {
      out[i] = { similarityPercent: null, status: cleaned[i].reason === "INVALID_TYPE" ? "INVALID_INPUT" : "EMPTY" };
      return;
    }
    const key = keys[i];
    if (scoreCache.has(key)) {
      out[i] = { similarityPercent: scoreCache.get(key), status: "CACHED" };
      metrics.cacheHits += 1;
    } else if (seenHere.has(key)) {
      dupes.push([i, seenHere.get(key)]);
      metrics.dedupedInflight += 1;
    } else if (inflight.has(key)) {
      seenHere.set(key, i);
      waiting.push([i, inflight.get(key)]);
      metrics.dedupedInflight += 1;
    } else {
      seenHere.set(key, i);
      let resolve;
      let reject;
      const p = new Promise((res, rej) => { resolve = res; reject = rej; });
      p.catch(() => {}); // no unhandled rejection when nobody else waits
      inflight.set(key, p);
      mine.push({ i, resolve, reject });
    }
  });

  const batches = [];
  for (let b = 0; b < mine.length; b += bs) batches.push(mine.slice(b, b + bs));

  await Promise.all(
    batches.map(async (batch, n) => {
      try {
        const scores = await getMLSimilarities({
          candidateText: candClean.text,
          resultTexts: batch.map((x) => cleaned[x.i].text),
          timeoutMs,
        });
        batch.forEach((x, j) => {
          const raw = scores?.[j]?.similarityPercent;
          const percent = raw === null || raw === undefined ? NaN : Number(raw);
          inflight.delete(keys[x.i]);
          if (scores?.[j]?.status !== "SCORED" || !Number.isFinite(percent)) {
            out[x.i] = { similarityPercent: null, status: scores?.[j]?.status === "INVALID_INPUT" ? "INVALID_INPUT" : "UNAVAILABLE" };
            x.reject(new Error("ML returned no score for this text"));
            return;
          }
          cacheSet(keys[x.i], percent, cacheMax);
          out[x.i] = { similarityPercent: percent, status: "SCORED" };
          x.resolve(percent);
        });
        console.log(`BGE-M3 batch ${n + 1}/${batches.length} completed (${batch.length})`);
      } catch (error) {
        // failures are never cached; the result is explicitly UNAVAILABLE
        batch.forEach((x) => {
          out[x.i] = { similarityPercent: null, status: "UNAVAILABLE" };
          inflight.delete(keys[x.i]);
          x.reject(error);
        });
        console.error(`BGE-M3 batch ${n + 1}/${batches.length} unavailable (${error.code || error.message}) - ${batch.length} result(s) use rule-based ranking`);
      }
    })
  );

  await Promise.all(
    waiting.map(async ([i, p]) => {
      try {
        out[i] = { similarityPercent: await p, status: "CACHED" };
      } catch (e) {
        out[i] = { similarityPercent: null, status: "UNAVAILABLE" };
      }
    })
  );
  for (const [i, first] of dupes) out[i] = { ...out[first] };

  return out;
};

module.exports = {
  getMLSimilarities,
  scoreTexts,
  getMetrics,
  resetMetrics,
  resetState,
  ML_SERVICE_URL,
  cleanText,
};
