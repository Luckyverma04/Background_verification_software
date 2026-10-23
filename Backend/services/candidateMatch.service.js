const crypto = require("crypto");
const verifiedIdentities = require("./verifiedIdentity.service");
const Candidate = require("../models/Candidate");
const {
  getCandidateSocialUrls,
  canonicalProfileKey,
} = require("../utils/candidateUrls");
const SearchResult = require("../models/SearchResult");
const CandidateMatch = require("../models/CandidateMatch");
const BgvRun = require("../models/BgvRun");

const { URL } = require("url");
const signals = require("./matchSignals.service");

// ============================================================
// NORMALIZE TEXT
// ============================================================

const normalizeText = (value) => {
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .replace(/[^\w\s@.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

// ============================================================
// TEXT SIMILARITY
// ============================================================

const calculateTextSimilarity = (candidateValue, resultValue) => {
  const a = normalizeText(candidateValue);
  const b = normalizeText(resultValue);

  // UNKNOWN
  if (!a || !b) {
    return null;
  }

  // Exact
  if (a === b) {
    return 100;
  }

  // One contains the other
  if (a.includes(b) || b.includes(a)) {
    return 85;
  }

  const aWords = new Set(a.split(/\s+/).filter(Boolean));
  const bWords = new Set(b.split(/\s+/).filter(Boolean));

  const intersection = [...aWords].filter((word) =>
    bWords.has(word)
  );

  if (!intersection.length) {
    return 0;
  }

  const union = new Set([...aWords, ...bWords]);

  return Math.round(
    (intersection.length / union.size) * 100
  );
};

// ============================================================
// URL NORMALIZATION
// ============================================================

const normalizeUrl = (value) => {
  if (!value) return "";

  try {
    const parsed = new URL(String(value).trim());

    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();

    parsed.hash = "";

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "fbclid",
      "gclid",
    ].forEach((param) => {
      parsed.searchParams.delete(param);
    });

    parsed.pathname = parsed.pathname.replace(/\/+$/, "");

    return parsed.toString();
  } catch {
    return String(value)
      .trim()
      .toLowerCase()
      .replace(/\/+$/, "");
  }
};

// ============================================================
// URL SIMILARITY
// ============================================================

const calculateUrlSimilarity = (candidateUrl, resultUrl) => {
  const a = canonicalProfileKey(candidateUrl);
  const b = canonicalProfileKey(resultUrl);

  if (!a || !b) {
    return null;
  }

  if (a === b) {
    return 100;
  }

  return 0;
};

// ============================================================
// GET RAW SEARCH TEXT
// ============================================================

const getSearchResultText = (searchResult) => {
  if (!searchResult) return "";

  const parts = [
    searchResult.name,
    searchResult.username,
    searchResult.headline,
    searchResult.company,
    searchResult.jobTitle,
    searchResult.profileUrl,
    searchResult.sourceUrl,
  ];

  const raw = searchResult.rawData;

  if (raw) {
    if (typeof raw === "string") {
      parts.push(raw);
    } else if (typeof raw === "object") {
      const rawValues = [
        raw.title,
        raw.name,
        raw.snippet,
        raw.description,
        raw.content,
        raw.text,
        raw.headline,
        raw.bio,
        raw.profile,
        raw.jobTitle,
        raw.company,
        raw.position,
        raw.occupation,
        raw.location,
      ];

      rawValues.forEach((value) => {
        if (typeof value === "string") {
          parts.push(value);
        }
      });

    }
  }

  return normalizeText(parts.filter(Boolean).join(" "));
};

// Text used for "mentioned in the result" evidence: the provider's own
// title/snippet/headline only (no URLs, no candidate-derived fields).
const getEvidenceText = (searchResult) => {
  if (!searchResult) return "";
  const raw = searchResult.rawData && typeof searchResult.rawData === "object" ? searchResult.rawData : {};
  return normalizeText(
    [
      searchResult.headline,
      searchResult.bio,
      raw.title,
      raw.snippet,
      raw.description,
    ]
      .filter((v) => typeof v === "string" && v)
      .join(" ")
  );
};

// ============================================================
// LOCATION MATCH
// Missing location fields = UNKNOWN
// ============================================================

const calculateLocationMatch = (
  candidateLocation,
  resultLocation
) => {
  if (!candidateLocation || !resultLocation) {
    return null;
  }

  const fields = [
    ["city", candidateLocation.city, resultLocation.city],
    ["state", candidateLocation.state, resultLocation.state],
    ["country", candidateLocation.country, resultLocation.country],
  ];

  const available = fields.filter(
    ([, candidateValue, resultValue]) =>
      candidateValue && resultValue
  );

  if (!available.length) {
    return null;
  }

  const scores = available.map(
    ([, candidateValue, resultValue]) =>
      calculateTextSimilarity(
        candidateValue,
        resultValue
      )
  );

  const validScores = scores.filter(
    (score) => score !== null
  );

  if (!validScores.length) {
    return null;
  }

  return Math.round(
    validScores.reduce(
      (sum, score) => sum + score,
      0
    ) / validScores.length
  );
};

// ============================================================
// LOCATION CONFLICT DETAILS
// ============================================================

const getLocationConflicts = (
  candidateLocation,
  resultLocation
) => {
  const conflicts = [];

  if (!candidateLocation || !resultLocation) {
    return conflicts;
  }

  const fields = [
    ["city", candidateLocation.city, resultLocation.city],
    ["state", candidateLocation.state, resultLocation.state],
    ["country", candidateLocation.country, resultLocation.country],
  ];

  for (const [field, candidateValue, resultValue] of fields) {
    if (!candidateValue || !resultValue) {
      continue;
    }

    const score = calculateTextSimilarity(
      candidateValue,
      resultValue
    );

    if (score !== null && score < 40) {
      conflicts.push({
        field: `location.${field}`,
        candidateValue,
        searchResultValue: resultValue,
        reason: `${field} values are significantly different`,
      });
    }
  }

  return conflicts;
};

// ============================================================
// EDUCATION MATCH
// Missing education = UNKNOWN
// ============================================================

const calculateEducationMatch = (
  candidateEducation,
  resultEducation
) => {
  if (
    !Array.isArray(candidateEducation) ||
    !Array.isArray(resultEducation) ||
    !candidateEducation.length ||
    !resultEducation.length
  ) {
    return null;
  }

  let bestScore = 0;
  let foundComparableData = false;

  for (const candidateEdu of candidateEducation) {
    for (const resultEdu of resultEducation) {
      const comparisons = [];

      if (
        candidateEdu.institution &&
        resultEdu.institution
      ) {
        comparisons.push(
          calculateTextSimilarity(
            candidateEdu.institution,
            resultEdu.institution
          )
        );
      }

      if (
        candidateEdu.degree &&
        resultEdu.degree
      ) {
        comparisons.push(
          calculateTextSimilarity(
            candidateEdu.degree,
            resultEdu.degree
          )
        );
      }

      if (
        candidateEdu.fieldOfStudy &&
        resultEdu.fieldOfStudy
      ) {
        comparisons.push(
          calculateTextSimilarity(
            candidateEdu.fieldOfStudy,
            resultEdu.fieldOfStudy
          )
        );
      }

      const validScores = comparisons.filter(
        (score) => score !== null
      );

      if (!validScores.length) {
        continue;
      }

      foundComparableData = true;

      const score =
        validScores.reduce(
          (sum, value) => sum + value,
          0
        ) / validScores.length;

      bestScore = Math.max(
        bestScore,
        score
      );
    }
  }

  if (!foundComparableData) {
    return null;
  }

  return Math.round(bestScore);
};

// ============================================================
// CANDIDATE SOCIAL URLS
// ============================================================

const getCandidateUrls = (candidate) => {
  // Reads the flat Candidate fields (linkedin, github, ...)
  return Object.values(
    getCandidateSocialUrls(candidate)
  );
};

// ============================================================
// DIRECT URL MATCH
// ============================================================

const findDirectUrlMatch = (
  candidate,
  searchResult
) => {
  if (!searchResult?.profileUrl) {
    return false;
  }

  const candidateUrls =
    getCandidateUrls(candidate);

  if (!candidateUrls.length) {
    return false;
  }

  return candidateUrls.some(
    (candidateUrl) =>
      calculateUrlSimilarity(
        candidateUrl,
        searchResult.profileUrl
      ) === 100
  );
};

// ============================================================
// JOB / DOMAIN KEYWORDS
// ============================================================

const JOB_DOMAINS = {
  software: [
    "software developer",
    "software engineer",
    "full stack developer",
    "full stack engineer",
    "frontend developer",
    "frontend engineer",
    "backend developer",
    "backend engineer",
    "web developer",
    "web engineer",
    "application developer",
    "application engineer",
    "node js developer",
    "node.js developer",
    "react developer",
    "javascript developer",
    "typescript developer",
    "programmer",
    "software development",
    "web development",
    "developer",
  ],

  data: [
    "data scientist",
    "data analyst",
    "machine learning engineer",
    "ml engineer",
    "ai engineer",
    "artificial intelligence",
    "data engineer",
  ],

  devops: [
    "devops engineer",
    "devops",
    "cloud engineer",
    "site reliability engineer",
    "sre",
    "platform engineer",
  ],

  design: [
    "interior designer",
    "graphic designer",
    "fashion designer",
    "ui designer",
    "ux designer",
    "product designer",
    "architect",
  ],

  sports: [
    "professional cricketer",
    "cricketer",
    "footballer",
    "professional footballer",
    "athlete",
    "kabaddi player",
    "sportsman",
    "sportsperson",
  ],

  politics: [
    "politician",
    "political leader",
    "member of parliament",
    "mla",
    "mp",
    "minister",
    "political secretary",
    "congress leader",
    "bjp leader",
  ],

  research: [
    "researcher",
    "research scientist",
    "research fellow",
    "professor",
    "academic researcher",
  ],
};

// ============================================================
// GET CANDIDATE JOB TEXT
// ============================================================

const getCandidateJobText = (candidate) => {
  return normalizeText(
    [
      candidate?.currentJobTitle,
      ...(Array.isArray(candidate?.experience)
        ? candidate.experience.map((e) => e?.jobTitle)
        : []),
    ]
      .filter(Boolean)
      .join(" ")
  );
};

// ============================================================
// GET RESULT JOB TEXT
// ============================================================

const getResultJobText = (searchResult) => {
  if (!searchResult) return "";

  const parts = [
    searchResult.jobTitle,
    searchResult.headline,
  ];

  const raw = searchResult.rawData;

  if (raw && typeof raw === "object") {
    parts.push(
      raw.jobTitle,
      raw.position,
      raw.role,
      raw.occupation,
      raw.headline,
      raw.title,
      raw.description,
      raw.snippet,
      raw.bio
    );
  }

  if (raw && typeof raw === "string") {
    parts.push(raw);
  }

  return normalizeText(
    parts.filter(Boolean).join(" ")
  );
};

// ============================================================
// DOMAIN DETECTION
// ============================================================

const detectDomains = (text) => {
  const normalized = normalizeText(text);

  if (!normalized) {
    return [];
  }

  const detected = [];

  for (const [domain, keywords] of Object.entries(
    JOB_DOMAINS
  )) {
    const found = keywords.some((keyword) =>
      normalized.includes(
        normalizeText(keyword)
      )
    );

    if (found) {
      detected.push(domain);
    }
  }

  return detected;
};

// ============================================================
// JOB / DOMAIN RELEVANCE
//
// Returns:
// positive = related
// negative = conflicting
// null = unknown
// ============================================================

const calculateJobDomainRelevance = (
  candidate,
  searchResult
) => {
  const candidateJob =
    getCandidateJobText(candidate);

  const resultJob =
    getResultJobText(searchResult);

  if (!candidateJob || !resultJob) {
    return {
      score: null,
      candidateDomains: [],
      resultDomains: [],
      reason: "Job/domain information is unknown",
    };
  }

  const candidateDomains =
    detectDomains(candidateJob);

  const resultDomains =
    detectDomains(resultJob);

  if (!candidateDomains.length) {
    return {
      score: null,
      candidateDomains,
      resultDomains,
      reason:
        "Candidate job domain could not be classified",
    };
  }

  if (!resultDomains.length) {
    return {
      score: null,
      candidateDomains,
      resultDomains,
      reason:
        "Search result job domain could not be classified",
    };
  }

  const sameDomain =
    candidateDomains.some((domain) =>
      resultDomains.includes(domain)
    );

  if (sameDomain) {
    return {
      score: 100,
      candidateDomains,
      resultDomains,
      reason:
        "Candidate and search result belong to a related job domain",
    };
  }

  return {
    score: 0,
    candidateDomains,
    resultDomains,
    reason:
      "Search result appears to belong to a different job domain",
  };
};

// ============================================================
// NOISY PAGE DETECTION
// ============================================================

const isNoisyPage = (searchResult) => {
  if (!searchResult) {
    return false;
  }

  const url = normalizeUrl(
    searchResult.profileUrl ||
      searchResult.sourceUrl
  );

  const text =
    getSearchResultText(searchResult);

  const noisyUrlKeywords = [
    "/reel/",
    "/reels/",
    "/article/",
    "/articles/",
    "/news/",
    "/press/",
    "/research/",
    "/scientific-contributions/",
    "/publication/",
    "/publications/",
    "/blog/",
    "/blogs/",
    "/success/",
    "/company-profile/",
    "/business-directory/",
    "/document/",
    "/search",
    "/jobs",
    "/job/",
    "/directory",
    "/name/",
    "/people-search",
    "/find/",
    "/tag/",
    "/topic/",
    "/category/",
  ];

  const noisyTextKeywords = [
    "press coverage",
    "research works",
    "scientific contributions",
    "company profile",
    "success story",
    "placement success",
    "news article",
    "article about",
    "conference paper",
    "search results for",
    "jobs in",
    "find contact info",
    "background reports",
  ];

  if (
    noisyUrlKeywords.some((keyword) =>
      url.includes(keyword)
    ) ||
    /[?&](q|query|search|s)=/i.test(url)
  ) {
    return true;
  }

  return noisyTextKeywords.some((keyword) =>
    text.includes(keyword)
  );
};

// ============================================================
// PROFILE-LIKE URL
// ============================================================

const isProfileLikeUrl = (searchResult) => {
  if (!searchResult) {
    return false;
  }

  const url = normalizeUrl(
    searchResult.profileUrl ||
      searchResult.sourceUrl
  );

  if (!url) {
    return false;
  }

  const platform =
    searchResult.platform;

  if (
    [
      "LINKEDIN",
      "INSTAGRAM",
      "FACEBOOK",
      "TWITTER",
      "GITHUB",
      "YOUTUBE",
      "MEDIUM",
      "STACKOVERFLOW",
      "LEETCODE",
      "HACKERRANK",
      "KAGGLE",
      "BEHANCE",
      "DRIBBBLE",
      "QUORA",
      "THREADS",
      "REDDIT",
      "PINTEREST",
      "DEVTO",
      "NAUKRI",
      "ABOUT_ME",
      "LINKTREE",
      "GITLAB",
      "BITBUCKET",
      "HASHNODE",
      "PEERLIST",
      "HUGGINGFACE",
      "RESEARCHGATE",
      "ORCID",
      "SCHOLAR",
      "CODEPEN",
      "CODECHEF",
    ].includes(platform)
  ) {
    return true;
  }

  const profileKeywords = [
    "/profile/",
    "/profiles/",
    "/people/",
    "/user/",
    "/users/",
    "/member/",
    "/author/",
    "/in/",
  ];

  return profileKeywords.some((keyword) =>
    url.includes(keyword)
  );
};

// ============================================================
// PROFILE IMAGE
// ============================================================

const hasProfileImage = (searchResult) => {
  return Boolean(
    searchResult?.profileImageUrl ||
      (
        Array.isArray(
          searchResult?.profileImageUrls
        ) &&
        searchResult.profileImageUrls.length
      )
  );
};

// ============================================================
// NAME QUALITY
// ============================================================

const calculateNameScore = (
  candidate,
  searchResult
) => {
  if (
    !candidate?.fullName ||
    !searchResult?.name
  ) {
    return null;
  }

  return calculateTextSimilarity(
    candidate.fullName,
    searchResult.name
  );
};

// ============================================================
// USERNAME SCORE
// ============================================================

const calculateUsernameScore = (
  candidate,
  searchResult
) => {
  if (
    !candidate?.fullName ||
    !searchResult?.username
  ) {
    return null;
  }

  const candidateName =
    normalizeText(candidate.fullName)
      .replace(/\s+/g, "");

  const username =
    normalizeText(searchResult.username)
      .replace(/\s+/g, "");

  if (!candidateName || !username) {
    return null;
  }

  if (
    username === candidateName
  ) {
    return 100;
  }

  if (
    username.includes(candidateName) ||
    candidateName.includes(username)
  ) {
    return 85;
  }

  return calculateTextSimilarity(
    candidate.fullName,
    searchResult.username
  );
};

// ============================================================
// IDENTITY MATCH (deterministic, explainable)
//
// Identity confidence is built ONLY from independent evidence:
//   name (gate), company, job title, location, education, exact known URL.
// A username derived from the name, a job domain, profile completeness
// and a URL found by search are NOT identity evidence.
// Missing / rejected data is UNKNOWN, never a mismatch.
// ============================================================

const envNum = (key, fallback) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && process.env[key] !== "" && process.env[key] !== undefined ? n : fallback;
};

const getThresholds = () => ({
  strongMin: envNum("MATCH_STRONG_MIN", 80),
  possibleMin: envNum("MATCH_POSSIBLE_MIN", 60),
  reviewMin: envNum("MATCH_REVIEW_MIN", 45),
  conflictPoints: envNum("MATCH_CONFLICT_POINTS", 1.5),
  conflictPointsWithEvidence: envNum("MATCH_CONFLICT_POINTS_WITH_EVIDENCE", 3),
  noisyCap: envNum("MATCH_NOISY_CAP", 35),
});

const WEIGHTS = { name: 40, company: 25, jobTitle: 10, location: 12, education: 13 };
const PENALTY_PER_POINT = 8;
const PENALTY_MAX = 24;
const EVIDENCE_CAPS = [40, 70, 90, 100]; // independent corroborators 0,1,2,3+

const MATCH_ENGINE_VERSION = 4;

const classifyPage = (searchResult) => {
  const noisy = isNoisyPage(searchResult);
  return { noisy, profileUrlShape: isProfileLikeUrl(searchResult) };
};

const calculateCandidateMatch = (candidate, searchResult) => {
  const th = getThresholds();
  const text = getEvidenceText(searchResult);

  const matchedSignals = {
    name: { matched: false, score: 0 },
    company: { matched: false, score: 0 },
    jobTitle: { matched: false, score: 0 },
    location: { matched: false, score: 0 },
    education: { matched: false, score: 0 },
    username: { matched: false, score: 0 },
    profileUrl: { matched: false, score: 0 },
  };
  const conflictingSignals = [];
  const contradictions = []; // { field, weight, severity }
  const addConflict = (field, candidateValue, resultValue, reason, weight) => {
    const severity = weight >= 1.5 ? "HARD" : "SOFT";
    conflictingSignals.push({
      field,
      candidateValue: toText(candidateValue),
      searchResultValue: toText(resultValue),
      reason,
      severity,
    });
    contradictions.push({ field, weight, severity });
  };

  // ---------- components ----------
  const name = signals.compareNames(candidate.fullName, searchResult.name);
  const company = signals.compareCompany(candidate, searchResult.company, text);
  const title = signals.compareTitle(candidate, searchResult.jobTitle || searchResult.headline);
  const location = signals.compareLocation(candidate.location, searchResult.location, text);
  const education = signals.compareEducation(candidate.education, searchResult.education, text);

  const knownUrls = getCandidateUrls(candidate);
  const handles = knownUrls.map((u) => handleOf(u)).filter(Boolean);
  const username = signals.analyzeUsername(searchResult.username, candidate.fullName, handles);

  // URL: only an exact candidate-supplied URL counts. A URL found by search
  // is a locator, never evidence.
  const directUrlMatch = findDirectUrlMatch(candidate, searchResult);
  let urlNote = "No candidate-supplied URL to compare.";
  if (directUrlMatch) {
    urlNote = "Result URL equals a profile URL supplied for this candidate.";
  } else if (knownUrls.length && searchResult.profileUrl) {
    const samePlatform = knownUrls.find(
      (u) => hostKey(u) && hostKey(u) === hostKey(searchResult.profileUrl)
    );
    if (samePlatform) {
      urlNote = "Candidate supplied a different profile on this platform.";
      addConflict(
        "profileUrl",
        samePlatform,
        searchResult.profileUrl,
        "Candidate supplied a different profile URL on this platform (a person can own two accounts; informational).",
        0.3
      );
    }
  }

  const page = classifyPage(searchResult);

  // ---------- matchedSignals (for UI / ranking compatibility) ----------
  const setSig = (key, comp, matchedAt) => {
    if (comp.score === null || comp.score === undefined) return;
    matchedSignals[key].score = comp.score;
    matchedSignals[key].matched = comp.score >= matchedAt;
  };
  setSig("name", name, 85);
  setSig("company", company, 70);
  setSig("jobTitle", title, 70);
  setSig("location", location, 70);
  setSig("education", education, 70);
  if (username.state === "KNOWN_HANDLE") {
    matchedSignals.username = { matched: true, score: 100 };
  } else if (username.usable && username.nameDerived) {
    // consistency only: it adds NO independent evidence (see identity.independent)
    matchedSignals.username = { matched: true, score: 70 };
  }
  if (directUrlMatch) matchedSignals.profileUrl = { matched: true, score: 100 };

  // ---------- contradictions (only for comparable, valid data) ----------
  if (name.state === "MISMATCH" && name.score !== null) {
    addConflict("name", candidate.fullName, searchResult.name, name.reason, 3);
  }
  if (company.state === "MISMATCH") {
    addConflict("company", candidate.currentCompany, company.resultValue, company.reason, 1);
  }
  if (title.state === "DIFFERENT" && title.resultValue) {
    addConflict("jobTitle", candidate.currentJobTitle, title.resultValue, title.reason, 0.3);
  }
  if (location.state === "MISMATCH") {
    addConflict(
      `location.${String(location.level || "city").toLowerCase()}`,
      toText(candidate.location),
      location.resultValue,
      location.reason,
      location.weight
    );
  }

  // ---------- independent corroboration ----------
  const corro = [];
  const strengthOf = (comp, field) => {
    if (comp.score === null || comp.score === undefined) return 0;
    let s = comp.score / 100;
    if (comp.source === "TEXT") s *= 0.8;
    if (comp.employer === "PAST" || comp.past) s *= 0.7;
    if (field === "location") {
      if (comp.level === "CITY") s *= 1;
      else if (comp.level === "STATE") s *= 0.6 / 0.6;
      else if (comp.level === "COUNTRY" || comp.level === "TEXT") s *= 1;
    }
    return Math.max(0, Math.min(1, s));
  };
  const addCorro = (field, comp, minStrength) => {
    if (comp.state === "MISMATCH" || comp.state === "DIFFERENT") return;
    const s = strengthOf(comp, field);
    const points = WEIGHTS[field] * s;
    if (points > 0) {
      corro.push({
        field,
        strength: Number(s.toFixed(2)),
        points: Number(points.toFixed(1)),
        independent: s >= minStrength,
        source: comp.source || "FIELD",
        note: comp.reason,
      });
    }
  };
  addCorro("company", company, 0.5);
  addCorro("jobTitle", title, 0.5);
  addCorro("location", location, 0.5); // country-only (0.3) / text (0.4) is too weak to count
  addCorro("education", education, 0.5);

  const independent = corro.filter((c) => c.independent);
  const independentCount = independent.length;
  const evidenceCap = EVIDENCE_CAPS[Math.min(independentCount, 3)];

  // ---------- score ----------
  const nameScore = name.score ?? 0;
  const nameKnown = name.state !== "UNKNOWN";
  const nameBase = nameKnown ? (WEIGHTS.name * nameScore) / 100 : 0;
  const corroPoints = corro.reduce((s, c) => s + c.points, 0);
  const contradictionPoints = contradictions.reduce((s, c) => s + c.weight, 0);
  const penalty = Math.min(contradictionPoints * PENALTY_PER_POINT, PENALTY_MAX);

  let raw = nameBase + corroPoints - penalty;
  const adjustments = [];
  if (!nameKnown) { raw = Math.min(raw, 40); adjustments.push("name unknown: capped at 40"); }

  let similarityScore = Math.max(0, Math.min(100, raw));
  const beforeCap = similarityScore;
  similarityScore = Math.min(similarityScore, evidenceCap);
  if (similarityScore < beforeCap) adjustments.push(`independent evidence (${independentCount}) caps score at ${evidenceCap}`);
  if (page.noisy) {
    similarityScore = Math.min(similarityScore, th.noisyCap);
    adjustments.push(`non-profile page: capped at ${th.noisyCap}`);
    addConflict(
      "pageType",
      "PERSON_PROFILE",
      "NOISY_OR_NON_PROFILE_PAGE",
      "Search result appears to be an article, news page, company page, directory or search page",
      0.3
    );
  }
  if (directUrlMatch) similarityScore = 100;
  similarityScore = Math.round(similarityScore);

  // ---------- status ----------
  const hardCount = contradictions.filter((c) => c.severity === "HARD").length;
  const idContradiction = contradictions
    .filter((c) => c.field !== "pageType")
    .reduce((s, c) => s + c.weight, 0);
  const nameOk = name.state === "MATCH" || name.state === "PARTIAL";
  const reasons = [];
  let matchStatus;

  if (directUrlMatch) {
    matchStatus = "STRONG";
    reasons.push("EXACT_CANDIDATE_URL");
  } else if (page.noisy) {
    matchStatus = "WEAK";
    reasons.push("NOT_A_PROFILE_PAGE");
  } else if (name.state === "MISMATCH") {
    matchStatus = "WEAK";
    reasons.push("NAME_MISMATCH");
  } else if (
    nameOk &&
    ((independentCount === 0 && idContradiction >= th.conflictPoints) ||
      idContradiction >= th.conflictPointsWithEvidence)
  ) {
    matchStatus = "CONFLICT";
    reasons.push("CONTRADICTING_IDENTITY_DATA");
  } else if (
    name.state === "MATCH" &&
    independentCount >= 2 &&
    similarityScore >= th.strongMin &&
    hardCount === 0
  ) {
    matchStatus = "STRONG";
    reasons.push("NAME_PLUS_MULTIPLE_INDEPENDENT_EVIDENCE");
  } else if (nameOk && independentCount >= 1 && similarityScore >= th.possibleMin && name.score >= 70) {
    matchStatus = "POSSIBLE";
    reasons.push("NAME_PLUS_INDEPENDENT_EVIDENCE");
  } else if (nameOk && similarityScore >= th.reviewMin) {
    matchStatus = "REVIEW_REQUIRED";
    reasons.push("PARTIAL_EVIDENCE");
  } else {
    matchStatus = "WEAK";
    reasons.push(independentCount === 0 ? "NAME_ONLY" : "INSUFFICIENT_EVIDENCE");
  }

  // ---------- relevance (separate from identity) ----------
  const domainRelevance = calculateJobDomainRelevance(candidate, searchResult);
  const relevance = {
    jobDomain: domainRelevance.score,
    jobDomainReason: domainRelevance.reason,
    note: "Job domain affects relevance ranking only; it never establishes or removes identity.",
  };

  const unknownFields = [];
  const rejectedFields = [];
  for (const [key, comp] of [["name", name], ["company", company], ["jobTitle", title], ["location", location], ["education", education]]) {
    if (comp.state === "UNKNOWN") unknownFields.push(key);
    if (comp.rejected) rejectedFields.push(`${key}: ${comp.reason}`);
  }

  const matchDetails = {
    engineVersion: MATCH_ENGINE_VERSION,
    identity: {
      score: similarityScore,
      rawScore: Math.round(raw),
      evidenceCap,
      independentEvidence: independent.map((c) => c.field),
      independentCount,
      nameContribution: Number(nameBase.toFixed(1)),
      corroboration: corro,
      contradictionPoints: Number(contradictionPoints.toFixed(2)),
      penalty: Number(penalty.toFixed(1)),
      adjustments,
      statusReasons: reasons,
    },
    components: {
      name: { state: name.state, score: name.score, reason: name.reason, matched: name.matched, unmatchedCandidate: name.unmatchedCandidate, unmatchedResult: name.unmatchedResult },
      company: pick(company),
      jobTitle: pick(title),
      location: pick(location),
      education: pick(education),
      username: { state: username.state, usable: username.usable, junk: username.junk, independentEvidence: false },
      profileUrl: { directMatch: directUrlMatch, trust: directUrlMatch ? "CANDIDATE_SUPPLIED" : "SEARCH_DISCOVERED_NOT_EVIDENCE", note: urlNote },
    },
    relevance,
    dataQuality: { unknownFields, rejectedFields, nonProfilePage: page.noisy, profileUrlShape: page.profileUrlShape },
    thresholds: th,
  };

  // ---------- explanation ----------
  const parts = [];
  if (directUrlMatch) {
    parts.push("Result URL equals a profile URL supplied for this candidate (strong evidence; still for human verification).");
  } else {
    const nm = name.state === "UNKNOWN"
      ? "Name: unknown."
      : `Name ${name.state.toLowerCase()} (${name.score}): ${name.reason}${name.matched.length ? ` Matched: ${name.matched.map((m) => `${m.candidate}~${m.result}`).join(", ")}.` : ""}${name.unmatchedCandidate.length ? ` Not found in result: ${name.unmatchedCandidate.join(", ")}.` : ""}`;
    parts.push(nm);
    parts.push(
      independentCount
        ? `Independent supporting evidence: ${independent.map((c) => c.field).join(", ")}.`
        : "No independent supporting evidence beyond the name."
    );
    if (unknownFields.length) parts.push(`Unknown (not penalised): ${unknownFields.join(", ")}.`);
    if (rejectedFields.length) parts.push(`Unreliable values ignored: ${rejectedFields.join("; ")}.`);
    if (domainRelevance.score === 100) parts.push("Job domain looks relevant (ranking only).");
    if (domainRelevance.score === 0) parts.push("Job domain looks different (ranking only; not an identity conflict).");
    if (page.noisy) parts.push("Result is not a personal profile page.");
  }
  parts.push(`Score ${similarityScore}/100 (cap ${evidenceCap}); status ${matchStatus} [${reasons.join(", ")}].`);
  if (conflictingSignals.length) {
    parts.push(
      `Conflicts: ${conflictingSignals.map((c) => `${c.field}(${c.severity})`).join(", ")}.`
    );
  }

  return {
    similarityScore,
    matchStatus,
    matchedSignals,
    conflictingSignals,
    explanation: parts.join(" "),
    matchDetails,
  };
};

const toText = (v, depth = 0) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (depth > 2) return "";
  // Mongoose documents are circular: always plain-object them first.
  const plain = typeof v.toObject === "function" ? v.toObject() : v;
  if (Array.isArray(plain)) return plain.map((x) => toText(x, depth + 1)).filter(Boolean).join("; ");
  if (typeof plain === "object") {
    return Object.entries(plain)
      .filter(([k]) => !k.startsWith("_"))
      .map(([, x]) => toText(x, depth + 1))
      .filter(Boolean)
      .join(", ");
  }
  return "";
};

const pick = (c) => {
  const { state, score, reason, source, employer, level, past } = c;
  return { state, score, reason, source, employer, level, past };
};

const hostKey = (u) => {
  const k = canonicalProfileKey(u);
  return k ? k.split("/")[0] : "";
};

const handleOf = (u) => {
  const k = canonicalProfileKey(u);
  if (!k) return "";
  const parts = k.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  return parts.length > 1 ? last : "";
};

// ============================================================
// CREATE / UPDATE ONE CANDIDATE MATCH
// ============================================================

const buildMatchFields = (match) => ({
  similarityScore: match.similarityScore,
  matchStatus: match.matchStatus,
  matchedSignals: match.matchedSignals,
  conflictingSignals: match.conflictingSignals,
  explanation: match.explanation,
  matchDetails: match.matchDetails,
});

// Re-running matching refreshes the scores but never touches a human
// decision, and never re-labels a profile a reviewer already decided on.
const applyMatchToExisting = (existing, match) => {
  const fields = buildMatchFields(match);
  if (existing.reviewStatus && existing.reviewStatus !== "PENDING") {
    const { matchStatus, ...rest } = fields;
    rest.matchDetails = {
      ...(fields.matchDetails || {}),
      automaticStatusNotApplied: matchStatus,
      reason: "Human decision exists; automatic status not applied.",
    };
    Object.assign(existing, rest);
  } else {
    Object.assign(existing, fields);
  }
  return existing.save();
};

const createMatchForResult = async ({
  candidate,
  bgvRun,
  searchResult,
}) => {
  const match = calculateCandidateMatch(candidate, searchResult);

  const existing = await CandidateMatch.findOne({
    candidate: candidate._id,
    bgvRun: bgvRun._id,
    searchResult: searchResult._id,
  });

  if (existing) return applyMatchToExisting(existing, match);

  try {
    return await CandidateMatch.create({
      candidate: candidate._id,
      bgvRun: bgvRun._id,
      searchResult: searchResult._id,
      ...buildMatchFields(match),
      reviewStatus: "PENDING",
    });
  } catch (error) {
    // Parallel request / retry created it first (unique index on
    // bgvRun + searchResult): update that record instead.
    if (error && error.code === 11000) {
      const duplicate = await CandidateMatch.findOne({
        bgvRun: bgvRun._id,
        searchResult: searchResult._id,
      });
      if (duplicate) return applyMatchToExisting(duplicate, match);
    }
    throw error;
  }
};

// ============================================================
// CREATE MATCHES FOR ALL SEARCH RESULTS
//
// IMPORTANT:
// ALL SearchResults remain in DB.
// Nothing is deleted because of low relevance.
// ============================================================

const createMatchesForBgvRun = async ({
  candidateId,
  bgvRunId,
}) => {
  const candidate =
    await Candidate.findById(
      candidateId
    );

  if (!candidate) {
    throw new Error(
      "Candidate not found"
    );
  }

  const bgvRun =
    await BgvRun.findById(
      bgvRunId
    );

  if (!bgvRun) {
    throw new Error(
      "BGV run not found"
    );
  }

  if (
    bgvRun.candidate.toString() !==
    candidate._id.toString()
  ) {
    throw new Error(
      "BGV run does not belong to this candidate"
    );
  }

  const dbStart = Date.now();
  const searchResults =
    await SearchResult.find({
      bgvRun: bgvRunId,
    }).lean();

  // ONE read for every match this run already has (re-runs update, never duplicate)
  const existingRows = await CandidateMatch.find({ bgvRun: bgvRunId, candidate: candidate._id })
    .select("_id searchResult reviewStatus matchStatus matchDetails.fingerprint matchDetails.previouslyVerified")
    .lean();
  const existingBySr = new Map(existingRows.map((m) => [String(m.searchResult), m]));
  // Permanent registry: which of these results are profiles a reviewer already
  // verified for THIS candidate (and still look like the same identity)?
  let verifiedByResult = new Map();
  try {
    verifiedByResult = await verifiedIdentities.assessRunResults({ candidateId: candidate._id, searchResults });
  } catch (error) {
    console.error("Verified identity check failed (matching continues):", error.message);
  }
  const dbReadMs = Date.now() - dbStart;
  const verifiedStats = { applied: 0, flagged: 0 };
  const flagged = [];
  const appliedLog = [];

  const matches = [];
  const ops = [];
  const inserts = [];
  let unchanged = 0;
  let failedMatches = 0;
  const computeStart = Date.now();

  for (const searchResult of searchResults) {
    // One broken result must never stop the whole run.
    try {
      const match = calculateCandidateMatch(candidate, searchResult);
      const fields = buildMatchFields(match);
      // unchanged inputs -> identical result: skip the write on a repeat run
      const fingerprint = crypto.createHash("sha1").update(JSON.stringify(fields)).digest("hex");
      fields.matchDetails = { ...(fields.matchDetails || {}), fingerprint };
      const existing = existingBySr.get(String(searchResult._id));

      // ---- previously verified? (explicit earlier human confirmation only)
      const vi = verifiedByResult.get(String(searchResult._id));
      let verifiedFields = null; // fields that mark the match as previously verified
      if (vi) {
        if (vi.reasons.length) {
          // material change: NOT assumed to be the same identity -> human review
          fields.matchDetails = { ...fields.matchDetails, needsReReview: { reasons: vi.reasons, identityId: vi.identity._id, detectedAt: new Date() } };
          flagged.push({ identity: vi.identity, reasons: vi.reasons });
          verifiedStats.flagged += 1;
        } else if (!existing || existing.reviewStatus === "PENDING") {
          // a human decision already in this run (APPROVED/REJECTED) is never overwritten
          verifiedFields = {
            reviewStatus: "APPROVED",
            reviewedAt: vi.identity.verifiedAt,
            ...(vi.identity.verifiedBy ? { reviewedBy: vi.identity.verifiedBy } : {}),
            reviewerNotes: `Previously verified${vi.identity.verifiedByLabel ? ` by ${vi.identity.verifiedByLabel}` : ""} on ${new Date(vi.identity.verifiedAt).toISOString().slice(0, 10)}`,
          };
          fields.matchDetails = {
            ...fields.matchDetails,
            previouslyVerified: {
              identityId: vi.identity._id,
              verifiedAt: vi.identity.verifiedAt,
              verifiedBy: vi.identity.verifiedBy || null,
              verifiedByLabel: vi.identity.verifiedByLabel || null,
              method: vi.identity.verificationMethod,
            },
          };
          appliedLog.push(vi.identity);
          verifiedStats.applied += 1;
        }
      }

      if (existing && !verifiedFields && !vi?.reasons?.length && existing.matchDetails?.fingerprint === fingerprint) {
        unchanged += 1;
        matches.push({ ...fields, matchStatus: existing.matchStatus, searchResult: searchResult._id });
      } else if (existing) {
        let update = fields;
        let effectiveStatus = fields.matchStatus;
        if (existing.reviewStatus && existing.reviewStatus !== "PENDING") {
          // a human decision exists: refresh scores, never the label/decision
          const { matchStatus, ...rest } = fields;
          rest.matchDetails = {
            ...(fields.matchDetails || {}),
            automaticStatusNotApplied: matchStatus,
            reason: "Human decision exists; automatic status not applied.",
          };
          update = rest;
          effectiveStatus = existing.matchStatus;
        }
        if (verifiedFields) update = { ...update, ...verifiedFields };
        ops.push({ updateOne: { filter: { _id: existing._id, ...(verifiedFields ? { reviewStatus: "PENDING" } : {}) }, update: { $set: update } } });
        matches.push({ ...update, matchStatus: effectiveStatus, searchResult: searchResult._id });
      } else {
        inserts.push({
          candidate: candidate._id,
          bgvRun: bgvRun._id,
          searchResult: searchResult._id,
          ...fields,
          ...(verifiedFields || { reviewStatus: "PENDING" }),
        });
        matches.push({ ...fields, searchResult: searchResult._id });
      }
    } catch (error) {
      failedMatches += 1;
      console.error(
        `Match failed for SearchResult ${searchResult._id}: ${error.message}`
      );
    }
  }
  const computeMs = Date.now() - computeStart;

  // bulk, idempotent writes (unique {bgvRun, searchResult})
  const writeStart = Date.now();
  if (inserts.length) {
    try {
      await CandidateMatch.insertMany(inserts, { ordered: false });
    } catch (error) {
      // a parallel request created some first (duplicate key): refresh those
      const dupes = (error?.writeErrors || []).filter((e) => (e.err?.code ?? e.code) === 11000);
      const others = (error?.writeErrors || []).length - dupes.length;
      if (!error?.writeErrors || others > 0) {
        failedMatches += others || inserts.length;
        console.error("Match insert problem:", error.message);
      }
      for (const d of dupes) {
        const doc = inserts[d.index ?? d.err?.index];
        if (!doc) continue;
        const { candidate: _c, bgvRun: _b, searchResult: sr, reviewStatus: _r, ...fields } = doc;
        ops.push({ updateOne: { filter: { bgvRun: bgvRun._id, searchResult: sr }, update: { $set: fields } } });
      }
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < ops.length; i += CHUNK) {
    try {
      await CandidateMatch.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    } catch (error) {
      // a duplicate-key race is harmless (the row exists); anything else is a failure
      const errs = error?.writeErrors || [];
      const real = errs.filter((e) => (e.err?.code ?? e.code) !== 11000);
      if (!errs.length || real.length) {
        failedMatches += real.length || ops.slice(i, i + CHUNK).length;
        console.error("Match bulk write problem:", error.message);
      }
    }
  }
  const dbWriteMs = Date.now() - writeStart;

  // audit trail for the registry decisions made in this run (never throws)
  for (const idn of appliedLog) {
    await verifiedIdentities.logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "KNOWLEDGE_BASE_REUSED",
      description: `Previously verified ${idn.platform} profile recognised (verified ${new Date(idn.verifiedAt).toISOString().slice(0, 10)}${idn.verifiedByLabel ? ` by ${idn.verifiedByLabel}` : ""}); not asked again`,
      metadata: { type: "PREVIOUSLY_VERIFIED_APPLIED", identity: idn._id, profileUrl: idn.profileUrl, platform: idn.platform, verifiedAt: idn.verifiedAt, method: idn.verificationMethod },
      idempotencyKey: `prev-verified:${bgvRun._id}:${idn._id}`,
    });
  }
  for (const f of flagged) {
    await verifiedIdentities.flagForReReview({ identityId: f.identity._id, reasons: f.reasons, bgvRunId: bgvRun._id });
    await verifiedIdentities.logEvent({
      bgvRun: bgvRun._id,
      candidate: candidate._id,
      action: "KNOWLEDGE_BASE_REUSED",
      description: `Previously verified ${f.identity.platform} profile changed (${f.reasons.join(", ")}): sent back for human review, not assumed to be the same identity`,
      metadata: { type: "VERIFIED_IDENTITY_NEEDS_REREVIEW", identity: f.identity._id, profileUrl: f.identity.profileUrl, reasons: f.reasons },
      idempotencyKey: `prev-verified-changed:${bgvRun._id}:${f.identity._id}`,
    });
  }
  if (process.env.PERF_LOG !== "false") {
    console.log(`[perf] matching ${JSON.stringify({ results: searchResults.length, computeMs, dbReadMs, dbWriteMs, inserted: inserts.length, updated: ops.length, unchanged, previouslyVerified: verifiedStats.applied, reReview: verifiedStats.flagged })}`);
  }

  // ==========================================================
  // COUNTS
  // ==========================================================

  const relevantMatches =
    matches.filter(
      (match) =>
        match.matchStatus ===
          "STRONG" ||
        match.matchStatus ===
          "POSSIBLE"
    );

  const reviewRequiredMatches =
    matches.filter(
      (match) =>
        match.matchStatus ===
        "REVIEW_REQUIRED"
    );

  await BgvRun.findByIdAndUpdate(
    bgvRunId,
    {
      matchedResults:
        relevantMatches.length,

      reviewRequired:
        reviewRequiredMatches.length,
    },
    {
      new: true,
    }
  );

  return {
    totalSearchResults:
      searchResults.length,

    totalMatches:
      matches.length,

    failedMatches,

    relevantMatches:
      relevantMatches.length,

    strongMatches:
      matches.filter(
        (match) =>
          match.matchStatus ===
          "STRONG"
      ).length,

    possibleMatches:
      matches.filter(
        (match) =>
          match.matchStatus ===
          "POSSIBLE"
      ).length,

    reviewRequired:
      reviewRequiredMatches.length,

    weakMatches:
      matches.filter(
        (match) =>
          match.matchStatus ===
          "WEAK"
      ).length,

    conflicts:
      matches.filter(
        (match) =>
          match.matchStatus ===
          "CONFLICT"
      ).length,

    matches,
    timings: { computeMs, dbReadMs, dbWriteMs, inserted: inserts.length, updated: ops.length, unchanged, previouslyVerified: verifiedStats.applied, reReview: verifiedStats.flagged },
  };
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  normalizeText,
  calculateTextSimilarity,
  calculateLocationMatch,
  calculateEducationMatch,
  calculateCandidateMatch,
  createMatchForResult,
  createMatchesForBgvRun,
};