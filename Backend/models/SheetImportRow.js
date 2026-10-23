const mongoose = require("mongoose");

/**
 * Bookkeeping for the Google Sheet import: which sheet row became which
 * candidate, and where that candidate stands in the review -> search flow.
 *
 * The unique {sheetId, rowKey} index is what makes repeated, retried, parallel
 * or restarted syncs safe: the same source row can never create two candidates.
 * rowKey is the sheet's stable "Job ID" (falls back to email / phone / name).
 */
const sheetImportRowSchema = new mongoose.Schema(
  {
    sheetId: { type: String, required: true },
    tab: String,
    rowKey: { type: String, required: true },
    jobId: String,
    rowNumber: Number,
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate" },

    status: {
      type: String,
      enum: ["CLAIMED", "IMPORTED", "LINKED_EXISTING"],
      default: "CLAIMED",
    },
    // when LINKED_EXISTING: the row matched a candidate that already existed
    duplicateReason: String,

    importedAt: Date,
    lastSeenAt: Date,

    // field-level synchronisation (see sheetImport.service.js)
    sourceHash: String,
    snapshot: mongoose.Schema.Types.Mixed, // source values as of the last sync
    lastUpdatedFromSourceAt: Date,

    // ---- review -> search flow ----
    // REVIEW   imported, waiting for the reviewer (default: NO search runs)
    // QUEUED   reviewer confirmed + started the queue; waits its turn
    // RUNNING  search + matching in progress (one candidate at a time)
    // DONE     results saved               FAILED  see searchError (retryable)
    searchStatus: {
      type: String,
      enum: ["REVIEW", "QUEUED", "RUNNING", "DONE", "FAILED"],
      default: "REVIEW",
    },
    confirmedAt: Date,
    confirmedBy: String,
    // reviewer explicitly accepted searching although data is missing / invalid
    incompleteOverride: { type: Boolean, default: false },

    bgvRun: { type: mongoose.Schema.Types.ObjectId, ref: "BgvRun" },
    queuedAt: Date,
    searchStartedAt: Date,
    searchFinishedAt: Date,
    searchError: String,
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

sheetImportRowSchema.index({ sheetId: 1, rowKey: 1 }, { unique: true });
sheetImportRowSchema.index({ searchStatus: 1, queuedAt: 1 });
sheetImportRowSchema.index({ candidate: 1 });

module.exports = mongoose.model("SheetImportRow", sheetImportRowSchema);
