"use strict";

/**
 * Matching, ranking, exclusions and targeted-query validation.
 * Scenarios 1-8 and 14 are pure (no DB); 9-13 use the API + database.
 * No provider call is made.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");
const { CANDIDATE, build } = require("../benchmark/matching-dataset");
const matcher = require("../services/candidateMatch.service");
const ranking = require("../services/candidateMatchRanking.service");
const search = require("../services/candidateSearch.service");
const signals = require("../services/matchSignals.service");
const { mergeSearchResults } = require("../services/resultMerge.service");

const NO_ML = { ml: { enabled: false } };

const sr = (over) => ({
  _id: `x-${Math.random().toString(36).slice(2)}`,
  platform: "LINKEDIN",
  name: "Shubham Patel",
  rawData: { title: over.name || "Shubham Patel", snippet: over.snippet || "" },
  ...over,
  sourceUrl: over.profileUrl,
});

const matchOf = (over, candidate = CANDIDATE) => {
  const searchResult = sr(over);
  return { _id: `m-${searchResult._id}`, candidate, searchResult, ...matcher.calculateCandidateMatch(candidate, searchResult) };
};

const rank = (matches, opts = {}) => ranking.shortlistMatches(matches, { config: NO_ML, limit: 50, ...opts });

// ------------------------------------------------------------------
// 1. exact known profile URL
// ------------------------------------------------------------------
test("1. exact candidate-supplied URL is STRONG; a URL merely found by search is not evidence", () => {
  const exact = matchOf({ profileUrl: "https://in.linkedin.com/in/Shubham-Patel-PM/?trk=public_profile&utm_source=x", name: null });
  assert.equal(exact.matchStatus, "STRONG");
  assert.equal(exact.similarityScore, 100);
  assert.equal(exact.matchedSignals.profileUrl.matched, true);
  assert.equal(exact.matchDetails.components.profileUrl.trust, "CANDIDATE_SUPPLIED");

  const found = matchOf({ profileUrl: "https://www.linkedin.com/in/shubham-patel-zzz1" });
  assert.equal(found.matchedSignals.profileUrl.matched, false);
  assert.equal(found.matchDetails.components.profileUrl.trust, "SEARCH_DISCOVERED_NOT_EVIDENCE");
  assert.notEqual(found.matchStatus, "STRONG");
  assert.ok(found.similarityScore <= 40, `name-only must stay <= 40, got ${found.similarityScore}`);
});

// ------------------------------------------------------------------
// 2. full name + company + supporting evidence
// ------------------------------------------------------------------
test("2. correct name + company + title + city is STRONG and explains which components matched", () => {
  const m = matchOf({
    profileUrl: "https://www.linkedin.com/in/shubham-patel-q1",
    jobTitle: "Sr. Program Manager", company: "Masai Learning Pvt. Ltd.",
    location: { city: "Bengaluru Urban", state: "Karnataka", country: "India" },
  });
  assert.equal(m.matchStatus, "STRONG");
  assert.deepEqual(m.matchDetails.identity.independentEvidence.sort(), ["company", "jobTitle", "location"]);
  assert.match(m.explanation, /Name match/i);
  assert.equal(m.matchDetails.components.name.matched.length, 2);
});

// ------------------------------------------------------------------
// 3. same name, different identity evidence
// ------------------------------------------------------------------
test("3. same name but different company + country is CONFLICT, with visible SOFT/HARD conflicts", () => {
  const m = matchOf({
    profileUrl: "https://www.linkedin.com/in/shubham-patel-houston",
    jobTitle: "Civil Engineer", company: "L&T",
    location: { city: "Houston", state: "Texas", country: "United States" },
  });
  assert.equal(m.matchStatus, "CONFLICT");
  const fields = m.conflictingSignals.map((c) => c.field);
  assert.ok(fields.includes("company") && fields.some((f) => f.startsWith("location")));
  assert.ok(m.conflictingSignals.every((c) => typeof c.candidateValue === "string" && typeof c.searchResultValue === "string"));
  assert.ok(m.conflictingSignals.some((c) => c.severity === "HARD"));
});

// ------------------------------------------------------------------
// 4. similar name, nothing else
// ------------------------------------------------------------------
test("4. similar name with no support is WEAK; shared first name or surname is not enough; name-only never STRONG", () => {
  for (const name of ["Shubham Sharma", "Rahul Patel", "Subham Patil"]) {
    const m = matchOf({ name, profileUrl: `https://www.linkedin.com/in/${name.replace(/ /g, "-").toLowerCase()}` });
    assert.equal(m.matchStatus, "WEAK", name);
    assert.ok(m.similarityScore < 40, `${name}: ${m.similarityScore}`);
  }
  assert.equal(signals.compareNames("Shubham Patel", "Shubham Sharma").state, "MISMATCH");
  assert.equal(signals.compareNames("Shubham Patel", "Patel Shubham").state, "MATCH"); // order
  assert.equal(signals.compareNames("Shubham Patel", "Shubham K. Patel").state, "MATCH"); // middle initial
  assert.equal(signals.compareNames("Shubham Patel", "S. Patel").state, "PARTIAL"); // initial
  assert.equal(signals.compareNames("Shubham Patel", "Shubam Patel").state, "MATCH"); // 1-letter typo
  // regression: name + a name-derived username used to become STRONG
  const nameUser = matchOf({ username: "shubhampatel", profileUrl: "https://github.com/shubhampatel", platform: "GITHUB" });
  assert.equal(nameUser.matchStatus, "WEAK");
  assert.equal(nameUser.matchDetails.components.username.independentEvidence, false);
});

// ------------------------------------------------------------------
// 5. correct profile, incomplete public info
// ------------------------------------------------------------------
test("5. incomplete public info is UNKNOWN, not a mismatch: still reviewable, never penalised", () => {
  const m = matchOf({
    profileUrl: "https://www.linkedin.com/in/shubham-patel-iitb",
    education: [{ institution: "Indian Institute of Technology Bombay" }],
  });
  assert.ok(["POSSIBLE", "REVIEW_REQUIRED"].includes(m.matchStatus), m.matchStatus);
  // the only informational note allowed is "candidate supplied another LinkedIn URL"
  assert.deepEqual(m.conflictingSignals.map((c) => c.field).filter((f) => f !== "profileUrl"), []);
  assert.ok(m.matchDetails.dataQuality.unknownFields.includes("company"));
  assert.ok(m.matchDetails.identity.penalty <= 3);
});

// ------------------------------------------------------------------
// 6. sentence fragment instead of a location (+ query validation)
// ------------------------------------------------------------------
test("6. sentence-fragment location is ignored, not treated as a conflict", () => {
  const m = matchOf({
    profileUrl: "https://www.linkedin.com/in/shubham-patel-8a1b2c",
    jobTitle: "Senior Program Manager", company: "Masai",
    location: { city: "Hong Kong, is currently a Senior Program Manager at Masai. Shu" },
  });
  assert.equal(m.matchDetails.components.location.state, "UNKNOWN");
  assert.ok(m.matchDetails.dataQuality.rejectedFields.some((f) => f.startsWith("location")));
  assert.ok(!m.conflictingSignals.some((c) => c.field.startsWith("location")));
  assert.ok(["STRONG", "POSSIBLE"].includes(m.matchStatus));
});

test("6b. targeted queries: no fragments, junk usernames, generic words or generic titles; near-duplicates removed; failures are contained", () => {
  const good = (over) => ({ name: "Shubham Patel", platform: "LINKEDIN", profileUrl: `https://www.linkedin.com/in/${over.username}`, ...over });
  const results = [
    good({ username: "shubham-patel-email_369850393", company: "Teams", jobTitle: "Manager", location: { city: "Hong Kong, is currently a Senior Program Manager at Masai. Shu" } }),
    good({ username: "shubham-patel-ok", company: "Masai", jobTitle: "Senior Program Manager", location: { city: "Bengaluru", state: "Karnataka", country: "India" } }),
    good({ username: "shubham-patel-ok2", company: "Masai", jobTitle: "Senior Program Manager", location: { city: "Bengaluru", state: "Karnataka", country: "India" } }),
    null,
    { name: { weird: true }, location: 42, company: ["x"] },
  ];
  const diagnostics = {};
  const queries = search.buildTargetedSearchQueries(CANDIDATE, results, { skipCoreSites: true, diagnostics });

  const joined = queries.join("\n");
  assert.ok(!/is currently/i.test(joined), joined);
  assert.ok(!/email_369850393/.test(joined), joined);
  assert.ok(!/"teams"/i.test(joined), joined);
  assert.ok(!queries.includes('"Shubham Patel" "Manager"'), joined);
  assert.ok(queries.every((q) => q.trim().length > 3));
  // near duplicates collapse
  assert.equal(new Set(queries.map((q) => q.toLowerCase())).size, queries.length);
  assert.ok(diagnostics.rejected.length >= 0);

  const dd = signals.dedupeQueries(['"A B" "Masai" "Bengaluru"', '"A B" "Bengaluru" "Masai"', 'site:github.com "A B"', '"A B" "Masai"']);
  assert.equal(dd.queries.length, 3);
  assert.equal(signals.validateCompany("Teams").valid, false);
  assert.equal(signals.validateTitle("Manager").generic, true);
  assert.equal(signals.validateLocation({ city: "Bengaluru", state: "Karnataka", country: "India" }).valid, true);
  assert.equal(signals.validateQueryUsername("shubham-patel-email_369850393", "Shubham Patel").valid, false);
  assert.equal(signals.validateQueryUsername("shubhampatel-dev", "Shubham Patel").valid, true);
});

// ------------------------------------------------------------------
// 7. generic article / company page
// ------------------------------------------------------------------
test("7. article, company page and search page are WEAK/non-profile, excluded WITH a recorded reason", async () => {
  const pages = [
    matchOf({ platform: "OTHER", profileUrl: "https://news-example.com/article/shubham-patel-1", snippet: "Shubham Patel at Masai Bengaluru senior program manager" }),
    matchOf({ platform: "OTHER", profileUrl: "https://directory-example.com/company-profile/masai", snippet: "Masai company profile" }),
    matchOf({ platform: "OTHER", profileUrl: "https://jobs-example.com/search?q=shubham+patel", snippet: "Search results for Shubham Patel" }),
  ];
  for (const p of pages) {
    assert.equal(p.matchStatus, "WEAK");
    assert.ok(p.similarityScore <= 35);
    assert.ok(p.matchDetails.identity.statusReasons.includes("NOT_A_PROFILE_PAGE"));
  }
  const out = await rank(pages);
  assert.equal(out.totalShortlist, 0);
  const ex = await rank(pages, { view: "excluded" });
  assert.equal(ex.data.length, 3);
  assert.ok(ex.data.every((d) => d.exclusion.reasons.length && d.exclusion.stage));
});

// ------------------------------------------------------------------
// 8. relevant profile discovered early must remain
// ------------------------------------------------------------------
test("8. an early-found relevant profile survives 400 later weaker results and ranks above them", async () => {
  const items = build();
  const relevant = items.filter((i) => i.label === "RELEVANT");
  const matches = items.map(({ searchResult }) => ({
    _id: `m-${searchResult._id}`, candidate: CANDIDATE, searchResult,
    ...matcher.calculateCandidateMatch(CANDIDATE, searchResult),
  }));
  const out = await rank(matches);
  const shown = new Set(out.data.map((d) => d.searchResult._id));
  for (const r of relevant) assert.ok(shown.has(r.searchResult._id), `relevant ${r.searchResult._id} missing from the shortlist`);

  // none of the 11 relevant is ranked below a non-relevant one
  const labels = new Map(items.map((i) => [i.searchResult._id, i.label]));
  const order = out.data.map((d) => labels.get(d.searchResult._id));
  const lastRelevant = order.lastIndexOf("RELEVANT");
  assert.ok(order.slice(0, lastRelevant + 1).every((l) => l === "RELEVANT"), order.join(","));
  // the counts never mix stages
  assert.equal(out.counts.discovered, items.length);
  assert.ok(out.counts.rejectedConflicting > 0 && out.counts.weak > 0);
});

// ------------------------------------------------------------------
// 9, 10, 14. more than 15 on one platform; independent platforms; fewer than 15
// ------------------------------------------------------------------
const linkedinMatch = (i) =>
  matchOf({ username: `shubham-patel-${i}x`, profileUrl: `https://www.linkedin.com/in/shubham-patel-${i}x`, jobTitle: "Senior Program Manager", company: "Masai", location: { city: "Bengaluru", state: "Karnataka", country: "India" } });

test("9/10/14. >15 LinkedIn results stay available; platforms are independent; a short platform is not padded", async () => {
  const li = Array.from({ length: 40 }, (_, i) => linkedinMatch(i));
  const gh = Array.from({ length: 3 }, (_, i) =>
    matchOf({ platform: "GITHUB", username: `shubhampatel-g${i}`, profileUrl: `https://github.com/shubhampatel-g${i}`, company: "Masai", headline: "Program manager at Masai" }));
  const all = [...li, ...gh];

  const liView = await rank(all, { platform: "LINKEDIN", limit: 50 });
  assert.equal(liView.totalShortlist, 15, "LinkedIn tab is capped at the per-platform target");
  assert.equal(liView.counts.discovered, 40);
  assert.equal(liView.excludedByReason.PLATFORM_CAP, 25, "overflow is recorded, not silently dropped");
  const overflow = await rank(all, { platform: "LINKEDIN", view: "excluded", limit: 50 });
  assert.equal(overflow.pagination.total, 25);
  assert.ok(overflow.data.every((d) => d.exclusion.reasons.includes("PLATFORM_CAP")));

  // GitHub is untouched by LinkedIn volume, and shows only what exists (3, no padding)
  const ghView = await rank(all, { platform: "GITHUB", limit: 50 });
  assert.equal(ghView.totalShortlist, 3);
  assert.equal(ghView.counts.discovered, 3);
  assert.ok(ghView.data.every((d) => d.searchResult.platform === "GITHUB"));
  assert.equal(Math.max(15 - ghView.totalBeforeCap, 0), 12, "shortfall of 12 is reportable");

  // global human-review shortlist stays 15
  const global = await rank(all, { limit: 50 });
  assert.equal(global.totalShortlist, 15);
});

// ------------------------------------------------------------------
// 11. duplicate profile URLs
// ------------------------------------------------------------------
test("11. duplicate profile URLs (www/in./trailing slash/tracking) collapse to one result", () => {
  const merged = mergeSearchResults(
    [{ title: "Shubham Patel - Senior Program Manager - Masai | LinkedIn", url: "https://www.linkedin.com/in/shubham-patel-pm", content: "Bengaluru", score: 0.8 }],
    [
      { title: "Shubham Patel | LinkedIn", link: "https://in.linkedin.com/in/shubham-patel-pm/?utm_source=share", snippet: "Masai" },
      { title: "Shubham Patel | LinkedIn", link: "https://www.linkedin.com/in/shubham-patel-pm/", snippet: "Masai" },
    ]
  );
  assert.equal(merged.filter((r) => /shubham-patel-pm/.test(r.profileUrl)).length, 1);
});

// ------------------------------------------------------------------
// 12 + 13: database and API
// ------------------------------------------------------------------
let ctx;
test.before(async () => { ctx = await H.startAll(); });
test.after(async () => { await ctx.stop(); });

const seedRun = async (specs) => {
  const { Candidate, BgvRun, SearchResult } = ctx.models;
  const candidate = await Candidate.create({
    fullName: CANDIDATE.fullName, email: `m${Math.random().toString(36).slice(2)}@example.com`,
    location: CANDIDATE.location, currentCompany: "Masai", currentJobTitle: "Senior Program Manager",
    education: CANDIDATE.education, experience: CANDIDATE.experience,
  });
  const run = await BgvRun.create({ candidate: candidate._id, status: "MATCHING" });
  const docs = [];
  for (const spec of specs) {
    docs.push(await SearchResult.create({ bgvRun: run._id, sourceUrl: spec.profileUrl, rawData: { title: spec.name, snippet: spec.snippet || "" }, ...spec }));
  }
  return { candidate, run, docs };
};

test("12. CandidateMatch create/update is idempotent across retries, parallel runs and human decisions", async () => {
  const { CandidateMatch } = ctx.models;
  const { candidate, run, docs } = await seedRun([
    { name: "Shubham Patel", platform: "LINKEDIN", profileUrl: "https://www.linkedin.com/in/shubham-patel-r1", company: "Masai", jobTitle: "Senior Program Manager" },
    // education conflict used to be written as an array into a String field
    { name: "Shubham Patel", platform: "LINKEDIN", profileUrl: "https://www.linkedin.com/in/shubham-patel-r2", company: "Infosys", education: [{ institution: "Oxford University" }], location: { city: "London", country: "United Kingdom" } },
  ]);

  const first = await matcher.createMatchesForBgvRun({ candidateId: candidate._id, bgvRunId: run._id });
  assert.equal(first.totalMatches, 2);
  assert.equal(first.failedMatches, 0);

  // retry sequentially and in parallel
  await matcher.createMatchesForBgvRun({ candidateId: candidate._id, bgvRunId: run._id });
  await Promise.all(Array.from({ length: 5 }, () => matcher.createMatchesForBgvRun({ candidateId: candidate._id, bgvRunId: run._id })));
  assert.equal(await CandidateMatch.countDocuments({ bgvRun: run._id }), 2);

  const stored = await CandidateMatch.findOne({ bgvRun: run._id, searchResult: docs[0]._id }).lean();
  assert.equal(stored.matchStatus, "POSSIBLE");
  assert.ok(stored.matchDetails.identity.independentEvidence.includes("company"));

  // a human decision is never overwritten by a re-run
  await CandidateMatch.updateOne({ _id: stored._id }, { $set: { reviewStatus: "APPROVED", reviewerNotes: "verified by phone" } });
  await ctx.models.Candidate.updateOne({ _id: candidate._id }, { $set: { currentCompany: "Somewhere Else" } });
  await matcher.createMatchesForBgvRun({ candidateId: candidate._id, bgvRunId: run._id });
  const after = await CandidateMatch.findOne({ _id: stored._id }).lean();
  assert.equal(after.reviewStatus, "APPROVED");
  assert.equal(after.reviewerNotes, "verified by phone");
  assert.equal(after.matchStatus, "POSSIBLE", "automatic status must not replace a reviewed profile's status");
  assert.ok(after.matchDetails.automaticStatusNotApplied);
});

test("13. API: platform filter, pagination, counts and the excluded view are consistent and run-scoped", async () => {
  const specs = [];
  for (let i = 0; i < 22; i++) specs.push({ name: "Shubham Patel", platform: "LINKEDIN", profileUrl: `https://www.linkedin.com/in/shubham-patel-api${i}`, company: "Masai", jobTitle: "Senior Program Manager", location: { city: "Bengaluru", state: "Karnataka", country: "India" } });
  for (let i = 0; i < 3; i++) specs.push({ name: "Shubham Patel", platform: "GITHUB", profileUrl: `https://github.com/shubhampatel-api${i}`, username: `shubhampatel-api${i}`, company: "Masai" });
  specs.push({ name: "Shubham Patel", platform: "OTHER", profileUrl: "https://news-example.com/article/shubham-patel", snippet: "article" });
  specs.push({ name: "Shubham Patel", platform: "INSTAGRAM", profileUrl: "https://www.instagram.com/shubhampatel9991", username: "shubhampatel9991" });

  const A = await seedRun(specs);
  const B = await seedRun([{ name: "Shubham Patel", platform: "GITHUB", profileUrl: "https://github.com/other-run-profile", username: "other-run", company: "Masai" }]);
  await matcher.createMatchesForBgvRun({ candidateId: A.candidate._id, bgvRunId: A.run._id });
  await matcher.createMatchesForBgvRun({ candidateId: B.candidate._id, bgvRunId: B.run._id });

  const g = (path) => ctx.call("GET", `/candidate-matches${path}`);

  const gh = await g(`/run/${A.run._id}/platform/GITHUB`);
  assert.equal(gh.status, 200);
  assert.equal(gh.body.data.length, 3);
  assert.ok(gh.body.data.every((d) => d.searchResult.platform === "GITHUB" && String(d.bgvRun) === String(A.run._id)));
  assert.equal(gh.body.counts.discovered, 3);
  assert.equal(gh.body.shortfall, 12);

  const li1 = await g(`/run/${A.run._id}/platform/LINKEDIN?limit=10&page=1`);
  const li2 = await g(`/run/${A.run._id}/platform/LINKEDIN?limit=10&page=2`);
  assert.equal(li1.body.data.length, 10);
  assert.equal(li2.body.data.length, 5, "per-platform view is capped at the target (15)");
  assert.equal(li1.body.pagination.total, 15);
  const ids = new Set([...li1.body.data, ...li2.body.data].map((d) => d._id));
  assert.equal(ids.size, 15, "no duplicates across pages");
  const exLi = await g(`/run/${A.run._id}/platform/LINKEDIN?view=excluded&limit=50`);
  assert.equal(exLi.body.data.length, 7);
  assert.ok(exLi.body.data.every((d) => d.exclusion.reasons.includes("PLATFORM_CAP")));

  // global review list: 15 max, counts distinguish stages
  const top = await g(`/run/${A.run._id}/relevant`);
  assert.equal(top.body.data.length, 15);
  assert.equal(top.body.counts.discovered, specs.length);
  assert.ok(top.body.counts.matched >= 15);
  assert.ok(top.body.counts.weak >= 2);
  assert.equal(top.body.counts.discovered, top.body.counts.matched + top.body.counts.reviewRequired + top.body.counts.weak + top.body.counts.rejectedConflicting);

  // excluded view shows article + instagram name-only with reasons
  const ex = await g(`/run/${A.run._id}/relevant?view=excluded&limit=50`);
  const art = ex.body.data.find((d) => /article/.test(d.searchResult.profileUrl));
  assert.ok(art && art.exclusion.reasons.length);
  assert.ok(ex.body.data.every((d) => String(d.bgvRun) === String(A.run._id)));

  // another run never leaks in
  assert.equal((await g(`/run/${B.run._id}/relevant`)).body.counts.discovered, 1);
});
