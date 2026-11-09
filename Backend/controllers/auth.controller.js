const User = require("../models/User");
const { ROLES } = require("../models/User");
const { signToken } = require("../middleware/auth.middleware");
const { hashPassword, verifyPassword, passwordProblem } = require("../utils/password");
const { sendError, isValidId } = require("../utils/http");

const clean = (v) => (typeof v === "string" ? v.trim() : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A fixed hash so a login for an unknown e-mail costs the same time as a real one
let dummyHash = null;
const getDummyHash = async () => (dummyHash ||= await hashPassword("not-a-real-password"));

// POST /api/auth/login  { email, password }
const login = async (req, res, next) => {
  try {
    const email = clean(req.body?.email).toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      return sendError(res, 400, "Email and password are required");
    }

    const user = await User.findOne({ email }).select("+passwordHash");
    const ok = await verifyPassword(password, user ? user.passwordHash : await getDummyHash());

    if (!user || !ok || !user.active) {
      return sendError(res, 401, "Wrong email or password");
    }

    user.lastLoginAt = new Date();
    await user.save();

    return res.status(200).json({
      success: true,
      data: { token: signToken(user), user: user.toSafeJSON() },
    });
  } catch (error) {
    return next(error);
  }
};

// GET /api/auth/me
const me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return sendError(res, 401, "Login required");
    return res.status(200).json({ success: true, data: user.toSafeJSON() });
  } catch (error) {
    return next(error);
  }
};

// POST /api/auth/change-password  { currentPassword, newPassword }
const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const problem = passwordProblem(newPassword);
    if (problem) return sendError(res, 400, problem);

    const user = await User.findById(req.user._id).select("+passwordHash");
    if (!user || !(await verifyPassword(String(currentPassword || ""), user.passwordHash))) {
      return sendError(res, 400, "Current password is wrong");
    }

    user.passwordHash = await hashPassword(newPassword);
    user.tokenVersion = (user.tokenVersion || 0) + 1; // log out other sessions
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password changed",
      data: { token: signToken(user), user: user.toSafeJSON() },
    });
  } catch (error) {
    return next(error);
  }
};

// ---------------------------------------------------------------
// User management (ADMIN only)
// ---------------------------------------------------------------

// GET /api/users
const listUsers = async (req, res, next) => {
  try {
    const users = await User.find().sort({ createdAt: 1 });
    return res.status(200).json({ success: true, data: users.map((u) => u.toSafeJSON()) });
  } catch (error) {
    return next(error);
  }
};

// POST /api/users  { name, email, password, role }
const createUser = async (req, res, next) => {
  try {
    const name = clean(req.body?.name);
    const email = clean(req.body?.email).toLowerCase();
    const role = clean(req.body?.role).toUpperCase() || "REVIEWER";
    const { password } = req.body || {};

    if (!name) return sendError(res, 400, "Name is required");
    if (!EMAIL_RE.test(email)) return sendError(res, 400, "A valid email is required");
    if (!ROLES.includes(role)) return sendError(res, 400, `Role must be one of ${ROLES.join(", ")}`);
    const problem = passwordProblem(password);
    if (problem) return sendError(res, 400, problem);

    if (await User.exists({ email })) {
      return sendError(res, 409, "A user with this email already exists");
    }

    const user = await User.create({ name, email, role, passwordHash: await hashPassword(password) });
    return res.status(201).json({ success: true, data: user.toSafeJSON() });
  } catch (error) {
    if (error?.code === 11000) return sendError(res, 409, "A user with this email already exists");
    return next(error);
  }
};

// PATCH /api/users/:id  { name?, role?, active?, password? }
const updateUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return sendError(res, 400, "Invalid user ID");

    const user = await User.findById(id);
    if (!user) return sendError(res, 404, "User not found");

    const body = req.body || {};
    const isSelf = String(user._id) === String(req.user._id);
    let revokeSessions = false;

    if (body.name !== undefined) {
      const name = clean(body.name);
      if (!name) return sendError(res, 400, "Name cannot be empty");
      user.name = name;
    }

    if (body.role !== undefined) {
      const role = clean(body.role).toUpperCase();
      if (!ROLES.includes(role)) return sendError(res, 400, `Role must be one of ${ROLES.join(", ")}`);
      if (isSelf && role !== "ADMIN") return sendError(res, 400, "You cannot remove your own admin role");
      user.role = role;
    }

    if (body.active !== undefined) {
      if (typeof body.active !== "boolean") return sendError(res, 400, "active must be true or false");
      if (isSelf && !body.active) return sendError(res, 400, "You cannot deactivate yourself");
      if (!body.active) revokeSessions = true;
      user.active = body.active;
    }

    if (body.password !== undefined) {
      const problem = passwordProblem(body.password);
      if (problem) return sendError(res, 400, problem);
      user.passwordHash = await hashPassword(body.password);
      revokeSessions = true;
    }

    // never leave the system without an active admin
    if (user.isModified("role") || user.isModified("active")) {
      const wasAdmin = await User.exists({ _id: user._id, role: "ADMIN", active: true });
      const staysAdmin = user.role === "ADMIN" && user.active;
      if (wasAdmin && !staysAdmin) {
        const others = await User.countDocuments({ _id: { $ne: user._id }, role: "ADMIN", active: true });
        if (others === 0) return sendError(res, 400, "At least one active admin is required");
      }
    }

    if (revokeSessions) user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    return res.status(200).json({ success: true, data: user.toSafeJSON() });
  } catch (error) {
    return next(error);
  }
};

// Called once at startup: creates the first admin from ADMIN_EMAIL /
// ADMIN_PASSWORD when the users collection is empty. Never touches an
// existing user.
const ensureFirstAdmin = async () => {
  if ((await User.estimatedDocumentCount()) > 0) return null;

  const email = clean(process.env.ADMIN_EMAIL).toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!EMAIL_RE.test(email) || passwordProblem(password)) {
    console.warn(
      "No users exist yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (min 8 characters) in .env " +
        "and restart to create the first admin."
    );
    return null;
  }

  const user = await User.create({
    name: clean(process.env.ADMIN_NAME) || "Admin",
    email,
    role: "ADMIN",
    passwordHash: await hashPassword(password),
  });
  console.log(`First admin created: ${email} (you can remove ADMIN_PASSWORD from .env now)`);
  return user;
};

module.exports = { login, me, changePassword, listUsers, createUser, updateUser, ensureFirstAdmin };
