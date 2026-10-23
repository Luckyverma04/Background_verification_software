"use strict";

/**
 * Google Sheet -> Candidates -> (human review) -> sequential search queue.
 *
 * What happens, in order
 *   1. SYNC     the sheet is read (service account, read-only scope) on a timer
 *               and on demand. New rows become Candidates automatically; known
 *               rows are updated with FIELD-LEVEL rules (see applySourceUpdate).
 *   2. REVIEW   every imported candidate waits as REVIEW. Completeness is
 *               computed live from the stored candidate, so an edit is reflected
 *               immediately. NOTHING is searched at this point.
 *   3. CONFIRM  the reviewer confirms candidates (and, for incomplete / invalid
 *               data, explicitly acknowledges that).
 *   4. QUEUE    "start" puts confirmed candidates in a persistent queue. Workers
 *               take ONE candidate at a time (default concurrency 1), run the
 *               existing BGV run + search + matching pipeline, save, then pause
 *               before the next one.
 *
 * Guarantees: the sheet is only read; one source row = one candidate (unique
 * index); blanks never erase data; manual edits are never overwritten; nothing
 * is deleted; credentials stay server-side.
 */

const crypto = require("crypto");
const fs = require("fs");
const axios = require("axios");

const Candidate = require("../models/Candidate");
const BgvRun = require("../models/BgvRun");
const SheetImportRow = require("../models/SheetImportRow");
const SheetSyncState = require("../models/SheetSyncState");
const map = require("../utils/sheetMapping");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const num = (name, def, { min = 0, max = Infinity } = {}) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min ? Math.min(v, max) : def;
};

// ---------------------------------------------------------------- config
const parseSheetRef = (value) => {
  const v = String(value || "").trim();
  const id = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const gid = v.match(/[#?&]gid=(\d+)/);
  return { id: id ? id[1] : v.replace(/[^a-zA-Z0-9-_].*$/, ""), gid: gid ? gid[1] : null };
};
const sheetIdFrom = (value) => parseSheetRef(value).id;

const loadCredentials = () => {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let json = null;
  if (raw) {
    try {
      json = raw.trim().startsWith("{") ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw.trim(), "utf8"));
    } catch {
      const e = new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON / the key file could not be read");
      e.code = "SHEET_CONFIG";
      throw e;
    }
  }
  const email = json?.client_email || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (json?.private_key || process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return email && key ? { email, key } : null;
};

const getConfig = () => {
  const ref = parseSheetRef(process.env.GOOGLE_SHEET_ID);
  let creds = null;
  let credError = null;
  try { creds = loadCredentials(); } catch (e) { credError = e.message; }
  return {
    sheetId: ref.id,
    gid: ref.gid,
    tab: (process.env.GOOGLE_SHEET_TAB || "").trim(),
    creds,
    credError,
    configured: Boolean(ref.id && creds),
    searchEnabled: String(process.env.SHEET_SEARCH_ENABLED || "true").toLowerCase() !== "false",
    pollMinutes: num("SHEET_SYNC_INTERVAL_MIN", 5),
    delayMs: num("SHEET_QUEUE_DELAY_MS", 2000),
    concurrency: Math.round(num("SHEET_QUEUE_CONCURRENCY", 1, { min: 1, max: 3 })),
    dateOrder: String(process.env.SHEET_DATE_ORDER || "MDY").toUpperCase() === "DMY" ? "DMY" : "MDY",
    maxRows: Math.round(num("SHEET_MAX_ROWS", 5000, { min: 1 })),
  };
};

// ---------------------------------------------------------------- google
const b64url = (input) => Buffer.from(input).toString("base64url");
let tokenCache = { token: null, exp: 0, email: null };

const getAccessToken = async (creds) => {
  if (tokenCache.token && tokenCache.email === creds.email && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: creds.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  let signature;
  try {
    signature = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(creds.key).toString("base64url");
  } catch {
    const e = new Error("The Google private key is not a valid PEM key");
    e.code = "SHEET_CONFIG";
    throw e;
  }
  const res = await axios.post(
    TOKEN_URL,
    new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${signature}` }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000 }
  );
  tokenCache = { token: res.data.access_token, exp: Date.now() + (Number(res.data.expires_in) || 3600) * 1000, email: creds.email };
  return tokenCache.token;
};

const sheetsGet = async (cfg, path, params) => {
  const token = await getAccessToken(cfg.creds);
  return axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cfg.sheetId)}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    params,
    timeout: 30000,
  });
};

/** The tab to read: GOOGLE_SHEET_TAB, else the tab named by the URL's gid, else the first tab. */
const resolveTab = async (cfg) => {
  if (cfg.tab) return cfg.tab;
  const meta = await sheetsGet(cfg, "", { fields: "sheets.properties(sheetId,title)" });
  const tabs = (meta.data?.sheets || []).map((s) => s.properties).filter(Boolean);
  const byGid = cfg.gid ? tabs.find((t) => String(t.sheetId) === String(cfg.gid)) : null;
  return (byGid || tabs[0])?.title || "Sheet1";
};

const fetchValues = async (cfg, tab) => {
  const range = `'${tab.replace(/'/g, "''")}'`;
  const res = await sheetsGet(cfg, `/values/${encodeURIComponent(range)}`, { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
  return Array.isArray(res.data?.values) ? res.data.values : [];
};

const friendlyGoogleError = (error, cfg) => {
  const status = error?.response?.status;
  if (error?.code === "SHEET_CONFIG") return error.message;
  if (status === 403) return `Google refused access. Share the sheet (Viewer) with ${cfg.creds?.email} and make sure the Google Sheets API is enabled for the project.`;
  if (status === 404) return "Sheet not found. Check GOOGLE_SHEET_ID.";
  if (status === 400) return "Google could not read that tab. Check GOOGLE_SHEET_TAB spelling.";
  if (status === 401 || error?.response?.data?.error === "invalid_grant") return "Google rejected the service-account key (wrong or revoked key, or wrong system clock).";
  return `Could not reach Google Sheets (${status || error?.code || error?.message}).`;
};

// ---------------------------------------------------------------- field-level sync
const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
const canon = (v) => {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return JSON.stringify(v.map((x) => (x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, iso(y)]).filter(([, y]) => y !== undefined && y !== null && y !== "").sort()) : x)));
  return String(iso(v)).trim();
};
const SCALARS = ["fullName", "email", "phone", "dateOfBirth", "address", "currentCompany", "currentJobTitle", "linkedin", "facebook", "twitter", "instagram", "github", "website", "sourceImageUrl"];

const toDbValue = (field, v) => (field === "dateOfBirth" ? new Date(`${v}T00:00:00.000Z`) : v);
const toDbArray = (field, arr) =>
  field === "experience" ? arr.map((x) => ({ ...x, ...(x.startDate ? { startDate: new Date(x.startDate) } : {}), ...(x.endDate ? { endDate: new Date(x.endDate) } : {}) })) : arr;

/**
 * What may be written to an already-imported candidate when its source row changed.
 *  - a blank sheet value never changes anything
 *  - the candidate field is blank            -> filled
 *  - candidate value == last synced value    -> nobody edited it -> take the new sheet value
 *  - candidate value != last synced value    -> a human corrected it -> KEPT
 */
const applySourceUpdate = (candidate, incoming, snapshot = {}) => {
  const set = {};
  const kept = [];
  const decide = (field, cur, nextVal, prevVal, write) => {
    if (canon(nextVal) === "") return;
    if (canon(cur) === canon(nextVal)) return;
    if (canon(cur) === "" || canon(cur) === canon(prevVal)) write();
    else kept.push(field);
  };
  for (const f of SCALARS) decide(f, candidate[f], incoming[f], snapshot[f], () => { set[f] = toDbValue(f, incoming[f]); });
  for (const k of ["city", "state", "country"]) {
    decide(`location.${k}`, candidate.location?.[k], incoming.location?.[k], snapshot.location?.[k], () => { set[`location.${k}`] = incoming.location[k]; });
  }
  for (const f of ["experience", "education"]) {
    const nextVal = incoming[f]?.length ? incoming[f] : undefined;
    decide(f, candidate[f]?.length ? candidate[f] : undefined, nextVal, snapshot[f], () => { set[f] = toDbArray(f, nextVal); });
  }
  return { set, kept };
};

// ---------------------------------------------------------------- duplicates across rows
/** An existing candidate this row clearly describes: same e-mail, or same phone AND same name. Names alone never match. */
const findExistingCandidate = async (c) => {
  if (c.email) {
    const byEmail = await Candidate.findOne({ email: c.email }).select("_id").lean();
    if (byEmail) return { id: byEmail._id, reason: "same email" };
  }
  const digits = map.clean(c.phone).replace(/\D/g, "");
  if (digits.length >= 7) {
    const tail = digits.slice(-10);
    const sameName = await Candidate.find({ fullName: new RegExp(`^${c.fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), phone: { $exists: true } }).select("_id phone").limit(20).lean();
    const hit = sameName.find((x) => String(x.phone).replace(/\D/g, "").slice(-10) === tail);
    if (hit) return { id: hit._id, reason: "same phone and name" };
  }
  return null;
};

// ---------------------------------------------------------------- sync
let syncing = false;

const recordState = (cfg, tab, patch) =>
  SheetSyncState.updateOne({ sheetId: cfg.sheetId || "injected" }, { $set: { tab, ...patch }, $setOnInsert: { sheetId: cfg.sheetId || "injected" } }, { upsert: true }).catch(() => {});

const syncFromSheet = async ({ rows: injectedRows, tab: injectedTab } = {}) => {
  const cfg = getConfig();
  if (!injectedRows && !cfg.configured) {
    const e = new Error(cfg.credError || "Google Sheet import is not configured (GOOGLE_SHEET_ID and a service account are required)");
    e.code = "SHEET_CONFIG";
    throw e;
  }
  if (syncing) {
    const e = new Error("A sync is already running");
    e.code = "SYNC_RUNNING";
    throw e;
  }
  syncing = true;
  const startedAt = new Date();
  const summary = { sheetId: cfg.sheetId, tab: null, startedAt, totalRows: 0, imported: 0, alreadyImported: 0, updated: 0, linkedExisting: 0, skipped: [], error: null };
  let tab = injectedTab || null;
  await recordState(cfg, tab, { lastAttemptAt: startedAt });
  try {
    let values;
    try {
      if (injectedRows) values = injectedRows;
      else { tab = await resolveTab(cfg); values = await fetchValues(cfg, tab); }
    } catch (error) {
      const e = new Error(friendlyGoogleError(error, cfg));
      e.code = error?.code === "SHEET_CONFIG" ? "SHEET_CONFIG" : "SHEET_FETCH";
      throw e;
    }
    summary.tab = tab;
    const detected = map.detectHeaders(values);
    if (!detected) {
      if (values.length < 2) { await finish(cfg, tab, summary); return summary; }
      const e = new Error('Could not find a header row with a "Candidate name" / "Name" column in the first 10 rows.');
      e.code = "SHEET_CONFIG";
      throw e;
    }
    const sheetId = cfg.sheetId || "injected";
    const dataRows = values.slice(detected.index + 1, detected.index + 1 + cfg.maxRows);
    summary.totalRows = dataRows.length;

    for (let i = 0; i < dataRows.length; i++) {
      const rowNumber = detected.index + 2 + i;
      const row = dataRows[i];
      if (!row || !row.some((c) => map.clean(c))) continue;
      const mapped = map.mapRow(detected, row, { dateOrder: cfg.dateOrder });
      if (mapped.error) { summary.skipped.push({ row: rowNumber, reason: mapped.error }); continue; }
      try {
        await importRow({ cfg, sheetId, tab, rowNumber, mapped, summary });
      } catch (e) {
        summary.skipped.push({ row: rowNumber, reason: e?.name === "ValidationError" ? "invalid candidate data" : "could not be saved" });
      }
    }
    await finish(cfg, tab, summary);
    return summary;
  } catch (error) {
    summary.error = error.message;
    summary.finishedAt = new Date();
    await recordState(cfg, tab, { lastError: error.message, lastSummary: summary });
    throw error;
  } finally {
    syncing = false;
  }
};

const finish = async (cfg, tab, summary) => {
  summary.finishedAt = new Date();
  await recordState(cfg, tab, { lastSuccessAt: summary.finishedAt, lastError: null, lastSummary: summary });
};

const sourceOf = (cfg, tab, rowNumber, mapped, extra = {}) => ({
  spreadsheetId: cfg.sheetId || "injected",
  tab,
  rowNumber,
  ...mapped.source,
  invalidFields: mapped.invalid,
  ...extra,
});

const importRow = async ({ cfg, sheetId, tab, rowNumber, mapped, summary }) => {
  const { rowKey, candidate: data } = mapped;
  const hash = map.hashOf(data, mapped.source);
  let row = await SheetImportRow.findOne({ sheetId, rowKey });

  if (!row) {
    // claim the source row (unique index): a parallel / repeated sync loses here
    try {
      row = await SheetImportRow.create({ sheetId, tab, rowKey, jobId: mapped.jobId || undefined, rowNumber, status: "CLAIMED", lastSeenAt: new Date() });
    } catch (e) {
      if (e?.code !== 11000) throw e;
      row = await SheetImportRow.findOne({ sheetId, rowKey });
    }
  }

  if (row.status === "IMPORTED" || row.status === "LINKED_EXISTING") {
    summary.alreadyImported += 1;
    await SheetImportRow.updateOne({ _id: row._id }, { $set: { lastSeenAt: new Date(), rowNumber, tab } });
    if (row.status === "IMPORTED" && row.sourceHash !== hash && row.candidate && row.searchStatus !== "RUNNING") {
      const cand = await Candidate.findById(row.candidate).lean();
      if (cand) {
        const { set } = applySourceUpdate(cand, data, row.snapshot || {});
        set["sheetSource"] = { ...(cand.sheetSource || {}), ...sourceOf(cfg, tab, rowNumber, mapped), importedAt: cand.sheetSource?.importedAt, lastSyncedAt: new Date() };
        await Candidate.updateOne({ _id: cand._id }, { $set: set });
        await SheetImportRow.updateOne({ _id: row._id }, { $set: { sourceHash: hash, snapshot: data, lastUpdatedFromSourceAt: new Date() } });
        summary.updated += 1;
      }
    }
    return;
  }

  // brand-new source row (status CLAIMED): link to an existing person, or create
  const existing = await findExistingCandidate(data);
  if (existing) {
    await SheetImportRow.updateOne({ _id: row._id }, { $set: { candidate: existing.id, status: "LINKED_EXISTING", duplicateReason: existing.reason, importedAt: new Date(), sourceHash: hash, searchStatus: "REVIEW" } });
    summary.linkedExisting += 1;
    return;
  }
  try {
    const created = await Candidate.create({
      ...data,
      ...(data.dateOfBirth ? { dateOfBirth: new Date(`${data.dateOfBirth}T00:00:00.000Z`) } : {}),
      ...(data.experience ? { experience: toDbArray("experience", data.experience) } : {}),
      verificationStatus: "INPUT_REVIEW",
      sheetSource: sourceOf(cfg, tab, rowNumber, mapped, { importedAt: new Date(), lastSyncedAt: new Date() }),
    });
    await SheetImportRow.updateOne({ _id: row._id }, { $set: { candidate: created._id, status: "IMPORTED", importedAt: new Date(), sourceHash: hash, snapshot: data, searchStatus: "REVIEW" } });
    summary.imported += 1;
  } catch (e) {
    // release the claim so the row is retried on the next sync
    await SheetImportRow.deleteOne({ _id: row._id, status: "CLAIMED" });
    throw e;
  }
};

// ---------------------------------------------------------------- listing (completeness is computed live)
const labelOf = (req) => map.clean(req?.user?.name || req?.headers?.["x-reviewer"] || req?.body?.reviewerName) || "reviewer";

const listItems = async ({ limit = 500 } = {}) => {
  const cfg = getConfig();
  const rows = await SheetImportRow.find(cfg.sheetId ? { sheetId: cfg.sheetId } : {}).sort({ rowNumber: 1, createdAt: 1 }).limit(Math.min(Number(limit) || 500, 2000)).lean();
  const cands = await Candidate.find({ _id: { $in: rows.map((r) => r.candidate).filter(Boolean) } }).lean();
  const byId = new Map(cands.map((c) => [String(c._id), c]));
  const queued = rows.filter((r) => r.searchStatus === "QUEUED").sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
  const position = new Map(queued.map((r, i) => [String(r._id), i + 1]));
  return rows.map((r) => {
    const c = byId.get(String(r.candidate));
    const completeness = c ? map.assessCompleteness(c, c.sheetSource) : null;
    return {
      id: r._id,
      rowNumber: r.rowNumber,
      jobId: r.jobId || c?.sheetSource?.jobId || null,
      candidateId: c?._id || null,
      name: c?.fullName || null,
      email: c?.email || null,
      importStatus: r.status,
      duplicateReason: r.duplicateReason || null,
      sourceDuplicateStatus: c?.sheetSource?.duplicateStatus || null,
      tenantName: c?.sheetSource?.tenantName || null,
      source: { spreadsheetId: r.sheetId, tab: r.tab || null },
      completeness,
      confirmed: Boolean(r.confirmedAt),
      confirmedAt: r.confirmedAt || null,
      confirmedBy: r.confirmedBy || null,
      incompleteOverride: Boolean(r.incompleteOverride),
      queueStatus: r.searchStatus,
      queuePosition: position.get(String(r._id)) || null,
      bgvRun: r.bgvRun || null,
      error: r.searchError || null,
      attempts: r.attempts || 0,
      searchFinishedAt: r.searchFinishedAt || null,
    };
  });
};

const getStatus = async () => {
  const cfg = getConfig();
  const [state, counts, running] = await Promise.all([
    cfg.sheetId ? SheetSyncState.findOne({ sheetId: cfg.sheetId }).lean() : null,
    SheetImportRow.find(cfg.sheetId ? { sheetId: cfg.sheetId } : {}).select("searchStatus confirmedAt").lean(),
    SheetImportRow.find({ searchStatus: "RUNNING" }).populate("candidate", "fullName").limit(3).lean(),
  ]);
  const n = (status, confirmed) => counts.filter((x) => x.searchStatus === status && (confirmed === undefined || Boolean(x.confirmedAt) === confirmed)).length;
  const queue = {
    review: n("REVIEW"),
    reviewConfirmed: n("REVIEW", true),
    queued: n("QUEUED"),
    running: n("RUNNING"),
    done: n("DONE"),
    failed: n("FAILED"),
    current: running.map((r) => ({ candidateId: r.candidate?._id || null, name: r.candidate?.fullName || null, bgvRun: r.bgvRun || null })),
  };
  queue.total = queue.review + queue.queued + queue.running + queue.done + queue.failed;
  return {
    configured: cfg.configured,
    problem: cfg.configured ? null : cfg.credError || (!cfg.sheetId ? "GOOGLE_SHEET_ID is not set" : "Service-account credentials are not set"),
    shareSheetWith: cfg.creds?.email || null,
    spreadsheetId: cfg.sheetId || null,
    tab: state?.tab || cfg.tab || null,
    pollingMinutes: cfg.pollMinutes,
    searchEnabled: cfg.searchEnabled,
    queueDelayMs: cfg.delayMs,
    queueConcurrency: cfg.concurrency,
    syncing,
    lastAttemptAt: state?.lastAttemptAt || null,
    lastSuccessAt: state?.lastSuccessAt || null,
    lastError: state?.lastError || null,
    lastSummary: state?.lastSummary || null,
    queue,
    message: queue.review > 0 ? "Candidate data imported. Please review completeness before starting searches." : null,
  };
};

// ---------------------------------------------------------------- review actions
const blocking = (a) => a.level === "INCOMPLETE" || a.invalid.length > 0;

/**
 * Confirm candidates. COMPLETE / SEARCHABLE candidates are confirmed directly.
 * INCOMPLETE ones and ones with invalid values need `acknowledgeIncomplete: true`
 * ("Search with incomplete data"); without it they are reported, not confirmed.
 */
const confirmCandidates = async ({ candidateIds, acknowledgeIncomplete = false, by = "reviewer" }) => {
  const out = { confirmed: [], needsAcknowledgement: [], notFound: [], notReviewable: [] };
  for (const id of candidateIds) {
    const row = await SheetImportRow.findOne({ candidate: id });
    if (!row) { out.notFound.push(String(id)); continue; }
    if (row.searchStatus !== "REVIEW") { out.notReviewable.push({ candidateId: String(id), status: row.searchStatus }); continue; }
    const cand = await Candidate.findById(id).lean();
    if (!cand) { out.notFound.push(String(id)); continue; }
    const a = map.assessCompleteness(cand, cand.sheetSource);
    if (blocking(a) && !acknowledgeIncomplete) {
      out.needsAcknowledgement.push({ candidateId: String(id), name: cand.fullName, level: a.level, missing: a.missing, invalid: a.invalid });
      continue;
    }
    await SheetImportRow.updateOne({ _id: row._id, searchStatus: "REVIEW" }, { $set: { confirmedAt: new Date(), confirmedBy: by, incompleteOverride: blocking(a) } });
    await Candidate.updateOne({ _id: id, verificationStatus: "INPUT_REVIEW" }, { $set: { verificationStatus: "CONFIRMED", confirmedAt: new Date() } });
    out.confirmed.push(String(id));
  }
  return out;
};

const unconfirmCandidates = async ({ candidateIds }) => {
  const r = await SheetImportRow.updateMany({ candidate: { $in: candidateIds }, searchStatus: "REVIEW" }, { $unset: { confirmedAt: 1, confirmedBy: 1 }, $set: { incompleteOverride: false } });
  return { updated: r.modifiedCount ?? r.nModified ?? 0 };
};

/** Put confirmed candidates in the queue. Unconfirmed ones can never enter. */
const startQueue = async ({ candidateIds } = {}) => {
  const cfg = getConfig();
  if (!cfg.searchEnabled) {
    const e = new Error("Searching is switched off (SHEET_SEARCH_ENABLED=false)");
    e.code = "SEARCH_DISABLED";
    throw e;
  }
  const filter = { searchStatus: "REVIEW", confirmedAt: { $exists: true } };
  if (candidateIds?.length) filter.candidate = { $in: candidateIds };
  const rows = await SheetImportRow.find(filter).sort({ rowNumber: 1 }).select("_id").lean();
  let t = Date.now();
  let queued = 0;
  for (const r of rows) {
    // atomic: only a still-REVIEW, confirmed row can be queued (no double queueing)
    const res = await SheetImportRow.updateOne({ _id: r._id, searchStatus: "REVIEW", confirmedAt: { $exists: true } }, { $set: { searchStatus: "QUEUED", queuedAt: new Date(t++), searchError: undefined } });
    if (res.modifiedCount ?? res.nModified) queued += 1;
  }
  const skippedUnconfirmed = candidateIds?.length ? await SheetImportRow.countDocuments({ candidate: { $in: candidateIds }, searchStatus: "REVIEW", confirmedAt: { $exists: false } }) : 0;
  if (queued) startWorkers();
  return { queued, skippedUnconfirmed };
};

const retryFailed = async ({ candidateIds } = {}) => {
  const cfg = getConfig();
  if (!cfg.searchEnabled) { const e = new Error("Searching is switched off (SHEET_SEARCH_ENABLED=false)"); e.code = "SEARCH_DISABLED"; throw e; }
  const filter = { searchStatus: "FAILED" };
  if (candidateIds?.length) filter.candidate = { $in: candidateIds };
  const r = await SheetImportRow.updateMany(filter, { $set: { searchStatus: "QUEUED", queuedAt: new Date(), searchError: undefined } });
  const retried = r.modifiedCount ?? r.nModified ?? 0;
  if (retried) startWorkers();
  return { retried };
};

/** Take waiting candidates out of the queue again (running ones finish). */
const cancelQueued = async ({ candidateIds } = {}) => {
  const filter = { searchStatus: "QUEUED" };
  if (candidateIds?.length) filter.candidate = { $in: candidateIds };
  const r = await SheetImportRow.updateMany(filter, { $set: { searchStatus: "REVIEW" } });
  return { cancelled: r.modifiedCount ?? r.nModified ?? 0 };
};

// ---------------------------------------------------------------- the queue (one candidate at a time)
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const workers = new Set();
const active = new Set(); // in-process guard on top of the atomic DB claim

// Reuse the existing controllers (same logging, locking, matching, evidence) instead of a second pipeline.
const callHandler = (handler, { params = {}, body = {} } = {}) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    Promise.resolve(handler({ params, body, query: {}, headers: {}, user: null }, res)).catch((e) => resolve({ status: 500, body: { message: e.message } }));
  });

const processOne = async (row) => {
  const { createBgvRun, searchBgvRun } = require("../controllers/bgvRun.controller");
  let runId = row.bgvRun;
  if (runId && !(await BgvRun.exists({ _id: runId }))) runId = null;
  if (!runId) {
    const created = await callHandler(createBgvRun, { body: { candidateId: String(row.candidate) } });
    if (created.status >= 300) throw new Error(created.body?.message || "could not create the BGV run");
    runId = created.body.data._id;
    await SheetImportRow.updateOne({ _id: row._id }, { $set: { bgvRun: runId } });
  }
  const searched = await callHandler(searchBgvRun, { params: { id: String(runId) } });
  if (searched.status >= 300) throw new Error(searched.body?.message || "search failed");
  // "done" only when the run really finished and its results are saved
  const after = await BgvRun.findById(runId).select("status error").lean();
  if (!after || ["FAILED", "SEARCHING", "MATCHING"].includes(after.status)) throw new Error(after?.error?.message || `run ended as ${after?.status || "missing"}`);
};

const workerLoop = async () => {
  for (;;) {
    const cfg = getConfig();
    if (!cfg.searchEnabled) return;
    // atomic claim: two workers can never take the same candidate
    const row = await SheetImportRow.findOneAndUpdate(
      { searchStatus: "QUEUED" },
      { $set: { searchStatus: "RUNNING", searchStartedAt: new Date(), searchError: undefined }, $inc: { attempts: 1 } },
      { sort: { queuedAt: 1 }, new: true }
    );
    if (!row) return;
    if (active.has(String(row._id))) continue;
    active.add(String(row._id));
    try {
      await processOne(row);
      await SheetImportRow.updateOne({ _id: row._id }, { $set: { searchStatus: "DONE", searchFinishedAt: new Date() } });
    } catch (e) {
      await SheetImportRow.updateOne({ _id: row._id }, { $set: { searchStatus: "FAILED", searchError: String(e.message || e).slice(0, 300), searchFinishedAt: new Date() } });
    } finally {
      active.delete(String(row._id));
    }
    await pause(cfg.delayMs);
  }
};

const startWorkers = () => {
  const want = getConfig().concurrency;
  while (workers.size < want) {
    const p = workerLoop()
      .catch((e) => console.error("[sheet-queue]", e.message))
      .finally(() => {
        workers.delete(p);
        // something queued while the worker was finishing must not be left waiting
        if (!workers.size) SheetImportRow.exists({ searchStatus: "QUEUED" }).then((x) => x && getConfig().searchEnabled && startWorkers()).catch(() => {});
      });
    workers.add(p);
  }
};
const waitIdle = async () => {
  while (workers.size) await Promise.all([...workers]);
};

/** After a restart: searches that were mid-flight go back to the queue; their half-finished run is closed as FAILED (history kept). */
const resumeQueue = async () => {
  const stuck = await SheetImportRow.find({ searchStatus: "RUNNING" }).select("_id bgvRun").lean();
  for (const r of stuck) {
    if (r.bgvRun) await BgvRun.updateOne({ _id: r.bgvRun, status: { $in: ["SEARCHING", "MATCHING"] } }, { $set: { status: "FAILED", error: { message: "Interrupted by a server restart; the search was re-queued" } } });
    await SheetImportRow.updateOne({ _id: r._id, searchStatus: "RUNNING" }, { $set: { searchStatus: "QUEUED" } });
  }
  if (getConfig().searchEnabled && (await SheetImportRow.exists({ searchStatus: "QUEUED" }))) startWorkers();
  return { requeued: stuck.length };
};

// ---------------------------------------------------------------- polling
const startAutoSync = () => {
  resumeQueue().catch((e) => console.error("[sheet-queue] resume failed:", e.message));
  const cfg = getConfig();
  if (cfg.pollMinutes <= 0 || !cfg.configured) return null;
  const tick = () =>
    syncFromSheet()
      .then((s) => (s.imported || s.updated) && console.log(`[sheet-sync] ${s.imported} new, ${s.updated} updated (nothing is searched before you confirm)`))
      .catch((e) => e.code !== "SYNC_RUNNING" && console.error("[sheet-sync] failed:", e.message));
  const timer = setInterval(tick, Math.max(cfg.pollMinutes, 1) * 60 * 1000);
  timer.unref?.();
  setTimeout(tick, 5000).unref?.();
  console.log(`[sheet-sync] polling the sheet every ${cfg.pollMinutes} min (not instant; use "Sync now" for an immediate read)`);
  return timer;
};

const _resetForTests = () => {
  tokenCache = { token: null, exp: 0, email: null };
  syncing = false;
};

module.exports = {
  syncFromSheet, getStatus, listItems, confirmCandidates, unconfirmCandidates, startQueue, retryFailed, cancelQueued,
  resumeQueue, startAutoSync, waitIdle, applySourceUpdate, sheetIdFrom, parseSheetRef, labelOf, _resetForTests,
};
