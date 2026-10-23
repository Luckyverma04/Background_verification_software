const mongoose = require("mongoose");

const evidenceSchema = new mongoose.Schema(
  {
    bgvRun: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "BgvRun",
      required: true,
    },

    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Candidate",
      required: true,
    },

    // The SearchResult / profile from which this evidence came
    searchResult: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SearchResult",
    },

    // CandidateMatch associated with this evidence
    candidateMatch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CandidateMatch",
    },

    // IdentityGroup associated with this evidence, if applicable
    identityGroup: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "IdentityGroup",
    },

    evidenceType: {
      type: String,
      enum: [
        "PROFILE",
        "NAME",
        "USERNAME",
        "COMPANY",
        "JOB_TITLE",
        "LOCATION",
        "EDUCATION",
        "EMAIL",
        "PHONE",
        "WEBSITE",
        "SOCIAL_LINK",
        "PROFILE_IMAGE",
        "CROSS_PLATFORM",
        "OTHER",
      ],
      required: true,
    },

    sourcePlatform: {
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
      default: "OTHER",
    },

    sourceUrl: {
      type: String,
      trim: true,
    },

    field: {
      type: String,
      trim: true,
    },

    observedValue: {
      type: String,
      trim: true,
    },

    candidateValue: {
      type: String,
      trim: true,
    },

    matchScore: {
      type: Number,
      min: 0,
      max: 100,
    },

    description: {
      type: String,
      trim: true,
    },

    capturedAt: {
      type: Date,
      default: Date.now,
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Retries / parallel requests can never create the same evidence twice.
evidenceSchema.index(
  { candidateMatch: 1, searchResult: 1, evidenceType: 1, field: 1 },
  { unique: true, sparse: true }
);
evidenceSchema.index({ bgvRun: 1, createdAt: -1 });

const Evidence = mongoose.model("Evidence", evidenceSchema);

module.exports = Evidence;