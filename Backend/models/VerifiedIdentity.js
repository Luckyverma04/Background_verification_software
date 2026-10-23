const mongoose = require("mongoose");

/**
 * Permanent, candidate-linked registry of profiles a HUMAN reviewer confirmed
 * as belonging to a candidate.
 *
 * - One row per (candidate, canonical profile URL): unique index => concurrent
 *   requests can never create two identities for the same profile.
 * - Rows are never deleted. Withdrawing a verification sets status REVOKED and
 *   appends to `history` (who / when / why), so the audit trail survives.
 * - Only an explicit reviewer action creates/updates a row (match review,
 *   identity-group review, manual "Add profile" with verification). Name
 *   similarity or an ML score never does.
 * - Verifying one profile says nothing about the candidate as a whole: a
 *   candidate can have many VERIFIED rows.
 */
const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: {
      type: String,
      enum: ["VERIFIED", "RE_VERIFIED", "REVOKED", "FLAGGED_FOR_REVIEW", "CLEARED_FLAG", "REAPPLIED"],
      required: true,
    },
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    byLabel: { type: String, trim: true },
    method: { type: String, trim: true },
    bgvRun: { type: mongoose.Schema.Types.ObjectId, ref: "BgvRun" },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const verifiedIdentitySchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },

    platform: { type: String, required: true, trim: true },
    // normalized URL (what the SearchResult stores) and its canonical key
    profileUrl: { type: String, required: true, trim: true },
    profileKey: { type: String, required: true, trim: true },
    profileId: { type: String, trim: true },
    username: { type: String, trim: true },
    displayName: { type: String, trim: true },

    status: { type: String, enum: ["VERIFIED", "REVOKED"], default: "VERIFIED" },

    verifiedAt: { type: Date, required: true },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    verifiedByLabel: { type: String, trim: true },
    verificationMethod: {
      type: String,
      enum: ["MATCH_REVIEW", "IDENTITY_GROUP", "MANUAL_ADD", "BACKFILL"],
      required: true,
    },
    reviewerNotes: { type: String, trim: true },

    // where it was first / last confirmed or seen
    firstVerifiedInRun: { type: mongoose.Schema.Types.ObjectId, ref: "BgvRun" },
    lastSeenInRun: { type: mongoose.Schema.Types.ObjectId, ref: "BgvRun" },
    sourceSearchResult: { type: mongoose.Schema.Types.ObjectId, ref: "SearchResult" },
    sourceCandidateMatch: { type: mongoose.Schema.Types.ObjectId, ref: "CandidateMatch" },
    sourceIdentityGroup: { type: mongoose.Schema.Types.ObjectId, ref: "IdentityGroup" },

    // Evidence supporting the verification (snapshot + links to Evidence rows)
    evidenceSnapshot: { type: mongoose.Schema.Types.Mixed },
    evidenceRefs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Evidence" }],

    // What was true when the reviewer confirmed. A later, materially different
    // value is flagged for review instead of being assumed to be the same identity.
    fingerprint: {
      platform: String,
      username: String,
      profileId: String,
      name: String,
    },

    needsReReview: {
      flag: { type: Boolean, default: false },
      reasons: [String],
      detectedAt: Date,
      bgvRun: { type: mongoose.Schema.Types.ObjectId, ref: "BgvRun" },
    },

    history: [historySchema],
  },
  { timestamps: true }
);

verifiedIdentitySchema.index({ candidate: 1, profileKey: 1 }, { unique: true });
verifiedIdentitySchema.index({ candidate: 1, status: 1 });

module.exports = mongoose.model("VerifiedIdentity", verifiedIdentitySchema);
