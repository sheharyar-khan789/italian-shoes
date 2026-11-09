/**
 * One idempotency key per checkout attempt. The server returns the same order for the same key, so a
 * double click or a retry after a dropped connection can't create two orders. If the bag, address,
 * delivery or coupon changes, a NEW key is used (the old key would return the old order).
 */

/** Stable text for what is being ordered. */
export const fingerprint = (payload) =>
  JSON.stringify([
    [...payload.items].map((i) => [i.productId, i.variantId, i.qty]).sort(),
    payload.shippingMethodId,
    payload.couponCode ?? "",
    payload.address,
    payload.customer,
  ]);

/**
 * @param {Pick<Storage, "getItem" | "setItem" | "removeItem"> | null} storage
 * @param {string} print @param {() => string} makeId
 */
export function keyFor(storage, print, makeId = () => crypto.randomUUID()) {
  const NAME = "checkout.attempt";
  try {
    const saved = JSON.parse(storage?.getItem(NAME) ?? "null");
    if (saved?.print === print && typeof saved.key === "string") return saved.key;
  } catch {
    /* unreadable: start a fresh attempt */
  }
  const key = makeId();
  try {
    storage?.setItem(NAME, JSON.stringify({ print, key }));
  } catch {
    /* storage blocked: the key still works for this attempt */
  }
  return key;
}

export const clearKey = (storage) => {
  try {
    storage?.removeItem("checkout.attempt");
  } catch {
    /* nothing to clear */
  }
};
