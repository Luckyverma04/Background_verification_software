"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

let ctx;
const state = {};

const CANDIDATE = {
  fullName: "Rahul Sharma",
  email: "rahul.sharma92@example.com",
  location: { city: "Pune", state: "Maharashtra", country: "India" },
  currentCompany: "TCS",
  currentJobTitle: "Software Engineer",
  education: [{ institution: "IIT Indore", degree: "B.Tech" }],
};

const rightPerson = () =>
  H.serperLinkedIn({
    name: "Rahul Sharma",
    slug: "rahul-sharma-pune",
    title: "Software Engineer",
    company: "TCS",
    location: "Pune, Maharashtra, India",
    extra: "Education: IIT Indore.",
  });

const namesake = () =>
  H.serperLinkedIn({
    name: "Rahul Sharma",
    slug: "rahul-sharma-berlin",
    title: "Chemical Engineer",
    company: "Siemens",
    location: "Berlin, Germany",
    extra: "Education: TU Berlin.",
  });

const log = async (runId) => {
  const r = await ctx.call("GET", `/verification-logs/run/${runId}`);
  return (r.body?.data || []).map((l) => l.action);
};

test.before(async () => {
  ctx = await H.startAll();
});

test.after(async () => {
  await ctx.stop();
});

test("1. create + retrieve candidate; bad input is a 400, not a 500", async () => {
  const bad = await ctx.call("POST", "/candidates", { email: "x@y.com" });
  assert.equal(bad.status, 400);

  const created = await ctx.call("POST", "/candidates", CANDIDATE);
  assert.equal(created.status, 201);
  state.candidateId = created.body.data._id;

  const got = await ctx.call("GET", `/candidates/${state.candidateId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.fullName, "Rahul Sharma");

  const badId = await ctx.call("GET", "/candidates/not-an-id");
  assert.equal(badId.status, 400);

  const list = await ctx.call("GET", "/candidates");
  assert.equal(list.status, 200);
  assert.ok(list.body.pagination);
});

test("2. create BGV run; double click does not create a second run; RUN_CREATED logged", async () => {
  const bad = await ctx.call("POST", "/bgv-runs", { candidateId: "nope" });
  assert.equal(bad.status, 400);

  const a = await ctx.call("POST", "/bgv-runs", { candidateId: state.candidateId });
  assert.equal(a.status, 201);
  state.runId = a.body.data._id;

  const b = await ctx.call("POST", "/bgv-runs", { candidateId: state.candidateId });
  assert.equal(b.status, 200);
  assert.equal(b.body.data._id, state.runId);

  assert.deepEqual((await log(state.runId)).filter((x) => x === "RUN_CREATED").length, 1);
});

test("3-7. search with both providers: dedupe, namesake, missing URLs, stats, logs", async () => {
  H.resetProviderCalls();

  H.setProviders({
    tavily: (query) => [
      // same profile as Serper's, different URL spelling -> must dedupe
      {
        title: "Rahul Sharma - Software Engineer - TCS | LinkedIn",
        url: "http://in.linkedin.com/in/rahul-sharma-pune/",
        content: "Pune, Maharashtra, India · Software Engineer · TCS. Education: IIT Indore.",
        score: 0.9,
      },
      H.tavilyGithub({ name: "Rahul Sharma", user: "rahulsharma-pune", bio: "Software engineer at TCS, Pune" }),
      // no URL at all -> cannot become a profile, but must be counted
      { title: "Rahul Sharma blog post", content: "no url here" },
    ],
    serper: (query, options) =>
      (options.page || 1) > 1 ? [] : [rightPerson(), namesake()],
  });

  const r = await ctx.call("POST", `/bgv-runs/${state.runId}/search`, {
    candidateId: state.candidateId,
  });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);

  const stats = r.body.data.search.stats;

  // never a name-only query when other details exist
  const queries = H.providerCalls.serper.map((c) => c.query);
  assert.ok(queries.length > 3);
  assert.ok(!queries.includes('"Rahul Sharma"'), "name-only query was used");

  // the exact same query + page is never paid for twice in one run
  const keys = H.providerCalls.serper.map((c) => `${c.query.toLowerCase()}|${c.options.page || 1}`);
  assert.equal(new Set(keys).size, keys.length, "a query was sent twice");

  // dedupe: LinkedIn (tavily + serper) -> 1 record, namesake -> 1, github -> 1
  const results = await ctx.call("GET", `/search-results/run/${state.runId}`);
  const urls = results.body.data.map((x) => x.profileUrl);
  assert.equal(
    urls.filter((u) => /rahul-sharma-pune/.test(u)).length,
    1,
    `duplicate profile stored: ${urls.join(", ")}`
  );
  assert.equal(urls.filter((u) => /rahul-sharma-berlin/.test(u)).length, 1);
  assert.ok(urls.some((u) => /github\.com\/rahulsharma-pune/.test(u)));

  // missing URL: counted, not stored, not silently lost
  assert.ok(stats.providerResultsWithoutUrl >= 1);

  // provider statistics are reported
  assert.ok(stats.providerCalls > 0);
  assert.equal(stats.providerCalls, stats.providerCallsOk);

  state.searchStats = stats;

  // audit trail
  const actions = await log(state.runId);
  for (const a of ["SEARCH_STARTED", "SEARCH_COMPLETED", "MATCHING_STARTED", "MATCHING_COMPLETED"]) {
    assert.ok(actions.includes(a), `missing log ${a}: ${actions.join(",")}`);
  }
  assert.equal(actions.filter((a) => a === "SEARCH_STARTED").length, 1);
});

test("10. review list: ranks the right person above the namesake, max 15, human decides", async () => {
  const r = await ctx.call("GET", `/candidate-matches/run/${state.runId}/relevant`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length <= 15);

  const order = r.body.data.map((m) => m.searchResult.profileUrl);
  const iRight = order.findIndex((u) => /rahul-sharma-pune/.test(u));
  const iWrong = order.findIndex((u) => /rahul-sharma-berlin/.test(u));

  assert.ok(iRight >= 0, `right person missing from the shortlist: ${order.join(" | ")}`);
  if (iWrong >= 0) assert.ok(iRight < iWrong, "namesake ranked above the real profile");

  // nothing is approved automatically, whatever the score
  for (const m of r.body.data) assert.equal(m.reviewStatus, "PENDING");

  state.match = r.body.data[iRight];

  // heavy provider dumps are not sent to the browser
  assert.equal(state.match.searchResult.rawData?.providerResults, undefined);
});
