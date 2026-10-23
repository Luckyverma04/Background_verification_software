const tavilySearch = require("./tavilySearch.service");
const serperSearch = require("./serperProvider.service");

const providers = {};

// ---------------------------------------------------------------------
// Shared provider layer: process-wide concurrency limit, response cache
// (TTL, LRU, in-flight de-duplication) and metrics. The same query sent
// twice (same run or a repeated run) costs one provider call, not two.
// ---------------------------------------------------------------------
const metrics = { calls: 0, retries: 0, errors: 0, cacheHits: 0, dedupedInflight: 0, latencyMs: 0 };
const cache = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise

const cacheTtlMs = () => Math.max(Number(process.env.PROVIDER_CACHE_TTL_MS ?? 6 * 3600 * 1000) || 0, 0);
const cacheMax = () => Math.max(Number(process.env.PROVIDER_CACHE_MAX ?? 3000) || 0, 0);
const globalLimit = () => Math.max(Number(process.env.SEARCH_GLOBAL_CONCURRENCY ?? 8) || 1, 1);

let active = 0;
const waiters = [];
const acquire = () =>
  new Promise((resolve) => {
    if (active < globalLimit()) {
      active += 1;
      resolve();
    } else waiters.push(resolve);
  });
const release = () => {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
};

const cacheKey = (name, query, options) =>
  `${name}|${String(query).trim().toLowerCase()}|${JSON.stringify(options || {}, Object.keys(options || {}).sort())}`;

const getMetrics = () => ({ ...metrics });
const resetMetrics = () => {
  for (const k of Object.keys(metrics)) metrics[k] = 0;
};
const clearCache = () => {
  cache.clear();
  inflight.clear();
};

/**
 * Register a search provider
 */
const registerProvider = (name, provider) => {
  providers[name] = provider;
};

/**
 * Get a registered provider
 */
const getProvider = (name) => {
  const provider = providers[name];

  if (!provider) {
    throw new Error(`Search provider not registered: ${name}`);
  }

  return provider;
};

/**
 * Search using one provider
 */
const searchWithProvider = async (
  providerName,
  query,
  options = {},
  hooks = {}
) => {
  const provider = getProvider(providerName);

  if (typeof provider.search !== "function") {
    throw new Error(
      `Search provider "${providerName}" must implement search()`
    );
  }

  const ttl = cacheTtlMs();
  const useCache = ttl > 0 && !options?.noCache;
  const key = useCache ? cacheKey(providerName, query, options) : null;

  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) {
      cache.delete(key);
      cache.set(key, hit); // LRU touch
      metrics.cacheHits += 1;
      if (typeof hooks.onCacheHit === "function") hooks.onCacheHit();
      return hit.value;
    }
    if (hit) cache.delete(key);
    if (inflight.has(key)) {
      metrics.dedupedInflight += 1;
      if (typeof hooks.onCacheHit === "function") hooks.onCacheHit();
      return inflight.get(key);
    }
  }

  const work = (async () => {
    const value = await searchWithRetry(providerName, provider, query, options, hooks);
    if (useCache && cacheMax() > 0) {
      cache.set(key, { at: Date.now(), value });
      while (cache.size > cacheMax()) cache.delete(cache.keys().next().value);
    }
    return value;
  })();

  if (!useCache) return work;
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
};

// ---------------------------------------------------------------------
// Retries: rate limits (429), provider 5xx and timeouts are retried with
// exponential backoff (Retry-After is honoured). Anything else (bad key,
// 4xx) fails immediately - retrying would only burn paid quota.
// ---------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (error) => {
  const status = error?.response?.status ?? error?.status;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(error?.code);
};

/**
 * hooks.onCacheHit() is called instead when the answer comes from the cache
 * (or a shared in-flight request): no provider call, no budget used.
 * hooks.beforeAttempt(providerName, attemptNumber) is called before EVERY
 * real provider request, retries included. Returning false means "no
 * capacity left": the request is not sent and the error is not retried.
 * This is how callers enforce a call budget on actual provider attempts.
 */
const searchWithRetry = async (providerName, provider, query, options, hooks = {}) => {
  const maxRetries = Math.max(
    Number(process.env.PROVIDER_MAX_RETRIES ?? 2) || 0,
    0
  );
  const baseMs = Number(process.env.PROVIDER_RETRY_BASE_MS ?? 800);

  let attempt = 0;
  for (;;) {
    if (typeof hooks.beforeAttempt === "function" && hooks.beforeAttempt(providerName, attempt + 1) === false) {
      const stop = new Error("Provider call budget exhausted");
      stop.code = "CALL_BUDGET_EXHAUSTED";
      throw stop;
    }

    const started = Date.now();
    let released = false;
    await acquire();
    try {
      metrics.calls += 1;
      return await provider.search(query, options);
    } catch (error) {
      metrics.errors += 1;
      if (attempt >= maxRetries || !isRetryable(error)) throw error;

      const retryAfter = Number(error?.response?.headers?.["retry-after"]);
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10000)
        : baseMs * 2 ** attempt;

      attempt += 1;
      metrics.retries += 1;
      release();
      released = true;
      await sleep(wait);
    } finally {
      if (!released) release();
      metrics.latencyMs += Date.now() - started;
    }
  }
};

/**
 * Search using multiple providers
 */
const searchWithProviders = async (
  providerNames,
  query,
  options = {},
  hooks = {}
) => {
  const results = [];

  for (const providerName of providerNames) {
    try {
      const providerResults = await searchWithProvider(
        providerName,
        query,
        options,
        hooks
      );

      results.push({
        provider: providerName,
        success: true,
        results: providerResults,
      });
    } catch (error) {
      console.error(
        `${providerName} search failed:`,
        error.message
      );

      results.push({
        provider: providerName,
        success: false,
        results: [],
        error: error.message,
        ...(error.code === "CALL_BUDGET_EXHAUSTED" ? { budgetExhausted: true } : {}),
      });
    }
  }

  return results;
};

/**
 * Register search providers
 */
registerProvider("tavily", tavilySearch);
registerProvider("serper", serperSearch);

module.exports = {
  registerProvider,
  getProvider,
  searchWithProvider,
  searchWithProviders,
  getMetrics,
  resetMetrics,
  clearCache,
};