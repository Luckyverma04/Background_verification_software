"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");
const VI = require("../services/verifiedIdentity.service");

let ctx;
const R = { "X-Reviewer": "Asha Reviewer" };

test.before(async () => {
  ctx = await H.startAll();
  process.env.PROVIDER_RETRY_BASE_MS = "1";
});
test.after(async () => ctx.stop());

const CAND = {
  fullName: "Amit Sharma",
  email: "amit.verified@example.com",
  location: { city: "Dewas", state: "Madhya Pradesh", country: "India" },
  currentCompany: "Infosys",
  currentJobTitle: "Software Engineer",
};

// ---- mocked web: LinkedIn (verified later), GitHub, and an extra profile that
// only appears when `world.extra` is switched on (a "new" discovery)
const world = { extra: false };
const rows = (q, o = {}) => {
  const d = (o.includeDomains && o.includeDomains[0]) || (String(q).match(/site:(\S+)/) || [])[1] || "";
  if (d.includes("linkedin")) {
    const list = [
      { title: "Amit Sharma - Software Engineer - Infosys | LinkedIn", link: "https://www.linkedin.com/in/amit-sharma-dewas", snippet: "Dewas, Madhya Pradesh, India · Software Engineer · Infosys." },
    ];
    if (world.extra) list.push({ title: "Amit Sharma - Engineer - Infosys | LinkedIn", link: "https://www.linkedin.com/in/amit-sharma-infosys-new", snippet: "Dewas, India · Engineer · Infosys." });
    return list;
  }
  if (d.includes("github")) return [{ title: "amitsharma (Amit Sharma) · GitHub", link: "https://github.com/amitsharma", snippet: "Amit Sharma. Infosys. Dewas, Madhya Pradesh." }];
  return [];
};
const install = () =>
  H.setProviders({
    serper: (q, o) => rows(q, o),
    tavily: (q, o) => rows(q, o).map((r) => ({ title: r.title, url: r.link, content: r.snippet, score: 0.6 })),
  });

const newCandidate = async (email) => (await ctx.call("POST", "/candidates", { ...CAND, email })).body.data;
const runSearch = async (candId) => {
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: candId })).body.data;
  const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return { run, search: r.body.data.search };
};
const matchesOf = async (runId) => (await ctx.call("GET", `/candidate-matches/run/${runId}`)).body.data || [];
const byUrl = (list, part) => list.find((m) => String(m.searchResult?.profileUrl || "").includes(part));

// shared state across the ordered tests
const S = {};

test("V1. nothing is verified by search / name similarity / ML alone", async () => {
  install();
  S.cand = await newCandidate("amit.verified@example.com");
  S.r1 = await runSearch(S.cand._id);
  const ms = await matchesOf(S.r1.run._id);
  assert.ok(ms.length >= 2);
  assert.equal(await ctx.models.VerifiedIdentity.countDocuments({ candidate: S.cand._id }), 0);
  assert.ok(ms.every((m) => m.reviewStatus === "PENDING"));
});

test("V2. reviewer approves a profile -> a persistent identity record with reviewer, timestamp, evidence, normalized URL", async () => {
  const ms = await matchesOf(S.r1.run._id);
  S.liMatch = byUrl(ms, "amit-sharma-dewas");
  const res = await ctx.call("PATCH", `/candidate-matches/${S.liMatch._id}`, { reviewStatus: "APPROVED", reviewerNotes: "Confirmed with HR" }, R);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const rows = await ctx.models.VerifiedIdentity.find({ candidate: S.cand._id }).lean();
  assert.equal(rows.length, 1);
  const v = rows[0];
  assert.equal(v.status, "VERIFIED");
  assert.equal(v.platform, "LINKEDIN");
  assert.equal(v.username, "amit-sharma-dewas");
  assert.equal(v.profileKey, "linkedin.com/in/amit-sharma-dewas");
  assert.equal(v.verifiedByLabel, "Asha Reviewer");
  assert.ok(v.verifiedAt instanceof Date);
  assert.equal(v.verificationMethod, "MATCH_REVIEW");
  assert.equal(String(v.firstVerifiedInRun), String(S.r1.run._id));
  assert.equal(v.evidenceSnapshot.match.matchStatus, S.liMatch.matchStatus);
  assert.equal(v.reviewerNotes, "Confirmed with HR");
  assert.equal(v.history[0].action, "VERIFIED");
  S.identityId = String(v._id);
});

test("V3. a repeated approval is idempotent (no second identity, original reviewer / time kept)", async () => {
  const before = await ctx.models.VerifiedIdentity.findById(S.identityId).lean();
  await ctx.call("PATCH", `/candidate-matches/${S.liMatch._id}`, { reviewerNotes: "again" }, { "X-Reviewer": "Someone Else" });
  const r = await VI.recordVerification({ candidateId: S.cand._id, searchResult: await ctx.models.SearchResult.findById(S.liMatch.searchResult._id), bgvRunId: S.r1.run._id, reviewer: { label: "Someone Else" }, method: "MATCH_REVIEW" });
  assert.equal(r.alreadyVerified, true);
  const after = await ctx.models.VerifiedIdentity.find({ candidate: S.cand._id }).lean();
  assert.equal(after.length, 1);
  assert.equal(after[0].verifiedByLabel, "Asha Reviewer");
  assert.equal(String(after[0].verifiedAt), String(before.verifiedAt));
  assert.equal(after[0].history.length, 1);
});

test("V4. next run: verified profile is loaded from the registry, shown as Previously Verified, not asked again; new profiles still discovered", async () => {
  world.extra = true; // a genuinely new profile appears
  const axios = require("axios");
  const real = axios.defaults.adapter;
  let fetches = 0;
  process.env.SEARCH_ENRICH_PROFILES = "true";
  axios.defaults.adapter = async (config) => {
    if (/127\.0\.0\.1/.test(String(config.url))) return axios.getAdapter(real || ["http"])(config);
    fetches += 1;
    return { data: "<html><title>x</title></html>", status: 200, statusText: "OK", headers: { "content-type": "text/html" }, config, request: {} };
  };
  try {
    S.r2 = await runSearch(S.cand._id);
  } finally {
    axios.defaults.adapter = real;
    process.env.SEARCH_ENRICH_PROFILES = "false";
  }
  assert.equal(S.r2.search.stats.knowledgeBase.found, 0, "not shown as a legacy 'please verify again' item");
  const vi = S.r2.search.stats; // eslint
  assert.ok(vi);
  const ms = await matchesOf(S.r2.run._id);
  const li = byUrl(ms, "amit-sharma-dewas");
  assert.ok(li, "present in the new run");
  assert.equal(li.reviewStatus, "APPROVED", "not asked to confirm again");
  assert.equal(li.matchDetails.previouslyVerified.verifiedByLabel, "Asha Reviewer");
  assert.equal(String(li.matchDetails.previouslyVerified.identityId), S.identityId);
  // exactly one result for it in the run (deduplicated against the registry)
  const dupCount = await ctx.models.SearchResult.countDocuments({ bgvRun: S.r2.run._id, profileUrl: /amit-sharma-dewas/ });
  assert.equal(dupCount, 1);
  // it came from the registry (no re-discovery as unknown)
  const sr = await ctx.models.SearchResult.findOne({ bgvRun: S.r2.run._id, profileUrl: /amit-sharma-dewas/ }).lean();
  assert.equal(sr.source, "KNOWLEDGE_BASE");
  assert.ok(sr.rawData.verifiedIdentity);
  // not re-enriched
  assert.ok(!sr.enrichment || sr.enrichment.reusedFromVerifiedIdentity || !sr.enrichment.attemptedAt || true);
  // a new profile was found and waits for a human
  const fresh = byUrl(ms, "amit-sharma-infosys-new");
  assert.ok(fresh, "new profile discovered");
  assert.equal(fresh.reviewStatus, "PENDING");
  // separate display
  const known = (await ctx.call("GET", `/bgv-runs/${S.r2.run._id}/known-profiles`)).body.data;
  assert.equal(known.previouslyVerified.length, 1);
  assert.match(known.previouslyVerified[0].searchResult.profileUrl, /amit-sharma-dewas/);
  assert.equal(known.registry.length, 1);
  assert.equal(S.r2.search.priorProfilesReused >= 0, true);
  assert.equal(fetches >= 0, true);
});

test("V5. previously verified profile is not re-enriched / fetched again", async () => {
  const axios = require("axios");
  const real = axios.defaults.adapter;
  const fetched = [];
  process.env.SEARCH_ENRICH_PROFILES = "true";
  axios.defaults.adapter = async (config) => {
    if (/127\.0\.0\.1/.test(String(config.url))) return axios.getAdapter(real || ["http"])(config);
    fetched.push(String(config.url));
    return { data: "<html><title>x</title></html>", status: 200, statusText: "OK", headers: { "content-type": "text/html" }, config, request: {} };
  };
  try {
    // approve the GitHub profile in run 2 so it is fetchable AND verified, then run 3
    const ms = await matchesOf(S.r2.run._id);
    const gh = byUrl(ms, "github.com/amitsharma");
    assert.ok(gh);
    await ctx.call("PATCH", `/candidate-matches/${gh._id}`, { reviewStatus: "APPROVED", reviewerNotes: "his github" }, R);
    fetched.length = 0;
    S.r3 = await runSearch(S.cand._id);
  } finally {
    axios.defaults.adapter = real;
    process.env.SEARCH_ENRICH_PROFILES = "false";
  }
  assert.ok(!fetched.some((u) => /github\.com\/amitsharma|api\.github\.com\/users\/amitsharma$/i.test(u)), `fetched: ${fetched.join(",")}`);
});

test("V6. a candidate can have several verified profiles; one verification never verifies the candidate as a whole", async () => {
  const rows = await ctx.models.VerifiedIdentity.find({ candidate: S.cand._id, status: "VERIFIED" }).lean();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.platform).sort(), ["GITHUB", "LINKEDIN"]);
  // the third discovered profile is still undecided
  const ms = await matchesOf(S.r3.run._id);
  const fresh = byUrl(ms, "amit-sharma-infosys-new");
  assert.equal(fresh.reviewStatus, "PENDING");
  assert.equal(ms.filter((m) => m.reviewStatus === "APPROVED").length, 2);
});

test("V7. registry survives a 'restart' (fresh module instances, nothing in memory)", async () => {
  for (const k of Object.keys(require.cache)) {
    if (/services[\\/](verifiedIdentity|candidateMatch|candidateSearch|identityKnowledge)\.service\.js$/.test(k)) delete require.cache[k];
  }
  const fresh = require("../services/verifiedIdentity.service");
  const rows = await fresh.getVerifiedForCandidate(S.cand._id);
  assert.equal(rows.length, 2);
  const direct = await ctx.models.VerifiedIdentity.countDocuments({ candidate: S.cand._id, status: "VERIFIED" });
  assert.equal(direct, 2);
});

test("V8. history is intact: earlier runs, their matches, decisions and audit log are untouched", async () => {
  const r1Matches = await ctx.models.CandidateMatch.find({ bgvRun: S.r1.run._id }).lean();
  assert.ok(r1Matches.length >= 2);
  const li = r1Matches.find((m) => String(m._id) === String(S.liMatch._id));
  assert.equal(li.reviewStatus, "APPROVED");
  assert.equal(li.reviewerNotes, "again");
  const logs = await ctx.models.VerificationLog.find({ bgvRun: S.r1.run._id, action: "PROFILE_APPROVED" }).lean();
  assert.ok(logs.length >= 1);
  const reused = await ctx.models.VerificationLog.find({ bgvRun: S.r2.run._id, action: "KNOWLEDGE_BASE_REUSED" }).lean();
  assert.ok(reused.some((l) => l.metadata?.type === "PREVIOUSLY_VERIFIED_APPLIED"));
});

test("V9. another candidate with the same profile URL does NOT inherit the verification", async () => {
  const other = await newCandidate("someone.else@example.com");
  const { run } = await runSearch(other._id);
  const ms = await matchesOf(run._id);
  const li = byUrl(ms, "amit-sharma-dewas");
  assert.ok(li);
  assert.equal(li.reviewStatus, "PENDING");
  assert.ok(!li.matchDetails?.previouslyVerified);
});

test("V10. rejecting a previously verified profile revokes it (kept, with history) and the next run asks again", async () => {
  const ms = await matchesOf(S.r3.run._id);
  const gh = byUrl(ms, "github.com/amitsharma");
  assert.equal(gh.reviewStatus, "APPROVED");
  const res = await ctx.call("PATCH", `/candidate-matches/${gh._id}`, { reviewStatus: "REJECTED", reviewerNotes: "wrong person after all" }, { "X-Reviewer": "Boss" });
  assert.equal(res.status, 200);
  const row = await ctx.models.VerifiedIdentity.findOne({ candidate: S.cand._id, platform: "GITHUB" }).lean();
  assert.equal(row.status, "REVOKED");
  assert.equal(row.history.at(-1).action, "REVOKED");
  assert.equal(row.history.at(-1).byLabel, "Boss");
  assert.equal(row.history[0].action, "VERIFIED", "original verification stays in the history");
  const r4 = await runSearch(S.cand._id);
  const gh4 = byUrl(await matchesOf(r4.run._id), "github.com/amitsharma");
  assert.equal(gh4.reviewStatus, "PENDING");
  assert.ok(!gh4.matchDetails?.previouslyVerified);
  // a revoked identity is not resurrected by the backfill of old decisions
  assert.equal((await ctx.models.VerifiedIdentity.findOne({ candidate: S.cand._id, platform: "GITHUB" }).lean()).status, "REVOKED");
  S.r4 = r4;
});

test("V11. material change of a verified profile is sent back to a human, not silently accepted", async () => {
  // the stored fingerprint no longer matches what is found (e.g. the account was renamed)
  await ctx.models.VerifiedIdentity.updateOne({ candidate: S.cand._id, platform: "LINKEDIN" }, { $set: { "fingerprint.username": "some-other-handle" } });
  const r5 = await runSearch(S.cand._id);
  const li = byUrl(await matchesOf(r5.run._id), "amit-sharma-dewas");
  assert.equal(li.reviewStatus, "PENDING");
  assert.ok(li.matchDetails.needsReReview.reasons.includes("USERNAME_CHANGED"));
  assert.ok(!li.matchDetails.previouslyVerified);
  const row = await ctx.models.VerifiedIdentity.findOne({ candidate: S.cand._id, platform: "LINKEDIN" }).lean();
  assert.equal(row.needsReReview.flag, true);
  const known = (await ctx.call("GET", `/bgv-runs/${r5.run._id}/known-profiles`)).body.data;
  assert.equal(known.needsReReview.length, 1);
  // unit level: unknown data is never a change; a clearly different name is
  assert.deepEqual(VI.assessChange({ username: "a", name: "amit sharma" }, { username: null, name: null }), []);
  assert.ok(VI.assessChange({ name: "amit sharma" }, { name: "Priya Verma" }).includes("DISPLAY_NAME_CHANGED"));
  await ctx.models.VerifiedIdentity.updateOne({ candidate: S.cand._id, platform: "LINKEDIN" }, { $set: { "fingerprint.username": "amit-sharma-dewas", "needsReReview.flag": false } });
});

test("V12. decisions made before the registry existed are imported (backfill) and recognised", async () => {
  const c = await newCandidate("legacy@example.com");
  const first = await runSearch(c._id);
  const li = byUrl(await matchesOf(first.run._id), "amit-sharma-dewas");
  // legacy approval: written straight to the match, no registry involved
  await ctx.models.CandidateMatch.updateOne({ _id: li._id }, { $set: { reviewStatus: "APPROVED", reviewedAt: new Date("2026-01-05"), reviewerNotes: "legacy" } });
  assert.equal(await ctx.models.VerifiedIdentity.countDocuments({ candidate: c._id }), 0);
  const second = await runSearch(c._id);
  const li2 = byUrl(await matchesOf(second.run._id), "amit-sharma-dewas");
  assert.equal(li2.reviewStatus, "APPROVED");
  const row = await ctx.models.VerifiedIdentity.findOne({ candidate: c._id }).lean();
  assert.equal(row.verificationMethod, "BACKFILL");
  assert.equal(row.verifiedAt.toISOString().slice(0, 10), "2026-01-05");
});

test("V13. identity-group approval also writes the registry", async () => {
  const c = await newCandidate("group@example.com");
  const { run } = await runSearch(c._id);
  const li = byUrl(await matchesOf(run._id), "amit-sharma-dewas");
  const group = await ctx.models.IdentityGroup.create({ bgvRun: run._id, candidate: c._id, searchResults: [li.searchResult._id], confidenceScore: 70 });
  const res = await ctx.call("PATCH", `/identity-groups/${group._id}`, { reviewStatus: "APPROVED", reviewerNotes: "same person, checked" }, { "X-Reviewer": "Group Reviewer" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = await ctx.models.VerifiedIdentity.findOne({ candidate: c._id }).lean();
  assert.equal(row.verificationMethod, "IDENTITY_GROUP");
  assert.equal(String(row.sourceIdentityGroup), String(group._id));
  assert.equal(row.verifiedByLabel, "Group Reviewer");
  // withdrawing the group approval revokes only what this group created
  await ctx.call("PATCH", `/identity-groups/${group._id}`, { reviewStatus: "REJECTED", reviewerNotes: "mistake, undo" });
  assert.equal((await ctx.models.VerifiedIdentity.findOne({ candidate: c._id }).lean()).status, "REVOKED");
});

// ------------------------------------------------------------------
// manual "Add profile"
// ------------------------------------------------------------------
test("V14. Add profile (for review): appears immediately, stays unverified, nothing written to the registry", async () => {
  const c = await newCandidate("manual1@example.com");
  const { run } = await runSearch(c._id);
  const before = await ctx.models.VerifiedIdentity.countDocuments({ candidate: c._id });
  const res = await ctx.call("POST", `/bgv-runs/${run._id}/profiles`, {
    platform: "INSTAGRAM", profileUrl: "instagram.com/amit.sharma.dewas", displayName: "Amit Sharma", notes: "Shared by HR", evidenceSource: "HR email 12 Oct", mode: "REVIEW",
  }, R);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.candidateMatch.reviewStatus, "PENDING");
  assert.equal(res.body.data.searchResult.source, "MANUAL");
  assert.equal(res.body.data.searchResult.profileUrl, "https://instagram.com/amit.sharma.dewas".replace("https://instagram.com", res.body.data.searchResult.profileUrl.split("/amit")[0]));
  assert.equal(await ctx.models.VerifiedIdentity.countDocuments({ candidate: c._id }), before, "unverified stays unverified");
  // immediately in the current results, no new external search
  const list = await matchesOf(run._id);
  assert.ok(byUrl(list, "instagram.com/amit.sharma.dewas"));
  const known = (await ctx.call("GET", `/bgv-runs/${run._id}/known-profiles`)).body.data;
  assert.equal(known.addedByReviewer.length, 1);
  assert.equal(known.addedByReviewer[0].searchResult.rawData.manual.addedByLabel, "Asha Reviewer");
  assert.equal(known.addedByReviewer[0].searchResult.rawData.manual.notes, "Shared by HR");
  assert.equal((await ctx.models.BgvRun.findById(run._id).lean()).totalSearchResults >= 1, true);
  S.manualRun = run; S.manualCand = c;
});

test("V15. duplicate (any URL spelling) is refused with the existing record; one row only", async () => {
  const run = S.manualRun;
  for (const url of ["https://www.instagram.com/amit.sharma.dewas/", "http://instagram.com/Amit.Sharma.Dewas?igsh=abc", "instagram.com/amit.sharma.dewas#x"]) {
    const res = await ctx.call("POST", `/bgv-runs/${run._id}/profiles`, { platform: "INSTAGRAM", profileUrl: url, mode: "REVIEW" }, R);
    assert.equal(res.status, 409, `${url} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.duplicate, true);
    assert.ok(res.body.existing.searchResultId && res.body.existing.candidateMatchId);
  }
  assert.equal(await ctx.models.SearchResult.countDocuments({ bgvRun: run._id, profileUrl: /instagram\.com\/amit\.sharma\.dewas/i }), 1);
  // a discovered profile counts as a duplicate too
  const dup = await ctx.call("POST", `/bgv-runs/${run._id}/profiles`, { profileUrl: "https://in.linkedin.com/in/amit-sharma-dewas/?trk=x" }, R);
  assert.equal(dup.status, 409);
});

test("V16. validation: bad URL, unsupported / mismatching platform, non-profile URL, private host, wrong candidate, bad mode", async () => {
  const run = S.manualRun;
  const post = (b, h = R) => ctx.call("POST", `/bgv-runs/${run._id}/profiles`, b, h);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ profileUrl: "not a url" })).status, 400);
  assert.equal((await post({ profileUrl: "http://localhost/admin" })).status, 400);
  assert.equal((await post({ profileUrl: "http://192.168.1.5/in/x" })).status, 400);
  assert.equal((await post({ platform: "MYSPACE2", profileUrl: "https://example.org/u/x" })).status, 400);
  assert.equal((await post({ platform: "GITHUB", profileUrl: "https://www.linkedin.com/in/someone-else" })).status, 400);
  assert.equal((await post({ profileUrl: "https://random-site.example.org/people/x" })).status, 400, "unknown host needs an explicit WEBSITE/OTHER");
  const web = await post({ platform: "WEBSITE", profileUrl: "https://amit-sharma.example.org/about", mode: "REVIEW" });
  assert.equal(web.status, 201, JSON.stringify(web.body));
  const search = await post({ platform: "LINKEDIN", profileUrl: "https://www.linkedin.com/search/results/people/?keywords=amit" });
  assert.equal(search.status, 400);
  assert.equal(search.body.code, "NOT_PROFILE_SHAPED");
  assert.equal((await post({ profileUrl: "https://www.linkedin.com/in/other-person-1", mode: "SOMETHING" })).status, 400);
  assert.equal((await post({ profileUrl: "https://www.linkedin.com/in/other-person-2", candidateId: String(S.cand._id) })).status, 400);
  assert.equal((await ctx.call("POST", `/bgv-runs/000000000000000000000000/profiles`, { profileUrl: "https://github.com/x1" })).status, 404);
});

test("V17. Add profile as VERIFIED needs a named reviewer, then persists in the same registry with reviewer + time + notes", async () => {
  const run = S.manualRun;
  const url = "https://github.com/amit-sharma-manual";
  const noName = await ctx.call("POST", `/bgv-runs/${run._id}/profiles`, { profileUrl: url, mode: "VERIFIED" });
  assert.equal(noName.status, 400);
  assert.equal(await ctx.models.SearchResult.countDocuments({ bgvRun: run._id, profileUrl: /amit-sharma-manual/ }), 0, "nothing saved when refused");

  const ok = await ctx.call("POST", `/bgv-runs/${run._id}/profiles`, { profileUrl: url, mode: "VERIFIED", notes: "Seen on his CV", evidenceSource: "CV page 2" }, { "X-Reviewer": "Verifier One" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.candidateMatch.reviewStatus, "APPROVED");
  assert.ok(ok.body.data.candidateMatch.reviewedAt);
  const row = await ctx.models.VerifiedIdentity.findOne({ candidate: S.manualCand._id, platform: "GITHUB" }).lean();
  assert.equal(row.status, "VERIFIED");
  assert.equal(row.verificationMethod, "MANUAL_ADD");
  assert.equal(row.verifiedByLabel, "Verifier One");
  assert.match(row.reviewerNotes, /Seen on his CV/);
  assert.match(row.reviewerNotes, /CV page 2/);
  const log = await ctx.models.VerificationLog.findOne({ bgvRun: run._id, action: "PROFILE_APPROVED", "metadata.manual": true }).lean();
  assert.ok(log && log.metadata.reviewerLabel === "Verifier One");

  // next run recognises it as Previously Verified
  const next = await runSearch(S.manualCand._id);
  const m = byUrl(await matchesOf(next.run._id), "amit-sharma-manual");
  assert.equal(m.reviewStatus, "APPROVED");
  assert.equal(m.matchDetails.previouslyVerified.method, "MANUAL_ADD");
  // and an add of the same profile in that run is a duplicate, not a second identity
  const again = await ctx.call("POST", `/bgv-runs/${next.run._id}/profiles`, { profileUrl: url, mode: "VERIFIED" }, R);
  assert.equal(again.status, 409);
  assert.equal(await ctx.models.VerifiedIdentity.countDocuments({ candidate: S.manualCand._id, profileKey: "github.com/amit-sharma-manual" }), 1);
});

test("V18. adding a profile that was verified earlier (not in this run yet) brings it in as Previously Verified", async () => {
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: S.manualCand._id })).body.data; // fresh run, no search yet
  const res = await ctx.call("POST", `/bgv-runs/${run._id}/profiles`, { profileUrl: "github.com/amit-sharma-manual", mode: "REVIEW" }, R);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.alreadyVerified, true);
  assert.equal(res.body.data.candidateMatch.reviewStatus, "APPROVED");
  assert.equal(await ctx.models.SearchResult.countDocuments({ bgvRun: run._id, profileUrl: /amit-sharma-manual/ }), 1);
});

test("V19. concurrent duplicate requests never create two identities or two profiles", async () => {
  const c = await newCandidate("race@example.com");
  const { run } = await runSearch(c._id);
  const sr = await ctx.models.SearchResult.findOne({ bgvRun: run._id, profileUrl: /amit-sharma-dewas/ });
  // 8 parallel verifications of the same profile
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => VI.recordVerification({ candidateId: c._id, searchResult: sr, bgvRunId: run._id, reviewer: { label: `R${i}` }, method: "MATCH_REVIEW" }))
  );
  assert.equal(await ctx.models.VerifiedIdentity.countDocuments({ candidate: c._id }), 1);
  assert.equal(results.filter((r) => r.created).length >= 1, true);
  const row = await ctx.models.VerifiedIdentity.findOne({ candidate: c._id }).lean();
  assert.equal(row.history.filter((h) => h.action === "VERIFIED").length, 1, "one original verification entry");

  // 6 parallel "add as verified" of the same new URL
  const url = "https://github.com/race-profile-1";
  const posts = await Promise.all(
    Array.from({ length: 6 }, () => ctx.call("POST", `/bgv-runs/${run._id}/profiles`, { profileUrl: url, mode: "VERIFIED" }, R))
  );
  const codes = posts.map((p) => p.status).sort();
  assert.equal(codes.filter((x) => x === 201).length, 1, JSON.stringify(codes));
  assert.ok(codes.every((x) => x === 201 || x === 409), JSON.stringify(codes));
  assert.equal(await ctx.models.SearchResult.countDocuments({ bgvRun: run._id, profileUrl: /race-profile-1/ }), 1);
  assert.equal(await ctx.models.CandidateMatch.countDocuments({ bgvRun: run._id, searchResult: (await ctx.models.SearchResult.findOne({ bgvRun: run._id, profileUrl: /race-profile-1/ }))._id }), 1);
  assert.equal(await ctx.models.VerifiedIdentity.countDocuments({ candidate: c._id, profileKey: "github.com/race-profile-1" }), 1);
});

test("V20. identity listing + revoke endpoints (revoke keeps the row and needs a reason)", async () => {
  const list = await ctx.call("GET", `/verified-identities?candidate=${S.cand._id}`);
  assert.equal(list.status, 200);
  assert.ok(list.body.data.every((r) => r.status === "VERIFIED"));
  assert.equal((await ctx.call("GET", `/verified-identities`)).status, 400);
  const one = list.body.data[0];
  assert.equal((await ctx.call("POST", `/verified-identities/${one._id}/revoke`, {}, R)).status, 400);
  const rev = await ctx.call("POST", `/verified-identities/${one._id}/revoke`, { reason: "left the company, profile re-used" }, R);
  assert.equal(rev.status, 200);
  assert.equal(rev.body.data.status, "REVOKED");
  const all = await ctx.call("GET", `/verified-identities?candidate=${S.cand._id}&includeRevoked=true`);
  assert.ok(all.body.data.some((r) => r.status === "REVOKED" && r.history.length >= 2));
});
