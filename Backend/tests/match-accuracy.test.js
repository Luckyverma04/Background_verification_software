"use strict";

/**
 * Real-world matching cases that used to stop the right person short of
 * STRONG, plus the namesake cases that must stay below STRONG.
 * Pure: no DB, no network, no ML.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const matcher = require("../services/candidateMatch.service");
const signals = require("../services/matchSignals.service");

const CANDIDATE = {
  fullName: "Priya Verma",
  currentCompany: "Tata Consultancy Services",
  currentJobTitle: "Senior Software Engineer",
  location: { city: "Bhopal", state: "Madhya Pradesh", country: "India" },
  education: [{ institution: "IIT Indore", degree: "B.Tech" }],
};

const linkedin = (over = {}) => ({
  _id: "r1",
  platform: "LINKEDIN",
  profileUrl: "https://in.linkedin.com/in/priya-verma-12ab",
  name: "Priya Verma",
  jobTitle: "Senior Software Engineer",
  company: "TCS",
  location: { city: "Bhopal", state: "Madhya Pradesh", country: "India" },
  education: [{ institution: "Indian Institute of Technology Indore" }],
  rawData: {},
  ...over,
});

const run = (candidate, result) => matcher.calculateCandidateMatch(candidate, result);

test("M1. company acronyms match the full name (TCS = Tata Consultancy Services)", () => {
  assert.equal(signals.isAcronymOf(["tcs"], ["tata", "consultancy", "services"]), true);
  assert.equal(signals.isAcronymOf(["ibm"], ["international", "business", "machines"]), true);
  assert.equal(signals.isAcronymOf(["ab"], ["alpha", "beta"]), false, "2-letter acronyms are too ambiguous");
  assert.equal(signals.compareCompany(CANDIDATE, "TCS", "").state, "MATCH");
  assert.equal(signals.compareCompany({ currentCompany: "TCS" }, "Tata Consultancy Services Ltd", "").state, "MATCH");
  assert.equal(signals.compareCompany(CANDIDATE, "TCS Logistics", "").state, "MISMATCH", "an acronym plus another word is a different company");

  const m = run(CANDIDATE, linkedin());
  assert.equal(m.matchStatus, "STRONG");
  assert.ok(!m.conflictingSignals.some((c) => c.field === "company"), "the acronym is not a conflict any more");
});

test("M2. job-title synonyms: developer / programmer / engineer, SDE", () => {
  assert.equal(signals.compareTitle({ currentJobTitle: "Software Developer" }, "Software Engineer").state, "MATCH");
  assert.equal(signals.compareTitle({ currentJobTitle: "Programmer" }, "Engineer").state, "MATCH");
  assert.equal(signals.compareTitle({ currentJobTitle: "Software Engineer" }, "SDE").state, "MATCH");
  assert.equal(signals.compareTitle({ currentJobTitle: "Data Engineer" }, "Software Engineer").state, "DIFFERENT");

  const m = run({ ...CANDIDATE, currentJobTitle: "Software Developer" }, linkedin());
  assert.equal(m.matchStatus, "STRONG");
});

test("M3. name + current employer + city, all agreeing, is STRONG even without title / education", () => {
  const sheetCandidate = { fullName: "Priya Verma", currentCompany: "TCS", location: CANDIDATE.location };
  const m = run(sheetCandidate, linkedin());
  assert.equal(m.matchStatus, "STRONG");
  assert.ok(m.matchDetails.identity.statusReasons.includes("NAME_PLUS_ALL_AVAILABLE_EVIDENCE"));
  assert.equal(m.matchDetails.identity.coverage, 1);
  assert.equal(m.matchDetails.identity.maxAchievable, 77);
  assert.match(m.explanation, /77 of 77 possible/);
});

test("M4. namesakes stay below STRONG", () => {
  const c = { fullName: "Rahul Sharma", currentCompany: "Tata Consultancy Services", currentJobTitle: "Software Engineer", location: { city: "Pune", state: "Maharashtra", country: "India" } };
  const r = (over) => ({ _id: "n", platform: "LINKEDIN", profileUrl: "https://linkedin.com/in/rahul-sharma-x", name: "Rahul Sharma", rawData: {}, ...over });
  const cases = {
    "other company, same city": r({ company: "Infosys", jobTitle: "Software Engineer", location: { city: "Pune" } }),
    "same company, other city": r({ company: "TCS", jobTitle: "Software Engineer", location: { city: "Delhi" } }),
    "same company + city, different title": r({ company: "TCS", jobTitle: "HR Manager", location: { city: "Pune" } }),
    "only the first name matches": r({ name: "Rahul Verma", company: "TCS", location: { city: "Pune" } }),
    "initial only": r({ name: "R Sharma", company: "TCS", location: { city: "Pune" } }),
    "name + city only": r({ location: { city: "Pune" } }),
    "name + company + title, no location": r({ company: "TCS", jobTitle: "Software Engineer" }),
  };
  for (const [label, result] of Object.entries(cases)) {
    assert.notEqual(run(c, result).matchStatus, "STRONG", label);
  }
});

// ------------------------------------------------------------------
// Parsing real search-result shapes (Serper / Google)
// ------------------------------------------------------------------
const { normalizeSerperResult } = require("../services/resultMerge.service");
const parse = (title, link, snippet) => normalizeSerperResult({ title, link, snippet });

test("M5. the person's name is taken from the page title on every platform", () => {
  assert.equal(parse("priyav (Priya Verma) · GitHub", "https://github.com/priyav", "").name, "Priya Verma");
  assert.equal(parse("priyav · GitHub", "https://github.com/priyav", "").name, null, "a bare username is not a name");
  assert.equal(parse("Priya Verma (@priya.verma) • Instagram photos and videos", "https://www.instagram.com/priya.verma/", "").name, "Priya Verma");
  assert.equal(parse("Priya Verma (@priyav) / X", "https://x.com/priyav", "").name, "Priya Verma");
  assert.equal(parse("Priya Verma on LinkedIn: Excited to share ...", "https://www.linkedin.com/posts/priya-verma_x-activity-1", "").name, "Priya Verma");
  assert.equal(parse("Priya Verma | Facebook", "https://www.facebook.com/priya.verma.1", "").name, "Priya Verma");
});

test("M6. LinkedIn: location in the title, labelled snippet fields, no snippet text as company", () => {
  const a = parse("Priya Verma - Bhopal, Madhya Pradesh, India | Professional Profile | LinkedIn", "https://in.linkedin.com/in/priyaverma",
    "Bhopal, Madhya Pradesh, India · Software Engineer · TCS. Experienced engineer with a history of working in the IT industry.");
  assert.deepEqual(a.location, { city: "Bhopal", state: "Madhya Pradesh", country: "India" });
  assert.equal(a.company, "TCS");
  assert.equal(a.jobTitle, "Software Engineer");

  const b = parse("Priya Verma - Senior Software Engineer - Tata Consultancy Services | LinkedIn", "https://in.linkedin.com/in/pv-1",
    "Senior Software Engineer at Tata Consultancy Services · Experience: Tata Consultancy Services · Education: Indian Institute of Technology, Indore · Location: Bhopal · 500+ connections on LinkedIn.");
  assert.deepEqual(b.education.map((e) => e.institution), ["Indian Institute of Technology, Indore"]);
  assert.equal(b.location.city, "Bhopal");

  const c = parse("Ravi Kumar - Data Analyst - Acme | LinkedIn", "https://www.linkedin.com/in/ravi-k", "Location: London, United Kingdom");
  assert.equal(c.location.country, "United Kingdom", "City, Country puts the country in country");
});

test("M7. sentence text does not leak into company / location", () => {
  const fb = parse("Priya Verma | Facebook", "https://www.facebook.com/p.v",
    "Priya Verma is on Facebook. Works at Tata Consultancy Services. Lives in Bhopal, Madhya Pradesh.");
  assert.equal(fb.company, "Tata Consultancy Services");
  assert.equal(fb.location.state, "Madhya Pradesh");
  const x = parse("Priya Verma (@priyav) / X", "https://x.com/priyav", "Software engineer @TCS. Bhopal, India.");
  assert.equal(x.company, "TCS");
  assert.equal(x.location.city, "Bhopal");
  const ig = parse("Priya Verma (@pv) • Instagram photos and videos", "https://www.instagram.com/pv/", "See Instagram photos and videos from Priya Verma (@pv)");
  assert.equal(ig.location, null, "\"from <name>\" is not a location");
});

test("M8. a page title is never compared as a job title", () => {
  const sr = { _id: "fb", ...parse("Priya Verma | Facebook", "https://www.facebook.com/p.v", "Works at Tata Consultancy Services. Lives in Bhopal, Madhya Pradesh.") };
  const m = run(CANDIDATE, sr);
  assert.ok(!m.conflictingSignals.some((c) => c.field === "jobTitle"));
  assert.equal(m.matchDetails.components.jobTitle.state, "UNKNOWN");
});

test("M9. end to end: the right person's profiles rank STRONG, namesakes stay WEAK", () => {
  const status = (t, l, s) => run(CANDIDATE, { _id: l, ...parse(t, l, s) }).matchStatus;
  assert.equal(status("Priya Verma - Senior Software Engineer - Tata Consultancy Services | LinkedIn", "https://in.linkedin.com/in/pv-1",
    "Experience: Tata Consultancy Services · Education: Indian Institute of Technology, Indore · Location: Bhopal"), "STRONG");
  assert.equal(status("Priya Verma - Bhopal, Madhya Pradesh, India | Professional Profile | LinkedIn", "https://in.linkedin.com/in/pv-2",
    "Bhopal, Madhya Pradesh, India · Software Engineer · TCS"), "STRONG");
  assert.equal(status("Priya Verma (@priyav) / X", "https://x.com/priyav", "Software engineer @TCS. Bhopal, India."), "STRONG");
  assert.equal(status("Priya Verma - Software Developer - Infosys | LinkedIn", "https://in.linkedin.com/in/pv-pune",
    "Software Developer at Infosys · Location: Pune, Maharashtra, India"), "WEAK");
  assert.equal(status("Priya Verma (@pv.official) • Instagram photos", "https://www.instagram.com/pv.official/", "Fashion & lifestyle creator, Delhi."), "WEAK");
});
