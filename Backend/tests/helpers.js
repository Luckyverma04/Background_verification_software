"use strict";

/**
 * Shared test setup.
 *
 *  - database: TEST_MONGO_URI if set, otherwise an in-memory MongoDB
 *    (mongodb-memory-server, a devDependency)
 *  - search providers: replaced by controllable fakes (no paid API calls)
 *  - BGE-M3: replaced by a small fake HTTP server speaking the same
 *    contract as ml-service/app.py (POST /match/batch)
 */

process.env.NODE_ENV = "test";
process.env.SEARCH_ENRICH_IMAGES = "false";
process.env.SEARCH_ENRICH_PROFILES = "false";
process.env.SEARCH_CONCURRENCY = "2";
process.env.SEARCH_DISCOVERY_PAGES = "2";
process.env.SEARCH_TARGETED_PAGES = "1";
process.env.FINAL_MIN_OK_PROVIDER_CALLS = "3";
process.env.PROVIDER_CACHE_TTL_MS = process.env.PROVIDER_CACHE_TTL_MS || "0"; // cache has its own tests
process.env.PERF_LOG = "false";
process.env.ML_RETRY_DELAY_MS = "5";
process.env.ML_BREAKER_COOLDOWN_MS = "50";

const http = require("http");
const mongoose = require("mongoose");

// ---------------------------------------------------------------
// Fake BGE-M3 service (same request/response shape as app.py)
// ---------------------------------------------------------------
const tokens = (t) =>
  new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1));

const jaccard = (a, b) => {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach((x) => B.has(x) && inter++);
  return inter / (A.size + B.size - inter);
};

const mlState = { requests: 0, fail: false, lastBatchSize: 0, delayMs: 0, inflight: 0, maxInflight: 0, texts: 0 };

const startFakeMl = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ success: true, status: "running" }));
      }

      if (req.method === "POST" && req.url === "/match/batch") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          mlState.requests += 1;

          if (mlState.fail) {
            res.writeHead(500);
            return res.end("boom");
          }

          let payload;
          try {
            payload = JSON.parse(body);
          } catch (e) {
            res.writeHead(422);
            return res.end("bad json");
          }

          if (
            typeof payload.candidate_text !== "string" ||
            !Array.isArray(payload.result_texts)
          ) {
            res.writeHead(422);
            return res.end("contract mismatch");
          }

          mlState.lastBatchSize = payload.result_texts.length;

          const results = payload.result_texts
            .map((text, index) => {
              const similarity = jaccard(payload.candidate_text, text);
              return {
                index,
                similarity: Number(similarity.toFixed(4)),
                similarityPercent: Number((similarity * 100).toFixed(2)),
              };
            })
            .sort((a, b) => b.similarity - a.similarity);

          mlState.texts += payload.result_texts.length;
          mlState.inflight += 1;
          mlState.maxInflight = Math.max(mlState.maxInflight, mlState.inflight);
          setTimeout(() => {
            mlState.inflight -= 1;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, model: "fake-bge-m3", results }));
          }, mlState.delayMs || 0);
        });
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ detail: "Not Found" }));
    });

    server.listen(0, "127.0.0.1", () => resolve(server));
  });

// ---------------------------------------------------------------
// Fake search providers
// ---------------------------------------------------------------
const providerCalls = { tavily: [], serper: [] };

let behaviour = { tavily: () => [], serper: () => [] };

const setProviders = (next) => {
  behaviour = { ...behaviour, ...next };
};

const resetProviderCalls = () => {
  providerCalls.tavily.length = 0;
  providerCalls.serper.length = 0;
};

const installFakeProviders = () => {
  const { registerProvider } = require("../services/searchProvider.service");

  for (const name of ["tavily", "serper"]) {
    registerProvider(name, {
      search: async (query, options = {}) => {
        providerCalls[name].push({ query, options });
        return behaviour[name](query, options);
      },
    });
  }
};

// Result builders (shape of the real provider responses)
const serperLinkedIn = ({ name, slug, title, company, location, extra = "" }) => ({
  title: `${name} - ${title} - ${company} | LinkedIn`,
  link: `https://www.linkedin.com/in/${slug}`,
  snippet: `${location} · ${title} · ${company}. ${extra}`.trim(),
});

const tavilyGithub = ({ name, user, bio = "" }) => ({
  title: `${user} (${name}) · GitHub`,
  url: `https://github.com/${user}`,
  content: `${name}. ${bio}`.trim(),
  score: 0.8,
});

// ---------------------------------------------------------------
// Boot
// ---------------------------------------------------------------
const startAll = async () => {
  const ml = await startFakeMl();
  process.env.ML_SERVICE_URL = `http://127.0.0.1:${ml.address().port}`;

  let uri = process.env.TEST_MONGO_URI;
  let memory = null;

  if (!uri) {
    const { MongoMemoryServer } = require("mongodb-memory-server");
    memory = await MongoMemoryServer.create();
    uri = memory.getUri();
  }

  const dbName = `bgv_test_${process.pid}_${Date.now()}`;
  await mongoose.connect(uri, { dbName });

  const app = require("../app");

  // build every unique index before the first test
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  installFakeProviders();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });

  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      json = null;
    }
    return { status: res.status, body: json };
  };

  const stop = async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => ml.close(r));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    if (memory) await memory.stop();
  };

  return {
    call,
    stop,
    mlState,
    providerCalls,
    models: mongoose.models,
  };
};

module.exports = {
  startAll,
  setProviders,
  resetProviderCalls,
  providerCalls,
  mlState,
  serperLinkedIn,
  tavilyGithub,
};
