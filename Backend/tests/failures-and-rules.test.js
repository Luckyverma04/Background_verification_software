"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

let ctx;

test.before(async () => {
  ctx = await H.startAll();
});
test.after(async () => {
  await ctx.stop();
});

const FULL = {
  fullName: "Priya Verma",
  email: "priya.verma@example.com",
  location: { city: "Bhopal", state: "Madhya Pradesh", country: "India" },
  currentCompany: "Trazoo Global",
  currentJobTitle: "Web Developer",
  education: [{ institution: "SVVV Indore" }],
};

const newCandidate = async (data = FULL) =>
  (await ctx.call("POST", "/candidates", data)).body.data;

const newRun = async (candidateId) =>
  (await ctx.call("POST", "/bgv-runs", { candidateId })).body.data;

const actions = async (runId) =>
  ((await ctx.call("GET", `/verification-logs/run/${runId}`)).body?.data || []).map((l) => l.action);

const goodProfile = () =>
  H.serperLinkedIn({
    name: "Priya Verma",
    slug: "priya-verma-bhopal",
    title: "Web Developer",
    company: "Trazoo Global",
    location: "Bhopal, Madhya Pradesh, India",
    extra: "Education: SVVV Indore.",
  });

const allWork = () =>
  H.setProviders({
    tavily: () => [],
    serper: (q, o) => ((o.page || 1) > 1 ? [] : [goodProfile()]),
  });

const search = (runId) => ctx.call("POST", `/bgv-runs/${runId}/search`, {});

test("4. one provider fails, the other succeeds: results are kept", async () => {
  H.setProviders({
    tavily: () => {
      throw new Error("tavily 429 rate limit");
    },
    serper: (q, o) => ((o.page || 1) > 1 ? [] : [goodProfile()]),
  });

  const c = await newCandidate();
  const run = await newRun(c._id);
  const r = await search(run._id);

  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stats = r.body.data.search.stats;
  assert.ok(stats.providerCallsOk > 0);
  assert.ok(stats.providerCalls > stats.providerCallsOk, "tavily failures must be counted");
  assert.ok(stats.providerErrors.some((e) => /tavily/.test(e)));
  assert.ok(r.body.data.search.totalResults >= 1);
});

test("5. all providers fail: explicit error, run FAILED + INCONCLUSIVE, SEARCH_FAILED logged, never 'success'", async () => {
  H.setProviders({
    tavily: () => {
      throw new Error("tavily down");
    },
    serper: () => {
      throw new Error("serper down");
    },
  });

  const c = await newCandidate();
  const run = await newRun(c._id);
  const r = await search(run._id);

  assert.equal(r.status, 500);
  assert.equal(r.body.success, false);

  const fresh = (await ctx.call("GET", `/bgv-runs/${run._id}`)).body.data;
  assert.equal(fresh.status, "FAILED");
  assert.equal(fresh.finalResult, "INCONCLUSIVE");

  const a = await actions(run._id);
  assert.ok(a.includes("SEARCH_FAILED"));
  assert.ok(!a.includes("SEARCH_COMPLETED"), "a failed search must not be logged as completed");
  assert.ok(!a.includes("MATCHING_COMPLETED"));
});

test("8. incomplete candidate (name only): no crash, name-only fallback, missing data is unknown not a mismatch", async () => {
  allWork();
  const c = await newCandidate({ fullName: "Priya Verma" });
  const run = await newRun(c._id);
  const r = await search(run._id);
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const rel = await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant?all=true`);
  assert.equal(rel.status, 200);
  for (const m of rel.body.data) {
    // candidate has no company / city: that can never be a CONFLICT
    const fields = (m.conflictingSignals || []).map((x) => x.field);
    assert.ok(!fields.includes("company"), "missing candidate company was treated as a mismatch");
    assert.ok(!fields.includes("location"), "missing candidate location was treated as a mismatch");
  }
});

test("11/16/17. review decisions, final result rules, retries", async () => {
  allWork();
  const c = await newCandidate();
  const run = await newRun(c._id);
  const r = await search(run._id);
  assert.equal(r.status, 200);

  // a finished run must not be restarted while "busy"
  await ctx.models.BgvRun.updateOne({ _id: run._id }, { status: "SEARCHING" });
  const busy = await search(run._id);
  assert.equal(busy.status, 409);
  await ctx.models.BgvRun.updateOne({ _id: run._id }, { status: "REVIEW_REQUIRED" });

  // PATCH cannot be used to force a result
  const forced = await ctx.call("PATCH", `/bgv-runs/${run._id}`, { finalResult: "CLEAR" });
  assert.equal(forced.status, 400);

  // pending reviews -> REVIEW_REQUIRED (never CLEAR just because a score is high)
  let fin = (await ctx.call("GET", `/bgv-runs/${run._id}/final-result`)).body.data;
  assert.equal(fin.finalResult, "REVIEW_REQUIRED", JSON.stringify(fin));

  const list = (await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant`)).body.data;
  assert.ok(list.length >= 1);
  const match = list[0];
  assert.equal(match.reviewStatus, "PENDING");

  // validation
  assert.equal((await ctx.call("PATCH", `/candidate-matches/${match._id}`, { reviewStatus: "MAYBE" })).status, 400);
  assert.equal((await ctx.call("PATCH", `/candidate-matches/${match._id}`, { finalResult: "x" })).status, 400);
  assert.equal((await ctx.call("PATCH", `/candidate-matches/nope`, { reviewStatus: "APPROVED" })).status, 400);

  // approve (+ repeated request = no duplicate log)
  const a1 = await ctx.call("PATCH", `/candidate-matches/${match._id}`, {
    reviewStatus: "APPROVED",
    reviewerNotes: "Same company and city on LinkedIn",
  });
  assert.equal(a1.status, 200);
  const a2 = await ctx.call("PATCH", `/candidate-matches/${match._id}`, {
    reviewStatus: "APPROVED",
    reviewerNotes: "Same company and city on LinkedIn",
  });
  assert.equal(a2.status, 200);

  const logs = await actions(run._id);
  assert.equal(logs.filter((x) => x === "PROFILE_APPROVED").length, 1);

  // everything reviewed + one confirmed + coverage ok -> CLEAR
  const rest = (await ctx.call("GET", `/candidate-matches/run/${run._id}/relevant?all=true&limit=50`)).body.data
    .filter((m) => m._id !== match._id && ["STRONG", "POSSIBLE", "REVIEW_REQUIRED"].includes(m.matchStatus) && m.reviewStatus === "PENDING");
  for (const m of rest) {
    await ctx.call("PATCH", `/candidate-matches/${m._id}`, { reviewStatus: "REJECTED", reviewerNotes: "different person" });
  }

  fin = (await ctx.call("GET", `/bgv-runs/${run._id}/final-result`)).body.data;
  assert.equal(fin.finalResult, "CLEAR", JSON.stringify(fin));
  assert.ok((await actions(run._id)).includes("FINAL_RESULT"));

  // reject it again -> nothing confirmed -> INCONCLUSIVE (not CLEAR)
  const rej = await ctx.call("PATCH", `/candidate-matches/${match._id}`, {
    reviewStatus: "REJECTED",
    reviewerNotes: "changed my mind",
  });
  assert.equal(rej.status, 200);
  fin = (await ctx.call("GET", `/bgv-runs/${run._id}/final-result`)).body.data;
  assert.equal(fin.finalResult, "INCONCLUSIVE");

  // an approved profile that conflicts with the declared data -> ISSUE_FOUND
  await ctx.models.CandidateMatch.updateOne(
    { _id: match._id },
    {
      reviewStatus: "APPROVED",
      conflictingSignals: [{ field: "company", candidateValue: "Trazoo Global", searchResultValue: "Other Ltd", reason: "different employer" }],
    }
  );
  fin = (await ctx.call("GET", `/bgv-runs/${run._id}/final-result`)).body.data;
  assert.equal(fin.finalResult, "ISSUE_FOUND");

  // manual decision needs a written reason
  assert.equal((await ctx.call("POST", `/bgv-runs/${run._id}/final-result`, { finalResult: "CLEAR" })).status, 400);
  assert.equal((await ctx.call("POST", `/bgv-runs/${run._id}/final-result`, { finalResult: "BANANA", reason: "because" })).status, 400);
  const manual = await ctx.call("POST", `/bgv-runs/${run._id}/final-result`, {
    finalResult: "INCONCLUSIVE",
    reason: "Reviewer could not reach the candidate",
  });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.data.finalResult, "INCONCLUSIVE");
});

test("16b. no matches + adequate search is INCONCLUSIVE (absence is not proof); no search at all is INCONCLUSIVE", async () => {
  H.setProviders({ tavily: () => [], serper: () => [] });
  const c = await newCandidate();
  const run = await newRun(c._id);
  const r = await search(run._id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fresh = (await ctx.call("GET", `/bgv-runs/${run._id}`)).body.data;
  assert.equal(fresh.finalResult, "INCONCLUSIVE");
  assert.notEqual(fresh.finalResult, "CLEAR");

  const run2 = await newRun((await newCandidate({ fullName: "Never Searched" }))._id);
  const fin = (await ctx.call("GET", `/bgv-runs/${run2._id}/final-result`)).body;
  // run never started -> nothing is concluded
  assert.ok(["PENDING", "INCONCLUSIVE"].includes(fin.data.finalResult));
});

test("15. ownership: a run cannot be searched for a different candidate", async () => {
  allWork();
  const a = await newCandidate();
  const b = await newCandidate({ fullName: "Someone Else" });
  const run = await newRun(a._id);
  const r = await ctx.call("POST", `/bgv-runs/${run._id}/search`, { candidateId: b._id });
  assert.equal(r.status, 400);
});

test("17. candidates with verification history are not deletable; others are", async () => {
  const a = await newCandidate({ fullName: "Has History" });
  await newRun(a._id);
  assert.equal((await ctx.call("DELETE", `/candidates/${a._id}`)).status, 409);

  const b = await newCandidate({ fullName: "No History" });
  assert.equal((await ctx.call("DELETE", `/candidates/${b._id}`)).status, 200);
});
