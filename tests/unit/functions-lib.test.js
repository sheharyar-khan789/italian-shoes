import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../functions/lib/logger.js";
import { AppError, toHttpsError } from "../../functions/lib/errors.js";
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
  const internal = toHttpsError(new Error("relation users does not exist at db-prod-7"), "test");
  assert.equal(internal.code, "internal");
  assert.ok(!internal.message.includes("db-prod"), "internal details never reach the browser");

  const safe = toHttpsError(new AppError("failed-precondition", "Only 1 left in EU 42"), "test");
  assert.equal(safe.code, "failed-precondition");
  assert.equal(safe.message, "Only 1 left in EU 42");

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
