const express = require("express");

const {
  buildGroupsForBgvRun,
  mergeIdentityGroup,
  getAllIdentityGroups,
  getIdentityGroupsByBgvRun,
  getIdentityGroupById,
  updateIdentityGroup,
} = require("../controllers/identityGroup.controller");

const router = express.Router();

// Build identity groups for a BGV run
router.post(
  "/build/:bgvRunId",
  buildGroupsForBgvRun
);

// Human-confirmed identity merge
// (static path, declared before any "/:id" route)
router.post(
  "/merge",
  mergeIdentityGroup
);

// Get all identity groups
router.get(
  "/",
  getAllIdentityGroups
);

// Get identity groups for a specific BGV run
router.get(
  "/run/:bgvRunId",
  getIdentityGroupsByBgvRun
);

// Get one identity group
router.get(
  "/:id",
  getIdentityGroupById
);

// Update identity group review
router.patch(
  "/:id",
  updateIdentityGroup
);

module.exports = router;