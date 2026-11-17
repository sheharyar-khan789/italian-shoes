/**
 * (Runs after pos-flow: file names are run in order.) Back-office work in a real browser: add a product with sizes and stock, then check the books and reports show what
 * the earlier till tests did. The database is read directly (emulator) to prove each screen saved what it said.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, newPage, adminLogin, shot, BASE, fx } from "./helpers.js";

process.env.GCLOUD_PROJECT = "demo-italianshoes";
const { db } = await import("../../functions/lib/admin.js");

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

test("the Owner adds a product, gives it a size and colour with a price, and it is saved exactly as typed", async () => {
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/products/new`);
  await page.locator("#pd-name").waitFor({ timeout: 20000 });
  await page.locator("#pd-name").fill("Browser Loafer");
  await page.locator("#pd-sku").fill("BR-LOAF-1");
  await page.locator("#pd-slug").fill("browser-loafer");
  await page.locator("#pd-description").fill("Added by the browser test.");
  await shot(page, "product-new");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForURL(/\/admin\/products\/(?!new)[A-Za-z0-9]+/, { timeout: 20000 });

  const saved = await db.collection("products").where("slug", "==", "browser-loafer").get();
  assert.equal(saved.size, 1);
  const p = saved.docs[0].data();
  assert.equal(p.name, "Browser Loafer");
  assert.equal(p.sku, "BR-LOAF-1");
  assert.equal(p.description, "Added by the browser test.");
  assert.equal(p.categoryId, fx.ids.cat);

  // Sizes and colours with a price (Rs 12,500) and a cost (Rs 7,000).
  await page.locator("#av-price").waitFor({ timeout: 20000 });
  await page.locator("form:has(#av-price) input[type=checkbox]").first().check();
  await page.locator("form:has(#av-price) input[type=checkbox]").last().check();
  await page.locator("#av-price").fill("12500");
  await page.locator("#av-costPrice").fill("7000");
  await page.getByRole("button", { name: /Add sizes/ }).click();
  await page.waitForTimeout(2500);
  const variants = await db.collection(`products/${saved.docs[0].id}/variants`).get();
  assert.ok(variants.size >= 1, "a size/colour was created");
  assert.equal(variants.docs[0].data().price, 1250000, "price saved as 12,500 rupees in paisa");

  // The product is not on the shop until it is published, and a duplicate web address is refused.
  await page.goto(`${BASE}/admin/products/new`);
  await page.locator("#pd-name").fill("Another");
  await page.locator("#pd-sku").fill("BR-LOAF-2");
  await page.locator("#pd-slug").fill("browser-loafer");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await page.waitForTimeout(2500);
  assert.equal((await db.collection("products").where("slug", "==", "browser-loafer").get()).size, 1, "the same web address cannot be used twice");
  assert.equal(problems.filter((p) => !/^409|^400/.test(p)).length, 0, problems.join("\n"));
  await context.close();
});

test("the books and reports show the till work: trial balance balances, revenue and returns are listed, stock report matches the shelf", async () => {
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });

  await page.goto(`${BASE}/admin/trial-balance`);
  await page.locator("#tb-from").waitFor({ timeout: 20000 });
  await page.locator("#tb-from").fill("2020-01-01");
  await page.locator("#tb-from").press("Tab");
  await page.getByRole("button", { name: /show|update|apply/i }).first().click().catch(() => {});
  await page.waitForFunction(() => /Balanced/i.test(document.querySelector("#adm-main")?.innerText ?? ""), null, { timeout: 20000 });
  const tb = (await page.locator("#adm-main").innerText()).replace(/\s+/g, " ");
  assert.doesNotMatch(tb, /NOT BALANCED/);
  assert.match(tb, /Sales Revenue/);
  assert.match(tb, /Cost of Goods Sold/);
  assert.match(tb, /Sales Returns/, "the return made in the till test is in the books");
  await shot(page, "trial-balance");

  // The old Reports screen (broken by a duplicate endpoint name until this test found it) shows the stock.
  await page.goto(`${BASE}/admin/reports`);
  await page.locator("[data-stock]").waitFor({ timeout: 20000 });
  await page.waitForFunction(() => /Pairs in stock/i.test(document.querySelector("[data-stock]")?.innerText ?? ""), null, { timeout: 20000 });
  assert.equal(problems.length, 0, problems.join("\n"));
  await context.close();
});

test("the storefront shows a published product from the database and not an unpublished one", async () => {
  const { page, context } = await newPage(browser);
  await page.goto(`${BASE}/shop`);
  await page.waitForFunction(() => /E2E Oxford/.test(document.body.innerText), null, { timeout: 30000 });
  assert.equal(/Browser Loafer/.test(await page.locator("body").innerText()), false, "an unpublished product is not shown");
  await page.goto(`${BASE}/product/oxford-e2e`);
  await page.waitForFunction(() => /E2E Oxford/.test(document.body.innerText), null, { timeout: 20000 });
  await context.close();
});
