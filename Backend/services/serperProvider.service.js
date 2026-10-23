const axios = require("axios");

const SERPER_API_URL = "https://google.serper.dev/search";

const search = async (query, options = {}) => {
  if (!process.env.SERPER_API_KEY) {
    throw new Error("SERPER_API_KEY is missing");
  }

  const response = await axios.post(
    SERPER_API_URL,
    {
      q: query,

      num: options.maxResults || 10,

      ...(options.gl ? { gl: options.gl } : {}),

      ...(options.page ? { page: options.page } : {}),

      ...(options.location
        ? {
            location: options.location,
          }
        : {}),
    },
    {
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },

      timeout: 15000,
    }
  );

  return response.data.organic || [];
};

module.exports = {
  search,
};