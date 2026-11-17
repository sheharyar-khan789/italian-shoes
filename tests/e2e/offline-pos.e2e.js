/**
 * The offline till in a real browser, end to end: the shell survives a reload with no network, a cash sale is kept on the
 * device, and it reaches the server once, exactly once, when the connection returns.
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

const item = () => fx.items["derby-e2e"];
const stock = async () => (await db.doc(`inventory/${item().productId}__${item().variantId}`).get()).data().byWarehouse[fx.ids.shop].onHand;
const text = async (page) => (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 500);

test("a till that was open when the internet dropped can be reloaded, sells for cash offline, and syncs once", async () => {
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.cashier);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  await page.goto(`${BASE}/admin/pos`);
  await page.locator("#po-float").waitFor({ timeout: 20000 });
  const shop = await page.locator("select[name=warehouseId] option").filter({ hasText: "Shop floor" }).getAttribute("value");
  await page.locator("select[name=warehouseId]").selectOption(shop);
  await page.locator("#po-float").fill("1000");
  await page.getByRole("button", { name: "Open register" }).click();
  await page.locator("#pos-q").waitFor({ timeout: 20000 });

  // The shell is saved by the service worker, and the catalogue is kept on the device.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30000 });
  await page.waitForFunction(async () => (await caches.keys()).some((k) => k.startsWith("admin-shell-")), null, { timeout: 30000 });
  await page.waitForTimeout(4000); // let the offline catalogue finish downloading
  const before_ = await stock();

  // The connection drops; the page is reloaded.
  const failed = [];
  page.on("requestfailed", (r) => failed.push(r.url().replace(BASE, "").slice(0, 70)));
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#pos-q").waitFor({ timeout: 30000 }).catch(async (e) => {
    await shot(page, "offline-pos-after-reload");
    throw new Error(`The till did not come back after an offline reload. The screen says: ${await text(page)} (${e.message.slice(0, 40)}) Browser problems: ${problems.slice(-6).join(" | ")} Failed requests: ${failed.join(" , ")}`);
  });
  await shot(page, "offline-pos-after-reload");
  const banner = page.locator("[data-offline-banner]");
  assert.ok(await banner.isVisible(), "the till says it is offline: " + (await text(page)));

  // Sell one pair for cash while offline.
  await page.locator("#pos-q").fill("E2E Derby");
  await page.locator("#pos-q").press("Enter");
  const add = page.locator("[data-results] [data-add]").first();
  await add.waitFor({ timeout: 15000 });
  await add.click();
  await page.locator("[data-checkout]").click();
  await page.locator("[data-a]").first().fill("15000");
  await page.locator("[data-checkout]").click();
  await page.waitForTimeout(2500);
  await shot(page, "offline-pos-sale");
  assert.equal(await stock(), before_, "nothing reached the server while offline");
  assert.equal((await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().lines?.[0]?.productId === item().productId).length, 0, "no sale on the server yet");

  // The connection returns; the queued sale is sent.
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  let synced = null;
  for (let i = 0; i < 60 && !synced; i++) {
    const rows = (await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().lines?.[0]?.productId === item().productId);
    if (rows.length) synced = rows[0];
    else await page.waitForTimeout(1000);
  }
  assert.ok(synced, "the offline sale reached the server: " + (await text(page)));
  const sale = synced.data();
  assert.equal(sale.total, 1500000);
  assert.ok(sale.pos?.offline?.offlineId, "it is marked as an offline sale");
  assert.equal(await stock(), before_ - 1);
  assert.equal((await db.doc(`journalEntries/sale__${synced.id}`).get()).exists, true, "and is in the books");

  // Reloading and waiting does not send it a second time.
  await page.reload();
  await page.waitForTimeout(5000);
  const again = (await db.collection("sales").where("channel", "==", "pos").get()).docs.filter((d) => d.data().lines?.[0]?.productId === item().productId);
  assert.equal(again.length, 1, "exactly one sale on the server");
  assert.equal(await stock(), before_ - 1, "stock reduced exactly once");
  await context.close();
});
