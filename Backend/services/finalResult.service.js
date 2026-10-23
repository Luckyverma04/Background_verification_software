/**
 * finalResult.service.js
 *
 * Decides BgvRun.finalResult from DOCUMENTED rules. It never infers
 * employment / education / criminal facts from search snippets - it only
 * looks at (a) how complete the external search was and (b) what the human
 * reviewers decided.
 *
 *   INCONCLUSIVE     search failed / was incomplete, OR the search was
 *                    complete but no profile has been confirmed by a human
 *                    (not finding a profile is NOT proof that none exists)
 *   REVIEW_REQUIRED  there are shortlisted matches no human has decided yet
 *   ISSUE_FOUND      a human-confirmed profile has recorded conflicts with
 *                    what the candidate declared (needs manual follow-up),
 *                    or a reviewer set it explicitly (with a written reason)
 *   CLEAR            search complete + every shortlisted profile reviewed +
 *                    at least one profile confirmed by a human + no
 *                    conflict on a confirmed profile
 *
 * Similarity scores never decide anything on their own.
 */

const BgvRun = require("../models/BgvRun");
const CandidateMatch = require("../models/CandidateMatch");
const Candidate = require("../models/Candidate");

const { logEvent } = require("./verificationLog.service");

const FINAL_RESULTS = ["CLEAR", "REVIEW_REQUIRED", "ISSUE_FOUND", "INCONCLUSIVE"];

// Matches a human is expected to look at.
const REVIEWABLE_STATUSES = ["STRONG", "POSSIBLE", "REVIEW_REQUIRED"];

const MIN_OK_PROVIDER_CALLS = () =>
  Number(process.env.FINAL_MIN_OK_PROVIDER_CALLS) || 3;

/**
 * Was the external search good enough to say anything at all?
 * `summary` is BgvRun.searchSummary, written by the search service.
 */
const assessSearchCoverage = (summary) => {
  if (!summary || typeof summary !== "object") {
    return { adequate: false, reason: "No search has been completed for this run" };
  }

  const calls = Number(summary.providerCalls) || 0;
  const ok = Number(summary.providerCallsOk) || 0;

  if (calls === 0 || ok === 0) {
    return { adequate: false, reason: "No search provider call succeeded" };
  }

  if (ok < MIN_OK_PROVIDER_CALLS()) {
    return {
      adequate: false,
      reason: `Only ${ok} provider call(s) succeeded - coverage too low`,
    };
  }

  // More than half of the calls failed -> results are probably partial.
  if (ok / calls < 0.5) {
    return {
      adequate: false,
      reason: `${calls - ok} of ${calls} provider calls failed - search incomplete`,
    };
  }

  return { adequate: true, reason: "Search coverage adequate" };
};

/**
 * Pure decision function (easy to unit test).
 */
const decideFinalResult = ({ searchSummary, matches = [], manualOverride = null }) => {
  const reasons = [];

  if (manualOverride?.finalResult) {
    return {
      finalResult: manualOverride.finalResult,
      reasons: [
        `Set by reviewer: ${manualOverride.reason || "no reason given"}`,
      ],
      counts: {},
    };
  }

  const coverage = assessSearchCoverage(searchSummary);

  const reviewable = matches.filter((m) =>
    REVIEWABLE_STATUSES.includes(m.matchStatus)
  );
  const pending = reviewable.filter(
    (m) => !m.reviewStatus || m.reviewStatus === "PENDING"
  );
  const approved = matches.filter((m) => m.reviewStatus === "APPROVED");
  const approvedWithConflict = approved.filter(
    (m) => Array.isArray(m.conflictingSignals) && m.conflictingSignals.length > 0
  );

  const counts = {
    totalMatches: matches.length,
    reviewable: reviewable.length,
    pendingReview: pending.length,
    approved: approved.length,
    approvedWithConflict: approvedWithConflict.length,
  };

  // 1. A confirmed profile that contradicts the declared data.
  if (approvedWithConflict.length > 0) {
    reasons.push(
      `${approvedWithConflict.length} human-confirmed profile(s) conflict with the details the candidate declared - manual follow-up needed`
    );
    return { finalResult: "ISSUE_FOUND", reasons, counts };
  }

  // 2. Search failed / incomplete -> we cannot conclude anything.
  if (!coverage.adequate) {
    reasons.push(coverage.reason);
    if (pending.length > 0) {
      reasons.push(`${pending.length} shortlisted profile(s) still need review`);
      return { finalResult: "REVIEW_REQUIRED", reasons, counts };
    }
    return { finalResult: "INCONCLUSIVE", reasons, counts };
  }

  // 3. Humans still have work to do.
  if (pending.length > 0) {
    reasons.push(`${pending.length} shortlisted profile(s) are waiting for human review`);
    return { finalResult: "REVIEW_REQUIRED", reasons, counts };
  }

  // 4. Everything reviewed.
  if (approved.length > 0) {
    reasons.push(
      `${approved.length} profile(s) confirmed by a human reviewer; search coverage adequate; no conflicts recorded`
    );
    return { finalResult: "CLEAR", reasons, counts };
  }

  reasons.push(
    reviewable.length > 0
      ? "All shortlisted profiles were rejected by reviewers - no profile confirmed"
      : "Search finished but no relevant public profile was found. This is not proof that none exists"
  );
  return { finalResult: "INCONCLUSIVE", reasons, counts };
};

const statusForFinalResult = (finalResult) =>
  finalResult === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETED";

/**
 * Recompute and store the final result of a run.
 * - Logs FINAL_RESULT only when the value really changed (retries are
 *   idempotent).
 * - Never throws into the caller's main flow when `safe` is true.
 */
const recomputeFinalResult = async (bgvRunId, { performedBy, manualOverride, safe = true } = {}) => {
  try {
    const run = await BgvRun.findById(bgvRunId);
    if (!run) return null;

    // Do not overwrite a run that is still searching / matching / failed.
    if (["PENDING", "SEARCHING", "MATCHING", "FAILED"].includes(run.status) && !manualOverride) {
      return { finalResult: run.finalResult, skipped: true };
    }

    const matches = await CandidateMatch.find({ bgvRun: run._id })
      .select("matchStatus reviewStatus conflictingSignals")
      .lean();

    const decision = decideFinalResult({
      searchSummary: run.searchSummary,
      matches,
      manualOverride,
    });

    const previous = run.finalResult;
    const changed = previous !== decision.finalResult;

    run.finalResult = decision.finalResult;
    run.finalResultReasons = decision.reasons;
    run.finalResultComputedAt = new Date();
    run.status = statusForFinalResult(decision.finalResult);

    if (decision.finalResult !== "REVIEW_REQUIRED") {
      run.completedAt = run.completedAt || new Date();
    }

    run.reviewRequired = decision.counts.pendingReview ?? run.reviewRequired;

    await run.save();

    // Keep Candidate.verificationStatus in sync (existing enum values).
    await Candidate.findByIdAndUpdate(run.candidate, {
      verificationStatus:
        decision.finalResult === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "COMPLETED",
    });

    if (changed) {
      await logEvent({
        bgvRun: run._id,
        candidate: run.candidate,
        action: "FINAL_RESULT",
        previousStatus: previous,
        newStatus: decision.finalResult,
        description: decision.reasons.join(". "),
        performedBy,
        metadata: { counts: decision.counts, reasons: decision.reasons },
        idempotencyKey: `final:${run._id}:${previous}->${decision.finalResult}:${decision.counts.approved ?? 0}:${decision.counts.pendingReview ?? 0}`,
      });
    }

    return { ...decision, previous, changed };
  } catch (error) {
    if (!safe) throw error;
    console.error("Final result recompute failed:", error.message);
    return null;
  }
};

module.exports = {
  FINAL_RESULTS,
  assessSearchCoverage,
  decideFinalResult,
  recomputeFinalResult,
};
