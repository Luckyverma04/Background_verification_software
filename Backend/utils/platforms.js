"use strict";

/**
 * Every platform the BGV search looks at.
 *
 *  key      stored in SearchResult.platform
 *  hosts    hostnames (suffix match) used to detect the platform from a URL
 *  site     what goes after `site:` in a search query
 *  domain   what is passed to Tavily's include_domains
 *  pathHint regex a URL path must match to look like a PERSON's profile
 *           (used to prefer real profile pages over posts / articles)
 *  idFrom   how to read the username out of the path segments
 *  core     true = searched with extra queries (name+company, name+city)
 */
const PLATFORMS = [
  // group: CORE = always searched, TECH / DESIGN / RESEARCH = only when the
  // candidate's profile makes that platform useful, OTHER = only when a
  // discovered profile already points to it.
  // needs: "data" = only for data / ML profiles (Kaggle, Hugging Face)
  { key: "LINKEDIN", group: "CORE", hosts: ["linkedin.com"], site: "linkedin.com/in", domain: "linkedin.com", core: true },
  { key: "GITHUB", group: "CORE", hosts: ["github.com"], site: "github.com", domain: "github.com", core: true },
  { key: "TWITTER", group: "CORE", hosts: ["x.com", "twitter.com"], site: "x.com", domain: "x.com", core: true, alt: [{ site: "twitter.com", domain: "twitter.com" }] },
  { key: "INSTAGRAM", group: "CORE", hosts: ["instagram.com"], site: "instagram.com", domain: "instagram.com", core: true },
  { key: "FACEBOOK", group: "CORE", hosts: ["facebook.com", "fb.com"], site: "facebook.com", domain: "facebook.com", core: true },

  { key: "GITLAB", group: "TECH", hosts: ["gitlab.com"], site: "gitlab.com", domain: "gitlab.com" },
  { key: "BITBUCKET", group: "TECH", hosts: ["bitbucket.org"], site: "bitbucket.org", domain: "bitbucket.org" },
  { key: "STACKOVERFLOW", group: "TECH", hosts: ["stackoverflow.com"], site: "stackoverflow.com/users", domain: "stackoverflow.com" },
  { key: "LEETCODE", group: "TECH", hosts: ["leetcode.com"], site: "leetcode.com", domain: "leetcode.com" },
  { key: "HACKERRANK", group: "TECH", hosts: ["hackerrank.com"], site: "hackerrank.com", domain: "hackerrank.com" },
  { key: "DEVTO", group: "TECH", hosts: ["dev.to"], site: "dev.to", domain: "dev.to" },
  { key: "MEDIUM", group: "TECH", hosts: ["medium.com"], site: "medium.com", domain: "medium.com" },
  { key: "HASHNODE", group: "TECH", hosts: ["hashnode.com"], site: "hashnode.com", domain: "hashnode.com" },
  { key: "PEERLIST", group: "TECH", hosts: ["peerlist.io"], site: "peerlist.io", domain: "peerlist.io" },
  { key: "CODEPEN", group: "TECH", hosts: ["codepen.io"], site: "codepen.io", domain: "codepen.io" },
  { key: "CODECHEF", group: "TECH", hosts: ["codechef.com"], site: "codechef.com/users", domain: "codechef.com" },
  { key: "KAGGLE", group: "TECH", needs: "data", hosts: ["kaggle.com"], site: "kaggle.com", domain: "kaggle.com" },
  { key: "HUGGINGFACE", group: "TECH", needs: "data", hosts: ["huggingface.co"], site: "huggingface.co", domain: "huggingface.co" },

  { key: "BEHANCE", group: "DESIGN", hosts: ["behance.net"], site: "behance.net", domain: "behance.net" },
  { key: "DRIBBBLE", group: "DESIGN", hosts: ["dribbble.com"], site: "dribbble.com", domain: "dribbble.com" },

  { key: "RESEARCHGATE", group: "RESEARCH", hosts: ["researchgate.net"], site: "researchgate.net/profile", domain: "researchgate.net" },
  { key: "ORCID", group: "RESEARCH", hosts: ["orcid.org"], site: "orcid.org", domain: "orcid.org" },
  { key: "SCHOLAR", group: "RESEARCH", hosts: ["scholar.google.com"], site: "scholar.google.com/citations", domain: "scholar.google.com" },

  { key: "YOUTUBE", group: "OTHER", hosts: ["youtube.com"], site: "youtube.com", domain: "youtube.com" },
  { key: "THREADS", group: "OTHER", hosts: ["threads.net", "threads.com"], site: "threads.net", domain: "threads.net" },
  { key: "QUORA", group: "OTHER", hosts: ["quora.com"], site: "quora.com/profile", domain: "quora.com" },
  { key: "REDDIT", group: "OTHER", hosts: ["reddit.com"], site: "reddit.com/user", domain: "reddit.com" },
  { key: "PINTEREST", group: "OTHER", hosts: ["pinterest.com"], site: "pinterest.com", domain: "pinterest.com" },
  { key: "NAUKRI", group: "OTHER", hosts: ["naukri.com"], site: "naukri.com", domain: "naukri.com" },
  { key: "ABOUT_ME", group: "OTHER", hosts: ["about.me"], site: "about.me", domain: "about.me" },
  { key: "LINKTREE", group: "OTHER", hosts: ["linktr.ee"], site: "linktr.ee", domain: "linktr.ee" },
];

const PLATFORM_KEYS = PLATFORMS.map((p) => p.key);

// Longest host first, so "scholar.google.com" is never shadowed by a
// shorter entry.
const hostMatches = (host, h) => host === h || host.endsWith(`.${h}`);

const platformFromHost = (hostname) => {
  const host = String(hostname || "").toLowerCase();
  const found = PLATFORMS.find((p) => p.hosts.some((h) => hostMatches(host, h)));
  return found ? found.key : null;
};

// Username from URL path segments, for the "simple" platforms.
const usernameFromPath = (platform, parts) => {
  const first = parts[0];
  if (!first) return null;
  const at = (s) => (s ? s.replace(/^@/, "") : null);

  switch (platform) {
    case "YOUTUBE":
      if (first.startsWith("@")) return at(first);
      if (["c", "user", "channel"].includes(first.toLowerCase())) return parts[1] || null;
      return null;
    case "MEDIUM":
    case "THREADS":
      return first.startsWith("@") ? at(first) : null;
    case "STACKOVERFLOW":
      return first.toLowerCase() === "users" ? parts[2] || parts[1] || null : null;
    case "QUORA":
      return first.toLowerCase() === "profile" ? parts[1] || null : null;
    case "REDDIT":
      return ["user", "u"].includes(first.toLowerCase()) ? parts[1] || null : null;
    case "HACKERRANK":
      return first.toLowerCase() === "profile" ? parts[1] || null : first;
    case "LEETCODE":
      return ["u", "profile"].includes(first.toLowerCase()) ? parts[1] || null : first;
    case "NAUKRI":
      return null;
    case "RESEARCHGATE":
      return first.toLowerCase() === "profile" ? parts[1] || null : null;
    case "CODECHEF":
      return first.toLowerCase() === "users" ? parts[1] || null : null;
    case "ORCID":
      return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(first) ? first : null;
    case "SCHOLAR":
      return null;
    default:
      // KAGGLE, BEHANCE, DRIBBBLE, PINTEREST, DEVTO, ABOUT_ME, LINKTREE
      return at(first);
  }
};

module.exports = { PLATFORMS, PLATFORM_KEYS, platformFromHost, usernameFromPath };
