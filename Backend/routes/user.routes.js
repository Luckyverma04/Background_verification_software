const express = require("express");

const { listUsers, createUser, updateUser } = require("../controllers/auth.controller");
const { requireRole } = require("../middleware/auth.middleware");

const router = express.Router();

// requireAuth is applied in app.js; user management is admin only
router.use(requireRole("ADMIN"));

router.get("/", listUsers);
router.post("/", createUser);
router.patch("/:id", updateUser);

module.exports = router;
