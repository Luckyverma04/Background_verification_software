const { URL } = require("url");
const {
  platformFromHost,
  usernameFromPath,
} = require("../utils/platforms");
const { canonicalProfileKey } = require("../utils/candidateUrls");

// ======================================================
// BASIC HELPERS
// ======================================================

const normalizeUrl = (url) => {
  if (!url) return null;

  try {
    const parsedUrl = new URL(String(url).trim());

    parsedUrl.hash = "";

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "fbclid",
      "gclid",
    ];

    trackingParams.forEach((param) => {
      parsedUrl.searchParams.delete(param);
    });

    parsedUrl.hostname = parsedUrl.hostname.toLowerCase();

    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, "");

    return parsedUrl.toString();
  } catch (error) {
    return String(url).trim();
  }
};

// ======================================================
// PLATFORM
// ======================================================

const detectPlatform = (url) => {
  if (!url) return "OTHER";

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return platformFromHost(hostname) || "WEBSITE";
  } catch (error) {
    return "OTHER";
  }
};

// ======================================================
// TEXT HELPERS
// ======================================================

const cleanText = (value) => {
  if (!value) return null;

  const cleaned = String(value)
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || null;
};

const cleanName = (value) => {
  if (!value) return null;

  return cleanText(
    String(value)
      .replace(
        /^(profile|page|user|account|linkedin|facebook|instagram|github)\s*[:\-]\s*/i,
        ""
      )
      .trim()
  );
};

// ======================================================
// PROFILE IDENTIFIER
// ======================================================

const extractProfileIdentifier = (url, platform) => {
  if (!url) {
    return {
      profileId: null,
      username: null,
    };
  }

  try {
    const parsedUrl = new URL(url);

    const pathParts = parsedUrl.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    switch (platform) {
      case "LINKEDIN": {
        const inIndex = pathParts.findIndex(
          (part) => part.toLowerCase() === "in"
        );

        if (inIndex !== -1 && pathParts[inIndex + 1]) {
          const identifier = pathParts[inIndex + 1];

          return {
            profileId: identifier,
            username: identifier,
          };
        }

        break;
      }

      case "INSTAGRAM": {
        const firstPart = pathParts[0];

        if (
          firstPart &&
          ![
            "accounts",
            "explore",
            "reels",
            "p",
            "about",
            "direct",
          ].includes(firstPart.toLowerCase())
        ) {
          return {
            profileId: firstPart,
            username: firstPart,
          };
        }

        break;
      }

      case "GITHUB": {
        const firstPart = pathParts[0];

        if (
          firstPart &&
          ![
            "features",
            "topics",
            "explore",
            "orgs",
            "settings",
          ].includes(firstPart.toLowerCase())
        ) {
          return {
            profileId: firstPart,
            username: firstPart,
          };
        }

        break;
      }

      case "TWITTER": {
        const firstPart = pathParts[0];

        if (
          firstPart &&
          ![
            "home",
            "explore",
            "search",
            "hashtag",
            "i",
            "intent",
          ].includes(firstPart.toLowerCase())
        ) {
          return {
            profileId: firstPart,
            username: firstPart,
          };
        }

        break;
      }

      case "FACEBOOK": {
        if (
          pathParts[0] &&
          pathParts[0].toLowerCase() !== "profile.php" &&
          pathParts[0].toLowerCase() !== "p"
        ) {
          return {
            profileId: pathParts[0],
            username: pathParts[0],
          };
        }

        if (
          pathParts[0]?.toLowerCase() === "p" &&
          pathParts[1]
        ) {
          return {
            profileId: pathParts[1],
            username: null,
          };
        }

        const facebookId = parsedUrl.searchParams.get("id");

        if (facebookId) {
          return {
            profileId: facebookId,
            username: null,
          };
        }

        break;
      }

      default: {
        // YOUTUBE, MEDIUM, STACKOVERFLOW, LEETCODE, KAGGLE, ...
        const handle = usernameFromPath(
          platform,
          pathParts
        );

        if (handle) {
          return {
            profileId: handle,
            username: handle,
          };
        }

        break;
      }
    }

    return {
      profileId: null,
      username: null,
    };
  } catch (error) {
    return {
      profileId: null,
      username: null,
    };
  }
};

// ======================================================
// SEARCH TEXT
// ======================================================

const getSearchText = (result) => {
  if (!result) return "";

  const pieces = [
    result.title,
    result.snippet,
    result.content,
  ];

  return pieces
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
};

// ======================================================
// COMPANY VALIDATION
// ======================================================

const isValidCompany = (value) => {
  if (!value) return false;

  const cleaned = cleanText(value);

  if (!cleaned) return false;

  if (cleaned.length < 2 || cleaned.length > 120) {
    return false;
  }

  // "of working in the IT industry", "at the moment": not a name
  if (!/^[A-Z0-9@]/.test(cleaned)) {
    return false;
  }

  const invalidPhrases = [
    "bootcamp",
    "software developer",
    "developer",
    "engineer",
    "resume",
    "profile",
    "success",
    "placement",
    "cgpa",
    "college",
    "university",
    "institute",
    "about this session",
  ];

  const lower = cleaned.toLowerCase();

  if (
    invalidPhrases.some((phrase) =>
      lower.includes(phrase)
    )
  ) {
    return false;
  }

  return true;
};

// ======================================================
// COMPANY EXTRACTION
// ======================================================

const extractCompany = (
  text,
  platform,
  rawResult = null
) => {
  const sources = [];

  // ----------------------------------------------------
  // Structured data
  // ----------------------------------------------------

  if (
    rawResult &&
    typeof rawResult === "object"
  ) {
    const structuredCompanyValues = [
      rawResult.company,
      rawResult.currentCompany,
      rawResult.organization,
      rawResult.organisation,
    ];

    for (const value of structuredCompanyValues) {
      if (
        typeof value === "string" &&
        value.trim() &&
        isValidCompany(value)
      ) {
        sources.push(value);
      }
    }

    if (Array.isArray(rawResult.experience)) {
      for (const experience of rawResult.experience) {
        if (
          experience &&
          typeof experience.company === "string" &&
          experience.company.trim() &&
          isValidCompany(experience.company)
        ) {
          sources.push(experience.company);
        }
      }
    }

    if (
      rawResult.profile &&
      typeof rawResult.profile === "object"
    ) {
      const profileCompany =
        rawResult.profile.company ||
        rawResult.profile.currentCompany;

      if (
        typeof profileCompany === "string" &&
        profileCompany.trim() &&
        isValidCompany(profileCompany)
      ) {
        sources.push(profileCompany);
      }
    }
  }

  // ----------------------------------------------------
  // Text extraction
  // ----------------------------------------------------

  if (text) {
    const normalized = text
      .replace(/\s+/g, " ")
      .trim();

    const patterns = [
      /(?:works?\s+at|working\s+at|currently\s+at|employed\s+at)\s+([A-Z][A-Za-z0-9&.'()\- ]{1,100}?)(?=\s*(?:$|[;|,\n\u00b7\u2022]|\.\s|\.$|\s[-\u2013\u2014]\s|\s(?:in|since|from|as)\s))/i,

      /(?:developer|engineer|designer|manager|analyst|consultant|architect|scientist|specialist|director|founder|co-founder|executive|officer|intern|lead|sde|swe)\s+(?:at|@)\s*([A-Z][A-Za-z0-9&.'()\- ]{1,100}?)(?=\s*(?:$|[;|,\n\u00b7\u2022]|\.\s|\.$|\s[-\u2013\u2014]\s|\s(?:in|since|from|as)\s))/i,

      /(?:company|organization|organisation)\s*[:\-]\s*([^.;|,\n]+)/i,

      /(?:current\s+company|current\s+organization|current\s+organisation)\s*[:\-]\s*([^.;|,\n]+)/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);

      if (match?.[1] && isValidCompany(match[1])) {
        sources.push(match[1]);
      }
    }

    if (platform === "LINKEDIN") {
      const linkedinPatterns = [
        /\bat\s+([A-Z][A-Za-z0-9&.'()\- ]{1,100}?)(?=\s*(?:$|[;|,\n\u00b7\u2022]|\.\s|\.$|\s[-\u2013\u2014]\s))/i,

        /\bof\s+([A-Z][A-Za-z0-9&.'()\- ]{1,100}?)(?=\s*(?:$|[;|,\n\u00b7\u2022]|\.\s|\.$|\s[-\u2013\u2014]\s))/i,
      ];

      for (const pattern of linkedinPatterns) {
        const match = normalized.match(pattern);

        if (
          match?.[1] &&
          isValidCompany(match[1])
        ) {
          sources.push(match[1]);
        }
      }
    }
  }

  const cleanedCompanies = [
    ...new Set(
      sources
        .map((value) => cleanText(value))
        .filter(Boolean)
        .filter(isValidCompany)
    ),
  ];

  if (!cleanedCompanies.length) {
    return null;
  }

  return cleanedCompanies[0];
};

// ======================================================
// JOB TITLE VALIDATION
// ======================================================

const isValidJobTitle = (value) => {
  if (!value) return false;

  const cleaned = cleanText(value);

  if (!cleaned) return false;

  if (
    cleaned.length < 2 ||
    cleaned.length > 100
  ) {
    return false;
  }

  const lower = cleaned.toLowerCase();

  // ----------------------------------------------------
  // Person name should NEVER be job title
  // Example:
  // Rahul Sharma -> invalid
  // ----------------------------------------------------

  if (
    /^[a-z]+(?:\s+[a-z]+){1,4}$/i.test(
      cleaned
    ) &&
    !lower.includes("developer") &&
    !lower.includes("engineer") &&
    !lower.includes("manager") &&
    !lower.includes("designer") &&
    !lower.includes("analyst")
  ) {
    return false;
  }

  // ----------------------------------------------------
  // Page/search phrases
  // ----------------------------------------------------

  const invalidPhrases = [
    "with rahul",
    "with me",
    "with us",
    "rahul sharma's success",
    "success",
    "placement",
    "about this session",
    "profile for",
    "profile",
    "resume",
    "actor:",
    "cgpa",
    "college",
    "university",
    "institute",
    "bootcamp",
    "my portfolio",
    "search code",
    "loading",
  ];

  if (
    invalidPhrases.some((phrase) =>
      lower.includes(phrase)
    )
  ) {
    return false;
  }

  // ----------------------------------------------------
  // Must contain a job-related word
  // ----------------------------------------------------

  const validJobWords = [
    "developer",
    "engineer",
    "designer",
    "manager",
    "analyst",
    "consultant",
    "architect",
    "scientist",
    "specialist",
    "director",
    "founder",
    "officer",
    "intern",
    "lead",
  ];

  if (
    !validJobWords.some((word) =>
      lower.includes(word)
    )
  ) {
    return false;
  }

  return true;
};

// ======================================================
// JOB TITLE CLEANING
// ======================================================

const cleanJobTitle = (value) => {
  if (!value) return null;

  let title = cleanText(value);

  if (!title) return null;

  // Remove common trailing profile/page text
  title = title
    .replace(
      /\s*[-|]\s*(LinkedIn|Facebook|Instagram|GitHub|X|Twitter).*$/i,
      ""
    )
    .trim();

  // Remove trailing company phrase
  title = title
    .replace(
      /\s+(?:at|@)\s+[A-Z][A-Za-z0-9&.,'()\- ]{2,100}$/i,
      ""
    )
    .trim();

  // Normalize separators
  title = title
    .replace(/\s*[|]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!title) return null;

  return isValidJobTitle(title)
    ? title
    : null;
};

// ======================================================
// JOB TITLE EXTRACTION
// ======================================================

const extractJobTitle = (
  text,
  title,
  platform,
  rawResult = null
) => {
  const structuredTitles = [];

  // ----------------------------------------------------
  // 1. Structured provider data
  // ----------------------------------------------------

  if (
    rawResult &&
    typeof rawResult === "object"
  ) {
    const values = [
      rawResult.jobTitle,
      rawResult.currentJobTitle,
      rawResult.position,
      rawResult.role,
    ];

    for (const value of values) {
      if (
        typeof value === "string" &&
        value.trim()
      ) {
        structuredTitles.push(value);
      }
    }

    // Nested profile
    if (
      rawResult.profile &&
      typeof rawResult.profile === "object"
    ) {
      const profileTitle =
        rawResult.profile.jobTitle ||
        rawResult.profile.position ||
        rawResult.profile.role;

      if (
        typeof profileTitle === "string" &&
        profileTitle.trim()
      ) {
        structuredTitles.push(
          profileTitle
        );
      }
    }

    // Experience
    if (Array.isArray(rawResult.experience)) {
      for (const experience of rawResult.experience) {
        if (!experience) continue;

        if (
          typeof experience.title === "string" &&
          experience.title.trim()
        ) {
          structuredTitles.push(
            experience.title
          );
        }

        if (
          typeof experience.jobTitle === "string" &&
          experience.jobTitle.trim()
        ) {
          structuredTitles.push(
            experience.jobTitle
          );
        }
      }
    }
  }

  // ----------------------------------------------------
  // Prefer structured specific title
  // ----------------------------------------------------

  const cleanedStructuredTitles =
    structuredTitles
      .map(cleanJobTitle)
      .filter(Boolean);

  // Prefer longer/more specific title
  if (cleanedStructuredTitles.length) {
    cleanedStructuredTitles.sort(
      (a, b) => b.length - a.length
    );

    return cleanedStructuredTitles[0];
  }

  // ----------------------------------------------------
  // 2. Text extraction
  // ----------------------------------------------------

  const combined = [text]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!combined) {
    return null;
  }

  // ----------------------------------------------------
  // Specific title patterns FIRST
  // ----------------------------------------------------

  const specificPatterns = [
    /\b(senior\s+software\s+developer)\b/i,

    /\b(junior\s+software\s+developer)\b/i,

    /\b(lead\s+software\s+developer)\b/i,

    /\b(principal\s+software\s+developer)\b/i,

    /\b(software\s+developer)\b/i,

    /\b(software\s+engineer)\b/i,

    /\b(frontend\s+developer)\b/i,

    /\b(front-end\s+developer)\b/i,

    /\b(backend\s+developer)\b/i,

    /\b(back-end\s+developer)\b/i,

    /\b(full[\s-]?stack\s+developer)\b/i,

    /\b(web\s+developer)\b/i,

    /\b(mobile\s+developer)\b/i,

    /\b(data\s+scientist)\b/i,

    /\b(data\s+analyst)\b/i,

    /\b(product\s+manager)\b/i,

    /\b(project\s+manager)\b/i,

    /\b(engineering\s+manager)\b/i,

    /\b(software\s+designer)\b/i,

    /\b(ui\/ux\s+designer)\b/i,
  ];

  for (const pattern of specificPatterns) {
    const match = combined.match(pattern);

    if (match?.[1]) {
      const cleaned = cleanJobTitle(
        match[1]
      );

      if (cleaned) {
        return cleaned;
      }
    }
  }

  // ----------------------------------------------------
  // Explicit title statements
  // ----------------------------------------------------

  const explicitPatterns = [
    /(?:job\s+title|position|role)\s*[:\-]\s*([^.;|,\n]+)/i,

    /(?:works?\s+as|working\s+as|joined\s+as)\s+(?:a|an)?\s*([^.;|,\n]+?)(?=\s+(?:at|in|with|from)\s+|$)/i,

    /(?:is\s+a|is\s+an)\s+([^.;|,\n]+?)(?=\s+(?:at|in|with|from)\s+|$)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = combined.match(pattern);

    if (match?.[1]) {
      const cleaned =
        cleanJobTitle(match[1]);

      if (cleaned) {
        return cleaned;
      }
    }
  }

  // ----------------------------------------------------
  // Generic fallback LAST
  // ----------------------------------------------------

  const genericPatterns = [
    /\b(developer)\b/i,
    /\b(engineer)\b/i,
    /\b(designer)\b/i,
    /\b(manager)\b/i,
    /\b(analyst)\b/i,
    /\b(consultant)\b/i,
    /\b(architect)\b/i,
    /\b(scientist)\b/i,
    /\b(specialist)\b/i,
    /\b(director)\b/i,
    /\b(founder)\b/i,
    /\b(co-founder)\b/i,
    /\b(intern)\b/i,
    /\b(lead)\b/i,
  ];

  for (const pattern of genericPatterns) {
    const match = combined.match(pattern);

    if (match?.[1]) {
      const cleaned =
        cleanJobTitle(match[1]);

      if (cleaned) {
        return cleaned;
      }
    }
  }

  return null;
};

// ======================================================
// LOCATION VALIDATION
// ======================================================

const isValidLocation = (location) => {
  if (!location) return false;

  const invalidPhrases = [
    "bootcamp",
    "software developer",
    "developer",
    "engineer",
    "college",
    "university",
    "institute",
    "cgpa",
    "resume",
    "profile",
    "experience",
    "career",
    "placement",
    "company",
    "technologies",
    "success",
    "session",
  ];

  const values = [
    location.city,
    location.state,
    location.country,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    invalidPhrases.some((phrase) =>
      values.includes(phrase)
    )
  ) {
    return false;
  }

  return true;
};

// ======================================================
// PARSE LOCATION
// ======================================================

const parseLocation = (locationText) => {
  if (!locationText) return null;

  const parts = locationText
    .split(",")
    .map((part) => cleanText(part))
    .filter(Boolean);

  if (!parts.length) {
    return null;
  }

  for (let i = 0; i < parts.length; i++) {
    parts[i] = parts[i].replace(/[.\s]+$/, "");
  }

  if (parts.length === 1) {
    return {
      city: parts[0],
      state: null,
      country: null,
    };
  }

  if (parts.length === 2) {
    return {
      city: parts[0],
      state: parts[1],
      country: null,
    };
  }

  return {
    city: parts[0],
    state: parts[1],
    country: parts[2],
  };
};

// ======================================================
// LOCATION EXTRACTION
// ======================================================

const extractLocation = (text) => {
  if (!text) return null;

  const normalized = text
    .replace(/\s+/g, " ")
    .trim();

  // ----------------------------------------------------
  // Explicit location
  // ----------------------------------------------------

  const explicitPatterns = [
    /(?:location)\s*[:\-]\s*([A-Z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3}(?:,\s*[A-Z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3}){0,2})/i,

    /(?:based\s+in|located\s+in|lives?\s+in)\s+([A-Z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3}(?:,\s*[A-Z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,3}){0,2})/,
  ];

  for (const pattern of explicitPatterns) {
    const match = normalized.match(pattern);

    if (match?.[1]) {
      const location =
        parseLocation(match[1]);

      if (
        location &&
        isValidLocation(location)
      ) {
        return location;
      }
    }
  }

  // ----------------------------------------------------
  // Indian location
  // ----------------------------------------------------

  const indianPattern =
    /\b([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2}),\s*(Madhya Pradesh|Maharashtra|Delhi|NCT of Delhi|Karnataka|Rajasthan|Gujarat|Uttar Pradesh|Haryana|Punjab|Tamil Nadu|Telangana|West Bengal|Kerala|Bihar|Odisha|Goa|Andhra Pradesh|Assam|Jharkhand|Chhattisgarh|Uttarakhand|Himachal Pradesh|Jammu and Kashmir|Chandigarh|Puducherry|Tripura|Meghalaya|Manipur|Nagaland|Mizoram|Arunachal Pradesh|Sikkim)(?:,\s*(India))?\b/;

  const indianMatch =
    normalized.match(indianPattern);

  if (indianMatch) {
    const location = {
      city: cleanText(indianMatch[1]),
      state: cleanText(indianMatch[2]),
      country:
        cleanText(indianMatch[3]) ||
        "India",
    };

    if (isValidLocation(location)) {
      return location;
    }
  }

  // ----------------------------------------------------
  // City + country
  // ----------------------------------------------------

  const countryPattern =
    /\b([A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2}),\s*(India|USA|US|UK|Canada|Australia|United States|United Kingdom|United Arab Emirates|UAE|Singapore|Germany)\b/;

  const countryMatch =
    normalized.match(countryPattern);

  if (countryMatch) {
    const location = {
      city: cleanText(countryMatch[1]),
      state: null,
      country: cleanText(countryMatch[2]),
    };

    if (isValidLocation(location)) {
      return location;
    }
  }

  // No reliable location
  return null;
};

// ======================================================
// EDUCATION
// ======================================================

const extractEducation = (text) => {
  if (!text) return [];

  const education = [];

  const add = (value) => {
    const institution = cleanText(String(value || "").replace(/[\s.,;:]+$/, ""));
    if (!institution || institution.length < 3 || institution.length > 100) return;
    if (education.some((e) => e.institution.toLowerCase() === institution.toLowerCase())) return;
    education.push({ institution, degree: null, fieldOfStudy: null });
  };

  // "Education: X" / "studied at X" -- up to the next separator
  const labelled = text.match(
    /(?:studied\s+at|studied\s+in|graduated\s+from|alumni\s+of|education\s*[:\-])\s*([^;|\n\u00b7\u2022]+?)(?=\s*(?:$|[;|\n\u00b7\u2022]|\.\s|\.$))/i
  );
  if (labelled?.[1]) add(labelled[1]);

  // A full institution name: capitalised words around University / College /
  // Institute, e.g. "Indian Institute of Technology, Indore", "Delhi University".
  if (!education.length) {
    const W = "[A-Z][A-Za-z&'-]*";
    const re = new RegExp(
      `\\b((?:${W}\\s+(?:(?:of|and|for|&)\\s+)?){0,5}(?:University|College|Institute|Academy)(?:\\s+(?:of|and|for|&)\\s+${W}(?:\\s+${W}){0,3})?(?:,\\s*[A-Z][a-z]+(?=$|[\\s.;|\u00b7\u2022]))?)`
    );
    const m = text.match(re);
    if (m?.[1]) add(m[1]);
  }

  // Common abbreviations: IIT Indore, NIT Trichy, IIIT Hyderabad, BITS Pilani
  if (!education.length) {
    const m = text.match(/\b((?:IIT|IIIT|NIT|BITS|IIM)\s+[A-Z][a-z]+)\b/);
    if (m?.[1]) add(m[1]);
  }

  return education;
};

// ======================================================
// NAME
// ======================================================

const extractName = (title, text) => {
  if (title) {
    let name = cleanText(title);

    name = name
      .replace(
        /\s*[-|]\s*(LinkedIn|Facebook|Instagram|GitHub|X|Twitter).*$/i,
        ""
      )
      .trim();

    if (name) {
      return cleanName(name);
    }
  }

  if (text) {
    const firstLine = text
      .split("\n")
      .map((line) => cleanText(line))
      .find(Boolean);

    if (firstLine) {
      return cleanName(firstLine);
    }
  }

  return null;
};

// ======================================================
// TAVILY NORMALIZATION
// ======================================================

const normalizeTavilyResultRaw = (result) => {
  const profileUrl =
    normalizeUrl(result?.url);

  if (!profileUrl) return null;

  const platform =
    detectPlatform(profileUrl);

  const {
    profileId,
    username,
  } = extractProfileIdentifier(
    profileUrl,
    platform
  );

  const text = getSearchText(result);

  const name = extractName(
    result.title,
    text
  );

  const company = extractCompany(
    text,
    platform,
    result
  );

  const jobTitle = extractJobTitle(
    text,
    result.title,
    platform,
    result
  );

  const location =
    extractLocation(text);

  const education =
    extractEducation(text);

  const imageUrls =
    Array.isArray(result.images)
      ? result.images.filter(Boolean)
      : [];

  const primaryImage =
    result.image ||
    imageUrls[0] ||
    null;

  return {
    platform,

    profileUrl,

    profileId,

    username,

    name,

    profileImageUrl:
      primaryImage,

    profileImageUrls:
      imageUrls,

    headline:
      cleanText(result.title),

    company,

    jobTitle,

    location,

    education,

    searchProvider:
      "TAVILY",

    providerResultId:
      result.id || null,

    source:
      "SEARCH_API",

    title:
      result.title || null,

    snippet:
      result.content || null,

    relevanceScore:
      typeof result.score === "number"
        ? result.score
        : null,

    rawData: result,
  };
};

// ======================================================
// SERPER NORMALIZATION
// ======================================================

const normalizeSerperResultRaw = (result) => {
  const profileUrl =
    normalizeUrl(result?.link);

  if (!profileUrl) return null;

  const platform =
    detectPlatform(profileUrl);

  const {
    profileId,
    username,
  } = extractProfileIdentifier(
    profileUrl,
    platform
  );

  const text = getSearchText(result);

  const name = extractName(
    result.title,
    text
  );

  const company = extractCompany(
    text,
    platform,
    result
  );

  const jobTitle = extractJobTitle(
    text,
    result.title,
    platform,
    result
  );

  const location =
    extractLocation(text);

  const education =
    extractEducation(text);

  const imageUrls =
    Array.isArray(result.images)
      ? result.images.filter(Boolean)
      : [];

  const primaryImage =
    result.imageUrl ||
    result.image ||
    imageUrls[0] ||
    null;

  return {
    platform,

    profileUrl,

    profileId,

    username,

    name,

    profileImageUrl:
      primaryImage,

    profileImageUrls:
      imageUrls,

    headline:
      cleanText(result.title),

    company,

    jobTitle,

    location,

    education,

    searchProvider:
      "SERPER",

    providerResultId:
      null,

    source:
      "SEARCH_API",

    title:
      result.title || null,

    snippet:
      result.snippet || null,

    relevanceScore:
      null,

    rawData: result,
  };
};


// ======================================================
// TITLE STRUCTURE + FIELD TIDYING
// ======================================================
//
// A LinkedIn search title is structured: "Name - Title - Company | LinkedIn".
// That is far more reliable than regexes over free text (which, for example,
// picked "Previously at Wipro" as the current company, dropped "Senior" from
// a title, or glued "LinkedIn" onto the city).

const TITLE_WORDS =
  /\b(engineer|developer|manager|analyst|consultant|architect|scientist|specialist|director|founder|executive|officer|intern|lead|designer|head|president|professor|teacher|doctor|physician|surgeon|cardiologist|nurse|lawyer|advocate|accountant|associate|administrator|coordinator|recruiter|programmer|student|freelancer|owner|partner|vp|ceo|cto|cfo)\b/i;

const trimEdgePunctuation = (value) => {
  const out = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:|\-\u2013\u2014]+|[\s.,;:|\-\u2013\u2014]+$/g, "")
    .trim();
  return out || null;
};

// "Bhopal, Madhya Pradesh, India", "Greater Mumbai Area", "Pune" (1-4 words,
// no digits) -- the shape LinkedIn uses for the location part of a title.
const INDIA_STATES =
  /\b(madhya pradesh|maharashtra|delhi|karnataka|rajasthan|gujarat|uttar pradesh|haryana|punjab|tamil nadu|telangana|west bengal|kerala|bihar|odisha|goa|andhra pradesh|assam|jharkhand|chhattisgarh|uttarakhand|himachal pradesh|jammu and kashmir|chandigarh)\b/i;
const looksLikeLocation = (value) => {
  const v = String(value || "").trim();
  if (!v || /\d/.test(v) || TITLE_WORDS.test(v)) return false;
  if (/\b(area|region|metropolitan)\b/i.test(v)) return true;
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return false;
  if (!parts.every((x) => /^[A-Z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,3}$/.test(x))) return false;
  return INDIA_STATES.test(v) || /\b(india|usa|united states|united kingdom|uk|canada|australia|uae|singapore|germany)\b/i.test(v);
};

const COUNTRY_NAMES =
  /^(india|usa|us|united states|united states of america|uk|united kingdom|canada|australia|uae|united arab emirates|singapore|germany|france|netherlands|ireland|new zealand|japan|china|nepal|bangladesh|sri lanka|pakistan|south africa|saudi arabia|qatar)$/i;

// "City, Country" puts the country in `country`, not in `state`.
const parseLocationSmart = (text) => {
  const loc = parseLocation(text);
  if (!loc) return loc;
  if (loc.state && !loc.country && COUNTRY_NAMES.test(loc.state)) {
    return { city: loc.city, state: null, country: loc.state };
  }
  if (loc.city && !loc.state && !loc.country && COUNTRY_NAMES.test(loc.city)) {
    return { city: null, state: null, country: loc.city };
  }
  return loc;
};

const parseTitleStructure = (title, platform) => {
  const empty = { name: null, jobTitle: null, company: null, location: null };
  if (!title || platform !== "LINKEDIN") return empty;

  const body = String(title)
    .replace(/\s*[|\u2013\u2014-]\s*LinkedIn\s*$/i, "")
    .replace(/\s*\|\s*(?:Professional Profile|Profile)\s*$/i, "")
    .trim();
  const parts = body.split(/\s+[-\u2013\u2014]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return empty;

  const out = { name: parts[0], jobTitle: null, company: null, location: null };

  // "Name - City, State, Country" (location instead of title / company)
  const rest = parts.slice(1);
  if (looksLikeLocation(rest[rest.length - 1])) out.location = rest.pop();

  if (rest.length >= 2) {
    out.jobTitle = rest[0];
    out.company = rest.slice(1).join(" - ");
  } else if (rest.length === 1) {
    const second = rest[0];
    const at = second.match(/^(.+?)\s+at\s+(.+)$/i);
    if (at) {
      out.jobTitle = at[1];
      out.company = at[2];
    } else if (TITLE_WORDS.test(second)) {
      out.jobTitle = second;
    } else {
      out.company = second;
    }
  }

  // "..." / location-only fragments are not a company or title
  for (const k of ["jobTitle", "company"]) {
    if (out[k] && (/\.\.\.$/.test(out[k]) || out[k].length > 90)) out[k] = null;
  }
  return out;
};

const LOCATION_NOISE = /^(?:linkedin|github|facebook|instagram|twitter|x|profile|view|\|)\s+/i;

// The person's display name from the page title, per platform:
//   GitHub     "user (Full Name) · GitHub"            -> Full Name ("user · GitHub" -> none)
//   Instagram  "Full Name (@user) • Instagram ..."   -> Full Name
//   X          "Full Name (@user) / X", "... on X: ..." -> Full Name
//   LinkedIn   "Full Name on LinkedIn: ..." (posts)  -> Full Name
//   any        "Full Name | Facebook", "Full Name - YouTube"
const PLATFORM_TAIL =
  /\s*(?:[|\u00b7\u2022/]|\s[-\u2013\u2014])\s*(?:LinkedIn|Facebook|Instagram(?:\s+photos.*)?|GitHub|X|Twitter|YouTube|Medium|Kaggle|Behance|Dribbble|GitLab|Stack Overflow|Quora|Reddit|LeetCode|HackerRank|Threads|Pinterest)\b.*$/i;

const nameFromTitle = (title, platform) => {
  const t = cleanText(title);
  if (!t) return undefined;
  let m;
  if (platform === "GITHUB") {
    if ((m = t.match(/^\S+\s+\(([^()@]{2,80})\)\s*(?:[\u00b7\u2022|-]\s*GitHub)?/i))) return m[1].trim();
    if (/^[\w.-]+\s*[\u00b7\u2022|-]\s*GitHub/i.test(t)) return null; // only a username
    if (/^GitHub\s*-\s*/i.test(t)) return null; // a repository page
  }
  if ((m = t.match(/^(.{2,80}?)\s*\(@[\w.]{1,40}\)/))) return m[1].trim();
  if ((m = t.match(/^(.{2,80}?)\s+on\s+(?:LinkedIn|X|Twitter|Instagram|Facebook)\s*:/i))) return m[1].trim();
  if (/^@[\w.]+\s*[\u00b7\u2022|]/.test(t)) return null; // only a handle
  const stripped = t.replace(PLATFORM_TAIL, "").trim();
  if (stripped && stripped !== t) return stripped;
  return undefined; // no opinion
};

// LinkedIn snippets are "·"-separated and often labelled:
//   "Senior Software Engineer at TCS · Experience: TCS · Education: IIT Indore · Location: Bhopal · 500+ connections"
//   "Bhopal, Madhya Pradesh, India · Software Engineer · TCS"
const parseLinkedInSnippet = (snippet) => {
  const out = {};
  const segs = String(snippet || "").split(/\s*[\u00b7\u2022]\s*/).map((x) => x.trim()).filter(Boolean);
  segs.forEach((seg, i) => {
    let m;
    if ((m = seg.match(/^Experience\s*:\s*(.+)$/i))) out.company = trimEdgePunctuation(m[1]);
    else if ((m = seg.match(/^Education\s*:\s*(.+)$/i))) out.education = trimEdgePunctuation(m[1]);
    else if ((m = seg.match(/^Location\s*:\s*(.+)$/i))) out.location = trimEdgePunctuation(m[1]);
    else if (i === 0 && looksLikeLocation(seg)) out.location = seg;
  });
  // "Bhopal, Madhya Pradesh, India · Software Engineer · TCS. Experienced ..."
  if (out.location && !out.company && segs.length >= 3 && TITLE_WORDS.test(segs[1]) && !/:/.test(segs[2])) {
    const company = trimEdgePunctuation(segs[2].split(/\.\s/)[0]);
    if (company && /^[A-Z0-9]/.test(company) && company.split(/\s+/).length <= 6) {
      out.jobTitle = trimEdgePunctuation(segs[1]);
      out.company = company;
    }
  }
  return out;
};

const refineFields = (obj, result) => {
  if (!obj) return obj;

  const ts = parseTitleStructure(result?.title, obj.platform);

  if (ts.name && ts.name.split(/\s+/).length <= 5) {
    obj.name = ts.name;
  } else {
    const n = nameFromTitle(result?.title, obj.platform);
    if (n !== undefined) obj.name = n && n.split(/\s+/).length <= 5 ? cleanName(n) : null;
  }
  if (ts.company) obj.company = ts.company;
  if (ts.jobTitle) obj.jobTitle = ts.jobTitle;
  if (ts.location) obj.location = parseLocationSmart(ts.location);

  if (obj.platform === "LINKEDIN") {
    const sn = parseLinkedInSnippet(result?.snippet || result?.content);
    if (sn.company && !ts.company) obj.company = sn.company;
    if (sn.jobTitle && !ts.jobTitle) obj.jobTitle = sn.jobTitle;
    if (sn.education) obj.education = [{ institution: sn.education, degree: null, fieldOfStudy: null }];
    if (sn.location && !ts.location) obj.location = parseLocationSmart(sn.location);
  }

  obj.company = trimEdgePunctuation(obj.company);
  obj.jobTitle = trimEdgePunctuation(obj.jobTitle);

  if (obj.location && obj.location.city) {
    let city = obj.location.city;
    while (LOCATION_NOISE.test(city)) city = city.replace(LOCATION_NOISE, "");
    obj.location = { ...obj.location, city: trimEdgePunctuation(city) };
  }
  if (obj.location) {
    for (const k of ["state", "country"]) {
      if (obj.location[k]) obj.location[k] = trimEdgePunctuation(obj.location[k]);
    }
  }

  return obj;
};

const normalizeTavilyResult = (result) => refineFields(normalizeTavilyResultRaw(result), result);
const normalizeSerperResult = (result) => refineFields(normalizeSerperResultRaw(result), result);

// ======================================================
// MERGE HELPERS
// ======================================================

const pickBetterValue = (
  existing,
  incoming
) => {
  if (!existing && incoming) {
    return incoming;
  }

  return existing;
};

const mergeLocation = (
  existing,
  incoming
) => {
  if (!existing && !incoming) {
    return null;
  }

  const result = {
    city: null,
    state: null,
    country: null,
  };

  if (existing) {
    result.city =
      existing.city || null;

    result.state =
      existing.state || null;

    result.country =
      existing.country || null;
  }

  if (incoming) {
    result.city =
      result.city ||
      incoming.city ||
      null;

    result.state =
      result.state ||
      incoming.state ||
      null;

    result.country =
      result.country ||
      incoming.country ||
      null;
  }

  if (!isValidLocation(result)) {
    return null;
  }

  return result;
};

const mergeEducation = (
  existing = [],
  incoming = []
) => {
  const combined = [
    ...existing,
    ...incoming,
  ];

  const map = new Map();

  for (const item of combined) {
    if (!item) continue;

    const key = [
      item.institution,
      item.degree,
      item.fieldOfStudy,
    ]
      .filter(Boolean)
      .join("|")
      .toLowerCase();

    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, item);
    }
  }

  return Array.from(map.values());
};

// ======================================================
// MERGE SEARCH RESULTS
// ======================================================

const mergeSearchResults = (
  tavilyResults = [],
  serperResults = []
) => {
  const resultMap = new Map();

  const allResults = [
    ...tavilyResults.map(
      normalizeTavilyResult
    ),

    ...serperResults.map(
      normalizeSerperResult
    ),
  ].filter(Boolean);

  for (const result of allResults) {
    // canonical key: www / in. / http / twitter-vs-x variants dedupe
    const key =
      canonicalProfileKey(result.profileUrl) ||
      result.profileUrl;

    // --------------------------------------------------
    // First result
    // --------------------------------------------------

    if (!resultMap.has(key)) {
      resultMap.set(key, {
        ...result,

        providers: [
          result.searchProvider,
        ],

        providerResultIds:
          result.providerResultId
            ? [result.providerResultId]
            : [],

        providerResults: [
          result.rawData,
        ],
      });

      continue;
    }

    // --------------------------------------------------
    // Existing result
    // --------------------------------------------------

    const existing =
      resultMap.get(key);

    if (
      !existing.providers.includes(
        result.searchProvider
      )
    ) {
      existing.providers.push(
        result.searchProvider
      );
    }

    if (
      result.providerResultId &&
      !existing.providerResultIds.includes(
        result.providerResultId
      )
    ) {
      existing.providerResultIds.push(
        result.providerResultId
      );
    }

    if (result.rawData) {
      existing.providerResults.push(
        result.rawData
      );
    }

    // --------------------------------------------------
    // Merge fields
    // --------------------------------------------------

    existing.name =
      pickBetterValue(
        existing.name,
        result.name
      );

    existing.profileId =
      pickBetterValue(
        existing.profileId,
        result.profileId
      );

    existing.username =
      pickBetterValue(
        existing.username,
        result.username
      );

    existing.title =
      pickBetterValue(
        existing.title,
        result.title
      );

    existing.headline =
      pickBetterValue(
        existing.headline,
        result.headline
      );

    existing.company =
      pickBetterValue(
        existing.company,
        result.company
      );

    // --------------------------------------------------
    // Job title:
    // Prefer specific title over generic title
    // --------------------------------------------------

    const existingTitle =
      cleanJobTitle(
        existing.jobTitle
      );

    const incomingTitle =
      cleanJobTitle(
        result.jobTitle
      );

    if (!existingTitle) {
      existing.jobTitle =
        incomingTitle;
    } else if (!incomingTitle) {
      existing.jobTitle =
        existingTitle;
    } else if (
      incomingTitle.length >
      existingTitle.length
    ) {
      existing.jobTitle =
        incomingTitle;
    } else {
      existing.jobTitle =
        existingTitle;
    }

    existing.location =
      mergeLocation(
        existing.location,
        result.location
      );

    existing.education =
      mergeEducation(
        existing.education,
        result.education
      );

    existing.snippet =
      pickBetterValue(
        existing.snippet,
        result.snippet
      );

    existing.profileImageUrl =
      pickBetterValue(
        existing.profileImageUrl,
        result.profileImageUrl
      );

    // --------------------------------------------------
    // All profile images
    // --------------------------------------------------

    const existingImages =
      existing.profileImageUrls || [];

    const newImages =
      result.profileImageUrls || [];

    existing.profileImageUrls = [
      ...new Set([
        ...existingImages,
        ...newImages,
      ]),
    ];

    if (
      !existing.profileImageUrl &&
      existing.profileImageUrls.length
    ) {
      existing.profileImageUrl =
        existing.profileImageUrls[0];
    }

    // --------------------------------------------------
    // Relevance score
    // --------------------------------------------------

    if (
      result.relevanceScore !== null &&
      (
        existing.relevanceScore === null ||
        result.relevanceScore >
          existing.relevanceScore
      )
    ) {
      existing.relevanceScore =
        result.relevanceScore;
    }
  }

  return Array.from(
    resultMap.values()
  );
};

// ======================================================
// EXPORTS
// ======================================================

module.exports = {
  nameFromTitle,
  parseLinkedInSnippet,
  parseTitleStructure,
  normalizeUrl,

  detectPlatform,

  extractProfileIdentifier,

  extractCompany,

  extractJobTitle,

  extractLocation,

  extractEducation,

  extractName,

  normalizeTavilyResult,

  normalizeSerperResult,

  mergeSearchResults,
};