/**
 * Only same-site paths are allowed as a post-login destination (prevents open redirects
 * like ?next=https://evil.example or ?next=//evil.example).
 * @param {string | null} next
 */
export function safeNext(next, fallback = "/account") {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  try {
    const url = new URL(next, "https://shop.invalid");
    return url.origin === "https://shop.invalid" ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}
