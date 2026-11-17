import { secureCallable } from "../lib/callable.js";
import { saveSettingsSchema, setStoreLogoInput, emptyObjectInput } from "../shared/schemas/index.js";
import * as settings from "../services/settings.js";
import { setStoreLogo as saveLogo, removeStoreLogo as dropLogo } from "../services/images.js";

/** Owner only: save the store settings. */
export const saveSettings = secureCallable(
  "saveSettings",
  { auth: "required", permission: "settings.manage", schema: saveSettingsSchema, rateLimit: { limit: 30, windowSeconds: 600 } },
  async ({ data, uid }) => settings.saveSettings(data, uid),
);

/** Owner only: set the store logo from a just-uploaded picture. */
export const setStoreLogo = secureCallable("setStoreLogo", { auth: "required", permission: "settings.manage", schema: setStoreLogoInput, rateLimit: { limit: 20, windowSeconds: 600 } }, async ({ data, uid }) => saveLogo(data, /** @type {string} */ (uid)));
export const removeStoreLogo = secureCallable("removeStoreLogo", { auth: "required", permission: "settings.manage", schema: emptyObjectInput, rateLimit: { limit: 20, windowSeconds: 600 } }, async ({ uid }) => dropLogo(/** @type {string} */ (uid)));
