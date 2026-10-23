const mongoose = require("mongoose");

const verifiedIdentities = require("../services/verifiedIdentity.service");
const CandidateMatch = require("../models/CandidateMatch");
const BgvRun = require("../models/BgvRun");
const { PLATFORM_KEYS } = require("../utils/platforms");
const Candidate = require("../models/Candidate");
const SearchResult = require("../models/SearchResult");

const {
  getTopRelevantMatches,
  HARD_MAX_SHORTLIST,
} = require("../services/candidateMatchRanking.service");

const { logEvent } = require("../services/verificationLog.service");
const { recomputeFinalResult } = require("../services/finalResult.service");
const { sendError } = require("../utils/http");

const REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"];


// ======================================================
// CREATE CANDIDATE MATCH
// ======================================================

const createCandidateMatch = async (req, res) => {
  try {
    const {
      bgvRun,
      candidate,
      searchResult,
    } = req.body;

    console.log("CANDIDATE MATCH BODY:", req.body);

    if (!bgvRun || !candidate || !searchResult) {
      return res.status(400).json({
        success: false,
        message:
          "bgvRun, candidate and searchResult are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(bgvRun)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRun,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(candidate)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Candidate ID",
        received: candidate,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(searchResult)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Search Result ID",
        received: searchResult,
      });
    }

    const run = await BgvRun.findById(bgvRun);

    if (!run) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
      });
    }

    const candidateData = await Candidate.findById(candidate);

    if (!candidateData) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      });
    }

    const searchResultData =
      await SearchResult.findById(searchResult);

    if (!searchResultData) {
      return res.status(404).json({
        success: false,
        message: "Search result not found",
      });
    }

    if (
      String(searchResultData.bgvRun) !==
      String(bgvRun)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Search result does not belong to this BGV run",
      });
    }

    const match = await CandidateMatch.create(req.body);

    await BgvRun.findByIdAndUpdate(bgvRun, {
      $inc: {
        matchedResults: 1,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Candidate match created successfully",
      data: match,
    });
  } catch (error) {
    console.error(
      "Create candidate match error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to create candidate match",
      error: error.message,
    });
  }
};


// ======================================================
// GET ALL CANDIDATE MATCHES
// ======================================================

const getAllCandidateMatches = async (req, res) => {
  try {
    const matches = await CandidateMatch.find()
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResult")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Candidate matches fetched successfully",
      count: matches.length,
      data: matches,
    });
  } catch (error) {
    console.error(
      "Get candidate matches error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch candidate matches",
      error: error.message,
    });
  }
};


// ======================================================
// GET MATCHES BY BGV RUN
// PAGINATION
// ======================================================

const getMatchesByBgvRun = async (req, res) => {
  try {
    const { bgvRunId } = req.params;

    // ----------------------------------------------
    // Validate BGV Run ID
    // ----------------------------------------------

    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    // ----------------------------------------------
    // Check BGV Run exists
    // ----------------------------------------------

    const run = await BgvRun.findById(bgvRunId);

    if (!run) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
      });
    }

    // ----------------------------------------------
    // Pagination
    // ----------------------------------------------

    const page = Math.max(
      parseInt(req.query.page) || 1,
      1
    );

    const limit = Math.min(
      Math.max(
        parseInt(req.query.limit) || 15,
        1
      ),
      50
    );

    const skip = (page - 1) * limit;

    // ----------------------------------------------
    // Fetch matches + total count
    // ----------------------------------------------

    const [matches, total] = await Promise.all([
      CandidateMatch.find({
        bgvRun: bgvRunId,
      })
        .populate("candidate")
        .populate("searchResult")
        .sort({
          similarityScore: -1,
          createdAt: -1,
        })
        .skip(skip)
        .limit(limit),

      CandidateMatch.countDocuments({
        bgvRun: bgvRunId,
      }),
    ]);

    const totalPages = Math.ceil(
      total / limit
    );

    return res.status(200).json({
      success: true,
      message:
        "BGV run candidate matches fetched successfully",

      data: matches,

      pagination: {
        page,
        limit,
        total,
        totalPages,

        hasNextPage:
          page < totalPages,

        hasPreviousPage:
          page > 1,
      },
    });
  } catch (error) {
    console.error(
      "Get matches by BGV run error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch BGV run candidate matches",
      error: error.message,
    });
  }
};


// ======================================================
// GET RANKED PROFILES OF ONE PLATFORM
// GET /api/candidate-matches/run/:bgvRunId/platform/:platform
// Capped by the per-platform target (default 15) - separate from the
// 15-profile human-review shortlist. Fewer are returned when fewer are
// genuinely relevant (no padding).
// ======================================================
const getPlatformMatchesForReview = async (req, res) => {
  try {
    const { bgvRunId } = req.params;
    const platform = String(req.params.platform || "").toUpperCase();

    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({ success: false, message: "Invalid BGV Run ID" });
    }

    if (!PLATFORM_KEYS.includes(platform)) {
      return res.status(400).json({ success: false, message: "Unknown platform", platform });
    }

    if (!(await BgvRun.exists({ _id: bgvRunId }))) {
      return res.status(404).json({ success: false, message: "BGV run not found" });
    }

    const target = Math.max(Number(process.env.PLATFORM_DISCOVERY_TARGET) || 15, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || target, 1), 50);
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    const view = req.query.view === "excluded" ? "excluded" : "shortlist";
    const result = await getTopRelevantMatches({ bgvRunId, limit, page, platform, view });

    return res.status(200).json({
      success: true,
      view,
      counts: result.counts,
      excludedByReason: result.excludedByReason,
      platform,
      target,
      returned: result.data.length,
      shortfall: Math.max(target - result.totalBeforeCap, 0),
      relevantFound: result.platformBreakdown?.[platform]?.relevant || 0,
      pagination: result.pagination,
      data: result.data,
    });
  } catch (error) {
    console.error("Get platform matches error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch platform matches",
    });
  }
};


// ======================================================
// GET TOP RELEVANT MATCHES
// HUMAN REVIEW
// ======================================================

const getTopRelevantMatchesForReview = async (
  req,
  res
) => {
  try {
    const { bgvRunId } = req.params;

    // ----------------------------------------------
    // Validate BGV Run ID
    // ----------------------------------------------

    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    // ----------------------------------------------
    // Check BGV Run exists
    // ----------------------------------------------

    const run = await BgvRun.findById(bgvRunId);

    if (!run) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
      });
    }

    // ----------------------------------------------
    // Shortlist: at most 15 profiles by default.
    // `?all=true` lists everything (paginated, page size max 50).
    // ----------------------------------------------

    const showAll = req.query.all === "true";
    const view = req.query.view === "excluded" ? "excluded" : "shortlist";

    const limit = Math.min(
      Math.max(parseInt(req.query.limit) || HARD_MAX_SHORTLIST, 1),
      showAll || view === "excluded" ? 50 : HARD_MAX_SHORTLIST
    );

    const page = Math.max(
      parseInt(req.query.page) || 1,
      1
    );

    const result = await getTopRelevantMatches({
      bgvRunId,
      limit,
      page,
      showAll,
      view,
    });

    return res.status(200).json({
      success: true,

      message:
        "Top relevant candidate matches fetched successfully",

      view,

      counts: result.counts,

      excludedByReason: result.excludedByReason,

      totalMatches: result.totalMatches,

      eligibleMatches:
        result.eligibleMatches,

      shortlisted:
        result.shortlisted,

      totalShortlist:
        result.totalShortlist,

      totalBeforeCap:
        result.totalBeforeCap,

      paddedMatches:
        result.paddedMatches,

      pagination: result.pagination,

      data: result.data,
    });
  } catch (error) {
    console.error(
      "Get top relevant matches error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch top relevant candidate matches",
      error: error.message,
    });
  }
};


// ======================================================
// GET ONE CANDIDATE MATCH
// ======================================================

const getCandidateMatchById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Candidate Match ID",
        received: id,
      });
    }

    const match = await CandidateMatch.findById(id)
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResult");

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Candidate match not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Candidate match fetched successfully",
      data: match,
    });
  } catch (error) {
    console.error(
      "Get candidate match error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch candidate match",
      error: error.message,
    });
  }
};


// ======================================================
// UPDATE CANDIDATE MATCH
// ======================================================

const updateCandidateMatch = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, 400, "Invalid Candidate Match ID", null, {
        received: id,
      });
    }

    const body = req.body || {};

    // Only human-review fields can be changed here.
    const unknownFields = Object.keys(body).filter(
      (key) => !["reviewStatus", "reviewerNotes"].includes(key)
    );

    if (unknownFields.length) {
      return sendError(res, 400, "Only reviewStatus and reviewerNotes can be updated", null, {
        rejectedFields: unknownFields,
      });
    }

    if (body.reviewStatus === undefined && body.reviewerNotes === undefined) {
      return sendError(res, 400, "reviewStatus or reviewerNotes is required");
    }

    if (
      body.reviewStatus !== undefined &&
      !REVIEW_STATUSES.includes(body.reviewStatus)
    ) {
      return sendError(
        res,
        400,
        `reviewStatus must be one of: ${REVIEW_STATUSES.join(", ")}`
      );
    }

    if (
      body.reviewerNotes !== undefined &&
      (typeof body.reviewerNotes !== "string" || body.reviewerNotes.length > 2000)
    ) {
      return sendError(res, 400, "reviewerNotes must be text (max 2000 characters)");
    }

    const before = await CandidateMatch.findById(id).lean();

    if (!before) {
      return sendError(res, 404, "Candidate match not found");
    }

    const newStatus = body.reviewStatus ?? before.reviewStatus;
    const newNotes =
      body.reviewerNotes !== undefined
        ? body.reviewerNotes.trim()
        : before.reviewerNotes;

    const statusChanged = newStatus !== before.reviewStatus;
    const notesChanged = (newNotes || "") !== (before.reviewerNotes || "");

    const populateAll = (query) =>
      query
        .populate("candidate")
        .populate("bgvRun")
        .populate("searchResult");

    // Repeated / retried request with the same content: nothing to do.
    if (!statusChanged && !notesChanged) {
      const same = await populateAll(CandidateMatch.findById(id));

      return res.status(200).json({
        success: true,
        message: "Candidate match already up to date",
        data: same,
      });
    }

    const update = { reviewerNotes: newNotes };

    if (statusChanged) {
      update.reviewStatus = newStatus;
      update.reviewedAt = newStatus === "PENDING" ? undefined : new Date();

      const who = req.user?._id || req.user?.id;
      if (who) update.reviewedBy = who;
    }

    // Compare-and-set: if someone else decided in the meantime we refuse
    // instead of silently overwriting their decision.
    const match = await populateAll(
      CandidateMatch.findOneAndUpdate(
        { _id: id, reviewStatus: before.reviewStatus },
        update.reviewedAt === undefined && statusChanged
          ? { $set: { reviewStatus: update.reviewStatus, reviewerNotes: newNotes }, $unset: { reviewedAt: 1, reviewedBy: 1 } }
          : { $set: update },
        { new: true, runValidators: true }
      )
    );

    if (!match) {
      return sendError(
        res,
        409,
        "This match was changed by someone else. Reload and try again."
      );
    }

    // Audit trail + final result - only AFTER the update succeeded.
    if (statusChanged && newStatus !== "PENDING") {
      const sr = match.searchResult || {};

      await logEvent({
        bgvRun: match.bgvRun?._id || before.bgvRun,
        candidate: match.candidate?._id || before.candidate,
        action: newStatus === "APPROVED" ? "PROFILE_APPROVED" : "PROFILE_REJECTED",
        previousStatus: before.reviewStatus,
        newStatus,
        description: `${sr.platform || "Profile"} ${sr.profileUrl || ""} ${newStatus.toLowerCase()} by reviewer${newNotes ? `: ${newNotes}` : ""}`.trim(),
        performedBy: req.user?._id || req.user?.id,
        metadata: {
          candidateMatch: match._id,
          searchResult: sr._id,
          platform: sr.platform,
          profileUrl: sr.profileUrl,
          similarityScore: match.similarityScore,
          matchStatus: match.matchStatus,
          reviewerNotes: newNotes || null,
        },
        idempotencyKey: `review:${match._id}:${before.reviewStatus}->${newStatus}:${match.updatedAt?.getTime?.()}`,
      });
    }

    // Permanent identity registry: an explicit reviewer APPROVAL is remembered
    // across runs; withdrawing it revokes (never deletes) the stored identity.
    // A registry problem must never fail the review itself.
    if (statusChanged) {
      try {
        const who = verifiedIdentities.reviewerFromRequest(req);
        const candidateId = match.candidate?._id || before.candidate;
        const runId = match.bgvRun?._id || before.bgvRun;
        if (newStatus === "APPROVED" && match.searchResult) {
          await verifiedIdentities.recordVerification({
            candidateId,
            searchResult: match.searchResult,
            bgvRunId: runId,
            match,
            reviewer: who,
            notes: newNotes,
            method: "MATCH_REVIEW",
          });
        } else if (before.reviewStatus === "APPROVED" && match.searchResult?.profileUrl) {
          await verifiedIdentities.revokeVerification({
            candidateId,
            profileUrl: match.searchResult.profileUrl,
            reviewer: who,
            bgvRunId: runId,
            reason: `Review changed from APPROVED to ${newStatus}${newNotes ? `: ${newNotes}` : ""}`,
          });
        }
      } catch (registryError) {
        console.error("Verified identity registry update failed:", registryError.message);
      }
    }

    if (statusChanged) {
      await recomputeFinalResult(match.bgvRun?._id || before.bgvRun, {
        performedBy: req.user?._id || req.user?.id,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Candidate match updated successfully",
      data: match,
    });
  } catch (error) {
    console.error("Update candidate match error:", error);

    return sendError(res, 500, "Failed to update candidate match", error);
  }
};

// ======================================================
// DELETE CANDIDATE MATCH
// ======================================================

const deleteCandidateMatch = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Candidate Match ID",
        received: id,
      });
    }

    const match =
      await CandidateMatch.findById(id);

    if (!match) {
      return res.status(404).json({
        success: false,
        message:
          "Candidate match not found",
      });
    }

    const bgvRunId = match.bgvRun;

    await CandidateMatch.findByIdAndDelete(id);

    if (bgvRunId) {
      await BgvRun.findByIdAndUpdate(
        bgvRunId,
        {
          $inc: {
            matchedResults: -1,
          },
        }
      );
    }

    return res.status(200).json({
      success: true,
      message:
        "Candidate match deleted successfully",
    });
  } catch (error) {
    console.error(
      "Delete candidate match error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to delete candidate match",
      error: error.message,
    });
  }
};


// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  createCandidateMatch,
  getAllCandidateMatches,
  getMatchesByBgvRun,
  getTopRelevantMatchesForReview,
  getPlatformMatchesForReview,
  getCandidateMatchById,
  updateCandidateMatch,
  deleteCandidateMatch,
};