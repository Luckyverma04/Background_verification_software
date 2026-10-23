"use strict";

const { computeCompleteness } = require("./profileEnrichment.service");

const mlService = require("./mlMatch.service");

/**
 * candidateMatchRanking.service.js
 *
 * Decides WHICH (max 15) CandidateMatches a human reviewer should look at
 * FIRST to find out whether they belong to the candidate.
 *
 * It does NOT answer "which pages contain the name and the profession?".
 *
 * Hard rules
 * ----------
 * - Nothing is deleted. All SearchResults / CandidateMatches stay in MongoDB.
 * - similarityScore / matchStatus keep their meaning. They are only ONE
 *   input here, and they are discounted when identity evidence is weak.
 * - The score is a prioritisation aid, never proof of identity.
 * - Missing information is UNKNOWN, never a mismatch.
 * - The list is paginated (15 per page) and holds at least 15 entries when
 *   that many results exist; low-confidence ones are labelled and ranked last.
 *
 * Priority of evidence (strongest -> weakest)
 * -------------------------------------------
 *  1. direct known profile URL (or candidate's email/phone found on the page)
 *  2. actual personal / social profile page
 *  3. name + username
 *  4. name + professional identity
 *  5. name + professional identity + location / company / education
 *  6. cross-platform corroboration
 *  7. profile image (supporting evidence only)
 *  8. search / provider relevance
 *  9. generic name + job title on a non-profile page  -> very low
 *
 * Page quality is NOT identity strength
 * ---------------------------------------
 * A real Instagram/X/Facebook profile is HIGH *page quality*, but with only
 * "name + username" the *identity* is WEAK: usernames that contain a
 * person's name are common and prove nothing.
 *
 * Identity levels
 * ---------------
 *  STRONG    DIRECT: known profile URL, or candidate email/phone on the page
 *            or (on an actual profile page, name matched) one of:
 *              - username + strong professional evidence
 *              - strong professional evidence + another supporting signal
 *              - username + cross-platform corroboration
 *              - professional evidence + location/company/education
 *  MODERATE  name + professional evidence on a HIGH profile page, or
 *            name + profile page + one supporting signal
 *  WEAK      name only, name + username only, generic social profile with
 *            no professional/location/company/education evidence, or any
 *            page whose profession conflicts with the candidate's
 *
 * Shortlist order (tiers, then score): 1 direct match, 2 strong identity +
 * professional, 3 strong identity + cross-platform, 4 moderate + strong
 * professional, 5 moderate + supporting signals, 6 weak identity (fallback
 * only: shown just to bring a thin list up to a small target size, never to
 * fill 15 slots).
 *
 * Page value
 * ----------
 *  HIGH    LinkedIn/GitHub/Instagram/Facebook/X personal profiles, personal
 *          websites, other clear personal professional profiles
 *  MEDIUM  About.me, resume/job-portal profiles, professional directories
 *  UNCLEAR unknown page, identity cannot be established from the URL
 *  LOW     service/session pages, documents, aggregators, listings, company
 *          pages, pages about several people, matcher-flagged noisy pages
 *  NOISY   articles, blog posts, news, press, search/listing pages, reels
 *
 * Works only on data already stored in MongoDB. No external calls.
 * All tunables are in DEFAULT_CONFIG and can be overridden per call.
 */

// ============================================================
// CONSTANTS
// ============================================================

// Business rule: the human review list never exceeds 15.
const HARD_MAX_SHORTLIST = 15;

const DISCLAIMER =
  "Ranking is a prioritisation aid for human verification. " +
  "It is not proof that this profile belongs to the candidate.";

const TIE_BAND = Number(process.env.RANK_TIE_BAND) || 3;
const IDENTITY_BAND = Number(process.env.RANK_IDENTITY_BAND) || 5;

const PAGE_VALUE = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  UNCLEAR: "UNCLEAR",
  LOW: "LOW",
  NOISY: "NOISY",
};

const IDENTITY_RANK = { STRONG: 3, MODERATE: 2, WEAK: 1, NONE: 0 };

const TIER_LABEL = {
  1: "Direct known profile URL / contact match",
  2: "Strong identity + professional evidence",
  3: "Strong identity + cross-platform corroboration",
  4: "Moderate identity + strong professional evidence",
  5: "Moderate identity + supporting signals",
  6: "Weak identity (fallback only)",
};

// Page kinds that are an actual person's profile page.
const PROFILE_KINDS = new Set([
  "PERSONAL_SOCIAL_PROFILE",
  "PERSONAL_WEBSITE",
  "PROFESSIONAL_PROFILE",
  "ABOUT_ME",
  "RESUME_PROFILE",
  "DIRECTORY_PROFILE",
  "GENERIC_PROFILE_PAGE",
]);

const REASON_TEXT = {
  STATUS_NOT_ELIGIBLE: "Matcher status is not eligible for human review",
  NOISY_PAGE: "Article / blog / news / search-style page, not a profile",
  LOW_VALUE_PAGE: "Service, document, aggregator, listing, company or multi-person page, not a personal profile",
  UNRELATED_PROFESSION_CONFLICT: "Strong evidence of an unrelated profession",
  DIFFERENT_COUNTRY: "Different country and no strong identity evidence to offset it",
  WEAK_IDENTITY_EVIDENCE: "Only name/title evidence on a page that is not a clear personal profile",
  WEAK_IDENTITY_FALLBACK_ONLY: "Weak identity (e.g. name + username only); better-supported candidates exist, so it is kept as a database match only",
  NO_IDENTITY_EVIDENCE: "No matched identity signal and low matcher similarity",
  BELOW_MIN_REVIEW_SCORE: "Review score too low to be useful for a human reviewer",
  MISSING_SEARCH_RESULT: "SearchResult missing",
  WEAK_IDENTITY_HIDDEN: "Weak identity (name-only / little evidence); hidden while enough better-supported profiles exist",
  PLATFORM_CAP: "More well-supported profiles than the per-platform review target; ranked below the cap",
  SHORTLIST_CAP: "More well-supported profiles than the 15-profile human-review shortlist; ranked below the cap",
};

// ============================================================
// DEFAULT CONFIG (override any part via the `config` argument)
// ============================================================

const DEFAULT_CONFIG = {
  eligibleStatuses: ["STRONG", "POSSIBLE", "REVIEW_REQUIRED"],

  // Below this score a result is not shown (unless a DIRECT match).
  // This is what prevents "filling" the 15 slots.
  minReviewScore: 20,
  // Lower floor for WEAK-identity results, which are fallback-only anyway.
  minReviewScoreWeak: 5,

  // WEAK-identity results (name / name + username only) are shown ONLY when
  // fewer than this many better-supported results exist, and only up to this
  // total list size. They never fill the list towards 15.
  weakFallback: { targetListSize: 5 }, // legacy, no longer limits the list

  // The review list has AT LEAST this many entries when that many search
  // results exist (extra ones are labelled low-confidence). The list is
  // paginated, so there is no upper limit.
  // 0 = do NOT pad the list with low-confidence profiles. The review list
  // holds at most HARD_MAX_SHORTLIST (15) profiles and fewer when fewer
  // are relevant.
  minListSize: 0,

  // A result with no matched signal needs at least this similarity.
  requireIdentityEvidence: true,
  minSimilarityWithoutSignals: 40,

  // WEAK identity (e.g. only name + title) is reviewable only on pages
  // whose value is in this list (a clear personal profile). Sparse
  // Instagram/GitHub profiles therefore stay reviewable, a generic
  // "Name + Software Developer" page does not.
  // Add "MEDIUM" here to let job-portal / about.me pages through.
  weakIdentityAllowedPageValues: ["HIGH"],

  // Only a DIRECT match (known profile URL / candidate contact on the page)
  // may override a country conflict, an unrelated-profession conflict or a
  // low-value page. Combination evidence never does.
  overrideBases: ["DIRECT"],

  priority: { high: 65, medium: 40 },

  // USERNAME is a weak hint only (it can reveal "..._CEO"); it never feeds
  // location detection.
  textTrust: { STRUCTURED: 1, TITLE: 0.8, BIO: 0.7, SNIPPET: 0.5, USERNAME: 0.4 },

  maxSourceChars: 1500,
  maxRawTextChars: 3000,
  maxProviderResults: 5,

  // BGE-M3 semantic matching. Supporting signal only; never identity proof.
  ml: {
    enabled: true,
    maxPoints: 20,
    minSimilarityPercent: 35,
    timeoutMs: 120000,

    // Only the best-ranked matches (by the deterministic score) go to
    // BGE-M3 - never the whole run.
    maxCandidates: 50,
    // ... and never in one request: batches of this size, one after the other.
    batchSize: 20,
    // BGE-M3 scores are cached (candidate text + result text), so opening
    // page 2, 3, ... of the review list does not call the model again.
    cacheMax: 5000,
  },

  weights: {
    // 1. direct evidence
    directUrl: 45,
    contactMatch: 25, // candidate's email or phone is on the page
    contactMatchMax: 40,

    // 2. page QUALITY (how real/useful the page is). The positive credit is
    // scaled by identity strength: a real Instagram page earns full credit
    // only when the identity is also supported by other evidence.
    pageValue: { HIGH: 14, MEDIUM: 7, UNCLEAR: 0, LOW: -8, NOISY: -30 },
    pageValueIdentityFactor: { STRONG: 1, MODERATE: 1, WEAK: 0.35, NONE: 0.2 },

    // Content-derived evidence (name, title, domain, similarity...) is
    // multiplied by this, so "Name + Software Developer" on a generic page
    // is worth much less than the same facts on a real profile.
    contentFactor: { HIGH: 1, MEDIUM: 0.6, UNCLEAR: 0.45, LOW: 0.2, NOISY: 0.1 },

    // 3. name + username. A username that contains the person's name is NOT
    // proof, so it is worth little alone and becomes meaningful only
    // together with strong professional evidence or cross-platform proof.
    nameWithUsername: { generic: 3, meaningful: 10 },
    usernameAlone: 2,
    nonProfileUsernameFactor: 0.3,

    // identity strength boost (DIRECT matches already get directUrl/contact)
    identityBonus: { STRONG: 12, MODERATE: 4, WEAK: 0, NONE: 0 },
    // strong ranking penalty for WEAK / NONE identity on a normal page
    weakIdentityPenalty: 6,

    // 4. name + professional identity (substantially more important)
    name: 6, // weak alone
    nameWithProfessional: { STRONG: 14, PARTIAL: 5 },
    jobTitle: 8,

    // 5. location / company / education
    company: 10,
    location: 8,
    education: 6,
    identityCombo: { one: 8, two: 14 },

    // GitHub / LinkedIn / portfolio with professional evidence
    professionalPlatformBonus: 4,

    // 6. cross-platform corroboration (same distinctive username or a
    // profile link, between name-matched actual profile pages)
    crossPlatformPerPlatform: 8,
    crossPlatformMax: 16,

    // 7. profile image (supporting only)
    profileImage: 3,

    // professional domain
    domainDirect: { HIGH: 16, MEDIUM: 11, LOW: 5 },
    domainAdjacent: 3,
    // If the profile's PRIMARY domain is not the candidate's domain
    // (e.g. UI/UX designer who also codes), the domain credit shrinks.
    domainPrimaryFactor: { ALIGNED: 1, ADJACENT: 0.6, OTHER: 0.5, UNKNOWN: 1 },

    domainConflictWhenRelated: 6,
    domainConflictWhenUnrelated: 20,
    domainConflictMax: 40,
    unrelatedDomainMention: 3,

    // location penalties (negative signal, NOT automatic rejection)
    locationCountryConflict: 35,
    locationPossibleCountryConflict: 8,

    profileQualityFactor: 0.08,

    // 8. search / provider relevance (also discounted by identityFactor
    //    and contentFactor: a "STRONG 90%" page with weak identity
    //    evidence earns little here)
    similarityFactor: 0.05,
    statusBonus: { STRONG: 3, POSSIBLE: 1.5, REVIEW_REQUIRED: 0 },
    identityFactor: { STRONG: 1, MODERATE: 0.75, WEAK: 0.4, NONE: 0.2 },

    // upstream `conflictingSignals`. location = 0 (we do our own
    // country-aware analysis), pageType = 0 (page classification
    // already uses it).
    conflictPenalty: {
      name: 20,
      company: 8,
      jobTitle: 8,
      education: 6,
      location: 0,
      pageType: 0,
      other: 8,
    },
    conflictPenaltyMax: 30,
  },

  pages: {
    // Path fragments -> NOISY pages
    noisyPathFragments: {
      ARTICLE: [
        "/article/", "/articles/", "/news/", "/press/", "/press-release",
        "/blog/", "/blogs/", "/story/",
      ],
      POST: ["/reel/", "/reels/"],
      LISTING: [
        "/tag/", "/tags/", "/hashtag/", "/search/", "/explore/", "/topics/",
        "/category/", "/directory/", "/listing/", "/listings/",
      ],
    },
    // Applied to title/snippet text of non-social pages only.
    noisyPhrases: [
      "success story", "placement program", "press coverage",
      "research paper", "press release", "top 10", "list of",
    ],

    // LOW value
    serviceHosts: [
      "topmate.io", "preplaced.in", "mentorcruise.com", "superpeer.com",
      "adplist.org", "fiverr.com", "urbanpro.com", "sulekha.com",
      "justdial.com", "calendly.com",
    ],
    documentHosts: [
      "scribd.com", "slideshare.net", "docplayer.net", "pdfcoffee.com",
      "studylib.net", "yumpu.com", "issuu.com", "vdocuments.mx", "dokumen.pub",
    ],
    documentPathFragments: ["/document/", "/documents/", "/doc/", "/pdf/"],
    documentExtensions: [".pdf", ".doc", ".docx", ".ppt", ".pptx"],
    aggregatorHosts: [
      "humantic.ai", "peekyou.com", "spokeo.com", "radaris.com",
      "whitepages.com", "pipl.com", "beenverified.com", "mylife.com",
      "411.com", "fastpeoplesearch.com", "truepeoplesearch.com",
      "clustrmaps.com", "rocketreach.co", "zoominfo.com", "contactout.com",
      "signalhire.com", "lusha.com", "apollo.io", "datanyze.com",
    ],
    // host label match, e.g. amazon.com / amazon.in / ebay.co.uk
    listingHostLabels: ["amazon", "ebay", "flipkart", "olx", "indiamart"],

    // MEDIUM value
    personalLinkHosts: ["about.me", "linktr.ee", "bio.link", "carrd.co"],
    resumeProfileHosts: [
      "kaampaao.com", "naukri.com", "apna.co", "foundit.in", "shine.com",
      "cakeresume.com", "flowcv.me", "resume.io", "indeed.com",
    ],
    directoryHosts: ["theorg.com", "crunchbase.com", "wellfound.com", "angel.co"],

    // HIGH value "other clear personal professional profiles".
    // mode: single (domain.com/<user>), at (domain.com/@user),
    //       prefix (domain.com/<prefix>/...), any
    professionalProfileHosts: {
      "stackoverflow.com": { mode: "prefix", prefixes: ["users"] },
      "dev.to": { mode: "single" },
      "medium.com": { mode: "at" },
      "behance.net": { mode: "single" },
      "dribbble.com": { mode: "single" },
      "kaggle.com": { mode: "single" },
      "leetcode.com": { mode: "single" },
      "hackerrank.com": { mode: "single" },
      "codepen.io": { mode: "single" },
      "gitlab.com": { mode: "single" },
      "bitbucket.org": { mode: "single" },
      "huggingface.co": { mode: "single" },
      "peerlist.io": { mode: "single" },
      "hashnode.com": { mode: "at" },
      "youtube.com": { mode: "at" },
      "codechef.com": { mode: "prefix", prefixes: ["users"] },
      "researchgate.net": { mode: "prefix", prefixes: ["profile"] },
      "scholar.google.com": { mode: "prefix", prefixes: ["citations"], minSegments: 1 },
      "orcid.org": { mode: "any" },
    },
    reservedFirstSegments: [
      "t", "tag", "tags", "search", "about", "explore", "topics", "jobs",
      "pricing", "login", "signup", "blog", "docs", "courses", "problems",
      "contest", "discuss", "questions", "explore", "help", "support",
    ],

    // personal sites on free hosting: name in the sub-domain => personal site
    hostingPlatforms: [
      "github.io", "netlify.app", "vercel.app", "pages.dev", "web.app",
      "firebaseapp.com", "framer.website", "wixsite.com", "notion.site",
      "webflow.io", "herokuapp.com", "onrender.com",
    ],

    genericProfilePathSegments: [
      "profile", "profiles", "people", "user", "users", "member",
      "members", "author", "in", "u",
    ],

    // Pages that mention OTHER people with a job role are multi-person
    // pages (never applied to HIGH-value personal profiles).
    multiPersonMinOthers: 1,

    // Image URLs that are not a person's photo.
    imageIgnorePatterns: [
      "/background/", "githubassets.com", "devicons", "shields.io",
      "camo.githubusercontent.com", "badge", "logo", "banner",
    ],
  },

  corroboration: { minUsernameLength: 5 },

  domain: {
    // Weight of a matched term, by kind of term.
    kindWeights: { title: 3, field: 2, context: 1.2, weak: 0.8 },
    candidateExperienceTrust: 0.6,
    maxDomainScore: 6,
    contextMaxScore: 1.5, // tool/keyword words alone never make a profession

    minDetectScore: 0.5,
    minRelatedScore: 0.5,
    highConfidenceScore: 2.0,
    mediumConfidenceScore: 1.0,
    conflictScore: 2.0,

    // Domains that do not conflict with each other (symmetric).
    adjacency: {
      software: ["data", "devops", "research", "ux"],
      data: ["software", "devops", "research"],
      devops: ["software", "data"],
      research: ["software", "data"],
      ux: ["software"],
    },

    // title   = explicit occupation / job-title phrase (strongest)
    // field   = explicit field-of-work phrase
    // context = supporting vocabulary (capped)
    // weak    = generic single words (very low weight)
    // strip   = phrases removed BEFORE matching (kill known false positives)
    // conflictEligible:false = this domain can never count as a conflict
    definitions: {
      software: {
        title: [
          "software developer", "software engineer",
          "software development engineer", "software architect",
          "web developer", "web engineer", "full stack web developer",
          "full stack developer", "full stack engineer",
          "fullstack developer", "fullstack engineer",
          "front end developer", "front end engineer",
          "frontend developer", "frontend engineer",
          "back end developer", "back end engineer",
          "backend developer", "backend engineer",
          "application developer", "application engineer",
          "javascript developer", "typescript developer",
          "node js developer", "nodejs developer",
          "react developer", "react js developer", "react native developer",
          "mern stack developer", "mean stack developer",
          "mobile app developer", "mobile application developer",
          "mobile app engineer", "mobile developer",
          "android developer", "ios developer", "flutter developer",
          "python developer", "java developer", "php developer",
          "laravel developer", "django developer", "golang developer",
          "net developer", "programmer", "sde",
        ],
        field: [
          "software development", "software engineering",
          "web development", "full stack development",
          "mobile app development", "application development",
        ],
        context: [
          "javascript", "typescript", "node js", "nodejs",
          "react js", "mern stack", "programming",
        ],
        weak: ["developer", "coder"],
        strip: [
          "real estate developer", "property developer", "land developer",
        ],
      },

      data: {
        title: [
          "data scientist", "data analyst", "data engineer",
          "machine learning engineer", "machine learning developer",
          "machine learning researcher", "machine learning scientist",
          "ml engineer", "ml researcher",
          "ai engineer", "ai developer", "ai researcher", "ai scientist",
          "artificial intelligence engineer",
          "artificial intelligence researcher",
          "nlp engineer", "deep learning engineer",
        ],
        field: [
          "machine learning", "deep learning", "data science",
          "artificial intelligence", "computer vision",
          "natural language processing",
        ],
        context: ["tensorflow", "pytorch", "analytics"],
      },

      devops: {
        title: [
          "devops engineer", "cloud engineer", "platform engineer",
          "site reliability engineer", "sre", "cloud architect",
          "infrastructure engineer",
        ],
        field: ["devops", "cloud computing"],
        context: ["kubernetes", "docker", "ci cd"],
      },

      research: {
        title: [
          "research scientist", "research fellow", "research professor",
          "academic researcher", "researcher", "research associate",
          "phd researcher", "postdoctoral researcher",
        ],
        context: ["phd", "postdoctoral"],
        conflictEligible: false,
      },

      ux: {
        title: [
          "product designer", "ui designer", "ux designer",
          "ui ux designer", "ux ui designer", "web designer",
          "visual designer", "interaction designer", "ux researcher",
        ],
        field: ["ui ux", "user experience", "user interface design"],
        context: ["figma"],
        conflictEligible: false,
      },

      design: {
        title: [
          "interior designer", "graphic designer", "fashion designer",
          "jewellery designer", "jewelry designer", "landscape designer",
        ],
        field: ["interior design", "fashion design"],
      },

      sports: {
        title: [
          "professional cricketer", "cricketer", "professional footballer",
          "footballer", "athlete", "sportsperson", "sportsman",
          "sportswoman", "kabaddi player", "basketball player",
          "hockey player", "tennis player", "badminton player",
          "wrestler", "boxer", "olympian",
        ],
        field: ["professional sports"],
        context: [
          "ipl", "bcci", "cricket", "football club", "olympics",
          "olympic", "fifa", "premier league", "ranji trophy",
          "national team",
        ],
      },

      entertainment: {
        title: [
          "actor", "actress", "film actor", "movie actor",
          "television actor", "tv actor", "bollywood actor",
          "bollywood actress", "singer", "playback singer",
          "film director", "film producer", "filmmaker",
          "fashion model", "supermodel", "ramp model", "male model",
          "female model", "glamour model", "dancer", "choreographer",
          "comedian",
        ],
        field: ["acting", "filmmaking"],
        context: [
          "bollywood", "tollywood", "kollywood", "hollywood",
          "film industry", "web series", "filmography", "box office",
        ],
        // "actor model" (concurrency), "threat actor" (security) ...
        strip: [
          "actor model", "actor framework", "actor system",
          "actor pattern", "threat actor", "bad actor", "akka actor",
        ],
      },

      politics: {
        title: [
          "politician", "political leader", "mla",
          "member of parliament", "member of legislative assembly",
          "member of legislative council", "mlc", "chief minister",
          "union minister", "cabinet minister", "state minister",
          "minister of", "councillor", "sarpanch", "mayor",
          "political secretary", "congress leader", "bjp leader",
          "party leader", "senator",
        ],
        context: [
          "lok sabha", "rajya sabha", "vidhan sabha",
          "legislative assembly", "political party", "bjp",
          "election campaign", "constituency",
        ],
      },

      medical: {
        title: [
          "physician", "surgeon", "dentist", "cardiologist",
          "pediatrician", "gynecologist", "orthopedic surgeon",
          "medical doctor", "general practitioner", "radiologist",
          "dermatologist", "psychiatrist", "neurologist",
        ],
        context: ["mbbs", "hospital", "clinic"],
        weak: ["doctor"],
      },

      legal: {
        title: [
          "lawyer", "attorney", "barrister", "solicitor",
          "legal counsel", "public prosecutor", "judge", "magistrate",
        ],
        context: ["high court", "supreme court", "bar council"],
      },

      finance: {
        title: [
          "chartered accountant", "investment banker",
          "financial advisor", "stock broker",
        ],
      },

      // "Rahul Sharma, CEO / corporate strategy" is a different profession.
      // A developer who is also a founder shows software evidence too, and
      // then this is not counted as a conflict (see analyzeDomainRelevance).
      executive: {
        title: [
          "ceo", "chief executive officer", "managing director",
          "chairman", "chairperson", "chief operating officer",
          "president and ceo", "vice president of strategy",
        ],
        field: [
          "corporate strategy", "business strategy", "corporate finance",
          "management consulting", "private equity",
        ],
        context: ["board of directors", "shareholders"],
      },
    },
  },

  location: {
    // A place found in free text only counts when it follows one of these
    // words, starts the text, or forms a "city, state/country" pair.
    contextWords: [
      "in", "based", "location", "located", "lives", "living",
      "resides", "residing", "near",
    ],
    // "london school of economics" is not a residence.
    nonLocationFollowers: [
      "university", "college", "school", "institute", "institution",
      "stock", "exchange", "bank", "times", "post", "news",
      "polytechnic", "academy", "hospital", "police",
    ],

    // ccTLD hint (weak, LOW confidence only). Generic TLDs (.com/.io) ignored.
    tldCountries: {
      in: "india", np: "nepal", pk: "pakistan", bd: "bangladesh",
      lk: "sri lanka", uk: "united kingdom", nl: "netherlands",
      de: "germany", fr: "france", ca: "canada", au: "australia",
      sg: "singapore", ae: "united arab emirates", jp: "japan", cn: "china",
    },

    // ISO-style codes accepted ONLY inside structured country fields.
    countryCodes: {
      in: "india", ind: "india",
      us: "united states", usa: "united states",
      gb: "united kingdom", gbr: "united kingdom", uk: "united kingdom",
      nl: "netherlands", nld: "netherlands",
      ca: "canada", can: "canada",
      au: "australia", aus: "australia",
      de: "germany", deu: "germany",
      fr: "france", fra: "france",
      sg: "singapore", sgp: "singapore",
      ae: "united arab emirates", are: "united arab emirates",
    },

    // Ambiguous names (e.g. "punjab" exists in India and Pakistan,
    // "washington", "georgia") are intentionally left out.
    countries: {
      india: {
        aliases: ["india", "bharat"],
        states: [
          "andhra pradesh", "arunachal pradesh", "assam", "bihar",
          "chhattisgarh", "goa", "gujarat", "haryana", "himachal pradesh",
          "jharkhand", "karnataka", "kerala", "madhya pradesh",
          "maharashtra", "manipur", "meghalaya", "mizoram", "nagaland",
          "odisha", "rajasthan", "sikkim", "tamil nadu", "telangana",
          "tripura", "uttar pradesh", "uttarakhand", "west bengal",
          "jammu and kashmir", "delhi ncr", "national capital region",
        ],
        cities: [
          "indore", "bhopal", "ujjain", "jabalpur", "gwalior", "raipur",
          "mumbai", "pune", "nagpur", "nashik", "delhi", "new delhi",
          "noida", "greater noida", "gurgaon", "gurugram", "faridabad",
          "ghaziabad", "bangalore", "bengaluru", "mysore", "mysuru",
          "hyderabad", "chennai", "coimbatore", "kochi",
          "thiruvananthapuram", "kolkata", "ahmedabad", "surat",
          "vadodara", "jaipur", "lucknow", "chandigarh", "patna",
          "ranchi", "bhubaneswar", "visakhapatnam",
        ],
      },
      "united states": {
        aliases: ["united states", "united states of america", "usa", "u s a"],
        states: [
          "california", "texas", "florida", "new york", "new jersey",
          "massachusetts", "illinois", "virginia", "north carolina",
        ],
        cities: [
          "new york city", "san francisco", "los angeles", "san jose",
          "seattle", "austin", "boston", "chicago", "houston", "dallas",
          "atlanta", "san diego",
        ],
      },
      "united kingdom": {
        aliases: ["united kingdom", "uk", "u k", "great britain", "britain"],
        states: ["england", "scotland", "wales", "northern ireland"],
        cities: [
          "london", "manchester", "birmingham", "leeds", "glasgow",
          "edinburgh", "bristol", "liverpool",
        ],
      },
      netherlands: {
        aliases: ["netherlands", "the netherlands", "holland"],
        cities: [
          "den haag", "the hague", "amsterdam", "rotterdam", "utrecht",
          "eindhoven",
        ],
      },
      canada: {
        aliases: ["canada"],
        states: ["ontario", "british columbia", "quebec", "alberta"],
        cities: ["toronto", "vancouver", "montreal", "ottawa", "calgary"],
      },
      australia: {
        aliases: ["australia"],
        cities: ["sydney", "melbourne", "brisbane", "perth"],
      },
      germany: {
        aliases: ["germany", "deutschland"],
        cities: ["berlin", "munich", "hamburg", "frankfurt"],
      },
      france: { aliases: ["france"], cities: ["paris", "lyon"] },
      singapore: { aliases: ["singapore"] },
      "united arab emirates": {
        aliases: ["united arab emirates", "uae", "u a e"],
        cities: ["dubai", "abu dhabi", "sharjah"],
      },
      pakistan: {
        aliases: ["pakistan"],
        cities: ["karachi", "lahore", "islamabad"],
      },
      bangladesh: { aliases: ["bangladesh"], cities: ["dhaka"] },
      nepal: { aliases: ["nepal"], cities: ["kathmandu"] },
      "sri lanka": { aliases: ["sri lanka"], cities: ["colombo"] },
      china: {
        aliases: ["china"],
        cities: ["beijing", "shanghai", "shenzhen"],
      },
      japan: { aliases: ["japan"], cities: ["tokyo", "osaka"] },
    },
  },
};

// ============================================================
// SMALL HELPERS
// ============================================================

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Deep merge. Arrays and primitives in `overrides` REPLACE the base value.
const mergeConfig = (base, overrides) => {
  if (!isPlainObject(overrides)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    out[key] =
      isPlainObject(value) && isPlainObject(base[key])
        ? mergeConfig(base[key], value)
        : value;
  }
  return out;
};

const asText = (v) =>
  typeof v === "string" || typeof v === "number" ? String(v) : "";

// Lowercase, strip accents, collapse everything non-alphanumeric to a
// single space. Matching is then done on " token token " strings, which
// gives exact word/phrase-boundary matching without regex (so
// "developers" does NOT match "developer", "mp" never matches "mpg").
const normalizeForMatch = (value) =>
  asText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const uniq = (arr) => [...new Set(arr)];
const round1 = (n) => Math.round(n * 10) / 10;

const parseUrl = (value) => {
  const text = asText(value).trim();
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return {
      host: url.hostname.toLowerCase().replace(/^www\./, ""),
      segments: url.pathname
        .split("/")
        .filter(Boolean)
        .map((s) => decodeURIComponent(s).toLowerCase()),
      search: url.search.toLowerCase(),
    };
  } catch {
    return null;
  }
};

const hostIn = (host, list) =>
  Boolean(host) && list.some((d) => host === d || host.endsWith(`.${d}`));

// ============================================================
// RUNTIME (compiled config, cached)
// ============================================================

const buildRuntime = (config) => {
  // ---- domain matchers
  const domainMatchers = {};

  for (const [domain, def] of Object.entries(config.domain.definitions)) {
    const terms = [];
    const seen = new Set();

    for (const kind of ["title", "field", "context", "weak"]) {
      for (const raw of def[kind] || []) {
        const text = normalizeForMatch(raw);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        terms.push({
          text,
          padded: ` ${text} `,
          kind,
          weight: config.domain.kindWeights[kind],
        });
      }
    }

    domainMatchers[domain] = {
      terms,
      strip: (def.strip || [])
        .map(normalizeForMatch)
        .filter(Boolean)
        .map((t) => ({ padded: ` ${t} ` })),
      conflictEligible: def.conflictEligible !== false,
    };
  }

  // ---- adjacency (symmetric)
  const adjacency = {};
  for (const [a, list] of Object.entries(config.domain.adjacency || {})) {
    adjacency[a] = adjacency[a] || new Set();
    for (const b of list) {
      adjacency[a].add(b);
      adjacency[b] = adjacency[b] || new Set();
      adjacency[b].add(a);
    }
  }

  // ---- place index: normalized phrase -> { type, country, name }
  const placeIndex = new Map();
  let maxPlaceWords = 1;

  const addPlace = (term, type, country) => {
    const name = normalizeForMatch(term);
    if (!name || placeIndex.has(name)) return;
    placeIndex.set(name, { type, country, name });
    maxPlaceWords = Math.max(maxPlaceWords, name.split(" ").length);
  };

  for (const [countryName, def] of Object.entries(config.location.countries)) {
    const canonical = normalizeForMatch(countryName);
    addPlace(countryName, "country", canonical);
    (def.aliases || []).forEach((a) => addPlace(a, "country", canonical));
    (def.states || []).forEach((s) => addPlace(s, "state", canonical));
    (def.cities || []).forEach((c) => addPlace(c, "city", canonical));
  }

  const countryCodes = {};
  for (const [code, country] of Object.entries(config.location.countryCodes || {})) {
    countryCodes[normalizeForMatch(code)] = normalizeForMatch(country);
  }

  return {
    config,
    domainMatchers,
    adjacency,
    placeIndex,
    maxPlaceWords,
    countryCodes,
    contextWords: new Set(config.location.contextWords.map(normalizeForMatch)),
    nonLocationFollowers: new Set(
      config.location.nonLocationFollowers.map(normalizeForMatch)
    ),
    noisyPhrases: config.pages.noisyPhrases.map(normalizeForMatch),
  };
};

const DEFAULT_RUNTIME = buildRuntime(DEFAULT_CONFIG);
const runtimeCache = new WeakMap();

const resolveRuntime = (overrides) => {
  if (!isPlainObject(overrides)) return DEFAULT_RUNTIME;
  if (!runtimeCache.has(overrides)) {
    runtimeCache.set(
      overrides,
      buildRuntime(mergeConfig(DEFAULT_CONFIG, overrides))
    );
  }
  return runtimeCache.get(overrides);
};


// ============================================================
// ML TEXT BUILDERS
// ============================================================

const compactText = (value, max = 1200) =>
  asText(value).replace(/\s+/g, " ").trim().slice(0, max);

const buildCandidateMLText = (candidate) => {
  if (!candidate) return "";

  const parts = [
    candidate.fullName && `Name: ${candidate.fullName}`,
    candidate.currentJobTitle && `Current job: ${candidate.currentJobTitle}`,
    candidate.currentCompany && `Current company: ${candidate.currentCompany}`,
    candidate.location &&
      `Location: ${
        isPlainObject(candidate.location)
          ? [
              candidate.location.city,
              candidate.location.state,
              candidate.location.country,
            ]
              .filter(Boolean)
              .join(", ")
          : candidate.location
      }`,
  ];

  if (Array.isArray(candidate.experience)) {
    candidate.experience.slice(0, 8).forEach((item) => {
      const value = [
        item?.jobTitle || item?.role || item?.title,
        item?.company,
      ]
        .filter(Boolean)
        .join(" at ");

      if (value) parts.push(`Experience: ${value}`);
    });
  }

  if (Array.isArray(candidate.education)) {
    candidate.education.slice(0, 5).forEach((item) => {
      const value = [
        item?.degree,
        item?.fieldOfStudy,
        item?.institution,
      ]
        .filter(Boolean)
        .join(" ");

      if (value) parts.push(`Education: ${value}`);
    });
  }

  return compactText(parts.filter(Boolean).join(" | "), 3000);
};

const buildSearchResultMLText = (searchResult) => {
  if (!searchResult) return "";

  const parts = [
    searchResult.name && `Name: ${searchResult.name}`,
    searchResult.username && `Username: ${searchResult.username}`,
    searchResult.jobTitle && `Job title: ${searchResult.jobTitle}`,
    searchResult.company && `Company: ${searchResult.company}`,

    searchResult.location &&
      `Location: ${
        isPlainObject(searchResult.location)
          ? [
              searchResult.location.city,
              searchResult.location.state,
              searchResult.location.country,
            ]
              .filter(Boolean)
              .join(", ")
          : searchResult.location
      }`,

    searchResult.headline &&
      `Headline: ${searchResult.headline}`,

    searchResult.bio &&
      `Bio: ${searchResult.bio}`,

    searchResult.about &&
      `About: ${searchResult.about}`,
  ];

  const raw = searchResult.rawData;

  /*
   * IMPORTANT:
   * BGE-M3 should receive useful identity/professional text only.
   * Do NOT send full webpage content, raw text dumps,
   * or provider result dumps.
   */

  if (typeof raw === "string") {
    parts.push(
      `Search content: ${compactText(raw, 500)}`
    );
  } else if (isPlainObject(raw)) {
    // Useful professional / identity fields only.
    const usefulFields = [
      ["occupation", "Occupation"],
      ["position", "Position"],
      ["role", "Role"],
      ["jobTitle", "Job title"],
      ["headline", "Headline"],
      ["bio", "Bio"],
      ["about", "About"],
      ["summary", "Summary"],
    ];

    for (const [key, label] of usefulFields) {
      if (raw[key]) {
        parts.push(
          `${label}: ${compactText(raw[key], 300)}`
        );
      }
    }

    // Search engine title/snippet are useful,
    // but keep them very small.
    if (raw.title) {
      parts.push(
        `Search title: ${compactText(raw.title, 250)}`
      );
    }

    if (raw.snippet) {
      parts.push(
        `Search snippet: ${compactText(raw.snippet, 500)}`
      );
    }

    /*
     * DO NOT include:
     * raw.content
     * raw.text
     * raw.providerResults
     *
     * These can contain huge webpage dumps and were causing
     * very large BGE-M3 requests.
     */
  }

  // Final hard limit for every individual result.
  return compactText(
    parts.filter(Boolean).join(" | "),
    1500
  );
};
// ============================================================
// BGE-M3 IN BATCHES (cached, failure-tolerant)
// ============================================================

/**
 * Sends `resultTexts` to BGE-M3 (cached, de-duplicated, bounded concurrency,
 * circuit breaker - see mlMatch.service.scoreTexts).
 * Returns an array aligned with `resultTexts`:
 *   [{ similarityPercent: number | null, status: SCORED|CACHED|UNAVAILABLE|EMPTY }]
 * A failed request is `null`/UNAVAILABLE - never a similarity of 0; the caller
 * keeps the deterministic (rule-based) rank for those results.
 */
const getMLScoresBatched = async ({ candidateText, resultTexts, mlConfig = {} }) =>
  mlService.scoreTexts({
    candidateText,
    resultTexts,
    batchSize: mlConfig.batchSize,
    cacheMax: mlConfig.cacheMax,
    timeoutMs: mlConfig.timeoutMs,
  });

// ============================================================
// TEXT SOURCES
// ============================================================

/**
 * Collect text from a SearchResult WITH a trust level per source.
 * URLs are deliberately NOT included (a username like
 * "rahul-politics-india" must not create domains / locations).
 * rawData is NOT JSON.stringified.
 */
const getTextSources = (searchResult, runtime) => {
  const { textTrust, maxSourceChars, maxProviderResults } = runtime.config;
  const sources = [];

  // "@RahulSharma_CEO" in a headline is a handle, not evidence of a
  // profession: @handles are removed from text and only act through the
  // low-trust USERNAME source.
  const push = (field, value, trustName) => {
    const text = normalizeForMatch(
      asText(value).slice(0, maxSourceChars).replace(/@[\w.\-]+/g, " ")
    );
    if (!text) return;
    sources.push({ field, text, trustName, trust: textTrust[trustName] });
  };

  if (!searchResult) return sources;

  push("jobTitle", searchResult.jobTitle, "STRUCTURED");
  push("headline", searchResult.headline, "STRUCTURED");
  push("bio", searchResult.bio, "BIO");
  push("about", searchResult.about, "BIO");
  // weak hint only ("RahulSharma_CEO"); never used for location
  push("username", searchResult.username, "USERNAME");

  const raw = searchResult.rawData;

  if (typeof raw === "string") {
    push("rawData", raw, "SNIPPET");
  } else if (isPlainObject(raw)) {
    for (const key of [
      "occupation", "position", "role", "jobTitle", "job_title", "headline",
    ]) {
      push(`raw.${key}`, raw[key], "STRUCTURED");
    }

    push("raw.title", raw.title, "TITLE");

    for (const key of ["bio", "about", "summary"]) {
      push(`raw.${key}`, raw[key], "BIO");
    }

    for (const key of ["snippet", "description", "content", "text"]) {
      push(`raw.${key}`, raw[key], "SNIPPET");
    }

    if (Array.isArray(raw.providerResults)) {
      raw.providerResults.slice(0, maxProviderResults).forEach((pr, i) => {
        if (!isPlainObject(pr)) return;
        push(`providerResults[${i}].title`, pr.title, "TITLE");
        for (const key of ["snippet", "description", "content"]) {
          push(`providerResults[${i}].${key}`, pr[key], "SNIPPET");
        }
      });
    }
  }

  return sources;
};

/**
 * Original-case texts (de-duplicated) used for contact matching, link
 * extraction and "other people on this page" detection.
 */
const collectRawTexts = (searchResult, runtime) => {
  const { maxRawTextChars, maxProviderResults } = runtime.config;
  const seen = new Set();
  const texts = [];

  const push = (field, value) => {
    const text = asText(value).slice(0, maxRawTextChars);
    if (!text.trim() || seen.has(text)) return;
    seen.add(text);
    texts.push({ field, text });
  };

  if (!searchResult) return texts;

  push("headline", searchResult.headline);
  push("bio", searchResult.bio);
  push("about", searchResult.about);

  const raw = searchResult.rawData;
  if (typeof raw === "string") {
    push("rawData", raw);
  } else if (isPlainObject(raw)) {
    for (const key of ["title", "snippet", "description", "content", "text", "bio", "about", "summary"]) {
      push(`raw.${key}`, raw[key]);
    }
    if (Array.isArray(raw.providerResults)) {
      raw.providerResults.slice(0, maxProviderResults).forEach((pr, i) => {
        if (!isPlainObject(pr)) return;
        for (const key of ["title", "snippet", "description", "content"]) {
          push(`providerResults[${i}].${key}`, pr[key]);
        }
      });
    }
  }

  return texts;
};

// ============================================================
// DOMAIN DETECTION
// ============================================================

/**
 * Score every domain over a list of trusted text sources.
 * - phrase + word-boundary aware (token matching, no substrings)
 * - each distinct term counts once
 * - a term contained in a longer matched term of the same domain is
 *   dropped ("developer" inside "software developer")
 * - context words (tool names) are capped: they never make a profession
 */
const scoreDomains = (sources, runtime) => {
  const { domainMatchers, config } = runtime;
  const best = new Map();

  for (const source of sources) {
    const padded = ` ${source.text} `;

    for (const [domain, matcher] of Object.entries(domainMatchers)) {
      let text = padded;

      for (const s of matcher.strip) {
        if (text.includes(s.padded)) text = text.split(s.padded).join(" ");
      }

      for (const term of matcher.terms) {
        if (!text.includes(term.padded)) continue;

        const value = term.weight * source.trust;
        const key = `${domain}|${term.text}`;
        const previous = best.get(key);

        if (!previous || value > previous.value) {
          best.set(key, {
            domain,
            term: term.text,
            kind: term.kind,
            source: source.field,
            value,
          });
        }
      }
    }
  }

  const byDomain = {};
  for (const entry of best.values()) {
    if (!byDomain[entry.domain]) byDomain[entry.domain] = [];
    byDomain[entry.domain].push(entry);
  }

  const scores = {};
  const evidence = [];

  for (const [domain, entries] of Object.entries(byDomain)) {
    const kept = entries.filter(
      (e) =>
        !entries.some(
          (o) =>
            o !== e &&
            o.term !== e.term &&
            ` ${o.term} `.includes(` ${e.term} `)
        )
    );

    const explicit = kept
      .filter((e) => e.kind !== "context")
      .reduce((sum, e) => sum + e.value, 0);
    const contextual = Math.min(
      kept
        .filter((e) => e.kind === "context")
        .reduce((sum, e) => sum + e.value, 0),
      config.domain.contextMaxScore
    );

    scores[domain] = Math.min(explicit + contextual, config.domain.maxDomainScore);
    evidence.push(...kept);
  }

  const domains = Object.keys(scores)
    .filter((d) => scores[d] >= config.domain.minDetectScore)
    .sort((a, b) => scores[b] - scores[a]);

  evidence.sort((a, b) => b.value - a.value);

  return { scores, domains, evidence };
};

const getCandidateDomainProfile = (candidate, runtime, memo) => {
  const cacheKey = candidate?._id ? `domain:${String(candidate._id)}` : null;
  if (cacheKey && memo?.has(cacheKey)) return memo.get(cacheKey);

  const sources = [];
  const trust = runtime.config.domain.candidateExperienceTrust;

  const currentText = normalizeForMatch(candidate?.currentJobTitle);
  if (currentText) {
    sources.push({ field: "currentJobTitle", text: currentText, trust: 1 });
  }

  const experience = Array.isArray(candidate?.experience)
    ? candidate.experience
    : [];

  experience.forEach((item, i) => {
    const text = normalizeForMatch(
      [item?.jobTitle, item?.role, item?.title].filter(Boolean).join(" ")
    );
    if (text) sources.push({ field: `experience[${i}]`, text, trust });
  });

  const profile = scoreDomains(sources, runtime);

  if (cacheKey && memo) memo.set(cacheKey, profile);
  return profile;
};

const domainsAreAdjacent = (runtime, a, b) =>
  Boolean(runtime.adjacency[a]?.has(b) || runtime.adjacency[b]?.has(a));

const analyzeDomainRelevance = (
  candidate,
  searchResult,
  runtime = DEFAULT_RUNTIME,
  memo = null,
  sources = null
) => {
  const cfg = runtime.config.domain;
  const candidateProfile = getCandidateDomainProfile(candidate, runtime, memo);
  const resultProfile = scoreDomains(
    sources || getTextSources(searchResult, runtime),
    runtime
  );

  const base = {
    candidateDomains: candidateProfile.domains,
    candidatePrimaryDomain: candidateProfile.domains[0] || null,
    resultDomains: resultProfile.domains,
    resultPrimaryDomain: resultProfile.domains[0] || null,
    resultSecondaryDomains: resultProfile.domains.slice(1),
    domainScores: resultProfile.scores,
    evidence: resultProfile.evidence.slice(0, 6),
  };

  // Missing information is UNKNOWN, not a mismatch.
  if (!candidateProfile.domains.length || !resultProfile.domains.length) {
    return {
      ...base,
      related: null,
      relation: "UNKNOWN",
      primaryRelation: "UNKNOWN",
      confidence: "UNKNOWN",
      overlappingDomains: [],
      conflicts: [],
    };
  }

  const scores = resultProfile.scores;

  const overlappingDomains = candidateProfile.domains.filter(
    (d) => (scores[d] || 0) >= cfg.minRelatedScore
  );

  const adjacentDomains = resultProfile.domains.filter(
    (d) =>
      !candidateProfile.domains.includes(d) &&
      candidateProfile.domains.some((c) => domainsAreAdjacent(runtime, c, d))
  );

  const directScore = Math.max(0, ...overlappingDomains.map((d) => scores[d]));
  const adjacentScore = Math.max(0, ...adjacentDomains.map((d) => scores[d]));

  let relation = "NONE";
  if (directScore >= cfg.minRelatedScore) relation = "DIRECT";
  else if (adjacentScore >= cfg.minRelatedScore) relation = "ADJACENT";

  // Is the profile's PRIMARY identity the candidate's domain?
  // "UI/UX designer who also codes" is DIRECT but not primary-aligned.
  const resultPrimary = resultProfile.domains[0];
  let primaryRelation = "OTHER";
  if (candidateProfile.domains.includes(resultPrimary)) primaryRelation = "ALIGNED";
  else if (adjacentDomains.includes(resultPrimary)) primaryRelation = "ADJACENT";

  // A conflict needs a domain that is unrelated to the candidate, strong
  // enough on its own, and STRONGER than any relevant evidence. Mixed
  // profiles (software + ML, software + cricket hobby) are not conflicts.
  const relevantScore = Math.max(directScore, adjacentScore);

  const conflicts = resultProfile.domains.filter(
    (d) =>
      !candidateProfile.domains.includes(d) &&
      !adjacentDomains.includes(d) &&
      runtime.domainMatchers[d]?.conflictEligible &&
      scores[d] >= cfg.conflictScore &&
      scores[d] > relevantScore
  );

  // HIGH/MEDIUM confidence needs an explicit job-title / field phrase.
  const hasExplicitEvidence = resultProfile.evidence.some(
    (e) =>
      overlappingDomains.includes(e.domain) &&
      (e.kind === "title" || e.kind === "field")
  );

  let confidence = "LOW";
  if (relation === "DIRECT" && hasExplicitEvidence) {
    if (directScore >= cfg.highConfidenceScore) confidence = "HIGH";
    else if (directScore >= cfg.mediumConfidenceScore) confidence = "MEDIUM";
  } else if (relation === "ADJACENT") {
    confidence = adjacentScore >= cfg.highConfidenceScore ? "MEDIUM" : "LOW";
  }

  return {
    ...base,
    related: relation !== "NONE",
    relation,
    primaryRelation,
    confidence,
    overlappingDomains,
    conflicts,
  };
};

// ============================================================
// LOCATION
// ============================================================

/**
 * Find places in normalized text using the gazetteer (longest phrase wins).
 * With requireContext=true a place only counts when:
 *  - it starts the text, or
 *  - the previous word is a context word ("in", "based", "location"...), or
 *  - it forms a "city, state/country" pair with a neighbouring place of
 *    the same country ("Den Haag, Netherlands"), even without "in",
 * and it is not followed by e.g. "university" / "school".
 */
const findPlaces = (text, runtime, requireContext) => {
  if (!text) return [];

  const tokens = text.split(" ").filter(Boolean);
  const found = [];

  let i = 0;
  while (i < tokens.length) {
    let hit = null;
    const longest = Math.min(runtime.maxPlaceWords, tokens.length - i);

    for (let n = longest; n >= 1; n--) {
      const entry = runtime.placeIndex.get(tokens.slice(i, i + n).join(" "));
      if (entry) {
        hit = { start: i, end: i + n, entry };
        break;
      }
    }

    if (hit) {
      found.push(hit);
      i = hit.end;
    } else {
      i += 1;
    }
  }

  if (!requireContext) return found.map((f) => f.entry);

  const accepted = [];

  found.forEach((f, idx) => {
    const previousToken = tokens[f.start - 1];
    const nextToken = tokens[f.end];
    const previousHit = found[idx - 1];
    const nextHit = found[idx + 1];

    if (nextToken && runtime.nonLocationFollowers.has(nextToken)) return;

    const sameCountryAs = (other) =>
      other && other.entry.country === f.entry.country;

    const pairedWithNext =
      nextHit && nextHit.start === f.end && sameCountryAs(nextHit);
    const pairedWithPrev =
      previousHit && previousHit.end === f.start && sameCountryAs(previousHit);

    const ok =
      f.start === 0 ||
      (previousToken && runtime.contextWords.has(previousToken)) ||
      (previousHit &&
        previousHit.end === f.start &&
        accepted.includes(previousHit)) ||
      pairedWithNext ||
      pairedWithPrev;

    if (ok) accepted.push(f);
  });

  return accepted.map((f) => f.entry);
};

const getCandidateLocationProfile = (candidate, runtime, memo) => {
  const cacheKey = candidate?._id ? `loc:${String(candidate._id)}` : null;
  if (cacheKey && memo?.has(cacheKey)) return memo.get(cacheKey);

  const loc = candidate?.location;
  let country = null;
  let city = "";

  if (typeof loc === "string") {
    const entries = findPlaces(normalizeForMatch(loc), runtime, false);
    country = entries[0]?.country || null;
    city = entries.find((e) => e.type === "city")?.name || "";
  } else if (isPlainObject(loc)) {
    city = normalizeForMatch(loc.city);
    const state = normalizeForMatch(loc.state);
    const countryText = normalizeForMatch(loc.country);

    if (countryText) {
      country =
        runtime.placeIndex.get(countryText)?.country ||
        runtime.countryCodes[countryText] ||
        countryText;
    }
    if (!country && city) country = runtime.placeIndex.get(city)?.country || null;
    if (!country && state) country = runtime.placeIndex.get(state)?.country || null;
  }

  const profile = { country, city };
  if (cacheKey && memo) memo.set(cacheKey, profile);
  return profile;
};

// HIGH confidence: explicit structured location fields.
const getStructuredResultPlaces = (searchResult, runtime) => {
  const countries = [];
  const cities = [];

  const consume = (value, hint) => {
    const text = normalizeForMatch(value);
    if (!text) return;

    const entries = findPlaces(text, runtime, false);

    if (entries.length) {
      entries.forEach((e) => {
        countries.push(e.country);
        if (e.type === "city") cities.push(e.name);
      });
      if (hint === "city") cities.push(text);
      return;
    }

    if (hint === "country") {
      countries.push(runtime.countryCodes[text] || text);
    } else if (hint === "city") {
      cities.push(text);
    }
  };

  const loc = searchResult?.location;
  if (typeof loc === "string") {
    consume(loc);
  } else if (isPlainObject(loc)) {
    consume(loc.city, "city");
    consume(loc.state);
    consume(loc.country, "country");
  }

  const raw = searchResult?.rawData;
  if (isPlainObject(raw)) {
    const rawLoc = raw.location;
    if (typeof rawLoc === "string") {
      consume(rawLoc);
    } else if (isPlainObject(rawLoc)) {
      consume(rawLoc.city, "city");
      consume(rawLoc.state);
      consume(rawLoc.country, "country");
    }
    consume(raw.address);
    consume(raw.region);
    consume(raw.city, "city");
    consume(raw.country, "country");
  }

  return { countries: uniq(countries), cities: uniq(cities) };
};

const sameCountry = (a, b) =>
  a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);

/**
 * Location analysis (a NEGATIVE SIGNAL, never an identity decision on its
 * own for weak evidence):
 *   UNKNOWN                      candidate or result location unknown
 *   CITY_MATCH                   same country and city
 *   SAME_COUNTRY                 same country, no city info
 *   SAME_COUNTRY_DIFFERENT_CITY  informational only, NOT a conflict
 *   COUNTRY_CONFLICT             different country, HIGH/MEDIUM confidence
 *   POSSIBLE_COUNTRY_CONFLICT    different country but only weak evidence
 *
 * Confidence by source: structured fields (HIGH) > headline/title with a
 * location (MEDIUM) > bio/snippets/ccTLD (LOW).
 */
const analyzeLocation = (
  candidate,
  searchResult,
  runtime = DEFAULT_RUNTIME,
  memo = null,
  sources = null
) => {
  const cand = getCandidateLocationProfile(candidate, runtime, memo);

  const unknown = {
    status: "UNKNOWN",
    conflict: false,
    confidence: "UNKNOWN",
    source: null,
    candidateCountry: cand.country,
    resultCountries: [],
  };

  if (!cand.country || !searchResult) return unknown;

  const textSources = sources || getTextSources(searchResult, runtime);

  const tiers = {
    HIGH: getStructuredResultPlaces(searchResult, runtime),
    MEDIUM: { countries: [], cities: [] },
    LOW: { countries: [], cities: [] },
  };

  let candidateCountryMentionedAnywhere = tiers.HIGH.countries.some((c) =>
    sameCountry(c, cand.country)
  );

  for (const source of textSources) {
    if (source.trustName === "USERNAME") continue;

    const tier =
      source.trustName === "STRUCTURED" || source.trustName === "TITLE"
        ? "MEDIUM"
        : "LOW";

    findPlaces(source.text, runtime, true).forEach((e) => {
      tiers[tier].countries.push(e.country);
      if (e.type === "city") tiers[tier].cities.push(e.name);
    });

    if (
      findPlaces(source.text, runtime, false).some((e) =>
        sameCountry(e.country, cand.country)
      )
    ) {
      candidateCountryMentionedAnywhere = true;
    }
  }

  const tld = parseUrl(searchResult.profileUrl || searchResult.sourceUrl)
    ?.host.split(".")
    .pop();
  const tldCountry = tld && runtime.config.location.tldCountries?.[tld];
  if (tldCountry) {
    tiers.LOW.countries.push(normalizeForMatch(tldCountry));
    if (sameCountry(normalizeForMatch(tldCountry), cand.country)) {
      candidateCountryMentionedAnywhere = true;
    }
  }

  const chosenTier = ["HIGH", "MEDIUM", "LOW"].find(
    (t) => tiers[t].countries.length > 0
  );

  if (!chosenTier) return unknown;

  const countries = uniq(tiers[chosenTier].countries);
  const cities = uniq(tiers[chosenTier].cities);

  const result = {
    confidence: chosenTier,
    source: chosenTier === "HIGH" ? "structured" : "text",
    candidateCountry: cand.country,
    resultCountries: countries,
  };

  if (countries.some((c) => sameCountry(c, cand.country))) {
    const cityMatch =
      cand.city &&
      cities.some((c) => c === cand.city || sameCountry(c, cand.city));

    let status = "SAME_COUNTRY";
    if (cityMatch) status = "CITY_MATCH";
    else if (cities.length) status = "SAME_COUNTRY_DIFFERENT_CITY";

    return { ...result, status, conflict: false };
  }

  // Different country. Hard conflict only with solid evidence: structured
  // field, or a headline/title that does not also mention the candidate's
  // country anywhere else in the result.
  const hard =
    chosenTier === "HIGH" ||
    (chosenTier === "MEDIUM" && !candidateCountryMentionedAnywhere);

  return {
    ...result,
    status: hard ? "COUNTRY_CONFLICT" : "POSSIBLE_COUNTRY_CONFLICT",
    conflict: hard,
  };
};

// ============================================================
// SIGNALS / UPSTREAM CONFLICTS
// ============================================================

const readSignals = (matchedSignals) => {
  const s = matchedSignals || {};
  const has = (key) => Boolean(s[key]?.matched);
  return {
    profileUrl: has("profileUrl"),
    name: has("name"),
    username: has("username"),
    jobTitle: has("jobTitle"),
    company: has("company"),
    location: has("location"),
    education: has("education"),
  };
};

const conflictField = (item) => {
  const label = String(
    typeof item === "string"
      ? item
      : item?.field || item?.signal || item?.type || item?.name || ""
  ).toLowerCase();

  if (label.includes("pagetype") || label.includes("page type") || label.includes("noisy")) return "pageType";
  if (label.includes("name") && !label.includes("username")) return "name";
  if (label.includes("company") || label.includes("employer")) return "company";
  if (label.includes("job") || label.includes("title") || label.includes("role")) return "jobTitle";
  if (label.includes("educat") || label.includes("school") || label.includes("universit")) return "education";
  if (label.includes("location") || label.includes("city") || label.includes("country")) return "location";
  return "other";
};

// ============================================================
// PAGE CLASSIFICATION (actual profile vs content / service / noisy page)
// ============================================================

const makePage = (kind, value, reason, legacyOverride) => {
  const isActualProfile = PROFILE_KINDS.has(kind);

  let legacy = legacyOverride;
  if (!legacy) {
    if (value === PAGE_VALUE.NOISY) legacy = "NOISY";
    else if (kind === "PERSONAL_SOCIAL_PROFILE") legacy = "SOCIAL_PROFILE";
    else if (isActualProfile) legacy = "PROFILE";
    else if (value === PAGE_VALUE.LOW) legacy = "CONTENT";
    else if (kind === "UNKNOWN_PAGE") legacy = "OTHER";
    else legacy = "UNKNOWN";
  }

  return {
    kind,
    value,
    reason,
    legacy,
    isActualProfile,
    isContentPage: value === PAGE_VALUE.LOW || value === PAGE_VALUE.NOISY,
  };
};

const hostToPlatform = (host) => {
  if (!host) return null;
  const table = {
    "linkedin.com": "LINKEDIN",
    "github.com": "GITHUB",
    "instagram.com": "INSTAGRAM",
    "facebook.com": "FACEBOOK",
    "fb.com": "FACEBOOK",
    "twitter.com": "TWITTER",
    "x.com": "TWITTER",
  };
  for (const [domain, platform] of Object.entries(table)) {
    if (host === domain || host.endsWith(`.${domain}`)) return platform;
  }
  return null;
};

const PLATFORM_DOMAIN = {
  LINKEDIN: "linkedin.com",
  GITHUB: "github.com",
  INSTAGRAM: "instagram.com",
  FACEBOOK: "facebook.com",
  TWITTER: "twitter.com",
};

const normalizePlatform = (value) => {
  const p = asText(value).toUpperCase().trim();
  if (p === "X") return "TWITTER";
  return ["LINKEDIN", "GITHUB", "INSTAGRAM", "FACEBOOK", "TWITTER"].includes(p)
    ? p
    : null;
};

const SOCIAL_NON_PROFILE_FIRST_SEGMENT = {
  LINKEDIN: ["company", "school", "jobs", "posts", "pulse", "feed", "groups", "events", "learning", "showcase"],
  INSTAGRAM: ["p", "tv", "stories", "accounts", "directory"],
  TWITTER: ["home", "search", "i", "intent", "share", "settings", "messages", "notifications"],
  FACEBOOK: ["groups", "watch", "events", "marketplace", "sharer", "sharer.php", "permalink.php", "story.php", "photo", "photos", "posts", "public"],
  GITHUB: ["topics", "search", "orgs", "marketplace", "features", "pricing", "about", "settings", "sponsors", "collections", "trending"],
};

const getCandidateNameTokens = (candidate) =>
  normalizeForMatch(candidate?.fullName || candidate?.name)
    .split(" ")
    .filter((t) => t.length >= 3);

const nameInHost = (hostPart, tokens) => {
  if (!tokens.length || !hostPart) return false;
  const letters = hostPart.replace(/[^a-z0-9]/g, "");
  if (letters.includes(tokens.join(""))) return true;
  return tokens.length >= 2 && letters.includes([...tokens].reverse().join(""));
};

const matchProfessionalHost = (host, segments, cfg) => {
  for (const [domain, rule] of Object.entries(cfg.professionalProfileHosts)) {
    if (!(host === domain || host.endsWith(`.${domain}`))) continue;

    const first = segments[0];
    if (!first) return false;
    if (cfg.reservedFirstSegments.includes(first)) return false;

    switch (rule.mode) {
      case "single":
        return segments.length === 1;
      case "at":
        return first.startsWith("@") && segments.length === 1;
      case "prefix":
        return (
          rule.prefixes.includes(first) &&
          segments.length >= (rule.minSegments || 2)
        );
      case "any":
        return true;
      default:
        return false;
    }
  }
  return null; // host is not in the table
};

const classifyPage = (searchResult, nameTokens, sources, runtime) => {
  if (!searchResult) return makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, "No search result.", "UNKNOWN");

  const cfg = runtime.config.pages;
  const url = parseUrl(searchResult.profileUrl || searchResult.sourceUrl);
  const host = url?.host || "";
  const segments = url?.segments || [];
  const platform = hostToPlatform(host) || normalizePlatform(searchResult.platform);

  // ---- 1. noisy URL patterns
  if (url) {
    const path = `/${segments.join("/")}/`;

    for (const [kind, fragments] of Object.entries(cfg.noisyPathFragments)) {
      if (fragments.some((f) => path.includes(f))) {
        return makePage(kind, PAGE_VALUE.NOISY, `URL looks like ${kind.toLowerCase()} / listing content (${host}).`);
      }
    }
    if (/[?&](q|query)=/.test(url.search)) {
      return makePage("LISTING", PAGE_VALUE.NOISY, "Search-results URL.");
    }
  }

  // ---- 2. low-value hosts (documents, services, aggregators, listings)
  if (host) {
    const lastPath = segments[segments.length - 1] || "";
    const isDocument =
      hostIn(host, cfg.documentHosts) ||
      cfg.documentExtensions.some((ext) => lastPath.endsWith(ext)) ||
      cfg.documentPathFragments.some((f) => `/${segments.join("/")}/`.includes(f));

    if (isDocument) {
      return makePage("DOCUMENT", PAGE_VALUE.LOW, `Document / presentation page (${host}), not a personal profile.`);
    }
    if (hostIn(host, cfg.serviceHosts)) {
      return makePage("SERVICE_PAGE", PAGE_VALUE.LOW, `Service / session / booking page (${host}), not a verified personal profile.`);
    }
    if (hostIn(host, cfg.aggregatorHosts)) {
      return makePage("AGGREGATOR", PAGE_VALUE.LOW, `Aggregator / people-search page (${host}).`);
    }
    if (host.split(".").some((label) => cfg.listingHostLabels.includes(label))) {
      return makePage("LISTING", PAGE_VALUE.LOW, `Marketplace / listing page (${host}).`);
    }
  }

  // ---- 3. major social platforms
  if (platform) {
    if (!url) {
      return makePage("PERSONAL_SOCIAL_PROFILE", PAGE_VALUE.HIGH, `${platform} result without URL (assumed profile).`);
    }

    const [first, second] = segments;
    if (!first) return makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, `${platform} root page.`);

    if (platform === "LINKEDIN" && ["company", "school", "showcase"].includes(first)) {
      return makePage("COMPANY_PAGE", PAGE_VALUE.LOW, "LinkedIn company/school page.");
    }
    if ((SOCIAL_NON_PROFILE_FIRST_SEGMENT[platform] || []).includes(first)) {
      return makePage("SOCIAL_CONTENT", PAGE_VALUE.LOW, `${platform} post / group / listing, not a personal profile.`);
    }

    switch (platform) {
      case "LINKEDIN":
        if (first === "in" || first === "pub") {
          return makePage("PERSONAL_SOCIAL_PROFILE", PAGE_VALUE.HIGH, "LinkedIn personal profile.");
        }
        return makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, "LinkedIn page of unknown shape.");
      case "GITHUB":
        return segments.length === 1
          ? makePage("PERSONAL_SOCIAL_PROFILE", PAGE_VALUE.HIGH, "GitHub personal profile.")
          : makePage("SOCIAL_CONTENT", PAGE_VALUE.LOW, "GitHub repository / sub-page, not the profile itself.");
      case "TWITTER":
        return second === "status"
          ? makePage("SOCIAL_CONTENT", PAGE_VALUE.LOW, "Tweet, not a profile.")
          : makePage("PERSONAL_SOCIAL_PROFILE", PAGE_VALUE.HIGH, "X/Twitter personal profile.");
      default:
        return makePage("PERSONAL_SOCIAL_PROFILE", PAGE_VALUE.HIGH, `${platform} personal profile.`);
    }
  }

  // ---- 4. other clear personal professional profiles
  if (host) {
    const professional = matchProfessionalHost(host, segments, cfg);
    if (professional === true) {
      return makePage("PROFESSIONAL_PROFILE", PAGE_VALUE.HIGH, `Personal professional profile (${host}).`);
    }
    if (professional === false) {
      return makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, `${host} page that is not a personal profile.`);
    }

    // ---- 5. medium value: about.me / resume profiles / directories
    if (hostIn(host, cfg.personalLinkHosts)) {
      return segments.length === 1
        ? makePage("ABOUT_ME", PAGE_VALUE.MEDIUM, `Personal link/about page (${host}).`)
        : makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, `${host} page of unknown shape.`);
    }
    if (hostIn(host, cfg.resumeProfileHosts)) {
      return makePage("RESUME_PROFILE", PAGE_VALUE.MEDIUM, `Resume / job-portal profile (${host}).`);
    }
    if (hostIn(host, cfg.directoryHosts)) {
      return makePage("DIRECTORY_PROFILE", PAGE_VALUE.MEDIUM, `Professional directory entry (${host}).`);
    }

    // ---- 6. personal website heuristics
    const hosting = cfg.hostingPlatforms.find((d) => host === d || host.endsWith(`.${d}`));
    if (hosting) {
      const sub = host.slice(0, host.length - hosting.length);
      if (nameInHost(sub, nameTokens) && segments.length <= 2) {
        return makePage("PERSONAL_WEBSITE", PAGE_VALUE.HIGH, `Personal site on ${hosting} with the candidate's name in the address.`);
      }
    } else if (nameInHost(host, nameTokens) && segments.length <= 2) {
      return makePage("PERSONAL_WEBSITE", PAGE_VALUE.HIGH, `Website whose address contains the candidate's name (${host}).`);
    }

    const titleText = sources
      .filter((s) => s.trustName === "TITLE" || s.trustName === "STRUCTURED")
      .map((s) => ` ${s.text} `);
    if (
      segments.length <= 1 &&
      nameTokens.length &&
      titleText.some(
        (t) =>
          t.includes(" portfolio ") &&
          nameTokens.every((tok) => t.includes(` ${tok} `))
      )
    ) {
      return makePage("PERSONAL_WEBSITE", PAGE_VALUE.HIGH, "Page titled as the candidate's portfolio.");
    }
  }

  // ---- 7. article-like wording on non-social pages
  const noisyText = sources
    .filter((s) => s.trustName === "TITLE" || s.trustName === "SNIPPET")
    .some((s) =>
      runtime.noisyPhrases.some((phrase) => ` ${s.text} `.includes(` ${phrase} `))
    );
  if (noisyText) {
    return makePage("ARTICLE", PAGE_VALUE.NOISY, "Title/snippet reads like an article, success story or press page.");
  }

  // ---- 8. generic profile-looking path on an unknown host
  if (url && segments.some((s) => cfg.genericProfilePathSegments.includes(s))) {
    return makePage("GENERIC_PROFILE_PAGE", PAGE_VALUE.MEDIUM, `Profile-like path on ${host}.`);
  }

  return url
    ? makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, `Unrecognised page (${host}); identity cannot be established from the URL.`)
    : makePage("UNKNOWN_PAGE", PAGE_VALUE.UNCLEAR, "No URL.", "UNKNOWN");
};

// ---- "page mentions other people" detection ----

const ROLE_WORDS = [
  "director", "manager", "engineer", "developer", "ceo", "cto", "cfo", "coo",
  "founder", "co-founder", "consultant", "analyst", "architect", "president",
  "vp", "head", "lead", "designer", "professor", "recruiter", "partner",
  "specialist", "officer",
];

const NON_NAME_WORDS = new Set([
  "senior", "junior", "sr", "lead", "chief", "principal", "software", "web",
  "mobile", "full", "stack", "front", "back", "frontend", "backend", "data",
  "machine", "learning", "technical", "product", "project", "program", "ui",
  "ux", "cloud", "devops", "java", "python", "entry", "level", "sales",
  "business", "assistant", "associate", "general", "executive", "head",
  "vice", "group", "technologies", "technology", "solutions", "services",
  "systems", "pvt", "ltd", "private", "limited", "university", "college",
  "institute", "school", "company", "team", "tech", "digital", "global",
  "india", "the", "and", "for", "with", "who", "our", "your", "about",
  "contact", ...ROLE_WORDS,
]);

const OTHER_PEOPLE_REGEX = (() => {
  const roles = uniq(
    ROLE_WORDS.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1), w.toUpperCase()])
  ).join("|");
  return new RegExp(
    "\\b([A-Z][a-z]{2,}(?:\\s+[A-Z][a-z]{2,}){1,2})\\s*[.,|:\\-\u2013]*\\s*" +
      "(?:(?:Senior|Sr|Lead|Chief|Assistant|Associate|Principal|Software|Technical|Product|Project)\\.?\\s+)?" +
      `(?:${roles})\\b`,
    "g"
  );
})();

const detectOtherPeople = (rawTexts, nameTokens) => {
  const others = new Set();

  for (const { text } of rawTexts) {
    OTHER_PEOPLE_REGEX.lastIndex = 0;
    let m;
    while ((m = OTHER_PEOPLE_REGEX.exec(text)) !== null) {
      const words = m[1].toLowerCase().split(/\s+/);
      if (words.some((w) => NON_NAME_WORDS.has(w) || nameTokens.includes(w))) continue;
      others.add(m[1]);
    }
  }

  return [...others];
};

// ---- candidate contact details found on the page ----

const detectContactMatch = (candidate, rawTexts) => {
  const email = asText(candidate?.email).trim().toLowerCase();
  const phone = asText(candidate?.phone).replace(/\D/g, "").slice(-10);
  const lowered = rawTexts.map((t) => t.text.toLowerCase());

  const emailHit =
    email.includes("@") && lowered.some((t) => t.includes(email));

  let phoneHit = false;
  if (phone.length === 10) {
    const re = new RegExp(
      `(?<!\\d)${phone.split("").join("[\\s().\\-]*")}(?!\\d)`
    );
    phoneHit = lowered.some((t) => re.test(t));
  }

  return { email: emailHit, phone: phoneHit };
};

const hasProfileImage = (searchResult, runtime) => {
  const url = asText(searchResult?.profileImageUrl).toLowerCase();
  if (!url) return false;
  return !runtime.config.pages.imageIgnorePatterns.some((p) => url.includes(p));
};

// ---- everything derived from the SearchResult once ----

const prepareResult = ({ match, candidate, searchResult }, runtime) => {
  const sources = getTextSources(searchResult, runtime);
  const rawTexts = collectRawTexts(searchResult, runtime);
  const nameTokens = getCandidateNameTokens(candidate);

  let page = classifyPage(searchResult, nameTokens, sources, runtime);
  const notes = [];

  // Matcher said "noisy / non-profile page"
  const upstreamNoisy = (Array.isArray(match?.conflictingSignals) ? match.conflictingSignals : [])
    .some((c) => conflictField(c) === "pageType");

  if (upstreamNoisy) {
    if (page.value === PAGE_VALUE.MEDIUM || page.value === PAGE_VALUE.UNCLEAR) {
      page = makePage("UPSTREAM_NOISY", PAGE_VALUE.LOW, "Matcher flagged this as a noisy / non-profile page.", "CONTENT");
    } else if (page.value === PAGE_VALUE.HIGH) {
      notes.push("Matcher flagged the page as noisy, but the URL pattern indicates a personal profile.");
    }
  }

  // Page that talks about several people (never for HIGH personal profiles)
  if (page.value === PAGE_VALUE.MEDIUM || page.value === PAGE_VALUE.UNCLEAR) {
    const others = detectOtherPeople(rawTexts, nameTokens);
    if (others.length >= runtime.config.pages.multiPersonMinOthers) {
      page = makePage(
        "MULTI_PERSON",
        PAGE_VALUE.LOW,
        `Page also mentions other people (${others.slice(0, 3).join(", ")}); identity is mixed.`,
        "CONTENT"
      );
    }
  }

  return {
    sources,
    rawTexts,
    page,
    notes,
    contact: detectContactMatch(candidate, rawTexts),
    image: hasProfileImage(searchResult, runtime),
  };
};

// ============================================================
// CROSS-PLATFORM CORROBORATION
// ============================================================

const platformKeyOf = (searchResult, url) =>
  hostToPlatform(url?.host) ||
  normalizePlatform(searchResult?.platform) ||
  url?.host ||
  "UNKNOWN";

const profileKeyFromUrl = (url) => {
  if (!url) return "";
  const platform = hostToPlatform(url.host);
  const host = platform ? PLATFORM_DOMAIN[platform] : url.host;
  if (platform === "LINKEDIN" && ["in", "pub"].includes(url.segments[0]) && url.segments[1]) {
    return `${host}/${url.segments[0]}/${url.segments[1]}`;
  }
  return url.segments[0] ? `${host}/${url.segments[0]}` : host;
};

const URL_IN_TEXT = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>)\]]*)?/gi;

/**
 * entries: [{ id, platformKey, pageValue, nameMatched, username, urlKey, texts[] }]
 * Two results corroborate each other when (and only when) both are
 * name-matched profile pages (HIGH/MEDIUM) on DIFFERENT platforms and
 *  - they share the same (non-trivial) username, or
 *  - one links to the other's profile URL.
 * Returns Map(id -> { platforms: [...], via: [...] }).
 */
// "rahulsharma", "rahul.sharma", "sharmarahul", "rahuls" ... are just the
// name. The same name-only username on two platforms is not corroboration.
const isGenericNameUsername = (username, nameTokens) => {
  if (!username || !nameTokens || !nameTokens.length) return false;
  const first = nameTokens[0];
  const last = nameTokens[nameTokens.length - 1];
  const variants = new Set([
    nameTokens.join(""),
    [...nameTokens].reverse().join(""),
    first,
    last,
    first + last[0],
    first[0] + nameTokens.slice(1).join(""),
    last + first[0],
  ]);
  return variants.has(username);
};

const buildCorroborationIndex = (entries, runtime = DEFAULT_RUNTIME, nameTokens = []) => {
  const result = new Map(entries.map((e) => [e.id, { platforms: new Set(), via: [] }]));
  const eligible = entries.filter(
    (e) =>
      e.nameMatched &&
      (e.pageValue === PAGE_VALUE.HIGH || e.pageValue === PAGE_VALUE.MEDIUM)
  );

  const link = (a, b, via) => {
    if (a.id === b.id || a.platformKey === b.platformKey) return;
    result.get(a.id).platforms.add(b.platformKey);
    result.get(b.id).platforms.add(a.platformKey);
    result.get(a.id).via.push(via);
    result.get(b.id).via.push(via);
  };

  // same username on different platforms
  const minLen = runtime.config.corroboration.minUsernameLength;
  const byUsername = new Map();
  for (const e of eligible) {
    if (!e.username || e.username.length < minLen) continue;
    if (isGenericNameUsername(e.username, nameTokens)) continue;
    if (!byUsername.has(e.username)) byUsername.set(e.username, []);
    byUsername.get(e.username).push(e);
  }
  for (const [username, group] of byUsername) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        link(group[i], group[j], `Same username "${username}" on ${group[i].platformKey} and ${group[j].platformKey}`);
      }
    }
  }

  // profile links inside another result's text
  const byUrlKey = new Map(eligible.filter((e) => e.urlKey).map((e) => [e.urlKey, e]));
  for (const e of eligible) {
    for (const text of e.texts) {
      const found = text.match(URL_IN_TEXT) || [];
      for (const candidateUrl of found) {
        const key = profileKeyFromUrl(parseUrl(candidateUrl));
        const target = key && byUrlKey.get(key);
        if (target) {
          link(e, target, `${e.platformKey} profile links to ${target.platformKey} profile`);
        }
      }
    }
  }

  return new Map(
    [...result].map(([id, v]) => [id, { platforms: [...v.platforms], via: uniq(v.via) }])
  );
};

// ============================================================
// PROFILE QUALITY (only ever ADDS; sparse profiles are not punished)
// ============================================================

const calculateProfileQuality = (searchResult) => {
  if (!searchResult) return 0;

  let quality = 0;

  if (searchResult.name) quality += 10;
  if (searchResult.username) quality += 5;
  if (searchResult.jobTitle) quality += 10;
  if (searchResult.company) quality += 10;

  const loc = searchResult.location;
  if (
    (typeof loc === "string" && loc.trim()) ||
    (isPlainObject(loc) && (loc.city || loc.state || loc.country))
  ) {
    quality += 10;
  }

  if (
    searchResult.profileImageUrl ||
    (Array.isArray(searchResult.profileImageUrls) &&
      searchResult.profileImageUrls.length)
  ) {
    quality += 5;
  }

  const raw = isPlainObject(searchResult.rawData) ? searchResult.rawData : {};
  const bioLength = Math.max(
    ...[
      searchResult.headline, searchResult.bio, searchResult.about,
      raw.bio, raw.about, raw.summary, raw.headline,
    ].map((v) => asText(v).trim().length),
    0
  );

  if (bioLength >= 40) quality += 10;
  if (bioLength >= 200) quality += 5;

  return Math.min(quality, 65);
};

// ============================================================
// RANK ONE MATCH
// ============================================================

const EMPTY_CORROBORATION = { platforms: [], via: [] };

const rankMatch = (
  {
    match,
    candidate,
    searchResult,
    prepared,
    corroboration,
    mlSimilarityPercent = 0,
  },
  runtime = DEFAULT_RUNTIME,
  memo = new Map()
) => {
  const cfg = runtime.config;
  const W = cfg.weights;

  if (!searchResult) {
    return {
      reviewRankScore: 0,
      reviewPriority: "LOW",
      identityLevel: "NONE",
      identityBasis: "NO_SIGNAL",
      reviewTier: 6,
      fallbackOnly: true,
      eligibility: { eligible: false, reasons: ["MISSING_SEARCH_RESULT"] },
      rankingEvidence: {
        disclaimer: DISCLAIMER,
        scoreBreakdown: [],
        exclusionReasons: ["MISSING_SEARCH_RESULT"],
        reviewDecision: { included: false, summary: REASON_TEXT.MISSING_SEARCH_RESULT, reasons: [REASON_TEXT.MISSING_SEARCH_RESULT] },
      },
    };
  }

  const prep = prepared || prepareResult({ match, candidate, searchResult }, runtime);
  const { sources, page, contact, image } = prep;

  const signals = readSignals(match?.matchedSignals);
  const domain = analyzeDomainRelevance(candidate, searchResult, runtime, memo, sources);
  const location = analyzeLocation(candidate, searchResult, runtime, memo, sources);
  const profileQuality = calculateProfileQuality(searchResult);

  const pageIsProfile =
    page.value === PAGE_VALUE.HIGH || page.value === PAGE_VALUE.MEDIUM;
  const contentFactor = W.contentFactor[page.value] ?? 0.45;
  const locationUsable = location.status !== "COUNTRY_CONFLICT";
  const locationMatched = signals.location && locationUsable;
  const cross = pageIsProfile ? corroboration || EMPTY_CORROBORATION : EMPTY_CORROBORATION;
  const contactMatched = contact.email || contact.phone;

  // ---- professional identity
  let professional = "NONE";
  if (
    domain.relation === "DIRECT" &&
    ["HIGH", "MEDIUM"].includes(domain.confidence) &&
    domain.primaryRelation === "ALIGNED"
  ) {
    professional = "STRONG";
  } else if (
    signals.jobTitle ||
    // keyword-only / weak-word evidence (LOW confidence) is not a profession
    ((domain.relation === "DIRECT" || domain.relation === "ADJACENT") &&
      domain.confidence !== "LOW")
  ) {
    professional = "PARTIAL";
  }

  // ---- supporting identity evidence
  // (a username is NOT supporting evidence: it usually just contains the name)
  const crossCount = cross.platforms.length;
  const fieldSupport = [signals.company, locationMatched, signals.education].filter(Boolean).length;
  const supportingCount = fieldSupport + (crossCount ? 1 : 0);

  const anyMatchedSignal =
    signals.name || signals.username || signals.jobTitle || signals.company ||
    signals.location || signals.education;

  // A page about a different profession (actor, CEO ...) can never be a
  // convincing identity match on name/username alone.
  const professionalConflict = domain.related === false && domain.conflicts.length > 0;

  const nameOnProfile = signals.name && pageIsProfile;

  // ---- identity level: how well do we know WHO this page is about?
  // (independent of page quality: a real Instagram page is still WEAK
  //  identity with only name + username)
  let identityLevel = "NONE";
  let identityBasis = "NO_SIGNAL";

  if (signals.profileUrl || contactMatched) {
    identityLevel = "STRONG";
    identityBasis = "DIRECT";
  } else if (professionalConflict && anyMatchedSignal) {
    identityLevel = "WEAK";
    identityBasis = "UNRELATED_PROFESSION";
  } else if (nameOnProfile && signals.username && professional === "STRONG") {
    identityLevel = "STRONG";
    identityBasis = "NAME_USERNAME_PROFESSIONAL";
  } else if (nameOnProfile && professional === "STRONG" && supportingCount >= 1) {
    identityLevel = "STRONG";
    identityBasis = "NAME_PROFESSIONAL_SUPPORTING";
  } else if (nameOnProfile && signals.username && crossCount >= 1) {
    identityLevel = "STRONG";
    identityBasis = "NAME_USERNAME_CROSS_PLATFORM";
  } else if (nameOnProfile && professional !== "NONE" && fieldSupport >= 1) {
    identityLevel = "STRONG";
    identityBasis = "NAME_PROFESSIONAL_LOCATION_COMPANY_EDUCATION";
  } else if (nameOnProfile && page.value === PAGE_VALUE.HIGH && professional !== "NONE") {
    identityLevel = "MODERATE";
    identityBasis = "NAME_PROFESSIONAL";
  } else if (nameOnProfile && supportingCount >= 1) {
    identityLevel = "MODERATE";
    identityBasis = "NAME_PROFILE_SUPPORTING";
  } else if (signals.name && !page.isContentPage && supportingCount >= 2) {
    identityLevel = "MODERATE";
    identityBasis = "NAME_SUPPORTING";
  } else if (anyMatchedSignal) {
    identityLevel = "WEAK";
    identityBasis =
      signals.name && signals.username && !signals.jobTitle ? "NAME_USERNAME_ONLY"
      : signals.name && signals.jobTitle && !signals.username ? "NAME_TITLE_ONLY"
      : signals.name && !signals.username ? "NAME_ONLY"
      : "PARTIAL_SIGNALS";
  }

  const directMatch = identityBasis === "DIRECT";
  const weakIdentity = identityLevel === "WEAK" || identityLevel === "NONE";

  // ---- review tier (shortlist order; lower = look at first)
  let reviewTier;
  if (directMatch) reviewTier = 1;
  else if (identityLevel === "STRONG") reviewTier = professional !== "NONE" ? 2 : 3;
  else if (identityLevel === "MODERATE") reviewTier = professional === "STRONG" ? 4 : 5;
  else reviewTier = 6;

  const idFactor = W.identityFactor[identityLevel] ?? 0.4;

  // ---- score
  const parts = [];
  const add = (factor, points, note) => {
    if (!points) return;
    parts.push({ factor, points: round1(points), note });
  };

  // 1. direct evidence
  if (signals.profileUrl) {
    add("directProfileUrl", W.directUrl, "Known profile URL matches this result (very strong evidence).");
  }
  if (contactMatched) {
    add(
      "contactDetailsOnPage",
      Math.min(
        (contact.email ? W.contactMatch : 0) + (contact.phone ? W.contactMatch : 0),
        W.contactMatchMax
      ),
      `Candidate's ${[contact.email && "email", contact.phone && "phone"].filter(Boolean).join(" and ")} appears on the page.`
    );
  }

  // 2. actual profile vs content page
  const basePageValue = W.pageValue[page.value] ?? 0;
  const pageCredit =
    basePageValue > 0
      ? basePageValue * (W.pageValueIdentityFactor[identityLevel] ?? 1)
      : basePageValue;
  add(
    "pageValue",
    pageCredit,
    `Page quality: ${page.kind} (${page.value}).${
      pageCredit < basePageValue ? ` Credit reduced because identity evidence is ${identityLevel}.` : ""
    } ${page.reason}`
  );

  // 3. name + username
  if (signals.name && signals.username) {
    const meaningfulUsername = professional === "STRONG" || crossCount >= 1;
    add(
      "nameWithUsername",
      (meaningfulUsername ? W.nameWithUsername.meaningful : W.nameWithUsername.generic) *
        (pageIsProfile ? 1 : W.nonProfileUsernameFactor),
      meaningfulUsername
        ? "Name and username match, backed by professional evidence or cross-platform proof."
        : "Name and username match, but a username containing the name is not proof of identity."
    );
  } else if (signals.username) {
    add("username", W.usernameAlone * (pageIsProfile ? 1 : W.nonProfileUsernameFactor), "Username matches (weak without name).");
  }

  // 4. name + professional identity (content evidence, scaled by page value)
  if (signals.name) {
    add("name", W.name * contentFactor, "Name matches (weak alone: names are often common).");
  }
  if (signals.name && professional !== "NONE") {
    add(
      "nameWithProfessional",
      W.nameWithProfessional[professional] * contentFactor,
      professional === "STRONG"
        ? "Name agrees with the candidate's professional domain, and it is the profile's primary domain."
        : "Name with partial professional evidence."
    );
  }
  if (signals.jobTitle) add("jobTitle", W.jobTitle * contentFactor, "Job title matches.");

  // 5. + location / company / education
  if (signals.company) add("company", W.company, "Company matches.");
  if (signals.education) add("education", W.education, "Education matches.");
  if (locationMatched) add("location", W.location, "Location matches.");

  if (signals.name && professional === "STRONG" && supportingCount >= 1) {
    add(
      "identityCombo",
      supportingCount >= 2 ? W.identityCombo.two : W.identityCombo.one,
      `Name + professional identity + ${supportingCount} supporting signal(s).`
    );
  }

  // 6. cross-platform corroboration
  if (cross.platforms.length) {
    add(
      "crossPlatform",
      Math.min(cross.platforms.length * W.crossPlatformPerPlatform, W.crossPlatformMax),
      `Corroborated on ${cross.platforms.length} other platform(s).`
    );
  }

  // identity strength: STRONG/MODERATE boosted differently, WEAK penalised
  if (!directMatch && (W.identityBonus[identityLevel] || 0) > 0) {
    add("identityStrength", W.identityBonus[identityLevel], `Identity evidence is ${identityLevel} (${identityBasis}).`);
  }
  if (weakIdentity && !page.isContentPage) {
    add("weakIdentityPenalty", -W.weakIdentityPenalty, `Weak identity evidence (${identityBasis}): kept as a fallback only.`);
  }

  // GitHub / LinkedIn / portfolio carrying professional evidence
  const platformKey = platformKeyOf(searchResult, parseUrl(searchResult.profileUrl || searchResult.sourceUrl));
  const technicalProfile =
    (page.kind === "PERSONAL_SOCIAL_PROFILE" && (platformKey === "GITHUB" || platformKey === "LINKEDIN")) ||
    page.kind === "PERSONAL_WEBSITE" ||
    page.kind === "PROFESSIONAL_PROFILE";
  if (technicalProfile && signals.name && professional !== "NONE") {
    add("professionalPlatform", W.professionalPlatformBonus, "Professional/technical profile (GitHub, LinkedIn, portfolio) with professional evidence.");
  }

  // 7. profile image: supporting only
  if (pageIsProfile && image) {
    add("profileImage", W.profileImage, "Profile image available for the reviewer (supporting only, not proof).");
  }

  // professional domain
  if (domain.relation === "DIRECT") {
    add(
      "domain",
      (W.domainDirect[domain.confidence] || 0) *
        (W.domainPrimaryFactor[domain.primaryRelation] ?? 1) *
        contentFactor,
      `Professional domain aligns (${domain.overlappingDomains.join(", ")}; confidence ${domain.confidence}; primary domain of profile: ${domain.resultPrimaryDomain}).`
    );
  } else if (domain.relation === "ADJACENT") {
    add("domain", W.domainAdjacent * contentFactor, "Adjacent professional domain (related, not identical).");
  }

  if (domain.conflicts.length) {
    const per = domain.related ? W.domainConflictWhenRelated : W.domainConflictWhenUnrelated;
    add(
      "domainConflict",
      -Math.min(domain.conflicts.length * per, W.domainConflictMax),
      `Strong unrelated profession evidence: ${domain.conflicts.join(", ")}.`
    );
  } else if (domain.relation === "NONE" && domain.resultDomains.length) {
    add("unrelatedDomainMention", -W.unrelatedDomainMention, "Result mentions an unrelated domain (weak evidence).");
  }

  // location: a penalty, never an automatic rejection
  if (location.status === "COUNTRY_CONFLICT") {
    add("locationCountryConflict", -W.locationCountryConflict * (fieldSupport > 0 || signals.jobTitle ? 0.3 : 1), `Different country (${location.resultCountries.join(", ")} vs ${location.candidateCountry}). Location can change, so this is a penalty, not proof.`);
  } else if (location.status === "POSSIBLE_COUNTRY_CONFLICT") {
    add("locationPossibleConflict", -W.locationPossibleCountryConflict, "Weak hint of a different country (free text / domain).");
  }

  add("profileQuality", profileQuality * W.profileQualityFactor, "Profile completeness (name/username/job/company/location/bio/image).");

  // 8. matcher relevance, discounted by identity strength and page value
  const similarityPoints = Number(match?.similarityScore || 0) * W.similarityFactor * contentFactor * idFactor;
  const statusPoints = (W.statusBonus[match?.matchStatus] || 0) * contentFactor * idFactor;
  add("searchRelevance", similarityPoints, "Matcher similarity (discounted when identity evidence is weak or the page is not a profile).");
  add("matchStatus", statusPoints, `Matcher status ${match?.matchStatus || "n/a"} (discounted the same way).`);

  // upstream conflicting signals
  const upstream = Array.isArray(match?.conflictingSignals) ? match.conflictingSignals : [];
  const upstreamFields = uniq(upstream.map(conflictField));
  if (upstream.length) {
    const penalty = Math.min(
      upstream.reduce(
        (sum, item) => sum + (W.conflictPenalty[conflictField(item)] ?? W.conflictPenalty.other),
        0
      ),
      W.conflictPenaltyMax
    );
    add("conflictingSignals", -penalty, `Matcher reported conflicting signals: ${upstreamFields.join(", ")}.`);
  }

  // BGE-M3 semantic similarity is a supporting signal.
  // It is capped so ML can improve ranking without overpowering direct,
  // contact, professional, company, location or cross-platform evidence.
  const mlCfg = cfg.ml || {};
  const mlScore = Number(mlSimilarityPercent || 0);

  if (mlCfg.enabled && mlScore > 0) {
    const minML = Number(mlCfg.minSimilarityPercent || 0);
    const normalizedML =
      Math.max(0, mlScore - minML) / Math.max(1, 100 - minML);
    const mlPoints = normalizedML * Number(mlCfg.maxPoints || 20);

    if (mlPoints > 0) {
      add(
        "mlSemanticSimilarity",
        mlPoints,
        `BGE-M3 semantic similarity: ${round1(mlScore)}%. ML is supporting evidence only.`
      );
    }
  }

  const raw = parts.reduce((sum, p) => sum + p.points, 0);
  const reviewRankScore = Math.max(0, Math.min(Math.round(raw), 100));

  let reviewPriority =
    reviewRankScore >= cfg.priority.high
      ? "HIGH"
      : reviewRankScore >= cfg.priority.medium
      ? "MEDIUM"
      : "LOW";
  // priority never outruns the evidence tier
  if (reviewTier === 6) reviewPriority = "LOW";
  else if (reviewTier >= 5 && reviewPriority === "HIGH") reviewPriority = "MEDIUM";

  // ---- eligibility: what a human is shown. DB records are never touched.
  const overrides = cfg.overrideBases.includes(identityBasis);
  const reasons = [];

  if (!cfg.eligibleStatuses.includes(match?.matchStatus)) {
    reasons.push("STATUS_NOT_ELIGIBLE");
  }
  if (page.value === PAGE_VALUE.NOISY && !overrides) {
    reasons.push("NOISY_PAGE");
  }
  if (page.value === PAGE_VALUE.LOW && !overrides) {
    reasons.push("LOW_VALUE_PAGE");
  }
  if (domain.related === false && domain.conflicts.length && !overrides) {
    reasons.push("UNRELATED_PROFESSION_CONFLICT");
  }
  // A single location difference is not proof of a different person
  // (relocation, older history): it only excludes when nothing else
  // (company, education, job title) supports the identity.
  if (location.status === "COUNTRY_CONFLICT" && !overrides && fieldSupport === 0 && !signals.jobTitle) {
    reasons.push("DIFFERENT_COUNTRY");
  }
  if (
    identityLevel === "WEAK" &&
    !cfg.weakIdentityAllowedPageValues.includes(page.value) &&
    !page.isContentPage // content pages already carry their own reason
  ) {
    reasons.push("WEAK_IDENTITY_EVIDENCE");
  }
  if (cfg.requireIdentityEvidence) {
    const anySignal = Object.values(signals).some(Boolean) || contactMatched;
    if (!anySignal && Number(match?.similarityScore || 0) < cfg.minSimilarityWithoutSignals) {
      reasons.push("NO_IDENTITY_EVIDENCE");
    }
  }
  const minScore = weakIdentity ? cfg.minReviewScoreWeak : cfg.minReviewScore;
  const matcherTrusted = ["STRONG", "POSSIBLE"].includes(match?.matchStatus);
  if (reviewRankScore < minScore && !overrides && !matcherTrusted) {
    reasons.push("BELOW_MIN_REVIEW_SCORE");
  }

  const included = reasons.length === 0;

  // ---- explanations
  const positive = [];
  const negative = [];

  if (signals.profileUrl) positive.push("Known profile URL matches.");
  if (contactMatched) positive.push("Candidate's contact details appear on the page.");
  if (page.isActualProfile) positive.push(`Actual personal profile page: ${page.kind} (${page.value} value).`);
  if (signals.name && signals.username) positive.push("Name and username match.");
  else if (signals.name) positive.push("Name matches (weak on its own).");
  if (professional === "STRONG") positive.push(`Professional identity aligns (${domain.overlappingDomains.join(", ")}).`);
  else if (professional === "PARTIAL") positive.push("Partial professional evidence.");
  if (signals.company) positive.push("Company matches.");
  if (signals.education) positive.push("Education matches.");
  if (locationMatched) positive.push("Location matches.");
  cross.via.forEach((v) => positive.push(`Cross-platform: ${v}.`));
  if (pageIsProfile && image) positive.push("Profile image available (supporting only).");

  if (page.isContentPage) negative.push(`Not a personal profile: ${page.kind}. ${page.reason}`);
  prep.notes.forEach((n) => negative.push(n));
  if (location.status === "COUNTRY_CONFLICT") negative.push(`Different country: ${location.resultCountries.join(", ")} vs ${location.candidateCountry} (${location.confidence} confidence).`);
  else if (location.status === "POSSIBLE_COUNTRY_CONFLICT") negative.push(`Weak hint of another country: ${location.resultCountries.join(", ")}.`);
  else if (location.status === "SAME_COUNTRY_DIFFERENT_CITY") negative.push("Different city in the same country (informational only).");
  if (domain.conflicts.length) negative.push(`Unrelated profession evidence: ${domain.conflicts.join(", ")}.`);
  if (domain.relation === "DIRECT" && domain.primaryRelation !== "ALIGNED") {
    negative.push(`Profile's primary domain is ${domain.resultPrimaryDomain}, not ${domain.candidatePrimaryDomain}.`);
  }
  if (upstream.length) negative.push(`Matcher conflicts: ${upstreamFields.join(", ")}.`);
  if (weakIdentity) {
    negative.push(
      identityBasis === "NAME_USERNAME_ONLY"
        ? "Name + username only: a username containing the person's name is common and is not proof of identity. No professional, company, location, education, contact or cross-platform evidence."
        : identityBasis === "UNRELATED_PROFESSION"
        ? "Profession on this page conflicts with the candidate's, so name/username matches carry little weight."
        : "Identity evidence is weak: no direct URL, contact details, professional evidence with supporting signals, or cross-platform corroboration."
    );
  }

  const matcherSaysStrong =
    match?.matchStatus === "STRONG" || Number(match?.similarityScore || 0) >= 80;
  const matcherDiscounted = matcherSaysStrong && (idFactor < 1 || contentFactor < 1);

  const reasonTexts = reasons.map((r) => REASON_TEXT[r] || r);
  const summary = included
    ? `Included for human review (tier ${reviewTier}: ${TIER_LABEL[reviewTier]}; ${reviewPriority} priority; identity ${identityLevel}): ${page.isActualProfile ? `${page.kind} page` : "page type unclear"}${positive.length ? "; " + positive.slice(0, 3).join(" ") : ""}`
    : `Not shown to the reviewer (kept in database): ${reasonTexts.join("; ")}.`;

  return {
    reviewRankScore,
    reviewPriority,
    identityLevel,
    identityBasis,
    reviewTier,
    fallbackOnly: weakIdentity,
    eligibility: { eligible: included, reasons },
    rankingEvidence: {
      // ---- original fields (unchanged names)
      domainRelated: domain.related,
      candidateDomains: domain.candidateDomains,
      resultDomains: domain.resultDomains,
      domainConflicts: domain.conflicts,
      domainConfidence: domain.confidence,
      overlappingDomains: domain.overlappingDomains,
      locationConflict: location.conflict,
      profileType: page.legacy,

      // ---- page evidence: actual profile vs content/service/noisy
      pageKind: page.kind,
      pageValue: page.value,
      isActualProfile: page.isActualProfile,
      isContentPage: page.isContentPage,
      pageReason: page.reason,

      // ---- identity evidence (separate from page quality)
      identityLevel,
      identityBasis,
      reviewTier,
      reviewTierLabel: TIER_LABEL[reviewTier],
      fallbackOnly: weakIdentity,
      identityEvidence: {
        directProfileUrl: signals.profileUrl,
        contactMatch: contact,
        nameMatched: signals.name,
        usernameMatched: signals.username,
        professional,
        supporting: {
          company: signals.company,
          location: locationMatched,
          education: signals.education,
        },
        profileImage: image,
      },

      // ---- cross-platform evidence
      crossPlatform: {
        count: cross.platforms.length,
        platforms: cross.platforms,
        via: cross.via,
      },

      // ---- professional / domain evidence
      domainRelation: domain.relation,
      domainPrimaryRelation: domain.primaryRelation,
      candidatePrimaryDomain: domain.candidatePrimaryDomain,
      resultPrimaryDomain: domain.resultPrimaryDomain,
      resultSecondaryDomains: domain.resultSecondaryDomains,
      domainScores: Object.fromEntries(
        Object.entries(domain.domainScores).map(([k, v]) => [k, round1(v)])
      ),
      domainEvidence: domain.evidence.map((e) => ({
        domain: e.domain,
        term: e.term,
        kind: e.kind,
        source: e.source,
      })),

      // ---- location evidence
      locationStatus: location.status,
      locationConfidence: location.confidence,
      locationSource: location.source,
      candidateCountry: location.candidateCountry,
      resultCountries: location.resultCountries,

      // ---- ML semantic evidence (supporting only)
      mlSemanticMatch: {
        enabled: cfg.ml?.enabled !== false,
        similarityPercent: round1(Number(mlSimilarityPercent || 0)),
        model: "BAAI/bge-m3",
        role: "Supporting ranking signal only; never proof of identity.",
      },

      // ---- matcher (similarityScore keeps its meaning; we only discount it)
      matcherAgreement: {
        similarityScore: Number(match?.similarityScore || 0),
        matchStatus: match?.matchStatus || null,
        discounted: matcherDiscounted,
        note: matcherDiscounted
          ? "Matcher reported a strong match, but identity evidence / page type is weaker; its credit was reduced for ranking only."
          : "Matcher output used as a low-priority input.",
      },

      // ---- why ranked / included / excluded
      directProfileUrlMatch: signals.profileUrl,
      profileQuality,
      positiveEvidence: positive,
      negativeEvidence: negative,
      scoreBreakdown: parts,
      exclusionReasons: reasons,
      reviewDecision: {
        included,
        summary,
        reasons: reasonTexts,
      },
      disclaimer: DISCLAIMER,
    },
  };
};

// Backward-compatible: returns only the numeric score.
const calculateReviewRankScore = ({ match, candidate, searchResult, config }) =>
  rankMatch({ match, candidate, searchResult }, resolveRuntime(config)).reviewRankScore;

// Backward-compatible: legacy profile type string.
const getProfileType = (searchResult, runtime = DEFAULT_RUNTIME, sources = null, candidate = null) =>
  classifyPage(
    searchResult,
    getCandidateNameTokens(candidate),
    sources || getTextSources(searchResult, runtime),
    runtime
  ).legacy;

// ============================================================
// SHORTLIST (pure, no DB) - testable
// ============================================================

const STATUS_PRIORITY = { STRONG: 3, POSSIBLE: 2, REVIEW_REQUIRED: 1 };

const MAX_PAGE_SIZE = 50;

/**
 * The review page only needs a few fields. Sending the whole populated
 * candidate + every raw provider result for every card makes the response
 * huge (and slow), so strip the heavy parts. Full data stays in MongoDB.
 */
const slimMatchForResponse = (match) => {
  const out = { ...match };

  const sr = out.searchResult;
  if (sr && typeof sr === "object") {
    const { rawData, ...restSr } = sr;
    out.searchResult = {
      ...restSr,
      rawData: rawData
        ? {
            title: rawData.title || null,
            snippet: rawData.snippet || null,
            providers: rawData.providers || [],
            knowledgeBase: rawData.knowledgeBase || undefined,
            verifiedIdentity: rawData.verifiedIdentity || undefined,
            manual: rawData.manual || undefined,
            identityChange: rawData.identityChange || undefined,
            discovery: rawData.discovery || undefined,
          }
        : undefined,
    };
  }

  const c = out.candidate;
  if (c && typeof c === "object") {
    out.candidate = {
      _id: c._id,
      fullName: c.fullName,
      sourceImageUrl: c.sourceImageUrl,
      currentCompany: c.currentCompany,
      currentJobTitle: c.currentJobTitle,
      location: c.location,
    };
  }

  return out;
};

/**
 * Which matches go to BGE-M3. Bounded (`maxCandidates`) but NOT just the top
 * by deterministic score: a share is reserved for promising profiles whose
 * deterministic score is low only because the profile is incomplete (the
 * name matches, no conflict), spread over platforms, so a thin-but-real
 * profile is not permanently shut out of semantic scoring.
 */
const selectMLCandidates = (matches, results, mlCfg = {}) => {
  const max = Math.max(Number(mlCfg.maxCandidates) || 50, 1);
  const reserve = Math.min(Math.ceil(max * (Number(mlCfg.diverseShare) >= 0 ? Number(mlCfg.diverseShare) : 0.3)), max - 1);
  const byScore = results
    .map((r, i) => ({ i, score: r.reviewRankScore }))
    .sort((a, b) => b.score - a.score);

  const chosen = byScore.slice(0, max - reserve).map((x) => x.i);
  const taken = new Set(chosen);

  const pool = byScore
    .filter((x) => {
      if (taken.has(x.i)) return false;
      const m = matches[x.i];
      if (m?.matchStatus === "CONFLICT") return false;
      return Boolean(readSignals(m?.matchedSignals).name);
    })
    .sort((a, b) => Number(matches[b.i].similarityScore || 0) - Number(matches[a.i].similarityScore || 0));

  // round-robin over platforms
  const lanes = new Map();
  for (const x of pool) {
    const k = String(matches[x.i].searchResult?.platform || "UNKNOWN");
    if (!lanes.has(k)) lanes.set(k, []);
    lanes.get(k).push(x.i);
  }
  const laneList = [...lanes.values()];
  let added = 0;
  while (added < reserve && laneList.some((l) => l.length)) {
    for (const l of laneList) {
      if (added >= reserve) break;
      if (l.length) {
        chosen.push(l.shift());
        added += 1;
      }
    }
  }
  // fill any unused reserve with the next best by score
  for (const x of byScore) {
    if (chosen.length >= max) break;
    if (!chosen.includes(x.i)) chosen.push(x.i);
  }
  return chosen;
};

const shortlistMatches = async (
  matches,
  { limit = HARD_MAX_SHORTLIST, page = 1, minListSize, showAll = false, config, platform = null, view = "shortlist" } = {}
) => {
  const runtime = resolveRuntime(config);
  const platformKey = platform ? String(platform).toUpperCase() : null;
  // Per-platform views are capped by the per-platform target, not by the
  // 15-profile human-review shortlist (which stays untouched).
  const platformCap = Math.max(Number(process.env.PLATFORM_DISCOVERY_TARGET) || 15, 1);
  const memo = new Map();

  // `limit` is now the PAGE SIZE (default 15). The whole ranked list is
  // paginated; it is no longer cut off at 15.
  const safeLimit = Math.min(
    Math.max(Number(limit) || HARD_MAX_SHORTLIST, 1),
    MAX_PAGE_SIZE
  );
  const safePage = Math.max(Number(page) || 1, 1);

  // The list should contain AT LEAST this many entries whenever that many
  // results exist at all (weak / low-confidence ones fill the gap, clearly
  // labelled, always ranked below the better-supported ones).
  const minSize = platformKey ? 0 : Math.max(
    Number(minListSize ?? runtime.config.minListSize ?? HARD_MAX_SHORTLIST) || 0,
    0
  );

  // Pass 1: derive page type / contact data once per result
  const prepared = matches.map((match) =>
    prepareResult(
      { match, candidate: match.candidate, searchResult: match.searchResult },
      runtime
    )
  );

  // Cross-platform corroboration across ALL results of the run
  const nameTokens = getCandidateNameTokens(matches[0]?.candidate);
  const corroboration = buildCorroborationIndex(
    matches.map((match, i) => {
      const sr = match.searchResult;
      const url = parseUrl(sr?.profileUrl || sr?.sourceUrl);
      return {
        id: i,
        platformKey: platformKeyOf(sr, url),
        pageValue: prepared[i].page.value,
        nameMatched: readSignals(match.matchedSignals).name,
        username: normalizeForMatch(sr?.username || sr?.profileId).replace(/ /g, ""),
        urlKey: profileKeyFromUrl(url),
        texts: prepared[i].rawTexts.map((t) => t.text),
      };
    }),
    runtime,
    nameTokens
  );

  const mlCfg = runtime.config.ml || {};

  const rankOne = (match, i, mlSimilarityPercent) =>
    rankMatch(
      {
        match,
        candidate: match.candidate,
        searchResult: match.searchResult,
        prepared: prepared[i],
        corroboration: corroboration.get(i),
        mlSimilarityPercent,
      },
      runtime,
      memo
    );

  // Pass 2: deterministic ranking of EVERY match (cheap, no network).
  const results = matches.map((match, i) => rankOne(match, i, 0));

  // Pass 3: BGE-M3 semantic matching - supporting signal only.
  // Only the top `maxCandidates` by deterministic score are sent, in
  // batches. Everything else keeps its deterministic score.
  const mlStatusByIndex = new Array(matches.length).fill("NOT_SCORED");
  const mlRun = { enabled: mlCfg.enabled !== false, sent: 0, scored: 0, cached: 0, unavailable: 0, skipped: 0 };
  if (mlCfg.enabled !== false) {
    const candidateText = buildCandidateMLText(matches[0]?.candidate);

    if (candidateText) {
      const topIndexes = selectMLCandidates(matches, results, mlCfg);
      mlRun.sent = topIndexes.length;

      console.log(
        `Results sent to ML: ${topIndexes.length} of ${matches.length}`
      );

      const mlScores = await getMLScoresBatched({
        candidateText,
        resultTexts: topIndexes.map((i) =>
          buildSearchResultMLText(matches[i].searchResult)
        ),
        mlConfig: mlCfg,
      });

      topIndexes.forEach((matchIndex, j) => {
        const sc = mlScores[j] || {};
        mlStatusByIndex[matchIndex] = sc.status || "UNAVAILABLE";
        if (sc.status === "SCORED") mlRun.scored += 1;
        else if (sc.status === "CACHED") mlRun.cached += 1;
        else mlRun.unavailable += 1;
        const percent = Number(sc.similarityPercent);
        // only a REAL score changes the rank; UNAVAILABLE keeps rule-based rank
        if (Number.isFinite(percent) && percent > 0) {
          results[matchIndex] = rankOne(matches[matchIndex], matchIndex, percent);
        }
      });
      mlRun.skipped = matches.length - topIndexes.length;
    }
  }

  // Pass 4: build the ranked list
  const ranked = matches.map((match, i) => {
    const result = results[i];

    // Information completeness is reported next to - never inside - the
    // identity score. It only breaks near-ties (see `compare`).
    const completeness = computeCompleteness(match.searchResult);
    result.rankingEvidence.completeness = completeness;
    if (result.rankingEvidence.mlSemanticMatch) {
      const st = mlStatusByIndex[i];
      result.rankingEvidence.mlSemanticMatch.status = st;
      // a failed / unscored request is "no ML evidence", not a score of 0
      if (st !== "SCORED" && st !== "CACHED") {
        result.rankingEvidence.mlSemanticMatch.similarityPercent = null;
        result.rankingEvidence.mlSemanticMatch.fallback =
          st === "UNAVAILABLE" ? "Rule-based ranking used (ML service unavailable)."
          : st === "INVALID_INPUT" ? "Profile text was not usable for ML; rule-based ranking used."
          : "Not sent to ML; rule-based ranking used.";
      }
    }

    return {
      ...match,
      reviewRankScore: result.reviewRankScore,
      reviewPriority: result.reviewPriority,
      rankingEvidence: result.rankingEvidence,
      _completeness: completeness.score,
      _eligibility: result.eligibility,
      _identityRank: IDENTITY_RANK[result.identityLevel] || 0,
      _tier: result.reviewTier,
      _fallbackOnly: result.fallbackOnly,
    };
  });

  const excludedByReason = {};
  const eligible = [];
  const excludedItems = [];

  for (const item of ranked) {
    const { eligible: ok } = item._eligibility;
    if (ok) {
      eligible.push(item);
    } else {
      excludedItems.push(item);
    }
  }

  // Order: evidence tier first (so a weak-identity profile can never outrank
  // a profile with professional evidence), then score.
  const compare = (a, b) => {
    if (a._tier !== b._tier) return a._tier - b._tier;

    // Identity confidence (from the matcher's independent evidence) comes
    // before the blended rank score, so keyword/page/domain points can never
    // push a weaker identity above a better-supported one.
    const idBandA = Math.floor(Number(a.similarityScore || 0) / IDENTITY_BAND);
    const idBandB = Math.floor(Number(b.similarityScore || 0) / IDENTITY_BAND);
    if (idBandA !== idBandB) return idBandB - idBandA;

    // Identity scores within the same small band are treated as a near-tie;
    // only then does the profile with more verified information go first.
    // A detailed profile can never jump a tier or a clearly higher identity
    // score (a detailed profile may belong to a different person).
    const bandA = Math.floor(a.reviewRankScore / TIE_BAND);
    const bandB = Math.floor(b.reviewRankScore / TIE_BAND);
    if (bandA !== bandB) return bandB - bandA;
    if (b._completeness !== a._completeness) return b._completeness - a._completeness;

    if (b.reviewRankScore !== a.reviewRankScore) {
      return b.reviewRankScore - a.reviewRankScore;
    }
    if (b._identityRank !== a._identityRank) {
      return b._identityRank - a._identityRank;
    }

    const urlA = a.rankingEvidence.directProfileUrlMatch ? 1 : 0;
    const urlB = b.rankingEvidence.directProfileUrlMatch ? 1 : 0;
    if (urlB !== urlA) return urlB - urlA;

    const simA = Number(a.similarityScore || 0);
    const simB = Number(b.similarityScore || 0);
    if (simB !== simA) return simB - simA;

    const statusDiff =
      (STATUS_PRIORITY[b.matchStatus] || 0) - (STATUS_PRIORITY[a.matchStatus] || 0);
    if (statusDiff !== 0) return statusDiff;

    return String(a._id || "").localeCompare(String(b._id || ""));
  };

  // Per-platform counts over the WHOLE run (before any platform filter)
  const platformOf = (item) => String(item.searchResult?.platform || "UNKNOWN").toUpperCase();
  const platformBreakdown = {};
  const bump = (item, field) => {
    const b = (platformBreakdown[platformOf(item)] ||= { relevant: 0, weakIdentity: 0, notShown: 0, total: 0 });
    b[field] += 1;
    b.total += 1;
  };
  eligible.forEach((i) => bump(i, i._fallbackOnly ? "weakIdentity" : "relevant"));
  excludedItems.forEach((i) => bump(i, "notShown"));

  let wellSupported = eligible.filter((i) => !i._fallbackOnly).sort(compare);
  let weakOnly = eligible.filter((i) => i._fallbackOnly).sort(compare);

  if (platformKey) {
    wellSupported = wellSupported.filter((i) => platformOf(i) === platformKey);
    weakOnly = weakOnly.filter((i) => platformOf(i) === platformKey);
  }

  const label = (item, section, summary, extra = {}) => {
    item.listSection = section;
    if (summary) {
      item.rankingEvidence.reviewDecision = {
        ...(item.rankingEvidence.reviewDecision || {}),
        included: true,
        summary,
        ...extra,
      };
    }
    return item;
  };

  wellSupported.forEach((i) => label(i, "RECOMMENDED"));
  weakOnly.forEach((i) =>
    label(
      i,
      "WEAK_IDENTITY",
      "Weak identity evidence (e.g. name / username only). Shown so nothing is hidden; verify manually.",
      { lowConfidence: true }
    )
  );

  // Weak-identity profiles (name / username only) do not meet the relevance
  // bar. They are shown only when too few well-supported profiles exist, so
  // the reviewer is not handed a list of namesakes. They stay stored and
  // appear with all=true. RANK_WEAK_FILL_BELOW=0 hides them completely.
  const weakFillBelow = Number.isFinite(Number(process.env.RANK_WEAK_FILL_BELOW))
    ? Number(process.env.RANK_WEAK_FILL_BELOW)
    : 3;
  const weakShown = showAll
    ? weakOnly
    : weakOnly.slice(0, Math.max(weakFillBelow - wellSupported.length, 0));

  let list = [...wellSupported, ...weakShown];

  // Top up to the minimum list size with the best of the rest.
  // Missing search results can never be shown.
  let padded = 0;
  if (showAll || list.length < minSize) {
    const filler = excludedItems
      .filter((i) => !i._eligibility.reasons.includes("MISSING_SEARCH_RESULT"))
      .sort((a, b) => b.reviewRankScore - a.reviewRankScore);

    for (const item of showAll ? filler : filler.slice(0, minSize - list.length)) {
      const why = (item._eligibility.reasons || [])
        .map((r) => REASON_TEXT[r] || r)
        .join("; ");
      label(
        item,
        "LOW_CONFIDENCE_FILLER",
        `Low confidence - added to reach the minimum list size. ${why ? "Note: " + why + "." : ""}`,
        { lowConfidence: true, reasons: item._eligibility.reasons }
      );
      list.push(item);
      padded += 1;
    }
  }

  if (weakOnly.length > weakShown.length) {
    excludedByReason.WEAK_IDENTITY_HIDDEN = weakOnly.length - weakShown.length;
  }

  // What really stayed out of the list (kept in the database)
  const inList = new Set(list);
  for (const item of excludedItems) {
    if (inList.has(item)) continue;
    item._eligibility.reasons.forEach((r) => {
      excludedByReason[r] = (excludedByReason[r] || 0) + 1;
    });
  }

  // Human review sees at most HARD_MAX_SHORTLIST profiles (best first:
  // well-supported ones come before weak-identity ones). `all=true`
  // still lists everything for debugging.
  const totalBeforeCap = list.length;
  const cap = platformKey ? platformCap : HARD_MAX_SHORTLIST;
  if (!showAll && list.length > cap) {
    list = list.slice(0, cap);
  }

  // ---- nothing disappears silently: every profile that is not in the list
  // gets a recorded stage + reasons and can be browsed (view=excluded).
  const shownSet = new Set(list);
  const hidden = [];
  for (const item of ranked) {
    if (platformKey && platformOf(item) !== platformKey) continue;
    if (shownSet.has(item)) continue;
    let stage;
    let why;
    if (!item._eligibility.eligible) {
      stage = "RANKING_ELIGIBILITY";
      why = item._eligibility.reasons;
    } else if (item._fallbackOnly) {
      stage = "WEAK_IDENTITY_HIDDEN";
      why = ["WEAK_IDENTITY_HIDDEN"];
    } else {
      stage = "CAP";
      why = [platformKey ? "PLATFORM_CAP" : "SHORTLIST_CAP"];
    }
    item.exclusion = {
      stage,
      reasons: why,
      reasonText: why.map((r) => REASON_TEXT[r] || r),
      matcherStatus: item.matchStatus,
      matcherReasons: item.matchDetails?.identity?.statusReasons || [],
    };
    hidden.push(item);
  }
  const capOverflow = hidden.filter((i) => i.exclusion.stage === "CAP").length;
  if (capOverflow) excludedByReason[platformKey ? "PLATFORM_CAP" : "SHORTLIST_CAP"] = capOverflow;

  // Counts that keep "discovered", "matched", "needs review" and
  // "rejected / conflicting" apart (matcher statuses, whole run or platform).
  const scope = platformKey ? ranked.filter((i) => platformOf(i) === platformKey) : ranked;
  const statusCount = (st) => scope.filter((i) => i.matchStatus === st).length;
  const counts = {
    discovered: scope.length,
    profileShaped: scope.filter((i) => prepared[ranked.indexOf(i)]?.page?.isActualProfile).length,
    matched: statusCount("STRONG") + statusCount("POSSIBLE"),
    strong: statusCount("STRONG"),
    possible: statusCount("POSSIBLE"),
    reviewRequired: statusCount("REVIEW_REQUIRED"),
    weak: statusCount("WEAK"),
    rejectedConflicting: statusCount("CONFLICT"),
    inReviewList: list.length,
    notInList: hidden.length,
    humanReviewed: scope.filter((i) => i.reviewStatus && i.reviewStatus !== "PENDING").length,
  };

  if (view === "excluded") {
    list = hidden
      .sort((a, b) => b.similarityScore - a.similarityScore || b.reviewRankScore - a.reviewRankScore)
      .map((item) => {
        item.listSection = "EXCLUDED";
        item.rankingEvidence.reviewDecision = {
          ...(item.rankingEvidence.reviewDecision || {}),
          included: false,
          stage: item.exclusion.stage,
          reasons: item.exclusion.reasonText,
        };
        return item;
      });
  }

  const total = list.length;
  const totalPages = Math.max(Math.ceil(total / safeLimit), 1);
  const currentPage = Math.min(safePage, totalPages);
  const selected = list.slice(
    (currentPage - 1) * safeLimit,
    currentPage * safeLimit
  );

  const data = selected.map(
    ({ _eligibility, _identityRank, _tier, _fallbackOnly, ...rest }) =>
      slimMatchForResponse(rest)
  );

  return {
    totalMatches: matches.length,
    eligibleMatches: eligible.length,
    wellSupportedMatches: wellSupported.length,
    weakFallbackAvailable: weakOnly.length,
    weakFallbackShown: weakOnly.length,
    paddedMatches: padded,
    totalShortlist: total,
    totalBeforeCap,
    view,
    counts,
    platform: platformKey,
    platformBreakdown,
    shortlisted: data.length,
    pagination: {
      page: currentPage,
      limit: safeLimit,
      total,
      totalPages,
      hasNextPage: currentPage < totalPages,
      hasPreviousPage: currentPage > 1,
    },
    excludedByReason,
    mlSummary: mlRun,
    data,
  };
};

// ============================================================
// GET TOP RELEVANT MATCHES (DB entry point, same signature as before)
// ============================================================

const pageCache = new Map();
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
// a page ranked while ML was down is re-ranked soon, so ML scores appear once it recovers
const ML_DEGRADED_TTL_MS = 20 * 1000;
const pageInflight = new Map();

const getTopRelevantMatches = async ({ bgvRunId, limit = HARD_MAX_SHORTLIST, page = 1, showAll = false, config, platform = null, view = "shortlist" } = {}) => {
  if (!bgvRunId) throw new Error("bgvRunId is required");

  // Lazy require keeps the pure ranking functions testable without mongoose.
  const CandidateMatch = require("../models/CandidateMatch");

  const matches = await CandidateMatch.find({ bgvRun: bgvRunId })
    .populate("candidate")
    .populate("searchResult")
    .lean();

  if (!matches.length) {
    return {
      totalMatches: 0,
      eligibleMatches: 0,
      wellSupportedMatches: 0,
      weakFallbackAvailable: 0,
      weakFallbackShown: 0,
      shortlisted: 0,
      totalShortlist: 0,
      paddedMatches: 0,
      pagination: {
        page: 1,
        limit: Math.min(Math.max(Number(limit) || HARD_MAX_SHORTLIST, 1), MAX_PAGE_SIZE),
        total: 0,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      },
      excludedByReason: {},
      counts: { discovered: 0, profileShaped: 0, matched: 0, strong: 0, possible: 0, reviewRequired: 0, weak: 0, rejectedConflicting: 0, inReviewList: 0, notInList: 0, humanReviewed: 0 },
      data: [],
    };
  }

  // Re-ranking (+ BGE-M3) is the expensive part. Cache the finished page for
  // a few minutes; any change (new matches, a review decision) changes the
  // signature and recomputes automatically.
  let sig = String(matches.length);
  let newest = 0;
  for (const m of matches) {
    const t = new Date(m.updatedAt || m.createdAt || 0).getTime();
    if (t > newest) newest = t;
    const st = m.searchResult?.updatedAt
      ? new Date(m.searchResult.updatedAt).getTime()
      : 0;
    if (st > newest) newest = st;
  }
  // candidate edits change the ranking too
  const cand = matches[0]?.candidate;
  const ct = cand?.updatedAt ? new Date(cand.updatedAt).getTime() : 0;
  sig += `:${newest}:${ct}`;

  const key = `${bgvRunId}|${page}|${limit}|${showAll ? 1 : 0}|${platform || ""}|${view}|v5|${sig}`;
  const hit = pageCache.get(key);
  const ttl = hit?.value?.mlSummary?.unavailable ? ML_DEGRADED_TTL_MS : PAGE_CACHE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.value;

  // identical concurrent requests share one computation (and one ML pass)
  if (pageInflight.has(key)) return pageInflight.get(key);

  const work = (async () => {
    const value = await shortlistMatches(matches, { limit, page, showAll, config, platform, view });
    if (pageCache.size >= 200) pageCache.delete(pageCache.keys().next().value);
    pageCache.set(key, { at: Date.now(), value });
    return value;
  })();
  pageInflight.set(key, work);
  try {
    return await work;
  } finally {
    pageInflight.delete(key);
  }
};

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // original public API
  getTopRelevantMatches,
  calculateReviewRankScore,
  getMLScoresBatched,
  selectMLCandidates,

  // building blocks (tests / identity grouping / other services)
  rankMatch,
  shortlistMatches,
  classifyPage,
  analyzeDomainRelevance,
  analyzeLocation,
  buildCorroborationIndex,
  detectContactMatch,
  getProfileType,
  calculateProfileQuality,
  DEFAULT_CONFIG,
  HARD_MAX_SHORTLIST,
};