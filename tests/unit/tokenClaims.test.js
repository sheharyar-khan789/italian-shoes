import { test } from "node:test";
import assert from "node:assert/strict";
import { claimsFromToken } from "../../src/app/tokenClaims.js";

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64url({ alg: "RS256" })}.${b64url(payload)}.signature`;

test("claims are read from a saved token without any network", () => {
  const c = claimsFromToken(jwt({ staff: true, roles: ["owner"], perms: ["*"], email: "a@b.test", name: "Ünïcode — اردو" }));
  assert.equal(c.staff, true);
  assert.deepEqual(c.perms, ["*"]);
  assert.equal(c.name, "Ünïcode — اردو");
});

test("anything that is not a token gives no claims, never an error", () => {
  for (const bad of [undefined, null, "", "abc", "a.b.c", "a..c", "a.%%%.c", 42, {}]) assert.deepEqual(claimsFromToken(bad), {}, String(bad));
  assert.deepEqual(claimsFromToken(`a.${Buffer.from("[1,2]").toString("base64url")}.c`), {}, "an array payload is not a set of claims");
});
