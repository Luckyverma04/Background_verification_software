"use strict";

/**
 * profileEnrichment.service.js
 *
 * Retrieves MORE reliable information about a promising profile than the
 * search-result snippet contains. It is deliberately separate from
 * profileImage.service.js (an image URL is not enrichment).
 *
 * Sources used (public / authorised only):
 *   GITHUB_API        public REST API  GET https://api.github.com/users/<user>
 *   PUBLIC_PAGE_META  <meta>/Open Graph/JSON-LD Person of a public page
 *                     (personal websites, portfolios, ...)
 *   SEARCH_SNIPPET    what the search provider already returned
 *
 * NOT fetched (login-walled; we never bypass authentication / CAPTCHAs):
 *   LinkedIn, Facebook, Instagram, X/Twitter. For these the record says so
 *   in `limitations` and only provider-supplied data is used.
 *
 * Honesty rules
 *   - Nothing is invented. A field that no source supplied is UNKNOWN.
 *   - Existing values are never overwritten, only empty fields are filled.
 *   - Snippet text is stored as a snippet, never promoted to a "bio".
 *   - UNKNOWN (no data) is kept distinct from a conflict (handled by the
 *     matching layer, which compares only fields that exist).
 */

const axios = require("axios");
const SearchResult = require("../models/SearchResult");
const { isSafePublicUrl } = require("./profileImage.service");
const { normalizeUrl, detectPlatform } = require("./resultMerge.service");
const { canonicalProfileKey } = require("../utils/candidateUrls");

const UA =
  "Mozilla/5.0 (compatible; BGV-Verification/1.0; +public-profile-lookup)";

const RESTRICTED_PLATFORMS = new Set([
  "LINKEDIN",
  "FACEBOOK",
  "INSTAGRAM",
  "TWITTER",
  "X",
]);

const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/\s+/g, " ").trim());

// ---------------------------------------------------------------------
// Completeness  (information quantity - NOT identity relevance)
// ---------------------------------------------------------------------

const COMPLETENESS_FIELDS = [
  "headline",
  "company",
  "jobTitle",
  "location",
  "education",
  "bio",
  "previousEmployers",
  "linkedProfiles",
  "username",
  "profileImage",
];

const hasLocation = (l) => !!(l && (clean(l.city) || clean(l.state) || clean(l.country)));
const hasEducation = (e) =>
  Array.isArray(e) && e.some((x) => x && (clean(x.institution) || clean(x.degree)));

const fieldPresence = (sr) => ({
  headline: !!clean(sr?.headline),
  company: !!clean(sr?.company),
  jobTitle: !!clean(sr?.jobTitle),
  location: hasLocation(sr?.location),
  education: hasEducation(sr?.education),
  bio: !!clean(sr?.bio),
  previousEmployers: Array.isArray(sr?.previousEmployers) && sr.previousEmployers.length > 0,
  linkedProfiles: Array.isArray(sr?.linkedProfiles) && sr.linkedProfiles.length > 0,
  username: !!clean(sr?.username),
  profileImage: !!clean(sr?.profileImageUrl) || (Array.isArray(sr?.profileImageUrls) && sr.profileImageUrls.length > 0),
});

/**
 * How much useful information a stored profile holds. Works on any
 * SearchResult (old records too). This is NOT a relevance score: a very
 * detailed profile can belong to a different person.
 */
const computeCompleteness = (sr) => {
  const presence = fieldPresence(sr);
  const availableFields = COMPLETENESS_FIELDS.filter((f) => presence[f]);
  const missingFields = COMPLETENESS_FIELDS.filter((f) => !presence[f]);
  const structured = (sr?.enrichment?.sources || []).some(
    (s) => s.ok && s.type !== "SEARCH_SNIPPET"
  );

  return {
    score: Math.round((availableFields.length / COMPLETENESS_FIELDS.length) * 100),
    available: availableFields.length,
    total: COMPLETENESS_FIELDS.length,
    availableFields,
    missingFields,
    // where the data came from; kept apart from the score on purpose
    sourceQuality: structured ? "STRUCTURED_SOURCE" : "SEARCH_SNIPPET_ONLY",
  };
};

// ---------------------------------------------------------------------
// Snippet-derived signals (conservative regexes, no guessing)
// ---------------------------------------------------------------------

const PREV_PATTERNS = [
  /\b(?:previously|formerly|ex[-\s]?|past)\s*(?:at|with|:)?\s+([A-Z][\w&.\-]*(?:\s+[A-Z][\w&.\-]*){0,3})/g,
];

const extractPreviousEmployers = (text) => {
  const out = [];
  const seen = new Set();
  for (const re of PREV_PATTERNS) {
    let m;
    while ((m = re.exec(text))) {
      const company = clean(m[1]).replace(/[.,;|]+$/, "");
      const key = company.toLowerCase();
      if (company.length >= 2 && !seen.has(key)) {
        seen.add(key);
        out.push({ company, title: null, startDate: null, endDate: null });
      }
    }
  }
  return out.slice(0, 5);
};

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/gi;

const extractLinks = (text, selfUrl) => {
  const selfKey = canonicalProfileKey(selfUrl) || "";
  const out = [];
  const seen = new Set();
  for (const raw of String(text || "").match(URL_RE) || []) {
    const url = normalizeUrl(raw.replace(/[.,;]+$/, ""));
    if (!url || !isSafePublicUrl(url)) continue;
    const key = canonicalProfileKey(url) || url;
    if (key === selfKey || seen.has(key)) continue;
    seen.add(key);
    out.push({ platform: detectPlatform(url) || "WEBSITE", url });
  }
  return out.slice(0, 8);
};

// ---------------------------------------------------------------------
// Structured sources
// ---------------------------------------------------------------------

const splitLocation = (value) => {
  const parts = clean(value).split(",").map(clean).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { city: parts[0], state: null, country: null };
  if (parts.length === 2) return { city: parts[0], state: null, country: parts[1] };
  return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
};

const fetchGithubUser = async (username, { timeout = 8000 } = {}) => {
  const src = {
    type: "GITHUB_API",
    url: `https://api.github.com/users/${encodeURIComponent(username)}`,
    retrievedAt: new Date(),
    ok: false,
  };
  try {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": UA };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await axios.get(src.url, { timeout, headers, validateStatus: () => true });
    src.httpStatus = res.status;
    if (res.status === 200 && res.data && typeof res.data === "object") {
      src.ok = true;
      const d = res.data;
      return {
        source: src,
        data: {
          displayName: clean(d.name) || null,
          bio: clean(d.bio) || null,
          company: clean(d.company).replace(/^@/, "") || null,
          location: splitLocation(d.location),
          imageUrl: clean(d.avatar_url) || null,
          links: [
            d.blog ? clean(d.blog) : null,
            d.twitter_username ? `https://x.com/${clean(d.twitter_username)}` : null,
          ].filter(Boolean),
        },
      };
    }
    if (res.status === 404) return { source: src, limitation: "GITHUB_USER_NOT_FOUND" };
    if (res.status === 403 || res.status === 429) return { source: src, limitation: "GITHUB_RATE_LIMITED" };
    return { source: src, limitation: `GITHUB_HTTP_${res.status}` };
  } catch (e) {
    src.error = e.code || "REQUEST_FAILED";
    return { source: src, limitation: "GITHUB_UNREACHABLE" };
  }
};

const metaContent = (html, attr, name) => {
  const a = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*content=["']([^"']*)["']`, "i");
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${name}["']`, "i");
  const m = html.match(a) || html.match(b);
  return m ? clean(m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")) : "";
};

const parseJsonLdPerson = (html) => {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of blocks) {
    const body = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      continue;
    }
    const nodes = [].concat(json, json?.["@graph"] || []);
    for (const n of nodes) {
      const type = [].concat(n?.["@type"] || []).join(",");
      if (/Person/i.test(type)) return n;
    }
  }
  return null;
};

const asName = (v) =>
  typeof v === "string" ? clean(v) : clean(v?.name) || "";

const fetchPageMeta = async (pageUrl, { timeout = 8000 } = {}) => {
  const src = { type: "PUBLIC_PAGE_META", url: pageUrl, retrievedAt: new Date(), ok: false };
  if (!isSafePublicUrl(pageUrl)) return { source: src, limitation: "UNSAFE_OR_PRIVATE_URL" };

  try {
    const res = await axios.get(pageUrl, {
      timeout,
      maxContentLength: 1024 * 1024,
      maxRedirects: 3,
      responseType: "text",
      headers: { "User-Agent": UA, Accept: "text/html" },
      validateStatus: () => true,
    });
    src.httpStatus = res.status;
    if (res.status !== 200 || typeof res.data !== "string") {
      return { source: src, limitation: `PAGE_HTTP_${res.status}` };
    }

    const html = res.data;
    src.ok = true;

    const person = parseJsonLdPerson(html);
    const description =
      clean(person?.description) ||
      metaContent(html, "property", "og:description") ||
      metaContent(html, "name", "description") ||
      "";

    const alumni = []
      .concat(person?.alumniOf || [])
      .map(asName)
      .filter(Boolean)
      .map((institution) => ({ institution, degree: null, fieldOfStudy: null }));

    const address = person?.address;
    const loc =
      typeof address === "string"
        ? splitLocation(address)
        : address
        ? {
            city: clean(address.addressLocality) || null,
            state: clean(address.addressRegion) || null,
            country: clean(address.addressCountry?.name || address.addressCountry) || null,
          }
        : null;

    return {
      source: src,
      data: {
        displayName: clean(person?.name) || null,
        bio: description || null,
        headline: metaContent(html, "property", "og:title") || null,
        company: asName(person?.worksFor) || null,
        jobTitle: clean(person?.jobTitle) || null,
        location: loc && hasLocation(loc) ? loc : null,
        education: alumni,
        imageUrl: asName(person?.image?.url || person?.image) || metaContent(html, "property", "og:image") || null,
        links: [].concat(person?.sameAs || []).map(clean).filter(Boolean),
      },
    };
  } catch (e) {
    src.error = e.code || "REQUEST_FAILED";
    return { source: src, limitation: "PAGE_UNREACHABLE" };
  }
};

// ---------------------------------------------------------------------
// Merge into a SearchResult document (fill empty fields only)
// ---------------------------------------------------------------------

const snippetText = (sr) =>
  [sr.headline, sr.rawData?.title, sr.rawData?.snippet, sr.rawData?.content]
    .map(clean)
    .filter(Boolean)
    .join(" | ");

/**
 * Reachability is what a REAL request returned - never inferred from the URL
 * shape. NOT_CHECKED means no request was made (login-walled platform,
 * nothing requested) or the answer was inconclusive (rate limit / bot block).
 */
const reachabilityOf = (sr, results) => {
  const attempt = results.find((r) => r.source);
  const platform = String(sr.platform || "").toUpperCase();

  if (!attempt) {
    return {
      status: "NOT_CHECKED",
      reason: RESTRICTED_PLATFORMS.has(platform) ? "LOGIN_WALLED_PLATFORM_NOT_REQUESTED" : "NOT_REQUESTED",
    };
  }

  const { ok, httpStatus, retrievedAt, type, error } = attempt.source;
  const base = { checkedAt: retrievedAt, method: type, httpStatus: httpStatus || null };

  if (ok) return { ...base, status: "REACHABLE" };
  if (httpStatus === 404 || httpStatus === 410) return { ...base, status: "NOT_FOUND" };
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
    return { ...base, status: "NOT_CHECKED", reason: "ACCESS_RESTRICTED_OR_RATE_LIMITED" };
  }
  return { ...base, status: "UNREACHABLE", reason: error || (httpStatus ? `HTTP_${httpStatus}` : "REQUEST_FAILED") };
};

/**
 * Pure helper: builds the enrichment record + the field updates for one
 * profile from whatever sources returned. Exported for tests.
 */
const buildEnrichment = (sr, results) => {
  const sources = [];
  const limitations = [];
  const updates = {};

  const structured = results.filter((r) => r.data);
  for (const r of results) {
    if (r.source) sources.push(r.source);
    if (r.limitation) limitations.push(r.limitation);
  }

  // ---- snippet-derived (always available, lowest trust)
  const text = snippetText(sr);
  sources.push({
    type: "SEARCH_SNIPPET",
    provider: sr.searchProvider || null,
    url: sr.sourceUrl || sr.profileUrl || null,
    retrievedAt: sr.discoveredAt || new Date(),
    ok: !!text,
  });

  const prev = extractPreviousEmployers(text);
  const links = extractLinks(text, sr.profileUrl);

  // ---- structured values (take the first non-empty per field)
  // fieldSources: where each filled field came from + how far to trust it.
  // GITHUB_API is the platform's own API (HIGH); page meta/JSON-LD is
  // self-published but unverified (MEDIUM); a search snippet is LOW.
  const CONFIDENCE = { GITHUB_API: "HIGH", PUBLIC_PAGE_META: "MEDIUM" };
  const fieldSources = {};
  const pickedFrom = {};
  const pick = (key) => {
    for (const r of structured) {
      if (r.data[key]) {
        pickedFrom[key] = r.source?.type || null;
        return r.data[key];
      }
    }
    return null;
  };
  const noteSource = (field, key = field) => {
    if (updates[field] === undefined) return;
    const type = pickedFrom[key];
    fieldSources[field] = { source: type, confidence: CONFIDENCE[type] || "LOW" };
  };

  // A structured public source (API / JSON-LD) is more trustworthy than a
  // value guessed from a search snippet, so it may replace a snippet-derived
  // company / title. Values from a human or from the knowledge base
  // (source MANUAL / KNOWLEDGE_BASE) are never replaced. Every replacement
  // is recorded in enrichment.overridden.
  const overridden = [];
  const snippetDerived = !["MANUAL", "KNOWLEDGE_BASE"].includes(sr.source);

  const maybeSet = (field, value, present, canOverride = false) => {
    if (!value) return;
    if (!present) {
      updates[field] = value;
    } else if (canOverride && snippetDerived && clean(sr[field]).toLowerCase() !== clean(value).toLowerCase()) {
      overridden.push({ field, from: sr[field], to: value });
      updates[field] = value;
    }
  };

  maybeSet("bio", pick("bio"), !!clean(sr.bio));
  maybeSet("company", pick("company"), !!clean(sr.company), true);
  maybeSet("jobTitle", pick("jobTitle"), !!clean(sr.jobTitle), true);
  maybeSet("headline", pick("headline"), !!clean(sr.headline));
  maybeSet("name", pick("displayName"), !!clean(sr.name));

  noteSource("bio"); noteSource("company"); noteSource("jobTitle"); noteSource("headline"); noteSource("name", "displayName");

  const loc = pick("location");
  if (loc && !hasLocation(sr.location)) updates.location = loc;
  noteSource("location");

  const edu = structured.map((r) => r.data.education).find((e) => Array.isArray(e) && e.length);
  if (edu && !hasEducation(sr.education)) updates.education = edu;

  const imageUrls = structured.map((r) => r.data.imageUrl).filter(Boolean);
  if (imageUrls.length) {
    updates.profileImageUrls = [...new Set([...(sr.profileImageUrls || []), ...imageUrls])];
    if (!clean(sr.profileImageUrl)) updates.profileImageUrl = imageUrls[0];
  }

  const structuredLinks = structured
    .flatMap((r) => r.data.links || [])
    .map((u) => normalizeUrl(u))
    .filter((u) => u && isSafePublicUrl(u))
    .map((url) => ({ platform: detectPlatform(url) || "WEBSITE", url }));

  const mergedLinks = [];
  const seenLinks = new Set();
  for (const l of [...(sr.linkedProfiles || []), ...structuredLinks, ...links]) {
    if (!l || !l.url || seenLinks.has(l.url)) continue;
    seenLinks.add(l.url);
    mergedLinks.push({ platform: l.platform, url: l.url });
  }
  if (mergedLinks.length > (sr.linkedProfiles || []).length) updates.linkedProfiles = mergedLinks.slice(0, 10);

  if (prev.length && !(sr.previousEmployers || []).length) {
    updates.previousEmployers = prev;
    fieldSources.previousEmployers = { source: "SEARCH_SNIPPET", confidence: "LOW" };
  }
  if (updates.education) { pickedFrom.education = structured.find((r) => Array.isArray(r.data.education) && r.data.education.length)?.source?.type || null; noteSource("education"); }
  if (updates.linkedProfiles) fieldSources.linkedProfiles = { source: structuredLinks.length ? "PUBLIC_PAGE_META" : "SEARCH_SNIPPET", confidence: structuredLinks.length ? "MEDIUM" : "LOW" };

  // restricted platform: say so explicitly
  if (RESTRICTED_PLATFORMS.has(String(sr.platform).toUpperCase())) {
    limitations.push("PLATFORM_RESTRICTED_NO_LOGINLESS_FETCH");
  }
  if (!structured.length) limitations.push("ONLY_SEARCH_RESULT_DATA");

  // Employment dates / education details are never inferred from snippets
  limitations.push("EMPLOYMENT_DATES_UNKNOWN_UNLESS_SOURCE_STATES_THEM");

  const merged = { ...sr, ...updates };
  const completeness = computeCompleteness({
    ...merged,
    enrichment: { sources },
  });

  // HTTP success is not the same as useful data: a page that answered 200
  // but yielded no field is NO_USEFUL_FIELDS, not "enriched".
  const fetched = results.some((r) => r.source?.ok);
  const usefulFields = Object.keys(fieldSources).filter((f) => fieldSources[f].confidence !== "LOW");
  const status = !structured.length
    ? RESTRICTED_PLATFORMS.has(String(sr.platform).toUpperCase())
      ? "RESTRICTED"
      : fetched ? "NO_USEFUL_FIELDS" : "SNIPPET_ONLY"
    : !usefulFields.length && !Object.keys(updates).length
      ? "NO_USEFUL_FIELDS"
      : completeness.missingFields.length ? "PARTIAL" : "ENRICHED";

  return {
    updates,
    enrichment: {
      status,
      attemptedAt: new Date(),
      sources,
      limitations: [...new Set(limitations)],
      reachability: reachabilityOf(sr, results),
      overridden,
      fieldSources,
      // UNKNOWN != conflicting: these were simply not available
      fields: Object.fromEntries(
        COMPLETENESS_FIELDS.map((f) => [f, completeness.availableFields.includes(f) ? "AVAILABLE" : "UNKNOWN"])
      ),
      missingFields: completeness.missingFields,
      completeness: {
        score: completeness.score,
        available: completeness.available,
        total: completeness.total,
        sourceQuality: completeness.sourceQuality,
      },
    },
  };
};

const enrichOne = async (sr, { timeout }) => {
  const results = [];
  const platform = String(sr.platform || "").toUpperCase();

  if (platform === "GITHUB" && sr.username) {
    results.push(await fetchGithubUser(sr.username, { timeout }));
  } else if (!RESTRICTED_PLATFORMS.has(platform) && sr.profileUrl) {
    results.push(await fetchPageMeta(sr.profileUrl, { timeout }));
  }

  const { updates, enrichment } = buildEnrichment(sr.toObject ? sr.toObject() : sr, results);

  await SearchResult.updateOne(
    { _id: sr._id },
    { $set: { ...updates, enrichment } }
  );

  return enrichment;
};

const runPool = async (items, concurrency, worker) => {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        try {
          await worker(item);
        } catch (e) {
          /* one failure never stops the rest */
        }
      }
    })
  );
};

/**
 * Enrich the most promising stored profiles of a run.
 *
 * Promising = the (injected) pre-scorer finds the candidate's name plus
 * at least a minimal score. Namesake-looking junk is not enriched, so
 * the request budget goes to profiles worth a reviewer's time.
 * Idempotent: profiles already attempted are skipped unless force=true.
 */
const enrichRunProfiles = async (bgvRunId, candidate, opts = {}) => {
  const {
    maxProfiles = Number(process.env.SEARCH_ENRICH_MAX) || 40,
    concurrency = Number(process.env.SEARCH_ENRICH_CONCURRENCY) || 8,
    timeout = Number(process.env.SEARCH_ENRICH_TIMEOUT_MS) || 8000,
    minScore = 40,
    scorer,
    force = false,
  } = opts;

  const filter = { bgvRun: bgvRunId, profileUrl: { $exists: true, $ne: null } };
  // previously verified profiles are known identities: their stored data is
  // reused, not fetched again
  filter["rawData.verifiedIdentity"] = { $exists: false };
  const ttlDays = Math.max(Number(process.env.ENRICH_TTL_DAYS ?? 7) || 0, 0);
  if (!force) {
    // never attempted, or attempted long ago (stale). A profile enriched
    // (or reused from an earlier run) within the TTL is NOT fetched again.
    // RESTRICTED rows have nothing to fetch, so staleness does not apply.
    const staleBefore = new Date(Date.now() - ttlDays * 86400000);
    filter.$or = [
      { "enrichment.attemptedAt": { $exists: false } },
      ...(ttlDays > 0
        ? [{ "enrichment.attemptedAt": { $lt: staleBefore }, "enrichment.status": { $ne: "RESTRICTED" } }]
        : []),
    ];
  }

  const t0 = Date.now();
  const docs = await SearchResult.find(filter).limit(500);

  const missingCount = (doc) => (doc.enrichment?.missingFields ? doc.enrichment.missingFields.length : COMPLETENESS_FIELDS.length);
  const isRestricted = (doc) => RESTRICTED_PLATFORMS.has(String(doc.platform || "").toUpperCase());

  const scored = docs
    .map((doc) => ({ doc, score: scorer ? scorer(candidate, doc.toObject()) : minScore }))
    .filter((x) => x.score >= minScore)
    // most promising first; at equal promise the profile with MORE missing
    // fields gains most from enrichment (completeness never ranks identity)
    .sort((a, b) => b.score - a.score || missingCount(b.doc) - missingCount(a.doc));

  // Login-walled platforms are never fetched, so they do not use up the
  // fetch budget (they only get their "RESTRICTED" audit record).
  const fetchable = scored.filter((x) => !isRestricted(x.doc)).slice(0, maxProfiles);
  const restricted = scored.filter((x) => isRestricted(x.doc)).slice(0, Number(process.env.SEARCH_ENRICH_MAX_RESTRICTED) || 100);
  const ranked = [...fetchable, ...restricted];

  const stats = {
    considered: docs.length,
    attempted: ranked.length,
    fetchAttempted: fetchable.length,
    structured: 0,
    restricted: 0,
    snippetOnly: 0,
    noUsefulFields: 0,
    failed: 0,
    ms: 0,
  };

  await runPool(ranked, concurrency, async ({ doc }) => {
    try {
      const e = await enrichOne(doc, { timeout });
      if (e.status === "RESTRICTED") stats.restricted += 1;
      else if (e.status === "SNIPPET_ONLY") stats.snippetOnly += 1;
      else if (e.status === "NO_USEFUL_FIELDS") stats.noUsefulFields += 1;
      else stats.structured += 1;
    } catch (err) {
      stats.failed += 1;
    }
  });

  stats.ms = Date.now() - t0;
  return stats;
};

module.exports = {
  enrichRunProfiles,
  buildEnrichment,
  computeCompleteness,
  fetchGithubUser,
  fetchPageMeta,
  COMPLETENESS_FIELDS,
};
