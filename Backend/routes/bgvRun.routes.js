const express = require("express");

const {
  createBgvRun,
  getAllBgvRuns,
  getBgvRunById,
  searchBgvRun,
  matchBgvRun,
  updateBgvRun,
  getFinalResult,
  getRunPlatforms,
  setFinalResult,
  renormalizeBgvRun,
  enrichBgvRunImages,
} = require("../controllers/bgvRun.controller");
const { addProfileToRun, getKnownProfiles } = require("../controllers/profile.controller");

const router = express.Router();

// ==========================================
// CREATE / START BGV
// POST /api/bgv-runs
// ==========================================
router.post("/", createBgvRun);

// ==========================================
// GET ALL BGV RUNS
// GET /api/bgv-runs
// ==========================================
router.get("/", getAllBgvRuns);

// ==========================================
// SEARCH BGV RUN
// POST /api/bgv-runs/:id/search
// ==========================================
router.post("/:id/search", searchBgvRun);

// ==========================================
// MATCH EXISTING SEARCH RESULTS
// POST /api/bgv-runs/:id/match
// ==========================================
router.post("/:id/match", matchBgvRun);

// ==========================================
// GET SINGLE BGV RUN
// GET /api/bgv-runs/:id
// ==========================================
// Final BGV result (documented rules) / reviewer decision with a reason
router.get("/:id/final-result", getFinalResult);
router.get("/:id/platforms", getRunPlatforms);
// reviewer adds a profile by hand / profiles shown apart from new discoveries
router.post("/:id/profiles", addProfileToRun);
router.get("/:id/known-profiles", getKnownProfiles);
router.post("/:id/final-result", setFinalResult);
router.post("/:id/renormalize", renormalizeBgvRun);
router.post("/:id/enrich-images", enrichBgvRunImages);
router.get("/:id", getBgvRunById);

// ==========================================
// UPDATE BGV RUN
// PATCH /api/bgv-runs/:id
// ==========================================
router.patch("/:id", updateBgvRun);

module.exports = router;