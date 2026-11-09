import { secureCallable } from "../lib/callable.js";
import { saveSettingsSchema } from "../shared/schemas/index.js";
import * as settings from "../services/settings.js";

/** Owner only: save the store settings. */
export const saveSettings = secureCallable(
  "saveSettings",
  { auth: "required", permission: "settings.manage", schema: saveSettingsSchema, rateLimit: { limit: 30, windowSeconds: 600 } },
  async ({ data, uid }) => settings.saveSettings(data, uid),
);
