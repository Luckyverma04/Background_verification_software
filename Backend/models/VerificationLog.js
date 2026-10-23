const mongoose = require("mongoose");

const verificationLogSchema = new mongoose.Schema(
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

    action: {
      type: String,
      enum: [
        "RUN_CREATED",
        "SEARCH_STARTED",
        "SEARCH_COMPLETED",
        "MATCHING_STARTED",
        "MATCHING_COMPLETED",
        "PROFILE_APPROVED",
        "PROFILE_REJECTED",
        "IDENTITY_GROUP_CREATED",
        "IDENTITY_GROUP_MERGED",
        "EVIDENCE_CREATED",
        "STATUS_CHANGED",
        "FINAL_RESULT",
        "SEARCH_FAILED",
        "MATCHING_FAILED",
        "KNOWLEDGE_BASE_REUSED",
      ],
      required: true,
    },

    previousStatus: {
      type: String,
      trim: true,
    },

    newStatus: {
      type: String,
      trim: true,
    },

    description: {
      type: String,
      trim: true,
    },

    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    // Makes retries safe: the same event is stored only once.
    idempotencyKey: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

verificationLogSchema.index({ bgvRun: 1, createdAt: 1 });
verificationLogSchema.index(
  { idempotencyKey: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("VerificationLog", verificationLogSchema);