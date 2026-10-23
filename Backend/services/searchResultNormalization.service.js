const SearchResult = require("../models/SearchResult");

const {
  normalizeTavilyResult,
  normalizeSerperResult,
} = require("./resultMerge.service");

// ==========================================
// RE-NORMALIZE EXISTING SEARCH RESULTS
// ==========================================
const renormalizeExistingSearchResults = async ({
  bgvRunId,
}) => {
  const filter = bgvRunId
    ? { bgvRun: bgvRunId }
    : {};

  const searchResults =
    await SearchResult.find(filter);

  let updated = 0;
  let skipped = 0;

  for (const searchResult of searchResults) {
    try {
      const rawData = searchResult.rawData;

      if (!rawData) {
        skipped++;
        continue;
      }

      /*
       * Our merge service stores provider responses
       * inside:
       *
       * rawData.providers
       * rawData.providerResults
       */

      const providerResults =
        rawData.providerResults || [];

      const providers =
        rawData.providers || [];

      let normalized = null;

      // ------------------------------------------
      // Try each original provider result
      // ------------------------------------------

      for (
        let i = 0;
        i < providerResults.length;
        i++
      ) {
        const providerResult =
          providerResults[i];

        const provider =
          providers[i] ||
          searchResult.searchProvider;

        let result = null;

        if (
          provider === "TAVILY"
        ) {
          result =
            normalizeTavilyResult(
              providerResult
            );
        }

        if (
          provider === "SERPER"
        ) {
          result =
            normalizeSerperResult(
              providerResult
            );
        }

        if (!result) {
          continue;
        }

        // ----------------------------------------
        // First valid normalized result
        // ----------------------------------------

        if (!normalized) {
          normalized = result;
          continue;
        }

        // ----------------------------------------
        // Fill missing data
        // ----------------------------------------

        normalized.name =
          normalized.name ||
          result.name;

        normalized.profileId =
          normalized.profileId ||
          result.profileId;

        normalized.username =
          normalized.username ||
          result.username;

        normalized.company =
          normalized.company ||
          result.company;

        normalized.jobTitle =
          normalized.jobTitle ||
          result.jobTitle;

        normalized.headline =
          normalized.headline ||
          result.headline;

        normalized.location =
          normalized.location ||
          result.location;

        normalized.education =
          normalized.education?.length
            ? normalized.education
            : result.education || [];

        normalized.profileImageUrl =
          normalized.profileImageUrl ||
          result.profileImageUrl;

        normalized.profileImageUrls = [
          ...new Set([
            ...(normalized.profileImageUrls || []),
            ...(result.profileImageUrls || []),
          ]),
        ];

        normalized.snippet =
          normalized.snippet ||
          result.snippet;
      }

      if (!normalized) {
        skipped++;
        continue;
      }

      // ------------------------------------------
      // Update existing MongoDB document
      // ------------------------------------------

      searchResult.platform =
        normalized.platform ||
        searchResult.platform;

      searchResult.profileUrl =
        normalized.profileUrl ||
        searchResult.profileUrl;

      searchResult.profileId =
        normalized.profileId ||
        null;

      searchResult.username =
        normalized.username ||
        null;

      searchResult.name =
        normalized.name ||
        null;

      searchResult.profileImageUrl =
        normalized.profileImageUrl ||
        null;

      searchResult.profileImageUrls =
        normalized.profileImageUrls ||
        [];

      searchResult.headline =
        normalized.headline ||
        null;

      searchResult.company =
        normalized.company ||
        null;

      searchResult.jobTitle =
        normalized.jobTitle ||
        null;

      searchResult.location =
        normalized.location ||
        {
          city: null,
          state: null,
          country: null,
        };

      searchResult.education =
        normalized.education ||
        [];

      await searchResult.save();

      updated++;
    } catch (error) {
      console.error(
        `Failed to normalize SearchResult ${searchResult._id}:`,
        error.message
      );

      skipped++;
    }
  }

  return {
    total: searchResults.length,
    updated,
    skipped,
  };
};

module.exports = {
  renormalizeExistingSearchResults,
};