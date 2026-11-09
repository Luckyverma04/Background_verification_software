const express = require("express");
const cors = require("cors");

// ==========================================
// ROUTES
// ==========================================
const candidateRoutes = require("./routes/candidate.routes");
const bgvRunRoutes = require("./routes/bgvRun.routes");
const searchResultRoutes = require("./routes/searchResult.routes");
const candidateMatchRoutes = require("./routes/candidateMatch.routes");
const identityGroupRoutes = require("./routes/identityGroup.routes");
const evidenceRoutes = require("./routes/evidence.routes");
const verificationLogRoutes = require("./routes/verificationLog.routes");
const uploadRoutes = require("./routes/upload.routes");
const sheetImportRoutes = require("./routes/sheetImport.routes");

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");

const { sendError } = require("./utils/http");
const { requireAuth } = require("./middleware/auth.middleware");

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
// Only the configured frontend origin(s) may call the API from a browser.
// CORS_ORIGIN is a comma list, e.g. "http://localhost:5173,https://bgv.example.com"
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));

// ==========================================
// HEALTH CHECK
// GET /api/health
// ==========================================
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "BGV Automation Backend is running 🚀",
  });
});

// ==========================================
// AUTH: everything below /api needs a logged-in user,
// except /api/health (above) and /api/auth/login
// ==========================================
app.use("/api/auth", authRoutes);
app.use("/api", requireAuth);

app.use("/api/users", userRoutes);
app.use("/api/candidates", candidateRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/sheet-import", sheetImportRoutes);
app.use("/api/bgv-runs", bgvRunRoutes);
app.use("/api/search-results", searchResultRoutes);
app.use("/api/candidate-matches", candidateMatchRoutes);
app.use("/api/identity-groups", identityGroupRoutes);
app.use("/api/evidence", evidenceRoutes);
app.use("/api/verification-logs", verificationLogRoutes);
app.use("/api/verified-identities", require("./routes/verifiedIdentity.routes"));

// ==========================================
// 404 + ERROR HANDLING (no stack traces / internal text in production)
// ==========================================
app.use((req, res) => {
  sendError(res, 404, "Route not found", null, {
    method: req.method,
    path: req.originalUrl,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") {
    return sendError(res, 400, "Request body is not valid JSON");
  }

  if (error?.type === "entity.too.large") {
    return sendError(res, 413, "Request body is too large");
  }

  console.error("Unhandled error:", error);

  return sendError(res, error?.status || 500, "Internal server error", error);
});

module.exports = app;
