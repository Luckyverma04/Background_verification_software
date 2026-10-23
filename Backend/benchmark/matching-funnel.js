"use strict";

/**
 * Per-stage funnel for the labelled matching dataset.
 *   node benchmark/matching-funnel.js                # current services
 *   SERVICES_DIR=/path/to/old/services node ...      # compare with an older tree
 * No network, no DB, no ML call.
 */
const path = require("path");
const dir = process.env.SERVICES_DIR || path.join(__dirname, "..", "services");
process.env.RANK_WEAK_FILL_BELOW = process.env.RANK_WEAK_FILL_BELOW || "3";

const { CANDIDATE, build } = require("./matching-dataset");
const matcher = require(path.join(dir, "candidateMatch.service.js"));
const ranking = require(path.join(dir, "candidateMatchRanking.service.js"));

(async () => {
  const items = build();
  const label = new Map(items.map((i) => [i.searchResult._id, i.label]));

  const matches = items.map(({ searchResult }) => {
    const m = matcher.calculateCandidateMatch(CANDIDATE, searchResult);
    return { _id: `m-${searchResult._id}`, candidate: CANDIDATE, searchResult, ...m };
  });

  const byStatus = {};
  matches.forEach((m) => (byStatus[m.matchStatus] = (byStatus[m.matchStatus] || 0) + 1));

  const relevantTotal = items.filter((i) => i.label === "RELEVANT").length;
  const out = await ranking.shortlistMatches(matches, {
    config: { ml: { enabled: false } },
    limit: 50,
  });
  // everything a reviewer can reach: the shortlist + the "excluded" view
  const excluded = await ranking.shortlistMatches(matches, {
    config: { ml: { enabled: false } },
    limit: 50,
    view: "excluded",
  });
  const all = { data: [] };
  for (let pg = 1; pg <= excluded.pagination.totalPages; pg++) {
    const r = await ranking.shortlistMatches(matches, { config: { ml: { enabled: false } }, limit: 50, view: "excluded", page: pg });
    all.data.push(...r.data);
  }
  all.data.push(...out.data);

  const shown = out.data.map((d) => label.get(d.searchResult._id));
  const top15 = shown.slice(0, 15);
  const tp15 = top15.filter((l) => l === "RELEVANT").length;
  const relevantShown = shown.filter((l) => l === "RELEVANT").length;
  const reachable = new Set(all.data.map((d) => d.searchResult._id));
  const relevantReachable = items.filter((i) => i.label === "RELEVANT" && reachable.has(i.searchResult._id)).length;

  const statusOfRelevant = {};
  matches.forEach((m) => {
    if (label.get(m.searchResult._id) === "RELEVANT") {
      statusOfRelevant[m.matchStatus] = (statusOfRelevant[m.matchStatus] || 0) + 1;
    }
  });

  const report = {
    discovered: items.length,
    matchStatus: byStatus,
    relevantLabelled: relevantTotal,
    relevantStatus: statusOfRelevant,
    eligible: out.eligibleMatches,
    counts: out.counts,
    excludedByReason: out.excludedByReason,
    excludedViewSize: excluded.pagination.total,
    shortlistSize: out.totalShortlist,
    relevantInDefaultShortlist: relevantShown,
    relevantReachableViaAll: relevantReachable,
    "precision@15": Number((tp15 / Math.max(top15.length, 1)).toFixed(2)),
    recallInShortlist: Number((relevantShown / relevantTotal).toFixed(2)),
    recallAnywhereInUi: Number((relevantReachable / relevantTotal).toFixed(2)),
  };
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
