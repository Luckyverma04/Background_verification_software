const mongoose = require("mongoose");
require("dotenv").config();

const app = require("./app");

const PORT = process.env.PORT || 5000;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error(
    "JWT_SECRET is missing or shorter than 32 characters. Add a long random value to .env, e.g.\n" +
      "  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  );
  process.exit(1);
}

// ==========================================
// DATABASE CONNECTION
// ==========================================
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected successfully ✅");

    // Unique indexes (no duplicate profiles / matches / evidence) are built
    // in the background. Say clearly when one cannot be built.
    Promise.allSettled(
      Object.values(mongoose.models).map((model) => model.init())
    ).then((outcomes) => {
      outcomes.forEach((outcome, i) => {
        if (outcome.status === "rejected") {
          console.error(
            `Index build FAILED for ${Object.keys(mongoose.models)[i]}: ${outcome.reason?.message}\n` +
              "  -> existing duplicate records block a unique index. " +
              "Run `npm run report:duplicates` (read-only) to see them."
          );
        }
      });
    });

    await require("./controllers/auth.controller").ensureFirstAdmin();

    require("./services/sheetImport.service").startAutoSync();

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("MongoDB connection failed ❌");
    console.error(error.message);
    process.exit(1);
  });
