/**
 * READ-ONLY report: finds SearchResult records that would break the
 * unique (bgvRun, profileUrl) sparse index. It never changes or deletes data.
 *
 *   node scripts/reportDuplicateSearchResults.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const SearchResult = require("../models/SearchResult");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const duplicates = await SearchResult.aggregate([
    { $match: { profileUrl: { $type: "string" } } },
    {
      $group: {
        _id: { bgvRun: "$bgvRun", profileUrl: "$profileUrl" },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (duplicates.length === 0) {
    console.log("No duplicates. The unique index can be built safely.");
  } else {
    console.log(`${duplicates.length} duplicated profile(s):`);
    duplicates.forEach((d) =>
      console.log(
        `  run ${d._id.bgvRun} | ${d._id.profileUrl} | x${d.count} | ids: ${d.ids.join(", ")}`
      )
    );
    console.log(
      "\nNothing was changed. Merge or remove the extra records before " +
        "restarting the server, otherwise the unique index cannot be created."
    );
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
