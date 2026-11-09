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
