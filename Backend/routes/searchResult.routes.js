const express = require("express");

const {
  createSearchResult,
  getAllSearchResults,
  getResultsByBgvRun,
  getSearchResultById,
  updateSearchResult,
  deleteSearchResult,
} = require("../controllers/searchResult.controller");

const router = express.Router();

// ==========================================
// CREATE SEARCH RESULT
// POST /api/search-results
// ==========================================
router.post("/", createSearchResult);

// ==========================================
// GET ALL SEARCH RESULTS
// GET /api/search-results
// ==========================================
router.get("/", getAllSearchResults);

// ==========================================
// GET RESULTS FOR ONE BGV RUN
// GET /api/search-results/run/:bgvRunId
// ==========================================
router.get("/run/:bgvRunId", getResultsByBgvRun);

// ==========================================
// GET ONE SEARCH RESULT
// GET /api/search-results/:id
// ==========================================
router.get("/:id", getSearchResultById);

// ==========================================
// UPDATE SEARCH RESULT
// PATCH /api/search-results/:id
// ==========================================
router.patch("/:id", updateSearchResult);

// ==========================================
// DELETE SEARCH RESULT
// DELETE /api/search-results/:id
// ==========================================
router.delete("/:id", deleteSearchResult);

module.exports = router;