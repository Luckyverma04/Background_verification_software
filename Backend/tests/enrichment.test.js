"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const H = require("./helpers");
const F = require("../benchmark/fixtures");
const { normalizeSerperResult } = require("../services/resultMerge.service");
const E = require("../services/profileEnrichment.service");

let ctx;
const realAdapter = axios.defaults.adapter;
const http = { github: {}, pages: {}, calls: [] };

const fakeHttp = async (config) => {
  const url = String(config.url);
  http.calls.push(url);
  const res = (data, status = 200) => ({ data, status, statusText: "", headers: {}, config, request: {} });
  let m;
  if ((m = url.match(/api\.github\.com\/users\/([^/?#]+)/))) {
    const entry = http.github[m[1]];
    if (entry === "RATE") return res({ message: "rate limit" }, 403);
    return entry ? res(entry) : res({ message: "Not Found" }, 404);
  }
  if (http.pages[url]) return res(http.pages[url]);
  return res("nf", 404);
};

test.before(async () => {
  ctx = await H.startAll();
  axios.defaults.adapter = fakeHttp;
});

test.after(async () => {
  axios.defaults.adapter = realAdapter;
  await ctx.stop();
});

test("E1. LinkedIn title is parsed structurally (title keeps 'Senior', no 'LinkedIn Bhopal' city, no trailing dot, previous employer is not current company)", () => {
  const r = normalizeSerperResult(F.serper[0]);
  assert.equal(r.name, "Priya Verma");
  assert.equal(r.jobTitle, "Senior Software Engineer");
  assert.equal(r.company, "Infosys");
  assert.equal(r.location.city, "Bhopal");
});

test("E2. completeness counts available fields only; sparse != mismatch", () => {
  const sparse = E.computeCompleteness({ username: "x" });
  assert.equal(sparse.available, 1);
  assert.ok(sparse.missingFields.includes("company"));
  assert.equal(sparse.sourceQuality, "SEARCH_SNIPPET_ONLY");
  const rich = E.computeCompleteness({ company: "A", jobTitle: "B", headline: "C", username: "u", location: { city: "X" } });
  assert.equal(rich.available, 5);
});

test("E3. buildEnrichment: structured source may replace snippet guesses (recorded), human values never replaced, never invents, never promotes a snippet to bio", () => {
  const sr = {
    platform: "GITHUB", username: "u1", profileUrl: "https://github.com/u1",
    company: "Existing Corp", rawData: { snippet: "Some long marketing snippet about u1." },
    education: [], previousEmployers: [], linkedProfiles: [],
  };
  const { updates, enrichment } = E.buildEnrichment(sr, [
    { source: { type: "GITHUB_API", ok: true }, data: { bio: "Real bio", company: "Other Corp", location: { city: "Pune", state: null, country: "India" }, links: ["https://u1.dev"] } },
  ]);
  assert.equal(updates.company, "Other Corp");
  assert.equal(E.buildEnrichment({ ...sr, source: "MANUAL" }, [{ source: { type: "GITHUB_API", ok: true }, data: { company: "Other Corp" } }]).updates.company, undefined, "human/KB values are never replaced");
  assert.equal(updates.bio, "Real bio");
  assert.equal(updates.location.city, "Pune");
  assert.equal(updates.linkedProfiles[0].url.includes("u1.dev"), true);
  assert.equal(enrichment.fields.education, "UNKNOWN");
  assert.ok(enrichment.missingFields.includes("education"));
  assert.ok(enrichment.limitations.includes("EMPLOYMENT_DATES_UNKNOWN_UNLESS_SOURCE_STATES_THEM"));

  const snippetOnly = E.buildEnrichment({ ...sr, platform: "LINKEDIN", company: "" }, []);
  assert.equal(snippetOnly.updates.bio, undefined);
  assert.equal(snippetOnly.enrichment.status, "RESTRICTED");
  assert.ok(snippetOnly.enrichment.limitations.includes("PLATFORM_RESTRICTED_NO_LOGINLESS_FETCH"));
});

test("E4. full pipeline stores professional fields, enriches via public sources, keeps no-URL results for audit, is idempotent", async () => {
  process.env.SEARCH_ENRICH_PROFILES = "true";
  http.github = { "priyaverma-dev": F.GITHUB_API["priyaverma-dev"], priyaverma: "RATE" };
  http.pages = F.PAGES;
  http.calls.length = 0;

  H.setProviders({
    serper: (q, o = {}) => (!o.page || o.page === 1 ? F.serper.slice(0, 13) : []),
    tavily: () => F.tavily,
  });

  const cand = (await ctx.call("POST", "/candidates", F.CANDIDATE)).body.data;
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;
  const s = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  assert.equal(s.status, 200, JSON.stringify(s.body));

  const SR = ctx.models.SearchResult;
  const li = await SR.findOne({ bgvRun: run._id, profileUrl: /linkedin\.com\/in\/priya-verma-bhopal$/ }).lean();
  assert.equal(li.company, "Infosys");
  assert.equal(li.jobTitle, "Senior Software Engineer");
  assert.ok(li.education.length > 0);
  assert.equal(li.enrichment.status, "RESTRICTED"); // LinkedIn is never fetched

  const gh = await SR.findOne({ bgvRun: run._id, profileUrl: /github\.com\/priyaverma-dev$/ }).lean();
  assert.match(gh.bio, /Backend engineer/);
  assert.equal(gh.location.city, "Bhopal");
  assert.ok(gh.linkedProfiles.some((l) => /priyaverma\.dev/.test(l.url)));
  assert.equal(gh.enrichment.sources.find((x) => x.type === "GITHUB_API").ok, true);

  // rate-limited lookup is recorded honestly, nothing invented
  const other = await SR.findOne({ bgvRun: run._id, profileUrl: /github\.com\/priyaverma$/ }).lean();
  assert.ok(other.enrichment.limitations.includes("GITHUB_RATE_LIMITED"));
  assert.equal(other.bio, undefined);

  // personal site: JSON-LD Person
  const site = await SR.findOne({ bgvRun: run._id, profileUrl: /priyaverma\.dev\/?$/ }).lean();
  assert.equal(site.jobTitle, "Senior Software Engineer");
  assert.equal(site.company, "Infosys");

  // LinkedIn/X/Instagram were never requested from the network
  assert.ok(!http.calls.some((u) => /linkedin|x\.com|instagram|facebook/.test(u)));

  // results without a URL are kept for audit, not turned into fake profiles
  const runDoc = await ctx.models.BgvRun.findById(run._id).lean();
  assert.ok(runDoc.searchSummary.excludedRecords.some((r) => r.reason === "NO_PROFILE_URL" && r.snippet));
  assert.equal(await SR.countDocuments({ bgvRun: run._id, profileUrl: { $in: [null, ""] } }), 0);

  // repeat: nothing is fetched twice
  const before = http.calls.length;
  await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  const newGithub = http.calls.slice(before).filter((u) => /api\.github\.com/.test(u));
  assert.equal(newGithub.length, 0, "already-enriched profiles must not be fetched again");
});

test("E5. review list: namesakes with conflicting data stay out, relevant profiles rank first, completeness reported separately", async () => {
  const run = (await ctx.models.BgvRun.findOne({}).lean());
  const match = await ctx.call("POST", `/bgv-runs/${run._id}/match`, {});
  assert.equal(match.status, 200, JSON.stringify(match.body));
  const r = await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant`);
  const list = r.body.data;
  assert.ok(list.length <= 15);
  const urls = list.map((m) => m.searchResult.profileUrl);
  assert.ok(urls.some((u) => /priya-verma-bhopal/.test(u)));
  assert.ok(!urls.some((u) => /priya-verma-london|priya-verma-mumbai|peoplefinder|careerblog/.test(u)));
  for (const m of list) {
    assert.equal(typeof m.rankingEvidence.completeness.score, "number");
    assert.ok(Array.isArray(m.rankingEvidence.completeness.missingFields));
  }
  // everything is still stored
  assert.ok((await ctx.models.SearchResult.countDocuments({ bgvRun: run._id })) > list.length);
});
