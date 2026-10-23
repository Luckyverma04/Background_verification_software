import axios from "axios";

// Set VITE_API_URL in Frontend/.env to change (e.g. for deployment)
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:5000/api",
});

// Reviewer name (no login in this app): sent with every request so verifications
// and manual additions are attributed in the audit trail.
const REVIEWER_KEY = "bgv.reviewerName";
export const getReviewerName = () => {
  try { return localStorage.getItem(REVIEWER_KEY) || ""; } catch { return ""; }
};
export const setReviewerName = (name) => {
  try { localStorage.setItem(REVIEWER_KEY, String(name || "").trim()); } catch { /* storage unavailable */ }
};
api.interceptors.request.use((config) => {
  const name = getReviewerName();
  if (name) config.headers["X-Reviewer"] = name;
  return config;
});

// Pull a readable message out of any axios error
export const errMsg = (e) =>
  e?.response?.data?.error ||
  e?.response?.data?.message ||
  e?.message ||
  "Something went wrong";

// ---- Candidates
export const getCandidates = () => api.get("/candidates").then((r) => r.data.data);
export const getCandidate = (id) => api.get(`/candidates/${id}`).then((r) => r.data.data);
export const createCandidate = (body) => api.post("/candidates", body).then((r) => r.data.data);
export const deleteCandidate = (id) => api.delete(`/candidates/${id}`);

// ---- BGV runs
export const getRuns = () => api.get("/bgv-runs").then((r) => r.data.data);
export const getRun = (id) => api.get(`/bgv-runs/${id}`).then((r) => r.data.data);
export const createRun = (candidateId) =>
  api.post("/bgv-runs", { candidateId }).then((r) => r.data.data);
// search + match can take a while (external search APIs)
export const searchRun = (id) =>
  api.post(`/bgv-runs/${id}/search`, {}, { timeout: 5 * 60 * 1000 }).then((r) => r.data.data);
export const matchRun = (id) =>
  api.post(`/bgv-runs/${id}/match`, {}, { timeout: 5 * 60 * 1000 }).then((r) => r.data.data);

// ---- Matches (human review)
export const getRelevantMatches = (runId, limit = 15, { view = "shortlist", page = 1 } = {}) =>
  api.get(`/candidate-matches/run/${runId}/relevant`, { params: { limit, view, page } }).then((r) => r.data);
export const reviewMatch = (id, reviewStatus, reviewerNotes) =>
  api.patch(`/candidate-matches/${id}`, { reviewStatus, reviewerNotes }).then((r) => r.data.data);

// ---- Per-platform discovery (each platform has its own target and counts)
export const getRunPlatforms = (runId) =>
  api.get(`/bgv-runs/${runId}/platforms`).then((r) => r.data.data);
export const getPlatformMatches = (runId, platform, { view = "shortlist", page = 1, limit } = {}) =>
  api.get(`/candidate-matches/run/${runId}/platform/${platform}`, { params: { view, page, ...(limit ? { limit } : {}) } }).then((r) => r.data);

// ---- Permanent verified identities + manual "Add profile"
export const getKnownProfiles = (runId) =>
  api.get(`/bgv-runs/${runId}/known-profiles`).then((r) => r.data.data);
// Resolves { ok, status, data, duplicate?, existing?, message }. A duplicate (409)
// is an expected answer, not an exception, so the UI can offer to open it.
export const addProfile = async (runId, body) => {
  try {
    const r = await api.post(`/bgv-runs/${runId}/profiles`, body);
    return { ok: true, status: r.status, ...r.data };
  } catch (e) {
    const d = e?.response?.data;
    if (e?.response?.status === 409 && d?.duplicate) return { ok: false, status: 409, ...d };
    throw e;
  }
};
export const revokeVerifiedIdentity = (id, reason) =>
  api.post(`/verified-identities/${id}/revoke`, { reason }).then((r) => r.data.data);

export const updateCandidate = (id, body) => api.patch(`/candidates/${id}`, body).then((r) => r.data.data);

// ---- Google Sheet import (review -> confirm -> sequential search)
export const getSheetStatus = () => api.get("/sheet-import/status").then((r) => r.data.data);
export const syncSheet = () => api.post("/sheet-import/sync", {}, { timeout: 2 * 60 * 1000 }).then((r) => r.data.data);
export const getSheetItems = () => api.get("/sheet-import/items").then((r) => r.data.data);
export const confirmSheetCandidates = (candidateIds, acknowledgeIncomplete = false) =>
  api.post("/sheet-import/confirm", { candidateIds, acknowledgeIncomplete }).then((r) => r.data.data);
export const unconfirmSheetCandidates = (candidateIds) =>
  api.post("/sheet-import/unconfirm", { candidateIds }).then((r) => r.data.data);
export const startSheetQueue = (candidateIds) => api.post("/sheet-import/queue/start", { candidateIds }).then((r) => r.data.data);
export const retrySheetFailed = (candidateIds) => api.post("/sheet-import/queue/retry", { candidateIds }).then((r) => r.data.data);
export const cancelSheetQueue = (candidateIds) => api.post("/sheet-import/queue/cancel", { candidateIds }).then((r) => r.data.data);
