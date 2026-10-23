const mongoose = require("mongoose");

const searchResultSchema = new mongoose.Schema(
  {
    // Kis BGV run se ye result belong karta hai
    bgvRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BgvRun",
      required: true,
    },

    // Search kis platform par mila
    platform: {
      type: String,
      enum: [
        "LINKEDIN",
        "INSTAGRAM",
        "FACEBOOK",
        "TWITTER",
        "GITHUB",
        "YOUTUBE",
        "MEDIUM",
        "STACKOVERFLOW",
        "LEETCODE",
        "HACKERRANK",
        "KAGGLE",
        "BEHANCE",
        "DRIBBBLE",
        "QUORA",
        "THREADS",
        "REDDIT",
        "PINTEREST",
        "DEVTO",
        "NAUKRI",
        "ABOUT_ME",
        "LINKTREE",
        "GITLAB",
        "BITBUCKET",
        "HASHNODE",
        "PEERLIST",
        "HUGGINGFACE",
        "RESEARCHGATE",
        "ORCID",
        "SCHOLAR",
        "CODEPEN",
        "CODECHEF",
        "WEBSITE",
        "OTHER",
      ],
      required: true,
    },

    // Profile/page URL
    profileUrl: {
      type: String,
      trim: true,
    },

    // Public platform ID / profile slug
    // Example: LinkedIn -> rahul-sharma-9599545
    profileId: {
      type: String,
      trim: true,
    },

    // Username / handle
    // Example: Instagram -> rahul123
    username: {
      type: String,
      trim: true,
    },

    // Publicly displayed name
    name: {
      type: String,
      trim: true,
    },

    // Public profile image
    // Example: LinkedIn/Instagram/GitHub profile photo
    profileImageUrl: {
      type: String,
      trim: true,
    },

    // Other image URLs if provider/source gives multiple images
    profileImageUrls: [
      {
        type: String,
        trim: true,
      },
    ],

    headline: {
      type: String,
      trim: true,
    },

    // Public profile description. Only filled from a structured source
    // (GitHub API, page meta/JSON-LD), never from a search snippet.
    bio: {
      type: String,
      trim: true,
    },

    previousEmployers: [
      {
        company: String,
        title: String,
        startDate: String,
        endDate: String,
      },
    ],

    // Other public profiles / websites linked from this profile
    linkedProfiles: [
      {
        platform: String,
        url: String,
      },
    ],

    // Enrichment audit: sources, retrieval time, UNKNOWN fields, limitations
    enrichment: {
      type: mongoose.Schema.Types.Mixed,
    },

    company: {
      type: String,
      trim: true,
    },

    jobTitle: {
      type: String,
      trim: true,
    },

    location: {
      city: String,
      state: String,
      country: String,
    },

    education: [
      {
        institution: String,
        degree: String,
        fieldOfStudy: String,
      },
    ],

    // Search source type
    source: {
      type: String,
      enum: [
        "WEB_SEARCH",
        "SEARCH_API",
        "PLATFORM_API",
        "MANUAL",
        // A profile a human already confirmed in an EARLIER run
        // (reused from the identity knowledge base, never auto-approved)
        "KNOWLEDGE_BASE",
      ],
      default: "WEB_SEARCH",
    },

    // Actual search provider
    // Example: TAVILY / SERPER
    searchProvider: {
      type: String,
      enum: [
        "TAVILY",
        "SERPER",
        "MANUAL",
        "OTHER",
      ],
      default: "OTHER",
    },

    // Provider ka result ID, agar provider deta hai
    // Tavily -> available
    // Serper -> usually null
    providerResultId: {
      type: String,
      trim: true,
    },

    // Original/source URL
    sourceUrl: {
      type: String,
      trim: true,
    },

    discoveredAt: {
      type: Date,
      default: Date.now,
    },

    // Original provider response / extra information
    rawData: {
      type: mongoose.Schema.Types.Mixed,
    },
  },
  {
    timestamps: true,
  }
);

// One stored record per public profile inside a BGV run.
// `sparse` skips documents without a profileUrl. If the index cannot be
// built, the collection already holds duplicates - run
// `npm run report:duplicates` to see them (read-only report).
searchResultSchema.index(
  { bgvRun: 1, profileUrl: 1 },
  { unique: true, sparse: true }
);

// Fast lookups when listing a run's results
searchResultSchema.index({ bgvRun: 1, createdAt: -1 });

const SearchResult = mongoose.model(
  "SearchResult",
  searchResultSchema
);

module.exports = SearchResult;