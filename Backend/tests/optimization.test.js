"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");
const { normalizeLocation } = require("../utils/locationNormalizer");
const { canonicalProfileKey } = require("../utils/candidateUrls");
const { normalizeUrl } = require("../services/resultMerge.service");
const providerLayer = require("../services/searchProvider.service");
const mlService = require("../services/mlMatch.service");
const searchSvc = require("../services/candidateSearch.service");
const ranking = require("../services/candidateMatchRanking.service");

let ctx;

test.before(async () => {
  ctx = await H.startAll();
  process.env.PROVIDER_RETRY_BASE_MS = "1";
});
test.after(async () => ctx.stop());

const CAND = {
  fullName: "Amit Sharma",
  email: "amit.sharma.dev@example.com",
  location: { city: "Dewas", state: "Maharashtra", country: "India" }, // wrong state on purpose
  currentCompany: "Infosys",
  currentJobTitle: "Software Engineer",
};

const world = (q, o = {}) => {
  const d = (o.includeDomains && o.includeDomains[0]) || (String(q).match(/site:(\S+)/) || [])[1] || null;
  if (d && d.includes("linkedin")) {
    return [
      { title: "Amit Sharma - Software Engineer - Infosys | LinkedIn", link: "https://www.linkedin.com/in/amit-sharma-dewas", snippet: "Dewas, Madhya Pradesh, India · Software Engineer · Infosys." },
      { title: "Amit Sharma - Geologist - Shell | LinkedIn", link: "https://www.linkedin.com/in/amit-sharma-houston", snippet: "Houston, Texas · Geologist · Shell." },
    ];
  }
  if (d && d.includes("github")) return [{ title: "amitsharma (Amit Sharma) · GitHub", link: "https://github.com/amitsharma", snippet: "Amit Sharma. Infosys. Dewas." }];
  return [];
};
const asTavily = (rows) => rows.map((r) => ({ title: r.title, url: r.link, content: r.snippet, score: 0.6 }));

const install = () =>
  H.setProviders({
    serper: (q, o) => world(q, o),
    tavily: (q, o) => asTavily(world(q, o)),
  });

// ------------------------------------------------------------------
// location
// ------------------------------------------------------------------
test("O1. Dewas + Maharashtra is repaired to Madhya Pradesh; unknown / foreign / missing locations are left alone", () => {
  const fixed = normalizeLocation({ city: "Dewas", state: "Maharashtra", country: "India" });
  assert.equal(fixed.state, "Madhya Pradesh");
  assert.equal(fixed.conflicts.length, 1);
  assert.equal(normalizeLocation({ city: "Dewas" }).state, "Madhya Pradesh");
  assert.equal(normalizeLocation({ state: "MP" }).state, "Madhya Pradesh");
  // a city name that exists elsewhere is NOT forced into India
  assert.equal(normalizeLocation({ city: "Salem", state: "Oregon" }).state, "Oregon");
  assert.equal(normalizeLocation({ city: "Springfield", state: "Illinois" }).state, "Illinois");
  // missing location stays missing
  const none = normalizeLocation(null);
  assert.deepEqual([none.city, none.state, none.country], ["", "", ""]);
});

test("O2. search queries never combine Dewas with Maharashtra; state/country are a controlled fallback", () => {
  const plan = { fallback: [] };
  const primary = searchSvc.buildSearchQueries(CAND, plan);
  assert.ok(primary.some((q) => q.includes('"Dewas" "Madhya Pradesh"')));
  for (const q of [...primary, ...plan.fallback]) assert.ok(!/Maharashtra/.test(q), q);
  // precise queries first; the state-only query is NOT in the primary tier
  assert.ok(!primary.some((q) => q === '"Amit Sharma" "Madhya Pradesh"'));
  assert.ok(plan.fallback.includes('"Amit Sharma" "Madhya Pradesh"'));
  // company / email signals are kept
  assert.ok(primary.some((q) => q.includes('"Infosys"')));
  assert.ok(primary.some((q) => q.includes("amit.sharma.dev")));
  // flat list stays available (compatibility)
  assert.ok(searchSvc.buildSearchQueries(CAND).length >= primary.length);
});

test("O3. matcher: a missing candidate location is never a mismatch; wrong stored state does not penalise the right city", () => {
  const ms = require("../services/matchSignals.service");
  assert.equal(ms.compareLocation(null, { city: "Pune", state: "Maharashtra" }, "").state, "UNKNOWN");
  assert.equal(ms.compareLocation({ city: "Dewas", state: "Maharashtra", country: "India" }, { city: "Dewas", state: "Madhya Pradesh", country: "India" }, "").state, "MATCH");
  assert.equal(ms.compareLocation({ city: "Dewas", state: "Maharashtra", country: "India" }, { city: "Pune", state: "Maharashtra", country: "India" }, "").state, "MISMATCH");
});

// ------------------------------------------------------------------
// URL normalisation
// ------------------------------------------------------------------
test("O4. URL variants of one profile share one canonical key", () => {
  const variants = [
    "https://www.linkedin.com/in/amit-sharma-dewas",
    "http://linkedin.com/in/amit-sharma-dewas/",
    "https://in.linkedin.com/in/amit-sharma-dewas?trk=public",
    "HTTPS://WWW.LINKEDIN.COM/in/Amit-Sharma-Dewas/#about",
  ].map((u) => canonicalProfileKey(normalizeUrl(u)));
  assert.equal(new Set(variants).size, 1, JSON.stringify(variants));
  assert.notEqual(canonicalProfileKey(normalizeUrl("https://github.com/amitsharma")), canonicalProfileKey(normalizeUrl("https://github.com/amitsharma2")));
});

// ------------------------------------------------------------------
// provider layer
// ------------------------------------------------------------------
test("O5. provider cache: identical query is one provider call; concurrent identical queries share it; failures are not cached", async () => {
  process.env.PROVIDER_CACHE_TTL_MS = "60000";
  try {
    providerLayer.clearCache();
    providerLayer.resetMetrics();
    H.resetProviderCalls();
    install();
    const a = await providerLayer.searchWithProviders(["serper"], '"Amit Sharma" "Dewas"', { maxResults: 10 });
    const b = await providerLayer.searchWithProviders(["serper"], '"amit sharma" "dewas"  ', { maxResults: 10 });
    assert.equal(H.providerCalls.serper.length, 1);
    assert.equal(providerLayer.getMetrics().cacheHits, 1);
    assert.deepEqual(a[0].results, b[0].results);

    // different options (page 2) are a different request
    await providerLayer.searchWithProviders(["serper"], '"Amit Sharma" "Dewas"', { maxResults: 10, page: 2 });
    assert.equal(H.providerCalls.serper.length, 2);

    // concurrent identical -> one call
    H.resetProviderCalls();
    await Promise.all([1, 2, 3].map(() => providerLayer.searchWithProviders(["tavily"], "concurrent q", {})));
    assert.equal(H.providerCalls.tavily.length, 1);

    // failures are not cached
    let boom = true;
    H.setProviders({ serper: () => { if (boom) throw Object.assign(new Error("bad key"), { response: { status: 401 } }); return []; } });
    H.resetProviderCalls();
    const f1 = await providerLayer.searchWithProviders(["serper"], "fails once", {});
    assert.equal(f1[0].success, false);
    boom = false;
    const f2 = await providerLayer.searchWithProviders(["serper"], "fails once", {});
    assert.equal(f2[0].success, true);
  } finally {
    process.env.PROVIDER_CACHE_TTL_MS = "0";
    providerLayer.clearCache();
    install();
  }
});

// ------------------------------------------------------------------
// ML
// ------------------------------------------------------------------
test("O6. ML failure is UNAVAILABLE (null) - never a similarity of 0; breaker stops hammering; recovers; cache is text-keyed", async () => {
  mlService.resetState();
  mlService.resetMetrics();
  const texts = ["Amit Sharma Infosys Dewas engineer", "Someone Else Shell Houston geologist"];

  ctx.mlState.fail = true;
  const failed = await ranking.getMLScoresBatched({ candidateText: "Amit Sharma Infosys Dewas", resultTexts: texts, mlConfig: { batchSize: 20 } });
  assert.deepEqual(failed.map((x) => x.status), ["UNAVAILABLE", "UNAVAILABLE"]);
  assert.deepEqual(failed.map((x) => x.similarityPercent), [null, null]);

  // second failure opens the breaker; further calls do not reach the service
  await ranking.getMLScoresBatched({ candidateText: "Amit Sharma Infosys Dewas", resultTexts: ["another text a"], mlConfig: {} });
  const before = ctx.mlState.requests;
  const skipped = await ranking.getMLScoresBatched({ candidateText: "Amit Sharma Infosys Dewas", resultTexts: ["another text b"], mlConfig: {} });
  assert.equal(skipped[0].status, "UNAVAILABLE");
  assert.equal(ctx.mlState.requests, before, "breaker open: no request sent");
  assert.ok(mlService.getMetrics().breakerSkips >= 1);

  // recovery after the cool-down; failures were never cached
  ctx.mlState.fail = false;
  await new Promise((r) => setTimeout(r, 80));
  const ok = await ranking.getMLScoresBatched({ candidateText: "Amit Sharma Infosys Dewas", resultTexts: texts, mlConfig: {} });
  assert.deepEqual(ok.map((x) => x.status), ["SCORED", "SCORED"]);
  assert.ok(ok[0].similarityPercent > ok[1].similarityPercent);

  // identical pair again -> cache, no request; changed text -> new request
  const r0 = ctx.mlState.requests;
  const again = await ranking.getMLScoresBatched({ candidateText: "Amit Sharma Infosys Dewas", resultTexts: texts, mlConfig: {} });
  assert.deepEqual(again.map((x) => x.status), ["CACHED", "CACHED"]);
  assert.equal(ctx.mlState.requests, r0);
  await ranking.getMLScoresBatched({ candidateText: "Amit Sharma Infosys Dewas", resultTexts: [texts[0] + " updated bio"], mlConfig: {} });
  assert.equal(ctx.mlState.requests, r0 + 1);
});

test("O7. ML: identical in-flight pairs are scored once; concurrency is bounded", async () => {
  mlService.resetState();
  ctx.mlState.delayMs = 60;
  ctx.mlState.maxInflight = 0;
  ctx.mlState.requests = 0;
  try {
    const cand = "Amit Sharma Infosys Dewas";
    const same = ["text one engineer", "text two engineer"];
    const [a, b] = await Promise.all([
      ranking.getMLScoresBatched({ candidateText: cand, resultTexts: same, mlConfig: {} }),
      ranking.getMLScoresBatched({ candidateText: cand, resultTexts: same, mlConfig: {} }),
    ]);
    assert.equal(ctx.mlState.requests, 1, "second caller waits for the first");
    assert.deepEqual(a.map((x) => x.similarityPercent), b.map((x) => x.similarityPercent));

    ctx.mlState.requests = 0;
    ctx.mlState.maxInflight = 0;
    const many = Array.from({ length: 100 }, (_, i) => `profile text number ${i} engineer`);
    await ranking.getMLScoresBatched({ candidateText: cand, resultTexts: many, mlConfig: { batchSize: 10 } });
    assert.equal(ctx.mlState.requests, 10);
    assert.ok(ctx.mlState.maxInflight <= 2, `max in flight ${ctx.mlState.maxInflight}`);
  } finally {
    ctx.mlState.delayMs = 0;
  }
});

test("O8. ML candidate selection is bounded but also takes promising low-score profiles (diverse by platform)", () => {
  const n = 120;
  const matches = Array.from({ length: n }, (_, i) => ({
    matchStatus: "REVIEW_REQUIRED",
    similarityScore: i >= 100 ? 60 : 10,
    matchedSignals: { name: { matched: i >= 100 || i < 30 } },
    searchResult: { platform: i >= 100 ? ["INSTAGRAM", "YOUTUBE", "MEDIUM", "QUORA"][i % 4] : "LINKEDIN" },
  }));
  // deterministic score: high for the first 100, LOW for the last 20 (thin profiles)
  const results = matches.map((_, i) => ({ reviewRankScore: i >= 100 ? 5 : 100 - i * 0.5 }));
  const picked = ranking.selectMLCandidates(matches, results, { maxCandidates: 50 });
  assert.equal(picked.length, 50);
  assert.equal(new Set(picked).size, 50);
  const lowButPromising = picked.filter((i) => i >= 100);
  assert.ok(lowButPromising.length >= 10, `low-score but name-matching profiles included: ${lowButPromising.length}`);
});

// ------------------------------------------------------------------
// end-to-end: repeated run, reuse, persistence, ML-down fallback
// ------------------------------------------------------------------
const runOnce = async (candId) => {
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: candId })).body.data;
  const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 400));
  return { run, search: r.body.data.search };
};

test("O9. repeated run: no provider calls, stored profiles + fresh enrichment reused, matches persisted per run, human decision untouched, nothing duplicated", async () => {
  process.env.PROVIDER_CACHE_TTL_MS = "600000";
  process.env.SEARCH_ENRICH_PROFILES = "true";
  const axios = require("axios");
  const realAdapter = axios.defaults.adapter;
  let pageFetches = 0;
  axios.defaults.adapter = async (config) => {
    if (/127\.0\.0\.1/.test(String(config.url))) return axios.getAdapter(realAdapter || ["http"])(config);
    pageFetches += 1;
    if (/api\.github\.com/.test(String(config.url))) {
      return { data: { login: "amitsharma", name: "Amit Sharma", company: "Infosys", location: "Dewas, India", bio: "Engineer" }, status: 200, statusText: "OK", headers: {}, config, request: {} };
    }
    return { data: "<html><title>x</title></html>", status: 200, statusText: "OK", headers: { "content-type": "text/html" }, config, request: {} };
  };
  try {
    providerLayer.clearCache();
    install();
    H.resetProviderCalls();
    const cand = (await ctx.call("POST", "/candidates", CAND)).body.data;

    const first = await runOnce(cand._id);
    const firstCalls = H.providerCalls.tavily.length + H.providerCalls.serper.length;
    assert.ok(firstCalls > 0);
    const firstFetches = pageFetches;
    assert.ok(firstFetches > 0, "first run enriched a fetchable profile");

    // reviewer approves the LinkedIn match of run 1
    const m1 = (await ctx.call("GET", `/candidate-matches/run/${first.run._id}`)).body;
    const list1 = m1.data || [];
    assert.ok(list1.length >= 2);
    const target = list1.find((m) => /amit-sharma-dewas/.test(m.searchResult?.profileUrl || ""));
    assert.ok(target, "dewas profile matched");
    const patched = await ctx.call("PATCH", `/candidate-matches/${target._id}`, { reviewStatus: "APPROVED", reviewerNotes: "ok" });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));

    H.resetProviderCalls();
    const second = await runOnce(cand._id);
    const secondCalls = H.providerCalls.tavily.length + H.providerCalls.serper.length;
    assert.equal(secondCalls, 0, "repeat run makes no provider calls");
    assert.equal(pageFetches, firstFetches, "no profile page re-fetched");
    // the approved profile comes back through the identity knowledge base
    // (re-review, never auto-approved); the others through profile reuse
    const reuse = second.search.timings.reuse;
    assert.ok(second.search.priorProfilesReused >= 1, JSON.stringify(reuse));
    assert.ok(reuse.priorProfilesReused + reuse.knowledgeBaseProfiles >= 2, JSON.stringify(reuse));
    assert.ok(second.search.timings.reuse.enrichmentsReused >= 1);
    assert.equal(second.search.timings.provider.calls, 0);
    assert.ok(
      !Object.values(second.search.platforms).some((p) => p.status === "SKIPPED_CALL_BUDGET"),
      "cache hits must not be mistaken for an exhausted call budget"
    );
    assert.equal(second.search.totalResults, first.search.totalResults, "repeat run finds the same profiles");

    // second run has its own persisted matches, one per stored result
    const sr2 = await ctx.models.SearchResult.countDocuments({ bgvRun: second.run._id });
    const cm2 = await ctx.models.CandidateMatch.countDocuments({ bgvRun: second.run._id });
    assert.equal(cm2, sr2);
    const rel = await ctx.call("GET", `/candidate-matches/run/${second.run._id}/relevant`);
    assert.equal(rel.status, 200);
    assert.ok(rel.body.data.length >= 1);

    // run 1 data and the human decision are intact; run 2 only carries the human-confirmed
    // profile forward as "Previously Verified" (registry); everything else starts PENDING
    const still = await ctx.models.CandidateMatch.findById(target._id).lean();
    assert.equal(still.reviewStatus, "APPROVED");
    const approvedInRun2 = await ctx.models.CandidateMatch.countDocuments({ bgvRun: second.run._id, reviewStatus: "APPROVED" });
    assert.equal(approvedInRun2, 1, "only the explicitly human-verified profile is recognised");
    const approved2 = await ctx.models.CandidateMatch.findOne({ bgvRun: second.run._id, reviewStatus: "APPROVED" }).lean();
    assert.ok(approved2.matchDetails.previouslyVerified, "marked Previously Verified, from the registry");

    // re-running matching on run 1 refreshes scores but keeps the decision, creates no duplicates
    const before = await ctx.models.CandidateMatch.countDocuments({ bgvRun: first.run._id });
    const { createMatchesForBgvRun } = require("../services/candidateMatch.service");
    const res = await createMatchesForBgvRun({ candidateId: cand._id, bgvRunId: first.run._id });
    assert.equal(await ctx.models.CandidateMatch.countDocuments({ bgvRun: first.run._id }), before);
    assert.equal(res.timings.unchanged, before, "unchanged inputs are not rewritten");
    assert.equal((await ctx.models.CandidateMatch.findById(target._id).lean()).reviewStatus, "APPROVED");

    // location in the run summary: repaired for queries, stored candidate untouched
    const stored = await ctx.models.Candidate.findById(cand._id).lean();
    assert.equal(stored.location.state, "Maharashtra");
    const run1doc = await ctx.models.BgvRun.findById(first.run._id).lean();
    assert.equal(run1doc.searchSummary.location.used.state, "Madhya Pradesh");
    assert.ok(run1doc.searchSummary.location.conflicts.length >= 1);
  } finally {
    axios.defaults.adapter = realAdapter;
    process.env.SEARCH_ENRICH_PROFILES = "false";
    process.env.PROVIDER_CACHE_TTL_MS = "0";
    providerLayer.clearCache();
  }
});

test("O10. ML service down: run completes, shortlist still ranked by rules, ML evidence says UNAVAILABLE (not 0)", async () => {
  mlService.resetState();
  install();
  ctx.mlState.fail = true;
  try {
    const cand = (await ctx.call("POST", "/candidates", { ...CAND, email: "ml.down@example.com" })).body.data;
    const { run } = await runOnce(cand._id);
    const rel = await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant`);
    assert.equal(rel.status, 200);
    assert.ok(rel.body.data.length >= 1, "rule-based shortlist still works");
    const top = rel.body.data[0];
    assert.match(String(top.searchResult?.profileUrl), /amit-sharma-dewas/, "the Dewas / Infosys profile still ranks first");
    const ml = top.rankingEvidence.mlSemanticMatch;
    assert.equal(ml.status, "UNAVAILABLE");
    assert.equal(ml.similarityPercent, null);
  } finally {
    ctx.mlState.fail = false;
    await new Promise((r) => setTimeout(r, 80));
  }
});

test("O11. saveNewResults: bulk insert is duplicate-key safe (parallel callers, same URL) and bulk-inserts new rows", async () => {
  const cand = (await ctx.call("POST", "/candidates", { ...CAND, email: "bulk@example.com" })).body.data;
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;
  const mk = (slug) => ({
    platform: "LINKEDIN",
    profileUrl: `https://www.linkedin.com/in/${slug}`,
    name: "Amit Sharma",
    searchProvider: "SERPER",
    providers: ["SERPER"],
    providerResults: [],
    title: "Amit Sharma",
    snippet: "x",
  });
  const merged = ["a-1", "a-2", "a-3"].map(mk);
  const args = { bgvRunId: run._id, candidateId: cand._id, mergedResults: merged, existingResults: [] };
  const [r1, r2] = await Promise.all([searchSvc.saveNewResults(args), searchSvc.saveNewResults(args)]);
  assert.equal(await ctx.models.SearchResult.countDocuments({ bgvRun: run._id }), 3);
  assert.equal(r1.savedResults.length + r2.savedResults.length + r1.reusedResults.length + r2.reusedResults.length, 6);
});

test("O12. ranking cache signature changes when the candidate or a review decision changes", async () => {
  const cand = (await ctx.call("POST", "/candidates", { ...CAND, email: "sig@example.com" })).body.data;
  install();
  const { run } = await runOnce(cand._id);
  const a = await ranking.getTopRelevantMatches({ bgvRunId: run._id, limit: 15 });
  const b = await ranking.getTopRelevantMatches({ bgvRunId: run._id, limit: 15 });
  assert.strictEqual(a, b, "unchanged data -> cached page");
  const first = a.data[0];
  await ctx.call("PATCH", `/candidate-matches/${first._id}`, { reviewStatus: "REJECTED", reviewerNotes: "no" });
  const c = await ranking.getTopRelevantMatches({ bgvRunId: run._id, limit: 15 });
  assert.notStrictEqual(a, c, "review decision invalidates the cache");
  await ctx.call("PATCH", `/candidates/${cand._id}`, { currentCompany: "Wipro" });
  const d = await ranking.getTopRelevantMatches({ bgvRunId: run._id, limit: 15 });
  assert.notStrictEqual(c, d, "candidate edit invalidates the cache");
});
