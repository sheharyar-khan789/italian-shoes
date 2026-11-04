/**
 * Refuses to let secrets into git.
 *
 *   node scripts/check-secrets.mjs            scan every file git would track (CI, `npm run check`)
 *   node scripts/check-secrets.mjs --staged   scan what is about to be committed (pre-commit hook)
 *
 * Exit code 1 when anything is found, printing the file and the kind of secret (never the value).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const staged = process.argv.includes("--staged");

/** Content patterns. The Firebase *web* API key is public by design and only allowed in its config file. */
const PATTERNS = [
  { name: "private key (PEM)", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: "Google service-account JSON", re: /"type"\s*:\s*"service_account"/ },
  { name: "Google OAuth client secret", re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe live key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}/ },
  { name: "Google API key outside the Firebase web config", re: /AIza[0-9A-Za-z_-]{35}/, allow: ["src/app/firebase-config.js"] },
];

/** File-name patterns that must never be committed, whatever they contain. */
const FORBIDDEN_FILES = [
  { name: "Firebase admin key file", re: /firebase-adminsdk-[^/]*\.json$/i },
  { name: "service-account file", re: /(^|\/)service-account[^/]*\.json$/i },
  { name: "environment file", re: /(^|\/)\.env(\.(?!example$)[^/]+)?$/ },
  { name: "private key file", re: /\.(pem|p12|pfx|key)$|(^|\/)id_(rsa|ed25519|ecdsa)$/i },
];

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|glb|woff2?|ttf|otf|pdf|zip)$/i;

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const files = (staged ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR") : git("ls-files", "--cached", "--others", "--exclude-standard"))
  .split("\n")
  .map((f) => f.trim())
  .filter(Boolean);

const findings = [];
for (const file of files) {
  for (const rule of FORBIDDEN_FILES) if (rule.re.test(file)) findings.push(`${file}: ${rule.name} must not be committed`);
  if (BINARY.test(file)) continue;
  let text;
  try {
    text = staged ? git("show", `:${file}`) : readFileSync(file, "utf8");
  } catch {
    continue; // deleted or unreadable
  }
  for (const rule of PATTERNS) {
    if (rule.allow?.includes(file)) continue;
    if (rule.re.test(text)) findings.push(`${file}: looks like a ${rule.name}`);
  }
}

if (findings.length) {
  console.error("✖ Possible secrets found — commit blocked:\n  " + findings.join("\n  "));
  console.error("\nRemove them (and rotate any real key that was exposed). Never commit keys; see SECURITY.md.");
  process.exit(1);
}
console.log(`✔ No secrets found in ${files.length} file(s).`);
