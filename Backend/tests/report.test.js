"use strict";

/**
 * Verification report (GET /bgv-runs/:id/report) and dashboard statistics
 * (GET /stats).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await H.startAll();
  process.env.PROVIDER_RETRY_BASE_MS = "1";
  const rows = (q, o = {}) => {
    const d = (o.includeDomains && o.includeDomains[0]) || (String(q).match(/site:(\S+)/) || [])[1] || "";
    if (d.includes("linkedin")) {
      return [
        { title: "Neha Joshi - Data Analyst - Infosys | LinkedIn", link: "https://www.linkedin.com/in/neha-joshi-indore", snippet: "Indore, Madhya Pradesh, India · Data Analyst · Infosys." },
        { title: "Neha Joshi - Teacher - DPS | LinkedIn", link: "https://www.linkedin.com/in/neha-joshi-teacher", snippet: "Pune, Maharashtra, India · Teacher · DPS." },
      ];
    }
    if (d.includes("github")) return [{ title: "nehaj (Neha Joshi) · GitHub", link: "https://github.com/nehaj", snippet: "Data Analyst at Infosys. Indore, Madhya Pradesh." }];
    return [];
  };
  H.setProviders({
    serper: (q, o) => rows(q, o),
    tavily: (q, o) => rows(q, o).map((r) => ({ title: r.title, url: r.link, content: r.snippet, score: 0.6 })),
  });
});
test.after(async () => ctx.stop());

const S = {};

test("R1. the report lists verified and rejected profiles with reviewer, time and notes", async () => {
  const cand = (await ctx.call("POST", "/candidates", {
    fullName: "Neha Joshi", email: "neha.report@example.com",
    location: { city: "Indore", state: "Madhya Pradesh", country: "India" },
    currentCompany: "Infosys", currentJobTitle: "Data Analyst",
  })).body.data;
  const run = (await ctx.call("POST", "/bgv-runs", { candidateId: cand._id })).body.data;
  assert.equal((await ctx.call("POST", `/bgv-runs/${run._id}/search`, {})).status, 200);
  S.run = run;

  const matches = (await ctx.call("GET", `/candidate-matches/run/${run._id}`)).body.data;
  const right = matches.find((m) => m.searchResult?.profileUrl?.includes("neha-joshi-indore"));
  const wrong = matches.find((m) => m.searchResult?.profileUrl?.includes("neha-joshi-teacher"));
  assert.ok(right && wrong, "both LinkedIn results are matched");

  const R = { "X-Reviewer": "Report Reviewer" };
  assert.equal((await ctx.call("PATCH", `/candidate-matches/${right._id}`, { reviewStatus: "APPROVED", reviewerNotes: "checked CV" }, R)).status, 200);
  assert.equal((await ctx.call("PATCH", `/candidate-matches/${wrong._id}`, { reviewStatus: "REJECTED", reviewerNotes: "different city" }, R)).status, 200);

  const res = await ctx.call("GET", `/bgv-runs/${run._id}/report`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body.data;
  assert.equal(r.candidate.fullName, "Neha Joshi");
  assert.equal(r.summary.verified, 1);
  assert.equal(r.summary.rejected, 1);
  assert.equal(r.verifiedProfiles[0].profileUrl.includes("neha-joshi-indore"), true);
  assert.equal(r.verifiedProfiles[0].reviewer.name, "Report Reviewer");
  assert.equal(r.verifiedProfiles[0].notes, "checked CV");
  assert.ok(r.verifiedProfiles[0].reviewedAt);
  assert.equal(r.rejectedProfiles[0].notes, "different city");
  assert.equal(r.generatedBy.name, "Test Admin");
  assert.ok(r.timeline.some((t) => t.action === "PROFILE_APPROVED"));
  assert.ok(r.timeline.some((t) => t.action === "RUN_CREATED"));
});

test("R2. report: bad id 400, unknown run 404, no login 401", async () => {
  assert.equal((await ctx.call("GET", "/bgv-runs/not-an-id/report")).status, 400);
  assert.equal((await ctx.call("GET", "/bgv-runs/000000000000000000000000/report")).status, 404);
  assert.equal((await ctx.call("GET", `/bgv-runs/${S.run._id}/report`, undefined, { "X-No-Auth": "1" })).status, 401);
});

test("R3. stats: totals, status / result counts, a full day series and decisions per reviewer", async () => {
  const res = await ctx.call("GET", "/stats?days=14&tz=Asia/Kolkata");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body.data;
  assert.equal(s.days, 14);
  assert.equal(s.timezone, "Asia/Kolkata");
  assert.ok(s.totals.candidates >= 1 && s.totals.runs >= 1);
  assert.equal(s.daily.length, 14);
  assert.ok(s.daily[s.daily.length - 1].runs >= 1, "today's run is counted");
  assert.ok(s.daily.reduce((n, d) => n + d.approved, 0) >= 1);
  const reviewer = s.reviewers.find((x) => x.name === "Report Reviewer");
  assert.deepEqual({ approved: reviewer.approved, rejected: reviewer.rejected }, { approved: 1, rejected: 1 });
  assert.ok(Object.values(s.runsByStatus).reduce((a, b) => a + b, 0) >= 1);

  assert.equal((await ctx.call("GET", "/stats?tz=Not/AZone")).body.data.timezone, "UTC", "an invalid time zone falls back to UTC");
  assert.equal((await ctx.call("GET", "/stats", undefined, { "X-No-Auth": "1" })).status, 401);
});
