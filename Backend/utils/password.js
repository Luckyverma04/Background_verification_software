const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;
const MIN_LENGTH = 8;

// Stored as "scrypt$<salt hex>$<hash hex>"
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, KEY_LEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
};

const verifyPassword = async (password, stored) => {
  const [scheme, saltHex, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
};

// Returns an error message, or null when the password is acceptable
const passwordProblem = (password) => {
  if (typeof password !== "string" || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`;
  }
  if (password.length > 200) return "Password is too long";
  return null;
};

module.exports = { hashPassword, verifyPassword, passwordProblem, MIN_LENGTH };
