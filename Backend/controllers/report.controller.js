const BgvRun = require("../models/BgvRun");
const Candidate = require("../models/Candidate");
const CandidateMatch = require("../models/CandidateMatch");
const VerificationLog = require("../models/VerificationLog");
require("../models/User"); // registers the model used by populate("reviewedBy")
const { isValidId, sendError } = require("../utils/http");

const profileOf = (m) => {
  const sr = m.searchResult || {};
  return {
    matchId: m._id,
    platform: sr.platform || null,
    profileUrl: sr.profileUrl || null,
    name: sr.name || null,
    username: sr.username || null,
    jobTitle: sr.jobTitle || null,
    company: sr.company || null,
    location: sr.location || null,
    matchStatus: m.matchStatus || null,
    score: typeof m.similarityScore === "number" ? Math.round(m.similarityScore) : null,
    reviewStatus: m.reviewStatus,
    reviewedAt: m.reviewedAt || null,
    reviewer: m.reviewedBy ? { name: m.reviewedBy.name, email: m.reviewedBy.email } : null,
    notes: m.reviewerNotes || null,
    conflicts: (m.conflictingSignals || []).map((c) => ({ field: c.field, candidateValue: c.candidateValue, foundValue: c.searchResultValue })),
  };
};

// ==========================================
// GET /api/bgv-runs/:id/report
// Everything a printable verification report needs, in one response.
// ==========================================
const getRunReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return sendError(res, 400, "Invalid BGV run ID");

    const run = await BgvRun.findById(id).lean();
    if (!run) return sendError(res, 404, "BGV run not found");
    const candidate = await Candidate.findById(run.candidate).lean();
    if (!candidate) return sendError(res, 404, "Candidate not found");

    const matches = await CandidateMatch.find({ bgvRun: id })
      .populate("searchResult")
      .populate("reviewedBy", "name email")
      .lean();

    const byReview = (st) => matches.filter((m) => m.reviewStatus === st)
      .sort((a, b) => (b.similarityScore || 0) - (a.similarityScore || 0))
      .map(profileOf);

    const countBy = (key) => matches.reduce((acc, m) => {
      const k = m[key] || "UNKNOWN";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});

    const pendingRelevant = matches.filter(
      (m) => m.reviewStatus === "PENDING" && ["STRONG", "POSSIBLE", "REVIEW_REQUIRED"].includes(m.matchStatus)
    ).length;

    const logs = await VerificationLog.find({ bgvRun: id })
      .sort({ createdAt: 1 })
      .limit(300)
      .populate("performedBy", "name")
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        generatedAt: new Date(),
        generatedBy: req.user ? { name: req.user.name, email: req.user.email } : null,
        run: {
          _id: run._id,
          status: run.status,
          finalResult: run.finalResult || null,
          finalResultReasons: run.finalResultReasons || [],
          createdAt: run.createdAt,
          startedAt: run.startedAt || null,
          completedAt: run.completedAt || null,
          totalSearchResults: run.totalSearchResults || matches.length,
        },
        candidate: {
          _id: candidate._id,
          fullName: candidate.fullName,
          email: candidate.email || null,
          phone: candidate.phone || null,
          dateOfBirth: candidate.dateOfBirth || null,
          address: candidate.address || null,
          location: candidate.location || null,
          currentCompany: candidate.currentCompany || null,
          currentJobTitle: candidate.currentJobTitle || null,
          experience: candidate.experience || [],
          education: candidate.education || [],
          sourceImageUrl: candidate.sourceImageUrl || null,
          sheetSource: candidate.sheetSource ? { jobId: candidate.sheetSource.jobId || null } : null,
        },
        summary: {
          discovered: matches.length,
          verified: matches.filter((m) => m.reviewStatus === "APPROVED").length,
          rejected: matches.filter((m) => m.reviewStatus === "REJECTED").length,
          pendingRelevant,
          byMatchStatus: countBy("matchStatus"),
        },
        verifiedProfiles: byReview("APPROVED"),
        rejectedProfiles: byReview("REJECTED"),
        timeline: logs.map((l) => ({
          at: l.createdAt,
          action: l.action,
          description: l.description || null,
          by: l.performedBy?.name || l.metadata?.reviewerLabel || null,
        })),
      },
    });
  } catch (error) {
    return next(error);
  }
};

// ==========================================
// GET /api/stats?days=14&tz=Asia/Kolkata
// Numbers for the dashboard charts.
// ==========================================
const safeTz = (tz) => {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
};

const getStats = async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 7), 90);
    const tz = safeTz(String(req.query.tz || "UTC"));
    const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
    since.setUTCHours(0, 0, 0, 0);
    since.setTime(since.getTime() - 24 * 60 * 60 * 1000); // one extra day so every local day is covered

    const [candidates, runs, runsByStatus, runsByResult, runsPerDay, decisionsPerDay, decisionsByReviewer] = await Promise.all([
      Candidate.countDocuments(),
      BgvRun.countDocuments(),
      BgvRun.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      BgvRun.aggregate([{ $group: { _id: { $ifNull: ["$finalResult", "NONE"] }, count: { $sum: 1 } } }]),
      BgvRun.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: tz } }, count: { $sum: 1 } } },
      ]),
      CandidateMatch.aggregate([
        { $match: { reviewStatus: { $in: ["APPROVED", "REJECTED"] }, reviewedAt: { $gte: since } } },
        {
          $group: {
            _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$reviewedAt", timezone: tz } }, status: "$reviewStatus" },
            count: { $sum: 1 },
          },
        },
      ]),
      CandidateMatch.aggregate([
        { $match: { reviewStatus: { $in: ["APPROVED", "REJECTED"] }, reviewedAt: { $gte: since } } },
        { $group: { _id: { user: "$reviewedBy", status: "$reviewStatus" }, count: { $sum: 1 } } },
        { $lookup: { from: "users", localField: "_id.user", foreignField: "_id", as: "user" } },
      ]),
    ]);

    // continuous list of local days, oldest first
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i--) dayKeys.push(fmt.format(new Date(Date.now() - i * 24 * 60 * 60 * 1000)));
    const runMap = Object.fromEntries(runsPerDay.map((r) => [r._id, r.count]));
    const decided = {};
    for (const d of decisionsPerDay) {
      decided[d._id.day] = decided[d._id.day] || { approved: 0, rejected: 0 };
      decided[d._id.day][d._id.status === "APPROVED" ? "approved" : "rejected"] += d.count;
    }

    const reviewers = {};
    for (const r of decisionsByReviewer) {
      const key = r._id.user ? String(r._id.user) : "unknown";
      const name = r.user?.[0]?.name || "Before login (unknown)";
      reviewers[key] = reviewers[key] || { name, approved: 0, rejected: 0 };
      reviewers[key][r._id.status === "APPROVED" ? "approved" : "rejected"] += r.count;
    }

    const toObj = (rows) => Object.fromEntries(rows.map((r) => [r._id || "NONE", r.count]));

    return res.status(200).json({
      success: true,
      data: {
        days,
        timezone: tz,
        totals: { candidates, runs },
        runsByStatus: toObj(runsByStatus),
        runsByResult: toObj(runsByResult),
        daily: dayKeys.map((day) => ({
          day,
          runs: runMap[day] || 0,
          approved: decided[day]?.approved || 0,
          rejected: decided[day]?.rejected || 0,
        })),
        reviewers: Object.values(reviewers).sort((a, b) => b.approved + b.rejected - (a.approved + a.rejected)),
      },
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = { getRunReport, getStats };
