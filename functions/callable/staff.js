import { secureCallable } from "../lib/callable.js";
import { setStaffRolesSchema } from "../shared/schemas/index.js";
import * as staff from "../services/staff.js";

/** First-time setup: the configured owner email claims the Owner role (once). */
export const claimOwner = secureCallable(
  "claimOwner",
  { auth: "required", rateLimit: { limit: 5, windowSeconds: 3600 } },
  async ({ uid, token }) => {
    const result = await staff.claimOwner({ uid, email: token.email, emailVerified: token.email_verified === true });
    return { roles: result.roles };
  },
);

/** Owner only: give or remove staff roles. */
export const setStaffRoles = secureCallable(
  "setStaffRoles",
  { auth: "required", permission: "staff.manage", schema: setStaffRolesSchema, rateLimit: { limit: 30, windowSeconds: 600 } },
  async ({ data, uid }) => staff.setStaffRoles({ ...data, actorUid: uid }),
);
