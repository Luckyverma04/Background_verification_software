"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");
const PD = require("../services/platformDiscovery.service");
const { searchWithProviders, registerProvider } = require("../services/searchProvider.service");

let ctx;
const state = {};

const CANDIDATE = {
  fullName: "Priya Verma",
  email: "priya.verma.dev@example.com",
  location: { city: "Bhopal", state: "Madhya Pradesh", country: "India" },
  currentCompany: "Infosys",
  currentJobTitle: "Senior Software Engineer",
  education: [{ institution: "MANIT Bhopal", degree: "B.Tech" }],
};

// ---------------------------------------------------------------
// Catalogue of what each platform "has" on the web (mocked)
// ---------------------------------------------------------------
const li = (i) => ({
  title: `Priya Verma - Senior Software Engineer - Infosys | LinkedIn`,
  link: `https://www.linkedin.com/in/priya-verma-bhopal-${i}`,
  snippet: `Bhopal, Madhya Pradesh, India · Senior Software Engineer · Infosys. Education: MANIT Bhopal.`,
});
const yt = (i) => ({ title: `Priya Verma Vlogs ${i}`, link: `https://www.youtube.com/@priyaverma${i}`, snippet: "Channel" });
const gh = (i, rel) => ({
  title: `priya-gh-${i} (Priya Verma) · GitHub`,
  link: `https://github.com/priya-gh-${i}`,
  snippet: rel ? "Priya Verma. Infosys Bhopal." : "Priya Verma. Seattle, United States. Google.",
});

const CATALOG = {
  "linkedin.com": Array.from({ length: 60 }, (_, i) => li(i)),
  "youtube.com": Array.from({ length: 60 }, (_, i) => yt(i)),
  "github.com": [gh(1, true), gh(2, true), gh(3, false)],
  "instagram.com": [],
  // generic search / directory pages, NOT profiles
  "reddit.com": [
    { title: "priya verma - Reddit search", link: "https://www.reddit.com/search/?q=priya%20verma", snippet: "search" },
    { title: "r/india", link: "https://www.reddit.com/r/india/comments/abc/priya_verma/", snippet: "post" },
  ],
};

const callsByDomain = {};
let order = [];
const FAIL_DOMAINS = new Set();

const respond = (domain, shape) => {
  order.push(domain);
  callsByDomain[domain] = (callsByDomain[domain] || 0) + 1;
  if (FAIL_DOMAINS.has(domain)) throw new Error(`${domain} provider outage`);
  const all = CATALOG[domain] || [];
  const n = callsByDomain[domain] - 1;
  const slice = all.slice((n * 10) % Math.max(all.length, 1), ((n * 10) % Math.max(all.length, 1)) + 10);
  return shape === "tavily"
    ? slice.map((r) => ({ title: r.title, url: r.link, content: r.snippet, score: 0.7 }))
    : slice;
};

const siteOf = (q) => {
  const m = String(q).match(/site:([a-z0-9.\-]+)/i);
  return m ? m[1].toLowerCase() : null;
};

const install = () =>
  H.setProviders({
    serper: (q) => {
      const d = siteOf(q);
      return d ? respond(d, "serper") : [];
    },
    tavily: (q, o = {}) => {
      const d = (o.includeDomains && o.includeDomains[0]) || null;
      return d ? respond(d, "tavily") : [];
    },
  });

const newRun = async () => {
  const cand = (await ctx.call("POST", "/candidates", { ...CANDIDATE, email: `p${Math.random().toString(36).slice(2)}@example.com` })).body.data;
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;
  return { cand, run };
};

const search = async (runId) => {
  const r = await ctx.call("POST", `/bgv-runs/${runId}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.search.platforms;
};

test.before(async () => {
  ctx = await H.startAll();
  process.env.PLATFORM_DISCOVERY_CONCURRENCY = "1"; // strictly one platform after another
  process.env.PROVIDER_RETRY_BASE_MS = "1";
});

test.after(async () => {
  await ctx.stop();
});

test("P1. each platform has its OWN limit: LinkedIn stops at 15, other platforms are still searched afterwards", async () => {
  install();
  Object.keys(callsByDomain).forEach((k) => delete callsByDomain[k]);
  order = [];
  const { run } = await newRun();
  state.run = run;
  const p = await search(run._id);

  // LinkedIn reached its own target and stopped
  assert.equal(p.LINKEDIN.target, 15);
  assert.ok(p.LINKEDIN.profileShapedUrls >= 15);
  assert.equal(p.LINKEDIN.status, "TARGET_REACHED");
  assert.equal(p.LINKEDIN.stoppedBecause, "TARGET_REACHED");

  // ...and that did NOT stop discovery elsewhere (run strictly after LinkedIn)
  const lastLinkedIn = order.lastIndexOf("linkedin.com");
  const firstYoutube = order.indexOf("youtube.com");
  assert.ok(firstYoutube > lastLinkedIn, "YouTube must be searched after LinkedIn has finished");
  assert.ok(p.YOUTUBE.profileShapedUrls >= 15);
  assert.equal(p.YOUTUBE.status, "TARGET_REACHED");
  assert.ok(p.GITHUB.providerCalls > 0);
  assert.ok(p.INSTAGRAM.providerCalls > 0, "Instagram searched although LinkedIn already had 15");
});

test("P2. counts are separate per platform; shortfall is reported, never padded", async () => {
  const run = state.run;
  const p = (await ctx.call("GET", `/bgv-runs/${run._id}/platforms`)).body.data;
  const by = Object.fromEntries(p.platforms.map((x) => [x.platform, x]));

  assert.equal(by.GITHUB.profileShapedUrls, 3);
  assert.equal(by.GITHUB.status, "SHORTFALL");
  assert.equal(by.GITHUB.discoveryShortfall, 12);

  assert.equal(by.INSTAGRAM.profileShapedUrls, 0);
  assert.equal(by.INSTAGRAM.status, "NOT_FOUND");
  assert.ok(by.INSTAGRAM.queriesRun > 0);

  // every supported platform has its own entry
  const { PLATFORM_KEYS } = require("../utils/platforms");
  for (const key of PLATFORM_KEYS) assert.ok(by[key], `${key} missing from summary`);
  assert.ok(by.GITHUB.discovered >= by.GITHUB.uniqueUrls);
  assert.ok(by.LINKEDIN.discovered >= 15);
});

test("P3. generic search / post pages are not counted as profiles", async () => {
  const p = (await ctx.call("GET", `/bgv-runs/${state.run._id}/platforms`)).body.data.platforms;
  const reddit = p.find((x) => x.platform === "REDDIT");
  assert.equal(reddit.profileShapedUrls, 0);
  assert.ok(reddit.invalidUrls >= 1);
  assert.equal(reddit.status, "NOT_FOUND");

  assert.equal(PD.hasProfileUrlShape("https://www.reddit.com/search/?q=x", "REDDIT"), false);
  assert.equal(PD.hasProfileUrlShape("https://github.com/someone/some-repo", "GITHUB"), false);
  assert.equal(PD.hasProfileUrlShape("https://github.com/someone", "GITHUB"), true);
  assert.equal(PD.hasProfileUrlShape("https://x.com/home", "TWITTER"), false);
  assert.equal(PD.hasProfileUrlShape("https://x.com/someone/status/123", "TWITTER"), false);
  assert.equal(PD.hasProfileUrlShape("https://www.linkedin.com/in/some-one", "LINKEDIN"), true);
  assert.equal(PD.hasProfileUrlShape("https://www.linkedin.com/company/acme", "LINKEDIN"), false);
  assert.equal(PD.hasProfileUrlShape("https://www.youtube.com/watch?v=abc", "YOUTUBE"), false);
  assert.equal(PD.hasProfileUrlShape("https://www.youtube.com/@someone", "YOUTUBE"), true);
  assert.equal(PD.hasProfileUrlShape("https://medium.com/@someone", "MEDIUM"), true);
  assert.equal(PD.hasProfileUrlShape("https://medium.com/some-article-123", "MEDIUM"), false);
  assert.equal(PD.hasProfileUrlShape("https://stackoverflow.com/users/123/name", "STACKOVERFLOW"), true);
  assert.equal(PD.hasProfileUrlShape("https://stackoverflow.com/questions/1/x", "STACKOVERFLOW"), false);
});

test("P4. platform-specific queries use company / location / education / username and never a bare name when other details exist", () => {
  const signals = {
    companies: ["Infosys"], institutions: ["MANIT Bhopal"], titles: ["Senior Software Engineer"],
    city: "Bhopal", state: "Madhya Pradesh", country: "India", emailUser: "priya.verma.dev",
  };
  const lin = PD.buildPlatformQueries(CANDIDATE, { key: "LINKEDIN", site: "linkedin.com/in" }, signals, 6);
  assert.ok(lin.queries.every((q) => q.startsWith("site:linkedin.com/in")));
  assert.ok(lin.queries.some((q) => q.includes('"Infosys"')));
  assert.ok(lin.queries.some((q) => q.includes('"Bhopal"')));
  assert.equal(lin.nameOnly, false);
  assert.ok(!lin.queries.includes('site:linkedin.com/in "Priya Verma"'));

  const yt2 = PD.buildPlatformQueries(CANDIDATE, { key: "YOUTUBE", site: "youtube.com" }, signals, 6);
  assert.ok(yt2.queries.every((q) => q.startsWith("site:youtube.com")));

  const bare = PD.buildPlatformQueries({ fullName: "Priya Verma" }, { key: "GITHUB", site: "github.com" },
    { companies: [], institutions: [], titles: [], city: "", state: "", country: "", emailUser: "" }, 4);
  assert.equal(bare.nameOnly, true);
});

test("P5. per-platform targets are configurable and independent", async () => {
  process.env.PLATFORM_TARGETS = JSON.stringify({ LINKEDIN: 5 });
  try {
    install();
    Object.keys(callsByDomain).forEach((k) => delete callsByDomain[k]);
    const { run } = await newRun();
    const p = await search(run._id);
    assert.equal(p.LINKEDIN.target, 5);
    assert.equal(p.LINKEDIN.status, "TARGET_REACHED");
    assert.equal(p.YOUTUBE.target, 15);
    assert.ok(p.YOUTUBE.profileShapedUrls >= 15);
    assert.ok(p.LINKEDIN.providerCalls < p.YOUTUBE.providerCalls + 5);
  } finally {
    delete process.env.PLATFORM_TARGETS;
  }
});

test("P6. one platform failing does not stop the others; status FAILED is explicit", async () => {
  FAIL_DOMAINS.add("github.com");
  try {
    install();
    Object.keys(callsByDomain).forEach((k) => delete callsByDomain[k]);
    const { run } = await newRun();
    const p = await search(run._id);
    assert.equal(p.GITHUB.status, "FAILED");
    assert.ok(p.GITHUB.errors.length > 0);
    assert.equal(p.LINKEDIN.status, "TARGET_REACHED");
    assert.equal(p.YOUTUBE.status, "TARGET_REACHED");
  } finally {
    FAIL_DOMAINS.delete("github.com");
  }
});

test("P7. the shared provider-call budget is respected and reported", async () => {
  process.env.PLATFORM_DISCOVERY_MAX_CALLS = "6";
  try {
    install();
    const { run } = await newRun();
    const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
    assert.equal(r.status, 200);
    const s = r.body.data.search;
    assert.ok(s.platformCallsUsed <= 6, `used ${s.platformCallsUsed}`);
    assert.equal(s.platformCallBudget, 6);
    const statuses = Object.values(s.platforms).map((x) => x.status);
    assert.ok(statuses.includes("SKIPPED_CALL_BUDGET") || statuses.includes("NOT_FOUND"));
  } finally {
    delete process.env.PLATFORM_DISCOVERY_MAX_CALLS;
  }
});

test("P8. rate limits (429) and 5xx are retried with backoff; other errors are not", async () => {
  let n429 = 0;
  registerProvider("flaky", {
    search: async () => {
      n429 += 1;
      if (n429 < 3) {
        const e = new Error("rate limited");
        e.response = { status: 429, headers: {} };
        throw e;
      }
      return [{ title: "ok", link: "https://github.com/x" }];
    },
  });
  const ok = await searchWithProviders(["flaky"], "q");
  assert.equal(ok[0].success, true);
  assert.equal(n429, 3);

  let n401 = 0;
  registerProvider("badkey", {
    search: async () => {
      n401 += 1;
      const e = new Error("bad key");
      e.response = { status: 401 };
      throw e;
    },
  });
  const bad = await searchWithProviders(["badkey"], "q");
  assert.equal(bad[0].success, false);
  assert.equal(n401, 1, "a 401 must not be retried");
});

test("P9. platform ranking: relevant profiles of ONE platform, capped at the platform target, shortlist stays 15, no padding", async () => {
  // GitHub relevant ones + one namesake; LinkedIn has many relevant ones
  install();
  Object.keys(callsByDomain).forEach((k) => delete callsByDomain[k]);
  const { run } = await newRun();
  await search(run._id);

  const m = await ctx.call("POST", `/bgv-runs/${run._id}/match`, {});
  assert.equal(m.status, 200, JSON.stringify(m.body));

  // global human-review shortlist is unchanged: max 15
  const shortlist = (await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant`)).body;
  assert.ok(shortlist.data.length <= 15);

  const li = (await ctx.call("GET", `/candidate-matches/run/${run._id}/platform/LINKEDIN`)).body;
  assert.equal(li.platform, "LINKEDIN");
  assert.ok(li.data.length <= 15);
  assert.ok(li.data.length >= 10);
  assert.ok(li.data.every((x) => x.searchResult.platform === "LINKEDIN"));
  assert.ok(li.relevantFound >= li.data.length);

  const gh = (await ctx.call("GET", `/candidate-matches/run/${run._id}/platform/GITHUB`)).body;
  assert.ok(gh.data.every((x) => x.searchResult.platform === "GITHUB"));
  assert.ok(gh.data.length <= 3);
  const urls = gh.data.map((x) => x.searchResult.profileUrl);
  assert.ok(!urls.some((u) => /priya-gh-3$/.test(u)), "the Seattle/Google namesake must not be padded in");
  assert.equal(gh.shortfall, 15 - gh.data.length > 0 ? gh.shortfall : 0);
  assert.ok(gh.shortfall >= 12);

  // summary now carries relevance counts + statuses
  const sum = (await ctx.call("GET", `/bgv-runs/${run._id}/platforms`)).body.data.platforms;
  const sli = sum.find((x) => x.platform === "LINKEDIN");
  const sgh = sum.find((x) => x.platform === "GITHUB");
  assert.equal(sli.relevanceStatus, "TARGET_MET");
  assert.ok(["SHORTFALL", "NONE_RELEVANT"].includes(sgh.relevanceStatus));
  assert.ok(sgh.relevanceShortfall >= 12);

  // all discovered records stay stored, shortlisted or not
  const stored = await ctx.models.SearchResult.countDocuments({ bgvRun: run._id });
  assert.ok(stored >= 15 + 15 + 3);

  assert.equal((await ctx.call("GET", `/candidate-matches/run/${run._id}/platform/NOPE`)).status, 400);
  assert.equal((await ctx.call("GET", `/bgv-runs/not-an-id/platforms`)).status, 400);
});

test("P10. a repeat search does not duplicate profiles within a platform", async () => {
  install();
  const { run } = await newRun();
  await search(run._id);
  const before = await ctx.models.SearchResult.countDocuments({ bgvRun: run._id });
  Object.keys(callsByDomain).forEach((k) => delete callsByDomain[k]);
  await search(run._id);
  const after = await ctx.models.SearchResult.countDocuments({ bgvRun: run._id });
  const keys = (await ctx.models.SearchResult.find({ bgvRun: run._id }).lean()).map((r) => r.profileUrl);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(after >= before);
});

// ====================================================================
// Regression tests for the v3 review findings
// ====================================================================

const axios = require("axios");

const resetCalls = () => {
  Object.keys(callsByDomain).forEach((k) => delete callsByDomain[k]);
  order = [];
};

test("R1. a previously supplied / confirmed profile does NOT stop fresh discovery on that platform (and is preserved)", async () => {
  install();
  resetCalls();

  const cand = (await ctx.call("POST", "/candidates", {
    ...CANDIDATE,
    email: `r1.${Date.now()}@example.com`,
    linkedin: "https://www.linkedin.com/in/priya-verma-bhopal-0",
    github: "https://github.com/priya-gh-1",
  })).body.data;
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;

  const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.data.search.platforms;

  // covered platforms were still searched with their own queries
  assert.equal(p.LINKEDIN.hasConfirmedProfile, true);
  assert.ok(p.LINKEDIN.queriesRun > 0, "LinkedIn discovery must still run");
  assert.ok(p.LINKEDIN.providerCalls > 0);
  assert.ok(p.GITHUB.queriesRun > 0, "GitHub discovery must still run");
  assert.notEqual(p.LINKEDIN.status, "COVERED_BY_CONFIRMED_PROFILE");
  assert.ok(callsByDomain["linkedin.com"] > 0);

  // the supplied profile is kept exactly once, plus fresh discoveries
  const SR = ctx.models.SearchResult;
  const seeded = await SR.find({ bgvRun: run._id, profileUrl: /linkedin\.com\/in\/priya-verma-bhopal-0$/ }).lean();
  assert.equal(seeded.length, 1);
  assert.ok((await SR.countDocuments({ bgvRun: run._id, platform: "LINKEDIN" })) > 1);
});

test("R2. opt-in PLATFORM_DISCOVERY_SKIP_COVERED=true still skips covered platforms (old behaviour is available explicitly)", async () => {
  process.env.PLATFORM_DISCOVERY_SKIP_COVERED = "true";
  try {
    install();
    resetCalls();
    const cand = (await ctx.call("POST", "/candidates", {
      ...CANDIDATE, email: `r2.${Date.now()}@example.com`,
      linkedin: "https://www.linkedin.com/in/priya-verma-bhopal-0",
    })).body.data;
    const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;
    const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
    const p = r.body.data.search.platforms;
    assert.equal(p.LINKEDIN.status, "COVERED_BY_CONFIRMED_PROFILE");
    assert.equal(p.LINKEDIN.providerCalls, 0);
    assert.ok(p.YOUTUBE.providerCalls > 0);
  } finally {
    delete process.env.PLATFORM_DISCOVERY_SKIP_COVERED;
  }
});

test("R3. concurrent workers cannot overspend the shared budget (reservation happens before the request)", async () => {
  const prevC = process.env.PLATFORM_DISCOVERY_CONCURRENCY;
  process.env.PLATFORM_DISCOVERY_CONCURRENCY = "8";
  process.env.PLATFORM_DISCOVERY_MAX_CALLS = "20";
  let invocations = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    const slow = async (q, o = {}) => {
      invocations += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 8)); // let the workers interleave
      inFlight -= 1;
      return [];
    };
    H.setProviders({ serper: slow, tavily: slow });

    const { run } = await newRun();
    const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.data.search;

    assert.ok(maxInFlight > 1, "the test must really run workers concurrently");
    const platformInvocations = invocations; // global phases return [] quickly but also count
    assert.ok(s.platformCallsUsed <= 20, `reserved ${s.platformCallsUsed}`);
    assert.equal(s.platformCallBudget, 20);

    // direct service-level check, no other phases involved
    invocations = 0;
    const out = await PD.runPlatformDiscovery(
      CANDIDATE,
      { companies: ["Infosys"], institutions: [], titles: [], city: "Bhopal", state: "", country: "", emailUser: "" },
      {}
    );
    assert.ok(invocations <= 20, `actual provider attempts ${invocations} exceeded the budget of 20`);
    assert.equal(out.callsUsed, invocations, "reported usage must equal real provider attempts");
    assert.ok(platformInvocations >= 0);
    const statuses = Object.values(out.perPlatform).map((x) => x.stoppedBecause);
    assert.ok(statuses.includes("CALL_BUDGET_EXHAUSTED"));
  } finally {
    process.env.PLATFORM_DISCOVERY_CONCURRENCY = prevC;
    delete process.env.PLATFORM_DISCOVERY_MAX_CALLS;
  }
});

test("R4. retries consume budget and are reported separately from logical requests", async () => {
  process.env.PLATFORM_DISCOVERY_PLATFORMS = "GITHUB";
  process.env.PLATFORM_DISCOVERY_MAX_CALLS = "50";
  process.env.PLATFORM_MAX_QUERIES = "1";
  try {
    let tries = 0;
    const flaky = async () => {
      tries += 1;
      if (tries <= 2) {
        const e = new Error("rate limited");
        e.response = { status: 429, headers: {} };
        throw e;
      }
      return [{ title: "priya-gh-1 (Priya Verma) · GitHub", url: "https://github.com/priya-gh-1", content: "Priya Verma" }];
    };
    let serperTries = 0;
    H.setProviders({ tavily: flaky, serper: async () => { serperTries += 1; return []; } });

    const out = await PD.runPlatformDiscovery(CANDIDATE,
      { companies: ["Infosys"], institutions: [], titles: [], city: "", state: "", country: "", emailUser: "" }, {});
    const g = out.perPlatform.GITHUB;

    assert.equal(g.retryAttempts, 2);
    assert.equal(g.providerAttempts, tries + serperTries, "attempts == real provider invocations (tavily + serper)");
    assert.ok(g.providerAttempts > g.providerCalls, "attempts include retries, requests do not");
    assert.equal(out.callsUsed, g.providerAttempts, "budget is charged per attempt");
    assert.equal(out.logicalRequests, g.providerCalls);
    assert.equal(g.providerCallsOk >= 1, true);

    // a budget of 2 stops a provider that always answers 429 after exactly 2 attempts
    process.env.PLATFORM_DISCOVERY_MAX_CALLS = "2";
    tries = 0;
    H.setProviders({
      tavily: async () => { tries += 1; const e = new Error("rl"); e.response = { status: 429, headers: {} }; throw e; },
      serper: async () => [],
    });
    const out2 = await PD.runPlatformDiscovery(CANDIDATE,
      { companies: ["Infosys"], institutions: [], titles: [], city: "", state: "", country: "", emailUser: "" }, {});
    assert.ok(tries <= 2, `provider invoked ${tries} times with a budget of 2`);
    assert.ok(out2.callsUsed <= 2);
  } finally {
    delete process.env.PLATFORM_DISCOVERY_PLATFORMS;
    delete process.env.PLATFORM_DISCOVERY_MAX_CALLS;
    delete process.env.PLATFORM_MAX_QUERIES;
  }
});

test("R5. the same profile in different URL forms is one profile per platform (counted and stored once)", async () => {
  process.env.PLATFORM_DISCOVERY_PLATFORMS = "TWITTER,LINKEDIN";
  try {
    const dupTw = [
      { title: "Priya Verma (@priya_dev_bpl) / X", link: "https://x.com/priya_dev_bpl", snippet: "Priya Verma. Bhopal. Infosys" },
      { title: "Priya Verma (@priya_dev_bpl) / X", link: "https://twitter.com/priya_dev_bpl", snippet: "Priya Verma. Infosys" },
      { title: "Priya Verma (@priya_dev_bpl) / X", link: "https://x.com/priya_dev_bpl/", snippet: "Priya Verma" },
      { title: "Priya Verma (@priya_dev_bpl) / X", link: "https://x.com/priya_dev_bpl?s=20", snippet: "Priya Verma" },
    ];
    const dupLi = [
      li(7),
      { ...li(7), link: "https://in.linkedin.com/in/priya-verma-bhopal-7/?utm_source=share" },
      { ...li(7), link: "https://www.linkedin.com/in/priya-verma-bhopal-7/" },
    ];
    H.setProviders({
      serper: (q) => (/x\.com|twitter\.com/.test(q) ? dupTw : /linkedin/.test(q) ? dupLi : []),
      tavily: (q, o = {}) => ((o.includeDomains || [])[0] === "x.com" ? dupTw.map((r) => ({ title: r.title, url: r.link, content: r.snippet })) : []),
    });

    const { run } = await newRun();
    const p = await search(run._id);

    assert.equal(p.TWITTER.profileShapedUrls, 1);
    assert.equal(p.TWITTER.uniqueUrls, 1);
    assert.ok(p.TWITTER.discovered >= 4);
    assert.equal(p.LINKEDIN.profileShapedUrls, 1);

    const SR = ctx.models.SearchResult;
    assert.equal(await SR.countDocuments({ bgvRun: run._id, platform: "TWITTER" }), 1);
    assert.equal(await SR.countDocuments({ bgvRun: run._id, platform: "LINKEDIN" }), 1);
  } finally {
    delete process.env.PLATFORM_DISCOVERY_PLATFORMS;
  }
});

test("R6. independent targets with mixed config: reaching one limit never changes another platform's limit", async () => {
  process.env.PLATFORM_TARGETS = JSON.stringify({ GITHUB: 2, YOUTUBE: 20, LINKEDIN: 7 });
  try {
    install();
    resetCalls();
    const { run } = await newRun();
    const p = await search(run._id);
    assert.equal(p.GITHUB.target, 2);
    assert.equal(p.LINKEDIN.target, 7);
    assert.equal(p.YOUTUBE.target, 20);
    assert.equal(p.INSTAGRAM.target, 15, "everything else keeps the default of 15");
    assert.equal(p.GITHUB.status, "TARGET_REACHED");
    assert.equal(p.LINKEDIN.status, "TARGET_REACHED");
    assert.equal(p.YOUTUBE.status, "TARGET_REACHED");
    assert.ok(p.YOUTUBE.profileShapedUrls >= 20);
    assert.ok(p.LINKEDIN.profileShapedUrls >= 7 && p.LINKEDIN.profileShapedUrls < 20);
  } finally {
    delete process.env.PLATFORM_TARGETS;
  }
});

test("R7. URL shape is NOT reachability: shaped URLs are not called live; only a real request sets REACHABLE / NOT_FOUND", async () => {
  const realAdapter = axios.defaults.adapter;
  const gh = { "priya-gh-1": { name: "Priya Verma", bio: "Infosys Bhopal", company: "Infosys", location: "Bhopal, India" } };
  axios.defaults.adapter = async (config) => {
    const m = String(config.url).match(/api\.github\.com\/users\/([^/?#]+)/);
    const res = (data, status = 200) => ({ data, status, statusText: "", headers: {}, config, request: {} });
    if (m) return gh[m[1]] ? res(gh[m[1]]) : res({ message: "Not Found" }, 404);
    return res("nf", 404);
  };
  process.env.SEARCH_ENRICH_PROFILES = "true";
  try {
    install();
    resetCalls();
    const { run } = await newRun();
    const p = await search(run._id);

    // GitHub: shape ok for all 3, but only real requests decide reachability
    assert.equal(p.GITHUB.profileShapedUrls, 3);
    assert.equal(p.GITHUB.reachability.reachable, 1);
    assert.ok(p.GITHUB.reachability.notFound >= 1, "404 from the API is NOT_FOUND although the URL looks fine");
    assert.equal(p.GITHUB.reachability.reachable + p.GITHUB.reachability.notFound + p.GITHUB.reachability.unreachable + p.GITHUB.reachability.notChecked, p.GITHUB.stored);

    // LinkedIn: login-walled, never requested -> NOT_CHECKED, never "live"
    assert.equal(p.LINKEDIN.reachability.reachable, 0);
    assert.equal(p.LINKEDIN.reachability.notChecked, p.LINKEDIN.stored);

    const SR = ctx.models.SearchResult;
    const ok = await SR.findOne({ bgvRun: run._id, profileUrl: /github\.com\/priya-gh-1$/ }).lean();
    const missing = await SR.findOne({ bgvRun: run._id, profileUrl: /github\.com\/priya-gh-2$/ }).lean();
    const wall = await SR.findOne({ bgvRun: run._id, platform: "LINKEDIN" }).lean();
    assert.equal(ok.enrichment.reachability.status, "REACHABLE");
    assert.equal(missing.enrichment.reachability.status, "NOT_FOUND");
    assert.equal(wall.enrichment.reachability.status, "NOT_CHECKED");
    assert.ok(/LOGIN_WALLED/.test(wall.enrichment.reachability.reason));

    // the summary never uses the word "validated" for a shape check
    assert.equal(p.GITHUB.validatedUrls, undefined);
  } finally {
    axios.defaults.adapter = realAdapter;
    process.env.SEARCH_ENRICH_PROFILES = "false";
  }
});
