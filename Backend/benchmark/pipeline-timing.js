"use strict";

/**
 * End-to-end timing of ONE BGV run (search -> merge -> save -> enrich ->
 * match -> BGE-M3 ranking) with SIMULATED provider / ML / page latency.
 * No paid API, no real model: everything is mocked, so the numbers show the
 * effect of the code (calls made, round trips, serial waits), not real
 * provider speed.
 *
 *   TEST_MONGO_URI=mongodb://127.0.0.1:27018 node benchmark/pipeline-timing.js
 *   TREE=/path/to/other/Backend node benchmark/pipeline-timing.js   # compare trees
 *
 * Env: LAT_TAVILY (ms, 300) LAT_SERPER (250) LAT_ML (1500 per batch) LAT_PAGE (150) RUNS (2)
 */

const path = require("path");
const TREE = process.env.TREE ? path.resolve(process.env.TREE) : path.join(__dirname, "..");
const req = (p) => require(path.join(TREE, p));

const LAT = {
  tavily: Number(process.env.LAT_TAVILY) || 300,
  serper: Number(process.env.LAT_SERPER) || 250,
  ml: Number(process.env.LAT_ML) || 1500,
  page: Number(process.env.LAT_PAGE) || 150,
};
const RUNS = Number(process.env.RUNS) || 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.SEARCH_ENRICH_IMAGES = "false";
// the production default (6 h response cache); helpers.js would otherwise turn it off for unit tests
process.env.PROVIDER_CACHE_TTL_MS = process.env.PROVIDER_CACHE_TTL_MS || "21600000";
const H = req("tests/helpers");
// helpers.js disables profile enrichment for unit tests; the benchmark wants it on
const wantEnrich = true;

// ---------------------------------------------------------------
// the simulated web
// ---------------------------------------------------------------
const CANDIDATE = {
  fullName: "Amit Sharma",
  email: "amit.sharma.dev@example.com",
  // deliberately inconsistent input: Dewas is in Madhya Pradesh
  location: { city: "Dewas", state: "Maharashtra", country: "India" },
  currentCompany: "Infosys",
  currentJobTitle: "Software Engineer",
  education: [{ institution: "IPS Academy Indore", degree: "B.Tech" }],
};

const WORLD = {};
const add = (domain, n, make) => {
  WORLD[domain] = Array.from({ length: n }, (_, i) => make(i));
};
const person = (i, good) => ({
  name: "Amit Sharma",
  good,
  loc: good ? "Dewas, Madhya Pradesh, India" : ["Pune, Maharashtra, India", "London, United Kingdom", "Houston, Texas, United States"][i % 3],
  co: good ? "Infosys" : ["TCS", "Barclays", "Shell"][i % 3],
  title: good ? "Software Engineer" : ["Project Manager", "Analyst", "Geologist"][i % 3],
});
add("linkedin.com", 45, (i) => {
  const p = person(i, i < 2);
  return {
    title: `${p.name} - ${p.title} - ${p.co} | LinkedIn`,
    link: `https://www.linkedin.com/in/amit-sharma-${i}${p.good ? "-dewas" : ""}`,
    snippet: `${p.loc} · ${p.title} · ${p.co}.`,
  };
});
add("github.com", 6, (i) => ({
  title: `amitsharma${i} (Amit Sharma) · GitHub`,
  link: `https://github.com/amitsharma${i}`,
  snippet: i < 2 ? "Amit Sharma. Infosys. Dewas, Madhya Pradesh." : "Amit Sharma. Houston, Texas.",
}));
for (const [d, n, pre] of [
  ["instagram.com", 8, ""], ["facebook.com", 8, ""], ["x.com", 6, ""],
  ["youtube.com", 20, "@"], ["medium.com", 5, "@"], ["quora.com", 4, "profile/"],
  ["stackoverflow.com", 3, "users/1"], ["reddit.com", 3, "user/"], ["kaggle.com", 2, ""],
]) {
  add(d, n, (i) => ({
    title: `Amit Sharma ${i} | ${d}`,
    link: `https://www.${d}/${pre}amitsharma${i}`,
    snippet: i === 0 ? "Amit Sharma, Dewas." : `Amit Sharma, ${["Mumbai", "Delhi", "Toronto"][i % 3]}.`,
  }));
}

const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const allPool = Object.values(WORLD).flat();

const calls = { tavily: 0, serper: 0, queries: new Set(), log: [] };
const cursor = {};

// Stateless like a real search API: the same request always returns the same
// page (serper: options.page; tavily: first page).
const answer = (q, domain, shape, page = 1) => {
  let list;
  if (domain) {
    const n = Math.max(Number(page) || 1, 1) - 1;
    const pool = WORLD[domain.replace(/^www\./, "")] || [];
    list = pool.slice(n * 10, n * 10 + 10);
  } else {
    // generic query: deterministic mixed sample
    const h = hash(q);
    list = Array.from({ length: 10 }, (_, i) => allPool[(h + i * 7) % allPool.length]);
  }
  return shape === "tavily"
    ? list.map((r) => ({ title: r.title, url: r.link, content: r.snippet, score: 0.6 }))
    : list;
};

const siteDomain = (q) => (String(q).match(/site:([a-z0-9.\-/]+)/i) || [])[1]?.split("/")[0] || null;

const install = () =>
  H.setProviders({
    serper: async (q, o = {}) => {
      calls.serper += 1;
      calls.queries.add(String(q).toLowerCase());
      await sleep(LAT.serper);
      return answer(q, siteDomain(q), "serper", o.page);
    },
    tavily: async (q, o = {}) => {
      calls.tavily += 1;
      calls.queries.add(String(q).toLowerCase());
      await sleep(LAT.tavily);
      return answer(q, (o.includeDomains && o.includeDomains[0]) || siteDomain(q), "tavily");
    },
  });

// profile-page fetches (enrichment) – only latency + a tiny HTML page
const installAxiosLatency = () => {
  const axios = require(path.join(TREE, "node_modules/axios"));
  const fake = { fetches: 0 };
  const prev = axios.defaults.adapter;
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || "");
    if (/127\.0\.0\.1|localhost/.test(url)) {
      // local fake ML / API server: use the real adapter
      const real = axios.getAdapter(prev || ["xhr", "http", "fetch"]);
      return real(config);
    }
    fake.fetches += 1;
    await sleep(LAT.page);
    return {
      data: "<html><head><title>Amit Sharma</title><meta name='description' content='Software engineer'></head></html>",
      status: 200, statusText: "OK", headers: { "content-type": "text/html" }, config, request: {},
    };
  };
  return fake;
};

// ---------------------------------------------------------------
(async () => {
  process.env.SEARCH_CONCURRENCY = process.env.SEARCH_CONCURRENCY || "4";
  const ctx = await H.startAll();
  if (wantEnrich) process.env.SEARCH_ENRICH_PROFILES = "true";
  H.mlState.delayMs = LAT.ml;
  install();
  const pageFetch = installAxiosLatency();

  const cand = (await ctx.call("POST", "/candidates", CANDIDATE)).body.data;
  const results = [];

  for (let i = 1; i <= RUNS; i++) {
    calls.tavily = 0; calls.serper = 0; calls.queries.clear(); pageFetch.fetches = 0;
    H.mlState.requests = 0; H.mlState.texts = 0; H.mlState.maxInflight = 0;

    const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;
    const t0 = Date.now();
    const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
    const tSearch = Date.now() - t0;
    const t1 = Date.now();
    const top = await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant`);
    const tRank = Date.now() - t1;

    const s = r.body?.data?.search || {};
    const stored = await ctx.models.SearchResult.countDocuments({ bgvRun: run._id });
    const matches = await ctx.models.CandidateMatch.countDocuments({ bgvRun: run._id });
    results.push({
      run: i,
      status: r.status,
      totalSec: Number(((tSearch + tRank) / 1000).toFixed(1)),
      searchAndMatchSec: Number((tSearch / 1000).toFixed(1)),
      firstShortlistFetchSec: Number((tRank / 1000).toFixed(1)),
      providerCalls: calls.tavily + calls.serper,
      uniqueQueries: calls.queries.size,
      pageFetches: pageFetch.fetches,
      mlRequests: H.mlState.requests,
      mlTextsScored: H.mlState.texts,
      storedResults: stored,
      reusedResults: s.reusedResults ?? s.updatedResults ?? null,
      matches,
      shortlist: top.body?.data?.length,
      timings: r.body?.data?.search?.timings || undefined,
    });
    console.log(JSON.stringify(results[results.length - 1]));
  }

  console.log("\nTREE:", TREE);
  console.log("LATENCY (simulated):", JSON.stringify(LAT));
  await ctx.stop();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
