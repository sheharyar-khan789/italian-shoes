/**
 * Delivery. Methods and city rates are entered by the owner; nothing here invents a fee.
 *
 *   shippingMethods/{id}   name, description, estimateText (owner's own words), isActive
 *   shippingRates/{methodId__city}   charge (paisa), freeOver (paisa or null); city "*" = all other cities
 *
 * Until at least one active method has a rate, checkout is refused with a clear message rather than
 * showing a misleading total.
 */
import { db, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** One rate per method + city, so the same city can't be priced twice. */
export const rateId = (methodId, city) => `${methodId}__${encodeURIComponent(norm(city))}`;

/* ───────── Reading (checkout) ───────── */

/** Active methods that have at least one rate. */
export async function listAvailableMethods() {
  const [methods, rates] = await Promise.all([db.collection("shippingMethods").where("isActive", "==", true).get(), db.collection("shippingRates").get()]);
  const withRates = new Set(rates.docs.map((r) => r.data().methodId));
  return methods.docs.filter((m) => withRates.has(m.id)).map((m) => ({ id: m.id, ...m.data() }));
}

/**
 * Charge in paisa for a method + city + order subtotal.
 * A rate for the exact city wins over the "*" (all other cities) rate; the free-shipping threshold applies.
 * @returns {Promise<{ methodId: string, name: string, estimateText: string, charge: number }>}
 */
export async function computeShipping(methodId, city, subtotal) {
  const [method, rates] = await Promise.all([db.collection("shippingMethods").doc(methodId).get(), db.collection("shippingRates").where("methodId", "==", methodId).get()]);
  if (!method.exists || method.data().isActive !== true) throw new AppError("failed-precondition", "That delivery option isn't available. Please choose another.");
  if (rates.empty) throw new AppError("failed-precondition", "Delivery charges haven't been set up for this option yet.");
  const all = rates.docs.map((d) => d.data());
  const rate = all.find((r) => norm(r.city) === norm(city)) ?? all.find((r) => r.city === "*");
  if (!rate) throw new AppError("failed-precondition", `We don't deliver to ${city} with this option.`, { fields: { city: "Not available for delivery" } });
  const free = rate.freeOver != null && subtotal >= rate.freeOver;
  return { methodId, name: method.data().name, estimateText: method.data().estimateText ?? "", charge: free ? 0 : rate.charge };
}

/* ───────── Managing (admin) ───────── */

/** @param {Record<string, any> & { id?: string }} input validated saveShippingMethodInput @param {string} actorUid */
export async function saveMethod(input, actorUid) {
  const { id, ...data } = input;
  const ref = id ? db.collection("shippingMethods").doc(id) : db.collection("shippingMethods").doc();
  await db.runTransaction(async (tx) => {
    const current = id ? await tx.get(ref) : null;
    if (id && !current.exists) throw new AppError("not-found", "That delivery method no longer exists.");
    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid };
    if (current) tx.update(ref, { ...data, ...stamp });
    else tx.create(ref, { ...data, ...stamp, createdAt: FieldValue.serverTimestamp() });
    writeAudit({ actorUid, action: current ? "shipping_method.updated" : "shipping_method.created", entityType: "shipping_method", entityId: ref.id, changes: { after: data } }, tx);
  });
  return { id: ref.id };
}

/** Create or update the rate for a city on a method. @param {Record<string, any>} input validated saveShippingRateInput @param {string} actorUid */
export async function saveRate(input, actorUid) {
  const method = await db.collection("shippingMethods").doc(input.methodId).get();
  if (!method.exists) throw new AppError("not-found", "That delivery method no longer exists.");
  const city = input.city === "*" ? "*" : input.city.trim();
  if (input.freeOver !== null && input.freeOver <= 0) throw new AppError("invalid-argument", "The free-delivery amount must be above zero, or left empty.", { fields: { freeOver: "Must be above zero" } });
  const ref = db.collection("shippingRates").doc(rateId(input.methodId, city));
  const existed = (await ref.get()).exists;
  await ref.set({ methodId: input.methodId, city, charge: input.charge, freeOver: input.freeOver ?? null, updatedAt: FieldValue.serverTimestamp(), updatedBy: actorUid });
  await writeAudit({ actorUid, action: existed ? "shipping_rate.updated" : "shipping_rate.created", entityType: "shipping_rate", entityId: ref.id, changes: { city, charge: input.charge, freeOver: input.freeOver ?? null } });
  return { id: ref.id, updated: existed };
}

/**
 * Delete a rate, or a method together with its rates. Past orders keep their own snapshot of the
 * delivery charge, so deleting never changes history.
 * @param {"method" | "rate"} kind @param {string} id @param {string} actorUid
 */
export async function deleteShipping(kind, id, actorUid) {
  if (kind === "rate") {
    const ref = db.collection("shippingRates").doc(id);
    if (!(await ref.get()).exists) throw new AppError("not-found", "That rate no longer exists.");
    await ref.delete();
  } else {
    const ref = db.collection("shippingMethods").doc(id);
    if (!(await ref.get()).exists) throw new AppError("not-found", "That delivery method no longer exists.");
    const rates = await db.collection("shippingRates").where("methodId", "==", id).get();
    const batch = db.batch();
    rates.docs.forEach((r) => batch.delete(r.ref));
    batch.delete(ref);
    await batch.commit();
  }
  await writeAudit({ actorUid, action: `shipping_${kind}.deleted`, entityType: `shipping_${kind}`, entityId: id });
  return { id };
}
