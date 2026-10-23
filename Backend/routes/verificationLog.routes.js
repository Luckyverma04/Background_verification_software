const express = require("express");

const {
  createLog,
  getLogsByRun,
  getLogById,
} = require("../controllers/verificationLog.controller");

const router = express.Router();

// ==========================================
// CREATE VERIFICATION LOG
// POST /api/verification-logs
// ==========================================
router.post("/", createLog);

// ==========================================
// GET LOGS BY BGV RUN
// GET /api/verification-logs/run/:bgvRunId
// ==========================================
router.get("/run/:bgvRunId", getLogsByRun);

// ==========================================
// GET LOG BY ID
// GET /api/verification-logs/:id
// ==========================================
router.get("/:id", getLogById);

module.exports = router;