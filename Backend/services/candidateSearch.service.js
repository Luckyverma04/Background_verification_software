const { normalizeLocation } = require("../utils/locationNormalizer");
const { createTimings } = require("../utils/perf");
const providerLayer = require("./searchProvider.service");
const verifiedIdentities = require("./verifiedIdentity.service");
const SearchResult = require("../models/SearchResult");

const Candidate = require("../models/Candidate");

const BgvRun = require("../models/BgvRun");



const {

  searchWithProviders,

} = require("./searchProvider.service");



const {

  mergeSearchResults,

  normalizeUrl,

  normalizeSerperResult,

} = require("./resultMerge.service");

const {
  getCandidateSocialUrls,
  canonicalProfileKey,
} = require("../utils/candidateUrls");

const { seedKnowledgeBaseResults } = require("./identityKnowledge.service");

const { enrichRunProfiles } = require("./profileEnrichment.service");
const matchSignals = require("./matchSignals.service");
const platformDiscovery = require("./platformDiscovery.service");
const { enrichProfileImages } = require("./profileImage.service");



/**

* * Get all existing SearchResults for this BGV run.*

* **

* * IMPORTANT:*

* * We do NOT filter by match percentage here.*

* * Every discovered result should remain available*

* * for the matching engine and human review.*

*/

const getExistingResults = async (bgvRunId) => {

  return SearchResult.find({

    bgvRun: bgvRunId,

  }).lean();

};



/**

* * Build multiple search queries from candidate data.*

* **

* * We intentionally create multiple queries so that*

* * different search providers can discover more profiles.*

*/

// Values that mean "we do not know" must never be searched as if real.
const PLACEHOLDER_RE =
  /^(n\/?a|na|none|null|nil|undefined|unknown|not available|not provided|not applicable|-+|\.+|\?+|tbd|test)$/i;

const cleanText = (value) => {
  if (value === null || value === undefined) return "";

  // Locations are stored as { city, state, country } objects: turn them into
  // "City, State, Country" instead of "[object Object]".
  if (typeof value === "object") {
    if (Array.isArray(value)) return cleanText(value.map(cleanText).join(" "));
    const parts = [value.city, value.state, value.country]
      .map((part) => (part ? String(part).trim() : ""))
      .filter(Boolean);
    return parts.join(", ");
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  return PLACEHOLDER_RE.test(text) ? "" : text;
};

const uniqueQueries = (queries = []) => {
  return [...new Set(
    queries
      .map(cleanText)
      .filter(Boolean)
  )];
};

const getCandidateLocation = (candidate) => {
  const location = candidate?.location;
  if (!location) return { city: "", state: "", country: "" };

  const input =
    typeof location === "string"
      ? { country: cleanText(location) }
      : {
          city: cleanText(location.city),
          state: cleanText(location.state),
          country: cleanText(location.country),
        };

  // fixes contradictory input such as Dewas + Maharashtra (-> Madhya Pradesh)
  const { city, state, country } = normalizeLocation(input);
  return { city, state, country };
};

/**
 * Everything we know about the candidate besides the name.
 * A name alone is NOT enough to search: common names return thousands of
 * unrelated profiles. Every query below pairs the name with at least one
 * of these signals.
 */
const getCandidateSignals = (candidate) => {
  const { city, state, country } = getCandidateLocation(candidate);

  const companies = uniqueQueries([
    candidate?.currentCompany,
    ...(Array.isArray(candidate?.experience)
      ? candidate.experience.map((e) => e?.company)
      : []),
  ]).slice(0, 4);

  const titles = uniqueQueries([
    candidate?.currentJobTitle,
    ...(Array.isArray(candidate?.experience)
      ? candidate.experience.map((e) => e?.jobTitle)
      : []),
  ]).slice(0, 2);

  const institutions = uniqueQueries(
    Array.isArray(candidate?.education)
      ? candidate.education.map((e) => e?.institution)
      : []
  ).slice(0, 3);

  const email = cleanText(candidate?.email).toLowerCase();
  const emailUser = email.includes("@") ? email.split("@")[0] : "";

  return { city, state, country, companies, titles, institutions, email, emailUser };
};

/**
 * PHASE 1: Discovery queries - ALWAYS name + something else.
 *
 * Location narrows a common name dramatically (often by ~80%), and
 * company / college / job title narrow it further. A name-only query is
 * used ONLY when the candidate has no other detail at all.
 */
const buildSearchQueries = (candidate, plan = null) => {
  const name = cleanText(candidate?.fullName);
  if (!name) return [];

  const sig = getCandidateSignals(candidate);
  const q = [];
  const place = (extra) => (extra ? ` "${extra}"` : "");

  const fallback = []; // broader scope: only used when the primary tier is thin

  // 1. name + location (strongest first)
  if (sig.city && sig.state) q.push(`"${name}" "${sig.city}" "${sig.state}"`);
  if (sig.city) q.push(`"${name}" "${sig.city}"`);

  // Name variation: drop middle names ("Rahul Kumar Sharma" -> "Rahul Sharma")
  const parts = name.split(" ").filter(Boolean);
  if (parts.length >= 3 && (sig.city || sig.state)) {
    q.push(`"${parts[0]} ${parts[parts.length - 1]}" "${sig.city || sig.state}"`);
  }
  // state / country only: broader scope. They are the controlled fallback when
  // a city is known (a locally identified person is not searched world-wide
  // unless the precise queries come back thin); without a city they ARE the
  // most precise location signal, so they stay in the primary tier.
  const broad = sig.city ? fallback : q;
  if (sig.state) broad.push(`"${name}" "${sig.state}"`);
  if (sig.country && !sig.state) broad.push(`"${name}" "${sig.country}"`);

  // 2. name + employer (current and past)
  sig.companies.forEach((c, i) => {
    q.push(`"${name}" "${c}"`);
    if (i === 0 && sig.city) q.push(`"${name}" "${c}" "${sig.city}"`);
  });

  // 3. name + college / institution
  sig.institutions.forEach((inst, i) => {
    q.push(`"${name}" "${inst}"`);
    if (i === 0 && sig.city) q.push(`"${name}" "${inst}" "${sig.city}"`);
  });

  // 4. name + job title
  sig.titles.forEach((t, i) => {
    q.push(`"${name}" "${t}"${i === 0 ? place(sig.city || sig.state) : ""}`);
  });

  // 5. the candidate's own email / its username part (very specific)
  if (sig.email) q.push(`"${sig.email}"`);
  if (sig.emailUser.length >= 6) q.push(`"${sig.emailUser}"`);

  const max = Number(process.env.SEARCH_MAX_DISCOVERY_QUERIES) || 15;
  const unique = uniqueQueries(q).slice(0, max);
  const fallbackUnique = uniqueQueries(fallback).filter((x) => !unique.includes(x));
  if (plan) plan.fallback = fallbackUnique.slice(0, 3);

  if (unique.length === 0) {
    console.warn(
      "WARNING: candidate has no location/company/education/email - " +
        "falling back to a name-only search (results will be noisy). " +
        "Add city/company/college for accurate results."
    );
    return [`"${name}"`];
  }

  // compatibility: callers that only want a flat list get primary + fallback
  return plan ? unique : [...unique, ...fallbackUnique].slice(0, max);
};

/**
 * Extract a compact identity/location/company signal from a search result.
 * This is only used to decide which profiles deserve a second search pass.
 */
const getResultSearchText = (result) => {
  const raw = result?.rawData || {};
  const providerResults = Array.isArray(raw.providerResults)
    ? raw.providerResults
    : [];

  const providerText = providerResults
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      return [
        item.title,
        item.snippet,
        item.name,
        item.username,
        item.jobTitle,
        item.company,
        item.location,
      ]
        .map(cleanText)
        .filter(Boolean)
        .join(" ");
    })
    .join(" ");

  return cleanText([
    result?.name,
    result?.username,
    result?.jobTitle,
    result?.company,
    result?.location,
    result?.headline,
    result?.bio,
    result?.about,
    raw.title,
    raw.snippet,
    providerText,
  ].map(cleanText).filter(Boolean).join(" "));
};

const normalizeForCompare = (value) =>
  cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const includesSignal = (text, value) => {
  const needle = normalizeForCompare(value);
  if (!needle) return false;
  return normalizeForCompare(text).includes(needle);
};

/**
 * Give discovery results a deterministic pre-ML score.
 * This score is NOT the final BGV match score. It only decides
 * which discovered profiles are worth a targeted second search.
 */
const scoreDiscoveryResult = (candidate, result) => {
  const name = cleanText(candidate?.fullName);
  const { city, state, country } = getCandidateLocation(candidate);
  const company = cleanText(candidate?.currentCompany);
  const jobTitle = cleanText(candidate?.currentJobTitle);
  const text = getResultSearchText(result);

  let score = 0;

  if (result?.profileUrl) score += 5;
  if (result?.platform) score += 3;

  if (name && includesSignal(text, name)) score += 40;
  if (city && includesSignal(text, city)) score += 25;
  if (state && includesSignal(text, state)) score += 15;
  if (country && includesSignal(text, country)) score += 5;
  if (company && includesSignal(text, company)) score += 15;
  if (jobTitle && includesSignal(text, jobTitle)) score += 10;
  if (result?.username) score += 3;

  return score;
};

/**
 * PHASE 2: Targeted secondary searches.
 *
 * We take only the strongest discovery results and search using the
 * information already discovered about those profiles.
 */
const NAME_ONLY_POINTS = 40;
const MIN_EXTRA_SIGNAL = Number(process.env.SEARCH_MIN_EXTRA_SIGNAL) || 15;

const buildTargetedSearchQueries = (
  candidate,
  discoveryResults = [],
  { coveredPlatforms = [], skipCoreSites = false, diagnostics: diag } = {}
) => {
  const name = cleanText(candidate?.fullName);
  if (!name || !Array.isArray(discoveryResults)) return [];

  const diagnostics = diag || {};
  diagnostics.rejected = diagnostics.rejected || [];
  diagnostics.errors = diagnostics.errors || [];
  diagnostics.skippedResults = diagnostics.skippedResults || 0;
  diagnostics.nearDuplicatesDropped = diagnostics.nearDuplicatesDropped || [];

  const ranked = discoveryResults
    .map((result) => ({
      result,
      score: scoreDiscoveryResult(candidate, result),
    }))
    .sort((a, b) => b.score - a.score);

  const queries = [];
  const seenProfiles = new Set();
  const coveredSet = new Set(coveredPlatforms.map((p) => String(p).toUpperCase()));

  const maxQueries = Number(process.env.SEARCH_MAX_TARGETED_QUERIES) || 40;
  const minScore = Number(process.env.SEARCH_TARGETED_MIN_SCORE) || 30;

  for (const { result, score } of ranked) {
    if (queries.length >= maxQueries) break;
    if (score < minScore) continue;

    // Name match alone (40 pts) is not enough - the profile must also match
    // location, company or job title, otherwise it is probably a namesake.
    if (score - NAME_ONLY_POINTS < MIN_EXTRA_SIGNAL) continue;

    const profileKey = normalizeUrl(result?.profileUrl) ||
      cleanText(result?.username) ||
      cleanText(result?.name);

    if (profileKey && seenProfiles.has(profileKey)) continue;
    if (profileKey) seenProfiles.add(profileKey);

    // One malformed result must never stop query generation for the run.
    try {
      const reject = (field, value, reason) =>
        diagnostics.rejected.push({ field, value: String(value ?? "").slice(0, 120), reason, url: result?.profileUrl || null });

      // The result must really look like the candidate before its details are
      // reused: a namesake's company/location would send the search to the
      // wrong person. (Phase 1 already searched the candidate's own signals.)
      const nameCheck = matchSignals.compareNames(candidate?.fullName, result?.name);
      if (nameCheck.state !== "MATCH") {
        diagnostics.skippedResults += 1;
        continue;
      }
      const corroborated =
        ["MATCH", "PARTIAL"].includes(matchSignals.compareCompany(candidate, result?.company, "").state) ||
        ["MATCH", "PARTIAL"].includes(matchSignals.compareLocation(candidate?.location, result?.location, "").state) ||
        matchSignals.compareEducation(candidate?.education, result?.education, "").state === "MATCH";
      if (!corroborated) {
        diagnostics.skippedResults += 1;
        continue;
      }

      // ---- validated signals only
      let company = "";
      if (result?.company) {
        const v = matchSignals.validateCompany(result.company);
        if (v.valid) company = v.value;
        else reject("company", result.company, v.reason);
      }

      let jobTitle = "";
      if (result?.jobTitle) {
        const v = matchSignals.validateTitle(result.jobTitle);
        if (!v.valid) reject("jobTitle", result.jobTitle, v.reason);
        else if (v.generic) reject("jobTitle", result.jobTitle, "generic title");
        else jobTitle = v.value;
      }

      let location = "";
      if (result?.location) {
        const v = matchSignals.validateLocation(result.location);
        if (v.valid) location = matchSignals.locationToQuery(result.location) || "";
        else reject("location", cleanText(result.location), v.reason);
      }

      let username = "";
      if (result?.username) {
        const v = matchSignals.validateQueryUsername(result.username, candidate?.fullName);
        if (v.valid) username = v.value;
        else reject("username", result.username, v.reason);
      }

      const platform = cleanText(result?.platform).toLowerCase();

      if (company) queries.push(`"${name}" "${company}"`);

      if (jobTitle && location) {
        queries.push(`"${name}" "${jobTitle}" "${location}"`);
      } else if (jobTitle) {
        queries.push(`"${name}" "${jobTitle}"`);
      }

      const platformKey = platform.includes("linkedin") ? "LINKEDIN"
        : platform.includes("github") ? "GITHUB"
        : platform.includes("instagram") ? "INSTAGRAM"
        : platform.includes("facebook") ? "FACEBOOK"
        : platform === "x" || platform.includes("twitter") ? "TWITTER" : "";
      const uq = username ? ` "${username}"` : "";
      if (platformKey && !coveredSet.has(platformKey)) {
        if (platformKey === "LINKEDIN") queries.push(`site:linkedin.com/in "${name}"${company ? ` "${company}"` : ""}`);
        else if (platformKey === "GITHUB") queries.push(`site:github.com "${name}"${uq}`);
        else if (platformKey === "INSTAGRAM") queries.push(`site:instagram.com "${name}"${uq}`);
        else if (platformKey === "FACEBOOK") queries.push(`site:facebook.com "${name}"${uq}`);
        else queries.push(`site:x.com "${name}"${uq}`);
      }

      // A validated, name-derived username finds the same person elsewhere.
      if (username) queries.push(`"${username}"`);
    } catch (error) {
      diagnostics.errors.push(error.message);
    }
  }

  // Core platforms are always searched (even if Phase 1 found nothing there).
  // site -> platform. A platform we already hold a CONFIRMED / candidate-
  // supplied profile for is not searched again (saves paid API calls).
  const SITE_PLATFORM = {
    "linkedin.com/in": "LINKEDIN",
    "github.com": "GITHUB",
    "instagram.com": "INSTAGRAM",
    "facebook.com": "FACEBOOK",
    "x.com": "TWITTER",
    "youtube.com": "YOUTUBE",
    "medium.com": "MEDIUM",
    "stackoverflow.com": "STACKOVERFLOW",
    "quora.com": "QUORA",
    "reddit.com/user": "REDDIT",
  };
  const covered = new Set(coveredPlatforms.map((p) => String(p).toUpperCase()));
  // Per-platform discovery (platformDiscovery.service) searches every
  // platform with its own queries, so these generic site queries are skipped.
  const coreSites = skipCoreSites
    ? []
    : Object.keys(SITE_PLATFORM).filter(
        (site) => !covered.has(SITE_PLATFORM[site])
      );
  const sig = getCandidateSignals(candidate);
  const anchor =
    sig.city || sig.state || sig.companies[0] || sig.institutions[0] || sig.country;
  if (anchor) {
    for (const site of coreSites) {
      queries.push(`site:${site} "${name}" "${anchor}"`);
    }
    // Second anchor (company / college) widens coverage on the big sites.
    const second = [sig.companies[0], sig.institutions[0]].find(
      (v) => v && v !== anchor
    );
    if (second) {
      for (const site of coreSites.slice(0, 5)) {
        queries.push(`site:${site} "${name}" "${second}"`);
      }
    }
  }

  const { queries: deduped, dropped } = matchSignals.dedupeQueries(uniqueQueries(queries));
  diagnostics.nearDuplicatesDropped.push(...dropped);
  return deduped.slice(0, maxQueries);
};

const runPool = async (items, concurrency, worker) => {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const index = i++;
        await worker(items[index], index);
      }
    })
  );
};

/**
 * Profile-shaped URLs whose title/snippet carry the candidate's full name.
 * Used only to decide whether the precise (city-level) queries found enough
 * to skip the broader state/country fallback - it is NOT an identity verdict.
 */
const countNameMatchingProfiles = (merged = [], fullName = "") => {
  const tokens = String(fullName || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!tokens.length) return merged.length;
  let n = 0;
  for (const r of merged) {
    if (!r?.profileUrl) continue;
    if (!platformDiscovery.hasProfileUrlShape(r.profileUrl, r.platform)) continue;
    const text = `${r.name || ""} ${r.title || ""} ${r.snippet || ""} ${r.username || ""}`.toLowerCase();
    if (tokens.every((t) => text.includes(t))) n += 1;
  }
  return n;
};

/**
 * Runs every query on Tavily (1 call, up to 20 results) and Serper
 * (page 1..pages, stops early when a page is thin). A few queries run
 * in parallel. Throws if EVERY call failed, so "0 results" is never silent.
 */
const searchExternalProviders = async (
  queries,
  { pages = 1, seenQueries = null } = {}
) => {
  const tavilyResults = [];
  const serperResults = [];
  const errors = [];
  let calls = 0;
  let okCalls = 0;
  let skippedDuplicateQueries = 0;
  let resultsWithoutUrl = 0;
  const urllessRecords = [];
  const urllessSeen = new Set();

  // Never run the same query twice inside one run (it costs money).
  if (seenQueries) {
    const fresh = [];
    for (const query of queries) {
      const key = String(query).toLowerCase().replace(/\s+/g, " ").trim();
      if (seenQueries.has(key)) {
        skippedDuplicateQueries += 1;
        continue;
      }
      seenQueries.add(key);
      fresh.push(query);
    }
    queries = fresh;
  }

  const collect = (response) => {
    calls += 1;
    if (!response.success) {
      errors.push(`${response.provider}: ${response.error}`);
      console.error(`${response.provider} failed:`, response.error);
      return;
    }
    okCalls += 1;

    // Provider results without any URL cannot become a profile record;
    // they are counted (never dropped silently).
    for (const r of response.results) {
      if (r?.url || r?.link) continue;
      resultsWithoutUrl += 1;
      const k = `${r?.title}|${r?.snippet || r?.content}`;
      if (urllessSeen.has(k) || urllessRecords.length >= 100) continue;
      urllessSeen.add(k);
      urllessRecords.push({
        reason: "NO_PROFILE_URL",
        provider: String(response.provider).toUpperCase(),
        title: r?.title || null,
        snippet: String(r?.snippet || r?.content || "").slice(0, 300) || null,
      });
    }

    (response.provider === "tavily" ? tavilyResults : serperResults).push(
      ...response.results
    );
  };

  await runPool(
    queries,
    Number(process.env.SEARCH_CONCURRENCY) || 4,
    async (query) => {
      console.log(`Searching: ${query}`);

      // site:... is a Google operator; Tavily filters by include_domains.
      const siteMatch = query.match(/site:(\S+)/);
      const tavilyOptions = {
        maxResults: Number(process.env.TAVILY_MAX_RESULTS) || 20,
        ...(siteMatch
          ? { includeDomains: [siteMatch[1].split("/")[0]] }
          : {}),
      };
      const tavilyQuery = siteMatch
        ? query.replace(/site:\S+\s*/g, "").trim()
        : query;

      const tavilyPromise = searchWithProviders(
        ["tavily"],
        tavilyQuery || query,
        tavilyOptions
      );

      const serperPromise = (async () => {
        const out = [];
        for (let page = 1; page <= pages; page++) {
          const res = await searchWithProviders(["serper"], query, {
            maxResults: 10,
            ...(page > 1 ? { page } : {}),
          });
          out.push(...res);
          const r = res[0];
          if (!r || !r.success || (r.results || []).length < 5) break;
        }
        return out;
      })();

      const [tavilyRes, serperRes] = await Promise.all([
        tavilyPromise,
        serperPromise,
      ]);

      [...tavilyRes, ...serperRes].forEach(collect);
    }
  );

  if (calls > 0 && okCalls === 0) {
    throw new Error(
      `All search API calls failed. First error: ${errors[0] || "unknown"}`
    );
  }

  return {
    tavilyResults,
    serperResults,
    calls,
    okCalls,
    errors: [...new Set(errors)].slice(0, 5),
    skippedDuplicateQueries,
    resultsWithoutUrl,
    urllessRecords,
  };
};

/**

* * Create a map of existing MongoDB results*

* * by normalized profile URL.*

*/

const createExistingUrlMap = (existingResults) => {

  const map = new Map();



  for (const result of existingResults) {

    if (!result.profileUrl) {

      continue;

    }



    const normalizedUrl = normalizeUrl(

      result.profileUrl

    );



    if (normalizedUrl) {

      map.set(normalizedUrl, result);

    }

  }



  return map;

};



/**

* * Merge image URLs from existing + newly discovered data.*

*/

const mergeImageUrls = (

  existingImages = [],

  newImages = []

) => {

  return [

    ...new Set([

      ...existingImages.filter(Boolean),

      ...newImages.filter(Boolean),

    ]),

  ];

};



/**

* * Merge provider result data.*

*/

const mergeProviderResults = (

  existingRawData = {},

  result = {}

) => {

  const existingProviders =

    existingRawData.providers || [];



  const existingProviderResultIds =

    existingRawData.providerResultIds || [];



  const existingProviderResults =

    existingRawData.providerResults || [];



  const newProviders =

    result.providers || [];



  const newProviderResultIds =

    result.providerResultIds || [];



  const newProviderResults =

    result.providerResults || [];



  return {

    ...existingRawData,



    providers: [

      ...new Set([

        ...existingProviders,

        ...newProviders,

      ]),

    ],



    providerResultIds: [

      ...new Set([

        ...existingProviderResultIds,

        ...newProviderResultIds,

      ]),

    ],



    providerResults: [

      ...existingProviderResults,

      ...newProviderResults,

    ],



    title:

      result.title ||

      existingRawData.title ||

      null,



    snippet:

      result.snippet ||

      existingRawData.snippet ||

      null,



    relevanceScore:

      result.relevanceScore ??

      existingRawData.relevanceScore ??

      null,

  };

};



/**

* * Update an existing SearchResult with newly*

* * discovered information.*

*/

const updateExistingResult = async (

  existing,

  result

) => {

  const existingImages =

    existing.profileImageUrls || [];



  const newImages =

    result.profileImageUrls || [];



  const mergedImages = mergeImageUrls(

    existingImages,

    newImages

  );



  const updateData = {};



  // -----------------------------------------*

  // BASIC DATA*

  // -----------------------------------------*



  if (!existing.platform && result.platform) {

    updateData.platform = result.platform;

  }



  if (!existing.profileId && result.profileId) {

    updateData.profileId = result.profileId;

  }



  if (!existing.username && result.username) {

    updateData.username = result.username;

  }



  if (!existing.name && result.name) {

    updateData.name = result.name;

  }
  // Fill professional fields only when still empty (never overwrite).
  for (const field of ["headline", "company", "jobTitle"]) {
    if (!existing[field] && result[field]) updateData[field] = result[field];
  }
  const hasLoc = (l) => l && (l.city || l.state || l.country);
  if (!hasLoc(existing.location) && hasLoc(result.location)) {
    updateData.location = result.location;
  }
  if (
    !(existing.education || []).length &&
    Array.isArray(result.education) &&
    result.education.length
  ) {
    updateData.education = result.education;
  }




  // -----------------------------------------*

  // IMAGE DATA*

  // -----------------------------------------*



  if (mergedImages.length > 0) {

    updateData.profileImageUrls =

      mergedImages;

  }



  if (

    !existing.profileImageUrl &&

    result.profileImageUrl

  ) {

    updateData.profileImageUrl =

      result.profileImageUrl;

  }



  // If the main image is not present but*

  // we have image URLs, use the first one.*

  if (

    !existing.profileImageUrl &&

    !result.profileImageUrl &&

    mergedImages.length > 0

  ) {

    updateData.profileImageUrl =

      mergedImages[0];

  }



  // -----------------------------------------*

  // PROVIDER DATA*

  // -----------------------------------------*



  updateData.rawData =

    mergeProviderResults(

      existing.rawData || {},

      result

    );



  // -----------------------------------------*

  // UPDATE DATABASE*

  // -----------------------------------------*



  if (Object.keys(updateData).length === 0) {

    return existing;

  }



  const updatedResult =

    await SearchResult.findByIdAndUpdate(

      existing._id,

      updateData,

      {

        new: true,

        runValidators: true,

      }

    ).lean();



  return updatedResult;

};



/**

* * Save API results without creating duplicate*

* * SearchResult documents.*

* **

* * Existing profiles are updated with new*

* * provider/image information.*

*/

const ENRICH_REUSE_DAYS = () => Math.max(Number(process.env.PROFILE_REUSE_TTL_DAYS ?? 14) || 0, 0);

/**
 * Profiles this candidate already has from EARLIER runs, keyed by canonical
 * URL (newest first). One batched query on the existing {bgvRun, profileUrl}
 * index. Scope = same candidate: public data is reused, nothing crosses
 * candidates. Reviewer decisions live on CandidateMatch and are never touched.
 */
const findPriorProfiles = async ({ candidateId, bgvRunId, urls }) => {
  const prior = new Map();
  if (!candidateId || !urls.length) return prior;

  const runIds = await BgvRun.find({ candidate: candidateId, _id: { $ne: bgvRunId } })
    .select("_id")
    .lean();
  if (!runIds.length) return prior;

  const rows = await SearchResult.find({
    bgvRun: { $in: runIds.map((r) => r._id) },
    profileUrl: { $in: urls },
  })
    .sort({ updatedAt: -1 })
    .lean();

  for (const row of rows) {
    const key = canonicalProfileKey(row.profileUrl) || row.profileUrl;
    if (!prior.has(key)) prior.set(key, row);
  }
  return prior;
};

/** Fields copied from an earlier run's row (only where the new row has none). */
const reuseFromPrior = (doc, prior) => {
  const copied = [];
  const has = (v) => (Array.isArray(v) ? v.length > 0 : v && (typeof v !== "object" || Object.keys(v).length > 0));
  for (const f of ["headline", "bio", "company", "jobTitle", "name", "profileImageUrl"]) {
    if (!has(doc[f]) && has(prior[f])) {
      doc[f] = prior[f];
      copied.push(f);
    }
  }
  for (const f of ["location", "education", "previousEmployers", "linkedProfiles", "profileImageUrls"]) {
    if (!has(doc[f]) && has(prior[f])) {
      doc[f] = prior[f];
      copied.push(f);
    }
  }
  // enrichment is reused only while it is still fresh (never re-served stale)
  const ttl = ENRICH_REUSE_DAYS();
  const at = prior.enrichment?.attemptedAt ? new Date(prior.enrichment.attemptedAt).getTime() : 0;
  let enrichmentReused = false;
  if (ttl > 0 && at && Date.now() - at < ttl * 86400000 && prior.enrichment?.status !== "FAILED") {
    doc.enrichment = { ...prior.enrichment, reusedFromRun: String(prior.bgvRun), reusedAt: new Date() };
    enrichmentReused = true;
  }
  return { copied, enrichmentReused };
};

const buildResultDoc = (bgvRunId, normalizedUrl, result) => {
  const imageUrls = result.profileImageUrls || [];
  return {
    bgvRun: bgvRunId,
    platform: result.platform,
    profileUrl: normalizedUrl,
    profileId: result.profileId,
    username: result.username,
    name: result.name,
    // professional fields extracted from the provider result
    headline: result.headline || undefined,
    company: result.company || undefined,
    jobTitle: result.jobTitle || undefined,
    location: result.location || undefined,
    education: Array.isArray(result.education) ? result.education : undefined,
    profileImageUrl: result.profileImageUrl || imageUrls[0] || null,
    profileImageUrls: imageUrls,
    source: result.searchProvider === "MANUAL" ? "MANUAL" : "SEARCH_API",
    searchProvider: result.searchProvider,
    providerResultId: result.providerResultId,
    sourceUrl: normalizedUrl,
    rawData: {
      providers: result.providers || [],
      providerResultIds: result.providerResultIds || [],
      providerResults: result.providerResults || [],
      title: result.title || null,
      snippet: result.snippet || null,
      relevanceScore: result.relevanceScore ?? null,
    },
  };
};

/**
 * Save API results without creating duplicate SearchResult documents.
 *
 *  - results already in THIS run are updated in place (bounded parallelism);
 *  - results this candidate already had in an EARLIER run are inserted for the
 *    new run with their stored public data / fresh enrichment carried over
 *    (`rawData.reuse` records it) - no re-fetch, no re-enrichment;
 *  - everything else is inserted with ONE bulk write (ordered:false), and a
 *    duplicate-key race falls back to an update, never to a failure.
 */
const saveNewResults = async ({
  bgvRunId,
  candidateId = null,
  mergedResults,
  existingResults,
  stats = null,
}) => {
  const existingMap = createExistingUrlMap(existingResults);
  const savedResults = [];
  const reusedResults = [];
  // Results we could not store as a profile. They are never dropped
  // silently - each one is reported with a reason.
  const excludedResults = [];

  const toInsert = new Map(); // normalizedUrl -> { result, doc }
  const toUpdate = []; // [existing, result]

  for (const result of mergedResults) {
    if (!result.profileUrl) {
      excludedResults.push({
        reason: "NO_PROFILE_URL",
        title: result.title || result.name || null,
        snippet: String(result.snippet || "").slice(0, 300) || null,
        providers: result.providers || [],
      });
      continue;
    }
    const normalizedUrl = normalizeUrl(result.profileUrl);
    if (!normalizedUrl) {
      excludedResults.push({
        reason: "UNUSABLE_PROFILE_URL",
        title: result.title || result.name || null,
        snippet: String(result.snippet || "").slice(0, 300) || null,
        url: String(result.profileUrl).slice(0, 200),
        providers: result.providers || [],
      });
      continue;
    }

    const existing = existingMap.get(normalizedUrl);
    if (existing) {
      toUpdate.push([existing, result, normalizedUrl]);
      continue;
    }
    if (!toInsert.has(normalizedUrl)) {
      toInsert.set(normalizedUrl, { result, doc: buildResultDoc(bgvRunId, normalizedUrl, result) });
    }
  }

  // ---- cross-run reuse (one batched read) ----
  const readStart = Date.now();
  let prior = new Map();
  try {
    prior = await findPriorProfiles({ candidateId, bgvRunId, urls: [...toInsert.keys()] });
  } catch (error) {
    console.error("Prior profile lookup failed (continuing without reuse):", error.message);
  }
  const reuse = { profiles: 0, enrichments: 0, fieldsCopied: 0 };
  for (const [url, entry] of toInsert) {
    const p = prior.get(canonicalProfileKey(url) || url);
    if (!p) continue;
    const r = reuseFromPrior(entry.doc, p);
    reuse.profiles += 1;
    if (r.enrichmentReused) reuse.enrichments += 1;
    reuse.fieldsCopied += r.copied.length;
    entry.doc.rawData.reuse = {
      fromRun: String(p.bgvRun),
      fromResult: String(p._id),
      fields: r.copied,
      enrichmentReused: r.enrichmentReused,
      at: new Date(),
    };
  }
  if (stats) {
    stats.dbReadMs = (stats.dbReadMs || 0) + (Date.now() - readStart);
    stats.reuse = reuse;
  }

  // ---- updates of rows already in this run ----
  const writeStart = Date.now();
  await runPool(toUpdate, 8, async ([existing, result, url]) => {
    // A previously verified profile found again: if what the search returns now
    // differs materially from what the reviewer confirmed (other username /
    // profile id / clearly other display name), record it so matching sends it
    // back to a human instead of silently assuming it is the same identity.
    const vi = existing.rawData?.verifiedIdentity;
    if (vi?.fingerprint) {
      const reasons = verifiedIdentities.assessChange(vi.fingerprint, result);
      if (reasons.length) {
        await SearchResult.updateOne(
          { _id: existing._id },
          { $set: { "rawData.identityChange": { reasons, detectedAt: new Date(), found: { name: result.name || null, username: result.username || null, profileId: result.profileId || null } } } }
        );
        existing = { ...existing, rawData: { ...(existing.rawData || {}), identityChange: { reasons } } };
      }
    }
    const updated = await updateExistingResult(existing, result);
    reusedResults.push(updated);
    existingMap.set(url, updated);
  });

  // ---- one bulk insert ----
  const docs = [...toInsert.values()].map((e) => e.doc);
  if (docs.length) {
    let inserted = [];
    let failed = [];
    try {
      inserted = await SearchResult.insertMany(docs, { ordered: false, rawResult: false });
    } catch (error) {
      // ordered:false: everything that could be inserted was; the rest are
      // duplicates of rows inserted by a parallel run / retry.
      inserted = error?.insertedDocs || [];
      failed = (error?.writeErrors || []).map((w) => docs[w.index ?? w.err?.index]).filter(Boolean);
      if (!error?.writeErrors && !error?.insertedDocs) throw error;
      if (error.code !== 11000 && !(error.writeErrors || []).every((w) => (w.err?.code ?? w.code) === 11000)) throw error;
    }
    for (const doc of inserted) {
      const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
      savedResults.push(obj);
      existingMap.set(obj.profileUrl, obj);
    }
    for (const doc of failed) {
      const duplicate = await SearchResult.findOne({ bgvRun: bgvRunId, profileUrl: doc.profileUrl }).lean();
      if (!duplicate) continue;
      const updated = await updateExistingResult(duplicate, toInsert.get(doc.profileUrl).result);
      reusedResults.push(updated);
      existingMap.set(doc.profileUrl, updated);
    }
  }
  if (stats) stats.dbWriteMs = (stats.dbWriteMs || 0) + (Date.now() - writeStart);

  return { savedResults, reusedResults, excludedResults, reuse };
};

/**
 * Links the candidate typed in (LinkedIn, GitHub, ...) become results
 * straight away - no search needed. They are the DIRECT matches.
 */
const buildKnownProfileSeeds = (candidate) =>
  Object.values(getCandidateSocialUrls(candidate))
    .map((url) => {
      const normalized = normalizeSerperResult({
        link: url,
        title: candidate.fullName,
        snippet: "",
      });

      if (!normalized) return null;

      return {
        ...normalized,
        searchProvider: "MANUAL",
        providers: ["MANUAL"],
        providerResultIds: [],
        providerResults: [{ manual: true, url }],
      };
    })
    .filter(Boolean);

/**

* * Main Candidate Search Engine*

* **

* * Flow:*

* **

* * Candidate*

* *    ↓*

* * Existing MongoDB results*

* *    ↓*

* * Tavily + Serper*

* *    ↓*

* * Normalize + deduplicate*

* *    ↓*

* * Compare URLs with MongoDB*

* *    ↓*

* * Create new OR update existing results*

* *    ↓*

* * Return ALL results*

*/

const searchCandidate = async ({
  candidateId,
  bgvRunId,
}) => {
  const timings = createTimings("search");
  const perfStats = { dbReadMs: 0, dbWriteMs: 0 };
  providerLayer.resetMetrics();

  // -----------------------------------------
  // 1. Validate Candidate / BGV run / ownership
  // -----------------------------------------

  const candidate = await Candidate.findById(candidateId);

  if (!candidate) {
    throw new Error("Candidate not found");
  }

  const bgvRun = await BgvRun.findById(bgvRunId);

  if (!bgvRun) {
    throw new Error("BGV run not found");
  }

  if (bgvRun.candidate.toString() !== candidate._id.toString()) {
    throw new Error("BGV run does not belong to this candidate");
  }

  // -----------------------------------------
  // 2. Existing MongoDB results of THIS run
  // -----------------------------------------

  let existingResults = await getExistingResults(bgvRunId);

  console.log(`Existing MongoDB results: ${existingResults.length}`);

  // -----------------------------------------
  // 3. Knowledge base: profiles a human already
  //    confirmed in EARLIER runs (never auto-approved)
  // -----------------------------------------

  // -----------------------------------------
  // 2b. Permanent verified-identity registry (this candidate): loaded BEFORE
  //     any external discovery. These profiles are "Previously Verified":
  //     they are put into the run from the database, not re-discovered,
  //     re-enriched or re-confirmed. Discovery below still looks for NEW ones.
  // -----------------------------------------
  let verifiedSeeds = { loaded: 0, created: 0, alreadyPresent: 0, backfilled: 0, profileUrls: [], usernames: [], platforms: [], keys: [] };
  const verifiedStart = Date.now();
  try {
    verifiedSeeds = await verifiedIdentities.applyVerifiedToRun({ candidate, bgvRunId });
  } catch (error) {
    // the registry is memory, not a gate: a failure must not stop the search
    console.error("Verified identity load failed (continuing without it):", error.message);
  }
  perfStats.dbReadMs += Date.now() - verifiedStart;
  if (verifiedSeeds.loaded > 0) {
    console.log(
      `Previously verified: ${verifiedSeeds.loaded} profile(s) (${verifiedSeeds.created} added to this run from the registry, ` +
        `${verifiedSeeds.backfilled} imported from earlier decisions)`
    );
    existingResults = await getExistingResults(bgvRunId);
  }

  let knowledgeBase = {
    found: 0,
    created: 0,
    alreadyPresent: 0,
    platforms: [],
    profileUrls: [],
    groups: [],
    runs: [],
  };

  try {
    knowledgeBase = await seedKnowledgeBaseResults({
      candidate,
      bgvRunId,
      skipKeys: new Set(verifiedSeeds.keys || []),
    });
  } catch (error) {
    // The knowledge base is a bonus; a failure must not stop the search.
    console.error("Knowledge base lookup failed:", error.message);
  }

  if (knowledgeBase.found > 0) {
    console.log(
      `Knowledge base: ${knowledgeBase.found} previously confirmed profile(s) ` +
        `(${knowledgeBase.created} added to this run)`
    );
    existingResults = await getExistingResults(bgvRunId);
  }

  // Platforms we already hold a profile for (confirmed earlier, or the
  // candidate supplied the link) do not need a fresh platform search.
  const knownSeeds = buildKnownProfileSeeds(candidate);

  const coveredPlatforms = [
    ...new Set([
      ...knowledgeBase.platforms,
      ...(verifiedSeeds.platforms || []),
      ...knownSeeds.map((seed) => seed.platform),
    ].filter(Boolean)),
  ];

  // -----------------------------------------
  // 4. PHASE 1 - Discovery (name + other signals)
  // -----------------------------------------

  const seenQueries = new Set();

  const effectiveCovered = platformDiscovery.getConfig().skipCovered
    ? coveredPlatforms
    : [];

  const queryPlan = { fallback: [] };
  const primaryQueries = buildSearchQueries(candidate, queryPlan);

  if (primaryQueries.length === 0) {
    throw new Error("No valid discovery queries could be generated");
  }

  const locationInfo = normalizeLocation(candidate?.location);
  if (locationInfo.conflicts.length) {
    // fixed for the queries only; the stored candidate is not modified
    console.warn(`Location input conflict repaired for search: ${locationInfo.conflicts.join("; ")}`);
  }

  let discoveryQueries = [...primaryQueries];
  console.log(`PHASE 1: ${primaryQueries.length} discovery queries`);
  primaryQueries.forEach((query) => {
    console.log(`  [discovery] ${query}`);
  });

  const phase1Pages = Number(process.env.SEARCH_DISCOVERY_PAGES) || 3;
  let discoveryResponses = await timings.time(
    "phase1Discovery",
    () => searchExternalProviders(primaryQueries, { pages: phase1Pages, seenQueries }),
    () => ({ queries: primaryQueries.length })
  );

  // Controlled scope expansion (state / country) - only when the precise
  // city-level queries returned too few usable, name-matching profiles.
  let fallbackRan = false;
  if (queryPlan.fallback.length) {
    const firstPass = mergeSearchResults(discoveryResponses.tavilyResults, discoveryResponses.serperResults);
    const enoughNeeded = Number(process.env.SEARCH_FALLBACK_MIN_PROFILES) || 5;
    const usable = countNameMatchingProfiles(firstPass, candidate?.fullName);
    if (usable < enoughNeeded) {
      fallbackRan = true;
      console.log(`PHASE 1b: only ${usable} name-matching profile URL(s) - widening to ${queryPlan.fallback.length} state/country queries`);
      const more = await timings.time("phase1bFallback", () =>
        searchExternalProviders(queryPlan.fallback, { pages: phase1Pages, seenQueries })
      );
      discoveryQueries = [...discoveryQueries, ...queryPlan.fallback];
      discoveryResponses = {
        ...discoveryResponses,
        tavilyResults: [...discoveryResponses.tavilyResults, ...more.tavilyResults],
        serperResults: [...discoveryResponses.serperResults, ...more.serperResults],
        calls: discoveryResponses.calls + more.calls,
        okCalls: discoveryResponses.okCalls + more.okCalls,
        errors: [...discoveryResponses.errors, ...more.errors],
        skippedDuplicateQueries: discoveryResponses.skippedDuplicateQueries + more.skippedDuplicateQueries,
        resultsWithoutUrl: discoveryResponses.resultsWithoutUrl + more.resultsWithoutUrl,
        urllessRecords: [...(discoveryResponses.urllessRecords || []), ...(more.urllessRecords || [])],
      };
    } else {
      console.log(`PHASE 1b skipped: ${usable} name-matching profile URL(s) already found with exact-location queries`);
    }
  }

  console.log(
    `  Tavily raw: ${discoveryResponses.tavilyResults.length} | ` +
      `Serper raw: ${discoveryResponses.serperResults.length} | ` +
      `provider calls ok: ${discoveryResponses.okCalls}/${discoveryResponses.calls}`
  );

  const discoveryMergedResults = mergeSearchResults(
    discoveryResponses.tavilyResults,
    discoveryResponses.serperResults
  );

  console.log(`  Unique discovery results: ${discoveryMergedResults.length}`);

  // -----------------------------------------
  // 5. PHASE 2 (targeted) and PHASE 3 (per-platform) are independent: Phase 3
  //    uses its own site-restricted queries and the shared `seenQueries` set
  //    prevents repeats. They run concurrently (SEARCH_PARALLEL_PHASES=false
  //    restores the old sequential order, where Phase 3 also sees Phase 2).
  // -----------------------------------------

  const queryDiagnostics = { rejected: [], errors: [], skippedResults: 0, nearDuplicatesDropped: [] };
  let targetedQueries = [];
  let targetedResponses = {
    tavilyResults: [],
    serperResults: [],
    calls: 0,
    okCalls: 0,
    errors: [],
    skippedDuplicateQueries: 0,
    resultsWithoutUrl: 0,
  };

  const runPhase2 = async () => {
    try {
      targetedQueries = buildTargetedSearchQueries(
        candidate,
        discoveryMergedResults,
        {
          // A confirmed / supplied profile does not stop fresh discovery
          // (only the opt-in PLATFORM_DISCOVERY_SKIP_COVERED=true does).
          coveredPlatforms: effectiveCovered,
          skipCoreSites: platformDiscovery.getConfig().enabled,
          diagnostics: queryDiagnostics,
        }
      );
    } catch (error) {
      // Query generation must never terminate the run.
      queryDiagnostics.errors.push(error.message);
      console.error("Targeted query generation failed (continuing):", error.message);
    }
    if (queryDiagnostics.rejected.length) {
      console.log(`  Rejected ${queryDiagnostics.rejected.length} unreliable signal(s) for targeted queries`);
    }

    if (targetedQueries.length > 0) {
      console.log(`PHASE 2: ${targetedQueries.length} targeted queries`);
      targetedQueries.forEach((query) => {
        console.log(`  [targeted] ${query}`);
      });

      targetedResponses = await timings.time("phase2Targeted", () =>
        searchExternalProviders(targetedQueries, {
          pages: Number(process.env.SEARCH_TARGETED_PAGES) || 2,
          seenQueries,
        })
      );

      console.log(
        `  Tavily raw: ${targetedResponses.tavilyResults.length} | ` +
          `Serper raw: ${targetedResponses.serperResults.length} | ` +
          `provider calls ok: ${targetedResponses.okCalls}/${targetedResponses.calls}`
      );
    } else {
      console.log("PHASE 2: no strong discovery profiles - nothing to refine");
    }
  };

  let platformRun = {
    perPlatform: {},
    tavilyResults: [],
    serperResults: [],
    callsUsed: 0,
    callBudget: 0,
  };

  const runPhase3 = async (includePhase2) => {
    if (!platformDiscovery.getConfig().enabled) return;
    platformRun = await timings.time("phase3Platforms", () =>
      platformDiscovery.runPlatformDiscovery(
        candidate,
        // verified usernames are trusted seeds (people reuse handles across platforms)
        { ...getCandidateSignals(candidate), verifiedUsernames: verifiedSeeds.usernames || [] },
        {
          rawTavily: [
            ...discoveryResponses.tavilyResults,
            ...(includePhase2 ? targetedResponses.tavilyResults : []),
          ],
          rawSerper: [
            ...discoveryResponses.serperResults,
            ...(includePhase2 ? targetedResponses.serperResults : []),
          ],
          coveredPlatforms: effectiveCovered,
          knownProfileUrls: [
            ...knownSeeds.map((seed) => seed.profileUrl),
            ...(knowledgeBase.profileUrls || []),
            ...(verifiedSeeds.profileUrls || []),
          ],
          seenQueries,
        }
      )
    );
    console.log(
      `PHASE 3: platform discovery used ${platformRun.callsUsed} provider calls`
    );
  };

  const parallelPhases = process.env.SEARCH_PARALLEL_PHASES !== "false";
  if (parallelPhases) {
    await Promise.all([runPhase2(), runPhase3(false)]);
  } else {
    await runPhase2();
    await runPhase3(true);
  }

  const platformCalls = Object.values(platformRun.perPlatform).reduce(
    (sum, r) => sum + (r.providerCalls || 0),
    0
  );
  const platformCallsOk = Object.values(platformRun.perPlatform).reduce(
    (sum, r) => sum + (r.providerCallsOk || 0),
    0
  );

  // Every raw provider hit of every phase (used for per-platform counts)
  const allRawTavily = [
    ...discoveryResponses.tavilyResults,
    ...targetedResponses.tavilyResults,
    ...platformRun.tavilyResults,
  ];
  const allRawSerper = [
    ...discoveryResponses.serperResults,
    ...targetedResponses.serperResults,
    ...platformRun.serperResults,
  ];

  // -----------------------------------------
  // 6. Merge both phases + candidate-supplied links
  // -----------------------------------------

  const apiMerged = mergeSearchResults(allRawTavily, allRawSerper);

  const knownKeys = new Set(
    knownSeeds.map((seed) => canonicalProfileKey(seed.profileUrl))
  );

  const mergedResults = [
    ...knownSeeds,
    ...apiMerged.filter(
      (result) => !knownKeys.has(canonicalProfileKey(result.profileUrl))
    ),
  ];

  console.log(`Unique results to store: ${mergedResults.length}`);

  // -----------------------------------------
  // 7. Save / update MongoDB results
  // -----------------------------------------

  const { savedResults, reusedResults, excludedResults, reuse: priorReuse } =
    await timings.time("saveResults", () =>
      saveNewResults({
        bgvRunId,
        candidateId: candidate._id,
        mergedResults,
        existingResults,
        stats: perfStats,
      })
    );

  console.log(`New results saved: ${savedResults.length}`);
  console.log(`Existing results updated/reused: ${reusedResults.length}`);

  if (excludedResults.length > 0) {
    console.log(
      `Not stored as profiles: ${excludedResults.length} ` +
        `(${[...new Set(excludedResults.map((e) => e.reason))].join(", ")})`
    );
  }

  // -----------------------------------------
  // 7b. Profile enrichment (structured public sources, best effort)
  // -----------------------------------------

  let enrichmentStats = null;

  if (process.env.SEARCH_ENRICH_PROFILES !== "false") {
    try {
      enrichmentStats = await timings.time("enrichment", () =>
        enrichRunProfiles(bgvRunId, candidate, {
          scorer: scoreDiscoveryResult,
        })
      );
      console.log(
        `Profile enrichment: ${enrichmentStats.attempted} attempted, ` +
          `${enrichmentStats.structured} structured, ` +
          `${enrichmentStats.restricted} restricted, ` +
          `${enrichmentStats.failed} failed`
      );
    } catch (error) {
      console.error("Profile enrichment failed:", error.message);
    }
  }

  // -----------------------------------------
  // 8. Profile photos (best effort, never fatal)
  // -----------------------------------------

  let imageStats = null;

  if (process.env.SEARCH_ENRICH_IMAGES !== "false") {
    try {
      imageStats = await enrichProfileImages(bgvRunId, {
        maxResults: Number(process.env.SEARCH_IMAGE_ENRICH_MAX) || 80,
      });
    } catch (error) {
      console.error("Profile photo lookup failed:", error.message);
    }
  }

  // -----------------------------------------
  // 9. FINAL complete result set + run count
  // -----------------------------------------

  const finalResults = await SearchResult.find({
    bgvRun: bgvRunId,
  })
    .sort({ createdAt: -1 })
    .lean();

  const providerCalls =
    (discoveryResponses.calls || 0) + (targetedResponses.calls || 0) + platformCalls;

  const providerCallsOk =
    (discoveryResponses.okCalls || 0) + (targetedResponses.okCalls || 0) + platformCallsOk;

  const providerErrors = [
    ...new Set([
      ...(discoveryResponses.errors || []),
      ...(targetedResponses.errors || []),
      ...Object.values(platformRun.perPlatform).flatMap((r) => r.providerErrors || []),
    ]),
  ].slice(0, 5);

  const platformsFound = [
    ...new Set(finalResults.map((r) => r.platform).filter(Boolean)),
  ];

  // Per-platform counts and statuses (discovered / unique / profile-shaped /
  // stored / enriched; "relevant" is filled in after matching).
  const storedByPlatform = {};
  for (const r of finalResults) {
    if (!r.platform || !r.profileUrl) continue;
    (storedByPlatform[r.platform] ||= []).push({
      key: canonicalProfileKey(r.profileUrl) || r.profileUrl,
      shape: platformDiscovery.hasProfileUrlShape(r.profileUrl, r.platform),
      reachability: r.enrichment?.reachability?.status || "NOT_CHECKED",
      enriched: ["ENRICHED", "PARTIAL"].includes(r.enrichment?.status),
    });
  }

  const platforms = platformDiscovery.buildPlatformSummary({
    discovery: platformRun,
    rawTavily: allRawTavily,
    rawSerper: allRawSerper,
    storedByPlatform,
    confirmedPlatforms: coveredPlatforms,
  });

  const providerMetrics = providerLayer.getMetrics();
  timings.set("providerRequests", providerMetrics.calls);
  const profileShapedCount = apiMerged.filter(
    (r) => r.profileUrl && platformDiscovery.hasProfileUrlShape(r.profileUrl, r.platform)
  ).length;
  const perfSnapshot = {
    ...timings.snapshot(),
    provider: providerMetrics,
    funnel: {
      rawResults: allRawTavily.length + allRawSerper.length,
      uniqueUrls: apiMerged.length,
      profileShapedUrls: profileShapedCount,
      stored: finalResults.length,
    },
    db: { readMs: perfStats.dbReadMs, writeMs: perfStats.dbWriteMs },
    reuse: {
      priorProfilesReused: priorReuse?.profiles || 0,
      enrichmentsReused: priorReuse?.enrichments || 0,
      knowledgeBaseProfiles: knowledgeBase.found,
      verifiedIdentities: verifiedSeeds.loaded,
    },
  };
  timings.log("search-done", { ...perfSnapshot, phasesMs: undefined, ...{ phases: perfSnapshot.phasesMs } });

  // How complete the search was. finalResult.service uses this to tell
  // "nothing relevant found" apart from "the search did not really run".
  const searchSummary = {
    discoveryQueries: discoveryQueries.length,
    targetedQueries: targetedQueries.length,
    queryDiagnostics: {
      rejectedSignals: queryDiagnostics.rejected.slice(0, 50),
      rejectedSignalCount: queryDiagnostics.rejected.length,
      skippedResults: queryDiagnostics.skippedResults,
      nearDuplicatesDropped: queryDiagnostics.nearDuplicatesDropped.slice(0, 50),
      errors: queryDiagnostics.errors.slice(0, 10),
    },
    providerCalls,
    providerCallsOk,
    providerErrors,
    platformsFound,
    knowledgeBaseProfiles: knowledgeBase.found,
    verifiedIdentities: {
      loaded: verifiedSeeds.loaded,
      addedToRun: verifiedSeeds.created,
      alreadyInRun: verifiedSeeds.alreadyPresent,
      importedFromEarlierDecisions: verifiedSeeds.backfilled,
      platforms: verifiedSeeds.platforms,
    },
    platformTarget: platformDiscovery.getConfig().target,
    platformCallsUsed: platformRun.callsUsed,
    platformCallBudget: platformRun.callBudget,
    platformLogicalRequests: platformRun.logicalRequests,
    platformRetryAttempts: platformRun.retryAttempts,
    platforms,
    enrichment: enrichmentStats,
    location: {
      used: { city: locationInfo.city, state: locationInfo.state, country: locationInfo.country },
      corrections: locationInfo.corrections,
      conflicts: locationInfo.conflicts,
    },
    fallbackQueriesRan: fallbackRan,
    timings: perfSnapshot,
    // Results without a usable profile URL are not turned into fake
    // profiles; their title/snippet is kept here for audit.
    excludedRecords: [
      ...excludedResults,
      ...(discoveryResponses.urllessRecords || []),
      ...(targetedResponses.urllessRecords || []),
    ].slice(0, 100).map((e) => ({
      ...e,
      retrievedAt: new Date(),
    })),
    completedAt: new Date(),
  };

  await BgvRun.findByIdAndUpdate(bgvRunId, {
    totalSearchResults: finalResults.length,
    searchSummary,
  });

  // -----------------------------------------
  // 10. Return everything
  // -----------------------------------------

  const allQueries = uniqueQueries([
    ...discoveryQueries,
    ...targetedQueries,
  ]);

  const stats = {
    platformSummary: Object.fromEntries(
      Object.entries(platforms).map(([k, v]) => [k, v.status])
    ),
    existingBeforeSearch: existingResults.length,
    discoveryQueries: discoveryQueries.length,
    targetedQueries: targetedQueries.length,
    skippedDuplicateQueries:
      (discoveryResponses.skippedDuplicateQueries || 0) +
      (targetedResponses.skippedDuplicateQueries || 0),
    tavilyRaw: allRawTavily.length,
    serperRaw: allRawSerper.length,
    uniqueApiResults: mergedResults.length,
    newResults: savedResults.length,
    reusedOrUpdatedResults: reusedResults.length,
    excludedResults: excludedResults.length,
    excludedReasons: excludedResults.reduce((acc, e) => {
      acc[e.reason] = (acc[e.reason] || 0) + 1;
      return acc;
    }, {}),
    providerResultsWithoutUrl:
      (discoveryResponses.resultsWithoutUrl || 0) +
      (targetedResponses.resultsWithoutUrl || 0),
    providerCalls,
    providerCallsOk,
    providerErrors,
    coveredPlatforms,
    knowledgeBase: {
      found: knowledgeBase.found,
      addedToRun: knowledgeBase.created,
      platforms: knowledgeBase.platforms,
    },
    images: imageStats,
    finalTotalResults: finalResults.length,
  };

  return {
    candidateId,
    bgvRunId,
    searchedExternally: true,
    totalResults: finalResults.length,
    newResults: savedResults.length,
    updatedResults: reusedResults.length,
    priorProfilesReused: priorReuse?.profiles || 0,
    verifiedIdentities: {
      loaded: verifiedSeeds.loaded,
      addedToRun: verifiedSeeds.created,
      alreadyInRun: verifiedSeeds.alreadyPresent,
      importedFromEarlierDecisions: verifiedSeeds.backfilled,
    },
    timings: perfSnapshot,
    queries: allQueries,
    discoveryQueries,
    targetedQueries,
    knowledgeBase,
    searchSummary,
    stats,
    results: finalResults,
  };
};

module.exports = {

  searchCandidate,

  buildSearchQueries,
  buildKnownProfileSeeds,
  buildTargetedSearchQueries,

  getExistingResults,

  searchExternalProviders,

  saveNewResults,

  createExistingUrlMap,

  mergeImageUrls,

  mergeProviderResults,

  updateExistingResult,

};