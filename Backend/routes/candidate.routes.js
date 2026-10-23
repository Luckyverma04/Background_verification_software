const express = require("express");

const {
  createCandidate,
  getAllCandidates,
  getCandidateById,
  updateCandidate,
  deleteCandidate,
} = require("../controllers/candidate.controller");

const router = express.Router();
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Candidate match routes are working",
  });
});

// CREATE
router.post("/", createCandidate);

// GET ALL
router.get("/", getAllCandidates);

// GET ONE
router.get("/:id", getCandidateById);

// UPDATE
router.patch("/:id", updateCandidate);

// DELETE
router.delete("/:id", deleteCandidate);

module.exports = router;