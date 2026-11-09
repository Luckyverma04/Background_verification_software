const mongoose = require("mongoose");

const ROLES = ["ADMIN", "REVIEWER"];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true,
      maxlength: 254,
    },
    // scrypt hash, never returned by the API (see toSafeJSON)
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: "REVIEWER" },
    active: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },
    // bumped on password change / deactivation so older tokens stop working
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    _id: this._id,
    name: this.name,
    email: this.email,
    role: this.role,
    active: this.active,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

const User = mongoose.model("User", userSchema);

module.exports = User;
module.exports.ROLES = ROLES;
