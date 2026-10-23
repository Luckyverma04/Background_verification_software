"use strict";

const mongoose = require("mongoose");

const isValidId = (id) =>
  typeof id === "string" || id instanceof mongoose.Types.ObjectId
    ? mongoose.Types.ObjectId.isValid(String(id)) && String(id).length === 24
    : false;

/**
 * Error response with the SAME shape the API always had
 * ({ success:false, message, error }) but without leaking internal error
 * text in production.
 */
const sendError = (res, status, message, error, extra = {}) => {
  const body = { success: false, message, ...extra };

  if (error && process.env.NODE_ENV !== "production") {
    body.error = error.message || String(error);
  }

  return res.status(status).json(body);
};

/**
 * Pagination helper: ?page=1&limit=50 with a hard maximum.
 */
const getPagination = (query = {}, { defaultLimit = 50, maxLimit = 200 } = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(
    Math.max(parseInt(query.limit, 10) || defaultLimit, 1),
    maxLimit
  );

  return { page, limit, skip: (page - 1) * limit };
};

const buildPagination = ({ page, limit, total }) => {
  const totalPages = Math.max(Math.ceil(total / limit), 1);

  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
};

module.exports = { isValidId, sendError, getPagination, buildPagination };
