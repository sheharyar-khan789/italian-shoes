/**
 * The shop counter in a real browser: open a register, sell, print the receipt, then take a pair back.
 * The database is read directly (emulator) to prove the screens did what they said.
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

const item = () => fx.items["oxford-e2e"];
const stock = async () => (await db.doc(`inventory/${item().productId}__${item().variantId}`).get()).data().byWarehouse[fx.ids.shop].onHand;
const visible = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600);
let saleId = null;

test("a cashier opens a register, rings up a sale for cash and gets a receipt; stock, sale and books agree", async () => {
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.cashier);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/pos`);

  // Open the register (unless this cashier's register from an earlier test is still open, as a real till would be).
  await page.locator("#po-float, #pos-q").first().waitFor({ timeout: 20000 });
  if (await page.locator("#po-float").count()) {
    // Warehouses are listed in no fixed order: choose the shop floor, where the stock is.
    const shop = await page.locator("select[name=warehouseId] option").filter({ hasText: "Shop floor" }).getAttribute("value");
    await page.locator("select[name=warehouseId]").selectOption(shop);
    await page.locator("#po-float").fill("5000");
    await page.getByRole("button", { name: "Open register" }).click();
  }
  await page.locator("#pos-q").waitFor({ timeout: 20000 });
  const before_ = await stock();

  // Find the pair and add it twice.
  await page.locator("#pos-q").fill("E2E Oxford");
  await page.locator("#pos-q").press("Enter");
  const result = page.locator("[data-results] [data-add]").first();
  await result.waitFor({ timeout: 15000 });
  await result.click();
  await page.locator("[data-inc]").first().click();
  assert.match(await page.locator("[data-cart]").innerText(), /E2E Oxford/);
  await shot(page, "pos-cart");

  // Pay cash: exactly the total (2 x Rs 10,000).
  await page.locator("[data-checkout]").click();
  const amount = page.locator("[data-a]").first();
  await amount.waitFor({ timeout: 10000 });
  await amount.fill("20000");
  await page.locator("[data-checkout]").click();

  // A receipt dialog appears; printing builds the receipt document (the browser's print dialog does the rest).
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor({ timeout: 20000 });
  assert.match(await dialog.innerText(), /Sale SL-[0-9]+/);
  await shot(page, "pos-receipt-dialog");
  await dialog.locator("[data-print]").click();
  await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some((f) => /E2E Oxford/.test(f.contentDocument?.body?.innerText ?? "")), null, { timeout: 15000 });
  const receipt = await page.evaluate(() => [...document.querySelectorAll("iframe")].map((f) => f.contentDocument?.body?.innerText ?? "").join(" "));
  assert.match(receipt, /E2E Test Store/);
  assert.match(receipt, /E2E Oxford/);
  assert.match(receipt, /20,000/);
  assert.match(receipt, /Cashier|Test Cashier/i);

  // The server's records agree.
  const mine = (await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().lines?.[0]?.productId === item().productId);
  assert.equal(mine.length, 1, await visible(page));
  const sale = mine[0].data();
  saleId = mine[0].id;
  assert.equal(sale.total, 2000000);
  assert.equal(sale.paymentStatus, "collected");
  assert.equal(sale.lines[0].qty, 2);
  assert.equal(await stock(), before_ - 2, "two pairs left the shelf");
  const journal = await db.doc(`journalEntries/sale__${saleId}`).get();
  assert.equal(journal.exists, true, "the sale is in the books");
  assert.equal(problems.length, 0, problems.join("\n"));
  await context.close();
});

test("the Owner takes one pair back from the sale screen: refund, stock and books follow", async () => {
  assert.ok(saleId, "needs the sale from the previous test");
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/sales/${saleId}`);
  await page.getByRole("button", { name: "Return or exchange" }).waitFor({ timeout: 20000 });
  const before_ = await stock();
  await page.getByRole("button", { name: "Return or exchange" }).click();
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  await dialog.locator('input[name="qty0"]').fill("1");
  await dialog.locator("#pd-reason").fill("Wrong size");
  await dialog.locator("#pd-refundMethod").selectOption("bank_transfer");
  await dialog.locator("#pd-reference").fill("TXN-E2E-1");
  await shot(page, "pos-return-dialog");
  await dialog.getByRole("button", { name: "Take back" }).click();
  await page.waitForSelector("dialog[open]", { state: "detached", timeout: 20000 });

  const returns = await db.collection("salesReturns").where("saleId", "==", saleId).get();
  assert.equal(returns.size, 1, await visible(page));
  const r = returns.docs[0].data();
  assert.equal(r.value, 1000000);
  assert.equal(r.refund, 1000000);
  assert.equal(r.refundMethod, "bank_transfer");
  assert.equal(await stock(), before_ + 1, "the pair is back on the shelf");
  const sale = (await db.doc(`sales/${saleId}`).get()).data();
  assert.equal(sale.returnedTotal, 1000000);
  assert.equal(sale.status, "completed", "one of two pairs kept");
  await page.reload();
  await page.getByText("Taken back so far").waitFor({ timeout: 15000 });
  assert.equal(problems.length, 0, problems.join("\n"));
  await context.close();
});

test("a cashier has no way to refund: the button is not offered", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.cashier);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/sales/${saleId}`);
  await page.waitForTimeout(2500);
  assert.equal(await page.getByRole("button", { name: "Return or exchange" }).count(), 0);
  await context.close();
});
