/**
 * Restore a backup made by scripts/backup-firestore.mjs.
 *
 *   Rehearsal on the local emulator (safe, do this first):
 *     npm run emulators            (in another window)
 *     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-italianshoes npm run restore -- --from "<backup folder>"
 *
 *   Real restore (only after a disaster, and only with the owner's decision):
 *     npm run restore -- --from "<backup folder>" --production --confirm-project italianshoes
 *
 * Existing documents are NEVER overwritten unless --overwrite is given, so restoring into a database that
 * still has most of its data only fills in what is missing. The backup is verified (checksums) before anything is written.
 */
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { importAll, verifyBackup } from "./lib/firestoreBackup.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const from = flag("--from");
if (!from) { console.error('Usage: npm run restore -- --from "<backup folder>" [--production --confirm-project <id>] [--overwrite]'); process.exit(1); }

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: rawKey, FIRESTORE_EMULATOR_HOST: emu } = process.env;
const check = verifyBackup(from);
if (!check.ok) { console.error(`Backup is not intact: ${check.problems.join("; ")}`); process.exit(2); }
const { manifest } = check;

if (!emu) {
  if (!args.includes("--production") || flag("--confirm-project") !== projectId || manifest.projectId !== projectId) {
    console.error(`Refusing to touch a real project. Needs --production and --confirm-project ${manifest.projectId}, with FIREBASE_PROJECT_ID=${manifest.projectId} (backup is from "${manifest.projectId}", target is "${projectId}").`);
    process.exit(1);
  }
} else if (!/^demo-/.test(projectId ?? "")) {
  console.error("With the emulator, FIREBASE_PROJECT_ID must start with demo-.");
  process.exit(1);
}
const credential = emu ? undefined : clientEmail && rawKey ? cert({ projectId, clientEmail, privateKey: rawKey.replace(/^"|"$/g, "").replace(/\\n/g, "\n") }) : applicationDefault();
const db = getFirestore(initializeApp({ projectId, ...(credential ? { credential } : {}) }));

console.log(`Restoring ${manifest.total} documents (${manifest.createdAt}) into ${projectId}${emu ? " (EMULATOR)" : " (REAL PROJECT)"} ...`);
const r = await importAll(db, from, { overwrite: args.includes("--overwrite") });
console.log(`Written: ${r.written}. Skipped because they already existed: ${r.skipped}.`);
