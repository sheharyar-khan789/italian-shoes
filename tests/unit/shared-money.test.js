import { test } from "node:test";
import assert from "node:assert/strict";
import { rupeesToPaisa, formatPKR, sumPaisa, lineTotal, percentOf, isPaisa, assertPaisa } from "../../shared/money.js";

test("rupee strings become exact paisa without float error", () => {
  assert.equal(rupeesToPaisa("12500"), 1250000);
  assert.equal(rupeesToPaisa("12,500"), 1250000);
  assert.equal(rupeesToPaisa("12500.5"), 1250050);
  assert.equal(rupeesToPaisa("0.10"), 10);
  assert.equal(rupeesToPaisa("0.07"), 7);
  assert.equal(rupeesToPaisa(19.99), 1999);
  assert.equal(rupeesToPaisa("0.1") + rupeesToPaisa("0.2"), 30, "0.1 + 0.2 is exactly 30 paisa");
});

test("invalid rupee input is rejected", () => {
  for (const bad of ["", "abc", "-5", "1.234", "1e5", "12 500", "١٢"]) {
    assert.throws(() => rupeesToPaisa(bad), RangeError, bad);
  }
});

test("formatting", () => {
  assert.equal(formatPKR(1250000), "Rs. 12,500");
  assert.equal(formatPKR(1250050), "Rs. 12,500.50");
  assert.equal(formatPKR(0), "Rs. 0");
  assert.throws(() => formatPKR(12.5));
  assert.throws(() => formatPKR(-100));
});

test("arithmetic stays in whole paisa and rejects bad values", () => {
  assert.equal(sumPaisa(100, 250, 0), 350);
  assert.equal(lineTotal(1250000, 3), 3750000);
  assert.throws(() => lineTotal(100, 0));
  assert.throws(() => lineTotal(100, 1.5));
  assert.throws(() => sumPaisa(100, 0.5));
  assert.equal(isPaisa(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isPaisa(Number.MAX_SAFE_INTEGER + 1), false);
  assert.throws(() => lineTotal(Number.MAX_SAFE_INTEGER, 2), "overflow beyond safe integers is refused");
  assert.equal(assertPaisa(5), 5);
});

test("percentages round down to whole paisa", () => {
  assert.equal(percentOf(1250000, 10), 125000);
  assert.equal(percentOf(999, 10), 99, "99.9 paisa → 99, never more than the percentage");
  assert.equal(percentOf(1000, 12.5), 125);
  assert.equal(percentOf(1000, 0), 0);
  assert.equal(percentOf(1000, 100), 1000);
  assert.throws(() => percentOf(1000, 101));
  assert.throws(() => percentOf(1000, -1));
});
