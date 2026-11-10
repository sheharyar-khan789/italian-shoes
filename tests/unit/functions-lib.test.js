import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../functions/lib/logger.js";
import { AppError, toApiError } from "../../functions/lib/errors.js";
import { parse } from "../../functions/lib/validate.js";
import { stockAdjustmentSchema } from "../../shared/schemas/index.js";

test("logs never contain secrets, at any depth", () => {
  const out = redact({
    email: "a@b.co",
    password: "hunter2",
    nested: { idToken: "eyJ...", apiKey: "AIza", list: [{ client_secret: "s" }], private_key: "-----BEGIN" },
    headers: { Authorization: "Bearer x", cookie: "sid=1" },
  });
  const json = JSON.stringify(out);
  for (const secret of ["hunter2", "eyJ", "AIza", '"s"', "BEGIN", "Bearer", "sid=1"]) assert.ok(!json.includes(secret), `leaked ${secret}`);
  assert.equal(out.email, "a@b.co", "non-sensitive fields are kept");
});

test("unexpected errors are hidden from callers; AppErrors pass through", () => {
  const internal = toApiError(new Error("relation users does not exist at db-prod-7"), "test");
  assert.equal(internal.status, 500);
  assert.equal(internal.body.error.code, "internal");
  assert.ok(!JSON.stringify(internal.body).includes("db-prod"), "internal details never reach the browser");

  const safe = toApiError(new AppError("failed-precondition", "Only 1 left in EU 42"), "test");
  assert.equal(safe.status, 400);
  assert.equal(safe.body.error.code, "failed-precondition");
  assert.equal(safe.body.error.message, "Only 1 left in EU 42");
  assert.equal(toApiError(new AppError("permission-denied", "no"), "t").status, 403);
  assert.equal(toApiError(new AppError("unauthenticated", "no"), "t").status, 401);

  assert.throws(() => new AppError("made-up", "x"), TypeError);
});

test("parse() returns cleaned data or a field-level invalid-argument error", () => {
  assert.equal(parse(stockAdjustmentSchema, { productId: "p1", variantId: "v1", change: 3, reason: "initial" }).change, 3);
  try {
    parse(stockAdjustmentSchema, { productId: "p1", variantId: "v1", change: 0, reason: "adjustment" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof AppError);
    assert.equal(e.code, "invalid-argument");
    assert.ok("change" in e.details.fields);
  }
});
