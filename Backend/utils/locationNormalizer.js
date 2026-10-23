"use strict";

/**
 * Candidate location normalisation for SEARCH QUERIES and matching.
 *
 * Input is user-entered and sometimes self-contradictory ("Dewas" +
 * "Maharashtra"; Dewas is in Madhya Pradesh). A conflicting pair in one
 * query sends the search engine to the wrong region, so we repair it here.
 *
 * Rules:
 *  - Only UNAMBIGUOUS Indian city names are corrected (a city that exists in
 *    several states is left alone).
 *  - Nothing is invented: unknown city -> unchanged; missing field -> stays
 *    empty (a missing location is never a mismatch).
 *  - Stored data is never modified; callers get a normalised copy.
 */

const STATE_ALIASES = {
  "madhya pradesh": ["mp", "m.p.", "m p", "madhyapradesh"],
  maharashtra: ["mh", "maharastra"],
  "uttar pradesh": ["up", "u.p.", "uttarpradesh"],
  rajasthan: ["rj"],
  gujarat: ["gj"],
  karnataka: ["ka"],
  "tamil nadu": ["tn", "tamilnadu"],
  telangana: ["ts"],
  "andhra pradesh": ["ap"],
  kerala: ["kl"],
  "west bengal": ["wb"],
  delhi: ["new delhi", "nct of delhi", "dl"],
  punjab: ["pb"],
  haryana: ["hr"],
  bihar: ["br"],
  odisha: ["orissa", "od"],
  chhattisgarh: ["cg", "chattisgarh"],
  jharkhand: ["jh"],
  uttarakhand: ["uk", "uttaranchal"],
  assam: ["as"],
  "himachal pradesh": ["hp"],
  "jammu and kashmir": ["j&k", "jk", "jammu & kashmir"],
  goa: ["ga"],
  chandigarh: ["ch"],
};

const CITY_TO_STATE = {
  "madhya pradesh": ["dewas", "indore", "bhopal", "ujjain", "gwalior", "jabalpur", "ratlam", "sagar", "satna", "rewa", "khandwa", "khargone", "mandsaur", "neemuch", "shajapur", "sehore", "vidisha", "hoshangabad", "narmadapuram", "chhindwara", "burhanpur", "dhar", "betul", "morena", "bhind", "damoh", "katni", "singrauli", "pithampur", "mhow", "itarsi", "badnagar", "nagda"],
  maharashtra: ["mumbai", "pune", "nagpur", "nashik", "thane", "kolhapur", "solapur", "amravati", "navi mumbai", "pimpri chinchwad", "akola", "latur", "sangli", "jalgaon", "nanded", "ahmednagar", "chandrapur", "satara", "ratnagiri"],
  "uttar pradesh": ["lucknow", "kanpur", "noida", "ghaziabad", "agra", "varanasi", "prayagraj", "allahabad", "meerut", "bareilly", "aligarh", "moradabad", "gorakhpur", "greater noida", "mathura", "jhansi", "saharanpur", "firozabad"],
  rajasthan: ["jaipur", "jodhpur", "udaipur", "kota", "bikaner", "alwar", "bhilwara", "sikar", "bharatpur", "jhunjhunu"],
  gujarat: ["ahmedabad", "surat", "vadodara", "rajkot", "gandhinagar", "bhavnagar", "jamnagar", "anand", "bharuch", "morbi"],
  karnataka: ["bengaluru", "bangalore", "mysuru", "mysore", "mangaluru", "mangalore", "hubli", "dharwad", "belagavi", "belgaum", "davanagere", "ballari", "shivamogga"],
  "tamil nadu": ["chennai", "coimbatore", "madurai", "tiruchirappalli", "trichy", "salem", "tirunelveli", "erode", "vellore", "hosur", "thanjavur"],
  telangana: ["hyderabad", "secunderabad", "warangal", "karimnagar", "nizamabad", "khammam"],
  "andhra pradesh": ["visakhapatnam", "vizag", "vijayawada", "guntur", "tirupati", "nellore", "kakinada", "rajahmundry", "kurnool", "anantapur"],
  kerala: ["kochi", "cochin", "thiruvananthapuram", "trivandrum", "kozhikode", "calicut", "thrissur", "kollam", "kannur", "palakkad"],
  "west bengal": ["kolkata", "calcutta", "howrah", "durgapur", "siliguri", "asansol", "kharagpur"],
  delhi: ["delhi", "new delhi"],
  punjab: ["ludhiana", "amritsar", "jalandhar", "patiala", "mohali", "bathinda"],
  haryana: ["gurgaon", "gurugram", "faridabad", "panipat", "karnal", "ambala", "hisar", "rohtak", "sonipat"],
  bihar: ["patna", "gaya", "muzaffarpur", "bhagalpur", "darbhanga", "purnia"],
  odisha: ["bhubaneswar", "cuttack", "rourkela", "berhampur", "sambalpur", "puri"],
  chhattisgarh: ["raipur", "bhilai", "durg", "korba", "jagdalpur"],
  jharkhand: ["ranchi", "jamshedpur", "dhanbad", "bokaro"],
  uttarakhand: ["dehradun", "haridwar", "roorkee", "haldwani", "rishikesh"],
  assam: ["guwahati", "dibrugarh", "silchar", "jorhat"],
  "himachal pradesh": ["shimla", "solan", "dharamshala", "manali"],
  goa: ["panaji", "margao", "vasco da gama"],
  chandigarh: ["chandigarh"],
};

const INDIA_ALIASES = new Set(["india", "in", "ind", "bharat", "republic of india"]);

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const key = (v) => clean(v).toLowerCase().replace(/[.,]/g, "").replace(/\s+/g, " ");

const stateByAlias = new Map();
for (const [state, aliases] of Object.entries(STATE_ALIASES)) {
  stateByAlias.set(key(state), state);
  for (const a of aliases) stateByAlias.set(key(a), state);
}
const cityMap = new Map();
for (const [state, cities] of Object.entries(CITY_TO_STATE)) {
  for (const c of cities) cityMap.set(key(c), state);
}

const title = (s) => s.replace(/\b[a-z]/g, (m) => m.toUpperCase()).replace(/\bAnd\b/, "and");

const canonicalState = (v) => {
  const s = stateByAlias.get(key(v));
  return s ? title(s) : null;
};

const isIndia = (v) => INDIA_ALIASES.has(key(v));

/**
 * @returns {{city:string,state:string,country:string,corrections:string[],conflicts:string[],inferred:{}}}
 */
const normalizeLocation = (input) => {
  const out = { city: "", state: "", country: "", corrections: [], conflicts: [], inferred: {} };
  if (!input) return out;

  if (typeof input === "string") {
    out.country = clean(input);
    return out;
  }
  out.city = clean(input.city);
  out.state = clean(input.state);
  out.country = clean(input.country);

  // state aliases (MP -> Madhya Pradesh) - only when it is a known state
  const canonState = out.state ? canonicalState(out.state) : null;
  if (canonState && canonState !== out.state) {
    out.corrections.push(`state "${out.state}" -> "${canonState}"`);
    out.state = canonState;
  }

  // a non-Indian state (e.g. "Oregon") means this is not the Indian city of that name
  const stateIsIndian = !out.state || Boolean(canonicalState(out.state));
  const countryIsIndia = (!out.country || isIndia(out.country)) && stateIsIndian;
  const cityState = out.city && stateIsIndian ? cityMap.get(key(out.city)) : null;

  if (cityState && countryIsIndia) {
    const cityStateTitle = title(cityState);
    if (out.state && key(out.state) !== key(cityStateTitle)) {
      // Known city beats a contradicting state: the query must not mix them.
      out.conflicts.push(`city "${out.city}" is in ${cityStateTitle}, not "${out.state}"`);
      out.corrections.push(`state "${out.state}" -> "${cityStateTitle}"`);
      out.state = cityStateTitle;
    } else if (!out.state) {
      out.state = cityStateTitle;
      out.inferred.state = true;
    }
    if (!out.country) {
      out.country = "India";
      out.inferred.country = true;
    }
  } else if (cityState && !(!out.country || isIndia(out.country))) {
    out.conflicts.push(`city "${out.city}" is an Indian city but country is "${out.country}"`);
  }

  if (!out.country && out.state && canonicalState(out.state)) {
    out.country = "India";
    out.inferred.country = true;
  }
  if (out.country && isIndia(out.country)) out.country = "India";
  return out;
};

/**
 * Ordered location tiers for queries: most specific first, then controlled
 * fallbacks. Each tier is the list of location phrases to pair with the name.
 */
const locationTiers = (loc) => {
  const l = loc && loc.corrections ? loc : normalizeLocation(loc);
  const primary = [];
  const fallback = [];
  if (l.city) primary.push([l.city, l.state].filter(Boolean));
  if (l.city && !l.state && l.country) primary.push([l.city, l.country]);
  if (l.state) fallback.push([l.state]);
  if (l.country) fallback.push([l.country]);
  return { primary, fallback };
};

module.exports = { normalizeLocation, locationTiers, canonicalState, isIndia };
