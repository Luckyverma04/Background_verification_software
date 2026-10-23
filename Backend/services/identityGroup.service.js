const Candidate = require("../models/Candidate");
const BgvRun = require("../models/BgvRun");
const SearchResult = require("../models/SearchResult");
const CandidateMatch = require("../models/CandidateMatch");
const IdentityGroup = require("../models/IdentityGroup");

const APPROVED_STATUS = "APPROVED";
const PENDING_STATUS = "PENDING";
const REJECTED_STATUS = "REJECTED";

/* =========================================================
   SHARED HELPERS (ids, errors, notes)
========================================================= */

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

const isValidObjectId = (value) =>
  OBJECT_ID_PATTERN.test(String(value || ""));

/*
  Works for strings, ObjectIds and populated documents.
*/
const idKey = (value) =>
  String(value && value._id ? value._id : value);

/*
  Order-independent signature of a set of profile ids.
  Used to detect "same group" without relying on array order.
*/
const signatureOf = (ids) =>
  [...new Set(ids.map(idKey))].sort().join("|");

/*
  Error the controller can turn into an HTTP response.
*/
const createServiceError = (
  statusCode,
  message,
  details = {}
) => {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.details = details;

  return error;
};

const mergeNotes = (...notes) => {
  const seen = new Set();
  const result = [];

  for (const note of notes) {
    const text =
      typeof note === "string" ? note.trim() : "";

    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }

  return result.join("\n");
};

/* =========================================================
   BASIC HELPERS
========================================================= */

const normalizeText = (value) => {
  if (!value) return "";

  return String(value)
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s@.-]/g, "");
};

const normalizeUsername = (value) => {
  if (!value) return "";

  return normalizeText(value)
    .replace(/^@/, "")
    .replace(/[_\-.]/g, "");
};

const normalizeUrl = (url) => {
  if (!url) return "";

  try {
    const parsed = new URL(String(url).trim());

    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");

    return parsed.toString();
  } catch {
    return normalizeText(url);
  }
};

const calculateTextSimilarity = (valueA, valueB) => {
  const a = normalizeText(valueA);
  const b = normalizeText(valueB);

  if (!a || !b) return 0;

  if (a === b) return 100;

  if (a.includes(b) || b.includes(a)) {
    return 85;
  }

  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));

  const commonWords = [...wordsA].filter((word) =>
    wordsB.has(word)
  );

  if (!commonWords.length) return 0;

  const union = new Set([...wordsA, ...wordsB]);

  return Math.round(
    (commonWords.length / union.size) * 100
  );
};

const compareProfileUrls = (urlA, urlB) => {
  const a = normalizeUrl(urlA);
  const b = normalizeUrl(urlB);

  if (!a || !b) return 0;

  return a === b ? 100 : 0;
};

const compareUsernames = (usernameA, usernameB) => {
  const a = normalizeUsername(usernameA);
  const b = normalizeUsername(usernameB);

  if (!a || !b) return 0;

  if (a === b) return 100;

  return calculateTextSimilarity(a, b);
};

/* =========================================================
   LOCATION
========================================================= */

const compareLocations = (locationA, locationB) => {
  if (!locationA || !locationB) return 0;

  const cityScore = calculateTextSimilarity(
    locationA.city,
    locationB.city
  );

  const stateScore = calculateTextSimilarity(
    locationA.state,
    locationB.state
  );

  const countryScore = calculateTextSimilarity(
    locationA.country,
    locationB.country
  );

  if (cityScore > 0) {
    return Math.round(
      cityScore * 0.6 +
        stateScore * 0.3 +
        countryScore * 0.1
    );
  }

  return Math.max(stateScore, countryScore);
};

/* =========================================================
   EDUCATION
========================================================= */

const compareEducation = (educationA, educationB) => {
  if (
    !Array.isArray(educationA) ||
    !Array.isArray(educationB) ||
    !educationA.length ||
    !educationB.length
  ) {
    return 0;
  }

  let bestScore = 0;

  for (const eduA of educationA) {
    for (const eduB of educationB) {
      const institutionScore = calculateTextSimilarity(
        eduA?.institution,
        eduB?.institution
      );

      const degreeScore = calculateTextSimilarity(
        eduA?.degree,
        eduB?.degree
      );

      const fieldScore = calculateTextSimilarity(
        eduA?.fieldOfStudy,
        eduB?.fieldOfStudy
      );

      const score = Math.round(
        institutionScore * 0.6 +
          degreeScore * 0.2 +
          fieldScore * 0.2
      );

      bestScore = Math.max(bestScore, score);
    }
  }

  return bestScore;
};

/* =========================================================
   CONTACT / LINKS
========================================================= */

const extractEmails = (profile) => {
  const values = [
    profile?.email,
    profile?.rawData?.email,
    profile?.rawData?.emails,
    profile?.description,
    profile?.headline,
    profile?.bio,
  ];

  const text = values
    .flatMap((value) => {
      if (Array.isArray(value)) return value;
      return value ? [value] : [];
    })
    .join(" ");

  const emails =
    text.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
    ) || [];

  return [...new Set(emails.map((e) => e.toLowerCase()))];
};

const extractUrlsFromProfile = (profile) => {
  const values = [
    profile?.profileUrl,
    profile?.sourceUrl,
    profile?.website,
    profile?.rawData?.website,
    profile?.rawData?.links,
    profile?.rawData?.urls,
    profile?.description,
    profile?.headline,
    profile?.bio,
  ];

  const urls = [];

  for (const value of values) {
    if (!value) continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          urls.push(item);
        }
      }
      continue;
    }

    if (typeof value === "string") {
      const found =
        value.match(/https?:\/\/[^\s"'<>]+/gi) || [];

      urls.push(...found);
    }
  }

  return [
    ...new Set(
      urls
        .map(normalizeUrl)
        .filter(Boolean)
    ),
  ];
};

const findSharedEmail = (profileA, profileB) => {
  const emailsA = extractEmails(profileA);
  const emailsB = extractEmails(profileB);

  return emailsA.some((email) =>
    emailsB.includes(email)
  );
};

const findSharedProfileLink = (profileA, profileB) => {
  const urlsA = extractUrlsFromProfile(profileA);
  const urlsB = extractUrlsFromProfile(profileB);

  return urlsA.some((url) => urlsB.includes(url));
};

const hasExplicitLinkTo = (profileA, profileB) => {
  const urlsA = extractUrlsFromProfile(profileA);

  const profileBUrl = normalizeUrl(
    profileB?.profileUrl
  );

  if (!profileBUrl) return false;

  return urlsA.includes(profileBUrl);
};

/* =========================================================
   PROFILE COMPARISON
========================================================= */

/* ---------------------------------------------------------
   Evidence helpers (new, used only by compareProfiles).
   Existing helpers above are untouched and still used:
   calculateTextSimilarity, compareLocations, compareEducation,
   compareProfileUrls, normalizeText, normalizeUsername,
   extractEmails, extractUrlsFromProfile.
--------------------------------------------------------- */

const EVIDENCE_TEXT_FIELDS = [
  "title",
  "snippet",
  "description",
  "content",
  "text",
  "bio",
  "about",
  "summary",
];

/*
  Page text where real evidence lives (bio, snippet, search content).
  Nothing is invented: only text already stored on the SearchResult.
*/
const collectEvidenceTexts = (profile) => {
  const seen = new Set();
  const texts = [];

  const push = (value) => {
    const text =
      typeof value === "string" ? value.slice(0, 5000) : "";

    if (!text.trim() || seen.has(text)) return;

    seen.add(text);
    texts.push(text);
  };

  push(profile?.headline);
  push(profile?.bio);
  push(profile?.description);
  push(profile?.about);

  const raw = profile?.rawData;

  if (typeof raw === "string") {
    push(raw);
  } else if (raw && typeof raw === "object") {
    EVIDENCE_TEXT_FIELDS.forEach((key) => push(raw[key]));

    if (Array.isArray(raw.providerResults)) {
      raw.providerResults.slice(0, 5).forEach((result) => {
        if (!result || typeof result !== "object") return;

        ["title", "snippet", "description", "content"].forEach(
          (key) => push(result[key])
        );
      });
    }
  }

  return texts;
};

const SOCIAL_KEY_HOSTS = {
  "linkedin.com": "linkedin.com",
  "github.com": "github.com",
  "instagram.com": "instagram.com",
  "facebook.com": "facebook.com",
  "fb.com": "facebook.com",
  "twitter.com": "twitter.com",
  "x.com": "twitter.com",
};

/*
  Comparable key of a URL, independent of http/https, www,
  query string, hash, trailing slash and case.

  Social platforms: host/username (LinkedIn: host/in/slug)
  Everything else : host/full-path
*/
const toProfileKey = (value) => {
  const text = String(value || "")
    .trim()
    .replace(/[),.;]+$/, "");

  if (!text) return "";

  let parsed;

  try {
    parsed = new URL(
      /^https?:\/\//i.test(text) ? text : `https://${text}`
    );
  } catch {
    return "";
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (!host.includes(".")) return "";

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  const social = Object.keys(SOCIAL_KEY_HOSTS).find(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );

  if (social) {
    const canonical = SOCIAL_KEY_HOSTS[social];

    if (
      canonical === "linkedin.com" &&
      ["in", "pub"].includes(segments[0]) &&
      segments[1]
    ) {
      return `${canonical}/${segments[0]}/${segments[1]}`;
    }

    return segments[0] ? `${canonical}/${segments[0]}` : canonical;
  }

  return segments.length ? `${host}/${segments.join("/")}` : host;
};

/*
  URLs in free text. Requires a scheme, "www.", or a path, so that
  "Node.js", "React.js" or "Next.js" are never read as websites.
*/
const TEXT_URL_REGEX =
  /(?:https?:\/\/|www\.)[^\s"'<>)\]]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s"'<>)\]]*/gi;

const extractTextUrls = (texts) =>
  texts.flatMap((text) => text.match(TEXT_URL_REGEX) || []);

/*
  Links that are boilerplate or too common to prove anything.
*/
const GENERIC_SHARED_HOSTS = new Set([
  "github.com",
  "linkedin.com",
  "twitter.com",
  "instagram.com",
  "facebook.com",
  "google.com",
  "youtube.com",
  "youtu.be",
  "medium.com",
  "stackoverflow.com",
  "npmjs.com",
  "reddit.com",
  "wikipedia.org",
  "amazon.com",
  "bit.ly",
  "t.co",
]);

const INFRA_HOST_PARTS = [
  "githubassets.com",
  "githubusercontent.com",
  "gstatic.com",
  "googleapis.com",
  "googleusercontent.com",
  "gravatar.com",
  "shields.io",
  "cloudfront.net",
  "w3.org",
  "schema.org",
  "creativecommons.org",
];

const RESERVED_FIRST_SEGMENTS = new Set([
  "features",
  "about",
  "pricing",
  "login",
  "signup",
  "settings",
  "explore",
  "search",
  "topics",
  "marketplace",
  "sponsors",
  "legal",
  "help",
  "intent",
  "share",
  "home",
]);

const isGenericSharedKey = (key) => {
  if (!key) return true;

  const [host, first] = key.split("/");

  if (
    INFRA_HOST_PARTS.some(
      (part) => host === part || host.endsWith(`.${part}`)
    )
  ) {
    return true;
  }

  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js)$/.test(key)) {
    return true;
  }

  return (
    GENERIC_SHARED_HOSTS.has(host) &&
    (!first || RESERVED_FIRST_SEGMENTS.has(first))
  );
};

/*
  Two keys point to the same place. A site root ("rahulsharma.dev")
  matches any page on that host.
*/
const keysShare = (keyA, keyB) => {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;

  /*
    Root rule applies to personal / external sites only.
    A bare "linkedin.com" or "github.com" mention must never match
    every profile on that platform.
  */
  const rootMatches = (root, other) =>
    !root.includes("/") &&
    other.split("/")[0] === root &&
    !GENERIC_SHARED_HOSTS.has(root) &&
    !Object.values(SOCIAL_KEY_HOSTS).includes(root);

  return rootMatches(keyA, keyB) || rootMatches(keyB, keyA);
};

/*
  Keys of every URL a profile mentions, excluding its own profile URL.
*/
const mentionedProfileKeys = (profile, texts) => {
  const own = new Set(
    [
      toProfileKey(profile?.profileUrl),
      toProfileKey(profile?.sourceUrl),
    ].filter(Boolean)
  );

  const urls = [
    ...extractUrlsFromProfile(profile),
    ...extractTextUrls(texts),
  ];

  return [
    ...new Set(
      urls
        .map(toProfileKey)
        .filter((key) => key && !own.has(key))
    ),
  ];
};

/*
  A shared link counts as evidence only if it points to a personal /
  external website or to a LinkedIn personal profile. A shared link to a
  GitHub org, an X/Instagram account, etc. is too often a famous third
  party, so it is not used.
*/
const isShareableExternalKey = (key) => {
  if (!key || isGenericSharedKey(key)) return false;

  const host = key.split("/")[0];
  const isSocial = Object.values(SOCIAL_KEY_HOSTS).includes(host);

  if (!isSocial) return true;

  return /^linkedin\.com\/(in|pub)\//.test(key);
};

/*
  Emails from the existing extractor plus the stored page text.
  Role / system addresses are ignored.
*/
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g;
const ROLE_EMAIL_LOCAL =
  /^(info|contact|support|admin|hello|noreply|no-reply|sales|team|careers|hr|help|mail|webmaster)$/;

const extractEvidenceEmails = (profile, texts) => {
  const emails = new Set(extractEmails(profile));

  for (const text of texts) {
    for (const email of text.toLowerCase().match(EMAIL_PATTERN) || []) {
      emails.add(email);
    }
  }

  return [...emails].filter(
    (email) =>
      !ROLE_EMAIL_LOCAL.test(email.split("@")[0]) &&
      !/\.(png|jpe?g|gif|svg|webp)$/.test(email) &&
      !/@(users\.)?noreply\.github\.com$/.test(email)
  );
};

/*
  Platform of a profile. For generic "WEBSITE" results the host is used,
  so two different websites count as different platforms.
*/
const platformOf = (profile) => {
  const platform = String(profile?.platform || "")
    .toUpperCase()
    .trim();

  if (platform && platform !== "WEBSITE" && platform !== "OTHER") {
    return platform === "X" ? "TWITTER" : platform;
  }

  return toProfileKey(profile?.profileUrl).split("/")[0] || "";
};

/*
  Person name without platform noise:
    "rahul-sharma-alx (Rahul Sharma) · GitHub" -> "Rahul Sharma"
    "Rahul Sharma rahulsharma1919"             -> "Rahul Sharma"
    "Rahul Sharma - Den haag, Netherlands | about.me" -> "Rahul Sharma"
*/
const PLATFORM_NOISE_WORDS = new Set([
  "github",
  "linkedin",
  "instagram",
  "facebook",
  "twitter",
  "x",
  "portfolio",
  "profile",
  "about",
  "me",
  "official",
  "resume",
  "cv",
]);

const extractPersonName = (profile) => {
  let text = String(profile?.name || "").trim();

  if (!text) return "";

  const inParens = text.match(/\(([^)]{3,})\)/);

  if (
    inParens &&
    inParens[1].trim().split(/\s+/).length >= 2 &&
    !inParens[1].trim().startsWith("@")
  ) {
    text = inParens[1];
  } else {
    text = text.replace(/\([^)]*\)/g, " ");
  }

  text = text
    .split(/\s[·|•\-–—]\s|,|:|\||·|•/)[0]
    .replace(/@[\w.\-]+/g, " ");

  const usernameKey = normalizeUsername(profile?.username);

  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => {
      const compact = normalizeText(word).replace(/[^a-z0-9]/g, "");

      if (!compact) return false;
      if (PLATFORM_NOISE_WORDS.has(compact)) return false;
      if (usernameKey && normalizeUsername(word) === usernameKey) {
        return false;
      }

      return true;
    })
    .join(" ");
};

const nameWordSet = (name) =>
  new Set(
    normalizeText(name)
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9]/g, ""))
      .filter(Boolean)
  );

/*
  One name's words are all inside the other's
  ("Rahul Sharma" inside "Humantic AI Profile for Rahul Sharma").
*/
const nameWordsContained = (nameA, nameB) => {
  const a = nameWordSet(nameA);
  const b = nameWordSet(nameB);

  if (!a.size || !b.size) return false;

  const [small, large] = a.size <= b.size ? [a, b] : [b, a];

  return [...small].every((word) => large.has(word));
};

/*
  A username that is just the person's name:
    rahulsharma, sharmarahul, rahuls, rsharma, rahul, sharma
*/
const isNameDerivedUsername = (usernameKey, names) => {
  if (!usernameKey) return false;

  for (const name of names) {
    const tokens = normalizeText(name)
      .split(/\s+/)
      .map((token) => token.replace(/[^a-z0-9]/g, ""))
      .filter((token) => token.length >= 2);

    if (!tokens.length) continue;

    const first = tokens[0];
    const last = tokens[tokens.length - 1];

    const variants = new Set([
      tokens.join(""),
      [...tokens].reverse().join(""),
      first,
      last,
      first + last[0],
      first[0] + tokens.slice(1).join(""),
      last + first[0],
    ]);

    if (variants.has(usernameKey)) return true;
  }

  return false;
};

/* ---------------------------------------------------------
   compareProfiles
--------------------------------------------------------- */

const compareProfiles = (profileA, profileB) => {
  const matchedSignals = {
    name: false,
    company: false,
    jobTitle: false,
    location: false,
    education: false,
    username: false,
    website: false,
  };

  const scores = {
    name: 0,
    company: 0,
    jobTitle: 0,
    location: 0,
    education: 0,
    username: 0,
    website: 0,
  };

  const conflicts = [];
  const evidence = [];

  const textsA = collectEvidenceTexts(profileA);
  const textsB = collectEvidenceTexts(profileB);

  /* ---------------- NAME ---------------- */

  const coreNameA = extractPersonName(profileA);
  const coreNameB = extractPersonName(profileB);

  const namesComparable = Boolean(coreNameA && coreNameB);

  const namesContained =
    namesComparable && nameWordsContained(coreNameA, coreNameB);

  scores.name = Math.max(
    calculateTextSimilarity(profileA?.name, profileB?.name),
    namesComparable
      ? calculateTextSimilarity(coreNameA, coreNameB)
      : 0,
    namesContained ? 85 : 0
  );

  matchedSignals.name = scores.name >= 70;

  /*
    Different names are a conflict only when both names are
    comparable. A missing / handle-only name is UNKNOWN.
  */
  const nameConflict = namesComparable && scores.name < 40;

  if (nameConflict) {
    conflicts.push({
      field: "name",
      valueA: profileA?.name,
      valueB: profileB?.name,
      reason: "Different names",
    });
  }

  const nameMatched = matchedSignals.name;

  const nameConsistent =
    !nameConflict && (nameMatched || !namesComparable);

  /* ---------------- COMPANY ---------------- */

  scores.company = calculateTextSimilarity(
    profileA?.company,
    profileB?.company
  );

  matchedSignals.company = scores.company >= 70;

  if (
    profileA?.company &&
    profileB?.company &&
    scores.company < 40
  ) {
    conflicts.push({
      field: "company",
      valueA: profileA.company,
      valueB: profileB.company,
      reason: "Different companies",
    });
  }

  /* ---------------- JOB TITLE ---------------- */

  scores.jobTitle = calculateTextSimilarity(
    profileA?.jobTitle,
    profileB?.jobTitle
  );

  matchedSignals.jobTitle = scores.jobTitle >= 70;

  /* ---------------- LOCATION ---------------- */

  scores.location = compareLocations(
    profileA?.location,
    profileB?.location
  );

  matchedSignals.location = scores.location >= 70;

  const countryA = normalizeText(profileA?.location?.country);
  const countryB = normalizeText(profileB?.location?.country);

  /*
    Different countries are a conflict. Missing country, or a
    short code such as "IN", is UNKNOWN.
  */
  if (
    countryA &&
    countryB &&
    countryA.length > 3 &&
    countryB.length > 3 &&
    calculateTextSimilarity(countryA, countryB) < 40
  ) {
    conflicts.push({
      field: "location.country",
      valueA: profileA.location.country,
      valueB: profileB.location.country,
      reason: "Different countries",
    });
  }

  /* ---------------- EDUCATION ---------------- */

  scores.education = compareEducation(
    profileA?.education,
    profileB?.education
  );

  matchedSignals.education = scores.education >= 70;

  /* ---------------- PROFILE URL ---------------- */

  scores.website = compareProfileUrls(
    profileA?.profileUrl,
    profileB?.profileUrl
  );

  /* =====================================================
     PROFILE-TO-PROFILE EVIDENCE
  ===================================================== */

  const keyA = toProfileKey(profileA?.profileUrl);
  const keyB = toProfileKey(profileB?.profileUrl);

  const platformA = platformOf(profileA);
  const platformB = platformOf(profileB);

  /* 1. same profile */

  const sameProfile =
    (profileA?.platform === profileB?.platform &&
      scores.website === 100) ||
    Boolean(keyA && keyA === keyB && platformA === platformB);

  /* 2. explicit reference: one profile links to the other */

  const mentionedByA = mentionedProfileKeys(profileA, textsA);
  const mentionedByB = mentionedProfileKeys(profileB, textsB);

  const referencesProfile = (mentioned, ownerKey) =>
    Boolean(ownerKey) &&
    !isGenericSharedKey(ownerKey) &&
    mentioned.some((key) => keysShare(key, ownerKey));

  const linkedProfile =
    referencesProfile(mentionedByA, keyB) ||
    referencesProfile(mentionedByB, keyA);

  /* 3. shared contact (email) */

  const emailsA = extractEvidenceEmails(profileA, textsA);
  const emailsB = extractEvidenceEmails(profileB, textsB);

  const sharedEmailAddress =
    emailsA.find((email) => emailsB.includes(email)) || null;

  const sharedEmail = Boolean(sharedEmailAddress);

  /* 4. distinctive username across DIFFERENT platforms */

  const usernameA = normalizeUsername(profileA?.username);
  const usernameB = normalizeUsername(profileB?.username);

  const sameUsername = Boolean(
    usernameA && usernameB && usernameA === usernameB
  );

  /*
    A username that is simply the person's name
    (Rahul Sharma -> rahulsharma) is NOT identity evidence.
  */
  const usernameIsNameDerived =
    sameUsername &&
    isNameDerivedUsername(usernameA, [
      coreNameA,
      coreNameB,
      profileA?.name,
      profileB?.name,
    ]);

  const usernameLooksDistinctive =
    sameUsername &&
    usernameA.length >= 6 &&
    !usernameIsNameDerived;

  const differentPlatforms = Boolean(
    platformA && platformB && platformA !== platformB
  );

  const crossPlatformDistinctiveUsername =
    usernameLooksDistinctive && differentPlatforms;

  /*
    Username that merely contains the name plus a little extra
    (rahulsharma03) is weaker than one that does not contain it.
  */
  const nameCompacts = [coreNameA, coreNameB]
    .map((name) => normalizeText(name).replace(/[^a-z0-9]/g, ""))
    .filter((compact) => compact.length >= 6);

  const usernameContainsName = nameCompacts.some((compact) =>
    usernameA.includes(compact)
  );

  /* 5. shared external website / LinkedIn profile */

  const ownHosts = new Set(
    [keyA, keyB].filter(Boolean).map((key) => key.split("/")[0])
  );

  const sharedWebsiteKeys = mentionedByA.filter(
    (key) =>
      isShareableExternalKey(key) &&
      !ownHosts.has(key.split("/")[0]) &&
      mentionedByB.some((other) => keysShare(key, other))
  );

  const sharedExternalWebsite =
    !linkedProfile && sharedWebsiteKeys.length > 0;

  /* 6. independent attributes */

  const cityMatched =
    calculateTextSimilarity(
      profileA?.location?.city,
      profileB?.location?.city
    ) >= 70;

  /*
    Strong attributes are specific; job title and a country/state-only
    location are generic and can never carry grouping on their own.
  */
  const strongAttributes = [
    matchedSignals.company,
    matchedSignals.education,
    cityMatched,
  ].filter(Boolean).length;

  const weakAttributes = [
    matchedSignals.jobTitle,
    matchedSignals.location && !cityMatched,
  ].filter(Boolean).length;

  const corroborated =
    strongAttributes >= 2 ||
    (strongAttributes >= 1 && weakAttributes >= 2);

  /* signals reported to the group */

  matchedSignals.username = crossPlatformDistinctiveUsername;
  scores.username = crossPlatformDistinctiveUsername ? 100 : 0;

  matchedSignals.website =
    scores.website === 100 || linkedProfile || sharedExternalWebsite;

  /* =====================================================
     EVIDENCE DECISION  (priority order)
  ===================================================== */

  let groupingDecision = "SEPARATE";
  let evidenceType = "NONE";
  let identityConfidence = 0;

  if (sameProfile) {
    groupingDecision = "SAME_PROFILE";
    evidenceType = "SAME_PROFILE";
    identityConfidence = 100;

    evidence.push("Same platform and exact profile URL");
  } else if (linkedProfile && nameConsistent) {
    groupingDecision = "LIKELY_SAME_PERSON";
    evidenceType = "LINKED_PROFILES";
    identityConfidence = 98;

    evidence.push("One profile explicitly links to the other");
  } else if (sharedEmail && nameConsistent) {
    groupingDecision = "LIKELY_SAME_PERSON";
    evidenceType = "SHARED_CONTACT";
    identityConfidence = 97;

    evidence.push(
      `Profiles share the same email address (${sharedEmailAddress})`
    );
  } else if (crossPlatformDistinctiveUsername && nameMatched) {
    groupingDecision = "LIKELY_SAME_PERSON";
    evidenceType = "SHARED_USERNAME";
    identityConfidence = usernameContainsName ? 85 : 92;

    evidence.push(
      `Distinctive username "${usernameA}" on different platforms (${platformA}, ${platformB}) with matching name`
    );
  } else if (sharedExternalWebsite && nameMatched) {
    groupingDecision = "LIKELY_SAME_PERSON";
    evidenceType = "SHARED_EXTERNAL_WEBSITE";
    identityConfidence = 88;

    evidence.push(
      `Both profiles link to the same external site (${sharedWebsiteKeys[0]}) with matching name`
    );
  } else if (nameMatched && corroborated) {
    groupingDecision = "LIKELY_SAME_PERSON";
    evidenceType = "CORROBORATED";
    identityConfidence = Math.min(
      90,
      55 + strongAttributes * 10 + weakAttributes * 5
    );

    evidence.push(
      "Name and multiple independent attributes match (company / education / location, with job title)"
    );
  } else if (nameMatched && strongAttributes + weakAttributes >= 1) {
    /*
      Name + job title (or one attribute) is NOT enough.
      A human reviews it; it is never merged automatically.
    */
    groupingDecision = "REVIEW";
    evidenceType = "WEAK_OVERLAP";
    identityConfidence = 55;

    evidence.push(
      "Some profile attributes overlap but identity evidence is insufficient"
    );
  }

  /*
    Conflicting strong information blocks automatic grouping,
    unless there is direct / explicit evidence.
  */

  if (
    conflicts.length > 0 &&
    evidenceType !== "SAME_PROFILE" &&
    evidenceType !== "LINKED_PROFILES" &&
    evidenceType !== "SHARED_CONTACT"
  ) {
    groupingDecision = "SEPARATE";
    evidenceType = "CONFLICT";
    identityConfidence = 0;

    evidence.length = 0;
    evidence.push(
      `Automatic grouping blocked by conflicting information: ${conflicts
        .map((conflict) => conflict.reason)
        .join("; ")}`
    );
  }

  return {
    confidenceScore: identityConfidence,
    matchedSignals,
    conflicts,
    groupingDecision,
    evidenceType,
    evidence,
    strongUsernameMatch: Boolean(crossPlatformDistinctiveUsername),
    sharedEmail,
    linkedProfile,
    sharedExternalWebsite,
  };
};

/* =========================================================
   DATABASE FETCH
========================================================= */

const getRunSearchResults = async (bgvRunId) => {
  return SearchResult.find({
    bgvRun: bgvRunId,
  }).lean();
};

const getRunCandidateMatches = async (bgvRunId) => {
  return CandidateMatch.find({
    bgvRun: bgvRunId,
  }).lean();
};

/* =========================================================
   APPROVED MATCHES ONLY
========================================================= */

const getApprovedCandidateMatches = async (
  bgvRunId
) => {
  return CandidateMatch.find({
    bgvRun: bgvRunId,
    reviewStatus: APPROVED_STATUS,
  }).lean();
};

/* =========================================================
   GROUP SIGNAL MERGING
========================================================= */

const mergeSignals = (
  group,
  comparison
) => {
  Object.keys(group.matchedSignals).forEach(
    (signal) => {
      if (
        comparison.matchedSignals?.[signal]
      ) {
        group.matchedSignals[signal] = true;
      }
    }
  );

  if (
    comparison.confidenceScore >
    group.confidenceScore
  ) {
    group.confidenceScore =
      comparison.confidenceScore;
  }

  if (comparison.evidenceType) {
    group.evidenceTypes.add(
      comparison.evidenceType
    );
  }

  for (const item of comparison.evidence || []) {
    if (!group.evidence.includes(item)) {
      group.evidence.push(item);
    }
  }
};

/* =========================================================
   BUILD CONNECTED GROUPS
========================================================= */

const computeIdentityGroups = ({
  approvedResults,
  matchMap,
}) => {
  const groups = [];

  /*
    Every APPROVED profile starts as a singleton.

    This is important:
    one approved profile is still a valid identity group.
  */

  for (const result of approvedResults) {
    groups.push({
      searchResults: [result],

      /*
        IdentityGroup confidence is profile-to-profile identity
        evidence, NOT the CandidateMatch similarityScore.

        A singleton has no such evidence yet, so it starts at 0.
        (matchMap is still accepted so existing callers keep working.)
      */
      confidenceScore: 0,

      matchedSignals: {
        name: false,
        company: false,
        jobTitle: false,
        location: false,
        education: false,
        username: false,
        website: false,
      },

      evidenceTypes: new Set(),

      evidence: [],
    });
  }

  /*
    Compare approved profiles with each other.
  */

  for (
    let i = 0;
    i < approvedResults.length;
    i++
  ) {
    for (
      let j = i + 1;
      j < approvedResults.length;
      j++
    ) {
      const profileA =
        approvedResults[i];

      const profileB =
        approvedResults[j];

      /*
        A pair with the same exact profile URL is NOT skipped:
        compareProfiles() returns SAME_PROFILE for it, so duplicate
        SearchResults end up in ONE group instead of two.
      */

      const comparison =
        compareProfiles(
          profileA,
          profileB
        );

      /*
        ONLY strong identity evidence
        can automatically merge.
      */

      if (
        comparison.groupingDecision !==
        "LIKELY_SAME_PERSON" &&
        comparison.groupingDecision !==
        "SAME_PROFILE"
      ) {
        continue;
      }

      mergeMatchingGroups(
        groups,
        profileA._id.toString(),
        profileB._id.toString(),
        comparison
      );
    }
  }

  return groups;
};

/* =========================================================
   MERGE GROUPS
========================================================= */

const mergeMatchingGroups = (
  groups,
  profileAId,
  profileBId,
  comparison
) => {
  const groupAIndex =
    groups.findIndex((group) =>
      group.searchResults.some(
        (result) =>
          result._id.toString() ===
          profileAId
      )
    );

  const groupBIndex =
    groups.findIndex((group) =>
      group.searchResults.some(
        (result) =>
          result._id.toString() ===
          profileBId
      )
    );

  if (
    groupAIndex === -1 ||
    groupBIndex === -1
  ) {
    return;
  }

  /*
    Already in same connected group.
  */

  if (groupAIndex === groupBIndex) {
    mergeSignals(
      groups[groupAIndex],
      comparison
    );

    return;
  }

  const groupA =
    groups[groupAIndex];

  const groupB =
    groups[groupBIndex];

  /*
    Merge B into A.
  */

  groupA.searchResults.push(
    ...groupB.searchResults
  );

  groupA.confidenceScore =
    Math.max(
      groupA.confidenceScore,
      groupB.confidenceScore,
      comparison.confidenceScore
    );

  Object.keys(
    groupA.matchedSignals
  ).forEach((signal) => {
    if (
      groupB.matchedSignals[signal]
    ) {
      groupA.matchedSignals[
        signal
      ] = true;
    }
  });

  for (const type of groupB.evidenceTypes) {
    groupA.evidenceTypes.add(type);
  }

  for (const item of groupB.evidence) {
    if (!groupA.evidence.includes(item)) {
      groupA.evidence.push(item);
    }
  }

  mergeSignals(
    groupA,
    comparison
  );

  groups.splice(groupBIndex, 1);
};

/* =========================================================
   SAVE GROUPS
========================================================= */

const saveIdentityGroups = async ({
  groups,
  candidateId,
  bgvRunId,
}) => {
  const savedGroups = [];

  for (const group of groups) {
    if (!group.searchResults.length) {
      continue;
    }

    const profileIds =
      group.searchResults.map(
        (result) => result._id
      );

    const evidenceText =
      group.evidence.length
        ? group.evidence.join(". ")
        : "Approved profile awaiting identity review.";

    const identityGroup =
      await IdentityGroup.create({
        bgvRun: bgvRunId,
        candidate: candidateId,

        searchResults: profileIds,

        /*
          This is identity-group confidence,
          NOT the CandidateMatch similarity score.

          We keep the strongest profile-to-profile
          identity evidence as the confidence.
        */

        confidenceScore: Math.min(
          100,
          Math.max(
            0,
            Math.round(
              group.confidenceScore
            )
          )
        ),

        matchedSignals:
          group.matchedSignals,

        explanation:
          `Identity group contains ${group.searchResults.length} approved profile(s). ${evidenceText}`,

        reviewStatus: "PENDING",
      });

    savedGroups.push(
      identityGroup
    );
  }

  return savedGroups;
};

/* =========================================================
   MAIN BUILD FUNCTION
========================================================= */

const buildIdentityGroups = async ({
  candidateId,
  bgvRunId,
  replacePendingGroups = true,
}) => {
  const candidate =
    await Candidate.findById(
      candidateId
    ).lean();

  if (!candidate) {
    throw new Error(
      "Candidate not found"
    );
  }

  const bgvRun =
    await BgvRun.findById(
      bgvRunId
    ).lean();

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

  const searchResults =
    await getRunSearchResults(
      bgvRunId
    );

  const candidateMatches =
    await getRunCandidateMatches(
      bgvRunId
    );

  /*
    -------------------------------------------------------
    IMPORTANT

    ALL SearchResults remain in DB.

    ONLY APPROVED CandidateMatches participate
    in IdentityGroup creation.
    -------------------------------------------------------
  */

  const approvedMatches =
    candidateMatches.filter(
      (match) =>
        match.reviewStatus ===
        APPROVED_STATUS
    );

  const approvedResultIds =
    new Set(
      approvedMatches.map(
        (match) =>
          match.searchResult.toString()
      )
    );

  const approvedResults =
    searchResults.filter(
      (result) =>
        approvedResultIds.has(
          result._id.toString()
        )
    );

  const matchMap = new Map();

  for (const match of approvedMatches) {
    matchMap.set(
      match.searchResult.toString(),
      match
    );
  }

  /*
    -------------------------------------------------------
    Groups that a rebuild must NEVER destroy

    - APPROVED groups (human-confirmed identity)
    - REJECTED groups (human decision)
    - PENDING groups too, when replacePendingGroups = false

    Profiles that already belong to such a group are not
    grouped again: this is what used to create duplicates
    (an APPROVED group plus brand new PENDING singletons
    for the same profiles).
    -------------------------------------------------------
  */

  const existingGroups =
    await IdentityGroup.find({
      bgvRun: bgvRunId,
    }).lean();

  const preservedGroups =
    existingGroups.filter(
      (group) =>
        !replacePendingGroups ||
        group.reviewStatus !==
          PENDING_STATUS
    );

  const lockedProfileIds = new Set();
  const rejectedSignatures = new Set();

  for (const group of preservedGroups) {
    const ids = (
      group.searchResults || []
    ).map(idKey);

    if (
      group.reviewStatus ===
      REJECTED_STATUS
    ) {
      rejectedSignatures.add(
        signatureOf(ids)
      );
    } else {
      ids.forEach((id) =>
        lockedProfileIds.add(id)
      );
    }
  }

  const groupableResults =
    approvedResults.filter(
      (result) =>
        !lockedProfileIds.has(
          idKey(result._id)
        )
    );

  const alreadyInReviewedGroups =
    approvedResults.length -
    groupableResults.length;

  /*
    -------------------------------------------------------
    Automatic grouping (strong evidence only)
    -------------------------------------------------------
  */

  const computedGroups =
    computeIdentityGroups({
      approvedResults:
        groupableResults,
      matchMap,
    });

  /*
    A grouping a human already REJECTED is not proposed
    again with the identical set of profiles.
  */

  const groups = computedGroups.filter(
    (group) =>
      !rejectedSignatures.has(
        signatureOf(
          group.searchResults
        )
      )
  );

  const skippedRejectedGroups =
    computedGroups.length -
    groups.length;

  /*
    -------------------------------------------------------
    Rebuild behavior

    Delete only PENDING groups.

    APPROVED / REJECTED groups are preserved.
    -------------------------------------------------------
  */

  if (replacePendingGroups) {
    await IdentityGroup.deleteMany({
      bgvRun: bgvRunId,
      reviewStatus: PENDING_STATUS,
    });
  }

  const summary = {
    totalSearchResults:
      searchResults.length,

    totalCandidateMatches:
      candidateMatches.length,

    approvedMatches:
      approvedMatches.length,

    notApprovedNotGrouped:
      candidateMatches.filter(
        (match) =>
          match.reviewStatus !==
          APPROVED_STATUS
      ).length,

    preservedReviewedGroups:
      preservedGroups.length,

    approvedProfilesAlreadyInReviewedGroups:
      alreadyInReviewedGroups,

    skippedPreviouslyRejectedGroups:
      skippedRejectedGroups,
  };

  /*
    If there is nothing new to group,
    no new automatic group is created.
  */

  if (!groups.length) {
    return {
      groups: [],
      totalGroups: 0,

      groupedApprovedResults:
        alreadyInReviewedGroups,

      ...summary,
    };
  }

  const savedGroups =
    await saveIdentityGroups({
      groups,
      candidateId,
      bgvRunId,
    });

  const newlyGroupedProfiles =
    savedGroups.reduce(
      (total, group) =>
        total +
        group.searchResults.length,
      0
    );

  return {
    groups: savedGroups,

    totalGroups:
      savedGroups.length,

    /*
      Approved profiles that now belong to an identity group:
      the ones grouped just now + the ones already inside
      a preserved (reviewed) group.
    */
    groupedApprovedResults:
      newlyGroupedProfiles +
      alreadyInReviewedGroups,

    ...summary,
  };
};

/* =========================================================
   HUMAN-CONFIRMED IDENTITY MERGE
========================================================= */

const getApprovalState = async ({
  bgvRunId,
  candidateId,
  searchResultIds,
}) => {
  const matches =
    await CandidateMatch.find({
      bgvRun: bgvRunId,
      searchResult: {
        $in: searchResultIds,
      },
    }).lean();

  const approved = new Set();
  const status = new Map();

  for (const match of matches) {
    // A match of another candidate is not evidence for this one.
    if (
      match.candidate &&
      idKey(match.candidate) !==
        idKey(candidateId)
    ) {
      continue;
    }

    const key = idKey(
      match.searchResult
    );

    if (
      !status.has(key) ||
      match.reviewStatus ===
        APPROVED_STATUS
    ) {
      status.set(
        key,
        match.reviewStatus
      );
    }

    if (
      match.reviewStatus ===
      APPROVED_STATUS
    ) {
      approved.add(key);
    }
  }

  return { approved, status };
};

/*
  Informational only: what the automatic comparison finds between
  the confirmed profiles. It never decides anything here.
*/
const summarizeProfileEvidence = (
  profiles
) => {
  const matchedSignals = {
    name: false,
    company: false,
    jobTitle: false,
    location: false,
    education: false,
    username: false,
    website: false,
  };

  const evidenceCounts = {};

  let totalPairs = 0;
  let evidencePairs = 0;

  for (let i = 0; i < profiles.length; i++) {
    for (
      let j = i + 1;
      j < profiles.length;
      j++
    ) {
      const comparison =
        compareProfiles(
          profiles[i],
          profiles[j]
        );

      totalPairs += 1;

      Object.keys(matchedSignals).forEach(
        (signal) => {
          if (
            comparison.matchedSignals?.[
              signal
            ]
          ) {
            matchedSignals[signal] = true;
          }
        }
      );

      if (
        comparison.groupingDecision ===
          "LIKELY_SAME_PERSON" ||
        comparison.groupingDecision ===
          "SAME_PROFILE"
      ) {
        evidencePairs += 1;

        evidenceCounts[
          comparison.evidenceType
        ] =
          (evidenceCounts[
            comparison.evidenceType
          ] || 0) + 1;
      }
    }
  }

  return {
    matchedSignals,
    evidenceCounts,
    totalPairs,
    evidencePairs,
  };
};

const buildManualExplanation = (
  profileCount,
  evidence
) => {
  const types = Object.entries(
    evidence.evidenceCounts
  )
    .map(
      ([type, count]) =>
        `${type} x${count}`
    )
    .join(", ");

  const automatic =
    evidence.totalPairs === 0
      ? ""
      : evidence.evidencePairs === 0
      ? ` Automatic profile-to-profile comparison found no strong evidence between these profiles (${evidence.totalPairs} pair(s)); this grouping relies on the reviewer's decision.`
      : ` Automatic profile-to-profile comparison found evidence for ${evidence.evidencePairs} of ${evidence.totalPairs} pair(s) (${types}); the remaining pair(s) rely on the reviewer's decision.`;

  return (
    `Identity group manually confirmed by reviewer. Contains ${profileCount} approved profiles. ` +
    "Confidence 100 represents human-confirmed identity, not algorithmic similarity." +
    automatic
  );
};

const byCreatedAt = (a, b) =>
  new Date(a.createdAt || 0) -
    new Date(b.createdAt || 0) ||
  idKey(a._id).localeCompare(
    idKey(b._id)
  );

/*
  A reviewer confirms that several APPROVED profiles belong to the
  same person.

  What it does
  - validates run, candidate and every SearchResult
  - requires an APPROVED CandidateMatch for every profile
  - reuses an existing group instead of creating duplicates:
      * PENDING group fully inside the selection -> expanded + APPROVED
      * APPROVED group overlapping the selection -> expanded
        (human-confirmed identities are transitive); other overlapping
        APPROVED groups are merged into it
      * PENDING group that also holds profiles NOT selected -> those
        profiles stay in that group, the selected ones move
      * REJECTED group with the identical set -> revived as APPROVED
  - stores ONE group: APPROVED, confidence 100 (human-confirmed),
    reviewerNotes, reviewedAt

  It never deletes or edits SearchResults or CandidateMatches. Only
  IdentityGroup documents that were folded into the confirmed group are
  removed.
*/
const confirmIdentityMerge = async ({
  bgvRunId,
  candidateId,
  searchResultIds,
  reviewerNotes,
  reviewedBy,
}) => {
  /* ---------------- 1. input validation ---------------- */

  if (!isValidObjectId(bgvRunId)) {
    throw createServiceError(
      400,
      "Invalid BGV Run ID",
      { received: bgvRunId }
    );
  }

  if (!isValidObjectId(candidateId)) {
    throw createServiceError(
      400,
      "Invalid Candidate ID",
      { received: candidateId }
    );
  }

  if (!Array.isArray(searchResultIds)) {
    throw createServiceError(
      400,
      "searchResultIds must be an array of SearchResult IDs"
    );
  }

  const invalidIds =
    searchResultIds.filter(
      (id) => !isValidObjectId(id)
    );

  if (invalidIds.length) {
    throw createServiceError(
      400,
      "Invalid SearchResult ID(s)",
      { invalidSearchResultIds: invalidIds }
    );
  }

  const selectedIds = [
    ...new Set(
      searchResultIds.map(String)
    ),
  ];

  if (selectedIds.length < 2) {
    throw createServiceError(
      400,
      "At least two different SearchResult IDs are required to confirm an identity merge"
    );
  }

  if (
    reviewerNotes !== undefined &&
    reviewerNotes !== null &&
    typeof reviewerNotes !== "string"
  ) {
    throw createServiceError(
      400,
      "reviewerNotes must be a string"
    );
  }

  const cleanNotes =
    typeof reviewerNotes === "string"
      ? reviewerNotes.trim()
      : "";

  /* ---------------- 2. run + candidate ---------------- */

  const bgvRun =
    await BgvRun.findById(
      bgvRunId
    ).lean();

  if (!bgvRun) {
    throw createServiceError(
      404,
      "BGV run not found"
    );
  }

  const candidate =
    await Candidate.findById(
      candidateId
    ).lean();

  if (!candidate) {
    throw createServiceError(
      404,
      "Candidate not found"
    );
  }

  if (
    idKey(bgvRun.candidate) !==
    idKey(candidate._id)
  ) {
    throw createServiceError(
      400,
      "BGV run does not belong to this candidate"
    );
  }

  /* ---------------- 3. search results ---------------- */

  const selectedDocs =
    await SearchResult.find({
      _id: { $in: selectedIds },
    }).lean();

  const foundIds = new Set(
    selectedDocs.map((doc) =>
      idKey(doc._id)
    )
  );

  const missingIds =
    selectedIds.filter(
      (id) => !foundIds.has(id)
    );

  if (missingIds.length) {
    throw createServiceError(
      404,
      "SearchResult(s) not found",
      { missingSearchResultIds: missingIds }
    );
  }

  const otherRunIds = selectedDocs
    .filter(
      (doc) =>
        idKey(doc.bgvRun) !==
        idKey(bgvRunId)
    )
    .map((doc) => idKey(doc._id));

  if (otherRunIds.length) {
    throw createServiceError(
      400,
      "All SearchResults must belong to the same BGV run",
      {
        searchResultsFromOtherRuns:
          otherRunIds,
      }
    );
  }

  /* ---------------- 4. APPROVED matches only ---------------- */

  const approval =
    await getApprovalState({
      bgvRunId,
      candidateId,
      searchResultIds: selectedIds,
    });

  const notApproved = selectedIds
    .filter(
      (id) => !approval.approved.has(id)
    )
    .map((id) => ({
      searchResultId: id,
      candidateMatchStatus:
        approval.status.get(id) || null,
    }));

  if (notApproved.length) {
    throw createServiceError(
      400,
      "Every selected profile must have a CandidateMatch with reviewStatus APPROVED",
      { notApproved }
    );
  }

  /* ---------------- 5. existing groups ---------------- */

  const existingGroups =
    await IdentityGroup.find({
      bgvRun: bgvRunId,
      candidate: candidateId,
      searchResults: {
        $in: selectedIds,
      },
    }).lean();

  const groupIds = (group) =>
    (group.searchResults || []).map(
      idKey
    );

  const selectedSet = new Set(
    selectedIds
  );

  const approvedOverlap =
    existingGroups
      .filter(
        (group) =>
          group.reviewStatus ===
          APPROVED_STATUS
      )
      .sort(byCreatedAt);

  const pendingOverlap =
    existingGroups
      .filter(
        (group) =>
          group.reviewStatus ===
          PENDING_STATUS
      )
      .sort(byCreatedAt);

  const rejectedOverlap =
    existingGroups.filter(
      (group) =>
        group.reviewStatus ===
        REJECTED_STATUS
    );

  // A PENDING group that holds ONLY selected profiles can be
  // expanded / promoted without losing anything.
  const pendingExpandable =
    pendingOverlap.filter((group) =>
      groupIds(group).every((id) =>
        selectedSet.has(id)
      )
    );

  // A PENDING group that also holds profiles the reviewer did NOT
  // select keeps those profiles; the selected ones move out of it.
  const pendingWithOutsiders =
    pendingOverlap.filter(
      (group) =>
        !pendingExpandable.includes(
          group
        )
    );

  /*
    Profiles of overlapping APPROVED groups join the confirmed group
    (a human already confirmed them). They must still have an
    APPROVED CandidateMatch in this run.
  */

  const extraCandidateIds = [
    ...new Set(
      approvedOverlap.flatMap(groupIds)
    ),
  ].filter((id) => !selectedSet.has(id));

  let extraDocs = [];
  const droppedUnapprovedProfileIds = [];

  if (extraCandidateIds.length) {
    const extraApproval =
      await getApprovalState({
        bgvRunId,
        candidateId,
        searchResultIds:
          extraCandidateIds,
      });

    const approvedExtraIds =
      extraCandidateIds.filter((id) =>
        extraApproval.approved.has(id)
      );

    const foundExtra =
      approvedExtraIds.length
        ? await SearchResult.find({
            _id: {
              $in: approvedExtraIds,
            },
          }).lean()
        : [];

    extraDocs = foundExtra.filter(
      (doc) =>
        idKey(doc.bgvRun) ===
        idKey(bgvRunId)
    );

    const keptExtra = new Set(
      extraDocs.map((doc) =>
        idKey(doc._id)
      )
    );

    extraCandidateIds.forEach((id) => {
      if (!keptExtra.has(id)) {
        droppedUnapprovedProfileIds.push(
          id
        );
      }
    });
  }

  const finalIds = [
    ...selectedIds,
    ...extraDocs.map((doc) =>
      idKey(doc._id)
    ),
  ];

  const finalSet = new Set(finalIds);

  /* ---------------- 6. choose the group to reuse ---------------- */

  let target =
    approvedOverlap[0] ||
    pendingExpandable[0] ||
    null;

  let revived = false;

  if (!target) {
    const signature =
      signatureOf(finalIds);

    const identicalRejected =
      rejectedOverlap.find(
        (group) =>
          signatureOf(
            groupIds(group)
          ) === signature
      );

    if (identicalRejected) {
      target = identicalRejected;
      revived = true;
    }
  }

  const consolidated = [
    ...approvedOverlap,
    ...pendingExpandable,
  ].filter((group) => group !== target);

  /* ---------------- 7. evidence summary + payload ---------------- */

  const profiles = [
    ...selectedDocs,
    ...extraDocs,
  ];

  const evidence =
    summarizeProfileEvidence(profiles);

  const notes = mergeNotes(
    target?.reviewerNotes,
    ...consolidated.map(
      (group) => group.reviewerNotes
    ),
    cleanNotes
  );

  const payload = {
    searchResults: finalIds,

    /*
      100 = HUMAN-CONFIRMED identity.
      It is NOT an algorithmic similarity and is not derived
      from CandidateMatch similarityScore.
    */
    confidenceScore: 100,

    matchedSignals:
      evidence.matchedSignals,

    explanation: buildManualExplanation(
      finalIds.length,
      evidence
    ),

    reviewStatus: APPROVED_STATUS,
    reviewedAt: new Date(),
  };

  if (notes) {
    payload.reviewerNotes = notes;
  }

  if (reviewedBy && isValidObjectId(reviewedBy)) {
    payload.reviewedBy = reviewedBy;
  }

  /* ---------------- 8. save ONE group ---------------- */

  let action;
  let savedId;

  if (target) {
    const sameProfiles =
      signatureOf(groupIds(target)) ===
      signatureOf(finalIds);

    if (revived) {
      action = "REVIVED";
    } else if (
      target.reviewStatus ===
      APPROVED_STATUS
    ) {
      action = sameProfiles
        ? "ALREADY_CONFIRMED"
        : "EXPANDED";
    } else {
      action = "CONFIRMED_EXISTING_GROUP";
    }

    const updated =
      await IdentityGroup.findByIdAndUpdate(
        target._id,
        { $set: payload },
        {
          new: true,
          runValidators: true,
        }
      );

    savedId = updated._id;
  } else {
    action = "CREATED";

    const created =
      await IdentityGroup.create({
        bgvRun: bgvRunId,
        candidate: candidateId,
        ...payload,
      });

    savedId = created._id;
  }

  /* ---------------- 9. fold in the other groups ---------------- */

  // Only IdentityGroup documents are removed; every profile they
  // held is now in the confirmed group.
  for (const group of consolidated) {
    await IdentityGroup.deleteOne({
      _id: group._id,
    });
  }

  const shrunkPendingGroupIds = [];

  for (const group of pendingWithOutsiders) {
    const remaining = groupIds(
      group
    ).filter((id) => !finalSet.has(id));

    if (!remaining.length) {
      await IdentityGroup.deleteOne({
        _id: group._id,
      });
      continue;
    }

    await IdentityGroup.findByIdAndUpdate(
      group._id,
      {
        $set: {
          searchResults: remaining,
          explanation: `Identity group contains ${remaining.length} approved profile(s). Some profiles were moved into a human-confirmed identity group; rebuild to refresh the automatic evidence.`,
        },
      }
    );

    shrunkPendingGroupIds.push(
      idKey(group._id)
    );
  }

  /* ---------------- 10. result ---------------- */

  const group =
    await IdentityGroup.findById(savedId)
      .populate("candidate")
      .populate("bgvRun")
      .populate("searchResults");

  return {
    group,
    action,
    consolidatedGroupIds:
      consolidated.map((item) =>
        idKey(item._id)
      ),
    shrunkPendingGroupIds,
    droppedUnapprovedProfileIds,
    previouslyRejectedGroupIds:
      rejectedOverlap
        .filter(
          (item) =>
            !target ||
            idKey(item._id) !==
              idKey(target._id)
        )
        .map((item) =>
          idKey(item._id)
        ),
  };
};

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  normalizeText,
  calculateTextSimilarity,
  normalizeUrl,
  compareProfileUrls,
  compareUsernames,
  compareLocations,
  compareEducation,

  extractEmails,
  extractUrlsFromProfile,

  compareProfiles,

  getRunSearchResults,
  getRunCandidateMatches,
  getApprovedCandidateMatches,

  computeIdentityGroups,
  buildIdentityGroups,
  confirmIdentityMerge,
};