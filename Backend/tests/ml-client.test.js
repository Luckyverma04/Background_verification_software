"use strict";

// Node ML client <-> /match/batch contract (no Mongo needed; local stub server).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

process.env.ML_RETRY_DELAY_MS = "1";
process.env.ML_BREAKER_COOLDOWN_MS = "50";
process.env.ML_BREAKER_THRESHOLD = "2";

const ml = require("../services/mlMatch.service");

let server;
const stub = { handler: null, bodies: [], hits: 0 };

test.before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      stub.hits += 1;
      const body = JSON.parse(raw || "{}");
      stub.bodies.push(body);
      const out = stub.handler(body);
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => {
  stub.bodies = [];
  stub.hits = 0;
  ml.resetState();
  ml.resetMetrics();
});

const okRow = (index, sim) => ({ index, status: "OK", similarity: sim, similarityPercent: sim * 100 });
const echoOk = (b) => ({ status: 200, json: { success: true, model: "m", results: b.result_texts.map((_, i) => okRow(i, 0.5)) } });

test("M1. normal strings are scored with their own index", async () => {
  stub.handler = echoOk;
  const r = await ml.getMLSimilarities({ candidateText: "alice", resultTexts: ["a", "b"] });
  assert.deepEqual(r.map((x) => x.status), ["SCORED", "SCORED"]);
  assert.equal(r[0].similarityPercent, 50);
});

test("M2. null / empty / object / array entries are never sent, never scored, indexes preserved", async () => {
  stub.handler = echoOk;
  const input = [null, "good one", "", { a: 1 }, ["x"], "  ", "good two", undefined];
  const r = await ml.getMLSimilarities({ candidateText: "alice", resultTexts: input });
  assert.equal(r.length, input.length);
  assert.deepEqual(stub.bodies[0].result_texts, ["good one", "good two"], "only valid text reaches the service");
  assert.deepEqual(r.map((x) => x.status), ["INVALID_INPUT", "SCORED", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "INVALID_INPUT", "SCORED", "INVALID_INPUT"]);
  for (const i of [0, 2, 3, 4, 5, 7]) {
    assert.equal(r[i].similarityPercent, null, "invalid input is not a 0 score");
    assert.ok(r[i].error.code);
  }
  assert.deepEqual([r[1].similarityPercent, r[6].similarityPercent], [50, 50]);
  assert.equal(JSON.stringify(stub.bodies[0]).includes("[object Object]"), false);
});

test("M3. all entries invalid: no HTTP call at all", async () => {
  stub.handler = echoOk;
  const r = await ml.getMLSimilarities({ candidateText: "alice", resultTexts: [null, "", {}] });
  assert.equal(stub.hits, 0);
  assert.ok(r.every((x) => x.status === "INVALID_INPUT" && x.similarityPercent === null));
});

test("M4. per-item UNAVAILABLE from the service stays null (not 0) and neighbours keep their scores", async () => {
  stub.handler = (b) => ({
    status: 200,
    json: {
      success: true, partial: true, model: "m",
      results: [okRow(0, 0.8), { index: 1, status: "UNAVAILABLE", similarity: null, similarityPercent: null, error: { code: "ENCODE_FAILED", pythonType: "str" } }, okRow(2, 0.3)],
    },
  });
  const r = await ml.getMLSimilarities({ candidateText: "alice", resultTexts: ["a", "b", "c"] });
  assert.deepEqual(r.map((x) => x.status), ["SCORED", "UNAVAILABLE", "SCORED"]);
  assert.equal(r[1].similarityPercent, null);
  assert.equal(r[1].similarity, null);
  assert.equal(r[1].error.code, "ENCODE_FAILED");
  assert.equal(r[0].similarityPercent, 80);
});

test("M5. a row with null similarity but no status is still 'no score', never 0", async () => {
  stub.handler = () => ({ status: 200, json: { model: "m", results: [{ index: 0, similarity: null, similarityPercent: null }] } });
  const r = await ml.getMLSimilarities({ candidateText: "alice", resultTexts: ["a"] });
  assert.equal(r[0].status, "UNAVAILABLE");
  assert.equal(r[0].similarityPercent, null);
});

test("M6. HTTP 503: retried once, then throws with mlStatus/mlCode; feeds the breaker", async () => {
  stub.handler = () => ({ status: 503, json: { detail: { success: false, code: "ML_UNAVAILABLE", message: "x" } } });
  await assert.rejects(ml.getMLSimilarities({ candidateText: "alice", resultTexts: ["a"] }), (e) => {
    assert.equal(e.mlStatus, 503);
    assert.equal(e.mlCode, "ML_UNAVAILABLE");
    assert.equal(e.code, "ML_UNAVAILABLE");
    return true;
  });
  assert.equal(stub.hits, 2, "one retry");
  await assert.rejects(ml.getMLSimilarities({ candidateText: "alice", resultTexts: ["a"] }));
  assert.equal(ml.getMetrics().breakerOpen, true);
});

test("M7. HTTP 422 (bad request data) is not retried and does not trip the breaker", async () => {
  stub.handler = () => ({ status: 422, json: { detail: { success: false, code: "INVALID_CANDIDATE_TEXT" } } });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(ml.getMLSimilarities({ candidateText: "alice", resultTexts: ["a"] }), (e) => e.code === "ML_BAD_REQUEST" && e.mlStatus === 422);
  }
  assert.equal(stub.hits, 3, "no retries");
  assert.equal(ml.getMetrics().breakerOpen, false);
});

test("M8. unusable candidate text is refused locally (no request)", async () => {
  stub.handler = echoOk;
  await assert.rejects(ml.getMLSimilarities({ candidateText: { a: 1 }, resultTexts: ["a"] }), (e) => e.code === "ML_BAD_REQUEST");
  assert.equal(stub.hits, 0);
});

test("M9. scoreTexts: statuses SCORED / INVALID_INPUT / EMPTY / UNAVAILABLE, never a fake 0", async () => {
  stub.handler = echoOk;
  const a = await ml.scoreTexts({ candidateText: "alice", resultTexts: ["ok text", {}, null, "", ["n"]] });
  assert.deepEqual(a.map((x) => x.status), ["SCORED", "INVALID_INPUT", "EMPTY", "EMPTY", "INVALID_INPUT"]);
  assert.deepEqual(a.map((x) => x.similarityPercent), [50, null, null, null, null]);

  ml.resetState();
  stub.handler = () => ({ status: 503, json: { detail: { code: "ML_UNAVAILABLE" } } });
  const b = await ml.scoreTexts({ candidateText: "alice", resultTexts: ["t1", {}, "t2"] });
  assert.deepEqual(b.map((x) => x.status), ["UNAVAILABLE", "INVALID_INPUT", "UNAVAILABLE"]);
  assert.ok(b.every((x) => x.similarityPercent === null));

  // failures are not cached: once healthy again the same text is scored for real
  ml.resetState();
  stub.handler = echoOk;
  const c = await ml.scoreTexts({ candidateText: "alice", resultTexts: ["t1"] });
  assert.equal(c[0].status, "SCORED");
});

test("M10. scoreTexts: a per-item failure from the service marks only that item UNAVAILABLE", async () => {
  stub.handler = () => ({ status: 200, json: { model: "m", results: [okRow(0, 0.9), { index: 1, status: "UNAVAILABLE", similarity: null, similarityPercent: null, error: { code: "NULL_TEXT" } }] } });
  const r = await ml.scoreTexts({ candidateText: "alice", resultTexts: ["x1", "x2"] });
  assert.deepEqual(r.map((x) => x.status), ["SCORED", "UNAVAILABLE"]);
  assert.equal(r[1].similarityPercent, null);
});
