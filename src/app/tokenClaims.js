/**
 * Read the claims out of a Firebase ID token WITHOUT contacting anyone (offline). Used only so the screen can still
 * be drawn when a saved sign-in has an expired token and the internet is down. The server never trusts this: every
 * request is verified again with a fresh token, and offline nothing reaches the server at all.
 * @param {string | undefined | null} jwt
 * @returns {Record<string, any>}
 */
export function claimsFromToken(jwt) {
  try {
    const part = String(jwt ?? "").split(".")[1];
    if (!part) return {};
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}
