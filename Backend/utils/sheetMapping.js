"use strict";

/**
 * Pure functions (no DB, no network) that turn one Google-Sheet row into the
 * existing Candidate shape and judge how complete it is.
 *
 *  - columns are found by NORMALISED HEADER NAME, never by position
 *  - blank cell = unknown: nothing is invented
 *  - structured cells ("city: NAIROBI\ncountry: KENYA", JSON, or plain text)
 *    are parsed defensively; what cannot be understood is kept as raw source text
 */

const crypto = require("crypto");
const { platformFromHost } = require("./platforms");

const clean = (v) => (v === null || v === undefined ? "" : String(v).replace(/ /g, " ").trim());
const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// ------------------------------------------------------------ header aliases
const ALIASES = {
  jobId: ["jobid", "id", "rowid", "caseid", "applicationid", "requestid", "recordid"],
  createdDate: ["createddate", "createdat", "created", "submittedat", "timestamp", "dateadded"],
  tenantName: ["tenantappname", "tenantname", "tenant", "appname", "clientname", "client"],
  fullName: ["candidatename", "fullname", "name", "candidate", "applicantname", "employeename"],
  email: ["email", "emailid", "emailaddress", "mail", "candidateemail"],
  phone: ["contactnumbers", "contactnumber", "contactno", "contact", "phone", "phonenumber", "mobile", "mobilenumber", "telephone"],
  dateOfBirth: ["dateofbirth", "dob", "birthdate", "birthday"],
  address: ["addresses", "address", "currentaddress", "location", "currentlocation"],
  education: ["education", "educationdetails", "educationhistory", "qualifications", "qualification"],
  experience: ["workexperience", "experience", "employment", "employmenthistory", "workhistory"],
  social: ["socialmediaprofiles", "socialprofiles", "socialmedia", "profiles", "profileurls", "profileurl"],
  imageUrl: ["profileimageurl", "profileimage", "photourl", "photo", "imageurl", "image", "picture"],
  duplicateStatus: ["duplicatestatus", "duplicate", "isduplicate"],
  createdBy: ["createdby"],
  assignedTo: ["assignedto", "assignee"],
  linkedin: ["linkedin", "linkedinurl", "linkedinprofile", "linkedinlink"],
  facebook: ["facebook", "facebookurl", "facebookprofile", "facebooklink"],
  twitter: ["twitter", "twitterurl", "x", "xurl", "xprofile"],
  instagram: ["instagram", "instagramurl", "instagramprofile"],
  github: ["github", "githuburl", "githubprofile"],
  website: ["website", "portfolio", "personalwebsite", "site"],
  // simple sheets with split columns
  city: ["city", "currentcity"],
  state: ["state", "province", "region"],
  country: ["country"],
  currentCompany: ["company", "currentcompany", "employer", "currentemployer", "organization", "organisation"],
  currentJobTitle: ["jobtitle", "currentjobtitle", "designation", "currentrole", "position", "title", "role"],
  degree: ["degree"],
  institution: ["institution", "college", "university", "school", "institute"],
};
const FIELD_BY_HEADER = new Map();
for (const [field, names] of Object.entries(ALIASES)) for (const n of names) if (!FIELD_BY_HEADER.has(n)) FIELD_BY_HEADER.set(n, field);

/** Find the header row (first 10 rows) and return { index, columns: Map(field -> col index), unmapped: [{header, col}] } */
const detectHeaders = (values) => {
  for (let r = 0; r < Math.min(values.length, 10); r++) {
    const row = values[r] || [];
    const columns = new Map();
    const unmapped = [];
    row.forEach((h, col) => {
      const field = FIELD_BY_HEADER.get(norm(h));
      if (field && !columns.has(field)) columns.set(field, col);
      else if (clean(h)) unmapped.push({ header: clean(h), col });
    });
    if (columns.has("fullName") && columns.size >= 2) return { index: r, columns, unmapped };
  }
  return null;
};

// ------------------------------------------------------------ value helpers
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

const shouting = (s) => s.length > 3 && s === s.toUpperCase() && /[A-Z]/.test(s);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-'(])([a-z])/g, (_, a, b) => a + b.toUpperCase());
/** "TERRENCE MOSLEY" -> "Terrence Mosley"; mixed-case text is left alone. */
const tidy = (v) => {
  const s = clean(v).replace(/\s+/g, " ");
  return shouting(s) ? titleCase(s) : s;
};

const parseUrl = (value) => {
  let v = clean(value).replace(/[),.;]+$/, "");
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(v) && !/\s/.test(v)) v = `https://${v}`;
    else return null;
  }
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
};

/** m/d/yyyy (the sheet's format) , yyyy-mm-dd, d-m-yyyy when day > 12 ... -> "YYYY-MM-DD" or null */
const parseDate = (value, order = "MDY") => {
  const v = clean(value);
  if (!v) return null;
  let y; let m; let d;
  let mt = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (mt) [, y, m, d] = mt;
  else if ((mt = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/))) {
    let a; let b;
    [, a, b, y] = mt;
    if (Number(a) > 12) [d, m] = [a, b];
    else if (Number(b) > 12) [m, d] = [a, b];
    else if (order === "DMY") [d, m] = [a, b];
    else [m, d] = [a, b];
  } else return null;
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 1900 || y > new Date().getUTCFullYear() + 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // 31 Feb etc.
  return dt.toISOString().slice(0, 10);
};

// ------------------------------------------------------------ structured cells
const KEY_LINE = /^\s*([A-Za-z][A-Za-z0-9_ ]{1,40}?)\s*:\s*(?!\/\/)(.*)$/;

/** "k: v" lines -> array of entries. A new entry starts at a blank line or when a key repeats. JSON cells are accepted too. */
const parseEntries = (text) => {
  const t = clean(text);
  if (!t) return [];
  if (/^[[{]/.test(t)) {
    try {
      const j = JSON.parse(t);
      const arr = Array.isArray(j) ? j : [j];
      return arr.filter((x) => x && typeof x === "object").map((o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [norm(k), clean(typeof v === "object" ? JSON.stringify(v) : v)])));
    } catch { /* fall through to line parsing */ }
  }
  const entries = [];
  for (const block of t.split(/\n\s*\n/)) {
    let cur = {};
    let lastKey = null;
    for (const line of block.split(/\r?\n/)) {
      if (!clean(line)) continue;
      const m = line.match(KEY_LINE);
      if (m) {
        const key = norm(m[1]);
        if (key in cur) { entries.push(cur); cur = {}; }
        cur[key] = clean(m[2]);
        lastKey = key;
      } else if (lastKey) {
        cur[lastKey] = clean(`${cur[lastKey]} ${line}`); // wrapped value
      } else {
        cur.text = clean(`${cur.text || ""} ${line}`);
      }
    }
    if (Object.keys(cur).length) entries.push(cur);
  }
  return entries;
};

const pick = (e, names) => {
  for (const n of names) if (clean(e[n])) return clean(e[n]);
  return "";
};

const yearOf = (v) => {
  const m = clean(v).match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
};

const parseAddress = (text) => {
  const entries = parseEntries(text);
  const e = entries[0] || {};
  const loc = {
    city: tidy(pick(e, ["city", "town", "locality"])),
    state: tidy(pick(e, ["state", "region", "province", "county"])),
    country: tidy(pick(e, ["country"])),
  };
  const street = pick(e, ["address", "addressline1", "street", "line1", "streetaddress"]);
  if (!loc.city && !loc.state && !loc.country && e.text) {
    // plain text: "Nairobi, Kenya" / "Bhopal, MP, India"
    const parts = e.text.split(",").map((x) => tidy(x)).filter(Boolean);
    if (parts.length === 1) loc.city = parts[0];
    else if (parts.length === 2) [loc.city, loc.country] = parts;
    else if (parts.length >= 3) [loc.city, loc.state, loc.country] = [parts[0], parts[1], parts[parts.length - 1]];
  }
  const location = Object.fromEntries(Object.entries(loc).filter(([, v]) => v));
  const raw = clean(text).replace(/\s*\n\s*/g, ", ");
  const address = [street, ...Object.values(location)].filter(Boolean).join(", ") || undefined;
  return { location, address: address || (raw ? raw.slice(0, 300) : undefined) };
};

const parseEducation = (text) =>
  parseEntries(text)
    .map((e) => {
      const out = {
        degree: pick(e, ["degree", "qualification", "degreename"]) || undefined,
        fieldOfStudy: pick(e, ["fieldofstudy", "major", "field", "specialization", "specialisation", "stream", "course"]) || undefined,
        institution: pick(e, ["institutionname", "institution", "school", "university", "college", "schoolname"]) || undefined,
        startYear: yearOf(pick(e, ["startyear", "startdate", "from", "fromyear"])),
        endYear: yearOf(pick(e, ["endyear", "enddate", "to", "graduationyear", "passingyear", "yearofpassing", "toyear"])),
      };
      if (!out.institution && !out.degree && e.text) out.institution = e.text.slice(0, 200);
      return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
    })
    .filter((o) => Object.keys(o).length);

const looseDate = (v) => {
  const s = clean(v);
  if (!s || /^(present|current|now|ongoing|till date)$/i.test(s)) return undefined;
  const iso = parseDate(s);
  if (iso) return iso;
  const my = s.match(/^(\d{1,2})[/-](\d{4})$/);
  if (my) return `${my[2]}-${String(my[1]).padStart(2, "0")}-01`;
  const y = s.match(/^(19|20)\d{2}$/);
  return y ? `${s}-01-01` : undefined;
};

const parseExperience = (text) =>
  parseEntries(text)
    .map((e) => {
      const out = {
        jobTitle: tidy(pick(e, ["jobtitle", "title", "position", "designation", "role"])) || undefined,
        company: clean(pick(e, ["employername", "employer", "company", "companyname", "organization", "organisation"])) || undefined,
        startDate: looseDate(pick(e, ["startdate", "start", "from", "fromdate"])),
        endDate: looseDate(pick(e, ["enddate", "end", "to", "todate"])),
      };
      if (!out.company && !out.jobTitle && e.text) out.company = e.text.slice(0, 200);
      return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
    })
    .filter((o) => Object.keys(o).length);

const SOCIAL_FIELD = { LINKEDIN: "linkedin", FACEBOOK: "facebook", TWITTER: "twitter", INSTAGRAM: "instagram", GITHUB: "github" };

/** URLs found in a free-form / key:value cell -> { byField, other, invalid } */
const parseSocial = (text) => {
  const byField = {};
  const other = [];
  const invalid = [];
  const t = clean(text);
  if (!t) return { byField, other, invalid };
  const candidates = [];
  for (const e of parseEntries(t)) {
    for (const v of Object.values(e)) candidates.push(...String(v).split(/[\s,;|]+/));
  }
  candidates.push(...t.split(/[\s,;|]+/));
  const seen = new Set();
  for (const raw of candidates) {
    const token = clean(raw);
    if (!token || /^[\w ]+:$/.test(token)) continue;
    if (!/[./]/.test(token)) continue; // not url-like
    const url = parseUrl(token);
    if (!url) { if (/^(https?:\/\/|www\.)/i.test(token)) invalid.push(token.slice(0, 200)); continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const key = platformFromHost(new URL(url).hostname.toLowerCase());
    const field = SOCIAL_FIELD[key];
    if (field && !byField[field]) byField[field] = url;
    else other.push(url);
  }
  return { byField, other, invalid };
};

const stable = (o) => JSON.stringify(o, Object.keys(o).sort());

// ------------------------------------------------------------ one row
/**
 * @returns { error } when the row cannot become a candidate (no name), else
 *   { candidate, source, invalid, rowKey, jobId }
 *   candidate  fields for the Candidate model (never contains blanks)
 *   source     informational sheet metadata (Candidate.sheetSource)
 *   invalid    [{field, value, reason}] values that were present but unusable
 */
const mapRow = (detected, row, { dateOrder = "MDY" } = {}) => {
  const cell = (field) => {
    const col = detected.columns.get(field);
    return col === undefined ? "" : clean(row[col]);
  };
  const fullName = tidy(cell("fullName"));
  if (!fullName) return { error: "name is missing" };

  const invalid = [];
  const candidate = { fullName, source: "GOOGLE_SHEET" };

  // email
  const emailRaw = cell("email");
  if (emailRaw) {
    const e = emailRaw.toLowerCase();
    if (EMAIL_RE.test(e)) candidate.email = e;
    else invalid.push({ field: "email", value: emailRaw.slice(0, 120), reason: "not a valid email address" });
  }
  // phone
  const phoneRaw = cell("phone");
  if (phoneRaw) {
    const digits = phoneRaw.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) candidate.phone = phoneRaw.slice(0, 40);
    else invalid.push({ field: "phone", value: phoneRaw.slice(0, 40), reason: "not a valid phone number" });
  }
  // date of birth
  const dobRaw = cell("dateOfBirth");
  if (dobRaw) {
    const iso = parseDate(dobRaw, dateOrder);
    if (iso) candidate.dateOfBirth = iso;
    else invalid.push({ field: "dateOfBirth", value: dobRaw.slice(0, 40), reason: "not a valid date" });
  }
  // address / location (structured column first, split columns fill gaps)
  const addr = parseAddress(cell("address"));
  const location = { ...addr.location };
  for (const k of ["city", "state", "country"]) if (!location[k] && cell(k)) location[k] = tidy(cell(k));
  if (Object.keys(location).length) candidate.location = location;
  if (addr.address) candidate.address = addr.address;

  // work experience + education
  const experience = parseExperience(cell("experience"));
  if (experience.length) {
    candidate.experience = experience;
    // the entry without an end date is the current job; else the first listed (assumed latest)
    const current = experience.find((x) => !x.endDate && (x.company || x.jobTitle)) || experience[0];
    if (current.company) candidate.currentCompany = current.company;
    if (current.jobTitle) candidate.currentJobTitle = current.jobTitle;
  }
  if (!candidate.currentCompany && cell("currentCompany")) candidate.currentCompany = clean(cell("currentCompany"));
  if (!candidate.currentJobTitle && cell("currentJobTitle")) candidate.currentJobTitle = tidy(cell("currentJobTitle"));
  let education = parseEducation(cell("education"));
  if (!education.length && (cell("degree") || cell("institution"))) {
    education = [Object.fromEntries(Object.entries({ degree: cell("degree"), institution: cell("institution") }).filter(([, v]) => v))];
  }
  if (education.length) candidate.education = education;

  // profile links: dedicated columns win, "Social Media Profiles" fills the rest
  const social = parseSocial(cell("social"));
  const other = [...social.other];
  for (const f of ["linkedin", "facebook", "twitter", "instagram", "github", "website"]) {
    const raw = cell(f);
    if (!raw) continue;
    const url = parseUrl(raw);
    if (url) candidate[f] = url;
    else invalid.push({ field: f, value: raw.slice(0, 200), reason: "not a valid URL" });
  }
  for (const [f, url] of Object.entries(social.byField)) {
    if (!candidate[f]) candidate[f] = url;
    else if (candidate[f] !== url) other.push(url);
  }
  for (const bad of social.invalid) invalid.push({ field: "socialProfiles", value: bad, reason: "not a valid URL" });

  // profile image
  const img = cell("imageUrl");
  if (img) {
    const u = parseUrl(img);
    if (u && u.startsWith("https://")) candidate.sourceImageUrl = u;
    else invalid.push({ field: "profileImage", value: img.slice(0, 120), reason: "not a valid https image URL" });
  }

  // source metadata (informational) + every unmapped column that holds something
  const extra = {};
  for (const { header, col } of detected.unmapped) {
    const v = clean(row[col]);
    if (v && Object.keys(extra).length < 30) extra[header.slice(0, 60)] = v.slice(0, 500);
  }
  const jobId = cell("jobId");
  const source = Object.fromEntries(
    Object.entries({
      jobId: jobId || undefined,
      tenantName: cell("tenantName") || undefined,
      createdDate: cell("createdDate") || undefined,
      duplicateStatus: cell("duplicateStatus") || undefined,
      createdBy: cell("createdBy") || undefined,
      assignedTo: cell("assignedTo") || undefined,
      otherProfiles: other.length ? other : undefined,
      extra: Object.keys(extra).length ? extra : undefined,
    }).filter(([, v]) => v !== undefined)
  );

  return { candidate, source, invalid, jobId: jobId || null, rowKey: rowKeyOf(candidate, jobId) };
};

const rowKeyOf = (c, jobId) => {
  const j = clean(jobId).toLowerCase();
  if (j) return `job:${j}`;
  if (c.email) return `email:${c.email}`;
  const digits = clean(c.phone).replace(/\D/g, "");
  if (digits.length >= 7) return `phone:${digits.slice(-10)}`;
  return `name:${crypto.createHash("sha1").update(`${c.fullName.toLowerCase()}|${(c.currentCompany || "").toLowerCase()}`).digest("hex").slice(0, 16)}`;
};

const hashOf = (candidate, source) =>
  crypto.createHash("sha1").update(JSON.stringify([candidate, source], (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v))).digest("hex");

// ------------------------------------------------------------ completeness
const PROFILE_FIELDS = ["linkedin", "facebook", "twitter", "instagram", "github", "website"];
const PROFILE_LABEL = { linkedin: "LinkedIn", facebook: "Facebook", twitter: "Twitter / X", instagram: "Instagram", github: "GitHub", website: "Website" };

const has = (v) => clean(v) !== "";
const validUrl = (v) => parseUrl(v) !== null;

/**
 * Judge a stored candidate (live, every time - so an edit is reflected at once).
 *
 *  required            name
 *  search identifiers  what the existing search pipeline can actually use:
 *                      email, phone, profile URLs, company, location, education
 *  level  COMPLETE     name + contact (email|phone|profile URL) + (company|education) + location
 *         SEARCHABLE   enough to run a meaningful search (a profile URL, or >= 2 identifiers)
 *                      but something recommended is missing
 *         INCOMPLETE   too little to search usefully (searching still possible via override)
 *  invalid             values that are present but unusable (bad email, URL, date, ...)
 */
const assessCompleteness = (c = {}, sheetSource = c.sheetSource) => {
  const profileUrls = PROFILE_FIELDS.filter((f) => has(c[f]));
  const company = has(c.currentCompany);
  const location = has(c.location?.city) || has(c.location?.country);
  const education = (c.education || []).some((e) => has(e?.institution));
  const email = has(c.email);
  const phone = has(c.phone);

  const identifiers = [];
  if (email) identifiers.push("email");
  if (phone) identifiers.push("phone");
  for (const f of profileUrls) identifiers.push(PROFILE_LABEL[f]);
  if (company) identifiers.push("current company");
  if (location) identifiers.push("location");
  if (education) identifiers.push("education");

  const anchors = [email, phone, company, location, education].filter(Boolean).length;
  const hasName = has(c.fullName);
  const searchable = hasName && (profileUrls.length >= 1 || anchors >= 2);
  const contact = email || phone || profileUrls.length >= 1;

  const missing = [];
  if (!hasName) missing.push("name");
  if (!contact) missing.push("email, phone or a profile URL");
  if (!company && !education) missing.push("current company or education");
  if (!location) missing.push("location (city or country)");

  const optionalMissing = [];
  if (!profileUrls.length) optionalMissing.push("profile URL (LinkedIn, Facebook, ...)");
  if (!has(c.currentJobTitle)) optionalMissing.push("job title");
  if (!c.dateOfBirth) optionalMissing.push("date of birth");
  if (!has(c.sourceImageUrl)) optionalMissing.push("profile image");

  // invalid: values stored on the candidate that are bad now, plus source values
  // that could not be imported and have not been replaced by a good value since
  const invalid = [];
  if (has(c.email) && !EMAIL_RE.test(String(c.email))) invalid.push({ field: "email", reason: "not a valid email address" });
  for (const f of PROFILE_FIELDS) if (has(c[f]) && !validUrl(c[f])) invalid.push({ field: f, reason: "not a valid URL" });
  const fieldOf = { profileImage: "sourceImageUrl", socialProfiles: null, dateOfBirth: "dateOfBirth" };
  for (const inv of sheetSource?.invalidFields || []) {
    const stored = inv.field in fieldOf ? (fieldOf[inv.field] ? c[fieldOf[inv.field]] : undefined) : c[inv.field];
    if (!has(stored) && !(stored instanceof Date)) invalid.push({ field: inv.field, reason: inv.reason, value: inv.value });
  }

  const complete = hasName && contact && (company || education) && location;
  const level = !hasName || !searchable ? "INCOMPLETE" : complete ? "COMPLETE" : "SEARCHABLE";
  return { level, required: ["name"], missing, optionalMissing, invalid, identifiers, searchable, needsAttention: level === "INCOMPLETE" || invalid.length > 0 };
};

module.exports = {
  norm, clean, detectHeaders, mapRow, rowKeyOf, hashOf, assessCompleteness,
  parseEntries, parseAddress, parseEducation, parseExperience, parseSocial, parseDate, parseUrl, tidy,
  EMAIL_RE, FIELD_BY_HEADER,
};
