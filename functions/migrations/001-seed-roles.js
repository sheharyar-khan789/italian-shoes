import { FieldValue } from "firebase-admin/firestore";
import { DEFAULT_ROLES } from "../shared/permissions.js";

/**
 * Creates the four staff roles. This is system configuration, not business data.
 * Existing role documents are left untouched so an Owner's later edits are never overwritten.
 * @type {import("./index.js").Migration}
 */
export default {
  id: "001-seed-roles",
  description: "Create the Owner, Inventory Manager, Order Manager and Content Manager roles",
  async up(db) {
    let created = 0;
    for (const [key, role] of Object.entries(DEFAULT_ROLES)) {
      const ref = db.collection("roles").doc(key);
      try {
        await ref.create({
          name: role.name,
          permissions: role.permissions,
          system: true, // the Owner can edit permissions but not delete these roles
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        created += 1;
      } catch (error) {
        // 6 = ALREADY_EXISTS: role was created earlier; keep it as it is.
        if (/** @type {{code?: number}} */ (error).code !== 6) throw error;
      }
    }
    return `${created} role(s) created`;
  },
};
