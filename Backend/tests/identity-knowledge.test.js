"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

let ctx;
const S = {};

test.before(async () => {
  ctx = await H.startAll();
});
test.after(async () => {
  await ctx.stop();
});

const PRIYA = {
  fullName: "Priya Verma",
  email: "priya.verma@example.com",
  location: { city: "Bhopal", state: "Madhya Pradesh", country: "India" },
  currentCompany: "Trazoo Global",
  currentJobTitle: "Web Developer",
};

const profile = () =>
  H.serperLinkedIn({
    name: "Priya Verma",
    slug: "priya-verma-bhopal",
    title: "Web Developer",
    company: "Trazoo Global",
    location: "Bhopal, Madhya Pradesh, India",
  });

const github = () =>
  H.tavilyGithub({
    name: "Priya Verma",
    user: "priyaverma-dev",
    bio: "Web Developer at Trazoo Global, Bhopal",
  });

const withProfile = () =>
  H.setProviders({
    tavily: () => [github()],
    serper: (q, o) => ((o.page || 1) > 1 ? [] : [profile()]),
  });

const mkCandidate = async (data) => (await ctx.call("POST", "/candidates", data)).body.data;
const mkRun = async (c) => (await ctx.call("POST", "/bgv-runs", { candidateId: c._id })).body.data;
const logs = async (run) =>
  ((await ctx.call("GET", `/verification-logs/run/${run}`)).body?.data || []).map((l) => l.action);

const matchFor = async (runId, re) =>
  (await ctx.call("GET", `/candidate-matches/run/${runId}/relevant?all=true&limit=50`)).body.data.find((m) =>
    re.test(m.searchResult.profileUrl)
  );

const firstMatch = (runId) => matchFor(runId, /priya-verma-bhopal/);

test("12. confirm identity (reason mandatory), rebuild keeps approved decisions, no duplicate membership", async () => {
  withProfile();
  S.priya = await mkCandidate(PRIYA);
  S.run1 = await mkRun(S.priya);
  assert.equal((await ctx.call("POST", `/bgv-runs/${S.run1._id}/search`, {})).status, 200);

  const m = await firstMatch(S.run1._id);
  const g = await matchFor(S.run1._id, /github\.com\/priyaverma-dev/);
  assert.ok(m && g, "profiles missing from review list");
  S.m1 = m;
  S.g1 = g;
  const ids = [m.searchResult._id, g.searchResult._id];

  // a group can only be built from profiles a human APPROVED
  const empty = await ctx.call("POST", `/identity-groups/build/${S.run1._id}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.totalGroups, 0);

  for (const x of [m, g]) {
    await ctx.call("PATCH", `/candidate-matches/${x._id}`, { reviewStatus: "APPROVED", reviewerNotes: "same city + employer" });
  }

  // human confirmation needs a reason
  const noReason = await ctx.call("POST", "/identity-groups/merge", {
    bgvRunId: S.run1._id,
    candidateId: S.priya._id,
    searchResultIds: ids,
  });
  assert.equal(noReason.status, 400);

  const merged = await ctx.call("POST", "/identity-groups/merge", {
    bgvRunId: S.run1._id,
    candidateId: S.priya._id,
    searchResultIds: ids,
    reviewerNotes: "Verified on LinkedIn: same employer and city",
  });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  S.group = merged.body.data;
  assert.equal(S.group.reviewStatus, "APPROVED");
  assert.equal(S.group.reviewerNotes, "Verified on LinkedIn: same employer and city");
  assert.equal(S.group.searchResults.length, 2);

  // repeating the same confirmation is a no-op (no 2nd group, no 2nd log)
  const again = await ctx.call("POST", "/identity-groups/merge", {
    bgvRunId: S.run1._id,
    candidateId: S.priya._id,
    searchResultIds: ids,
    reviewerNotes: "Verified on LinkedIn: same employer and city",
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.action, "ALREADY_CONFIRMED");

  const groups = (await ctx.call("GET", `/identity-groups/run/${S.run1._id}`)).body.data;
  assert.equal(groups.length, 1);

  // rebuild must not touch or duplicate the approved group
  const rebuilt = await ctx.call("POST", `/identity-groups/build/${S.run1._id}`);
  assert.equal(rebuilt.status, 200);
  assert.equal(rebuilt.body.data.totalGroups, 0);
  const after = (await ctx.call("GET", `/identity-groups/run/${S.run1._id}`)).body.data;
  assert.equal(after.length, 1);
  assert.equal(after[0].reviewStatus, "APPROVED");

  // invalid status / a group review needs a reason
  assert.equal((await ctx.call("PATCH", `/identity-groups/${S.group._id}`, { reviewStatus: "NOPE" })).status, 400);
  assert.equal((await ctx.call("PATCH", `/identity-groups/${S.group._id}`, { reviewStatus: "REJECTED" })).status, 400);

  const a = await logs(S.run1._id);
  assert.equal(a.filter((x) => x === "IDENTITY_GROUP_CREATED").length, 1);
});

test("14. evidence: created once, retries re-use it, logged once", async () => {
  const first = await ctx.call("POST", "/evidence/from-group", { identityGroupId: S.group._id });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.ok(first.body.data.created > 0);

  const second = await ctx.call("POST", "/evidence/from-group", { identityGroupId: S.group._id });
  assert.equal(second.status, 200);
  assert.equal(second.body.data.created, 0);
  assert.ok(second.body.data.reused > 0);

  const count = await ctx.models.Evidence.countDocuments({ bgvRun: S.run1._id });
  assert.equal(count, first.body.data.created);

  assert.equal((await logs(S.run1._id)).filter((x) => x === "EVIDENCE_CREATED").length, 1);

  // evidence points to stored data
  const ev = await ctx.models.Evidence.findOne({ bgvRun: S.run1._id }).lean();
  assert.ok(ev.searchResult && ev.candidateMatch && ev.identityGroup);
  assert.ok(ev.sourceUrl);
});

test("13. a NEW run re-uses the human-confirmed profile; nothing is auto-approved; old run untouched", async () => {
  H.resetProviderCalls();
  withProfile(); // the live search returns the same profile again

  S.run2 = await mkRun(S.priya);
  const r = await ctx.call("POST", `/bgv-runs/${S.run2._id}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const stats = r.body.data.search.stats;
  // both profiles were explicitly confirmed -> they come from the permanent
  // verified-identity registry, not from the "please verify again" seeding
  assert.equal(stats.knowledgeBase.found, 0);
  assert.equal(r.body.data.search.verifiedIdentities.addedToRun + r.body.data.search.verifiedIdentities.alreadyInRun, 2);
  assert.ok(stats.coveredPlatforms.includes("LINKEDIN"));
  assert.ok(stats.coveredPlatforms.includes("GITHUB"));

  // A confirmed profile does NOT switch fresh discovery off: LinkedIn and
  // GitHub are still searched with their own platform-specific queries ...
  const queries = [...H.providerCalls.serper, ...H.providerCalls.tavily].map((c) => c.query);
  assert.ok(queries.some((q) => q.startsWith("site:linkedin.com/in")), "LinkedIn must still be searched");
  assert.ok(queries.some((q) => q.startsWith("site:github.com")), "GitHub must still be searched");
  assert.equal(r.body.data.search.platforms.LINKEDIN.hasConfirmedProfile, true);
  assert.ok(r.body.data.search.platforms.LINKEDIN.queriesRun > 0);

  // exactly ONE record for the profile in run 2 (knowledge base + live search merged)
  const rows = await ctx.models.SearchResult.find({ bgvRun: S.run2._id, profileUrl: /priya-verma-bhopal/ }).lean();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "KNOWLEDGE_BASE");
  assert.ok(rows[0].rawData.verifiedIdentity);

  // recognised as Previously Verified only because a human confirmed it earlier
  const m2 = await firstMatch(S.run2._id);
  assert.ok(m2, "verified profile is present in the new run");
  assert.equal(m2.reviewStatus, "APPROVED");
  assert.ok(m2.matchDetails.previouslyVerified);

  // old run: decisions, group, evidence intact
  const oldMatch = await ctx.models.CandidateMatch.findById(S.m1._id).lean();
  assert.equal(oldMatch.reviewStatus, "APPROVED");
  const oldGroup = await ctx.models.IdentityGroup.findById(S.group._id).lean();
  assert.equal(oldGroup.reviewStatus, "APPROVED");
  assert.ok((await ctx.models.Evidence.countDocuments({ bgvRun: S.run1._id })) > 0);

  assert.ok((await logs(S.run2._id)).includes("KNOWLEDGE_BASE_REUSED"));

  // repeating the search does not create duplicates
  const again = await ctx.call("POST", `/bgv-runs/${S.run2._id}/search`, {});
  assert.equal(again.status, 200);
  assert.equal(
    await ctx.models.SearchResult.countDocuments({ bgvRun: S.run2._id, profileUrl: /priya-verma-bhopal/ }),
    1
  );
});

test("13b. same NAME but no reliable identifier -> knowledge base is NOT reused", async () => {
  withProfile();
  const namesake = await mkCandidate({
    fullName: "Priya Verma",
    email: "someone.else@example.org",
    location: { city: "Delhi", country: "India" },
    currentCompany: "Another Corp",
  });
  const run = await mkRun(namesake);
  const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.search.stats.knowledgeBase.found, 0);
  assert.equal(
    await ctx.models.SearchResult.countDocuments({ bgvRun: run._id, source: "KNOWLEDGE_BASE" }),
    0
  );
});

test("13c. duplicate candidate record (same e-mail + name token) DOES share the knowledge base", async () => {
  withProfile();
  const dup = await mkCandidate({
    fullName: "Priya V Verma",
    email: "PRIYA.VERMA@example.com",
    currentCompany: "Trazoo Global",
  });
  const run = await mkRun(dup);
  const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.search.stats.knowledgeBase.found, 2);
  const m = await firstMatch(run._id);
  assert.equal(m?.reviewStatus, "PENDING");
});

test("10b. review list never exceeds 15, even with 40 strong matches; fewer when fewer qualify", async () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    H.serperLinkedIn({
      name: "Karan Mehta",
      slug: `karan-mehta-${i}`,
      title: "Data Analyst",
      company: "Infosys",
      location: "Indore, Madhya Pradesh, India",
    })
  );
  H.setProviders({ tavily: () => [], serper: (q, o) => ((o.page || 1) > 1 ? [] : many) });

  const c = await mkCandidate({
    fullName: "Karan Mehta",
    location: { city: "Indore", state: "Madhya Pradesh", country: "India" },
    currentCompany: "Infosys",
    currentJobTitle: "Data Analyst",
  });
  const run = await mkRun(c);
  assert.equal((await ctx.call("POST", `/bgv-runs/${run._id}/search`, {})).status, 200);

  const r = await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant?limit=50`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length <= 15, `got ${r.body.data.length}`);
  assert.equal(r.body.pagination.totalPages, 1);

  // everything stays in the database
  assert.ok((await ctx.models.SearchResult.countDocuments({ bgvRun: run._id })) >= 40);

  // ML contract: batches of at most 20, a failing ML service never breaks the list
  assert.ok(ctx.mlState.requests > 0, "BGE-M3 was never called");
  assert.ok(ctx.mlState.lastBatchSize <= 20);

  ctx.mlState.fail = true;
  const rerun = await ctx.call("POST", `/bgv-runs/${run._id}/match`, {});
  assert.equal(rerun.status, 200);
  const down = await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant`);
  assert.equal(down.status, 200);
  assert.ok(down.body.data.length > 0);
  ctx.mlState.fail = false;
});
