const mongoose = require("mongoose");

const identityGroupSchema = new mongoose.Schema(
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

    searchResults: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SearchResult",
      },
    ],

    confidenceScore: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },

    matchedSignals: {
      name: {
        type: Boolean,
        default: false,
      },

      company: {
        type: Boolean,
        default: false,
      },

      jobTitle: {
        type: Boolean,
        default: false,
      },

      location: {
        type: Boolean,
        default: false,
      },

      education: {
        type: Boolean,
        default: false,
      },

      username: {
        type: Boolean,
        default: false,
      },

      website: {
        type: Boolean,
        default: false,
      },
    },

    explanation: {
      type: String,
      trim: true,
    },

    reviewStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    reviewedAt: {
      type: Date,
    },

    reviewerNotes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

identityGroupSchema.index({ bgvRun: 1, reviewStatus: 1 });
// Cross-run knowledge base lookups: "confirmed groups of this candidate"
identityGroupSchema.index({ candidate: 1, reviewStatus: 1 });

const IdentityGroup = mongoose.model(
  "IdentityGroup",
  identityGroupSchema
);

module.exports = IdentityGroup;