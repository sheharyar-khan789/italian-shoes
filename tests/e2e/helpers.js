/** Shared browser-test helpers: launch real Chrome, sign in, watch for errors. */
import { chromium } from "playwright-core";
import fs from "node:fs";

export const BASE = process.env.E2E_BASE ?? "http://localhost:5183";
export const fx = JSON.parse(process.env.E2E_FIXTURES ?? "{}");
export const OUT = process.env.E2E_OUT ?? "e2e-output";

const CHROME = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && fs.existsSync(p));

export async function launch() {
  if (!CHROME) throw new Error("Google Chrome was not found. Install it or set CHROME_PATH.");
  return chromium.launch({ executablePath: CHROME, headless: true, args: process.env.CI ? ["--no-sandbox"] : [] });
}

/** A fresh browser context that records script errors and console errors of OUR app (not third-party noise). */
export async function newPage(browser, { viewport = { width: 1280, height: 800 }, ...opts } = {}) {
  const context = await browser.newContext({ viewport, serviceWorkers: "allow", ...opts });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/favicon|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED|fonts[.]g|cdn[.]jsdelivr|Failed to load resource/i.test(t)) return; // failed loads are reported with their address below
    problems.push(`console: ${t.slice(0, 200)}`);
  });
  page.on("response", (r) => {
    const u = r.url();
    if (r.status() >= 400 && u.startsWith(BASE) && !/favicon/.test(u)) problems.push(`${r.status()} ${u.replace(BASE, "")}`);
  });
  return { context, page, problems };
}

/** Sign in on /admin with an emulator account. */
export async function adminLogin(page, person) {
  await page.goto(`${BASE}/admin`);
  await page.locator("#adm-email").fill(person.email);
  await page.locator("#adm-password").fill(person.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {});
