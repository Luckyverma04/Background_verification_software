"use strict";

/**
 * The Candidate model stores social links as flat fields
 * (candidate.linkedin, candidate.github, ...). Older code read a
 * non-existent `candidate.socialUrls` object, so known profile URLs were
 * never searched and never counted as a DIRECT match.
 *
 * This helper is the single place that reads them. It still honours a
 * `socialUrls` object if one ever exists.
 */

const SOCIAL_KEYS = [
  "linkedin",
  "github",
  "twitter",
  "instagram",
  "facebook",
  "website",
];

const clean = (v) => (typeof v === "string" ? v.trim() : "");

// Add https:// when the user typed "linkedin.com/in/x"
const withProtocol = (url) => {
  const u = clean(url);
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
};

const getCandidateSocialUrls = (candidate) => {
  const source = candidate?.toObject ? candidate.toObject() : candidate || {};
  const nested = source.socialUrls || {};
  const out = {};

  for (const key of SOCIAL_KEYS) {
    const value = withProtocol(source[key] || nested[key]);
    if (value) out[key] = value;
  }

  return out;
};

/**
 * Canonical key for comparing profile URLs, so these all match:
 *   https://www.linkedin.com/in/Rahul-Sharma/
 *   http://in.linkedin.com/in/rahul-sharma?trk=x
 *   https://twitter.com/rahul  ==  https://x.com/rahul
 */
const canonicalProfileKey = (url) => {
  const raw = withProtocol(url);
  if (!raw) return null;

  try {
    const u = new URL(raw);
    let host = u.hostname.toLowerCase();
    // strip www / m / country subdomains, but never turn "fb.com" into "com"
    if (host.split(".").length > 2) {
      host = host.replace(/^(www|m|mobile|[a-z]{2})\./, "");
    }
    if (host === "twitter.com") host = "x.com";
    if (host.endsWith("linkedin.com")) host = "linkedin.com";
    if (host === "fb.com") host = "facebook.com";

    const path = u.pathname.replace(/\/+$/, "").toLowerCase();

    // Facebook profile.php?id=123 is identified by its query string
    const keep =
      host === "facebook.com" && path === "/profile.php"
        ? `?id=${u.searchParams.get("id") || ""}`
        : "";

    return `${host}${path}${keep}`;
  } catch (e) {
    return raw.toLowerCase();
  }
};

module.exports = {
  getCandidateSocialUrls,
  canonicalProfileKey,
  SOCIAL_KEYS,
  withProtocol,
};
