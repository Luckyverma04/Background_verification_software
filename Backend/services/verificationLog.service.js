const mongoose = require("mongoose");

const VerificationLog = require("../models/VerificationLog");

const isValidId = (id) => mongoose.Types.ObjectId.isValid(String(id));

/**
 * Create one VerificationLog row.
 *
 * `idempotencyKey` (optional) makes retries safe: when a log with the same
 * key already exists it is returned instead of creating a duplicate.
 */
const createVerificationLog = async ({
  bgvRun,
  candidate,
  action,
  previousStatus,
  newStatus,
  description,
  performedBy,
  metadata = {},
  idempotencyKey,
}) => {
  if (!bgvRun) {
    throw new Error("bgvRun is required");
  }

  if (!candidate) {
    throw new Error("candidate is required");
  }

  if (!action) {
    throw new Error("action is required");
  }

  if (idempotencyKey) {
    const existing = await VerificationLog.findOne({ idempotencyKey });
    if (existing) return existing;
  }

  try {
    return await VerificationLog.create({
      bgvRun,
      candidate,
      action,
      previousStatus,
      newStatus,
      description,
      performedBy: performedBy && isValidId(performedBy) ? performedBy : undefined,
      metadata,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  } catch (error) {
    // Same event inserted by a parallel request: return that one.
    if (error && error.code === 11000 && idempotencyKey) {
      return VerificationLog.findOne({ idempotencyKey });
    }
    throw error;
  }
};

/**
 * Fire-and-forget logging used by the real BGV workflow.
 *
 * A failing log must NEVER break the BGV operation it describes, so this
 * never throws. Call it only AFTER the underlying operation succeeded
 * (or with a *_FAILED action when it failed) - it must not describe
 * something that did not happen.
 */
const logEvent = async (event) => {
  try {
    if (!event?.bgvRun || !event?.candidate) return null;
    return await createVerificationLog(event);
  } catch (error) {
    console.error(
      `VerificationLog write failed (${event?.action}):`,
      error.message
    );
    return null;
  }
};

const getVerificationLogsByRun = async (bgvRunId) => {
  return VerificationLog.find({
    bgvRun: bgvRunId,
  })
    .populate("candidate", "fullName email phone")
    .populate("performedBy", "name email")
    .sort({ createdAt: -1 });
};

const getVerificationLogById = async (logId) => {
  return VerificationLog.findById(logId)
    .populate("candidate", "fullName email phone")
    .populate("performedBy", "name email");
};

module.exports = {
  createVerificationLog,
  logEvent,
  getVerificationLogsByRun,
  getVerificationLogById,
};
