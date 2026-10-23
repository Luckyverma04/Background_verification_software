const mongoose = require("mongoose");

const {
  createVerificationLog,
  getVerificationLogsByRun,
  getVerificationLogById,
} = require("../services/verificationLog.service");

// ==========================================
// CREATE VERIFICATION LOG
// POST /api/verification-logs
// ==========================================
const createLog = async (req, res) => {
  try {
    const {
      bgvRun,
      candidate,
      action,
      previousStatus,
      newStatus,
      description,
      performedBy,
      metadata,
    } = req.body;

    const log = await createVerificationLog({
      bgvRun,
      candidate,
      action,
      previousStatus,
      newStatus,
      description,
      performedBy,
      metadata,
    });

    return res.status(201).json({
      success: true,
      message: "Verification log created successfully",
      data: log,
    });
  } catch (error) {
    console.error("Create verification log error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create verification log",
      error: error.message,
    });
  }
};

// ==========================================
// GET LOGS BY BGV RUN
// GET /api/verification-logs/run/:bgvRunId
// ==========================================
const getLogsByRun = async (req, res) => {
  try {
    const { bgvRunId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV run ID",
      });
    }

    const logs = await getVerificationLogsByRun(bgvRunId);

    return res.status(200).json({
      success: true,
      count: logs.length,
      data: logs,
    });
  } catch (error) {
    console.error("Get verification logs error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch verification logs",
      error: error.message,
    });
  }
};

// ==========================================
// GET LOG BY ID
// GET /api/verification-logs/:id
// ==========================================
const getLogById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid verification log ID",
      });
    }

    const log = await getVerificationLogById(id);

    if (!log) {
      return res.status(404).json({
        success: false,
        message: "Verification log not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: log,
    });
  } catch (error) {
    console.error("Get verification log error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch verification log",
      error: error.message,
    });
  }
};

module.exports = {
  createLog,
  getLogsByRun,
  getLogById,
};