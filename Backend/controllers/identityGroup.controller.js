const mongoose = require("mongoose");

const verifiedIdentities = require("../services/verifiedIdentity.service");
const IdentityGroup = require("../models/IdentityGroup");
const BgvRun = require("../models/BgvRun");
const Candidate = require("../models/Candidate");

const {
  buildIdentityGroups,
  confirmIdentityMerge,
} = require("../services/identityGroup.service");

const { logEvent } = require("../services/verificationLog.service");
const { sendError } = require("../utils/http");

const GROUP_REVIEW_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

// ======================================================
// BUILD IDENTITY GROUPS
// ======================================================

const buildGroupsForBgvRun = async (req, res) => {
  try {
    const { bgvRunId } = req.params;

    // Validate BGV Run ID
    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    // Check BGV Run
    const bgvRun = await BgvRun.findById(bgvRunId);

    if (!bgvRun) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
      });
    }

    // Check candidate
    const candidate = await Candidate.findById(
      bgvRun.candidate
    );

    if (!candidate) {
      return res.status(404).json({
        success: false,
        message: "Candidate not found",
      });
    }

    console.log(
      `Building identity groups for BGV run: ${bgvRunId}`
    );

    const result = await buildIdentityGroups({
      candidateId: candidate._id,
      bgvRunId,
    });

    if (result.totalGroups > 0) {
      await logEvent({
        bgvRun: bgvRunId,
        candidate: candidate._id,
        action: "IDENTITY_GROUP_CREATED",
        description: `${result.totalGroups} automatic (PENDING) identity group(s) proposed from human-approved profiles`,
        performedBy: req.user?._id || req.user?.id,
        metadata: {
          groups: (result.groups || []).map((g) => String(g._id)),
          approvedMatches: result.approvedMatches,
        },
        idempotencyKey: `group-build:${bgvRunId}:${(result.groups || [])
          .map((g) => String(g._id))
          .sort()
          .join(",")}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Identity groups built successfully",
      data: {
        bgvRunId,
        candidateId: candidate._id,

        // New automatic (PENDING) groups created by this build
        totalGroups: result.totalGroups,

        // Approved profiles that now belong to an identity group
        // (service field: groupedApprovedResults)
        totalGroupedResults: result.groupedApprovedResults,

        // APPROVED / REJECTED groups that the rebuild kept untouched
        preservedReviewedGroups: result.preservedReviewedGroups,
        approvedProfilesAlreadyInReviewedGroups:
          result.approvedProfilesAlreadyInReviewedGroups,
        skippedPreviouslyRejectedGroups:
          result.skippedPreviouslyRejectedGroups,

        // Transparency: nothing is deleted, only not grouped
        totalSearchResults: result.totalSearchResults,
        totalCandidateMatches: result.totalCandidateMatches,
        approvedMatches: result.approvedMatches,
        notApprovedNotGrouped: result.notApprovedNotGrouped,

        groups: result.groups,
      },
    });
  } catch (error) {
    console.error(
      "Build identity groups error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to build identity groups",
      error: error.message,
    });
  }
};

// ======================================================
// HUMAN-CONFIRMED IDENTITY MERGE
// ======================================================

const MERGE_MESSAGES = {
  CREATED: "Identity group created and confirmed by reviewer",
  EXPANDED:
    "Existing confirmed identity group expanded with the selected profiles",
  CONFIRMED_EXISTING_GROUP:
    "Existing pending identity group confirmed by reviewer",
  REVIVED:
    "Previously rejected identity group confirmed again by reviewer",
  ALREADY_CONFIRMED:
    "These profiles were already confirmed in one identity group (no duplicate created)",
};

const mergeIdentityGroup = async (req, res) => {
  try {
    const {
      bgvRunId,
      candidateId,
      searchResultIds,
      reviewerNotes,
    } = req.body || {};

    // Validate BGV Run ID
    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    // Validate Candidate ID
    if (!mongoose.Types.ObjectId.isValid(candidateId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Candidate ID",
        received: candidateId,
      });
    }

    // Validate SearchResult IDs
    if (
      !Array.isArray(searchResultIds) ||
      searchResultIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "searchResultIds must be a non-empty array of SearchResult IDs",
      });
    }

    const invalidIds = searchResultIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );

    if (invalidIds.length) {
      return res.status(400).json({
        success: false,
        message: "Invalid SearchResult ID(s)",
        invalidSearchResultIds: invalidIds,
      });
    }

    // The reason for a human confirmation must be recorded.
    if (
      typeof reviewerNotes !== "string" ||
      reviewerNotes.trim().length < 3
    ) {
      return res.status(400).json({
        success: false,
        message:
          "reviewerNotes (the reason for confirming this identity) is required",
      });
    }

    // Reviewer, when an auth middleware sets req.user
    const reviewedBy = req.user?._id || req.user?.id;

    const result = await confirmIdentityMerge({
      bgvRunId,
      candidateId,
      searchResultIds,
      reviewerNotes,
      reviewedBy,
    });

    // Audit trail (after the merge really succeeded). A repeated request
    // that changed nothing is not logged again.
    if (result.action !== "ALREADY_CONFIRMED") {
      await logEvent({
        bgvRun: bgvRunId,
        candidate: candidateId,
        action:
          result.action === "CREATED"
            ? "IDENTITY_GROUP_CREATED"
            : "IDENTITY_GROUP_MERGED",
        previousStatus: result.action === "CREATED" ? undefined : "PENDING",
        newStatus: "APPROVED",
        description: `Identity ${result.action.toLowerCase().replace(/_/g, " ")} by reviewer: ${reviewerNotes.trim()}`,
        performedBy: reviewedBy,
        metadata: {
          identityGroup: result.group?._id,
          action: result.action,
          searchResultIds,
          consolidatedGroupIds: result.consolidatedGroupIds,
          reviewerNotes: reviewerNotes.trim(),
        },
        idempotencyKey: `group-merge:${result.group?._id}:${result.action}:${[
          ...searchResultIds,
        ]
          .map(String)
          .sort()
          .join(",")}`,
      });
    }

    return res
      .status(result.action === "CREATED" ? 201 : 200)
      .json({
        success: true,
        message: MERGE_MESSAGES[result.action],
        action: result.action,
        consolidatedGroupIds: result.consolidatedGroupIds,
        shrunkPendingGroupIds: result.shrunkPendingGroupIds,
        droppedUnapprovedProfileIds:
          result.droppedUnapprovedProfileIds,
        previouslyRejectedGroupIds:
          result.previouslyRejectedGroupIds,
        data: result.group,
      });
  } catch (error) {
    // Errors raised on purpose by the service carry an HTTP status
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.details || {}),
      });
    }

    console.error(
      "Merge identity group error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to merge identity group",
      error: error.message,
    });
  }
};

// ======================================================
// GET ALL IDENTITY GROUPS
// ======================================================

const getAllIdentityGroups = async (req, res) => {
  try {
    const groups = await IdentityGroup.find()
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResults")
      .populate("reviewedBy")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Identity groups fetched successfully",
      count: groups.length,
      data: groups,
    });
  } catch (error) {
    console.error(
      "Get identity groups error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch identity groups",
      error: error.message,
    });
  }
};

// ======================================================
// GET IDENTITY GROUPS BY BGV RUN
// ======================================================

const getIdentityGroupsByBgvRun = async (req, res) => {
  try {
    const { bgvRunId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    const bgvRun = await BgvRun.findById(bgvRunId);

    if (!bgvRun) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
      });
    }

    const groups = await IdentityGroup.find({
      bgvRun: bgvRunId,
    })
      .populate("candidate")
      .populate("searchResults")
      .populate("reviewedBy")
      .sort({ confidenceScore: -1 });

    return res.status(200).json({
      success: true,
      message:
        "Identity groups for BGV run fetched successfully",
      count: groups.length,
      data: groups,
    });
  } catch (error) {
    console.error(
      "Get identity groups by BGV run error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch identity groups for BGV run",
      error: error.message,
    });
  }
};

// ======================================================
// GET ONE IDENTITY GROUP
// ======================================================

const getIdentityGroupById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Identity Group ID",
        received: id,
      });
    }

    const group = await IdentityGroup.findById(id)
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResults")
      .populate("reviewedBy");

    if (!group) {
      return res.status(404).json({
        success: false,
        message: "Identity group not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Identity group fetched successfully",
      data: group,
    });
  } catch (error) {
    console.error(
      "Get identity group error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch identity group",
      error: error.message,
    });
  }
};

// ======================================================
// UPDATE IDENTITY GROUP REVIEW
// ======================================================

const updateIdentityGroup = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Identity Group ID",
        received: id,
      });
    }

    const body = req.body || {};

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
      !GROUP_REVIEW_STATUSES.includes(body.reviewStatus)
    ) {
      return sendError(
        res,
        400,
        `reviewStatus must be one of: ${GROUP_REVIEW_STATUSES.join(", ")}`
      );
    }

    const existing = await IdentityGroup.findById(id).lean();

    if (!existing) {
      return sendError(res, 404, "Identity group not found");
    }

    const statusChanged =
      body.reviewStatus !== undefined &&
      body.reviewStatus !== existing.reviewStatus;

    // Approving / rejecting a group is a human decision: it needs a reason.
    const notes =
      typeof body.reviewerNotes === "string"
        ? body.reviewerNotes.trim()
        : existing.reviewerNotes;

    // The reason must come WITH this decision (old notes do not count).
    const givenNotes =
      typeof body.reviewerNotes === "string" ? body.reviewerNotes.trim() : "";

    if (
      statusChanged &&
      ["APPROVED", "REJECTED"].includes(body.reviewStatus) &&
      givenNotes.length < 3
    ) {
      return sendError(res, 400, "reviewerNotes (the reason for this decision) is required");
    }

    // A profile can belong to only one confirmed group of a run.
    if (statusChanged && body.reviewStatus === "APPROVED") {
      const clash = await IdentityGroup.findOne({
        _id: { $ne: existing._id },
        bgvRun: existing.bgvRun,
        reviewStatus: "APPROVED",
        searchResults: { $in: existing.searchResults || [] },
      }).lean();

      if (clash) {
        return sendError(
          res,
          409,
          "Some profiles already belong to another confirmed identity group. Use the merge endpoint to combine them.",
          null,
          { conflictingGroupId: clash._id }
        );
      }
    }

    const updateData = {};

    if (body.reviewStatus !== undefined) updateData.reviewStatus = body.reviewStatus;
    if (typeof body.reviewerNotes === "string") updateData.reviewerNotes = notes;

    if (statusChanged) {
      updateData.reviewedAt = new Date();
      const who = req.user?._id || req.user?.id;
      if (who) updateData.reviewedBy = who;
    }

    const group =
      await IdentityGroup.findOneAndUpdate(
        { _id: id, reviewStatus: existing.reviewStatus },
        { $set: updateData },
        {
          new: true,
          runValidators: true,
        }
      )
        .populate("candidate")
        .populate("bgvRun")
        .populate("searchResults")
        .populate("reviewedBy");

    if (!group) {
      return sendError(
        res,
        409,
        "This identity group was changed by someone else. Reload and try again."
      );
    }

    if (statusChanged && body.reviewStatus !== "PENDING") {
      await logEvent({
        bgvRun: group.bgvRun?._id || existing.bgvRun,
        candidate: group.candidate?._id || existing.candidate,
        action: "STATUS_CHANGED",
        previousStatus: existing.reviewStatus,
        newStatus: body.reviewStatus,
        description: `Identity group ${body.reviewStatus.toLowerCase()} by reviewer: ${notes}`,
        performedBy: req.user?._id || req.user?.id,
        metadata: {
          identityGroup: group._id,
          profiles: (group.searchResults || []).map((r) => String(r._id)),
          reviewerNotes: notes,
        },
        idempotencyKey: `group-review:${group._id}:${existing.reviewStatus}->${body.reviewStatus}:${group.updatedAt?.getTime?.()}`,
      });
    }

    // Permanent identity registry (see verifiedIdentity.service): approving a
    // group remembers each of its profiles; withdrawing the approval revokes
    // only the identities this group created.
    if (statusChanged) {
      try {
        const who = verifiedIdentities.reviewerFromRequest(req);
        const candidateId = group.candidate?._id || existing.candidate;
        const runId = group.bgvRun?._id || existing.bgvRun;
        if (body.reviewStatus === "APPROVED") {
          for (const sr of group.searchResults || []) {
            await verifiedIdentities.recordVerification({
              candidateId,
              searchResult: sr,
              bgvRunId: runId,
              identityGroupId: group._id,
              reviewer: who,
              notes: notes,
              method: "IDENTITY_GROUP",
            });
          }
        } else if (existing.reviewStatus === "APPROVED") {
          for (const sr of group.searchResults || []) {
            await verifiedIdentities.revokeVerification({
              candidateId,
              profileUrl: sr.profileUrl,
              reviewer: who,
              bgvRunId: runId,
              onlyIfSourceGroup: group._id,
              reason: `Identity group changed from APPROVED to ${body.reviewStatus}`,
            });
          }
        }
      } catch (registryError) {
        console.error("Verified identity registry update failed:", registryError.message);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Identity group updated successfully",
      data: group,
    });
  } catch (error) {
    console.error(
      "Update identity group error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to update identity group",
      error: error.message,
    });
  }
};

module.exports = {
  buildGroupsForBgvRun,
  mergeIdentityGroup,
  getAllIdentityGroups,
  getIdentityGroupsByBgvRun,
  getIdentityGroupById,
  updateIdentityGroup,
};