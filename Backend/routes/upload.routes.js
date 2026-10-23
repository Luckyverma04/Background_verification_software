const express = require("express");

const upload = require("../middleware/upload.middleware");
const {
  uploadCandidateImage,
} = require("../controllers/upload.controller");

const router = express.Router();

router.post(
  "/candidate-image",
  upload.single("image"),
  uploadCandidateImage
);

module.exports = router;