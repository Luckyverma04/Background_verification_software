"use strict";

/**
 * Manually labelled benchmark fixtures (mocked provider responses).
 * Candidate: Priya Verma, Bhopal, Infosys, Senior Software Engineer.
 * Labels: RELEVANT (the candidate), NAMESAKE, GENERIC (directory/article),
 * everything is deterministic and needs no network.
 */

const CANDIDATE = {
  fullName: "Priya Verma",
  email: "priya.verma.dev@example.com",
  location: { city: "Bhopal", state: "Madhya Pradesh", country: "India" },
  currentCompany: "Infosys",
  currentJobTitle: "Senior Software Engineer",
  education: [{ institution: "MANIT Bhopal", degree: "B.Tech" }],
};

const li = (slug, title, company, loc, extra = "") => ({
  title: `Priya Verma - ${title} - ${company} | LinkedIn`,
  link: `https://www.linkedin.com/in/${slug}`,
  snippet: `${loc} · ${title} · ${company}. ${extra}`.trim(),
});

// ---- RELEVANT (true positives) --------------------------------------
const R_LINKEDIN = "https://www.linkedin.com/in/priya-verma-bhopal";
const R_GITHUB = "https://github.com/priyaverma-dev";
const R_SITE = "https://priyaverma.dev";
const R_TWITTER = "https://x.com/priya_dev_bpl";

const serper = [
  li("priya-verma-bhopal", "Senior Software Engineer", "Infosys", "Bhopal, Madhya Pradesh, India", "Education: MANIT Bhopal. Previously at Wipro."),
  // same profile again, different URL form (duplicate across providers)
  { title: "Priya Verma - Senior Software Engineer - Infosys | LinkedIn", link: "https://in.linkedin.com/in/priya-verma-bhopal/?utm_source=share", snippet: "Bhopal · Senior Software Engineer · Infosys" },
  { title: "Priya Verma | Software Engineer", link: "https://priyaverma.dev/", snippet: "Portfolio of Priya Verma." },
  { title: "Priya Verma (@priya_dev_bpl) / X", link: "https://x.com/priya_dev_bpl", snippet: "Priya Verma. Software engineer at Infosys. Bhopal." },

  // ---- namesakes
  li("priya-verma-london", "Product Manager", "Barclays", "London, United Kingdom", "Education: LSE."),
  li("priya-verma-mumbai", "Cardiologist", "Lilavati Hospital", "Mumbai, Maharashtra, India", "Education: Grant Medical College."),
  li("priya-verma-seattle", "Data Scientist", "Google", "Seattle, Washington, United States", "Education: University of Washington."),
  { title: "Priya Verma (@priya.verma.official) • Instagram photos", link: "https://www.instagram.com/priya.verma.official/", snippet: "120 posts. Fashion & lifestyle creator, Delhi." },

  // ---- generic pages that repeat the name
  { title: "Priya Verma - Phone, Address, Email | Public Records Directory", link: "https://www.peoplefinder-example.com/name/priya-verma", snippet: "Priya Verma age 20-60 lives in many cities. Find Priya Verma contact info, relatives, address history, background reports and more for Priya Verma." },
  { title: "Top 10 tips from Priya Verma on software careers", link: "https://careerblog-example.com/priya-verma-tips", snippet: "Priya Verma shares ten tips about software engineering careers, interviews, resumes, productivity and more. Read Priya Verma's story." },
  { title: "Priya Verma wins district quiz", link: "https://dailynews-example.com/local/priya-verma-quiz", snippet: "Class 8 student Priya Verma won the district quiz competition." },

  // ---- no usable URL
  { title: "Priya Verma Infosys Bhopal", snippet: "Priya Verma works at Infosys Bhopal as senior software engineer." },
  { title: "Priya Verma", link: "", snippet: "Some result without any link." },
];

const tavily = [
  { title: "priyaverma-dev (Priya Verma) · GitHub", url: R_GITHUB, content: "Priya Verma priyaverma-dev. Repositories.", score: 0.7 },
  { title: "priyaverma (Priya Verma) · GitHub", url: "https://github.com/priyaverma", content: "Priya Verma. Data scientist.", score: 0.6 },
  { title: "Priya Verma - Senior Software Engineer - Infosys | LinkedIn", url: R_LINKEDIN, content: "Bhopal, Madhya Pradesh, India. Senior Software Engineer at Infosys.", score: 0.8 },
  { title: "Priya Verma - Directory listing", url: "https://www.peoplefinder-example.com/name/priya-verma", content: "Priya Verma. Find contact info for Priya Verma.", score: 0.4 },
];

// extra namesakes so that there are more candidates than the 15 slots
const CITIES = [["Delhi", "India"], ["Chennai", "India"], ["Toronto", "Canada"], ["Sydney", "Australia"], ["Dubai", "UAE"], ["Singapore", "Singapore"], ["Berlin", "Germany"], ["Austin", "United States"], ["Lagos", "Nigeria"], ["Paris", "France"], ["Pune", "India"], ["Kolkata", "India"]];
const JOBS = [["Teacher", "DPS School"], ["Accountant", "Deloitte"], ["Nurse", "Apollo"], ["Marketing Manager", "Unilever"], ["Architect", "Studio 7"], ["Lawyer", "Khaitan"], ["HR Executive", "Accenture"], ["Designer", "Ogilvy"], ["Chef", "Taj"], ["Analyst", "JP Morgan"], ["Professor", "IIT Delhi"], ["Pharmacist", "Cipla"]];
CITIES.forEach(([city, country], i) => {
  serper.push(li(`priya-verma-x${i}`, JOBS[i][0], JOBS[i][1], `${city}, ${country}`));
});

// ---- Public-source fixtures served through the mocked HTTP layer ----
const GITHUB_API = {
  "priyaverma-dev": { name: "Priya Verma", bio: "Backend engineer. Node.js, MongoDB. Infosys Bhopal.", company: "@Infosys", location: "Bhopal, India", blog: "https://priyaverma.dev", twitter_username: "priya_dev_bpl", avatar_url: "https://avatars.githubusercontent.com/u/111?v=4" },
  priyaverma: { name: "Priya Verma", bio: "Data scientist at Google", company: "Google", location: "Seattle, United States", blog: "", twitter_username: null, avatar_url: "https://avatars.githubusercontent.com/u/222?v=4" },
};

const PAGES = {
  "https://priyaverma.dev/": `<html><head><meta property="og:title" content="Priya Verma | Software Engineer"><meta name="description" content="Senior software engineer at Infosys, Bhopal. I build Node.js backends."><script type="application/ld+json">{"@context":"https://schema.org","@type":"Person","name":"Priya Verma","jobTitle":"Senior Software Engineer","worksFor":{"@type":"Organization","name":"Infosys"},"alumniOf":{"@type":"CollegeOrUniversity","name":"MANIT Bhopal"},"address":{"addressLocality":"Bhopal","addressRegion":"Madhya Pradesh","addressCountry":"India"},"sameAs":["https://github.com/priyaverma-dev","https://www.linkedin.com/in/priya-verma-bhopal"]}</script></head></html>`,
  "https://careerblog-example.com/priya-verma-tips": `<html><head><meta name="description" content="Ten tips on careers."></head></html>`,
  "https://www.peoplefinder-example.com/name/priya-verma": `<html><head><meta name="description" content="Find people."></head></html>`,
  "https://dailynews-example.com/local/priya-verma-quiz": `<html><head><meta name="description" content="Local news."></head></html>`,
};

const key = (u) =>
  String(u).toLowerCase().replace(/^https?:\/\/(www\.|in\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

const LABELS = {
  RELEVANT: [R_LINKEDIN, R_GITHUB, R_SITE, R_TWITTER].map(key),
  GENERIC: [
    "https://www.peoplefinder-example.com/name/priya-verma",
    "https://careerblog-example.com/priya-verma-tips",
    "https://dailynews-example.com/local/priya-verma-quiz",
  ].map(key),
};

module.exports = { CANDIDATE, serper, tavily, GITHUB_API, PAGES, LABELS, key };
