/**
 * Every screen in the admin, opened by the Owner in a real browser: it must draw, without script errors, failed
 * requests or the generic "something went wrong" panel. Then the critical screens are checked on a phone-sized screen.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, newPage, adminLogin, shot, BASE } from "./helpers.js";

let browser;
let session;
let paths = [];
before(async () => {
  browser = await launch();
  session = await newPage(browser);
  await adminLogin(session.page, (await import("./helpers.js")).fx.people.owner);
  await session.page.locator("#adm-nav").waitFor({ timeout: 20000 });
  paths = await session.page.locator("#adm-nav [data-module]").evaluateAll((els) => els.map((a) => a.getAttribute("href")));
});
after(async () => {
  await session?.context.close();
  await browser?.close();
});

const settle = async (page) => {
  await page.waitForFunction(() => !document.querySelector("#adm-main .adm-state--loading") && !/^\s*Loading…\s*$/.test(document.querySelector("#adm-main")?.innerText ?? ""), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(400);
};

test("the Owner's menu lists every module", () => {
  assert.ok(paths.length >= 60, `saw ${paths.length}`);
  assert.equal(new Set(paths).size, paths.length, "no module is listed twice");
});

test("every admin screen opens and draws without errors", async () => {
  const { page, problems } = session;
  const bad = [];
  for (const path of paths) {
    problems.length = 0;
    const res = await page.goto(`${BASE}${path}`);
    await settle(page);
    const main = (await page.locator("#adm-main").innerText()).replace(/\s+/g, " ");
    let issues = [...problems];
    // My HR is for people who are also on the staff list: an Owner with no employee record correctly gets an explanation, not data.
    if (path === "/admin/hr-self" && /Your sign-in/.test(main)) issues = issues.filter((p) => !/hrMyProfile/.test(p));
    if (res.status() >= 400) issues.push(`HTTP ${res.status()}`);
    if (!(path === "/admin/hr-self" && /Your sign-in/.test(main)) && /something went wrong|couldn't be loaded|not available/i.test(main) && !/no .* yet|nothing/i.test(main.slice(0, 80))) issues.push(`panel: ${main.slice(0, 90)}`);
    if (main.length < 8) issues.push("empty screen");
    if (issues.length) bad.push(`${path}: ${issues.join(" | ")}`);
  }
  assert.equal(bad.length, 0, `${bad.length} of ${paths.length} screens had problems:\n${bad.join("\n")}`);
});

test("the critical screens fit a phone: no sideways scrolling, and the menu opens", async () => {
  const mobile = await newPage(browser, { viewport: { width: 375, height: 800 }, isMobile: true, hasTouch: true });
  await adminLogin(mobile.page, (await import("./helpers.js")).fx.people.owner);
  await mobile.page.locator("#adm-nav").waitFor({ state: "attached", timeout: 20000 });
  const wide = [];
  for (const path of ["/admin", "/admin/pos", "/admin/products", "/admin/orders", "/admin/sales", "/admin/inventory", "/admin/journals", "/admin/hr-attendance", "/admin/hr-payroll", "/admin/settings"]) {
    await mobile.page.goto(`${BASE}${path}`);
    await settle(mobile.page);
    const { sw, iw } = await mobile.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    if (sw > iw + 1) wide.push(`${path}: page is ${sw}px wide on a ${iw}px screen`);
  }
  await shot(mobile.page, "mobile-settings");
  await mobile.page.locator("[data-nav-toggle]").click();
  assert.ok(await mobile.page.locator("#adm-nav.is-open").count(), "the menu button opens the menu");
  await mobile.context.close();
  assert.equal(wide.length, 0, wide.join("\n"));
});
