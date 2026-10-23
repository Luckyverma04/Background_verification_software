const mongoose = require("mongoose");

const experienceSchema = new mongoose.Schema(
  {
    company: {
      type: String,
      trim: true,
    },

    jobTitle: {
      type: String,
      trim: true,
    },

    startDate: {
      type: Date,
    },

    endDate: {
      type: Date,
    },
  },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    degree: {
      type: String,
      trim: true,
    },

    fieldOfStudy: {
      type: String,
      trim: true,
    },

    institution: {
      type: String,
      trim: true,
    },

    startYear: {
      type: Number,
    },

    endYear: {
      type: Number,
    },
  },
  { _id: false }
);

const locationSchema = new mongoose.Schema(
  {
    city: {
      type: String,
      trim: true,
    },

    state: {
      type: String,
      trim: true,
    },

    country: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);

const candidateSchema = new mongoose.Schema(
  {
    // =========================
    // BASIC DETAILS
    // =========================

    fullName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
    },

    phone: {
      type: String,
      trim: true,
    },

    location: {
      type: locationSchema,
    },

    // Free-text address as given by the source (the structured part is `location`)
    address: {
      type: String,
      trim: true,
    },

    // Date of birth (UTC midnight). Never logged; not used by the search itself.
    dateOfBirth: {
      type: Date,
    },

    // =========================
    // PROFESSIONAL DETAILS
    // =========================

    currentCompany: {
      type: String,
      trim: true,
    },

    currentJobTitle: {
      type: String,
      trim: true,
    },

    experience: {
      type: [experienceSchema],
      default: [],
    },

    // =========================
    // EDUCATION
    // =========================

    education: {
      type: [educationSchema],
      default: [],
    },

    // =========================
    // SOCIAL / ONLINE PROFILES
    // =========================

    linkedin: {
      type: String,
      trim: true,
    },

    instagram: {
      type: String,
      trim: true,
    },

    facebook: {
      type: String,
      trim: true,
    },

    twitter: {
      type: String,
      trim: true,
    },

    github: {
      type: String,
      trim: true,
    },

    website: {
      type: String,
      trim: true,
    },

    // =========================
    // SOURCE IMAGE
    // =========================

    sourceImageUrl: {
      type: String,
      trim: true,
    },

    sourceImagePublicId: {
      type: String,
      trim: true,
    },

    // =========================
    // INPUT / SOURCE
    // =========================

    // Where an imported candidate came from (Google Sheet: spreadsheet id, tab,
    // row, Job ID, tenant, created date, duplicate status, created by /
    // assigned to, extra source columns). Informational; never used to decide
    // identity.
    sheetSource: {
      type: mongoose.Schema.Types.Mixed,
    },

    source: {
      type: String,
      enum: ["MANUAL", "IMAGE", "EXCEL", "GOOGLE_SHEET"],
      default: "MANUAL",
    },

    extractionStatus: {
      type: String,
      enum: [
        "NOT_APPLICABLE",
        "EXTRACTING",
        "EXTRACTED",
        "WAITING_CONFIRMATION",
        "CONFIRMED",
        "CORRECTION_REQUIRED",
      ],
      default: "NOT_APPLICABLE",
    },

    // =========================
    // VERIFICATION
    // =========================

    verificationStatus: {
      type: String,
      enum: [
        "PENDING",
        "INPUT_REVIEW",
        "CONFIRMED",
        "SEARCHING",
        "MATCHING",
        "REVIEW_REQUIRED",
        "COMPLETED",
      ],
      default: "PENDING",
    },

    confirmedAt: {
      type: Date,
    },

    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
  }
);

const Candidate = mongoose.model("Candidate", candidateSchema);

module.exports = Candidate;