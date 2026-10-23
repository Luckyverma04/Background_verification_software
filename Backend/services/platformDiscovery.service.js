"use strict";

/**
 * platformDiscovery.service.js
 *
 * Per-platform profile discovery.
 *
 * Every supported platform (utils/platforms.js) gets its OWN discovery loop,
 * its OWN target (default 15 unique profile-shaped URLs) and its OWN
 * counters. Reaching the target on LinkedIn never stops the search on
 * Instagram, GitHub, YouTube ... and vice versa.
 *
 * Definitions (all counted per platform):
 *   discovered   raw provider hits whose URL belongs to the platform
 *   uniqueUrls   distinct canonical URLs among them
 *   profileShapedUrls  unique URLs whose SHAPE is a person's profile page
 *                  (not a search page, post, repo, article ...). This is
 *                  not a reachability check; see `reachability` below.
 *   enriched     profiles for which a structured public source answered
 *   reachability counted separately (REACHABLE / NOT_FOUND / UNREACHABLE /
 *                NOT_CHECKED) from what the enrichment step really requested
 *   relevant     profiles the ranking judged relevant (set after matching)
 *
 * Discovery stops for a platform when it has `target` profile-shaped URLs, when
 * its query list is exhausted, or when the shared call budget is spent.
 * A shortfall is reported, never filled with unrelated profiles.
 *
 * Only public search providers are used; nothing here logs in to a platform
 * or bypasses a CAPTCHA / access restriction.
 */

const { PLATFORMS } = require("../utils/platforms");
const { searchWithProviders } = require("./searchProvider.service");
const {
  normalizeUrl,
  detectPlatform,
  extractProfileIdentifier,
} = require("./resultMerge.service");
const { canonicalProfileKey, getCandidateSocialUrls } = require("../utils/candidateUrls");

// ---------------------------------------------------------------------
// Configuration (all overridable through environment variables)
// ---------------------------------------------------------------------

const DEFAULT_TARGET = 15;

const getConfig = () => {
  let overrides = {};
  try {
    overrides = process.env.PLATFORM_TARGETS ? JSON.parse(process.env.PLATFORM_TARGETS) : {};
  } catch (e) {
    overrides = {};
  }

  const enabledList = String(process.env.PLATFORM_DISCOVERY_PLATFORMS || "")
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);

  return {
    enabled: process.env.PLATFORM_DISCOVERY !== "false",
    target: Math.max(Number(process.env.PLATFORM_DISCOVERY_TARGET) || DEFAULT_TARGET, 1),
    overrides,
    enabledList,
    maxQueries: Math.max(Number(process.env.PLATFORM_MAX_QUERIES) || 4, 1),
    pages: Math.max(Number(process.env.PLATFORM_DISCOVERY_PAGES) || 2, 1),
    concurrency: Math.max(Number(process.env.PLATFORM_DISCOVERY_CONCURRENCY) || 6, 1),
    // stop a platform after this many CONSECUTIVE queries added no new
    // profile-shaped URL (0 disables); reported as NO_NEW_RESULTS, never hidden
    stallQueries: Math.max(Number(process.env.PLATFORM_STALL_QUERIES ?? 2) || 0, 0),
    // wall-clock budget for the whole phase (0 = unlimited). Platforms not
    // started in time are reported as SKIPPED_TIME_BUDGET, not as "not found".
    timeBudgetMs: Math.max(Number(process.env.PLATFORM_DISCOVERY_TIME_BUDGET_MS ?? 90000) || 0, 0),
    maxCalls: Math.max(Number(process.env.PLATFORM_DISCOVERY_MAX_CALLS) || 600, 1),
    // Opt-in only. A confirmed / candidate-supplied profile does NOT stop fresh
    // discovery by default (the stored knowledge is kept either way).
    skipCovered: process.env.PLATFORM_DISCOVERY_SKIP_COVERED === "true",
  };
};

const targetFor = (cfg, key) => {
  const o = Number(cfg.overrides?.[key]);
  return Number.isFinite(o) && o > 0 ? Math.floor(o) : cfg.target;
};

const getEnabledPlatforms = (cfg = getConfig()) =>
  PLATFORMS.filter((p) => !cfg.enabledList.length || cfg.enabledList.includes(p.key));

// ---------------------------------------------------------------------
// URL validation: is this URL a person's profile page on that platform?
// ---------------------------------------------------------------------

const RESERVED_FIRST_SEGMENT = new Set([
  "search", "explore", "home", "login", "signup", "sign-up", "signin", "about",
  "pricing", "docs", "blog", "help", "support", "jobs", "topics", "tag", "tags",
  "trending", "discover", "feed", "settings", "terms", "privacy", "models",
  "datasets", "spaces", "competitions", "courses", "learn", "questions", "posts",
  "pulse", "company", "school", "groups", "events", "hashtag", "watch", "results",
  "playlist", "shorts", "feed", "i", "intent", "share", "sharer", "dialog", "pub",
  "directory", "dir",
]);

const SINGLE_SEGMENT_PLATFORMS = new Set([
  "GITHUB", "TWITTER", "INSTAGRAM", "GITLAB", "BITBUCKET", "DRIBBBLE", "BEHANCE",
  "PINTEREST", "KAGGLE", "DEVTO", "ABOUT_ME", "LINKTREE", "CODEPEN", "HASHNODE",
  "PEERLIST", "HUGGINGFACE", "LEETCODE",
]);

/**
 * URL SHAPE only: does the URL look like a person's profile page on the
 * platform (right host, a username segment, not a search / post / repo /
 * article path)? It says NOTHING about whether the page exists or is
 * reachable - that is tracked separately (enrichment.reachability).
 */
const hasProfileUrlShape = (url, platformKey) => {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (e) {
    return false;
  }

  const platform = platformKey || detectPlatform(normalized);
  if (!platform || platform === "WEBSITE" || platform === "OTHER") return false;
  if (detectPlatform(normalized) !== platform) return false;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const first = (parts[0] || "").toLowerCase();

  // platform-specific shapes that carry no username
  if (platform === "SCHOLAR") {
    return /\/citations/i.test(parsed.pathname) && !!parsed.searchParams.get("user");
  }
  if (platform === "NAUKRI") return first === "mnjuser" || first === "profile";
  if (platform === "FACEBOOK" && first === "profile.php") {
    return !!parsed.searchParams.get("id");
  }
  if (platform === "FACEBOOK" && ["pages", "groups", "events", "watch", "marketplace", "public", "people"].includes(first)) {
    return false;
  }

  const { profileId, username } = extractProfileIdentifier(normalized, platform);
  if (!profileId && !username) return false;

  if (SINGLE_SEGMENT_PLATFORMS.has(platform)) {
    if (parts.length !== 1) return false;
    if (RESERVED_FIRST_SEGMENT.has(first)) return false;
    // lone file-like pages (robots.txt, favicon.ico ...)
    if (/\.[a-z]{2,4}$/i.test(first)) return false;
  }

  if (platform === "LINKEDIN") {
    const idx = parts.findIndex((p) => p.toLowerCase() === "in");
    return idx === 0 && !!parts[1];
  }

  if (platform === "FACEBOOK" && RESERVED_FIRST_SEGMENT.has(first)) return false;
  if (platform === "YOUTUBE" && parts.length > 2 && !["c", "user", "channel"].includes(first)) return false;

  return true;
};

// ---------------------------------------------------------------------
// Shared call budget. Capacity is RESERVED synchronously before each real
// provider request (retries included), so concurrent platform workers can
// never overspend: JS runs this check-and-increment atomically, before any
// await.
// Unit = actual provider ATTEMPT. A "logical request" that is retried twice
// costs 3 and is reported as 1 request + 2 retry attempts.
// ---------------------------------------------------------------------

const createBudget = (limit) => ({
  limit,
  used: 0,
  reserve() {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  },
  available() {
    return this.used < this.limit;
  },
});

// ---------------------------------------------------------------------
// Platform-specific queries
// ---------------------------------------------------------------------

const nameVariants = (fullName) => {
  const tokens = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  const variants = [tokens.join(" ")];
  if (tokens.length > 2) variants.push(`${tokens[0]} ${tokens[tokens.length - 1]}`);
  return [...new Set(variants.filter(Boolean))];
};

const knownUsernamesFor = (candidate, signals, platformKey) => {
  const out = new Set();
  const urls = getCandidateSocialUrls(candidate);
  for (const url of Object.values(urls)) {
    const platform = detectPlatform(url);
    const { username } = extractProfileIdentifier(url, platform);
    // handles used on OTHER platforms are likely reused on this one
    if (username && platform !== platformKey && username.length >= 4) out.add(username);
  }
  // handles from profiles a reviewer already verified are trusted seeds
  for (const handle of signals.verifiedUsernames || []) {
    if (handle && handle.length >= 4) out.add(handle);
  }
  if (signals.emailUser && signals.emailUser.length >= 5 && !/^(info|admin|contact|hello|mail|support|sales)/i.test(signals.emailUser)) {
    out.add(signals.emailUser);
  }
  return [...out].slice(0, 3);
};

/**
 * Ordered, platform-specific queries (most identifying first). A name-only
 * query is produced only when the candidate has no other detail at all.
 */
const buildPlatformQueries = (candidate, platform, signals, maxQueries) => {
  const names = nameVariants(candidate?.fullName);
  if (!names.length) return { queries: [], nameOnly: false };

  const [name] = names;
  const site = platform.site;
  const q = [];

  const anchors = [
    ...signals.companies.slice(0, 1),
    ...signals.institutions.slice(0, 1),
    signals.city,
    ...signals.titles.slice(0, 1),
    signals.state,
    ...signals.companies.slice(1, 2),
    signals.country,
  ].filter(Boolean);

  const uniqueAnchors = [...new Set(anchors)];

  for (const anchor of uniqueAnchors) q.push(`site:${site} "${name}" "${anchor}"`);

  // a different spelling of the name with the strongest anchor
  if (names[1] && uniqueAnchors[0]) q.push(`site:${site} "${names[1]}" "${uniqueAnchors[0]}"`);

  // handles known from the candidate's other profiles / e-mail
  for (const handle of knownUsernamesFor(candidate, signals, platform.key)) {
    q.push(`site:${site} "${handle}"`);
  }

  let nameOnly = false;
  if (!q.length) {
    q.push(`site:${site} "${name}"`);
    nameOnly = true;
  }

  // Twitter/X is indexed under two hosts
  if (platform.alt?.length && uniqueAnchors[0]) {
    q.push(`site:${platform.alt[0].site} "${name}" "${uniqueAnchors[0]}"`);
  }

  return {
    queries: [...new Set(q)].slice(0, maxQueries),
    nameOnly,
  };
};

// ---------------------------------------------------------------------
// Counting helpers
// ---------------------------------------------------------------------

const rawUrl = (r) => r?.url || r?.link || null;

const keyOf = (url) => {
  const n = normalizeUrl(url);
  return n ? canonicalProfileKey(n) || n : null;
};

/** Tallies raw provider results per platform (discovered / unique / profile-shaped). */
const tallyRawResults = (rawResults = []) => {
  const byPlatform = {};
  for (const r of rawResults) {
    const url = rawUrl(r);
    const n = normalizeUrl(url);
    if (!n) continue;
    const platform = detectPlatform(n);
    if (!platform || platform === "WEBSITE" || platform === "OTHER") continue;

    const t = (byPlatform[platform] ||= { discovered: 0, unique: new Set(), shaped: new Set() });
    t.discovered += 1;
    const key = keyOf(n);
    t.unique.add(key);
    if (hasProfileUrlShape(n, platform)) t.shaped.add(key);
  }
  return byPlatform;
};

// ---------------------------------------------------------------------
// One platform
// ---------------------------------------------------------------------

const discoverPlatform = async ({
  candidate,
  platform,
  signals,
  cfg,
  budget,
  initialShaped = new Set(),
  seenQueries,
}) => {
  const target = targetFor(cfg, platform.key);
  const { queries, nameOnly } = buildPlatformQueries(candidate, platform, signals, cfg.maxQueries);

  const out = {
    platform: platform.key,
    target,
    tavilyResults: [],
    serperResults: [],
    queries: [],
    nameOnlyQuery: nameOnly,
    providerCalls: 0, // logical requests that were actually sent
    providerCallsOk: 0,
    providerAttempts: 0, // real provider attempts, retries included
    retryAttempts: 0,
    providerErrors: [],
    stoppedBecause: null,
  };

  const shaped = new Set(initialShaped);
  let stall = 0;
  const deadline = cfg.deadlineAt || 0;
  const count = (results) => {
    for (const r of results) {
      const n = normalizeUrl(rawUrl(r));
      if (!n) continue;
      if (detectPlatform(n) === platform.key && hasProfileUrlShape(n, platform.key)) {
        shaped.add(keyOf(n));
      }
    }
  };

  if (!queries.length) {
    out.stoppedBecause = "NO_QUERY_POSSIBLE";
    out.profileShapedUrls = shaped.size;
    return out;
  }

  for (const query of queries) {
    if (shaped.size >= target) {
      out.stoppedBecause = "TARGET_REACHED";
      break;
    }
    if (!budget.available()) {
      out.stoppedBecause = "CALL_BUDGET_EXHAUSTED";
      break;
    }

    const dedupeKey = query.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenQueries.has(dedupeKey)) continue;
    seenQueries.add(dedupeKey);

    out.queries.push(query);

    const siteMatch = query.match(/site:(\S+)/);
    const domain = siteMatch ? siteMatch[1].split("/")[0] : platform.domain;
    const tavilyQuery = query.replace(/site:\S+\s*/g, "").trim() || query;

    // One logical request = one provider call + its retries. Every real
    // attempt reserves budget first; with no capacity nothing is sent.
    const request = async (provider, q, opts) => {
      let attempts = 0;
      let cached = false;
      const [res] = await searchWithProviders([provider], q, opts, {
        beforeAttempt: () => {
          if (!budget.reserve()) return false;
          attempts += 1;
          return true;
        },
        // answered from the cache: costs no provider call and no budget
        onCacheHit: () => {
          cached = true;
        },
      });

      if (attempts === 0 && !cached) {
        out.stoppedBecause = "CALL_BUDGET_EXHAUSTED";
        return null; // not sent, not counted as a request
      }

      out.providerCalls += 1;
      out.providerAttempts += attempts;
      out.retryAttempts += Math.max(attempts - 1, 0);
      if (cached) out.cacheHits = (out.cacheHits || 0) + 1;

      if (res.budgetExhausted) out.stoppedBecause = "CALL_BUDGET_EXHAUSTED";

      if (res.success) {
        out.providerCallsOk += 1;
        return res.results || [];
      }
      out.providerErrors.push(`${res.provider}: ${res.error}`);
      return [];
    };

    if (deadline && Date.now() > deadline) {
      out.stoppedBecause = "TIME_BUDGET_EXHAUSTED";
      break;
    }
    const shapedBefore = shaped.size;

    // Tavily first (one domain-restricted request); Serper pages only while
    // the target is still unmet - a satisfied platform costs one call.
    // (Platforms run concurrently with each other, so latency is hidden.)
    const tavResults = await request("tavily", tavilyQuery, {
      maxResults: Number(process.env.TAVILY_MAX_RESULTS) || 20,
      includeDomains: [domain],
    });
    if (tavResults) {
      out.tavilyResults.push(...tavResults);
      count(tavResults);
    }
    for (let page = 1; page <= cfg.pages; page++) {
      if (shaped.size >= target || !budget.available()) break;
      const serResults = await request("serper", query, {
        maxResults: 10,
        ...(page > 1 ? { page } : {}),
      });
      if (serResults === null) break;
      out.serperResults.push(...serResults);
      count(serResults);
      if (serResults.length < 5) break;
    }

    stall = shaped.size > shapedBefore ? 0 : stall + 1;
    if (cfg.stallQueries && stall >= cfg.stallQueries && shaped.size < target) {
      out.stoppedBecause = "NO_NEW_RESULTS";
      break;
    }

    if (out.stoppedBecause === "CALL_BUDGET_EXHAUSTED") break;
  }

  if (!out.stoppedBecause) {
    out.stoppedBecause = shaped.size >= target ? "TARGET_REACHED" : "QUERIES_EXHAUSTED";
  }
  out.profileShapedUrls = shaped.size;
  return out;
};

const runPool = async (items, concurrency, worker) => {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await worker(item);
      }
    })
  );
};

/**
 * Runs the independent discovery loops.
 *
 * @param {object}  candidate
 * @param {object}  signals          getCandidateSignals(candidate)
 * @param {object}  opts
 * @param {Array}   opts.rawTavily   results already found by earlier phases
 * @param {Array}   opts.rawSerper
 * @param {string[]} opts.coveredPlatforms platforms that already hold a confirmed profile
 * @param {Set}     opts.seenQueries
 */
const runPlatformDiscovery = async (
  candidate,
  signals,
  { rawTavily = [], rawSerper = [], coveredPlatforms = [], knownProfileUrls = [], seenQueries = new Set() } = {}
) => {
  const cfg = getConfig();
  const platforms = getEnabledPlatforms(cfg);
  const covered = new Set(coveredPlatforms.map((p) => String(p).toUpperCase()));
  const budget = createBudget(cfg.maxCalls);

  // what earlier phases (global discovery) already found ...
  const earlier = tallyRawResults([...rawTavily, ...rawSerper]);

  // ... plus profiles we already hold (knowledge base, candidate-supplied
  // links). They count toward the platform's target, but they never stop
  // fresh discovery (only the opt-in PLATFORM_DISCOVERY_SKIP_COVERED does).
  for (const url of knownProfileUrls) {
    const n = normalizeUrl(url);
    if (!n) continue;
    const platform = detectPlatform(n);
    if (!platform || platform === "WEBSITE" || platform === "OTHER") continue;
    if (!hasProfileUrlShape(n, platform)) continue;
    const t = (earlier[platform] ||= { discovered: 0, unique: new Set(), shaped: new Set() });
    t.unique.add(keyOf(n));
    t.shaped.add(keyOf(n));
  }

  const perPlatform = {};
  const tavilyResults = [];
  const serperResults = [];

  const runCfg = { ...cfg, deadlineAt: cfg.timeBudgetMs ? Date.now() + cfg.timeBudgetMs : 0 };

  // platforms that still need profiles go first (fewest already-found first)
  const ordered = [...platforms].sort(
    (a, b) => (earlier[a.key]?.shaped.size || 0) - (earlier[b.key]?.shaped.size || 0)
  );

  await runPool(ordered, cfg.concurrency, async (platform) => {
    const before = earlier[platform.key];
    const target = targetFor(cfg, platform.key);

    if (cfg.skipCovered && covered.has(platform.key)) {
      perPlatform[platform.key] = {
        platform: platform.key,
        target,
        queries: [],
        providerCalls: 0,
        providerCallsOk: 0,
        providerErrors: [],
        stoppedBecause: "COVERED_BY_CONFIRMED_PROFILE",
        skipped: true,
      };
      return;
    }

    if (runCfg.deadlineAt && Date.now() > runCfg.deadlineAt) {
      perPlatform[platform.key] = {
        platform: platform.key, target, queries: [], providerCalls: 0, providerCallsOk: 0,
        providerErrors: [], stoppedBecause: "TIME_BUDGET_EXHAUSTED", skippedByTime: true,
      };
      return;
    }

    try {
      const result = await discoverPlatform({
        candidate,
        platform,
        signals,
        cfg: runCfg,
        budget,
        initialShaped: before?.shaped || new Set(),
        seenQueries,
      });
      perPlatform[platform.key] = result;
      tavilyResults.push(...result.tavilyResults);
      serperResults.push(...result.serperResults);
    } catch (error) {
      // one platform failing never stops the others
      perPlatform[platform.key] = {
        platform: platform.key,
        target,
        queries: [],
        providerCalls: 0,
        providerCallsOk: 0,
        providerErrors: [String(error.message).slice(0, 200)],
        stoppedBecause: "ERROR",
        failed: true,
      };
    }
  });

  return {
    perPlatform,
    tavilyResults,
    serperResults,
    // unit = real provider attempts (retries included)
    callsUsed: budget.used,
    callBudget: cfg.maxCalls,
    logicalRequests: Object.values(perPlatform).reduce((n, r) => n + (r.providerCalls || 0), 0),
    retryAttempts: Object.values(perPlatform).reduce((n, r) => n + (r.retryAttempts || 0), 0),
    target: cfg.target,
  };
};

// ---------------------------------------------------------------------
// Summary (counts + status per platform)
// ---------------------------------------------------------------------

const STATUS = {
  TARGET_REACHED: "TARGET_REACHED",
  SHORTFALL: "SHORTFALL",
  NOT_FOUND: "NOT_FOUND",
  FAILED: "FAILED",
  COVERED: "COVERED_BY_CONFIRMED_PROFILE",
  SKIPPED_BUDGET: "SKIPPED_CALL_BUDGET",
  SKIPPED_TIME: "SKIPPED_TIME_BUDGET",
};

/**
 * Builds the per-platform summary stored on the BGV run.
 *
 * @param {object} p
 * @param {object} p.discovery     return value of runPlatformDiscovery
 * @param {Array}  p.rawTavily     ALL raw tavily results (every phase)
 * @param {Array}  p.rawSerper
 * @param {object} p.storedByPlatform { PLATFORM: [{key, valid, enriched}] } of stored rows
 */
const buildPlatformSummary = ({ discovery, rawTavily = [], rawSerper = [], storedByPlatform = {}, confirmedPlatforms = [] }) => {
  const cfg = getConfig();
  const tally = tallyRawResults([...rawTavily, ...rawSerper]);
  const summary = {};
  const confirmed = new Set(confirmedPlatforms.map((p) => String(p).toUpperCase()));

  for (const platform of getEnabledPlatforms(cfg)) {
    const key = platform.key;
    const run = discovery?.perPlatform?.[key] || {};
    const t = tally[key];
    const target = targetFor(cfg, key);

    // raw provider hits of every phase + rows that exist in the database
    // (knowledge base / candidate-supplied links are stored but not "raw")
    const stored = storedByPlatform[key] || [];
    const uniqueSet = new Set([...(t ? t.unique : []), ...stored.map((x) => x.key)]);
    const validSet = new Set([...(t ? t.shaped : []), ...stored.filter((x) => x.shape).map((x) => x.key)]);
    const profileShapedUrls = validSet.size;

    // Reachability is measured only where a request was really made
    // (enrichment). URL shape never implies the page is live.
    const reach = { reachable: 0, notFound: 0, unreachable: 0, notChecked: 0 };
    for (const x of stored) {
      const st = x.reachability || "NOT_CHECKED";
      if (st === "REACHABLE") reach.reachable += 1;
      else if (st === "NOT_FOUND") reach.notFound += 1;
      else if (st === "UNREACHABLE") reach.unreachable += 1;
      else reach.notChecked += 1;
    }

    let status;
    if (run.skipped) status = STATUS.COVERED;
    else if (run.failed || (run.providerCalls > 0 && run.providerCallsOk === 0)) status = STATUS.FAILED;
    else if (run.stoppedBecause === "CALL_BUDGET_EXHAUSTED" && profileShapedUrls < target) status = STATUS.SKIPPED_BUDGET;
    else if (run.stoppedBecause === "TIME_BUDGET_EXHAUSTED" && profileShapedUrls < target) status = STATUS.SKIPPED_TIME;
    else if (profileShapedUrls >= target) status = STATUS.TARGET_REACHED;
    else if (profileShapedUrls > 0) status = STATUS.SHORTFALL;
    else status = STATUS.NOT_FOUND;

    summary[key] = {
      platform: key,
      group: platform.group,
      target,
      status,
      stoppedBecause: run.stoppedBecause || null,
      discovered: t ? t.discovered : 0,
      uniqueUrls: uniqueSet.size,
      profileShapedUrls,
      invalidUrls: uniqueSet.size - validSet.size,
      stored: stored.length,
      reachability: reach,
      hasConfirmedProfile: confirmed.has(key),
      enriched: stored.filter((x) => x.enriched).length,
      relevant: 0, // filled after matching by refreshPlatformRelevance
      discoveryShortfall: Math.max(target - profileShapedUrls, 0),
      relevanceShortfall: target,
      queriesRun: (run.queries || []).length,
      queries: (run.queries || []).slice(0, 6),
      nameOnlyQuery: !!run.nameOnlyQuery,
      providerCalls: run.providerCalls || 0,
      providerCallsOk: run.providerCallsOk || 0,
      providerAttempts: run.providerAttempts || 0,
      retryAttempts: run.retryAttempts || 0,
      errors: [...new Set(run.providerErrors || [])].slice(0, 3),
    };
  }

  return summary;
};

module.exports = {
  createBudget,
  getConfig,
  getEnabledPlatforms,
  targetFor,
  hasProfileUrlShape,
  buildPlatformQueries,
  tallyRawResults,
  discoverPlatform,
  runPlatformDiscovery,
  buildPlatformSummary,
  STATUS,
};
