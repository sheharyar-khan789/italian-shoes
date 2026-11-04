/**
 * Ordered list of data migrations. Each runs exactly once per database; progress is recorded in
 * the `_migrations` collection. Never edit or reorder a migration that has run in production —
 * add a new one instead.
 */
import seedRoles from "./001-seed-roles.js";

/** @typedef {{ id: string, description: string, up: (db: import("firebase-admin/firestore").Firestore) => Promise<string> }} Migration */

/** @type {Migration[]} */
export const MIGRATIONS = [seedRoles];
