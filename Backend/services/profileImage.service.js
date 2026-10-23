"use strict";

const axios = require("axios");
const SearchResult = require("../models/SearchResult");

/**
 * Finds a real profile photo for every discovered profile, so the human
 * reviewer (and later a face-comparison step) has something to look at.
 *
 *   GitHub     -> https://github.com/<user>.png          (always works)
 *   any page   -> its <meta property="og:image">         (public pages)
 *   fallback   -> unavatar.io/<platform>/<user>          (Instagram, X, ...)
 *
 * LinkedIn blocks server-side page fetches, so it usually only gets an
 * image when the search provider already returned one.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// Do not let a search result make our server call internal addresses.
const isSafePublicUrl = (value) => {
  try {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1)/.test(h)) return false;
    return true;
  } catch (e) {
    return false;
  }
};

const GENERIC_IMAGE = /(logo|favicon|default|placeholder|sprite|blank|og-image-default|static\.licdn\.com\/aero)/i;

const absolute = (src, base) => {
  try {
    return new URL(src, base).toString();
  } catch (e) {
    return null;
  }
};

const extractOgImage = (html, pageUrl) => {
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const url = absolute(m[1].replace(/&amp;/g, "&"), pageUrl);
      if (url && !GENERIC_IMAGE.test(url)) return url;
    }
  }
  return null;
};

const fetchOgImage = async (pageUrl, timeout) => {
  if (!isSafePublicUrl(pageUrl)) return null;
  try {
    const res = await axios.get(pageUrl, {
      timeout,
      maxContentLength: 1024 * 1024,
      maxRedirects: 3,
      responseType: "text",
      headers: { "User-Agent": UA, Accept: "text/html" },
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return typeof res.data === "string" ? extractOgImage(res.data, pageUrl) : null;
  } catch (e) {
    return null;
  }
};

const UNAVATAR = {
  INSTAGRAM: "instagram",
  TWITTER: "x",
  GITHUB: "github",
  YOUTUBE: "youtube",
  REDDIT: "reddit",
  PINTEREST: "pinterest",
};

const unavatarUrl = async (platform, username, timeout) => {
  const provider = UNAVATAR[platform];
  if (!provider || !username) return null;
  const url = `https://unavatar.io/${provider}/${encodeURIComponent(username)}?fallback=false`;
  try {
    const res = await axios.head(url, { timeout, maxRedirects: 3, validateStatus: (s) => s === 200 });
    return res.status === 200 ? url : null;
  } catch (e) {
    return null;
  }
};

const findImageFor = async (sr, timeout) => {
  if (sr.platform === "GITHUB" && sr.username) {
    return `https://github.com/${encodeURIComponent(sr.username)}.png?size=400`;
  }
  const og = await fetchOgImage(sr.profileUrl, timeout);
  if (og) return og;
  return unavatarUrl(sr.platform, sr.username, timeout);
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
          /* one failure must never stop the rest */
        }
      }
    })
  );
};

/**
 * @param {string} bgvRunId
 * @param {{ maxResults?: number, concurrency?: number, timeout?: number, force?: boolean }} opts
 */
const enrichProfileImages = async (bgvRunId, opts = {}) => {
  const { maxResults = 80, concurrency = 6, timeout = 6000, force = false } = opts;

  const filter = { bgvRun: bgvRunId, profileUrl: { $exists: true, $ne: null } };
  if (!force) filter.$or = [{ profileImageUrl: null }, { profileImageUrl: "" }, { profileImageUrl: { $exists: false } }];

  // Real profile platforms first, generic websites last
  const docs = await SearchResult.find(filter).limit(maxResults * 2);
  docs.sort((a, b) => (a.platform === "WEBSITE") - (b.platform === "WEBSITE"));
  const todo = docs.slice(0, maxResults);

  let found = 0;
  await runPool(todo, concurrency, async (sr) => {
    const image = await findImageFor(sr, timeout);
    if (!image) return;
    sr.profileImageUrl = image;
    sr.profileImageUrls = [...new Set([image, ...(sr.profileImageUrls || [])])];
    await sr.save();
    found += 1;
  });

  return { checked: todo.length, found };
};

module.exports = { enrichProfileImages, extractOgImage, isSafePublicUrl };
