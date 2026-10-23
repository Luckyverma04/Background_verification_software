const mongoose = require("mongoose");

const SearchResult = require("../models/SearchResult");
const { getPagination, buildPagination } = require("../utils/http");
const BgvRun = require("../models/BgvRun");

// ==========================================
// CREATE SEARCH RESULT
// POST /api/search-results
// ==========================================
const createSearchResult = async (req, res) => {
  try {
    const { bgvRun } = req.body;

    console.log("SEARCH RESULT BODY:", req.body);

    // ------------------------------------------
    // Validate bgvRun
    // ------------------------------------------
    if (!bgvRun) {
      return res.status(400).json({
        success: false,
        message: "bgvRun is required",
      });
    }

    // ------------------------------------------
    // Validate MongoDB ObjectId
    // ------------------------------------------
    if (!mongoose.Types.ObjectId.isValid(bgvRun)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRun,
      });
    }

    // ------------------------------------------
    // Check BGV Run exists
    // ------------------------------------------
    const run = await BgvRun.findById(bgvRun);

    if (!run) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
        bgvRun,
      });
    }

    // ------------------------------------------
    // Create Search Result
    // ------------------------------------------
    const searchResult = await SearchResult.create({
      ...req.body,
      bgvRun,
    });

    // ------------------------------------------
    // Update BGV Run result count
    // ------------------------------------------
    await BgvRun.findByIdAndUpdate(
      bgvRun,
      {
        $inc: {
          totalSearchResults: 1,
        },
      }
    );

    // ------------------------------------------
    // Success
    // ------------------------------------------
    return res.status(201).json({
      success: true,
      message: "Search result created successfully",
      data: searchResult,
    });
  } catch (error) {
    console.error("Create search result error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to create search result",
      error: error.message,
    });
  }
};

// ==========================================
// GET ALL SEARCH RESULTS
// GET /api/search-results
// ==========================================
const getAllSearchResults = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query, {
      defaultLimit: 100,
      maxLimit: 500,
    });

    const [results, total] = await Promise.all([
      SearchResult.find()
        .populate("bgvRun")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      SearchResult.countDocuments(),
    ]);

    return res.status(200).json({
      success: true,
      message: "Search results fetched successfully",
      count: results.length,
      pagination: buildPagination({ page, limit, total }),
      data: results,
    });
  } catch (error) {
    console.error("Get search results error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch search results",
      error: error.message,
    });
  }
};

// ==========================================
// GET SEARCH RESULTS FOR ONE BGV RUN
// GET /api/search-results/run/:bgvRunId
// ==========================================
const getResultsByBgvRun = async (req, res) => {
  try {
    const { bgvRunId } = req.params;

    // ------------------------------------------
    // Validate BGV Run ID
    // ------------------------------------------
    if (!mongoose.Types.ObjectId.isValid(bgvRunId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid BGV Run ID",
        received: bgvRunId,
      });
    }

    // ------------------------------------------
    // Check BGV Run exists
    // ------------------------------------------
    const run = await BgvRun.findById(bgvRunId);

    if (!run) {
      return res.status(404).json({
        success: false,
        message: "BGV run not found",
      });
    }

    // ------------------------------------------
    // Fetch Search Results
    // ------------------------------------------
    const { page, limit, skip } = getPagination(req.query, {
      defaultLimit: 100,
      maxLimit: 500,
    });

    const [results, total] = await Promise.all([
      SearchResult.find({ bgvRun: bgvRunId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      SearchResult.countDocuments({ bgvRun: bgvRunId }),
    ]);

    return res.status(200).json({
      success: true,
      message: "BGV run search results fetched successfully",
      bgvRunId,
      count: results.length,
      pagination: buildPagination({ page, limit, total }),
      data: results,
    });
  } catch (error) {
    console.error("Get BGV run results error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch BGV run search results",
      error: error.message,
    });
  }
};

// ==========================================
// GET ONE SEARCH RESULT
// GET /api/search-results/:id
// ==========================================
const getSearchResultById = async (req, res) => {
  try {
    const { id } = req.params;

    // ------------------------------------------
    // Validate SearchResult ID
    // ------------------------------------------
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid search result ID",
        received: id,
      });
    }

    // ------------------------------------------
    // Find SearchResult
    // ------------------------------------------
    const result = await SearchResult.findById(id)
      .populate("bgvRun");

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Search result not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Search result fetched successfully",
      data: result,
    });
  } catch (error) {
    console.error("Get search result error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch search result",
      error: error.message,
    });
  }
};

// ==========================================
// UPDATE SEARCH RESULT
// PATCH /api/search-results/:id
// ==========================================
const updateSearchResult = async (req, res) => {
  try {
    const { id } = req.params;

    // ------------------------------------------
    // Validate ID
    // ------------------------------------------
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid search result ID",
        received: id,
      });
    }

    // ------------------------------------------
    // Prevent changing BGV Run accidentally
    // ------------------------------------------
    const updateData = { ...req.body };

    delete updateData.bgvRun;

    // ------------------------------------------
    // Update SearchResult
    // ------------------------------------------
    const result = await SearchResult.findByIdAndUpdate(
      id,
      updateData,
      {
        new: true,
        runValidators: true,
      }
    ).populate("bgvRun");

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Search result not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Search result updated successfully",
      data: result,
    });
  } catch (error) {
    console.error("Update search result error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to update search result",
      error: error.message,
    });
  }
};

// ==========================================
// DELETE SEARCH RESULT
// DELETE /api/search-results/:id
// ==========================================
const deleteSearchResult = async (req, res) => {
  try {
    const { id } = req.params;

    // ------------------------------------------
    // Validate ID
    // ------------------------------------------
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid search result ID",
        received: id,
      });
    }

    // ------------------------------------------
    // Find result
    // ------------------------------------------
    const result = await SearchResult.findById(id);

    if (!result) {
      return res.status(404).json({
        success: false,
        message: "Search result not found",
      });
    }

    const bgvRunId = result.bgvRun;

    // ------------------------------------------
    // Delete SearchResult
    // ------------------------------------------
    await SearchResult.findByIdAndDelete(id);

    // ------------------------------------------
    // Decrease BGV Run count safely
    // ------------------------------------------
    if (bgvRunId) {
      await BgvRun.findByIdAndUpdate(bgvRunId, {
        $inc: {
          totalSearchResults: -1,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Search result deleted successfully",
    });
  } catch (error) {
    console.error("Delete search result error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to delete search result",
      error: error.message,
    });
  }
};

// ==========================================
// EXPORT CONTROLLERS
// ==========================================
module.exports = {
  createSearchResult,
  getAllSearchResults,
  getResultsByBgvRun,
  getSearchResultById,
  updateSearchResult,
  deleteSearchResult,
};