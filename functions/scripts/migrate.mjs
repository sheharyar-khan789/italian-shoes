/**
 * Run pending data migrations.
 *
 *   Emulator (default, safe):   npm run migrate            (from the project root, emulators running)
 *   Production (explicit):      node functions/scripts/migrate.mjs --production --project italianshoes
 *
 * Production needs Google Application Default Credentials (`gcloud auth application-default login`)
 * and refuses to run unless both flags are given. It never deletes data.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const production = args.includes("--production");
const projectFlag = args.indexOf("--project");
const projectId = projectFlag >= 0 ? args[projectFlag + 1] : undefined;

if (production) {
  if (!projectId) {
    console.error("Refusing to run against production without --project <id>.");
    process.exit(1);
  }
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("FIRESTORE_EMULATOR_HOST is set — unset it to target production.");
    process.exit(1);
  }
} else if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("No emulator found (FIRESTORE_EMULATOR_HOST is not set). Start the emulators, or pass --production --project <id> to migrate the live database.");
  process.exit(1);
}

const app = initializeApp({ projectId: projectId ?? process.env.GCLOUD_PROJECT ?? "demo-italianshoes" });
const target = production ? `PRODUCTION project "${app.options.projectId}"` : `emulator ${process.env.FIRESTORE_EMULATOR_HOST} (project ${app.options.projectId})`;
console.log(`Running migrations on ${target}`);

const { runMigrations } = await import("../migrations/runner.js");
const { applied, skipped } = await runMigrations(getFirestore(app));
console.log(`Done. Applied: ${applied.length ? applied.join(", ") : "none"}. Already applied: ${skipped.length}.`);
