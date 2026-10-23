const express = require("express");

const {
  createCandidateMatch,
  getAllCandidateMatches,
  getMatchesByBgvRun,
  getTopRelevantMatchesForReview,
  getPlatformMatchesForReview,
  getCandidateMatchById,
  updateCandidateMatch,
  deleteCandidateMatch,
} = require("../controllers/candidateMatch.controller");

const router = express.Router();


// ======================================================
// CREATE
// ======================================================

router.post("/", createCandidateMatch);


// ======================================================
// GET ALL
// ======================================================

router.get("/", getAllCandidateMatches);


// ======================================================
// GET TOP RELEVANT MATCHES FOR HUMAN REVIEW
// IMPORTANT: Keep this BEFORE /:id
// ======================================================

router.get(
  "/run/:bgvRunId/relevant",
  getTopRelevantMatchesForReview
);

router.get(
  "/run/:bgvRunId/platform/:platform",
  getPlatformMatchesForReview
);


// ======================================================
// GET MATCHES BY BGV RUN
// PAGINATION
// ======================================================

router.get(
  "/run/:bgvRunId",
  getMatchesByBgvRun
);


// ======================================================
// GET ONE
// ======================================================

router.get(
  "/:id",
  getCandidateMatchById
);


// ======================================================
// UPDATE
// ======================================================

router.patch(
  "/:id",
  updateCandidateMatch
);


// ======================================================
// DELETE
// ======================================================

router.delete(
  "/:id",
  deleteCandidateMatch
);


module.exports = router;