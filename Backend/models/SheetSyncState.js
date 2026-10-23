const mongoose = require("mongoose");

// One document per spreadsheet: when it was last read, so "last successful
// sync" survives a restart.
const sheetSyncStateSchema = new mongoose.Schema(
  {
    sheetId: { type: String, required: true, unique: true },
    tab: String,
    lastAttemptAt: Date,
    lastSuccessAt: Date,
    lastError: String,
    lastSummary: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);

module.exports = mongoose.model("SheetSyncState", sheetSyncStateSchema);
