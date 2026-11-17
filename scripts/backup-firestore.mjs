/**
 * Export every Firestore document to a folder. READ-ONLY: it never writes to Firestore.
 *
 *   npm run backup -- --out "D:\Backups\italianshoes-2026-11-20"
 *
 * Credentials (no key file is ever stored in this project):
 *   - Recommended: sign in once on your own computer with `gcloud auth application-default login`
 *     (an account that can read Firestore) and set FIREBASE_PROJECT_ID=italianshoes.
 *   - Or the same FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY variables the site uses.
 *   - With FIRESTORE_EMULATOR_HOST set it reads the local emulator instead.
 * The backup holds customer, employee (CNIC, salary) and financial data. Keep it on an encrypted drive,
 * never inside the project or an OneDrive folder, and never commit it.
 */
import path from "node:path";
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { exportAll, verifyBackup } from "./lib/firestoreBackup.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const out = flag("--out");
if (!out) { console.error('Usage: npm run backup -- --out "<new folder outside the project>"'); process.exit(1); }
const outDir = path.resolve(out);
const repo = path.resolve(import.meta.dirname, "..");
if (outDir.toLowerCase().startsWith(repo.toLowerCase()) || /onedrive/i.test(outDir)) {
  console.error("Refusing: the backup contains personal and financial data. Choose a folder outside this project and outside OneDrive.");
  process.exit(1);
}

const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail, FIREBASE_PRIVATE_KEY: rawKey, FIRESTORE_EMULATOR_HOST: emu } = process.env;
if (!projectId) { console.error("Set FIREBASE_PROJECT_ID (e.g. italianshoes)."); process.exit(1); }
const credential = emu ? undefined : clientEmail && rawKey ? cert({ projectId, clientEmail, privateKey: rawKey.replace(/^"|"$/g, "").replace(/\\n/g, "\n") }) : applicationDefault();
const db = getFirestore(initializeApp({ projectId, ...(credential ? { credential } : {}) }));

console.log(`Exporting project ${projectId}${emu ? " (EMULATOR)" : ""} to ${outDir} ...`);
const manifest = await exportAll(db, outDir, { projectId });
const check = verifyBackup(outDir);
console.log(`Done: ${manifest.total} documents in ${Object.keys(manifest.counts).length} collections.`);
console.log(check.ok ? "Verification: every file matches its checksum." : `VERIFICATION FAILED: ${check.problems.join("; ")}`);
process.exit(check.ok ? 0 : 2);
