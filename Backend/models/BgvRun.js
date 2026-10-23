const mongoose = require("mongoose");

const bgvRunSchema = new mongoose.Schema(
  {
    candidate: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Candidate",
      required: true,
    },

    runType: {
      type: String,
      enum: ["FULL", "SOCIAL", "EMPLOYMENT", "EDUCATION"],
      default: "FULL",
    },

    initiatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    status: {
      type: String,
      enum: [
        "PENDING",
        "SEARCHING",
        "MATCHING",
        "REVIEW_REQUIRED",
        "COMPLETED",
        "FAILED",
      ],
      default: "PENDING",
    },

    finalResult: {
      type: String,
      enum: [
        "PENDING",
        "CLEAR",
        "REVIEW_REQUIRED",
        "ISSUE_FOUND",
        "INCONCLUSIVE",
      ],
      default: "PENDING",
    },

    startedAt: {
      type: Date,
    },

    completedAt: {
      type: Date,
    },

    searchStartedAt: {
      type: Date,
    },

    searchCompletedAt: {
      type: Date,
    },

    totalSearchResults: {
      type: Number,
      default: 0,
    },

    matchedResults: {
      type: Number,
      default: 0,
    },

    reviewRequired: {
      type: Number,
      default: 0,
    },

    reviewedAt: {
      type: Date,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    notes: {
      type: String,
      trim: true,
    },

    // How complete the external search was (provider calls, errors,
    // platforms covered, ...). Used to tell "nothing found" apart from
    // "search was incomplete".
    searchSummary: {
      type: mongoose.Schema.Types.Mixed,
    },

    // Why finalResult has its value (human readable, auditable)
    finalResultReasons: {
      type: [String],
      default: [],
    },

    finalResultComputedAt: {
      type: Date,
    },

    error: {
      message: {
        type: String,
        trim: true,
      },
      code: {
        type: String,
        trim: true,
      },
    },
  },
  {
    timestamps: true,
  }
);

const BgvRun = mongoose.model("BgvRun", bgvRunSchema);

module.exports = BgvRun;