/**
 * Sales backfill (see functions/migrations/004-accounting-backfill.js). A DRY RUN unless --apply is given.
 *
 *   Emulator, dry run (safe):        npm run migrate:accounting
 *   Emulator, apply:                 npm run migrate:accounting -- --apply
 *   Production, dry run:             node functions/scripts/migrate-accounting.mjs --production --project <id>
 *   Production, apply (explicit):    node functions/scripts/migrate-accounting.mjs --production --project <id> --apply --confirm <id>
 *
 * Production needs Google Application Default Credentials and never runs without --project. Applying to
 * production additionally needs --confirm <the same project id>. Nothing is ever deleted.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const production = args.includes("--production");
const apply = args.includes("--apply");
const projectId = flag("--project");

if (production) {
  if (!projectId) {
    console.error("Refusing to run against production without --project <id>.");
    process.exit(1);
  }
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("FIRESTORE_EMULATOR_HOST is set — unset it to target production.");
    process.exit(1);
  }
  if (apply && flag("--confirm") !== projectId) {
    console.error(`Applying to production needs --confirm ${projectId}. Run without --apply first to see the dry-run report.`);
    process.exit(1);
  }
} else if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("No emulator found (FIRESTORE_EMULATOR_HOST is not set). Start the emulators, or pass --production --project <id>.");
  process.exit(1);
}

const app = initializeApp({ projectId: projectId ?? process.env.GCLOUD_PROJECT ?? "demo-italianshoes" });
const target = production ? `PRODUCTION project "${app.options.projectId}"` : `emulator ${process.env.FIRESTORE_EMULATOR_HOST} (project ${app.options.projectId})`;
console.log(`${apply ? "APPLYING" : "DRY RUN (no changes)"} accounting backfill on ${target}`);

const { runAccountingBackfill } = await import("../migrations/004-accounting-backfill.js");
const report = await runAccountingBackfill(getFirestore(app), { apply, log: console.log });

const short = (list) => (list.length > 10 ? [...list.slice(0, 10), `… and ${list.length - 10} more`] : list);
console.log(JSON.stringify({ ...report, skipped: short(report.skipped), wouldFail: short(report.wouldFail) }, null, 2));
const issues = report.skipped.length + report.wouldFail.length + report.failed;
console.log(issues ? `\n${issues} item(s) need a look (listed above). Events that could not be posted safely were NOT posted.` : "\nNo problems found.");
if (!apply) console.log("This was a dry run. Nothing was written.");
if (report.verification.missing.length || report.failed) process.exitCode = 2;
