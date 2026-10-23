const mongoose = require("mongoose");

const Evidence = require("../models/Evidence");

const {
  createEvidenceFromCandidateMatch,
  createEvidenceForIdentityGroup,
} = require("../services/evidence.service");

const { logEvent } = require("../services/verificationLog.service");

// ======================================================
// CREATE EVIDENCE FROM CANDIDATE MATCH
// ======================================================

const createEvidenceFromMatch = async (req, res) => {
  try {
    const { candidateMatchId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(candidateMatchId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Candidate Match ID",
        received: candidateMatchId,
      });
    }

    const result = await createEvidenceFromCandidateMatch({
      candidateMatchId,
    });

    // Log only when something was really created (a retry that only
    // re-used existing evidence adds nothing and must not log again).
    if (result.created > 0) {
      await logEvent({
        bgvRun: result.bgvRun,
        candidate: result.candidate,
        action: "EVIDENCE_CREATED",
        description: `${result.created} evidence record(s) created from candidate match`,
        performedBy: req.user?._id || req.user?.id,
        metadata: {
          candidateMatch: candidateMatchId,
          created: result.created,
          reused: result.reused,
        },
        idempotencyKey: `evidence:match:${candidateMatchId}:${result.evidence
          .map((e) => String(e._id))
          .sort()
          .join(",")
          .slice(0, 400)}`,
      });
    }

    return res.status(result.created > 0 ? 201 : 200).json({
      success: true,
      message:
        result.created > 0
          ? "Evidence created successfully"
          : "Evidence already existed (nothing new created)",
      data: result,
    });
  } catch (error) {
    console.error(
      "Create evidence from match error:",
      error
    );

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.details || {}),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create evidence",
      error: error.message,
    });
  }
};

// ======================================================
// CREATE EVIDENCE FOR IDENTITY GROUP
// ======================================================

const createEvidenceForGroup = async (req, res) => {
  try {
    const { identityGroupId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(identityGroupId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Identity Group ID",
        received: identityGroupId,
      });
    }

    const result = await createEvidenceForIdentityGroup({
      identityGroupId,
    });

    if (result.created > 0) {
      await logEvent({
        bgvRun: result.bgvRun,
        candidate: result.candidate,
        action: "EVIDENCE_CREATED",
        description: `${result.created} evidence record(s) created for identity group`,
        performedBy: req.user?._id || req.user?.id,
        metadata: {
          identityGroup: identityGroupId,
          created: result.created,
          reused: result.reused,
        },
        idempotencyKey: `evidence:group:${identityGroupId}:${result.evidence
          .map((e) => String(e._id))
          .sort()
          .join(",")
          .slice(0, 400)}`,
      });
    }

    return res.status(result.created > 0 ? 201 : 200).json({
      success: true,
      message:
        result.created > 0
          ? "Evidence created for identity group successfully"
          : "Evidence already existed (nothing new created)",
      data: result,
    });
  } catch (error) {
    console.error(
      "Create evidence for identity group error:",
      error
    );

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        message: error.message,
        ...(error.details || {}),
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create identity group evidence",
      error: error.message,
    });
  }
};

// ======================================================
// GET ALL EVIDENCE
// ======================================================

const getAllEvidence = async (req, res) => {
  try {
    const evidence = await Evidence.find()
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResult")
      .populate("candidateMatch")
      .populate("identityGroup")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Evidence fetched successfully",
      count: evidence.length,
      data: evidence,
    });
  } catch (error) {
    console.error(
      "Get all evidence error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch evidence",
      error: error.message,
    });
  }
};

// ======================================================
// GET EVIDENCE BY ID
// ======================================================

const getEvidenceById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid Evidence ID",
        received: id,
      });
    }

    const evidence = await Evidence.findById(id)
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResult")
      .populate("candidateMatch")
      .populate("identityGroup");

    if (!evidence) {
      return res.status(404).json({
        success: false,
        message: "Evidence not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Evidence fetched successfully",
      data: evidence,
    });
  } catch (error) {
    console.error(
      "Get evidence by ID error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Failed to fetch evidence",
      error: error.message,
    });
  }
};

// ======================================================
// GET EVIDENCE BY BGV RUN
// ======================================================

const getEvidenceByBgvRun = async (req, res) => {
  try {
    const { bgvRunId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    const evidence = await Evidence.find({
      bgvRun: bgvRunId,
    })
      .populate("candidate")
      .populate("searchResult")
      .populate("candidateMatch")
      .populate("identityGroup")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message:
        "Evidence for BGV run fetched successfully",
      count: evidence.length,
      data: evidence,
    });
  } catch (error) {
    console.error(
      "Get evidence by BGV run error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Failed to fetch evidence for BGV run",
      error: error.message,
    });
  }
};

module.exports = {
  createEvidenceFromMatch,
  createEvidenceForGroup,
  getAllEvidence,
  getEvidenceById,
  getEvidenceByBgvRun,
};