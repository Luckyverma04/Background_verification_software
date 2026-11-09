"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

let ctx;

test.before(async () => {
  ctx = await H.startAll();
});
test.after(async () => {
  await ctx.stop();
});

const NO_AUTH = { "X-No-Auth": "1" };
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const login = (email, password) =>
  ctx.call("POST", "/auth/login", { email, password }, NO_AUTH);

const createUser = (body) => ctx.call("POST", "/users", body); // as the default admin

test("A1. health is public; every other API route needs a token", async () => {
  assert.equal((await ctx.call("GET", "/health", undefined, NO_AUTH)).status, 200);

  for (const [method, path] of [
    ["GET", "/candidates"],
    ["POST", "/candidates"],
    ["GET", "/bgv-runs"],
    ["GET", "/sheet-import/status"],
    ["GET", "/users"],
    ["DELETE", "/candidates/000000000000000000000000"],
    ["GET", "/does-not-exist"],
  ]) {
    const res = await ctx.call(method, path, method === "POST" ? {} : undefined, NO_AUTH);
    assert.equal(res.status, 401, `${method} ${path} must need login`);
  }

  const bad = await ctx.call("GET", "/candidates", undefined, bearer("not.a.token"));
  assert.equal(bad.status, 401);
});

test("A2. login: right password gives a token, wrong one is refused with the same message as an unknown user", async () => {
  const created = await createUser({ name: "Login Person", email: "Login.Person@Example.com", password: "correct-horse-1", role: "REVIEWER" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.email, "login.person@example.com");
  assert.equal(created.body.data.passwordHash, undefined, "hash is never returned");

  const wrong = await login("login.person@example.com", "nope-nope-nope");
  const unknown = await login("nobody@example.com", "nope-nope-nope");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.message, unknown.body.message);

  const ok = await login("LOGIN.person@example.com", "correct-horse-1");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.data.token);
  assert.equal(ok.body.data.user.role, "REVIEWER");

  const me = await ctx.call("GET", "/auth/me", undefined, bearer(ok.body.data.token));
  assert.equal(me.status, 200);
  assert.equal(me.body.data.name, "Login Person");

  const list = await ctx.call("GET", "/candidates", undefined, bearer(ok.body.data.token));
  assert.equal(list.status, 200);
});

test("A3. reviewers cannot manage users or delete records; admins can", async () => {
  await createUser({ name: "Plain Reviewer", email: "plain@example.com", password: "reviewer-pass-1" });
  const token = (await login("plain@example.com", "reviewer-pass-1")).body.data.token;

  assert.equal((await ctx.call("GET", "/users", undefined, bearer(token))).status, 403);
  assert.equal((await ctx.call("POST", "/users", { name: "x", email: "x@example.com", password: "12345678" }, bearer(token))).status, 403);

  const cand = (await ctx.call("POST", "/candidates", { fullName: "Delete Me" })).body.data;
  assert.equal((await ctx.call("DELETE", `/candidates/${cand._id}`, undefined, bearer(token))).status, 403);
  assert.equal((await ctx.call("DELETE", `/search-results/000000000000000000000000`, undefined, bearer(token))).status, 403);
  assert.equal((await ctx.call("DELETE", `/candidate-matches/000000000000000000000000`, undefined, bearer(token))).status, 403);

  assert.equal((await ctx.call("DELETE", `/candidates/${cand._id}`)).status, 200, "admin may delete");
});

test("A4. user validation: duplicate email, short password, bad role", async () => {
  assert.equal((await createUser({ name: "Dup", email: "plain@example.com", password: "long-enough-1" })).status, 409);
  assert.equal((await createUser({ name: "Short", email: "short@example.com", password: "short" })).status, 400);
  assert.equal((await createUser({ name: "Role", email: "role@example.com", password: "long-enough-1", role: "GOD" })).status, 400);
  assert.equal((await createUser({ name: "", email: "noname@example.com", password: "long-enough-1" })).status, 400);
});

test("A5. deactivating a user or resetting the password ends their sessions at once", async () => {
  const u = (await createUser({ name: "Leaver", email: "leaver@example.com", password: "leaver-pass-1" })).body.data;
  const token = (await login("leaver@example.com", "leaver-pass-1")).body.data.token;
  assert.equal((await ctx.call("GET", "/candidates", undefined, bearer(token))).status, 200);

  assert.equal((await ctx.call("PATCH", `/users/${u._id}`, { password: "new-leaver-pass" })).status, 200);
  assert.equal((await ctx.call("GET", "/candidates", undefined, bearer(token))).status, 401, "old token revoked");

  const token2 = (await login("leaver@example.com", "new-leaver-pass")).body.data.token;
  assert.equal((await ctx.call("PATCH", `/users/${u._id}`, { active: false })).status, 200);
  assert.equal((await ctx.call("GET", "/candidates", undefined, bearer(token2))).status, 401);
  assert.equal((await login("leaver@example.com", "new-leaver-pass")).status, 401, "inactive user cannot log in");
});

test("A6. change own password: needs the current one, old token stops working, new token works", async () => {
  await createUser({ name: "Changer", email: "changer@example.com", password: "first-pass-1" });
  const token = (await login("changer@example.com", "first-pass-1")).body.data.token;

  const wrong = await ctx.call("POST", "/auth/change-password", { currentPassword: "bad", newPassword: "second-pass-2" }, bearer(token));
  assert.equal(wrong.status, 400);

  const ok = await ctx.call("POST", "/auth/change-password", { currentPassword: "first-pass-1", newPassword: "second-pass-2" }, bearer(token));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await ctx.call("GET", "/auth/me", undefined, bearer(token))).status, 401);
  assert.equal((await ctx.call("GET", "/auth/me", undefined, bearer(ok.body.data.token))).status, 200);
});

test("A7. the last active admin cannot be demoted or deactivated", async () => {
  const admins = (await ctx.call("GET", "/users")).body.data.filter((u) => u.role === "ADMIN" && u.active);
  assert.equal(admins.length, 1);
  const self = admins[0];
  assert.equal((await ctx.call("PATCH", `/users/${self._id}`, { role: "REVIEWER" })).status, 400);
  assert.equal((await ctx.call("PATCH", `/users/${self._id}`, { active: false })).status, 400);
});

test("A8. a spoofed X-Reviewer header cannot change who is recorded", async () => {
  await createUser({ name: "Real Name", email: "real@example.com", password: "real-pass-123" });
  const token = (await login("real@example.com", "real-pass-123")).body.data.token;
  const res = await ctx.call("POST", "/sheet-import/confirm", { candidateIds: [] }, {
    ...bearer(token),
    "x-reviewer": "Someone Important",
  });
  // whatever the endpoint answers, the attribution helpers read only req.user
  assert.notEqual(res.status, 401);
  const { reviewerFromRequest } = require("../services/verifiedIdentity.service");
  const { labelOf } = require("../services/sheetImport.service");
  const fakeReq = { user: { name: "Real Name" }, headers: { "x-reviewer": "Someone Important" }, body: { reviewerName: "Someone Important" } };
  assert.equal(reviewerFromRequest(fakeReq).label, "Real Name");
  assert.equal(labelOf(fakeReq), "Real Name");
  assert.equal(reviewerFromRequest({ headers: { "x-reviewer": "Someone Important" } }).label, "");
});
