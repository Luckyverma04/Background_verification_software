"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const axios = require("axios");

const H = require("./helpers");
const sheet = require("../services/sheetImport.service");

let ctx;
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicEncoding: { type: "spki", format: "pem" } });
const realPost = axios.post;
const realGet = axios.get;
const calls = { token: [], values: [] };
let sheetValues = [];
let googleStatus = 200;

test.before(async () => {
  ctx = await H.startAll();
  process.env.SHEET_QUEUE_DELAY_MS = "0";
  process.env.SHEET_SEARCH_ENABLED = "true";
  process.env.GOOGLE_SHEET_ID = "https://docs.google.com/spreadsheets/d/SHEET123abc/edit?gid=1041549353#gid=1041549353";
  process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = "bot@proj.iam.gserviceaccount.com";
  process.env.GOOGLE_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
  axios.post = async (url, body, opts) => {
    if (String(url).startsWith("https://oauth2.googleapis.com")) {
      calls.token.push({ url, body });
      return { data: { access_token: "tok", expires_in: 3600 } };
    }
    return realPost(url, body, opts);
  };
  axios.get = async (url, opts) => {
    if (String(url).startsWith("https://sheets.googleapis.com")) {
      if (!/\/values\//.test(String(url))) return { data: { sheets: [{ properties: { sheetId: 0, title: "Other" } }, { properties: { sheetId: 1041549353, title: "Prembly Internal sheet" } }] } };
      calls.values.push({ url, opts });
      if (googleStatus !== 200) { const e = new Error("x"); e.response = { status: googleStatus, data: {} }; throw e; }
      return { data: { values: sheetValues } };
    }
    return realGet(url, opts);
  };
});
test.after(async () => {
  axios.post = realPost; axios.get = realGet;
  await ctx.stop();
});
test.beforeEach(() => { sheet._resetForTests(); calls.token = []; calls.values = []; googleStatus = 200; });


const HEAD = ["Job ID", "Created Date", "Tenant/App Name", "Candidate Name", "Email", "Contact Number(s)", "Date of Birth", "Address(es)", "Education", "Work Experience", "Social Media Profiles", "Profile Image URL", "Duplicate Status", "Created By", "Assigned To", "LinkedIn", "Facebook"];
const ROW = (job, name, email, o = {}) => [
  job, "1/2/2026", "Prembly", name, email, o.phone ?? `+255 7${String([...job].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 100000000).padStart(8, "0")}`, o.dob ?? "1/15/2000",
  o.address ?? "city: Dar es salaam\ncountry: TANZANIA",
  o.edu ?? "degree: BSc\ninstitution: University of Dar es Salaam\nendYear: 2022",
  o.exp ?? "company: Acme Ltd\njobTitle: Engineer\nstartDate: 1/1/2023",
  o.social ?? "", o.img ?? "https://img.example.com/p.jpg?sig=1", "Unique", "ops", "agent", o.li ?? "", o.fb ?? "",
];
const names = [];
const inflight = { now: 0, max: 0 };
const useProviders = (delay = 0) => {
  const rec = async (q) => {
    const m = String(q).match(/(Alpha|Bravo|Charlie|Delta) Person/i);
    if (m) names.push(m[1].toLowerCase());
    inflight.now++; inflight.max = Math.max(inflight.max, inflight.now);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    inflight.now--;
    return [];
  };
  H.setProviders({ serper: rec, tavily: rec });
};
const sync = () => ctx.call("POST", "/sheet-import/sync", {});
const items = async () => (await ctx.call("GET", "/sheet-import/items")).body.data;
const itemOf = async (job) => (await items()).find((i) => i.jobId === job);

test("T1. new rows are detected and imported; real headers mapped; tab resolved from gid; read-only scope; NO search", async () => {
  H.resetProviderCalls(); useProviders();
  sheetValues = [HEAD, ROW("J1", "ALPHA PERSON", "Alpha@Example.com", { li: "https://www.linkedin.com/in/alpha", fb: "https://facebook.com/alpha.p", social: "https://twitter.com/alpha\nhttps://example.org/me" })];
  const before = await ctx.models.BgvRun.countDocuments();
  const r = await sync();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.imported, 1);
  assert.equal(r.body.data.tab, "Prembly Internal sheet");
  const c = await ctx.models.Candidate.findOne({ email: "alpha@example.com" }).lean();
  assert.equal(c.fullName, "Alpha Person");
  assert.match(c.phone.replace(/\D/g, ""), /^2557\d{8}$/);
  assert.equal(c.location.city, "Dar es salaam");
  assert.equal(c.linkedin, "https://www.linkedin.com/in/alpha");
  assert.equal(c.facebook, "https://facebook.com/alpha.p");
  assert.equal(c.twitter, "https://twitter.com/alpha");
  assert.equal(c.education[0].institution, "University of Dar es Salaam");
  assert.equal(c.currentCompany, "Acme Ltd");
  assert.equal(new Date(c.dateOfBirth).toISOString().slice(0, 10), "2000-01-15");
  assert.equal(c.source, "GOOGLE_SHEET");
  assert.equal(c.sheetSource.jobId, "J1");
  assert.equal(c.sheetSource.tab, "Prembly Internal sheet");
  assert.equal(c.sheetSource.rowNumber, 2);
  assert.equal(c.sheetSource.spreadsheetId, "SHEET123abc");
  assert.equal(c.sourceImageUrl, "https://img.example.com/p.jpg?sig=1");
  // nothing searched, no run
  assert.equal(await ctx.models.BgvRun.countDocuments(), before);
  assert.equal(H.providerCalls.serper.length + H.providerCalls.tavily.length, 0);
  const assertion = new URLSearchParams(calls.token[0].body).get("assertion");
  assert.equal(JSON.parse(Buffer.from(assertion.split(".")[1], "base64url")).scope, "https://www.googleapis.com/auth/spreadsheets.readonly");
  const it = await itemOf("J1");
  assert.equal(it.queueStatus, "REVIEW");
  assert.equal(it.confirmed, false);
  assert.equal((await ctx.call("GET", "/sheet-import/status")).body.data.message, "Candidate data imported. Please review completeness before starting searches.");
});

test("T2. repeated / restarted syncs do not import again; only new rows are added", async () => {
  sheetValues = [HEAD, ROW("J1", "Alpha Person", "alpha@example.com"), ROW("J2", "Bravo Person", "bravo@example.com")];
  const r = await sync();
  assert.equal(r.body.data.imported, 1);
  assert.equal(r.body.data.alreadyImported, 1);
  sheet._resetForTests(); // "restart"
  const r2 = await sync();
  assert.equal(r2.body.data.imported, 0);
  assert.equal(await ctx.models.Candidate.countDocuments({ source: "GOOGLE_SHEET" }), 2);
  const st = (await ctx.call("GET", "/sheet-import/status")).body.data;
  assert.ok(st.lastSuccessAt);
  assert.equal(st.tab, "Prembly Internal sheet");
});

test("T3. two simultaneous syncs never create a candidate twice", async () => {
  sheetValues = [HEAD, ROW("R1", "Race One", "race1@example.com"), ROW("R2", "Race Two", "race2@example.com")];
  const rs = await Promise.all([sync(), sync()]);
  assert.ok(rs.every((r) => [200, 409].includes(r.status)));
  assert.equal(await ctx.models.Candidate.countDocuments({ email: /^race[12]@/ }), 2);
  assert.equal(await ctx.models.SheetImportRow.countDocuments({ jobId: /^R[12]$/ }), 2);
});

test("T4. blank cells do not erase data; manual corrections survive source changes; unedited fields follow the sheet", async () => {
  const c0 = await ctx.models.Candidate.findOne({ email: "bravo@example.com" });
  await ctx.call("PATCH", `/candidates/${c0._id}`, { currentCompany: "Manual Corp" });
  // sheet: company changed, phone blanked, address changed
  sheetValues = [HEAD, ROW("J1", "Alpha Person", "alpha@example.com"),
    ROW("J2", "Bravo Person", "bravo@example.com", { phone: "", exp: "company: Sheet Corp\njobTitle: Engineer", address: "city: Arusha\ncountry: TANZANIA" })];
  const r = await sync();
  assert.equal(r.body.data.updated, 1);
  const c = await ctx.models.Candidate.findById(c0._id).lean();
  assert.equal(c.currentCompany, "Manual Corp", "manual edit kept");
  assert.ok(c.phone, "blank sheet cell did not erase the phone");
  assert.equal(c.location.city, "Arusha", "unedited field follows the sheet");
});

test("T5. a column that is blank in the sheet fills a blank field but never wipes; invalid values are reported, not dropped silently", async () => {
  sheetValues = [HEAD, ROW("J3", "Charlie Person", "not-an-email", { li: "", phone: "abc" })];
  const r = await sync();
  assert.equal(r.body.data.imported, 1, JSON.stringify(r.body.data));
  const it = await itemOf("J3");
  assert.ok(it.completeness.invalid.length >= 1);
  assert.ok(it.completeness.invalid.some((x) => /email/i.test(x.field)));
});

test("T6. completeness: name + LinkedIn is searchable; name only is INCOMPLETE; edits recalculate immediately", async () => {
  sheetValues = [HEAD, ROW("J4", "Delta Person", "", { phone: "", dob: "", address: "", edu: "", exp: "", img: "", li: "https://linkedin.com/in/delta" }),
    ROW("J5", "Nameonly Person", "", { phone: "", dob: "", address: "", edu: "", exp: "", img: "" })];
  await sync();
  const a = await itemOf("J4");
  const b = await itemOf("J5");
  assert.equal(a.completeness.searchable, true);
  assert.notEqual(a.completeness.level, "INCOMPLETE");
  assert.equal(b.completeness.level, "INCOMPLETE");
  assert.ok(b.completeness.missing.length > 0);
  await ctx.call("PATCH", `/candidates/${b.candidateId}`, { email: "nameonly@example.com", currentCompany: "Zeta", location: { city: "Pune", country: "India" } });
  const b2 = await itemOf("J5");
  assert.notEqual(b2.completeness.level, "INCOMPLETE");
});

test("T7. incomplete / unconfirmed candidates cannot enter the queue; override needs explicit acknowledgement", async () => {
  H.resetProviderCalls(); useProviders();
  sheetValues = [HEAD, ROW("J6", "Echo Person", "", { phone: "", dob: "", address: "", edu: "", exp: "", img: "" })];
  await sync();
  const it = await itemOf("J6");
  assert.equal(it.completeness.level, "INCOMPLETE");
  // starting the queue without confirmation queues nothing
  let q = await ctx.call("POST", "/sheet-import/queue/start", { candidateIds: [String(it.candidateId)] });
  assert.equal(q.body.data.queued, 0);
  // confirm without acknowledgement is refused with details
  let c = await ctx.call("POST", "/sheet-import/confirm", { candidateIds: [String(it.candidateId)] });
  assert.equal(c.body.data.confirmed.length, 0);
  assert.equal(c.body.data.needsAcknowledgement.length, 1);
  q = await ctx.call("POST", "/sheet-import/queue/start", {});
  await sheet.waitIdle();
  assert.equal((await itemOf("J6")).queueStatus, "REVIEW");
  assert.equal(H.providerCalls.serper.length + H.providerCalls.tavily.length, 0);
  // explicit override
  c = await ctx.call("POST", "/sheet-import/confirm", { candidateIds: [String(it.candidateId)], acknowledgeIncomplete: true });
  assert.equal(c.body.data.confirmed.length, 1);
  assert.equal((await itemOf("J6")).incompleteOverride, true);
  // confirmed but queue not started -> still nothing searched
  await sheet.waitIdle();
  assert.equal(H.providerCalls.serper.length + H.providerCalls.tavily.length, 0);
  // unconfirm puts it back
  await ctx.call("POST", "/sheet-import/unconfirm", { candidateIds: [String(it.candidateId)] });
  assert.equal((await itemOf("J6")).confirmed, false);
  assert.equal((await ctx.call("POST", "/sheet-import/confirm", {})).status, 400);
});

test("T8. after confirmation + start, candidates are searched ONE BY ONE and results saved against the right candidate/run", async () => {
  names.length = 0; inflight.max = 0; H.resetProviderCalls(); useProviders(15);
  sheetValues = [HEAD,
    ROW("Q1", "Alpha Person", "alpha.q1@example.com"), ROW("Q2", "Bravo Person", "bravo.q2@example.com"), ROW("Q3", "Charlie Person", "charlie.q3@example.com")];
  await sync();
  const list = (await items()).filter((i) => /^Q\d$/.test(i.jobId));
  const ids = list.map((i) => String(i.candidateId));
  const cf = await ctx.call("POST", "/sheet-import/confirm", { candidateIds: ids });
  assert.equal(cf.body.data.confirmed.length, 3);
  // a row added while the queue runs waits for confirmation
  const st = await ctx.call("POST", "/sheet-import/queue/start", { candidateIds: ids });
  assert.equal(st.body.data.queued, 3);
  sheetValues = [...sheetValues, ROW("Q4", "Delta Person", "delta.q4@example.com")];
  await sync();
  await sheet.waitIdle();
  const order = [];
  for (const n of names) if (order[order.length - 1] !== n) order.push(n);
  assert.deepEqual(order, ["alpha", "bravo", "charlie"]);
  for (const j of ["Q1", "Q2", "Q3"]) {
    const it = await itemOf(j);
    assert.equal(it.queueStatus, "DONE", j + " " + JSON.stringify(it));
    const run = await ctx.models.BgvRun.findById(it.bgvRun).lean();
    assert.equal(String(run.candidate), String(it.candidateId));
    assert.ok(run.searchStartedAt);
    assert.equal(await ctx.models.BgvRun.countDocuments({ candidate: it.candidateId }), 1);
  }
  const q4 = await itemOf("Q4");
  assert.equal(q4.queueStatus, "REVIEW");
  assert.equal(q4.bgvRun, null);
});

test("T9. a failed search is shown and retried without duplicating work", async () => {
  const it = await itemOf("Q1");
  const runsBefore = await ctx.models.BgvRun.countDocuments({ candidate: it.candidateId });
  await ctx.models.SheetImportRow.updateOne({ candidate: it.candidateId }, { $set: { searchStatus: "FAILED", searchError: "boom" } });
  assert.equal((await itemOf("Q1")).error, "boom");
  const r = await ctx.call("POST", "/sheet-import/queue/retry", {});
  assert.equal(r.body.data.retried, 1);
  await sheet.waitIdle();
  const after = await itemOf("Q1");
  assert.equal(after.queueStatus, "DONE");
  assert.equal(await ctx.models.BgvRun.countDocuments({ candidate: it.candidateId }), runsBefore, "same run reused");
  assert.ok(after.attempts >= 2);
});

test("T10. restart: a search interrupted mid-flight is re-queued and finished; the interrupted run is closed (history kept)", async () => {
  names.length = 0; useProviders();
  const it = await itemOf("Q4");
  await ctx.call("POST", "/sheet-import/confirm", { candidateIds: [String(it.candidateId)] });
  const created = await ctx.call("POST", "/bgv-runs", { candidateId: String(it.candidateId) });
  const runId = created.body.data._id;
  await ctx.models.BgvRun.updateOne({ _id: runId }, { $set: { status: "SEARCHING" } });
  await ctx.models.SheetImportRow.updateOne({ candidate: it.candidateId }, { $set: { searchStatus: "RUNNING", bgvRun: runId } });
  const r = await sheet.resumeQueue();
  assert.equal(r.requeued, 1);
  await sheet.waitIdle();
  const after = await itemOf("Q4");
  assert.equal(after.queueStatus, "DONE");
  assert.ok(names.includes("delta"));
  assert.ok(await ctx.models.BgvRun.exists({ _id: runId }), "interrupted run is never deleted");
});

test("T11. queued items are claimed atomically: two workers never take the same candidate", async () => {
  names.length = 0; useProviders(10);
  sheetValues = [...sheetValues, ROW("Q5", "Alpha Person", "alpha.q5@example.com")];
  await sync();
  const it = await itemOf("Q5");
  await ctx.call("POST", "/sheet-import/confirm", { candidateIds: [String(it.candidateId)] });
  process.env.SHEET_QUEUE_CONCURRENCY = "3";
  await ctx.call("POST", "/sheet-import/queue/start", {});
  await ctx.call("POST", "/sheet-import/queue/start", {});
  await sheet.waitIdle();
  process.env.SHEET_QUEUE_CONCURRENCY = "1";
  assert.equal(await ctx.models.BgvRun.countDocuments({ candidate: it.candidateId }), 1);
  assert.equal((await itemOf("Q5")).queueStatus, "DONE");
});

test("T12. search disabled: confirmed candidates cannot be queued", async () => {
  sheetValues = [...sheetValues, ROW("Q6", "Bravo Person", "bravo.q6@example.com")];
  await sync();
  const it = await itemOf("Q6");
  await ctx.call("POST", "/sheet-import/confirm", { candidateIds: [String(it.candidateId)] });
  process.env.SHEET_SEARCH_ENABLED = "false";
  const r = await ctx.call("POST", "/sheet-import/queue/start", {});
  process.env.SHEET_SEARCH_ENABLED = "true";
  assert.equal(r.status, 409);
  assert.equal((await itemOf("Q6")).queueStatus, "REVIEW");
});

test("T13. duplicates: same email links to the existing candidate; same name alone never merges", async () => {
  await ctx.call("POST", "/candidates", { fullName: "Hand Made", email: "hand@example.com" });
  sheetValues = [HEAD, ROW("D1", "Hand M", "hand@example.com"), ROW("D2", "Hand Made", "different@example.com", { phone: "" })];
  const r = await sync();
  assert.equal(r.body.data.linkedExisting, 1);
  assert.equal(r.body.data.imported, 1);
  assert.equal(await ctx.models.Candidate.countDocuments({ email: "hand@example.com" }), 1);
  assert.equal(await ctx.models.Candidate.countDocuments({ fullName: "Hand Made" }), 2);
});

test("T14. Google errors: clear messages, no key leaked; status never exposes the key; unconfigured -> 400", async () => {
  googleStatus = 403;
  const r = await sync();
  assert.equal(r.status, 502);
  assert.match(r.body.message, /bot@proj\.iam\.gserviceaccount\.com/);
  assert.equal(JSON.stringify(r.body).includes("PRIVATE KEY"), false);
  googleStatus = 200;
  const st = await ctx.call("GET", "/sheet-import/status");
  assert.equal(st.body.data.configured, true);
  assert.ok(st.body.data.lastError);
  assert.equal(JSON.stringify(st.body).includes("BEGIN"), false);
  const saved = process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SHEET_ID;
  assert.equal((await sync()).status, 400);
  process.env.GOOGLE_SHEET_ID = saved;
  sheetValues = [["Foo", "Bar"], ["a", "b"]];
  assert.equal((await sync()).status, 400);
});

test("T15. existing identity verification + manual review still work for sheet candidates", async () => {
  const it = await itemOf("Q1");
  const run = await ctx.models.BgvRun.findById(it.bgvRun).lean();
  assert.ok(run);
  const reg = await ctx.call("GET", `/verified-identities?candidate=${it.candidateId}`);
  assert.equal(reg.status, 200);
  const kp = await ctx.call("GET", `/bgv-runs/${it.bgvRun}/known-profiles`);
  assert.equal(kp.status, 200);
  assert.equal(await ctx.models.BgvRun.countDocuments({ candidate: it.candidateId }), 1, "history untouched");
});
