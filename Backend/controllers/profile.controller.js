const mongoose = require("mongoose");

const BgvRun = require("../models/BgvRun");
const Candidate = require("../models/Candidate");
const SearchResult = require("../models/SearchResult");
const CandidateMatch = require("../models/CandidateMatch");
const VerifiedIdentity = require("../models/VerifiedIdentity");

const { isValidId, sendError } = require("../utils/http");
const { canonicalProfileKey, withProtocol } = require("../utils/candidateUrls");
const { normalizeUrl, detectPlatform, extractProfileIdentifier } = require("../services/resultMerge.service");
const { isSafePublicUrl } = require("../services/profileImage.service");
const { hasProfileUrlShape } = require("../services/platformDiscovery.service");
const { PLATFORM_KEYS } = require("../utils/platforms");
const { createMatchForResult, createMatchesForBgvRun } = require("../services/candidateMatch.service");
const { logEvent } = require("../services/verificationLog.service");
const { recomputeFinalResult } = require("../services/finalResult.service");
const verifiedIdentities = require("../services/verifiedIdentity.service");

const SUPPORTED = new Set([...PLATFORM_KEYS, "WEBSITE", "OTHER"]);
const MODES = ["REVIEW", "VERIFIED"];

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// A trimmed view of a match that the review cards can render.
const cardOf = (m) => {
  const sr = m.searchResult && typeof m.searchResult === "object" ? m.searchResult : {};
  const { rawData, ...rest } = sr;
  return {
    ...m,
    searchResult: {
      ...rest,
      rawData: rawData
        ? {
            title: rawData.title || null,
            snippet: rawData.snippet || null,
            knowledgeBase: rawData.knowledgeBase || undefined,
            verifiedIdentity: rawData.verifiedIdentity || undefined,
            manual: rawData.manual || undefined,
            identityChange: rawData.identityChange || undefined,
          }
        : undefined,
    },
  };
};

const populatedMatch = (id) =>
  CandidateMatch.findById(id).populate("searchResult").lean().then((m) => (m ? cardOf(m) : null));

// ======================================================
// POST /api/bgv-runs/:id/profiles  - reviewer adds a profile by hand
// ======================================================
const addProfileToRun = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return sendError(res, 400, "Invalid BGV run ID", null, { received: id });

    const run = await BgvRun.findById(id);
    if (!run) return sendError(res, 404, "BGV run not found");
    const candidate = await Candidate.findById(run.candidate);
    if (!candidate) return sendError(res, 404, "Candidate not found");

    const body = req.body || {};

    // The run belongs to exactly one candidate: a different one is refused.
    if (body.candidateId !== undefined && body.candidateId !== null && body.candidateId !== "" && String(body.candidateId) !== String(candidate._id)) {
      return sendError(res, 400, "BGV run does not belong to this candidate");
    }

    const mode = String(body.mode || "REVIEW").toUpperCase();
    if (!MODES.includes(mode)) return sendError(res, 400, `mode must be one of: ${MODES.join(", ")}`);

    // ---- URL
    const rawUrl = text(body.profileUrl, 500);
    if (!rawUrl) return sendError(res, 400, "profileUrl is required");
    if (/\s/.test(rawUrl)) return sendError(res, 400, "profileUrl must be a single URL");
    const prefixed = withProtocol(rawUrl);
    let parsed;
    try {
      parsed = new URL(prefixed);
    } catch (e) {
      return sendError(res, 400, "profileUrl is not a valid URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname.includes(".")) {
      return sendError(res, 400, "profileUrl must be a public http(s) URL");
    }
    if (!isSafePublicUrl(prefixed)) return sendError(res, 400, "profileUrl must point to a public website");
    const profileUrl = normalizeUrl(prefixed);
    const key = canonicalProfileKey(profileUrl || prefixed);
    if (!profileUrl || !key) return sendError(res, 400, "profileUrl could not be normalised");

    // ---- platform
    const requested = text(body.platform, 40).toUpperCase();
    if (requested && !SUPPORTED.has(requested)) {
      return sendError(res, 400, `Unsupported platform "${requested}"`, null, { supported: [...SUPPORTED] });
    }
    const detected = detectPlatform(profileUrl);
    let platform = requested || detected;
    if (requested && PLATFORM_KEYS.includes(requested) && detected !== requested) {
      return sendError(res, 400, `The URL belongs to ${detected}, not ${requested}`, null, { detected });
    }
    if (!requested && (detected === "WEBSITE" || detected === "OTHER")) {
      return sendError(res, 400, "This website is not a supported platform. Choose platform WEBSITE or OTHER explicitly.", null, { detected });
    }
    if (PLATFORM_KEYS.includes(platform) && !hasProfileUrlShape(profileUrl, platform) && body.allowNonProfileUrl !== true) {
      return sendError(res, 400, `This URL does not look like a ${platform} profile page (it may be a search, post or repository). Check the link, or confirm it is a profile.`, null, { code: "NOT_PROFILE_SHAPED" });
    }

    // ---- reviewer (explicit verification must be attributable)
    const reviewer = verifiedIdentities.reviewerFromRequest(req);
    if (mode === "VERIFIED" && !reviewer.label && !reviewer.id) {
      return sendError(res, 400, "reviewerName is required to save a profile as verified");
    }

    const ids = extractProfileIdentifier(profileUrl, platform) || {};
    const username = text(body.username, 100).replace(/^@/, "") || ids.username || undefined;
    const profileId = text(body.profileId, 200) || ids.profileId || undefined;
    const displayName = text(body.displayName, 200) || undefined;
    const notes = text(body.notes, 2000);
    const evidenceSource = text(body.evidenceSource, 500);

    // ---- duplicate? (same normalized profile for this candidate)
    const inRun = await SearchResult.find({ bgvRun: run._id, profileUrl: { $exists: true, $ne: null } }).select("_id profileUrl").lean();
    const dup = inRun.find((r) => canonicalProfileKey(r.profileUrl) === key);
    const duplicateResponse = async (srId) => {
      const match = await CandidateMatch.findOne({ bgvRun: run._id, searchResult: srId }).select("_id reviewStatus").lean();
      const verified = await VerifiedIdentity.findOne({ candidate: candidate._id, profileKey: key, status: "VERIFIED" }).select("_id verifiedAt").lean();
      return res.status(409).json({
        success: false,
        duplicate: true,
        message: "This profile is already in the current results.",
        existing: { searchResultId: srId, candidateMatchId: match?._id || null, reviewStatus: match?.reviewStatus || null, verified: Boolean(verified) },
      });
    };
    if (dup) return duplicateResponse(dup._id);

    // ---- already verified earlier (other run) but not in this run: bring it in
    const registered = await VerifiedIdentity.findOne({ candidate: candidate._id, profileKey: key, status: "VERIFIED" }).lean();
    if (registered) {
      await verifiedIdentities.applyVerifiedToRun({ candidate, bgvRunId: run._id });
      const sr = await SearchResult.findOne({ bgvRun: run._id, profileUrl: registered.profileUrl }).lean();
      if (sr) {
        // the run-level matcher applies the registry (Previously Verified)
        await createMatchesForBgvRun({ candidateId: candidate._id, bgvRunId: run._id });
        const match = await CandidateMatch.findOne({ bgvRun: run._id, searchResult: sr._id });
        await BgvRun.updateOne({ _id: run._id }, { $inc: { totalSearchResults: 1 } });
        return res.status(200).json({
          success: true,
          alreadyVerified: true,
          message: "This profile was already verified for this candidate earlier. It is now in the current results as Previously Verified.",
          data: { searchResult: sr, candidateMatch: await populatedMatch(match._id) },
        });
      }
    }

    // ---- create the result
    let searchResult;
    try {
      searchResult = await SearchResult.create({
        bgvRun: run._id,
        platform,
        profileUrl,
        profileId,
        username,
        name: displayName,
        source: "MANUAL",
        searchProvider: "MANUAL",
        sourceUrl: profileUrl,
        rawData: {
          providers: ["MANUAL"],
          providerResultIds: [],
          providerResults: [{ manual: true, url: profileUrl }],
          title: displayName || null,
          snippet: null,
          // reviewer-supplied context: kept for the audit trail, deliberately
          // NOT fed to the matcher as if it were independent evidence
          manual: {
            addedAt: new Date(),
            addedBy: reviewer.id || null,
            addedByLabel: reviewer.label || null,
            notes: notes || null,
            evidenceSource: evidenceSource || null,
            requestedMode: mode,
          },
        },
      });
    } catch (error) {
      if (error && error.code === 11000) {
        const existing = await SearchResult.findOne({ bgvRun: run._id, profileUrl }).select("_id").lean();
        if (existing) return duplicateResponse(existing._id);
      }
      throw error;
    }

    await BgvRun.updateOne({ _id: run._id }, { $inc: { totalSearchResults: 1 } });

    // same matcher as discovered profiles (idempotent per run + result)
    let match = await createMatchForResult({ candidate, bgvRun: run, searchResult });

    let identity = null;
    if (mode === "VERIFIED") {
      // explicit reviewer verification: compare-and-set so a parallel request
      // cannot double-apply it
      await CandidateMatch.updateOne(
        { _id: match._id, reviewStatus: "PENDING" },
        { $set: { reviewStatus: "APPROVED", reviewedAt: new Date(), reviewerNotes: notes || "Added and verified manually", ...(reviewer.id ? { reviewedBy: reviewer.id } : {}) } }
      );
      const fresh = await CandidateMatch.findById(match._id).lean();
      const recorded = await verifiedIdentities.recordVerification({
        candidateId: candidate._id,
        searchResult,
        bgvRunId: run._id,
        match: fresh,
        reviewer,
        notes: [notes, evidenceSource && `Source: ${evidenceSource}`].filter(Boolean).join(" | "),
        method: "MANUAL_ADD",
      });
      identity = recorded.identity;

      await logEvent({
        bgvRun: run._id,
        candidate: candidate._id,
        action: "PROFILE_APPROVED",
        previousStatus: "PENDING",
        newStatus: "APPROVED",
        description: `${platform} ${profileUrl} added manually and verified by ${reviewer.label || "reviewer"}`,
        performedBy: reviewer.id || undefined,
        metadata: { manual: true, candidateMatch: match._id, searchResult: searchResult._id, platform, profileUrl, notes: notes || null, evidenceSource: evidenceSource || null, reviewerLabel: reviewer.label || null },
        idempotencyKey: `manual-verified:${run._id}:${key}`,
      });
      await recomputeFinalResult(run._id, { performedBy: reviewer.id || undefined });
    } else {
      await logEvent({
        bgvRun: run._id,
        candidate: candidate._id,
        action: "STATUS_CHANGED",
        newStatus: "PENDING",
        description: `${platform} ${profileUrl} added manually for review${reviewer.label ? ` by ${reviewer.label}` : ""}`,
        performedBy: reviewer.id || undefined,
        metadata: { manual: true, candidateMatch: match._id, searchResult: searchResult._id, platform, profileUrl, notes: notes || null, evidenceSource: evidenceSource || null },
        idempotencyKey: `manual-added:${run._id}:${key}`,
      });
    }

    return res.status(201).json({
      success: true,
      message: mode === "VERIFIED" ? "Profile added and verified." : "Profile added for review.",
      data: {
        mode,
        searchResult: searchResult.toObject(),
        candidateMatch: await populatedMatch(match._id),
        verifiedIdentity: identity,
      },
    });
  } catch (error) {
    console.error("Add profile error:", error);
    return sendError(res, 500, "Failed to add profile", error);
  }
};

// ======================================================
// GET /api/bgv-runs/:id/known-profiles
// Profiles shown apart from newly discovered results:
//   previouslyVerified - registry identities present in this run
//   addedByReviewer    - profiles a reviewer added by hand
//   registry           - the candidate's whole verified registry
// ======================================================
const getKnownProfiles = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    const run = await BgvRun.findById(id).lean();
    if (!run) return sendError(res, 404, "BGV run not found");

    const results = await SearchResult.find({
      bgvRun: run._id,
      $or: [{ "rawData.verifiedIdentity": { $exists: true } }, { "rawData.manual": { $exists: true } }],
    })
      .select("_id")
      .lean();

    const matches = results.length
      ? await CandidateMatch.find({ bgvRun: run._id, searchResult: { $in: results.map((r) => r._id) } })
          .populate("searchResult")
          .sort({ createdAt: 1 })
          .lean()
      : [];

    const cards = matches.map(cardOf);
    const isPrev = (m) => Boolean(m.matchDetails?.previouslyVerified);
    const registry = await VerifiedIdentity.find({ candidate: run.candidate, status: "VERIFIED" })
      .sort({ verifiedAt: -1 })
      .select("-evidenceSnapshot")
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        previouslyVerified: cards.filter(isPrev),
        // verified earlier but changed materially: needs a human again
        needsReReview: cards.filter((m) => m.matchDetails?.needsReReview),
        addedByReviewer: cards.filter((m) => m.searchResult?.rawData?.manual),
        registry,
      },
    });
  } catch (error) {
    console.error("Known profiles error:", error);
    return sendError(res, 500, "Failed to load known profiles", error);
  }
};

// ======================================================
// GET /api/verified-identities?candidate=ID[&includeRevoked=true]
// ======================================================
const listVerifiedIdentities = async (req, res) => {
  try {
    const { candidate, includeRevoked } = req.query || {};
    if (!candidate || !isValidId(candidate)) return sendError(res, 400, "A valid candidate query parameter is required");
    const rows = await verifiedIdentities.getVerifiedForCandidate(candidate, { includeRevoked: includeRevoked === "true" });
    return res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    return sendError(res, 500, "Failed to load verified identities", error);
  }
};

// ======================================================
// POST /api/verified-identities/:id/revoke  { reason, reviewerName }
// Withdraws a verification. The row and its history are kept.
// ======================================================
const revokeVerifiedIdentity = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return sendError(res, 400, "Invalid identity ID");
    const reason = text(req.body?.reason, 1000);
    if (reason.length < 3) return sendError(res, 400, "A reason is required to revoke a verification");
    const existing = await VerifiedIdentity.findById(id).lean();
    if (!existing) return sendError(res, 404, "Verified identity not found");
    if (existing.status === "REVOKED") return res.status(200).json({ success: true, message: "Already revoked", data: existing });

    const revoked = await verifiedIdentities.revokeVerification({
      candidateId: existing.candidate,
      identityId: existing._id,
      reviewer: verifiedIdentities.reviewerFromRequest(req),
      reason,
    });
    return res.status(200).json({ success: true, message: "Verification revoked", data: revoked });
  } catch (error) {
    return sendError(res, 500, "Failed to revoke verification", error);
  }
};

module.exports = { addProfileToRun, getKnownProfiles, listVerifiedIdentities, revokeVerifiedIdentity };
