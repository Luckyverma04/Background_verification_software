const Candidate = require("../models/Candidate");
const BgvRun = require("../models/BgvRun");

const {
  isValidId,
  sendError,
  getPagination,
  buildPagination,
} = require("../utils/http");

// Never taken from the request body.
const PROTECTED_FIELDS = ["_id", "__v", "createdAt", "updatedAt"];

const stripProtected = (body = {}) => {
  const data = { ...body };
  PROTECTED_FIELDS.forEach((field) => delete data[field]);
  return data;
};

// Mongoose validation / cast problems are the client's fault (400), not 500.
const handleWriteError = (res, error, fallbackMessage) => {
  if (error?.name === "ValidationError") {
    return sendError(res, 400, "Invalid candidate data", null, {
      details: Object.values(error.errors || {}).map((e) => e.message),
    });
  }

  if (error?.name === "CastError") {
    return sendError(res, 400, "Invalid value for a candidate field", null, {
      field: error.path,
    });
  }

  console.error(fallbackMessage, error);
  return sendError(res, 500, fallbackMessage, error);
};

// ==========================================
// CREATE CANDIDATE
// POST /api/candidates
// ==========================================
const createCandidate = async (req, res) => {
  try {
    const data = stripProtected(req.body);

    if (typeof data.fullName !== "string" || !data.fullName.trim()) {
      return sendError(res, 400, "fullName is required");
    }

    // Candidate data is personal data: it is not written to the logs.
    const candidate = await Candidate.create(data);

    res.status(201).json({
      success: true,
      message: "Candidate created successfully",
      data: candidate,
    });
  } catch (error) {
    handleWriteError(res, error, "Failed to create candidate");
  }
};

// ==========================================
// GET ALL CANDIDATES
// GET /api/candidates?page=1&limit=200
// ==========================================
const getAllCandidates = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query, {
      defaultLimit: 200,
      maxLimit: 500,
    });

    const [candidates, total] = await Promise.all([
      Candidate.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      Candidate.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      message: "Candidates fetched successfully",
      count: candidates.length,
      pagination: buildPagination({ page, limit, total }),
      data: candidates,
    });
  } catch (error) {
    console.error("Get all candidates error:", error);
    sendError(res, 500, "Failed to fetch candidates", error);
  }
};

// ==========================================
// GET SINGLE CANDIDATE
// GET /api/candidates/:id
// ==========================================
const getCandidateById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid candidate ID", null, { received: id });
    }

    const candidate = await Candidate.findById(id);

    if (!candidate) {
      return sendError(res, 404, "Candidate not found");
    }

    res.status(200).json({
      success: true,
      message: "Candidate fetched successfully",
      data: candidate,
    });
  } catch (error) {
    console.error("Get candidate error:", error);
    sendError(res, 500, "Failed to fetch candidate", error);
  }
};

// ==========================================
// UPDATE CANDIDATE
// PATCH /api/candidates/:id
// ==========================================
const updateCandidate = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid candidate ID", null, { received: id });
    }

    const data = stripProtected(req.body);

    if (data.fullName !== undefined && !String(data.fullName).trim()) {
      return sendError(res, 400, "fullName cannot be empty");
    }

    const candidate = await Candidate.findByIdAndUpdate(id, data, {
      new: true,
      runValidators: true,
    });

    if (!candidate) {
      return sendError(res, 404, "Candidate not found");
    }

    res.status(200).json({
      success: true,
      message: "Candidate updated successfully",
      data: candidate,
    });
  } catch (error) {
    handleWriteError(res, error, "Failed to update candidate");
  }
};

// ==========================================
// DELETE CANDIDATE
// DELETE /api/candidates/:id
//
// A candidate that already has BGV runs is part of the audit history
// (runs, reviews, evidence, confirmed identities). It is kept.
// ==========================================
const deleteCandidate = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid candidate ID", null, { received: id });
    }

    const runs = await BgvRun.countDocuments({ candidate: id });

    if (runs > 0) {
      return sendError(
        res,
        409,
        "This candidate has verification history and cannot be deleted. History, reviews and evidence are preserved.",
        null,
        { bgvRuns: runs }
      );
    }

    const candidate = await Candidate.findByIdAndDelete(id);

    if (!candidate) {
      return sendError(res, 404, "Candidate not found");
    }

    res.status(200).json({
      success: true,
      message: "Candidate deleted successfully",
      data: candidate,
    });
  } catch (error) {
    console.error("Delete candidate error:", error);
    sendError(res, 500, "Failed to delete candidate", error);
  }
};

module.exports = {
  createCandidate,
  getAllCandidates,
  getCandidateById,
  updateCandidate,
  deleteCandidate,
};
