const express = require("express");

const {
  createEvidenceFromMatch,
  createEvidenceForGroup,
  getAllEvidence,
  getEvidenceById,
  getEvidenceByBgvRun,
} = require("../controllers/evidence.controller");

const router = express.Router();

// Create evidence from a CandidateMatch
router.post(
  "/from-match",
  createEvidenceFromMatch
);

// Create evidence for an IdentityGroup
router.post(
  "/from-group",
  createEvidenceForGroup
);

// Get all evidence
router.get(
  "/",
  getAllEvidence
);

// Get evidence for a BGV run
router.get(
  "/run/:bgvRunId",
  getEvidenceByBgvRun
);

// Get one evidence document
router.get(
  "/:id",
  getEvidenceById
);

module.exports = router;