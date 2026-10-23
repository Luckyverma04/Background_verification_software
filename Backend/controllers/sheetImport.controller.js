"use strict";
const svc = require("../services/sheetImport.service");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const fail = (res, e) => {
  if (!e.code) console.error("[sheet-import]", e.message);
  const status = { SHEET_CONFIG: 400, SEARCH_DISABLED: 409, SYNC_RUNNING: 409, SHEET_FETCH: 502 }[e.code] || 500;
  return res.status(status).json({ success: false, message: status === 500 ? "Sheet import failed" : e.message });
};
const ids = (req) => (Array.isArray(req.body?.candidateIds) ? req.body.candidateIds.filter(Boolean).map(String) : []);
const wrap = (fn) => async (req, res) => { try { return ok(res, await fn(req)); } catch (e) { return fail(res, e); } };

exports.status = wrap(() => svc.getStatus());
exports.sync = wrap(() => svc.syncFromSheet());
exports.items = wrap((req) => svc.listItems({ limit: req.query.limit }));
exports.confirm = wrap((req) => {
  if (!ids(req).length) { const e = new Error("candidateIds is required"); e.code = "SHEET_CONFIG"; throw e; }
  return svc.confirmCandidates({ candidateIds: ids(req), acknowledgeIncomplete: req.body?.acknowledgeIncomplete === true, by: svc.labelOf(req) });
});
exports.unconfirm = wrap((req) => svc.unconfirmCandidates({ candidateIds: ids(req) }));
exports.startQueue = wrap((req) => svc.startQueue({ candidateIds: ids(req) }));
exports.retry = wrap((req) => svc.retryFailed({ candidateIds: ids(req) }));
exports.cancel = wrap((req) => svc.cancelQueued({ candidateIds: ids(req) }));
