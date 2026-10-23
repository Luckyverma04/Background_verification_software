"use strict";

/**
 * identityKnowledge.service.js
 *
 * Cross-run identity knowledge base.
 *
 * The database gets more useful as humans confirm profiles: an APPROVED
 * IdentityGroup (human-confirmed) from an EARLIER BGV run can seed a new run
 * so reviewers do not start from zero and we skip needless API calls.
 *
 * SAFETY RULES
 *  - Only human-confirmed (APPROVED) IdentityGroups are reused.
 *  - A group is linked to a candidate only through RELIABLE identifiers:
 *      * the very same Candidate record, or
 *      * another Candidate record that shares an e-mail / phone number /
 *        social-profile URL AND at least one name token.
 *    A name (or company / city / similar username) alone is NEVER enough.
 *  - Reused profiles are copied into the new run as ordinary SearchResults
 *    (source = KNOWLEDGE_BASE) and stay PENDING: nothing is auto-approved,
 *    the reviewer still decides. The old run, its decisions, its evidence
 *    and its groups are never modified.
 *  - No duplicate SearchResult is created (unique per run + profileUrl).
 */

const mongoose = require("mongoose");

const IdentityGroup = require("../models/IdentityGroup");
const SearchResult = require("../models/SearchResult");
const Candidate = require("../models/Candidate");

const { getCandidateSocialUrls, canonicalProfileKey } = require("../utils/candidateUrls");
const { normalizeUrl } = require("./resultMerge.service");

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim());

const digitsOnly = (v) => clean(v).replace(/\D+/g, "");

// Compare phones by their last 10 digits (ignores +91 / 0 prefixes).
const phoneKey = (v) => {
  const d = digitsOnly(v);
  return d.length >= 10 ? d.slice(-10) : "";
};

const nameTokens = (name) =>
  clean(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

const sharesNameToken = (a, b) => {
  const setB = new Set(nameTokens(b));
  return nameTokens(a).some((t) => setB.has(t));
};

/**
 * Candidate records that are the same person as `candidate` according to a
 * reliable identifier. Always includes the candidate itself.
 */
const findRelatedCandidateIds = async (candidate) => {
  const ids = new Map();
  ids.set(String(candidate._id), "SAME_CANDIDATE");

  const email = clean(candidate.email).toLowerCase();
  const phone = phoneKey(candidate.phone);
  const links = Object.values(getCandidateSocialUrls(candidate))
    .map(canonicalProfileKey)
    .filter(Boolean);

  const or = [];
  if (email) or.push({ email });
  if (phone) {
    // stored phones may have different formatting: match on the last digits
    or.push({ phone: new RegExp(`${phone.split("").join("\\D*")}\\D*$`) });
  }
  if (!or.length && !links.length) return ids;

  const linkFieldClauses = [];
  for (const field of ["linkedin", "github", "twitter", "instagram", "facebook"]) {
    if (candidate[field]) linkFieldClauses.push({ [field]: { $exists: true, $ne: "" } });
  }

  const others = await Candidate.find({
    _id: { $ne: candidate._id },
    $or: [...or, ...linkFieldClauses],
  })
    .select("fullName email phone linkedin github twitter instagram facebook website")
    .limit(200)
    .lean();

  for (const other of others) {
    // A reliable identifier AND a shared name token are both required.
    if (!sharesNameToken(candidate.fullName, other.fullName)) continue;

    let reason = null;

    if (email && clean(other.email).toLowerCase() === email) reason = "SAME_EMAIL";
    else if (phone && phoneKey(other.phone) === phone) reason = "SAME_PHONE";
    else {
      const otherLinks = new Set(
        Object.values(getCandidateSocialUrls(other)).map(canonicalProfileKey).filter(Boolean)
      );
      if (links.some((k) => otherLinks.has(k))) reason = "SAME_PROFILE_LINK";
    }

    if (reason) ids.set(String(other._id), reason);
  }

  return ids;
};

/**
 * Human-confirmed profiles from EARLIER runs for this candidate.
 */
const getConfirmedProfiles = async ({ candidate, excludeBgvRunId }) => {
  const related = await findRelatedCandidateIds(candidate);

  const query = {
    reviewStatus: "APPROVED",
    candidate: { $in: [...related.keys()].map((id) => new mongoose.Types.ObjectId(id)) },
  };
  if (excludeBgvRunId && mongoose.Types.ObjectId.isValid(String(excludeBgvRunId))) {
    query.bgvRun = { $ne: new mongoose.Types.ObjectId(String(excludeBgvRunId)) };
  }

  const groups = await IdentityGroup.find(query)
    .populate({ path: "searchResults", model: "SearchResult" })
    .sort({ reviewedAt: -1, updatedAt: -1 })
    .limit(100)
    .lean();

  const profiles = [];
  const seen = new Set();

  for (const group of groups) {
    for (const sr of group.searchResults || []) {
      if (!sr || !sr.profileUrl) continue;

      const key = canonicalProfileKey(sr.profileUrl);
      if (!key || seen.has(key)) continue;
      seen.add(key);

      profiles.push({
        key,
        searchResult: sr,
        identityGroupId: group._id,
        fromBgvRun: group.bgvRun,
        fromCandidate: group.candidate,
        linkedBy: related.get(String(group.candidate)) || "SAME_CANDIDATE",
        confirmedAt: group.reviewedAt || group.updatedAt,
        reviewerNotes: group.reviewerNotes || null,
      });
    }
  }

  return profiles;
};

/**
 * Copy previously confirmed profiles into the new run (once each).
 * Returns what was reused so the caller can log it and skip redundant
 * external queries for platforms that are already covered.
 */
const seedKnowledgeBaseResults = async ({ candidate, bgvRunId, skipKeys = null }) => {
  let confirmed = await getConfirmedProfiles({
    candidate,
    excludeBgvRunId: bgvRunId,
  });
  // profiles already in the permanent verified registry of THIS candidate are
  // handled there ("Previously Verified"); they must not be asked about again
  if (skipKeys && skipKeys.size) confirmed = confirmed.filter((c) => !skipKeys.has(c.key));

  const out = {
    found: confirmed.length,
    created: 0,
    alreadyPresent: 0,
    platforms: [],
    profileUrls: [],
    groups: [...new Set(confirmed.map((c) => String(c.identityGroupId)))],
    runs: [...new Set(confirmed.map((c) => String(c.fromBgvRun)))],
  };

  if (!confirmed.length) return out;

  const platforms = new Set();

  for (const item of confirmed) {
    const src = item.searchResult;
    const profileUrl = normalizeUrl(src.profileUrl) || src.profileUrl;

    const knowledgeBase = {
      fromBgvRun: item.fromBgvRun,
      fromIdentityGroup: item.identityGroupId,
      fromSearchResult: src._id,
      linkedBy: item.linkedBy,
      confirmedAt: item.confirmedAt,
      reviewerNotes: item.reviewerNotes,
      note: "Previously confirmed by a human reviewer in an earlier run. Not auto-approved: please review again.",
    };

    platforms.add(src.platform);
    out.profileUrls.push(profileUrl);

    const existing = await SearchResult.findOne({ bgvRun: bgvRunId, profileUrl });

    if (existing) {
      out.alreadyPresent += 1;
      // Only annotate (keep every existing value).
      await SearchResult.updateOne(
        { _id: existing._id, "rawData.knowledgeBase": { $exists: false } },
        { $set: { "rawData.knowledgeBase": knowledgeBase } }
      );
      continue;
    }

    try {
      await SearchResult.create({
        bgvRun: bgvRunId,
        platform: src.platform,
        profileUrl,
        profileId: src.profileId,
        username: src.username,
        name: src.name,
        profileImageUrl: src.profileImageUrl,
        profileImageUrls: src.profileImageUrls || [],
        company: src.company,
        jobTitle: src.jobTitle,
        location: src.location,
        education: src.education,
        source: "KNOWLEDGE_BASE",
        searchProvider: "OTHER",
        sourceUrl: profileUrl,
        rawData: {
          providers: [],
          providerResultIds: [],
          providerResults: [],
          title: src.rawData?.title || null,
          snippet: src.rawData?.snippet || null,
          knowledgeBase,
        },
      });
      out.created += 1;
    } catch (error) {
      // Parallel run created it first - fine, nothing to do.
      if (error && error.code === 11000) {
        out.alreadyPresent += 1;
      } else {
        throw error;
      }
    }
  }

  out.platforms = [...platforms];
  return out;
};

module.exports = {
  findRelatedCandidateIds,
  getConfirmedProfiles,
  seedKnowledgeBaseResults,
};
