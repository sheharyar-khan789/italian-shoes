/**
 * HR core: settings, employees, documents, profile history and the HR roles.
 *
 *   employees/{id}         the profile: name, contact, designation, department, manager, shift, joining / leaving dates, status (hr.read)
 *   employeeSecure/{id}    pay terms (basic salary, allowances, method) and the CNIC: never returned without hr.salary.read / hr.sensitive
 *   employeeDocs/{id}      uploaded documents (URL, name, kind): hr.sensitive only
 *   employeeHistory/{id}   who changed what and when; entries about pay or CNIC are `restricted` and filtered by permission
 *   employeeLinks/{uid}    which employee a staff sign-in belongs to (one sign-in, one employee) so people can see their OWN records
 *   employeeKeys/cnic_…    makes a CNIC unique inside the same transaction as the profile
 *   hrSettings/main        departments, designations, employment types, leave types, attendance / overtime / payroll rules (all the owner's own)
 *
 * No browser reads or writes any of these directly (rules deny it); every read goes through an endpoint that filters what the caller's
 * permissions allow. The employee is NOT a second user system: the sign-in is the existing staff account, linked by uid.
 */
import { db, auth, FieldValue } from "../lib/admin.js";
import { AppError } from "../lib/errors.js";
import { writeAudit } from "../lib/audit.js";
import { pktDateKey } from "../shared/accounting.js";
import { HR_DEFAULTS } from "../shared/hr.js";
import { HR_ROLES } from "../shared/permissions.js";

/** @typedef {{ uid: string, name: string }} Actor */

export const employees = () => db.collection("employees");
export const secure = () => db.collection("employeeSecure");
const history = () => db.collection("employeeHistory");
const iso = (t) => t?.toDate?.().toISOString() ?? null;
const SCAN = 1000;

/** A document as a plain object with its id. @param {FirebaseFirestore.DocumentSnapshot} d @returns {Record<string, any>} */
export const plain = (d) => ({ id: d.id, ...d.data() });
/** The same without the named fields (server timestamps are not JSON). @param {FirebaseFirestore.DocumentSnapshot} d @param {string[]} keys @returns {Record<string, any>} */
export const strip = (d, ...keys) => {
  const o = plain(d);
  for (const k of keys) delete o[k];
  return o;
};

/* ───────── Settings ───────── */

/** The saved HR settings over the starting values (departments and designations start empty). */
export async function getHrSettings() {
  const s = await db.collection("hrSettings").doc("main").get();
  const v = s.exists ? s.data() ?? {} : {};
  return {
    departments: v.departments ?? HR_DEFAULTS.departments,
    designations: v.designations ?? HR_DEFAULTS.designations,
    employmentTypes: v.employmentTypes ?? HR_DEFAULTS.employmentTypes,
    leaveTypes: v.leaveTypes ?? HR_DEFAULTS.leaveTypes,
    attendance: { ...HR_DEFAULTS.attendance, ...(v.attendance ?? {}) },
    overtime: { ...HR_DEFAULTS.overtime, ...(v.overtime ?? {}) },
    payroll: { ...HR_DEFAULTS.payroll, unmarked: "block", ...(v.payroll ?? {}) },
    saved: s.exists,
  };
}

/** @param {Record<string, any>} input validated hrSettingsInput @param {Actor} actor */
export async function saveHrSettings(input, actor) {
  await db.collection("hrSettings").doc("main").set({ ...input, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid }, { merge: false });
  await writeAudit({ actorUid: actor.uid, action: "hr.settings_updated", entityType: "hrSettings", entityId: "main", changes: { departments: input.departments.length, designations: input.designations.length, leaveTypes: input.leaveTypes.length } });
  return getHrSettings();
}

/* ───────── Helpers ───────── */

/** The employee a staff sign-in belongs to, or null. @param {string} uid */
export async function employeeForUid(uid) {
  const link = await db.collection("employeeLinks").doc(uid).get();
  if (!link.exists) return null;
  const e = await employees().doc(link.data()?.employeeId).get();
  return e.exists ? plain(e) : null;
}

/** @param {string} value @param {string[]} list @param {string} label @param {string} field */
function inList(value, list, label, field) {
  if (value && !list.includes(value)) throw new AppError("invalid-argument", `“${value}” isn't one of your ${label}. Add it in HR settings first.`, { fields: { [field]: "Not in the list" } });
}

/** Names of the fields that differ between two flat-ish objects. */
const changedKeys = (before, after, keys) => keys.filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null));

const PROFILE_KEYS = ["name", "phone", "email", "address", "designation", "department", "managerId", "joiningDate", "employmentType", "photoUrl", "emergencyContact", "notes", "shiftId"];

/* ───────── Create / edit ───────── */

/**
 * Create (no id) or edit (id) an employee. The general profile needs hr.write; `sensitive` (CNIC) needs hr.sensitive; `pay` (salary terms) needs hr.salary.write.
 * A section the caller isn't allowed to change is refused, not silently ignored.
 * @param {Record<string, any>} input validated saveEmployeeInput @param {Actor} actor @param {string[]} perms
 */
export async function saveEmployee({ id, profile, sensitive, pay }, actor, perms) {
  if (sensitive && !perms.includes("hr.sensitive")) throw new AppError("permission-denied", "You don't have permission to change CNIC numbers.");
  if (pay && !perms.includes("hr.salary.write")) throw new AppError("permission-denied", "You don't have permission to change salaries.");
  const settings = await getHrSettings();
  inList(profile.department, settings.departments, "departments", "department");
  inList(profile.designation, settings.designations, "designations", "designation");
  inList(profile.employmentType, settings.employmentTypes, "employment types", "employmentType");
  /** @type {string | null} */
  let staffUid = null;
  if (profile.staffEmail) {
    try {
      staffUid = (await auth.getUserByEmail(profile.staffEmail)).uid;
    } catch {
      throw new AppError("not-found", "No sign-in exists for that email yet. Add them as staff first (Staff & Roles), then link them here.", { fields: { staffEmail: "Not found" } });
    }
  }
  /** @type {Record<string, any>} */
  const profileFields = { ...profile };
  delete profileFields.staffEmail;
  const ref = id ? employees().doc(id) : employees().doc();
  const result = await db.runTransaction(async (tx) => {
    const reads = await Promise.all([
      tx.get(ref),
      tx.get(secure().doc(ref.id)),
      profile.managerId ? tx.get(employees().doc(profile.managerId)) : null,
      profile.shiftId ? tx.get(db.collection("shifts").doc(profile.shiftId)) : null,
      staffUid ? tx.get(db.collection("employeeLinks").doc(staffUid)) : null,
      id ? null : tx.get(db.collection("counters").doc("employees")),
      sensitive?.cnic ? tx.get(db.collection("employeeKeys").doc(`cnic_${sensitive.cnic}`)) : null,
    ]);
    const [cur, sec, manager, shift, link, counter, cnicKey] = reads;
    if (id && !cur.exists) throw new AppError("not-found", "That employee doesn't exist.");
    if (profile.managerId) {
      if (profile.managerId === ref.id) throw new AppError("invalid-argument", "A person can't report to themselves.", { fields: { managerId: "Invalid" } });
      if (!manager?.exists) throw new AppError("invalid-argument", "That manager doesn't exist.", { fields: { managerId: "Not found" } });
      // No reporting loops: walk up from the manager.
      let up = manager.data()?.managerId;
      for (let i = 0; up && i < 25; i += 1) {
        if (up === ref.id) throw new AppError("invalid-argument", "That would make a reporting loop.", { fields: { managerId: "Reporting loop" } });
        up = (await tx.get(employees().doc(up))).data()?.managerId;
      }
    }
    if (profile.shiftId && (!shift?.exists || shift.data()?.isActive === false)) throw new AppError("invalid-argument", "That shift doesn't exist or is switched off.", { fields: { shiftId: "Not available" } });
    if (staffUid && link?.exists && link.data()?.employeeId !== ref.id) throw new AppError("already-exists", "That sign-in is already linked to another employee.", { fields: { staffEmail: "Already linked" } });
    if (cnicKey?.exists && cnicKey.data()?.employeeId !== ref.id) throw new AppError("already-exists", "Another employee already has that CNIC.", { fields: { cnic: "Already used" } });
    const before = cur.exists ? cur.data() : null;
    const beforeSec = sec.exists ? sec.data() : null;
    // The counter and the old keys are read BEFORE any write.
    const oldLink = before?.staffUid && before.staffUid !== staffUid ? await tx.get(db.collection("employeeLinks").doc(before.staffUid)) : null;
    const seq = (counter?.exists ? counter.data()?.next : 1) ?? 1;
    const employeeNo = before?.employeeNo ?? `EMP-${String(seq).padStart(4, "0")}`;
    const doc = { ...profileFields, managerId: profile.managerId ?? null, shiftId: profile.shiftId ?? null, staffUid: staffUid ?? before?.staffUid ?? null, nameLower: profile.name.toLowerCase(), phoneDigits: profile.phone.replace(/\D/g, ""), employeeNo, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid };
    if (!id) {
      tx.set(db.collection("counters").doc("employees"), { next: seq + 1 });
      tx.create(ref, { ...doc, status: "active", leavingDate: "", createdAt: FieldValue.serverTimestamp(), createdBy: actor.uid });
    } else tx.update(ref, doc);
    const secDoc = { ...(beforeSec ?? { basicSalary: 0, salaryMethod: "cash", payDetails: "", allowances: [], cnic: "", payConfigured: false }) };
    if (pay) Object.assign(secDoc, { basicSalary: pay.basicSalary, salaryMethod: pay.salaryMethod, payDetails: pay.payDetails, allowances: pay.allowances, payConfigured: true });
    if (sensitive) secDoc.cnic = sensitive.cnic;
    tx.set(secure().doc(ref.id), { ...secDoc, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    if (staffUid) tx.set(db.collection("employeeLinks").doc(staffUid), { employeeId: ref.id });
    if (oldLink?.exists) tx.delete(oldLink.ref);
    if (sensitive) {
      if (beforeSec?.cnic && beforeSec.cnic !== sensitive.cnic) tx.delete(db.collection("employeeKeys").doc(`cnic_${beforeSec.cnic}`));
      if (sensitive.cnic) tx.set(db.collection("employeeKeys").doc(`cnic_${sensitive.cnic}`), { employeeId: ref.id });
    }
    // History: plain fields in the open; pay and CNIC entries are restricted.
    const open = changedKeys(before, { ...doc }, PROFILE_KEYS);
    if (!id) tx.create(history().doc(), { employeeId: ref.id, kind: "created", summary: "Employee added", restricted: null, by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
    else if (open.length) tx.create(history().doc(), { employeeId: ref.id, kind: "profile", summary: `Changed ${open.join(", ")}`, fields: open, restricted: null, by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
    if (pay && beforeSec && (beforeSec.basicSalary !== pay.basicSalary || beforeSec.salaryMethod !== pay.salaryMethod || JSON.stringify(beforeSec.allowances) !== JSON.stringify(pay.allowances))) {
      tx.create(history().doc(), { employeeId: ref.id, kind: "pay", summary: `Salary terms changed: basic ${beforeSec.basicSalary} → ${pay.basicSalary} paisa`, restricted: "hr.salary.read", by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
    } else if (pay && !beforeSec?.payConfigured) {
      tx.create(history().doc(), { employeeId: ref.id, kind: "pay", summary: "Salary terms set", restricted: "hr.salary.read", by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
    }
    if (sensitive && (beforeSec?.cnic ?? "") !== sensitive.cnic) tx.create(history().doc(), { employeeId: ref.id, kind: "cnic", summary: sensitive.cnic ? "CNIC recorded or changed" : "CNIC removed", restricted: "hr.sensitive", by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
    return { id: ref.id, employeeNo, created: !id, changed: [...open, ...(pay ? ["pay"] : []), ...(sensitive ? ["cnic"] : [])] };
  });
  // Audit never carries a salary or a CNIC: only which kinds of field changed.
  await writeAudit({ actorUid: actor.uid, action: result.created ? "hr.employee_created" : "hr.employee_updated", entityType: "employee", entityId: result.id, changes: { fields: result.changed } });
  return { id: result.id, employeeNo: result.employeeNo };
}

/** Active / inactive / left the company. Leaving needs a date; coming back clears it. @param {{ id: string, status: string, leavingDate?: string, reason: string }} input @param {Actor} actor */
export async function setEmployeeStatus({ id, status, leavingDate = "", reason }, actor) {
  await db.runTransaction(async (tx) => {
    const ref = employees().doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new AppError("not-found", "That employee doesn't exist.");
    const date = status === "active" ? "" : leavingDate || pktDateKey(new Date());
    if (status !== "active" && date < snap.data()?.joiningDate) throw new AppError("invalid-argument", "The leaving date is before the joining date.", { fields: { leavingDate: "Too early" } });
    tx.update(ref, { status, leavingDate: date, updatedAt: FieldValue.serverTimestamp(), updatedBy: actor.uid });
    tx.create(history().doc(), { employeeId: id, kind: "status", summary: `Status: ${snap.data()?.status} → ${status}${date ? ` (${date})` : ""}. ${reason}`, restricted: null, by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
  });
  await writeAudit({ actorUid: actor.uid, action: "hr.employee_status", entityType: "employee", entityId: id, changes: { status } });
  return { id, status };
}

/* ───────── Reading ───────── */

/** @param {Record<string, any>} e @param {Record<string, any> | null} sec @param {string[]} perms */
function publicView(e, sec, perms) {
  /** @type {Record<string, any>} */
  const out = { ...e, createdAt: iso(e.createdAt), updatedAt: iso(e.updatedAt) };
  delete out.nameLower;
  delete out.phoneDigits;
  if (perms.includes("hr.salary.read") && sec) Object.assign(out, { pay: { basicSalary: sec.basicSalary ?? 0, salaryMethod: sec.salaryMethod ?? "cash", payDetails: sec.payDetails ?? "", allowances: sec.allowances ?? [], configured: Boolean(sec.payConfigured) } });
  return out;
}

/** The directory. Pay terms are included only for people who may see salaries. @param {Record<string, any>} q @param {string[]} perms */
export async function listEmployees({ q = "", status = "active", department = "", designation = "", managerId, limit = 50, offset = 0 }, perms) {
  const snap = await employees().limit(SCAN + 1).get();
  if (snap.size > SCAN) throw new AppError("failed-precondition", `There are more than ${SCAN} employees; narrow the search.`);
  const text = q.trim().toLowerCase();
  const phoneLike = /^[+\d][\d\s()-]{5,}$/.test(q.trim());
  const digits = phoneLike ? text.replace(/\D/g, "") : "";
  let rows = snap.docs.map(plain).filter((e) => (status === "all" || e.status === status) && (!department || e.department === department) && (!designation || e.designation === designation) && (!managerId || e.managerId === managerId) && (!text || e.nameLower?.includes(text) || e.employeeNo.toLowerCase() === text || (e.email ?? "").toLowerCase().includes(text) || (digits.length >= 4 && (e.phoneDigits ?? "").includes(digits))));
  rows.sort((a, b) => a.nameLower.localeCompare(b.nameLower));
  const total = rows.length;
  rows = rows.slice(offset, offset + limit);
  const secs = perms.includes("hr.salary.read") && rows.length ? await db.getAll(...rows.map((r) => secure().doc(r.id))) : [];
  const names = new Map(snap.docs.map((d) => [d.id, d.data().name]));
  return { total, employees: rows.map((e, i) => ({ ...publicView(e, secs[i]?.data() ?? null, perms), managerName: e.managerId ? (names.get(e.managerId) ?? null) : null })) };
}

/** One employee with everything the caller's permissions allow. @param {{ id: string }} input @param {string[]} perms */
export async function getEmployee({ id }, perms) {
  const [snap, sec] = await Promise.all([employees().doc(id).get(), secure().doc(id).get()]);
  if (!snap.exists) throw new AppError("not-found", "That employee doesn't exist.");
  const e = plain(snap);
  const [hist, docs, manager, reports, shift] = await Promise.all([
    history().where("employeeId", "==", id).orderBy("at", "desc").limit(100).get(),
    perms.includes("hr.sensitive") ? db.collection("employeeDocs").where("employeeId", "==", id).limit(50).get() : null,
    e.managerId ? employees().doc(e.managerId).get() : null,
    employees().where("managerId", "==", id).limit(100).get(),
    e.shiftId ? db.collection("shifts").doc(e.shiftId).get() : null,
  ]);
  const view = publicView(e, sec.data() ?? null, perms);
  if (perms.includes("hr.sensitive")) /** @type {any} */ (view).cnic = sec.data()?.cnic ?? "";
  return {
    employee: view,
    managerName: manager?.data()?.name ?? null,
    reports: reports.docs.map((d) => ({ id: d.id, name: d.data().name, designation: d.data().designation ?? "" })),
    shift: shift?.exists ? { id: shift.id, name: shift.data()?.name } : null,
    documents: (docs?.docs ?? []).map((d) => ({ id: d.id, ...d.data(), at: iso(d.data().at) })),
    history: hist.docs.map(plain).filter((h) => !h.restricted || perms.includes(h.restricted)).map((h) => ({ id: h.id, kind: h.kind, summary: h.summary, byName: h.byName, at: iso(h.at) })),
  };
}

/* ───────── Documents ───────── */

/** @param {Record<string, any>} input validated employeeDocInput @param {Actor} actor */
export async function addDocument({ employeeId, kind, name, url, type, size }, actor) {
  const e = await employees().doc(employeeId).get();
  if (!e.exists) throw new AppError("not-found", "That employee doesn't exist.");
  const count = await db.collection("employeeDocs").where("employeeId", "==", employeeId).count().get();
  if (count.data().count >= 20) throw new AppError("failed-precondition", "At most 20 documents per employee.");
  const ref = db.collection("employeeDocs").doc();
  await ref.create({ employeeId, kind, name, url, type, size, by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
  await history().doc().create({ employeeId, kind: "document", summary: `Document added: ${name}`, restricted: "hr.sensitive", by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "hr.document_added", entityType: "employee", entityId: employeeId, changes: { kind } });
  return { id: ref.id };
}

/** @param {{ employeeId: string, docId: string }} input @param {Actor} actor */
export async function removeDocument({ employeeId, docId }, actor) {
  const ref = db.collection("employeeDocs").doc(docId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.employeeId !== employeeId) throw new AppError("not-found", "That document doesn't exist.");
  await ref.delete();
  await history().doc().create({ employeeId, kind: "document", summary: `Document removed: ${snap.data()?.name}`, restricted: "hr.sensitive", by: actor.uid, byName: actor.name, at: FieldValue.serverTimestamp() });
  await writeAudit({ actorUid: actor.uid, action: "hr.document_removed", entityType: "employee", entityId: employeeId, changes: { kind: snap.data()?.kind } });
  return { docId };
}

/* ───────── Roles ───────── */

/** Create the HR Manager, Payroll Accountant and Employee roles if they don't exist. An explicit owner action; existing roles are left alone. @param {string} actorUid */
export async function createHrRoles(actorUid) {
  return db.runTransaction(async (tx) => {
    const keys = Object.keys(HR_ROLES);
    const refs = keys.map((k) => db.collection("roles").doc(k));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    /** @type {string[]} */
    const created = [];
    snaps.forEach((s, i) => {
      if (s.exists) return;
      tx.create(refs[i], { name: HR_ROLES[keys[i]].name, permissions: HR_ROLES[keys[i]].permissions, system: true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      created.push(keys[i]);
    });
    if (created.length) writeAudit({ actorUid, action: "hr.roles_created", entityType: "roles", entityId: created.join(","), changes: { created } }, tx);
    return { created };
  });
}
