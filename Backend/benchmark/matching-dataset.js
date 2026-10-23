"use strict";

/**
 * Deterministic, hand-labelled matching dataset (no network, no DB).
 *
 * Candidate: Shubham Patel, Senior Program Manager at Masai, Bengaluru.
 * Labels:
 *   RELEVANT  - genuinely the candidate (as far as the visible evidence goes)
 *   NAMESAKE  - same / similar name, evidence points to somebody else
 *   GENERIC   - article, directory, company page, search page
 *   UNRELATED - different person, name only partially shared
 *
 * Noisy provider snippets (sentence fragments in the location, junk
 * usernames) are intentionally part of the RELEVANT set - that is exactly
 * what made good profiles disappear.
 */

const CANDIDATE = {
  _id: "cand-1",
  fullName: "Shubham Patel",
  email: "shubham683p@example.com",
  location: { city: "Bengaluru", state: "Karnataka", country: "India" },
  currentCompany: "Masai",
  currentJobTitle: "Senior Program Manager",
  education: [{ institution: "IIT Bombay", degree: "B.Tech" }],
  linkedin: "https://www.linkedin.com/in/shubham-patel-pm",
  experience: [
    { company: "Newton School", jobTitle: "Program Manager" },
    { company: "Masai", jobTitle: "Senior Program Manager" },
  ],
};

let seq = 0;
const make = (label, platform, fields) => {
  seq += 1;
  const url = fields.profileUrl;
  return {
    label,
    searchResult: {
      _id: `sr-${seq}`,
      platform,
      name: null,
      username: null,
      headline: null,
      company: null,
      jobTitle: null,
      location: null,
      education: [],
      profileImageUrl: null,
      ...fields,
      sourceUrl: url,
      rawData: {
        title: fields.rawTitle || fields.name || "",
        snippet: fields.snippet || "",
        providers: ["SERPER"],
      },
    },
  };
};

const loc = (city, state, country) => ({ city, state, country });

const build = () => {
  seq = 0;
  const items = [];

  // ---------------- RELEVANT ----------------
  // R1 candidate-supplied URL (exact known URL)
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubham-patel-pm",
    profileUrl: "https://in.linkedin.com/in/shubham-patel-pm/?trk=public_profile",
    jobTitle: "Senior Program Manager", company: "Masai",
    snippet: "Bengaluru, Karnataka, India · Senior Program Manager · Masai",
  }));
  // R2 correct person, location is a sentence fragment
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubham-patel-8a1b2c",
    profileUrl: "https://www.linkedin.com/in/shubham-patel-8a1b2c",
    jobTitle: "Senior Program Manager", company: "Masai",
    location: loc("Hong Kong, is currently a Senior Program Manager at Masai. Shu", null, null),
    snippet: "Hong Kong, is currently a Senior Program Manager at Masai. Shubham holds a B.Tech from IIT Bombay.",
  }));
  // R3 paraphrased title, same company, same city
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubhampatel-masai",
    profileUrl: "https://www.linkedin.com/in/shubhampatel-masai",
    jobTitle: "Program Lead", company: "Masai School",
    location: loc("Bengaluru", "Karnataka", "India"),
    snippet: "Bengaluru, Karnataka, India · Program Lead · Masai School",
  }));
  // R4 changed title, same company, no location
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", profileUrl: "https://www.linkedin.com/in/shubham-patel-pm-masai",
    username: "shubham-patel-pm-masai",
    jobTitle: "Product Manager", company: "Masai",
    snippet: "Product Manager at Masai",
  }));
  // R5 GitHub, bio mentions company and city
  items.push(make("RELEVANT", "GITHUB", {
    name: "Shubham Patel", username: "shubhampatel-dev",
    profileUrl: "https://github.com/shubhampatel-dev",
    headline: "Program manager at Masai", company: "Masai",
    location: loc("Bengaluru", null, "India"),
    snippet: "Shubham Patel shubhampatel-dev. Program manager at Masai. Bengaluru.",
  }));
  // R6 correct profile, incomplete public info (name + education only)
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubham-patel-iitb",
    profileUrl: "https://www.linkedin.com/in/shubham-patel-iitb",
    education: [{ institution: "IIT Bombay", degree: "B.Tech" }],
    snippet: "Shubham Patel - IIT Bombay",
  }));
  // R7 name with initial + company
  items.push(make("RELEVANT", "TWITTER", {
    name: "Shubham K. Patel", username: "shubham_masai",
    profileUrl: "https://x.com/shubham_masai",
    company: "Masai", location: loc("Bengaluru", null, null),
    snippet: "Shubham K. Patel. Masai. Bengaluru.",
  }));
  // R8 instagram with city + name
  items.push(make("RELEVANT", "INSTAGRAM", {
    name: "Shubham Patel", username: "shubhampatel.blr",
    profileUrl: "https://www.instagram.com/shubhampatel.blr/",
    location: loc("Bengaluru", "Karnataka", "India"),
    snippet: "Shubham Patel. Program manager. Bengaluru.",
  }));

  // R9 changed title + sentence-fragment location (two weak "conflicts")
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubham-patel-9f3",
    profileUrl: "https://www.linkedin.com/in/shubham-patel-9f3",
    jobTitle: "Product Manager", company: "Masai",
    location: loc("Singapore, currently leading the learning programs at Masai", null, null),
    snippet: "Singapore, currently leading the learning programs at Masai.",
  }));
  // R10 abbreviation + legal-entity suffix in the company
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubham-patel-srpm",
    profileUrl: "https://www.linkedin.com/in/shubham-patel-srpm",
    jobTitle: "Sr. Program Manager", company: "Masai Learning Pvt. Ltd.",
    location: loc("Bengaluru Urban", "Karnataka", "India"),
    snippet: "Bengaluru Urban, Karnataka · Sr. Program Manager · Masai Learning Pvt. Ltd.",
  }));
  // R11 shows a PAST employer from the candidate's own history
  items.push(make("RELEVANT", "LINKEDIN", {
    name: "Shubham Patel", username: "shubham-patel-newton",
    profileUrl: "https://www.linkedin.com/in/shubham-patel-newton",
    jobTitle: "Program Manager", company: "Newton School",
    location: loc("Bengaluru", "Karnataka", "India"),
    education: [{ institution: "Indian Institute of Technology Bombay" }],
    snippet: "Bengaluru · Program Manager · Newton School · IIT Bombay",
  }));

  // ---------------- NAMESAKES ----------------
  const places = [
    ["Ahmedabad", "Gujarat", "India"], ["London", null, "United Kingdom"],
    ["Houston", "Texas", "United States"], ["Toronto", "Ontario", "Canada"],
    ["Pune", "Maharashtra", "India"], ["Dubai", null, "United Arab Emirates"],
  ];
  const others = [
    ["Software Engineer", "Infosys"], ["Doctor", "Apollo Hospitals"],
    ["Accountant", "Deloitte"], ["Civil Engineer", "L&T"],
    ["Sales Manager", "Tata Motors"], ["Teacher", "DPS"],
  ];
  for (let i = 0; i < 48; i++) {
    const p = places[i % places.length];
    const o = others[(i * 5) % others.length];
    items.push(make("NAMESAKE", i % 4 === 0 ? "GITHUB" : "LINKEDIN", {
      name: "Shubham Patel", username: `shubham-patel-${100 + i}`,
      profileUrl: i % 4 === 0 ? `https://github.com/shubhampatel${i}` : `https://www.linkedin.com/in/shubham-patel-${100 + i}`,
      jobTitle: o[0], company: o[1], location: loc(p[0], p[1], p[2]),
      snippet: `${p[0]} · ${o[0]} · ${o[1]}`,
    }));
  }
  // name-only namesakes (no supporting evidence at all)
  for (let i = 0; i < 30; i++) {
    items.push(make("NAMESAKE", ["INSTAGRAM", "FACEBOOK", "TWITTER", "LINKEDIN"][i % 4], {
      name: "Shubham Patel", username: `shubhampatel${5000 + i}`,
      profileUrl: `https://www.${["instagram", "facebook", "x", "linkedin"][i % 4]}.com/${i % 4 === 3 ? "in/" : ""}shubhampatel${5000 + i}`,
      snippet: "Shubham Patel",
    }));
  }

  // ---------------- UNRELATED (similar name) ----------------
  for (let i = 0; i < 60; i++) {
    const nm = ["Shubham Sharma", "Shubham Singh", "Subham Patel", "Rahul Patel", "Shubhangi Patil", "Patel Shubham Kumar"][i % 6];
    items.push(make("UNRELATED", "LINKEDIN", {
      name: nm, username: `${nm.toLowerCase().replace(/ /g, "-")}-${i}`,
      profileUrl: `https://www.linkedin.com/in/${nm.toLowerCase().replace(/ /g, "-")}-${i}`,
      jobTitle: "Manager", company: i % 3 ? "Teams" : null,
      location: loc("Bengaluru", "Karnataka", "India"),
      snippet: `Bengaluru · Manager · ${nm}`,
    }));
  }

  // ---------------- GENERIC ----------------
  for (let i = 0; i < 120; i++) {
    const kind = i % 4;
    items.push(make("GENERIC", "OTHER", {
      name: "Shubham Patel",
      profileUrl: [
        `https://news-example.com/article/shubham-patel-${i}`,
        `https://directory-example.com/company-profile/masai-${i}`,
        `https://blog-example.com/blog/program-management-tips-${i}`,
        `https://jobs-example.com/search?q=shubham+patel&p=${i}`,
      ][kind],
      snippet: [
        "Shubham Patel shares program management tips. Masai Bengaluru senior program manager article about teams.",
        "Masai company profile: Senior Program Manager roles in Bengaluru, Karnataka, India.",
        "Ten tips for program managers. Shubham Patel interview. Masai school.",
        "Search results for Shubham Patel Manager jobs in Bengaluru.",
      ][kind],
    }));
  }

  // ---------------- other noise ----------------
  for (let i = 0; i < 150; i++) {
    items.push(make("UNRELATED", ["YOUTUBE", "MEDIUM", "REDDIT", "QUORA"][i % 4], {
      name: null, username: `user${i}`,
      profileUrl: `https://www.${["youtube", "medium", "reddit", "quora"][i % 4]}.com/${["@", "@", "user/", "profile/"][i % 4]}user${i}`,
      snippet: "Bengaluru program management teams",
    }));
  }

  return items;
};

module.exports = { CANDIDATE, build };
