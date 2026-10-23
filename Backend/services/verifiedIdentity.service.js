"use strict";

/**
 * verifiedIdentity.service.js
 *
 * The single place that reads/writes the permanent VerifiedIdentity registry.
 * Every supported verification path calls recordVerification():
 *   - reviewer approves a CandidateMatch
 *   - reviewer approves an IdentityGroup
 *   - reviewer adds a profile manually AND verifies it
 *   - one-time backfill of decisions made before the registry existed
 *
 * It reuses the existing identity architecture (it does not replace it): the
 * IdentityGroup / CandidateMatch decisions stay as they are; the registry adds
 * the persistent, candidate-linked memory that later runs consult BEFORE
 * external discovery.
 */

const mongoose = require("mongoose");

const VerifiedIdentity = require("../models/VerifiedIdentity");
const SearchResult = require("../models/SearchResult");
const CandidateMatch = require("../models/CandidateMatch");
const IdentityGroup = require("../models/IdentityGroup");
const Evidence = require("../models/Evidence");

const { canonicalProfileKey } = require("../utils/candidateUrls");
const { normalizeUrl, extractProfileIdentifier } = require("./resultMerge.service");
const { logEvent } = require("./verificationLog.service");
const signals = require("./matchSignals.service");

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());
const lower = (v) => clean(v).toLowerCase();
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v));
const toId = (v) => (v && v._id ? v._id : v);

// ---------------------------------------------------------------------
// Reviewer attribution. The app has no login yet, so a reviewer is taken from
// req.user when an auth layer exists, otherwise from the X-Reviewer header /
// body.reviewerName that the frontend sends.
// ---------------------------------------------------------------------
const reviewerFromRequest = (req) => {
  const user = req?.user || null;
  const id = user?._id || user?.id || null;
  const label =
    clean(user?.name) ||
    clean(user?.email) ||
    clean(req?.headers?.["x-reviewer"]) ||
    clean(req?.body?.reviewerName) ||
    "";
  return { id: id && isId(id) ? id : null, label: label.slice(0, 120) };
};

const fingerprintOf = (sr) => ({
  platform: clean(sr.platform).toUpperCase(),
  username: lower(sr.username),
  profileId: lower(sr.profileId),
  name: lower(sr.name),
});

const snapshotOf = (sr, match) => ({
  name: sr.name || null,
  headline: sr.headline || null,
  company: sr.company || null,
  jobTitle: sr.jobTitle || null,
  location: sr.location || null,
  education: sr.education || [],
  bio: sr.bio || null,
  title: sr.rawData?.title || null,
  snippet: sr.rawData?.snippet || null,
  profileImageUrl: sr.profileImageUrl || null,
  match: match
    ? {
        similarityScore: match.similarityScore ?? null,
        matchStatus: match.matchStatus || null,
        matchedSignals: match.matchedSignals || null,
        explanation: match.explanation || null,
      }
    : null,
  capturedAt: new Date(),
});

// ---------------------------------------------------------------------
// Write: record (or re-confirm) a verification. Idempotent and race-safe.
// ---------------------------------------------------------------------
/**
 * @param {object} p
 * @param {string} p.candidateId
 * @param {object} p.searchResult   SearchResult doc / lean object
 * @param {string} [p.bgvRunId]
 * @param {object} [p.match]        CandidateMatch (for the evidence snapshot / source id)
 * @param {string} [p.identityGroupId]
 * @param {{id,label}} [p.reviewer]
 * @param {string} p.method         MATCH_REVIEW | IDENTITY_GROUP | MANUAL_ADD | BACKFILL
 * @param {Date}   [p.verifiedAt]
 */
const recordVerification = async ({
  candidateId,
  searchResult,
  bgvRunId = null,
  match = null,
  identityGroupId = null,
  reviewer = {},
  notes = "",
  method,
  verifiedAt = new Date(),
}) => {
  const sr = searchResult?.toObject ? searchResult.toObject() : searchResult;
  const url = normalizeUrl(sr?.profileUrl) || clean(sr?.profileUrl);
  const key = canonicalProfileKey(url);
  if (!candidateId || !sr || !url || !key) return { identity: null, created: false, skipped: "NO_PROFILE_URL" };

  const ids = extractProfileIdentifier(url, sr.platform) || {};
  const username = sr.username || ids.username || undefined;
  const profileId = sr.profileId || ids.profileId || undefined;

  const evidenceRefs = sr._id
    ? (await Evidence.find({ candidate: candidateId, searchResult: sr._id }).select("_id").limit(200).lean()).map((e) => e._id)
    : [];

  const byLabel = clean(reviewer.label) || undefined;
  const by = reviewer.id || undefined;

  const filter = { candidate: candidateId, profileKey: key };
  const before = await VerifiedIdentity.findOne(filter).select("status").lean();
  const wasVerified = before?.status === "VERIFIED";

  const set = {
    platform: clean(sr.platform).toUpperCase(),
    profileUrl: url,
    profileId,
    username,
    displayName: sr.name || undefined,
    lastSeenInRun: bgvRunId || undefined,
  };
  Object.keys(set).forEach((k) => set[k] === undefined && delete set[k]);

  let update;
  if (wasVerified) {
    // already verified: do not rewrite who/when/evidence of the original decision
    update = { $set: set };
  } else {
    update = {
      $set: {
        ...set,
        status: "VERIFIED",
        verifiedAt,
        verifiedBy: by,
        verifiedByLabel: byLabel,
        verificationMethod: method,
        reviewerNotes: clean(notes) || undefined,
        sourceSearchResult: sr._id,
        sourceCandidateMatch: match?._id || undefined,
        sourceIdentityGroup: identityGroupId || undefined,
        evidenceSnapshot: snapshotOf(sr, match),
        evidenceRefs,
        fingerprint: fingerprintOf({ ...sr, username, profileId }),
        "needsReReview.flag": false,
      },
      $setOnInsert: { firstVerifiedInRun: bgvRunId || undefined },
      $push: {
        history: {
          at: verifiedAt,
          action: before ? "RE_VERIFIED" : "VERIFIED",
          by,
          byLabel,
          method,
          bgvRun: bgvRunId || undefined,
          note: clean(notes) || undefined,
        },
      },
    };
    for (const k of Object.keys(update.$set)) if (update.$set[k] === undefined) delete update.$set[k];
    if (!update.$setOnInsert.firstVerifiedInRun) delete update.$setOnInsert.firstVerifiedInRun;
    if (!Object.keys(update.$setOnInsert).length) delete update.$setOnInsert;
  }

  const opts = { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true };
  let identity;
  let alreadyVerified = wasVerified;
  if (wasVerified) {
    identity = await VerifiedIdentity.findOneAndUpdate(filter, update, { ...opts, upsert: false });
    if (!identity) {
      // revoked in between: fall through to a fresh verification below
      alreadyVerified = false;
    }
  }
  if (!identity) {
    // Atomic claim: only a row that is NOT currently VERIFIED matches. Of N
    // parallel requests exactly one writes the verification (and its single
    // history entry); the others hit the unique index (E11000) and merely
    // refresh the non-audit fields of the row that won.
    const claimUpdate = wasVerified ? { $set: set } : update;
    try {
      identity = await VerifiedIdentity.findOneAndUpdate({ ...filter, status: { $ne: "VERIFIED" } }, claimUpdate, opts);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      alreadyVerified = true;
      identity = await VerifiedIdentity.findOneAndUpdate(filter, { $set: set }, { ...opts, upsert: false });
    }
  }
  return { identity, created: !before && !alreadyVerified, reverified: Boolean(before) && !wasVerified && !alreadyVerified, alreadyVerified };
};

/**
 * Withdraw a verification (reviewer rejected / un-did it). The row is kept,
 * with the revocation in its history.
 */
const revokeVerification = async ({ candidateId, profileUrl, identityId = null, reviewer = {}, reason = "", bgvRunId = null, onlyIfSourceGroup = null }) => {
  const filter = identityId
    ? { _id: identityId, candidate: candidateId }
    : { candidate: candidateId, profileKey: canonicalProfileKey(profileUrl) };
  if (!identityId && !filter.profileKey) return null;
  filter.status = "VERIFIED";
  if (onlyIfSourceGroup) filter.sourceIdentityGroup = onlyIfSourceGroup;

  return VerifiedIdentity.findOneAndUpdate(
    filter,
    {
      $set: { status: "REVOKED" },
      $push: {
        history: {
          at: new Date(),
          action: "REVOKED",
          by: reviewer.id || undefined,
          byLabel: clean(reviewer.label) || undefined,
          bgvRun: bgvRunId || undefined,
          note: clean(reason) || undefined,
        },
      },
    },
    { new: true }
  );
};

// ---------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------
const getVerifiedForCandidate = async (candidateId, { includeRevoked = false } = {}) =>
  VerifiedIdentity.find({ candidate: candidateId, ...(includeRevoked ? {} : { status: "VERIFIED" }) })
    .sort({ verifiedAt: -1 })
    .lean();

const getVerifiedKeyMap = async (candidateId) => {
  const rows = await getVerifiedForCandidate(candidateId);
  return new Map(rows.map((r) => [r.profileKey, r]));
};

// ---------------------------------------------------------------------
// Backfill: decisions that were made BEFORE the registry existed
// (APPROVED matches / groups of this candidate). Lazy, idempotent and cheap.
// ---------------------------------------------------------------------
const backfillFromHistory = async (candidate) => {
  const candidateId = candidate._id;
  let imported = 0;

  const matches = await CandidateMatch.find({ candidate: candidateId, reviewStatus: "APPROVED" })
    .populate("searchResult")
    .sort({ reviewedAt: 1 })
    .limit(500)
    .lean();

  const known = await getVerifiedKeyMap(candidateId);
  const revoked = new Set(
    (await VerifiedIdentity.find({ candidate: candidateId, status: "REVOKED" }).select("profileKey").lean()).map((r) => r.profileKey)
  );

  for (const m of matches) {
    const sr = m.searchResult;
    const key = sr?.profileUrl ? canonicalProfileKey(sr.profileUrl) : null;
    // a revoked identity stays revoked: backfill must not undo a withdrawal
    if (!key || known.has(key) || revoked.has(key)) continue;
    const r = await recordVerification({
      candidateId,
      searchResult: sr,
      bgvRunId: m.bgvRun,
      match: m,
      reviewer: { id: m.reviewedBy, label: "" },
      notes: m.reviewerNotes,
      method: "BACKFILL",
      verifiedAt: m.reviewedAt || m.updatedAt || new Date(),
    });
    if (r.identity) {
      known.set(key, r.identity);
      imported += 1;
    }
  }

  const groups = await IdentityGroup.find({ candidate: candidateId, reviewStatus: "APPROVED" })
    .populate("searchResults")
    .limit(200)
    .lean();
  for (const g of groups) {
    for (const sr of g.searchResults || []) {
      const key = sr?.profileUrl ? canonicalProfileKey(sr.profileUrl) : null;
      if (!key || known.has(key) || revoked.has(key)) continue;
      const r = await recordVerification({
        candidateId,
        searchResult: sr,
        bgvRunId: g.bgvRun,
        identityGroupId: g._id,
        reviewer: { id: g.reviewedBy, label: "" },
        notes: g.reviewerNotes,
        method: "BACKFILL",
        verifiedAt: g.reviewedAt || g.updatedAt || new Date(),
      });
      if (r.identity) {
        known.set(key, r.identity);
        imported += 1;
      }
    }
  }
  return { imported };
};

// ---------------------------------------------------------------------
// Material-change check: is the profile that was found now still the
// identity the reviewer confirmed? Missing data is UNKNOWN, never a change.
// ---------------------------------------------------------------------
const assessChange = (fingerprint, found) => {
  const reasons = [];
  if (!fingerprint || !found) return reasons;
  const fp = fingerprint;

  if (fp.platform && found.platform && fp.platform !== clean(found.platform).toUpperCase()) reasons.push("PLATFORM_CHANGED");
  const u = lower(found.username);
  if (fp.username && u && fp.username !== u) reasons.push("USERNAME_CHANGED");
  const pid = lower(found.profileId);
  if (fp.profileId && pid && fp.profileId !== pid) reasons.push("PROFILE_ID_CHANGED");
  if (fp.name && clean(found.name)) {
    try {
      if (signals.compareNames(fp.name, found.name).state === "MISMATCH") reasons.push("DISPLAY_NAME_CHANGED");
    } catch (e) {
      /* name check is best effort */
    }
  }
  return reasons;
};

const flagForReReview = async ({ identityId, reasons, bgvRunId }) => {
  if (!identityId || !reasons?.length) return null;
  return VerifiedIdentity.findOneAndUpdate(
    { _id: identityId, status: "VERIFIED" },
    {
      $set: { "needsReReview.flag": true, "needsReReview.reasons": reasons, "needsReReview.detectedAt": new Date(), "needsReReview.bgvRun": bgvRunId },
      $push: { history: { at: new Date(), action: "FLAGGED_FOR_REVIEW", bgvRun: bgvRunId, note: reasons.join(", ") } },
    },
    { new: true }
  );
};

// ---------------------------------------------------------------------
// At the START of a run: load the registry and make sure each verified profile
// exists in the run as a "Previously Verified" result (no external call, no
// re-enrichment). Returns seeds for discovery.
// ---------------------------------------------------------------------
const applyVerifiedToRun = async ({ candidate, bgvRunId }) => {
  const out = {
    backfilled: 0,
    loaded: 0,
    created: 0,
    alreadyPresent: 0,
    profileUrls: [],
    usernames: [],
    platforms: [],
    keys: [],
    identities: [],
  };

  try {
    out.backfilled = (await backfillFromHistory(candidate)).imported;
  } catch (error) {
    console.error("Verified identity backfill failed (continuing):", error.message);
  }

  const identities = await getVerifiedForCandidate(candidate._id);
  out.loaded = identities.length;
  if (!identities.length) return out;

  // newest source row per identity supplies the stored public data to reuse
  const sourceIds = identities.map((i) => i.sourceSearchResult).filter(Boolean);
  const sources = sourceIds.length ? await SearchResult.find({ _id: { $in: sourceIds } }).lean() : [];
  const sourceById = new Map(sources.map((s) => [String(s._id), s]));

  for (const idn of identities) {
    const src = sourceById.get(String(idn.sourceSearchResult)) || {};
    const snap = idn.evidenceSnapshot || {};
    out.profileUrls.push(idn.profileUrl);
    out.keys.push(idn.profileKey);
    out.platforms.push(idn.platform);
    if (idn.username) out.usernames.push(idn.username);
    out.identities.push(String(idn._id));

    const verifiedInfo = {
      identityId: idn._id,
      verifiedAt: idn.verifiedAt,
      verifiedBy: idn.verifiedBy || null,
      verifiedByLabel: idn.verifiedByLabel || null,
      method: idn.verificationMethod,
      fingerprint: idn.fingerprint || null,
      needsReReview: Boolean(idn.needsReReview?.flag),
    };

    const existing = await SearchResult.findOne({ bgvRun: bgvRunId, profileUrl: idn.profileUrl }).select("_id rawData.verifiedIdentity").lean();
    if (existing) {
      out.alreadyPresent += 1;
      if (!existing.rawData?.verifiedIdentity) {
        await SearchResult.updateOne({ _id: existing._id }, { $set: { "rawData.verifiedIdentity": verifiedInfo } });
      }
      continue;
    }

    try {
      await SearchResult.create({
        bgvRun: bgvRunId,
        platform: idn.platform,
        profileUrl: idn.profileUrl,
        profileId: idn.profileId,
        username: idn.username,
        name: src.name || snap.name || idn.displayName,
        headline: src.headline || snap.headline || undefined,
        bio: src.bio || snap.bio || undefined,
        company: src.company || snap.company || undefined,
        jobTitle: src.jobTitle || snap.jobTitle || undefined,
        location: src.location || snap.location || undefined,
        education: src.education?.length ? src.education : snap.education,
        previousEmployers: src.previousEmployers,
        linkedProfiles: src.linkedProfiles,
        profileImageUrl: src.profileImageUrl || snap.profileImageUrl || undefined,
        profileImageUrls: src.profileImageUrls || [],
        // stored enrichment is carried over so the profile is not fetched again
        enrichment: src.enrichment ? { ...src.enrichment, reusedFromVerifiedIdentity: idn._id } : undefined,
        source: "KNOWLEDGE_BASE",
        searchProvider: "OTHER",
        sourceUrl: idn.profileUrl,
        rawData: {
          providers: [],
          providerResultIds: [],
          providerResults: [],
          title: snap.title || src.rawData?.title || null,
          snippet: snap.snippet || src.rawData?.snippet || null,
          verifiedIdentity: verifiedInfo,
        },
      });
      out.created += 1;
    } catch (error) {
      if (error?.code === 11000) out.alreadyPresent += 1;
      else throw error;
    }
  }

  await VerifiedIdentity.updateMany({ _id: { $in: identities.map((i) => i._id) } }, { $set: { lastSeenInRun: bgvRunId } });
  out.platforms = [...new Set(out.platforms)];
  out.usernames = [...new Set(out.usernames)];
  return out;
};

/**
 * Called by matching: for every result of the run that is a verified profile
 * of THIS candidate, decide whether it stays "Previously Verified" (apply the
 * stored verification) or must go back to a human (material change).
 * Returns Map(searchResultId -> { identity, reasons })
 */
const assessRunResults = async ({ candidateId, searchResults }) => {
  const map = await getVerifiedKeyMap(candidateId);
  const out = new Map();
  if (!map.size) return out;

  for (const sr of searchResults) {
    const key = sr.profileUrl ? canonicalProfileKey(sr.profileUrl) : null;
    const idn = key ? map.get(key) : null;
    if (!idn) continue;

    const reasons = [];
    // a change seen when the profile was rediscovered (see saveNewResults)
    const seen = sr.rawData?.identityChange?.reasons;
    if (Array.isArray(seen)) reasons.push(...seen);
    reasons.push(...assessChange(idn.fingerprint, sr).filter((r) => !reasons.includes(r)));
    out.set(String(sr._id), { identity: idn, reasons });
  }
  return out;
};

module.exports = {
  reviewerFromRequest,
  recordVerification,
  revokeVerification,
  getVerifiedForCandidate,
  getVerifiedKeyMap,
  backfillFromHistory,
  assessChange,
  flagForReReview,
  applyVerifiedToRun,
  assessRunResults,
  fingerprintOf,
  logEvent,
};
