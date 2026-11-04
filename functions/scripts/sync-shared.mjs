/**
 * Copies /shared into functions/shared so Cloud Functions can import it.
 * Firebase uploads only the functions/ folder on deploy, so code outside it would be missing.
 * Runs before every deploy (firebase.json predeploy) and before the emulators start.
 * functions/shared is generated: edit /shared, never the copy.
 */
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../shared/", import.meta.url));
const target = fileURLToPath(new URL("../shared/", import.meta.url));

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
writeFileSync(new URL("../shared/README.md", import.meta.url), "Generated copy of /shared — do not edit. Run `npm run sync-shared` in functions/.\n");
console.log("Synced /shared → functions/shared");
