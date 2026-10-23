const mongoose = require("mongoose");
const { getCandidateSocialUrls } = require("../utils/candidateUrls");

const Evidence = require("../models/Evidence");
const CandidateMatch = require("../models/CandidateMatch");
const IdentityGroup = require("../models/IdentityGroup");
const SearchResult = require("../models/SearchResult");
const Candidate = require("../models/Candidate");

const createServiceError = (message, statusCode = 400, details = {}) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

// ======================================================
// HELPERS
// ======================================================

const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

const safeString = (value) => {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim();
};

// ======================================================
// CREATE EVIDENCE FROM CANDIDATE MATCH
// ======================================================

const createEvidenceFromCandidateMatch = async ({
  candidateMatchId,
}) => {
  if (!isValidObjectId(candidateMatchId)) {
    throw createServiceError(
      "Invalid Candidate Match ID",
      400
    );
  }

  const candidateMatch = await CandidateMatch.findById(
    candidateMatchId
  )
    .populate("candidate")
    .populate("bgvRun")
    .populate("searchResult");

  if (!candidateMatch) {
    throw createServiceError(
      "Candidate match not found",
      404
    );
  }

  const candidate = candidateMatch.candidate;
  const searchResult = candidateMatch.searchResult;

  if (!candidate || !searchResult) {
    throw createServiceError(
      "Candidate or SearchResult missing from CandidateMatch",
      400
    );
  }

  const evidence = [];

  const pushEvidence = ({
    evidenceType,
    field,
    candidateValue,
    observedValue,
    matchScore,
    description,
  }) => {
    const candidateText = safeString(candidateValue);
    const observedText = safeString(observedValue);

    // Missing information should not become evidence.
    if (!candidateText && !observedText) {
      return;
    }

    evidence.push({
      bgvRun: candidateMatch.bgvRun._id,
      candidate: candidate._id,
      searchResult: searchResult._id,
      candidateMatch: candidateMatch._id,

      evidenceType,

      sourcePlatform: searchResult.platform || "OTHER",

      sourceUrl:
        searchResult.profileUrl ||
        searchResult.sourceUrl ||
        undefined,

      field,

      candidateValue: candidateText || undefined,
      observedValue: observedText || undefined,

      matchScore,

      description,

      metadata: {
        matchStatus: candidateMatch.matchStatus,
        similarityScore:
          candidateMatch.similarityScore,
      },
    });
  };

  // ====================================================
  // NAME
  // ====================================================

  if (candidateMatch.matchedSignals?.name?.matched) {
    pushEvidence({
      evidenceType: "NAME",
      field: "fullName",
      candidateValue: candidate.fullName,
      observedValue: searchResult.name,
      matchScore:
        candidateMatch.matchedSignals.name.score,
      description:
        "Candidate name matched the discovered profile name.",
    });
  }

  // ====================================================
  // COMPANY
  // ====================================================

  if (candidateMatch.matchedSignals?.company?.matched) {
    pushEvidence({
      evidenceType: "COMPANY",
      field: "currentCompany",
      candidateValue: candidate.currentCompany,
      observedValue: searchResult.company,
      matchScore:
        candidateMatch.matchedSignals.company.score,
      description:
        "Candidate company matched the discovered profile company.",
    });
  }

  // ====================================================
  // JOB TITLE
  // ====================================================

  if (candidateMatch.matchedSignals?.jobTitle?.matched) {
    pushEvidence({
      evidenceType: "JOB_TITLE",
      field: "currentJobTitle",
      candidateValue: candidate.currentJobTitle,
      observedValue: searchResult.jobTitle,
      matchScore:
        candidateMatch.matchedSignals.jobTitle.score,
      description:
        "Candidate job title matched the discovered profile job title.",
    });
  }

  // ====================================================
  // LOCATION
  // ====================================================

  if (candidateMatch.matchedSignals?.location?.matched) {
    const candidateLocation = [
      candidate.location?.city,
      candidate.location?.state,
      candidate.location?.country,
    ]
      .filter(Boolean)
      .join(", ");

    const resultLocation = [
      searchResult.location?.city,
      searchResult.location?.state,
      searchResult.location?.country,
    ]
      .filter(Boolean)
      .join(", ");

    pushEvidence({
      evidenceType: "LOCATION",
      field: "location",
      candidateValue: candidateLocation,
      observedValue: resultLocation,
      matchScore:
        candidateMatch.matchedSignals.location.score,
      description:
        "Candidate location matched the discovered profile location.",
    });
  }

  // ====================================================
  // USERNAME
  // ====================================================

  if (candidateMatch.matchedSignals?.username?.matched) {
    pushEvidence({
      evidenceType: "USERNAME",
      field: "username",
      candidateValue:
        Object.values(
          getCandidateSocialUrls(candidateMatch.candidate)
        ).join(", "),
      observedValue: searchResult.username,
      matchScore:
        candidateMatch.matchedSignals.username.score,
      description:
        "Discovered username matched candidate social profile information.",
    });
  }

  // ====================================================
  // PROFILE URL
  // ====================================================

  if (candidateMatch.matchedSignals?.profileUrl?.matched) {
    pushEvidence({
      evidenceType: "SOCIAL_LINK",
      field: "profileUrl",
      candidateValue:
        searchResult.profileUrl,
      observedValue:
        searchResult.profileUrl,
      matchScore:
        candidateMatch.matchedSignals.profileUrl.score,
      description:
        "Discovered profile URL directly matched a known candidate profile URL.",
    });
  }

  // ====================================================
  // EDUCATION
  // ====================================================

  if (candidateMatch.matchedSignals?.education?.matched) {
    const candidateEducation =
      Array.isArray(candidate.education)
        ? candidate.education
            .map((item) =>
              [
                item.institution,
                item.degree,
                item.fieldOfStudy,
              ]
                .filter(Boolean)
                .join(" - ")
            )
            .filter(Boolean)
            .join("; ")
        : "";

    const resultEducation =
      Array.isArray(searchResult.education)
        ? searchResult.education
            .map((item) =>
              [
                item.institution,
                item.degree,
                item.fieldOfStudy,
              ]
                .filter(Boolean)
                .join(" - ")
            )
            .filter(Boolean)
            .join("; ")
        : "";

    pushEvidence({
      evidenceType: "EDUCATION",
      field: "education",
      candidateValue: candidateEducation,
      observedValue: resultEducation,
      matchScore:
        candidateMatch.matchedSignals.education.score,
      description:
        "Candidate education matched the discovered profile education.",
    });
  }

  if (!evidence.length) {
    return {
      created: 0,
      reused: 0,
      evidence: [],
    };
  }

  // Avoid duplicate evidence for the same match/field.
  // (Also enforced by a unique index, so a retry or a parallel request can
  // never create the same evidence twice.)
  const savedEvidence = [];
  let created = 0;
  let reused = 0;

  for (const item of evidence) {
    const key = {
      candidateMatch: item.candidateMatch,
      searchResult: item.searchResult,
      evidenceType: item.evidenceType,
      field: item.field,
    };

    const existing = await Evidence.findOne(key);

    if (existing) {
      reused += 1;
      savedEvidence.push(existing);
      continue;
    }

    try {
      savedEvidence.push(await Evidence.create(item));
      created += 1;
    } catch (error) {
      if (error && error.code === 11000) {
        const duplicate = await Evidence.findOne(key);
        if (duplicate) {
          reused += 1;
          savedEvidence.push(duplicate);
          continue;
        }
      }
      throw error;
    }
  }

  return {
    created,
    reused,
    bgvRun: candidateMatch.bgvRun?._id || candidateMatch.bgvRun,
    candidate: candidate._id,
    evidence: savedEvidence,
  };
};

// ======================================================
// CREATE EVIDENCE FOR AN IDENTITY GROUP
// ======================================================

const createEvidenceForIdentityGroup = async ({
  identityGroupId,
}) => {
  if (!isValidObjectId(identityGroupId)) {
    throw createServiceError(
      "Invalid Identity Group ID",
      400
    );
  }

  const identityGroup =
    await IdentityGroup.findById(identityGroupId)
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResults");

  if (!identityGroup) {
    throw createServiceError(
      "Identity group not found",
      404
    );
  }

  const results = [];
  let created = 0;
  let reused = 0;

  for (const searchResult of identityGroup.searchResults) {
    const candidateMatch =
      await CandidateMatch.findOne({
        bgvRun: identityGroup.bgvRun._id,
        candidate: identityGroup.candidate._id,
        searchResult: searchResult._id,
        reviewStatus: "APPROVED",
      });

    if (!candidateMatch) {
      continue;
    }

    const matchEvidence =
      await createEvidenceFromCandidateMatch({
        candidateMatchId: candidateMatch._id,
      });

    for (const item of matchEvidence.evidence) {
      await Evidence.findByIdAndUpdate(
        item._id,
        {
          identityGroup: identityGroup._id,
        },
        { new: true }
      );
    }

    results.push(...matchEvidence.evidence);
    created += matchEvidence.created;
    reused += matchEvidence.reused;
  }

  return {
    identityGroupId: identityGroup._id,
    bgvRun: identityGroup.bgvRun._id,
    candidate: identityGroup.candidate._id,
    totalEvidence: results.length,
    created,
    reused,
    evidence: results,
  };
};

module.exports = {
  createEvidenceFromCandidateMatch,
  createEvidenceForIdentityGroup,
};