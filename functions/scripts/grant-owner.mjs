/**
 * Give an existing account the Owner role from the command line.
 * The person must already have created their account on the website (so they chose their own
 * password; this script never handles passwords).
 *
 *   Emulator:    npm run grant-owner -- --email owner@example.com
 *   Production:  node functions/scripts/grant-owner.mjs --email owner@example.com --production --project italianshoes
 *
 * Production needs Google Application Default Credentials (`gcloud auth application-default login`).
 * The usual way to set up the first Owner is the "Claim ownership" button on /admin instead.
 */
import { initializeApp } from "firebase-admin/app";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const email = flag("--email");
const production = args.includes("--production");
const projectId = flag("--project");

if (!email) {
  console.error("Usage: grant-owner --email <address> [--production --project <id>]");
  process.exit(1);
}
if (production ? !projectId || process.env.FIRESTORE_EMULATOR_HOST : !process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error(production ? "Production needs --project <id> and no emulator variables set." : "Start the emulators first (or pass --production --project <id>).");
  process.exit(1);
}

initializeApp({ projectId: projectId ?? process.env.GCLOUD_PROJECT ?? "demo-italianshoes" });
const { setStaffRoles } = await import("../services/staff.js");
const result = await setStaffRoles({ email, roles: ["owner"], actorUid: null });
console.log(`✔ ${email} is now an Owner (${result.perms.length} permissions). They must sign out and back in.`);
