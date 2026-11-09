const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { sendError, isValidId } = require("../utils/http");

const TOKEN_TTL = () => process.env.JWT_EXPIRES_IN || "12h";

const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    // server.js refuses to start without it; this guards tests / scripts
    throw new Error("JWT_SECRET is missing or shorter than 32 characters");
  }
  return value;
};

const signToken = (user) =>
  jwt.sign({ sub: String(user._id), v: user.tokenVersion || 0 }, secret(), {
    algorithm: "HS256",
    expiresIn: TOKEN_TTL(),
  });

/**
 * Every protected request must carry "Authorization: Bearer <token>".
 * The user is re-read from the database on each request, so a deactivated
 * user or a changed password takes effect immediately.
 */
const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return sendError(res, 401, "Login required");
    }

    let payload;
    try {
      payload = jwt.verify(token, secret(), { algorithms: ["HS256"] });
    } catch {
      return sendError(res, 401, "Session expired or invalid - please log in again");
    }

    if (!isValidId(payload.sub)) {
      return sendError(res, 401, "Session expired or invalid - please log in again");
    }

    const user = await User.findById(payload.sub);

    if (!user || !user.active || (user.tokenVersion || 0) !== payload.v) {
      return sendError(res, 401, "Session expired or invalid - please log in again");
    }

    req.user = {
      _id: user._id,
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
    };

    return next();
  } catch (error) {
    return next(error);
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return sendError(res, 401, "Login required");
  if (!roles.includes(req.user.role)) {
    return sendError(res, 403, "You do not have permission to do this");
  }
  return next();
};

module.exports = { requireAuth, requireRole, signToken };
