const express = require("express");
const rateLimit = require("express-rate-limit");

const { login, me, changePassword } = require("../controllers/auth.controller");
const { requireAuth } = require("../middleware/auth.middleware");

const router = express.Router();

// Slow down password guessing: 10 attempts per IP per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_RATE_LIMIT) || 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, message: "Too many login attempts - try again in 15 minutes" },
});

router.post("/login", loginLimiter, login);
router.get("/me", requireAuth, me);
router.post("/change-password", requireAuth, changePassword);

module.exports = router;
