const express = require("express");
const { listVerifiedIdentities, revokeVerifiedIdentity } = require("../controllers/profile.controller");

const router = express.Router();

// GET /api/verified-identities?candidate=ID
router.get("/", listVerifiedIdentities);
// POST /api/verified-identities/:id/revoke
router.post("/:id/revoke", revokeVerifiedIdentity);

module.exports = router;
