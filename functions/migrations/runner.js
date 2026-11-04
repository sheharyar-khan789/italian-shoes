import { FieldValue } from "firebase-admin/firestore";
import { MIGRATIONS } from "./index.js";

/**
 * Run every pending migration in order.
 *
 * Each migration is claimed by creating `_migrations/{id}` with status "running"; Firestore's
 * create() fails if the document exists, so two runners can never apply the same migration.
 * A migration that failed is marked "failed" and is retried on the next run; one left "running"
 * (a crashed run) stops the runner so a person can check it.
 *
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{ migrations?: import("./index.js").Migration[], log?: (line: string) => void }} [options]
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
export async function runMigrations(db, { migrations = MIGRATIONS, log = console.log } = {}) {
  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    const ref = db.collection("_migrations").doc(migration.id);
    const existing = await ref.get();
    const status = existing.data()?.status;

    if (status === "done") {
      skipped.push(migration.id);
      continue;
    }
    if (status === "running") {
      throw new Error(`Migration ${migration.id} is marked "running" — a previous run may have crashed. Check it, then delete _migrations/${migration.id} to retry.`);
    }

    if (existing.exists) await ref.update({ status: "running", startedAt: FieldValue.serverTimestamp(), error: FieldValue.delete() });
    else await ref.create({ status: "running", description: migration.description, startedAt: FieldValue.serverTimestamp() });

    try {
      const summary = await migration.up(db);
      await ref.update({ status: "done", summary, finishedAt: FieldValue.serverTimestamp() });
      applied.push(migration.id);
      log(`✔ ${migration.id}: ${summary}`);
    } catch (error) {
      await ref.update({ status: "failed", error: String(/** @type {Error} */ (error).message ?? error), finishedAt: FieldValue.serverTimestamp() });
      throw error;
    }
  }
  return { applied, skipped };
}
