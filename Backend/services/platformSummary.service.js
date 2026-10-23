"use strict";

/**
 * Per-platform counts and statuses of a BGV run.
 *
 *   discovered / uniqueUrls / profileShapedUrls / enriched  -> written at search time
 *   relevant / weakIdentity                              -> written after matching
 *
 * `relevant` = profiles the ranking judged relevant (identity evidence beyond
 * a bare name). The shortfall is reported, never padded.
 */

const BgvRun = require("../models/BgvRun");
const { getTopRelevantMatches } = require("./candidateMatchRanking.service");
const { PLATFORMS } = require("../utils/platforms");

const GROUP_ORDER = { CORE: 0, TECH: 1, DESIGN: 2, RESEARCH: 3, OTHER: 4 };

/** Fills `relevant` / `weakIdentity` / `relevanceShortfall` after matching. */
const refreshPlatformRelevance = async (bgvRunId) => {
  const run = await BgvRun.findById(bgvRunId).select("searchSummary").lean();
  const platforms = run?.searchSummary?.platforms;
  if (!platforms) return null;

  const ranked = await getTopRelevantMatches({ bgvRunId, limit: 1 });
  const breakdown = ranked.platformBreakdown || {};

  const $set = {};
  for (const key of Object.keys(platforms)) {
    const b = breakdown[key] || { relevant: 0, weakIdentity: 0, notShown: 0 };
    const target = platforms[key].target;
    const relevant = Math.min(b.relevant, target);

    $set[`searchSummary.platforms.${key}.relevant`] = relevant;
    $set[`searchSummary.platforms.${key}.relevantFound`] = b.relevant;
    $set[`searchSummary.platforms.${key}.weakIdentity`] = b.weakIdentity;
    $set[`searchSummary.platforms.${key}.relevanceShortfall`] = Math.max(target - relevant, 0);
  }

  await BgvRun.updateOne({ _id: bgvRunId }, { $set });
  return breakdown;
};

/** Summary list for the UI, core platforms first. */
const getPlatformSummary = async (bgvRunId) => {
  const run = await BgvRun.findById(bgvRunId).select("searchSummary").lean();
  const platforms = run?.searchSummary?.platforms || {};
  const label = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));

  const list = Object.values(platforms)
    .map((p) => ({
      ...p,
      relevanceStatus:
        p.relevant === undefined
          ? "NOT_RANKED_YET"
          : p.relevant >= p.target
          ? "TARGET_MET"
          : p.relevant > 0
          ? "SHORTFALL"
          : "NONE_RELEVANT",
    }))
    .sort(
      (a, b) =>
        (GROUP_ORDER[label[a.platform]?.group] ?? 9) - (GROUP_ORDER[label[b.platform]?.group] ?? 9) ||
        a.platform.localeCompare(b.platform)
    );

  return {
    target: run?.searchSummary?.platformTarget || null,
    completedAt: run?.searchSummary?.completedAt || null,
    platforms: list,
  };
};

module.exports = { refreshPlatformRelevance, getPlatformSummary };
