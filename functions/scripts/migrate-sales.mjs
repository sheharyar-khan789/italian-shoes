/**
 * Sales backfill (see functions/migrations/003-sales-backfill.js). A DRY RUN unless --apply is given.
 *
 *   Emulator, dry run (safe):        npm run migrate:sales
 *   Emulator, apply:                 npm run migrate:sales -- --apply
 *   Production, dry run:             node functions/scripts/migrate-sales.mjs --production --project <id>
 *   Production, apply (explicit):    node functions/scripts/migrate-sales.mjs --production --project <id> --apply --confirm <id>
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
console.log(`${apply ? "APPLYING" : "DRY RUN (no changes)"} sales backfill on ${target}`);

const { runSalesBackfill } = await import("../migrations/003-sales-backfill.js");
const report = await runSalesBackfill(getFirestore(app), { apply, log: console.log });

const short = (list) => (list.length > 10 ? [...list.slice(0, 10), `… and ${list.length - 10} more`] : list);
console.log(
  JSON.stringify(
    { ...report, problems: Object.fromEntries(Object.entries(report.problems).map(([k, v]) => [k, { count: v.length, examples: short(v) }])), verification: { ...report.verification, mismatches: short(report.verification.mismatches) } },
    null,
    2,
  ),
);
const issues = Object.values(report.problems).reduce((n, v) => n + v.length, 0);
console.log(issues ? `\n${issues} item(s) need a look (listed above). Orders that don't add up were NOT given a sale.` : "\nNo problems found.");
if (!apply) console.log("This was a dry run. Nothing was written.");
if (report.verification.mismatches.length) process.exitCode = 2;
