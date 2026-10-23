"use strict";

/**
 * Search-quality benchmark on labelled, mocked data.
 *
 *   node benchmark/run.js <path-to-Backend-tree>        (needs TEST_MONGO_URI)
 *
 * Works on any tree that has the same service entry points, so the same
 * fixtures run against the ORIGINAL code and the IMPROVED code.
 * No live search, no paid API calls: providers, GitHub API and web pages
 * are all fixtures served through a mocked HTTP layer.
 */

const path = require("path");
const http = require("http");

const tree = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const req = (p) => require(path.join(tree, p));

process.env.NODE_ENV = "test";
process.env.SEARCH_ENRICH_IMAGES = "false";
process.env.SEARCH_CONCURRENCY = "2";

const F = require("./fixtures");

const realLog = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const startFakeMl = () =>
  new Promise((resolve) => {
    const toks = (t) => new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1));
    const jac = (a, b) => {
      const A = toks(a), B = toks(b);
      if (!A.size || !B.size) return 0;
      let i = 0; A.forEach((x) => B.has(x) && i++);
      return i / (A.size + B.size - i);
    };
    const s = http.createServer((rq, rs) => {
      let body = "";
      rq.on("data", (c) => (body += c));
      rq.on("end", () => {
        if (rq.url === "/health") { rs.end("{}"); return; }
        const p = JSON.parse(body || "{}");
        const results = (p.result_texts || []).map((t, index) => {
          const sim = jac(p.candidate_text, t);
          return { index, similarity: sim, similarityPercent: +(sim * 100).toFixed(2) };
        });
        rs.writeHead(200, { "Content-Type": "application/json" });
        rs.end(JSON.stringify({ success: true, results }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

(async () => {
  const ml = await startFakeMl();
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${ml.address().port}`;

  const axios = require(path.join(tree, "node_modules/axios"));
  const httpCalls = { github: 0, pages: 0 };
  axios.defaults.adapter = async (config) => {
    const url = String(config.url);
    const ok = (data, status = 200) => ({ data, status, statusText: "", headers: {}, config, request: {} });
    let m;
    if ((m = url.match(/^https:\/\/api\.github\.com\/users\/([^/?#]+)/))) {
      httpCalls.github += 1;
      const d = F.GITHUB_API[decodeURIComponent(m[1])];
      return d ? ok(d) : ok({ message: "Not Found" }, 404);
    }
    if (F.PAGES[url]) { httpCalls.pages += 1; return ok(F.PAGES[url]); }
    httpCalls.pages += 1;
    return ok("not found", 404);
  };

  const mongoose = require(path.join(tree, "node_modules/mongoose"));
  await mongoose.connect(process.env.TEST_MONGO_URI, { dbName: `bench_${process.pid}_${Date.now()}` });

  const { registerProvider } = req("services/searchProvider.service");
  const apiCalls = { tavily: 0, serper: 0 };
  registerProvider("tavily", { search: async () => { apiCalls.tavily += 1; return F.tavily; } });
  registerProvider("serper", { search: async (q, o = {}) => { apiCalls.serper += 1; return !o.page || o.page === 1 ? F.serper : []; } });

  const Candidate = req("models/Candidate");
  const BgvRun = req("models/BgvRun");
  const SearchResult = req("models/SearchResult");

  const candidate = await Candidate.create(F.CANDIDATE);
  const run = await BgvRun.create({ candidate: candidate._id });

  const { searchCandidate } = req("services/candidateSearch.service");
  const { createMatchesForBgvRun } = req("services/candidateMatch.service");
  const { getTopRelevantMatches } = req("services/candidateMatchRanking.service");

  await searchCandidate({ candidateId: candidate._id, bgvRunId: run._id });
  await createMatchesForBgvRun({ candidateId: candidate._id, bgvRunId: run._id });
  const top = await getTopRelevantMatches({ bgvRunId: run._id, limit: 15 });

  const stored = await SearchResult.find({ bgvRun: run._id }).lean();
  if (process.env.BENCH_DUMP) realLog(JSON.stringify(stored.filter((x) => /bhopal/.test(x.profileUrl)).map(({ rawData, ...r }) => r), null, 1));
  const key = F.key;
  const isRel = (u) => F.LABELS.RELEVANT.includes(key(u));
  const isGen = (u) => F.LABELS.GENERIC.includes(key(u));

  const list = (top.matches || top.data || []).map((m) => m.searchResult).filter(Boolean);
  const relInList = new Set(list.filter((s) => isRel(s.profileUrl)).map((s) => key(s.profileUrl)));
  const relInDb = new Set(stored.filter((s) => isRel(s.profileUrl)).map((s) => key(s.profileUrl)));

  const FIELDS = [
    (s) => s.headline, (s) => s.company, (s) => s.jobTitle,
    (s) => s.location && (s.location.city || s.location.state || s.location.country),
    (s) => s.education && s.education.some((e) => e.institution || e.degree),
    (s) => s.bio, (s) => s.previousEmployers && s.previousEmployers.length,
    (s) => s.linkedProfiles && s.linkedProfiles.length, (s) => s.username,
    (s) => s.profileImageUrl || (s.profileImageUrls && s.profileImageUrls.length),
  ];
  const relDocs = stored.filter((s) => isRel(s.profileUrl));
  const fieldsPerRel = relDocs.length
    ? relDocs.reduce((a, s) => a + FIELDS.filter((f) => !!f(s)).length, 0) / relDocs.length
    : 0;

  const uniq = new Set(stored.map((s) => key(s.profileUrl)));
  const run2 = await BgvRun.findById(run._id).lean();

  const metrics = {
    tree: path.basename(path.dirname(tree)) + "/" + path.basename(tree),
    shortlistSize: list.length,
    precisionAt15: list.length ? +(list.filter((s) => isRel(s.profileUrl)).length / list.length).toFixed(3) : 0,
    recallInShortlist: +(relInList.size / F.LABELS.RELEVANT.length).toFixed(3),
    recallInDatabase: +(relInDb.size / F.LABELS.RELEVANT.length).toFixed(3),
    relevantRank: list.map((s, i) => (isRel(s.profileUrl) ? i + 1 : null)).filter(Boolean),
    usefulFieldsPerRelevantProfile: +fieldsPerRel.toFixed(2),
    storedResults: stored.length,
    pctStoredWithValidUrl: stored.length ? +((stored.filter((s) => /^https?:\/\//.test(s.profileUrl || "")).length / stored.length) * 100).toFixed(1) : 0,
    duplicateRate: stored.length ? +(1 - uniq.size / stored.length).toFixed(3) : 0,
    genericInShortlist: list.filter((s) => isGen(s.profileUrl)).length,
    storedGenericPages: stored.filter((s) => isGen(s.profileUrl)).length,
    resultsWithoutUrlRetainedForAudit: (run2.searchSummary && run2.searchSummary.excludedRecords ? run2.searchSummary.excludedRecords.length : 0),
    providerApiCalls: apiCalls.tavily + apiCalls.serper,
    publicSourceRequests: httpCalls.github + httpCalls.pages,
  };

  if (process.env.BENCH_VERBOSE) realLog((top.matches || top.data || []).map((m, i) => `${i + 1}. ${m.searchResult && m.searchResult.profileUrl} tier=${m.rankingEvidence && m.rankingEvidence.reviewTier} score=${m.reviewRankScore} compl=${m.rankingEvidence && m.rankingEvidence.completeness && m.rankingEvidence.completeness.score}`).join('\n'));
  realLog(JSON.stringify(metrics, null, 2));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  ml.close();
  process.exit(0);
})().catch((e) => { realLog("BENCH ERROR", e.stack); process.exit(1); });
