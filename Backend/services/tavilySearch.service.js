const axios = require("axios");

const TAVILY_API_URL = "https://api.tavily.com/search";

const search = async (query, options = {}) => {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is missing");
  }

  const response = await axios.post(
    TAVILY_API_URL,
    {
      api_key: process.env.TAVILY_API_KEY,

      query,

      search_depth:
        options.searchDepth || "basic",

      max_results:
        options.maxResults || 10,

      include_answer: false,

      include_raw_content: false,

      // IMPORTANT:
      // Ask Tavily to return available image URLs
      include_images: true,

      ...(options.includeDomains?.length
        ? {
            include_domains:
              options.includeDomains,
          }
        : {}),
    },
    {
      headers: {
        "Content-Type": "application/json",
      },

      timeout: 15000,
    }
  );

  return response.data.results || [];
};

module.exports = {
  search,
};