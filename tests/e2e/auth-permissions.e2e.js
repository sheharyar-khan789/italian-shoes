/**
 * Real-browser tests: sign-in, what each kind of person sees, and that the browser cannot be used to get past the server.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { launch, newPage, adminLogin, shot, BASE, fx } from "./helpers.js";

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

const navLabels = (page) => page.locator("#adm-nav [data-module]").allTextContents();

test("a wrong password is refused with a clear message and no one is signed in", async () => {
  const { page, context } = await newPage(browser);
  await page.goto(`${BASE}/admin`);
  await page.locator("#adm-email").fill(fx.people.owner.email);
  await page.locator("#adm-password").fill("not-the-password-1A");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator("[data-form-alert]:not([hidden])").waitFor({ timeout: 15000 });
  const msg = (await page.locator("[data-form-alert]").innerText()).toLowerCase();
  assert.match(msg, /incorrect|wrong|invalid|couldn|doesn/, msg);
  assert.equal(await page.locator("#adm-nav").count(), 0, "no admin shell for a failed sign-in");
  await context.close();
});

test("the Owner signs in, sees the whole admin, and stays signed in after a reload", async () => {
  const { page, context, problems } = await newPage(browser);
  await adminLogin(page, fx.people.owner);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  const labels = await navLabels(page);
  assert.ok(labels.length >= 60, `the Owner should see ~70 modules, saw ${labels.length}`);
  for (const must of ["Products", "Sales", "Point of Sale", "Staff & Roles", "Store Settings", "Period Close", "Bank Reconciliation", "HR Dashboard"]) {
    assert.ok(labels.some((l) => l.includes(must.replace("HR Dashboard", "HR").replace("Point of Sale", "POS")) || l === must), `Owner is missing "${must}" (${labels.join(", ")})`);
  }
  await shot(page, "owner-dashboard");
  await page.reload();
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  assert.equal(problems.length, 0, problems.join("\n"));
  await context.close();
});

test("a cashier sees only the till, and typing an admin address by hand shows nothing they may not see", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.cashier);
  await page.locator("#adm-nav").waitFor({ timeout: 20000 });
  const labels = await navLabels(page);
  assert.ok(labels.length > 0 && labels.length <= 6, `a cashier should see a handful of items, saw ${labels.length}: ${labels.join(", ")}`);
  for (const hidden of ["Staff & Roles", "Store Settings", "Products", "Finance", "Payroll", "Period Close"]) assert.ok(!labels.some((l) => l.includes(hidden)), `cashier must not see ${hidden}`);
  for (const path of ["/admin/staff", "/admin/settings", "/admin/journals", "/admin/hr-payroll"]) {
    await page.goto(`${BASE}${path}`);
    await page.locator("#adm-main").waitFor();
    await page.waitForTimeout(800);
    const text = await page.locator("#adm-main").innerText();
    assert.match(text, /not available|permission|don't have|no access/i, `${path} must refuse a cashier, showed: ${text.slice(0, 120)}`);
  }
  await context.close();
});

test("the server refuses a cashier's real token on endpoints they may not use (what someone could do from the browser console)", async () => {
  const signIn = async (p) => (await (await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: p.email, password: p.password, returnSecureToken: true }) })).json()).idToken;
  const api = async (name, token, data = {}) => (await fetch(`${BASE}/api/${name}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }) })).status;
  const cashier = await signIn(fx.people.cashier);
  const owner = await signIn(fx.people.owner);
  assert.ok(cashier && owner);
  for (const name of ["saveSettings", "setStaffRoles", "closePeriod", "posReturn", "reverseJournal", "saveProduct"]) {
    assert.equal(await api(name, null), 401, `${name} signed out`);
    assert.equal(await api(name, cashier), 403, `${name} as a cashier`);
    assert.notEqual(await api(name, owner), 403, `${name} as the Owner is allowed (then judged on its input)`);
  }
});

test("a customer account cannot enter the admin", async () => {
  const { page, context } = await newPage(browser);
  await adminLogin(page, fx.people.customer);
  await page.waitForTimeout(3000);
  assert.equal(await page.locator("#adm-nav").count(), 0, "no admin menu for a customer");
  const text = await page.locator("#admin").innerText();
  assert.match(text, /staff|permission|access|owner|not/i, text.slice(0, 200));
  await context.close();
});

test("the storefront and the sign-in pages load without errors", async () => {
  const { page, context, problems } = await newPage(browser);
  for (const path of ["/", "/shop", "/cart", "/account/login", "/account/forgot-password", "/size-guide", "/this-page-does-not-exist"]) {
    const res = await page.goto(`${BASE}${path}`);
    assert.ok(res.status() < 400, `${path} -> ${res.status()}`);
    await page.waitForTimeout(600);
  }
  assert.equal(problems.length, 0, problems.join("\n"));
  await context.close();
});

test("password reset: the form asks Firebase for a reset email for the right address, and says the same thing for an unknown address", async () => {
  const oob = async () => (await (await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/demo-italianshoes/oobCodes`)).json()).oobCodes ?? [];
  const { page, context } = await newPage(browser);
  const messages = [];
  for (const email of [fx.people.customer.email, "nobody-at-all@example.test"]) {
    await page.goto(`${BASE}/account/forgot-password`);
    await page.locator("input[name=email]").first().fill(email);
    await page.getByRole("button", { name: /send|reset|link/i }).first().click();
    await page.waitForTimeout(2500);
    messages.push((await page.locator("main").innerText()).replace(/\s+/g, " ").toLowerCase());
  }
  const codes = await oob();
  assert.ok(codes.some((c) => c.requestType === "PASSWORD_RESET" && c.email === fx.people.customer.email), "a reset email was requested for the real account");
  assert.ok(!codes.some((c) => c.email === "nobody-at-all@example.test"), "nothing is sent for an address with no account");
  const strip = (m) => m.replace(/e2e-customer@example\.test|nobody-at-all@example\.test/g, "");
  assert.equal(strip(messages[0]).includes("check"), strip(messages[1]).includes("check"), "the page answers alike, so it does not reveal which addresses have accounts");
  await context.close();
});
