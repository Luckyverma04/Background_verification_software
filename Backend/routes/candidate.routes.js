const express = require("express");

const {
  createCandidate,
  getAllCandidates,
  getCandidateById,
  updateCandidate,
  deleteCandidate,
} = require("../controllers/candidate.controller");

const { requireRole } = require("../middleware/auth.middleware");

const router = express.Router();

// CREATE
router.post("/", createCandidate);

// GET ALL
router.get("/", getAllCandidates);

// GET ONE
router.get("/:id", getCandidateById);

// UPDATE
router.patch("/:id", updateCandidate);

// DELETE
router.delete("/:id", requireRole("ADMIN"), deleteCandidate);

module.exports = router;