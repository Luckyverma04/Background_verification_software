"use strict";
const { normalizeLocation } = require("../utils/locationNormalizer");

/**
 * Pure (no DB, no network) helpers for identity matching and for validating
 * signals before they are used to build search queries.
 *
 * Rules:
 *  - missing data is UNKNOWN, never a mismatch
 *  - a value that looks like a sentence fragment is REJECTED (UNKNOWN)
 *  - whole-token comparison only (no "one string contains the other" = 85)
 */

const strip = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
const norm = (s) =>
  strip(s)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
const toks = (s) => norm(s).split(" ").filter(Boolean);
const uniq = (a) => [...new Set(a)];

// ------------------------------------------------------------
// Sentence-fragment / junk detection
// ------------------------------------------------------------
const SENTENCE_WORDS =
  /\b(is|are|was|were|currently|works?|working|holds?|has|have|had|based|located|lives?|living|joined|studied|studies|leading|leads|serving|serves|with over|years? of|experience|passionate|helping|helps|i am|i'm|he|she|they|his|her)\b/i;
const ROLE_WORDS =
  /\b(manager|engineer|developer|director|analyst|consultant|designer|officer|president|founder|lead|architect|specialist|associate|intern|executive|scientist|professor|teacher)\b/i;

const looksLikeFragment = (text, { maxWords = 8 } = {}) => {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/(\.\.\.|…)\s*$/.test(t)) return true;
  if (t.split(/\s+/).length > maxWords) return true;
  if (/[.!?]\s+[A-Za-z]/.test(t) && !/\b(pvt|ltd|inc|co|corp|llc|jr|sr|dr|mr|st)\.\s/i.test(t)) return true;
  if (t.split(/\s+/).length > 3 && SENTENCE_WORDS.test(t)) return true;
  if (t.length > 80) return true;
  return false;
};

const GENERIC_COMPANY = new Set([
  "team", "teams", "company", "companies", "organization", "organisation", "business",
  "self employed", "selfemployed", "freelance", "freelancer", "confidential", "stealth",
  "various", "student", "linkedin", "facebook", "instagram", "github", "twitter", "x",
  "google search", "unknown", "private", "public", "startup", "a startup", "none",
]);

const GENERIC_TITLES = new Set([
  "manager", "engineer", "developer", "associate", "executive", "analyst", "consultant",
  "intern", "student", "member", "employee", "professional", "specialist", "officer",
  "lead", "director", "teams", "team", "worker", "staff", "profile", "user",
]);

const SENIORITY = new Set([
  "senior", "junior", "lead", "principal", "staff", "associate", "assistant", "head",
  "chief", "executive", "sr", "jr", "intern", "trainee", "deputy", "vice",
]);

const TITLE_ABBR = {
  sr: "senior", jr: "junior", mgr: "manager", eng: "engineer", engr: "engineer",
  dev: "developer", swe: "software engineer", sde: "software development engineer",
  asst: "assistant", assoc: "associate", dir: "director", exec: "executive",
  vp: "vice president", avp: "assistant vice president", mktg: "marketing",
  ops: "operations", hr: "human resources", prog: "program", proj: "project",
};

const LEGAL_SUFFIX = new Set([
  "pvt", "private", "ltd", "limited", "llc", "inc", "incorporated", "corp", "corporation",
  "co", "company", "plc", "gmbh", "llp", "opc", "ag", "sa", "bv", "pte",
]);

const GENERIC_COMPANY_TOKENS = new Set([
  "school", "schools", "technologies", "technology", "tech", "solutions", "services",
  "systems", "group", "global", "labs", "lab", "software", "consulting", "consultancy",
  "digital", "international", "enterprises", "industries", "institute", "university",
  "college", "academy", "learning", "education", "the", "and", "of", "india", "limited",
]);

// ------------------------------------------------------------
// NAME
// ------------------------------------------------------------
const NAME_NOISE = new Set([
  "mr", "mrs", "ms", "dr", "shri", "smt", "prof", "er", "ca", "cs", "mba", "phd", "pmp", "jr", "sr", "ii", "iii",
]);
const NON_NAME_WORDS = new Set([
  "foundation", "school", "academy", "university", "institute", "group", "team", "official",
  "fan", "page", "club", "studio", "solutions", "technologies", "services", "company",
  "pvt", "ltd", "jobs", "resume", "cv", "profile", "news",
]);

const nameTokens = (v) => {
  const all = toks(v);
  const kept = all.filter((t) => !NAME_NOISE.has(t));
  return kept.length ? kept : all;
};

const lev1 = (a, b) => {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
};

const tokenRelation = (a, b) => {
  if (a === b) return "exact";
  if (a.length >= 6 && b.length >= 6 && lev1(a, b)) return "variant";
  if ((a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b))) return "initial";
  return null;
};

const compareNames = (candidateName, resultName) => {
  const A = nameTokens(candidateName);
  const B = nameTokens(resultName);
  if (!A.length || !B.length) {
    return { state: "UNKNOWN", score: null, reason: "Name unavailable on one side.", matched: [], unmatchedCandidate: A, unmatchedResult: B };
  }

  if (A.length === 1 || B.length === 1) {
    const rel = A.some((a) => B.some((b) => tokenRelation(a, b) === "exact"));
    return {
      state: "MISMATCH", score: rel ? 30 : 0,
      reason: rel ? "Only a single name token is shared; not sufficient identity evidence." : "Names share no token.",
      matched: [], unmatchedCandidate: A, unmatchedResult: B,
    };
  }

  const used = new Set();
  const matched = [];
  const unmatchedCandidate = [];
  for (const a of A) {
    let found = -1, kind = null;
    for (const want of ["exact", "variant", "initial"]) {
      found = B.findIndex((b, i) => !used.has(i) && tokenRelation(a, b) === want);
      if (found >= 0) { kind = want; break; }
    }
    if (found >= 0) { used.add(found); matched.push({ candidate: a, result: B[found], kind }); }
    else unmatchedCandidate.push(a);
  }
  const unmatchedResult = B.filter((_, i) => !used.has(i));

  const first = A[0];
  const last = A[A.length - 1];
  const coreKinds = [first, last].map((c) => matched.find((m) => m.candidate === c)?.kind || null);
  const solid = coreKinds.filter((k) => k === "exact" || k === "variant").length;
  const initials = coreKinds.filter((k) => k === "initial").length;

  let score;
  let reason;
  if (solid === 2) {
    score = 100 - 8 * coreKinds.filter((k) => k === "variant").length;
    const middleDiff = unmatchedCandidate.filter((t) => t !== first && t !== last).length + unmatchedResult.length;
    score -= Math.min(middleDiff * 3, 9);
    if (unmatchedResult.some((t) => NON_NAME_WORDS.has(t))) { score -= 40; reason = "Result name contains organisation-like words."; }
  } else if (solid === 1 && initials === 1) {
    score = 62;
    reason = "One name component matches; the other only by initial.";
  } else if (solid === 1) {
    score = 35;
    reason = "Only one name component (first name or surname) matches; not sufficient identity evidence.";
  } else {
    score = 0;
    reason = "No name component matches.";
  }
  score = Math.max(0, Math.min(100, score));
  return {
    state: score >= 85 ? "MATCH" : score >= 55 ? "PARTIAL" : "MISMATCH",
    score,
    reason: reason || (score === 100 ? "All name components match." : "Name components match with minor differences."),
    matched, unmatchedCandidate, unmatchedResult,
  };
};

// ------------------------------------------------------------
// USERNAME (never independent evidence)
// ------------------------------------------------------------
const isJunkUsername = (u) => {
  const s = String(u ?? "").trim().replace(/^@/, "");
  if (!s) return true;
  if (s.length < 3 || s.length > 40) return true;
  if (/email|noreply|unknown|undefined|null/i.test(s)) return true;
  if (/\d{6,}/.test(s)) return true;
  if (/^\d+$/.test(s)) return true;
  if (/^[a-f0-9]{16,}$/i.test(s)) return true;
  if (!/^[a-z0-9._-]+$/i.test(s)) return true;
  return false;
};

const analyzeUsername = (username, candidateName, knownHandles = []) => {
  const raw = String(username ?? "").trim().replace(/^@/, "");
  if (!raw) return { state: "UNKNOWN", usable: false, junk: false, nameDerived: false, knownHandle: false };
  const junk = isJunkUsername(raw);
  const low = raw.toLowerCase();
  const knownHandle = knownHandles.some((h) => h && h.toLowerCase() === low);
  const t = nameTokens(candidateName);
  const letters = low.replace(/[^a-z]/g, "");
  let nameDerived = false;
  if (t.length >= 2) {
    const f = t[0], l = t[t.length - 1];
    nameDerived = letters.includes(f + l) || letters.includes(l + f) || letters.includes(f[0] + l) || (letters.includes(f) && letters.includes(l));
  }
  return { state: knownHandle ? "KNOWN_HANDLE" : nameDerived ? "NAME_DERIVED" : "UNRELATED", usable: !junk, junk, nameDerived, knownHandle };
};

// ------------------------------------------------------------
// COMPANY
// ------------------------------------------------------------
const companyTokens = (v) => {
  const t = toks(v).filter((x) => !LEGAL_SUFFIX.has(x));
  return t;
};
const distinctive = (t) => t.filter((x) => !GENERIC_COMPANY_TOKENS.has(x));

const validateCompany = (value) => {
  const v = String(value ?? "").trim();
  if (!v) return { valid: false, reason: "empty" };
  const n = norm(v);
  if (!n || /^[\d\s]+$/.test(n)) return { valid: false, reason: "no letters" };
  if (GENERIC_COMPANY.has(n)) return { valid: false, reason: "generic word" };
  if (looksLikeFragment(v, { maxWords: 7 })) return { valid: false, reason: "sentence fragment" };
  if (ROLE_WORDS.test(v) && v.split(/\s+/).length <= 2 && !/\b(inc|ltd|llc|pvt)\b/i.test(v)) return { valid: false, reason: "looks like a job title" };
  if (n.length < 2) return { valid: false, reason: "too short" };
  return { valid: true, value: v.replace(/\s+/g, " ") };
};

const compareOneCompany = (known, found) => {
  const a = companyTokens(known);
  const b = companyTokens(found);
  if (!a.length || !b.length) return 0;
  if (a.join(" ") === b.join(" ")) return 100;
  const da = distinctive(a);
  const db = distinctive(b);
  if (!da.length || !db.length) return 0;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  if (short.every((x) => long.includes(x))) return 90;
  const inter = short.filter((x) => long.includes(x)).length;
  const jac = inter / uniq([...da, ...db]).length;
  return jac >= 0.5 ? 65 : 0;
};

const knownCompanies = (candidate) => {
  const cur = candidate?.currentCompany ? String(candidate.currentCompany).trim() : "";
  const past = (Array.isArray(candidate?.experience) ? candidate.experience : [])
    .map((e) => String(e?.company ?? "").trim())
    .filter((c) => c && c.toLowerCase() !== cur.toLowerCase());
  return { current: cur, past: uniq(past) };
};

const mentionsPhrase = (text, phrase) => {
  const p = norm(phrase);
  if (!p) return false;
  return ` ${norm(text)} `.includes(` ${p} `);
};

const compareCompany = (candidate, resultCompany, text) => {
  const { current, past } = knownCompanies(candidate);
  if (!current && !past.length) return { state: "UNKNOWN", score: null, reason: "Candidate company unknown.", source: null };

  const check = validateCompany(resultCompany);
  if (check.valid) {
    let best = { score: 0, employer: null, known: null };
    if (current) {
      const s = compareOneCompany(current, check.value);
      if (s > best.score) best = { score: s, employer: "CURRENT", known: current };
    }
    for (const p of past) {
      const s = Math.round(compareOneCompany(p, check.value) * 0.75);
      if (s > best.score) best = { score: s, employer: "PAST", known: p };
    }
    if (best.score >= 85 && best.employer === "CURRENT") return { state: "MATCH", score: best.score, employer: "CURRENT", source: "FIELD", reason: `Company matches current employer (${best.known}).` };
    if (best.score >= 50) return { state: "PARTIAL", score: best.score, employer: best.employer, source: "FIELD", reason: best.employer === "PAST" ? `Company matches a previous employer (${best.known}).` : `Company partially matches (${best.known}).` };
    return { state: "MISMATCH", score: 0, source: "FIELD", reason: `Company "${check.value}" does not match any known employer.`, resultValue: check.value };
  }

  // structured company unusable -> look for a whole-phrase mention in the result's own text
  for (const [list, employer] of [[current ? [current] : [], "CURRENT"], [past, "PAST"]]) {
    for (const c of list) {
      const dt = distinctive(companyTokens(c));
      if (dt.length && mentionsPhrase(text, dt.join(" "))) {
        return { state: "PARTIAL", score: employer === "CURRENT" ? 70 : 50, employer, source: "TEXT", reason: `Company "${c}" is mentioned in the result text.` };
      }
    }
  }
  return {
    state: "UNKNOWN", score: null, source: null,
    reason: resultCompany ? `Result company rejected (${check.reason}).` : "Result company unknown.",
    rejected: Boolean(resultCompany),
  };
};

// ------------------------------------------------------------
// TITLE
// ------------------------------------------------------------
const titleTokens = (v) =>
  toks(v)
    .flatMap((t) => (TITLE_ABBR[t] ? TITLE_ABBR[t].split(" ") : [t]))
    .filter((t) => !["of", "and", "the", "at", "in", "for"].includes(t));

const validateTitle = (value) => {
  const v = String(value ?? "").trim();
  if (!v) return { valid: false, reason: "empty" };
  if (looksLikeFragment(v, { maxWords: 8 })) return { valid: false, reason: "sentence fragment" };
  const t = titleTokens(v);
  if (!t.length) return { valid: false, reason: "no letters" };
  const core = t.filter((x) => !SENIORITY.has(x));
  const generic = !core.length || core.every((x) => GENERIC_TITLES.has(x));
  return { valid: true, value: v.replace(/\s+/g, " "), generic };
};

const compareOneTitle = (known, found) => {
  const a = titleTokens(known);
  const b = titleTokens(found);
  if (!a.length || !b.length) return 0;
  if (a.join(" ") === b.join(" ")) return 100;
  const ca = a.filter((x) => !SENIORITY.has(x));
  const cb = b.filter((x) => !SENIORITY.has(x));
  if (!ca.length || !cb.length) return 40;
  if (ca.join(" ") === cb.join(" ")) return 88;
  const [s, l] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  const inter = s.filter((x) => l.includes(x));
  if (inter.length && inter.every((x) => GENERIC_TITLES.has(x))) return 35;
  if (s.every((x) => l.includes(x))) return 75;
  const jac = inter.length / uniq([...ca, ...cb]).length;
  if (jac >= 0.5) return 60;
  if (inter.length && inter.every((x) => GENERIC_TITLES.has(x))) return 35;
  return 0;
};

const compareTitle = (candidate, resultTitle) => {
  const current = candidate?.currentJobTitle ? String(candidate.currentJobTitle).trim() : "";
  const past = uniq(
    (Array.isArray(candidate?.experience) ? candidate.experience : [])
      .map((e) => String(e?.jobTitle ?? "").trim())
      .filter((t) => t && t.toLowerCase() !== current.toLowerCase())
  );
  if (!current && !past.length) return { state: "UNKNOWN", score: null, reason: "Candidate job title unknown." };
  const check = validateTitle(resultTitle);
  if (!check.valid) return { state: "UNKNOWN", score: null, reason: resultTitle ? `Result title rejected (${check.reason}).` : "Result title unknown.", rejected: Boolean(resultTitle) };

  let best = { score: 0, past: false };
  if (current) best = { score: compareOneTitle(current, check.value), past: false };
  for (const p of past) {
    const s = Math.round(compareOneTitle(p, check.value) * 0.8);
    if (s > best.score) best = { score: s, past: true };
  }
  const state = best.score >= 85 ? "MATCH" : best.score >= 55 ? "PARTIAL" : "DIFFERENT";
  return {
    state, score: best.score, past: best.past, genericResult: check.generic,
    reason: state === "DIFFERENT" ? `Title "${check.value}" differs (people change roles; informational).` : `Title ${state === "MATCH" ? "matches" : "partially matches"}${best.past ? " a previous role" : ""}.`,
    resultValue: check.value,
  };
};

// ------------------------------------------------------------
// LOCATION
// ------------------------------------------------------------
const CITY_ALIAS = {
  bangalore: "bengaluru", bombay: "mumbai", calcutta: "kolkata", madras: "chennai",
  gurgaon: "gurugram", poona: "pune", baroda: "vadodara", trivandrum: "thiruvananthapuram",
  "new delhi": "delhi",
};
const COUNTRY_ALIAS = {
  in: "india", ind: "india", usa: "united states", us: "united states", "united states of america": "united states",
  uk: "united kingdom", "great britain": "united kingdom", england: "united kingdom", uae: "united arab emirates",
};
const LOC_SUFFIX = ["urban", "rural", "district", "city", "metropolitan area", "metropolitan region", "region", "division", "area", "greater"];

const normLoc = (v, alias) => {
  let n = norm(v);
  for (const s of LOC_SUFFIX) n = n.replace(new RegExp(`\\b${s}\\b`, "g"), " ");
  n = n.replace(/\s+/g, " ").trim();
  return alias[n] || n;
};

const validateLocationPart = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return { valid: false, reason: "empty" };
  if (looksLikeFragment(s, { maxWords: 4 })) return { valid: false, reason: "sentence fragment" };
  if (/\d/.test(s) || /@|https?:|\//.test(s)) return { valid: false, reason: "contains digits/URL" };
  if (ROLE_WORDS.test(s) || SENTENCE_WORDS.test(s)) return { valid: false, reason: "contains role/verb words" };
  if (s.split(/\s+/).length > 4) return { valid: false, reason: "too long" };
  if (norm(s).length < 2) return { valid: false, reason: "too short" };
  return { valid: true, value: s };
};

const asLocationObject = (loc) => {
  if (!loc) return null;
  if (typeof loc === "string") {
    const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 1) return { country: parts[0] };
    if (parts.length === 2) return { city: parts[0], country: parts[1] };
    return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
  }
  if (typeof loc === "object") return { city: loc.city, state: loc.state, country: loc.country };
  return null;
};

const validateLocation = (loc) => {
  const o = asLocationObject(loc);
  if (!o) return { valid: false, reason: "empty" };
  const out = {};
  const rejected = [];
  for (const k of ["city", "state", "country"]) {
    if (!o[k]) continue;
    const v = validateLocationPart(o[k]);
    if (v.valid) out[k] = v.value;
    else rejected.push(`${k}: ${v.reason}`);
  }
  // A malformed part makes the whole value untrustworthy.
  if (rejected.length) return { valid: false, reason: rejected.join("; ") };
  if (!Object.keys(out).length) return { valid: false, reason: "empty" };
  return { valid: true, value: out };
};

const compareLocation = (candidateLoc, resultLoc, text) => {
  // repair contradictory input (Dewas + Maharashtra) before comparing
  const rawC = asLocationObject(candidateLoc);
  const c = rawC ? (({ city, state, country }) => ({ city, state, country }))(normalizeLocation(rawC)) : null;
  const cClean = c ? Object.fromEntries(Object.entries(c).filter(([, v]) => v && String(v).trim())) : {};
  if (!Object.keys(cClean).length) return { state: "UNKNOWN", score: null, reason: "Candidate location unknown." };

  const r = validateLocation(resultLoc);
  if (!r.valid) {
    if (c.city && text && mentionsPhrase(text, normLoc(c.city, CITY_ALIAS))) {
      return { state: "PARTIAL", score: 50, level: "TEXT", source: "TEXT", reason: `Candidate city "${c.city}" appears in the result text.` };
    }
    return { state: "UNKNOWN", score: null, reason: resultLoc && r.reason !== "empty" ? `Result location rejected (${r.reason}).` : "Result location unknown.", rejected: Boolean(resultLoc) && r.reason !== "empty" };
  }

  const cmp = (key, alias) => {
    if (!cClean[key] || !r.value[key]) return null;
    const a = normLoc(cClean[key], alias);
    const b = normLoc(r.value[key], alias);
    if (!a || !b) return null;
    if (a === b) return true;
    const ta = a.split(" "), tb = b.split(" ");
    const [s, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
    return s.every((x) => l.includes(x));
  };
  const city = cmp("city", CITY_ALIAS);
  const state = cmp("state", {});
  const country = cmp("country", COUNTRY_ALIAS);

  if (country === false) return { state: "MISMATCH", score: 0, level: "COUNTRY", weight: 1.5, reason: `Different country (${r.value.country} vs ${cClean.country}).`, resultValue: r.value.country };
  if (city === true) return { state: "MATCH", score: 100, level: "CITY", reason: "City matches." };
  if (city === false) {
    const sameRegion = state === true;
    return { state: "MISMATCH", score: 20, level: "CITY", weight: sameRegion ? 0.3 : 0.5, reason: `Different city (${r.value.city} vs ${cClean.city}); relocation or older history may explain this.`, resultValue: r.value.city };
  }
  if (state === true) return { state: "PARTIAL", score: 60, level: "STATE", reason: "State matches (city unknown)." };
  if (state === false) return { state: "MISMATCH", score: 20, level: "STATE", weight: 0.5, reason: `Different state (${r.value.state} vs ${cClean.state}).`, resultValue: r.value.state };
  if (country === true) return { state: "PARTIAL", score: 30, level: "COUNTRY", reason: "Only the country matches (weak)." };
  return { state: "UNKNOWN", score: null, reason: "No comparable location fields." };
};

// ------------------------------------------------------------
// EDUCATION
// ------------------------------------------------------------
const EDU_EXPAND = [
  [/\biiit\b/g, "international institute of information technology"],
  [/\biit\b/g, "indian institute of technology"],
  [/\bnit\b/g, "national institute of technology"],
  [/\bbits\b/g, "birla institute of technology and science"],
  [/\buniv\b/g, "university"],
];
const eduNorm = (v) => {
  let n = norm(v);
  for (const [re, to] of EDU_EXPAND) n = n.replace(re, to);
  return n.split(" ").filter((t) => !["the", "of", "and", "at", "in"].includes(t)).join(" ");
};

const compareEducation = (candidateEdu, resultEdu, text) => {
  const cands = (Array.isArray(candidateEdu) ? candidateEdu : []).map((e) => e?.institution).filter(Boolean);
  if (!cands.length) return { state: "UNKNOWN", score: null, reason: "Candidate education unknown." };
  const found = (Array.isArray(resultEdu) ? resultEdu : []).map((e) => e?.institution).filter(Boolean);

  const same = (a, b) => {
    const x = eduNorm(a), y = eduNorm(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const tx = x.split(" "), ty = y.split(" ");
    const [s, l] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
    return s.length >= 2 && s.every((t) => l.includes(t));
  };

  if (found.length) {
    if (cands.some((a) => found.some((b) => same(a, b)))) return { state: "MATCH", score: 100, source: "FIELD", reason: "Institution matches." };
    return { state: "NO_OVERLAP", score: null, reason: "Listed institutions do not overlap (public lists are often partial; informational only)." };
  }
  for (const c of cands) {
    const n = eduNorm(c);
    if (n && ` ${eduNorm(text)} `.includes(` ${n} `)) return { state: "PARTIAL", score: 70, source: "TEXT", reason: `Institution "${c}" is mentioned in the result text.` };
  }
  return { state: "UNKNOWN", score: null, reason: "Result education unknown." };
};

// ------------------------------------------------------------
// QUERY-SIGNAL VALIDATION
// ------------------------------------------------------------
const validateQueryUsername = (username, candidateName) => {
  const a = analyzeUsername(username, candidateName);
  if (!a.usable) return { valid: false, reason: a.junk ? "junk username" : "empty" };
  if (String(username).length < 5) return { valid: false, reason: "too short" };
  if (!a.nameDerived) return { valid: false, reason: "not derived from candidate name" };
  return { valid: true, value: String(username).trim().replace(/^@/, "") };
};

const locationToQuery = (loc) => {
  const v = validateLocation(loc);
  if (!v.valid) return null;
  const { city, state, country } = v.value;
  return city || state || country || null;
};

const queryTokenKey = (q) => {
  const site = (String(q).match(/site:\S+/i) || [""])[0].toLowerCase();
  const t = uniq(norm(String(q).replace(/site:\S+/i, "")).split(" ").filter(Boolean)).sort();
  return { site, tokens: t };
};

/** Drop exact and near-duplicate queries (same scope, token Jaccard >= 0.85). Keeps the first. */
const dedupeQueries = (queries, { threshold = 0.85 } = {}) => {
  const kept = [];
  const keys = [];
  const dropped = [];
  for (const q of queries) {
    if (!q || !String(q).trim()) continue;
    const k = queryTokenKey(q);
    const dup = keys.some((o) => {
      if (o.site !== k.site) return false;
      const inter = k.tokens.filter((t) => o.tokens.includes(t)).length;
      const union = uniq([...k.tokens, ...o.tokens]).length || 1;
      return inter / union >= threshold;
    });
    if (dup) { dropped.push(q); continue; }
    keys.push(k);
    kept.push(q);
  }
  return { queries: kept, dropped };
};

module.exports = {
  norm, toks, looksLikeFragment, nameTokens,
  compareNames, analyzeUsername, isJunkUsername,
  validateCompany, compareCompany, knownCompanies,
  validateTitle, compareTitle, titleTokens,
  validateLocation, compareLocation, locationToQuery,
  compareEducation, mentionsPhrase,
  validateQueryUsername, dedupeQueries,
  GENERIC_TITLES,
};
