const BgvRun = require("../models/BgvRun");
const Candidate = require("../models/Candidate");

const { enrichProfileImages } = require("../services/profileImage.service");
const { searchCandidate } = require("../services/candidateSearch.service");
const mlService = require("../services/mlMatch.service");
const {
  getTopRelevantMatches,
} = require("../services/candidateMatchRanking.service");
const {
  createMatchesForBgvRun,
} = require("../services/candidateMatch.service");
const {
  renormalizeExistingSearchResults,
} = require("../services/searchResultNormalization.service");
const { logEvent } = require("../services/verificationLog.service");
const {
  refreshPlatformRelevance,
  getPlatformSummary,
} = require("../services/platformSummary.service");
const {
  FINAL_RESULTS,
  recomputeFinalResult,
} = require("../services/finalResult.service");

const {
  isValidId,
  sendError,
  getPagination,
  buildPagination,
} = require("../utils/http");

// Statuses during which a second search/match request must be refused
// (it would run the same paid searches twice and race on the same data).
const BUSY_STATUSES = ["SEARCHING", "MATCHING"];

// How long a PENDING run is treated as "the same click, sent twice".
const DUPLICATE_CREATE_WINDOW_MS = 60 * 1000;

const reviewer = (req) => req.user?._id || req.user?.id;

// ==========================================
// Shared checks: valid id, run exists, candidate exists,
// run belongs to the candidate (when one is given in the body)
// ==========================================
const loadRun = async (req, res) => {
  const { id } = req.params;

  if (!isValidId(id)) {
    sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    return null;
  }

  const bgvRun = await BgvRun.findById(id);

  if (!bgvRun) {
    sendError(res, 404, "BGV run not found");
    return null;
  }

  const candidate = await Candidate.findById(bgvRun.candidate);

  if (!candidate) {
    sendError(res, 404, "Candidate not found");
    return null;
  }

  const claimed = req.body?.candidateId;

  if (claimed !== undefined && String(claimed) !== String(candidate._id)) {
    sendError(res, 400, "BGV run does not belong to this candidate");
    return null;
  }

  return { bgvRun, candidate };
};

// ==========================================
// After matching: warm up BGE-M3 (batched + cached) so the review page
// opens instantly, then print the FINAL summary.
// A BGE-M3 failure never fails the BGV run.
// ==========================================
const finishMatchingStage = async (bgvRunId, matchingResult) => {
  console.log("ML:");

  try {
    const ranked = await getTopRelevantMatches({ bgvRunId, limit: 15 });
    // Inspectable funnel: discovered -> matched / needs review / rejected,
    // and why anything is not in the review list.
    await BgvRun.updateOne(
      { _id: bgvRunId },
      {
        $set: {
          "searchSummary.funnel": {
            ...ranked.counts,
            excludedByReason: ranked.excludedByReason,
            matchingFailed: matchingResult.failedMatches || 0,
            computedAt: new Date(),
          },
        },
      }
    );
  } catch (error) {
    console.error(
      "BGE-M3 warm-up failed (the review list will retry):",
      error.message
    );
  }

  // per-platform "relevant" counts / shortfalls (never fatal)
  try {
    await refreshPlatformRelevance(bgvRunId);
  } catch (error) {
    console.error("Platform relevance refresh failed:", error.message);
  }

  console.log("FINAL:");
  console.log(`  Total results: ${matchingResult.totalSearchResults}`);
  console.log(`  Strong matches: ${matchingResult.strongMatches}`);
  console.log(`  Possible matches: ${matchingResult.possibleMatches}`);
  console.log(`  Review required: ${matchingResult.reviewRequired}`);
};

// Atomically claim the run so two requests cannot work on it at once.
const claimRun = (id, nextStatus, extra = {}) =>
  BgvRun.findOneAndUpdate(
    { _id: id, status: { $nin: BUSY_STATUSES } },
    { $set: { status: nextStatus, ...extra, error: undefined } },
    { new: true }
  );

// ==========================================
// CREATE / START BGV
// POST /api/bgv-runs
// ==========================================
const createBgvRun = async (req, res) => {
  try {
    const { candidateId } = req.body || {};

    if (!candidateId) {
      return sendError(res, 400, "candidateId is required");
    }

    if (!isValidId(candidateId)) {
      return sendError(res, 400, "Invalid candidateId", null, {
        received: candidateId,
      });
    }

    const candidate = await Candidate.findById(candidateId);

    if (!candidate) {
      return sendError(res, 404, "Candidate not found");
    }

    // Double click / retry: reuse the run that was created a moment ago
    // and has not started yet, instead of creating a second one.
    const recent = await BgvRun.findOne({
      candidate: candidateId,
      status: "PENDING",
      searchStartedAt: { $exists: false },
      createdAt: { $gte: new Date(Date.now() - DUPLICATE_CREATE_WINDOW_MS) },
    }).sort({ createdAt: -1 });

    if (recent) {
      return res.status(200).json({
        success: true,
        message: "BGV run already created",
        data: recent,
      });
    }

    const bgvRun = await BgvRun.create({
      candidate: candidateId,
      status: "PENDING",
      startedAt: new Date(),
    });

    candidate.verificationStatus = "SEARCHING";
    await candidate.save();

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "RUN_CREATED",
      newStatus: "PENDING",
      description: "BGV run created",
      performedBy: reviewer(req),
      idempotencyKey: `run-created:${bgvRun._id}`,
    });

    return res.status(201).json({
      success: true,
      message: "BGV run created successfully",
      data: bgvRun,
    });
  } catch (error) {
    console.error("Create BGV run error:", error);

    return sendError(res, 500, "Failed to create BGV run", error);
  }
};

// ==========================================
// GET ALL BGV RUNS
// GET /api/bgv-runs?page=1&limit=100
// ==========================================
const getAllBgvRuns = async (req, res) => {
  try {
    const { page, limit, skip } = getPagination(req.query, {
      defaultLimit: 100,
      maxLimit: 500,
    });

    const filter = {};

    if (req.query.candidateId) {
      if (!isValidId(req.query.candidateId)) {
        return sendError(res, 400, "Invalid candidateId");
      }
      filter.candidate = req.query.candidateId;
    }

    const [runs, total] = await Promise.all([
      BgvRun.find(filter)
        .populate("candidate")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      BgvRun.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: "BGV runs fetched successfully",
      count: runs.length,
      pagination: buildPagination({ page, limit, total }),
      data: runs,
    });
  } catch (error) {
    console.error("Get BGV runs error:", error);

    return sendError(res, 500, "Failed to fetch BGV runs", error);
  }
};

// ==========================================
// GET BGV RUN BY ID
// GET /api/bgv-runs/:id
// ==========================================
const getBgvRunById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    const run = await BgvRun.findById(id).populate("candidate");

    if (!run) {
      return sendError(res, 404, "BGV run not found");
    }

    return res.status(200).json({
      success: true,
      message: "BGV run fetched successfully",
      data: run,
    });
  } catch (error) {
    console.error("Get BGV run error:", error);

    return sendError(res, 500, "Failed to fetch BGV run", error);
  }
};

const matchingSummary = (matchingResult) => ({
  totalMatches: matchingResult.totalMatches,
  failedMatches: matchingResult.failedMatches || 0,
  relevantMatches: matchingResult.relevantMatches,
  strongMatches: matchingResult.strongMatches,
  possibleMatches: matchingResult.possibleMatches,
  reviewRequired: matchingResult.reviewRequired,
  weakMatches: matchingResult.weakMatches,
  conflicts: matchingResult.conflicts,
});

const runSummary = (bgvRun) => ({
  id: bgvRun._id,
  status: bgvRun.status,
  finalResult: bgvRun.finalResult,
  finalResultReasons: bgvRun.finalResultReasons,
  totalSearchResults: bgvRun.totalSearchResults,
  matchedResults: bgvRun.matchedResults,
  reviewRequired: bgvRun.reviewRequired,
});

// ==========================================
// SEARCH + MATCH BGV RUN
// POST /api/bgv-runs/:id/search
// ==========================================
const searchBgvRun = async (req, res) => {
  let loaded = null;
  let claimed = false;

  try {
    loaded = await loadRun(req, res);
    if (!loaded) return;

    const { candidate } = loaded;
    const id = loaded.bgvRun._id;

    // ------------------------------------------
    // STEP 1: claim the run (refuse parallel / repeated requests)
    // ------------------------------------------
    const previousStatus = loaded.bgvRun.status;
    const startedAt = new Date();

    const bgvRun = await claimRun(id, "SEARCHING", { searchStartedAt: startedAt });

    if (!bgvRun) {
      return sendError(
        res,
        409,
        "A search or matching is already running for this BGV run"
      );
    }

    claimed = true;

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "SEARCH_STARTED",
      previousStatus,
      newStatus: "SEARCHING",
      description: "External search started",
      performedBy: reviewer(req),
      idempotencyKey: `search-started:${bgvRun._id}:${startedAt.getTime()}`,
    });

    console.log(`Starting BGV search for candidate: ${candidate.fullName}`);

    // ------------------------------------------
    // STEP 2: EXTERNAL SEARCH (Tavily + Serper)
    // ------------------------------------------
    const runT0 = Date.now();
    mlService.resetMetrics();
    const searchResult = await searchCandidate({
      candidateId: candidate._id,
      bgvRunId: bgvRun._id,
    });
    const searchMs = Date.now() - runT0;

    console.log(
      `Search completed. Results found: ${searchResult.totalResults || 0}`
    );

    bgvRun.searchCompletedAt = new Date();
    bgvRun.totalSearchResults = searchResult.totalResults || 0;
    bgvRun.status = "MATCHING";
    await bgvRun.save();

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "SEARCH_COMPLETED",
      previousStatus: "SEARCHING",
      newStatus: "MATCHING",
      description: `Search completed: ${searchResult.totalResults || 0} stored result(s)`,
      performedBy: reviewer(req),
      metadata: {
        stats: searchResult.stats,
        searchSummary: searchResult.searchSummary,
      },
      idempotencyKey: `search-completed:${bgvRun._id}:${startedAt.getTime()}`,
    });

    if (searchResult.knowledgeBase?.found > 0) {
      await logEvent({
        bgvRun: bgvRun._id,
        candidate: candidate._id,
        action: "KNOWLEDGE_BASE_REUSED",
        description: `${searchResult.knowledgeBase.found} previously human-confirmed profile(s) found; ${searchResult.knowledgeBase.created} added to this run for re-review (nothing was auto-approved)`,
        metadata: {
          groups: searchResult.knowledgeBase.groups,
          runs: searchResult.knowledgeBase.runs,
          platforms: searchResult.knowledgeBase.platforms,
        },
        idempotencyKey: `kb-reused:${bgvRun._id}:${startedAt.getTime()}`,
      });
    }

    // ------------------------------------------
    // STEP 3: MATCHING (candidate vs ALL results)
    // ------------------------------------------
    console.log(`Starting candidate matching for BGV run: ${bgvRun._id}`);

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "MATCHING_STARTED",
      previousStatus: "MATCHING",
      newStatus: "MATCHING",
      description: "Candidate matching started",
      idempotencyKey: `matching-started:${bgvRun._id}:${startedAt.getTime()}`,
    });

    const matchT0 = Date.now();
    const matchingResult = await createMatchesForBgvRun({
      candidateId: candidate._id,
      bgvRunId: bgvRun._id,
    });
    const matchMs = Date.now() - matchT0;

    console.log(
      `Matching completed. Total matches: ${matchingResult.totalMatches}`
    );

    const rankT0 = Date.now();
    await finishMatchingStage(bgvRun._id, matchingResult);
    const rankMs = Date.now() - rankT0;

    // End-to-end timing (counts and durations only - no candidate data)
    const timings = {
      ...(searchResult.timings || {}),
      totalMs: Date.now() - runT0,
      stagesMs: { search: searchMs, matching: matchMs, rankingAndMl: rankMs },
      matching: matchingResult.timings || null,
      ml: mlService.getMetrics(),
    };
    try {
      await BgvRun.updateOne({ _id: bgvRun._id }, { $set: { "searchSummary.timings": timings } });
    } catch (e) {
      console.error("Could not store timings:", e.message);
    }
    if (process.env.PERF_LOG !== "false") {
      console.log(`[perf] run-done ${JSON.stringify({ totalMs: timings.totalMs, stagesMs: timings.stagesMs, ml: timings.ml, provider: timings.provider, reuse: timings.reuse, funnel: timings.funnel })}`);
    }

    bgvRun.totalSearchResults = matchingResult.totalSearchResults;
    bgvRun.matchedResults = matchingResult.relevantMatches;
    bgvRun.reviewRequired = matchingResult.reviewRequired;
    bgvRun.status = "COMPLETED"; // finalResult.service sets the real status
    bgvRun.completedAt = new Date();
    await bgvRun.save();

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "MATCHING_COMPLETED",
      previousStatus: "MATCHING",
      newStatus: "COMPLETED",
      description: `Matching completed: ${matchingResult.totalMatches} match(es)`,
      metadata: matchingSummary(matchingResult),
      idempotencyKey: `matching-completed:${bgvRun._id}:${startedAt.getTime()}`,
    });

    // ------------------------------------------
    // STEP 4: FINAL RESULT from documented rules
    // ------------------------------------------
    await recomputeFinalResult(bgvRun._id, { performedBy: reviewer(req) });

    const fresh = await BgvRun.findById(bgvRun._id);

    return res.status(200).json({
      success: true,
      message: "BGV search and matching completed successfully",

      data: {
        bgvRun: runSummary(fresh),

        search: {
          totalResults: searchResult.totalResults || 0,
          newResults: searchResult.newResults || 0,
          updatedResults: searchResult.updatedResults || 0,
          stats: searchResult.stats,
          // per-platform counts and statuses (see also GET /:id/platforms)
          platforms: searchResult.searchSummary?.platforms,
          platformTarget: searchResult.searchSummary?.platformTarget,
          platformCallsUsed: searchResult.searchSummary?.platformCallsUsed,
          platformCallBudget: searchResult.searchSummary?.platformCallBudget,
          platformLogicalRequests: searchResult.searchSummary?.platformLogicalRequests,
          platformRetryAttempts: searchResult.searchSummary?.platformRetryAttempts,
          priorProfilesReused: searchResult.priorProfilesReused || 0,
          verifiedIdentities: searchResult.verifiedIdentities,
          timings,
        },

        matching: matchingSummary(matchingResult),
      },
    });
  } catch (error) {
    console.error("BGV search error:", error);

    // Mark the run as failed - and say so in the audit log.
    // A failed search is never reported as a finished one.
    try {
      // Only the request that claimed the run may mark it as failed.
      const id = loaded?.bgvRun?._id;

      if (claimed && id) {
        const failed = await BgvRun.findByIdAndUpdate(
          id,
          {
            status: "FAILED",
            finalResult: "INCONCLUSIVE",
            finalResultReasons: [`Search failed: ${error.message}`],
            error: { message: error.message, code: "SEARCH_FAILED" },
          },
          { new: true }
        );

        if (failed) {
          await logEvent({
            bgvRun: failed._id,
            candidate: failed.candidate,
            action: "SEARCH_FAILED",
            newStatus: "FAILED",
            description: `Search/matching failed: ${error.message}`,
            idempotencyKey: `search-failed:${failed._id}:${failed.updatedAt?.getTime?.() || Date.now()}`,
          });
        }
      }
    } catch (updateError) {
      console.error("Failed to update BGV run after error:", updateError.message);
    }

    if (!res.headersSent) {
      return sendError(res, 500, "Failed to search and match BGV run", error);
    }
  }
};

// ==========================================
// MATCH EXISTING SEARCH RESULTS
// POST /api/bgv-runs/:id/match
// ==========================================
// This does NOT call Tavily/Serper again.
const matchBgvRun = async (req, res) => {
  try {
    const loaded = await loadRun(req, res);
    if (!loaded) return;

    const { candidate } = loaded;
    const previousStatus = loaded.bgvRun.status;
    const startedAt = new Date();

    const bgvRun = await claimRun(loaded.bgvRun._id, "MATCHING");

    if (!bgvRun) {
      return sendError(
        res,
        409,
        "A search or matching is already running for this BGV run"
      );
    }

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "MATCHING_STARTED",
      previousStatus,
      newStatus: "MATCHING",
      description: "Matching of existing search results started",
      performedBy: reviewer(req),
      idempotencyKey: `matching-started:${bgvRun._id}:${startedAt.getTime()}`,
    });

    console.log(`Starting matching for existing results: ${bgvRun._id}`);

    let matchingResult;

    try {
      matchingResult = await createMatchesForBgvRun({
        candidateId: candidate._id,
        bgvRunId: bgvRun._id,
      });
    } catch (error) {
      await BgvRun.findByIdAndUpdate(bgvRun._id, {
        status: "FAILED",
        finalResult: "INCONCLUSIVE",
        finalResultReasons: [`Matching failed: ${error.message}`],
        error: { message: error.message, code: "MATCHING_FAILED" },
      });

      await logEvent({
        bgvRun: bgvRun._id,
        candidate: candidate._id,
        action: "MATCHING_FAILED",
        newStatus: "FAILED",
        description: `Matching failed: ${error.message}`,
        idempotencyKey: `matching-failed:${bgvRun._id}:${startedAt.getTime()}`,
      });

      throw error;
    }

    await finishMatchingStage(bgvRun._id, matchingResult);

    bgvRun.totalSearchResults = matchingResult.totalSearchResults;
    bgvRun.matchedResults = matchingResult.relevantMatches;
    bgvRun.reviewRequired = matchingResult.reviewRequired;
    bgvRun.status = "COMPLETED";
    bgvRun.completedAt = new Date();
    await bgvRun.save();

    await logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "MATCHING_COMPLETED",
      previousStatus: "MATCHING",
      newStatus: "COMPLETED",
      description: `Matching completed: ${matchingResult.totalMatches} match(es)`,
      metadata: matchingSummary(matchingResult),
      idempotencyKey: `matching-completed:${bgvRun._id}:${startedAt.getTime()}`,
    });

    await recomputeFinalResult(bgvRun._id, { performedBy: reviewer(req) });

    const fresh = await BgvRun.findById(bgvRun._id);

    return res.status(200).json({
      success: true,
      message: "Candidate matching completed successfully",

      data: {
        bgvRun: runSummary(fresh),

        matching: matchingSummary(matchingResult),
      },
    });
  } catch (error) {
    console.error("Match BGV run error:", error);

    if (!res.headersSent) {
      return sendError(res, 500, "Failed to match BGV run", error);
    }
  }
};

// ==========================================
// UPDATE BGV RUN (notes only)
// PATCH /api/bgv-runs/:id
//
// status / finalResult are computed from documented rules; they can not be
// written through this endpoint (use POST /:id/final-result with a reason).
// ==========================================
const updateBgvRun = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    const body = req.body || {};

    const forbidden = Object.keys(body).filter((key) => key !== "notes");

    if (forbidden.length) {
      return sendError(
        res,
        400,
        "Only `notes` can be changed here. finalResult is set by the review rules or POST /:id/final-result",
        null,
        { rejectedFields: forbidden }
      );
    }

    const run = await BgvRun.findByIdAndUpdate(
      id,
      { notes: body.notes },
      { new: true, runValidators: true }
    );

    if (!run) {
      return sendError(res, 404, "BGV run not found");
    }

    return res.status(200).json({
      success: true,
      message: "BGV run updated successfully",
      data: run,
    });
  } catch (error) {
    console.error("Update BGV run error:", error);

    return sendError(res, 500, "Failed to update BGV run", error);
  }
};

// ==========================================
// FINAL RESULT
// GET  /api/bgv-runs/:id/final-result            -> recompute + return
// POST /api/bgv-runs/:id/final-result            -> reviewer decision
//      body: { finalResult, reason }  (reason is mandatory)
// ==========================================
// GET /api/bgv-runs/:id/platforms  - per-platform counts and statuses
const getRunPlatforms = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    if (!(await BgvRun.exists({ _id: id }))) {
      return sendError(res, 404, "BGV run not found");
    }

    return res.status(200).json({ success: true, data: await getPlatformSummary(id) });
  } catch (error) {
    console.error("Get platform summary error:", error);
    return sendError(res, 500, "Failed to load platform summary", error);
  }
};

const getFinalResult = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    const exists = await BgvRun.exists({ _id: id });
    if (!exists) return sendError(res, 404, "BGV run not found");

    await recomputeFinalResult(id, { performedBy: reviewer(req) });

    const run = await BgvRun.findById(id);

    return res.status(200).json({
      success: true,
      data: {
        id: run._id,
        status: run.status,
        finalResult: run.finalResult,
        reasons: run.finalResultReasons,
        computedAt: run.finalResultComputedAt,
        searchSummary: run.searchSummary,
      },
    });
  } catch (error) {
    console.error("Get final result error:", error);

    return sendError(res, 500, "Failed to compute final result", error);
  }
};

const setFinalResult = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    const { finalResult, reason } = req.body || {};

    if (!FINAL_RESULTS.includes(finalResult) || finalResult === "PENDING") {
      return sendError(res, 400, `finalResult must be one of: ${FINAL_RESULTS.join(", ")}`);
    }

    if (typeof reason !== "string" || reason.trim().length < 5) {
      return sendError(res, 400, "A written reason (min 5 characters) is required");
    }

    const exists = await BgvRun.exists({ _id: id });
    if (!exists) return sendError(res, 404, "BGV run not found");

    await recomputeFinalResult(id, {
      performedBy: reviewer(req),
      manualOverride: { finalResult, reason: reason.trim() },
      safe: false,
    });

    const run = await BgvRun.findById(id);

    return res.status(200).json({
      success: true,
      message: "Final result recorded",
      data: {
        id: run._id,
        status: run.status,
        finalResult: run.finalResult,
        reasons: run.finalResultReasons,
      },
    });
  } catch (error) {
    console.error("Set final result error:", error);

    return sendError(res, 500, "Failed to record final result", error);
  }
};

// ==========================================
// FETCH PROFILE IMAGES
// POST /api/bgv-runs/:id/enrich-images
// ==========================================
const enrichBgvRunImages = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    const bgvRun = await BgvRun.findById(id);

    if (!bgvRun) {
      return sendError(res, 404, "BGV run not found");
    }

    const result = await enrichProfileImages(id, {
      force: req.query.force === "true",
    });

    return res.status(200).json({
      success: true,
      message: "Profile images updated",
      data: result,
    });
  } catch (error) {
    console.error("Enrich images error:", error);

    return sendError(res, 500, "Failed to fetch profile images", error);
  }
};

// ==========================================
// RE-NORMALIZE EXISTING SEARCH RESULTS
// POST /api/bgv-runs/:id/renormalize
// ==========================================
const renormalizeBgvRun = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return sendError(res, 400, "Invalid BGV run ID", null, { received: id });
    }

    const bgvRun = await BgvRun.findById(id);

    if (!bgvRun) {
      return sendError(res, 404, "BGV run not found");
    }

    console.log(`Starting re-normalization for BGV run: ${id}`);

    const result = await renormalizeExistingSearchResults({ bgvRunId: id });

    console.log(
      `Re-normalization completed. Updated: ${result.updated}, Skipped: ${result.skipped}`
    );

    return res.status(200).json({
      success: true,
      message: "Existing search results re-normalized successfully",
      data: result,
    });
  } catch (error) {
    console.error("Re-normalize BGV run error:", error);

    return sendError(res, 500, "Failed to re-normalize search results", error);
  }
};

// ==========================================
// EXPORT CONTROLLERS
// ==========================================
module.exports = {
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
};
