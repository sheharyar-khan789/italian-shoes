/**
 * HR, attendance, leave and payroll against the emulators (`npm run test:emulator`). Every payroll figure is worked out by hand in the comments:
 * the dates are RELATIVE to the previous month, so the numbers don't change with the calendar. Tests share state and run in order.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const PROJECT = "demo-italianshoes";
assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "run via `npm run test:emulator`");
process.env.GCLOUD_PROJECT ??= PROJECT;

const { db, auth, FieldValue } = await import("../../functions/lib/admin.js");
const { handleApi } = await import("../../functions/handler.js");
const catalog = await import("../../functions/services/catalog.js");
const products = await import("../../functions/services/products.js");
const inventory = await import("../../functions/services/inventory.js");
const warehouses = await import("../../functions/services/warehouses.js");
const accounting = await import("../../functions/services/accounting.js");
const schemas = await import("../../functions/shared/schemas/index.js");
const { pktDateKey } = await import("../../functions/shared/accounting.js");
const { addDays } = await import("../../functions/shared/finance.js");
const { weekdayOf } = await import("../../functions/shared/hr.js");
const { HR_ROLES, effectivePermissions, ALL_PERMISSIONS } = await import("../../functions/shared/permissions.js");

const STAFF = "staff-1";
const ids = {};
const key = () => randomUUID().replace(/-/g, "");
const today = pktDateKey(new Date());
const CM = today.slice(0, 7);
const PM = (() => {
  const [y, m] = CM.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
})();
const firstMonday = (month) => {
  let d = `${month}-01`;
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
};
const D = firstMonday(PM);
const at = (n) => addDays(D, n);

const TOKENS = {
  owner: { uid: "hr-owner", name: "Owner", staff: true, perms: [...ALL_PERMISSIONS], auth_time: 9999999999 },
  hrm: { uid: "hr-mgr", name: "HR Manager", staff: true, perms: [...HR_ROLES.hr_manager.permissions], auth_time: 9999999999 },
  acct: { uid: "hr-acct", name: "Accountant", staff: true, perms: [...HR_ROLES.payroll_accountant.permissions], auth_time: 9999999999 },
  reader: { uid: "hr-read", name: "Reader", staff: true, perms: ["hr.read"], auth_time: 9999999999 },
  salary: { uid: "hr-sal", name: "Salary viewer", staff: true, perms: ["hr.read", "hr.salary.read"], auth_time: 9999999999 },
  writer: { uid: "hr-wr", name: "Writer", staff: true, perms: ["hr.read", "hr.write"], auth_time: 9999999999 },
  emp1: { uid: "hr-emp1", name: "Asad", staff: true, perms: ["hr.self", "pos.access", "pos.sell", "pos.register"], auth_time: 9999999999 },
  emp2: { uid: "hr-emp2", name: "Bilal", staff: true, perms: [...HR_ROLES.employee.permissions], auth_time: 9999999999 },
  emp3: { uid: "hr-emp3", name: "Unlinked", staff: true, perms: [...HR_ROLES.employee.permissions], auth_time: 9999999999 },
  cashier: { uid: "hr-cash", name: "Cashier", staff: true, perms: ["pos.access", "pos.sell", "pos.register"], auth_time: 9999999999 },
  customer: { uid: "cust-acct" },
};
const verifyToken = async (t) => {
  if (!(t in TOKENS)) throw new Error("bad token");
  return TOKENS[t];
};
const call = (name, token, data) => handleApi({ method: "POST", name, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: { data } }, { verifyToken });
const ok = async (name, token, data) => {
  const r = await call(name, token, data);
  assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.body)}`);
  return r.body.data;
};
const get = async (path) => (await db.doc(path).get()).data();
const net = async (code) => (await db.collection("ledgerEntries").where("accountCode", "==", code).get()).docs.reduce((n, d) => n + d.data().debit - d.data().credit, 0);
const profile = (over = {}) => ({ name: "Asad Ali", phone: "0300 1112223", email: "", address: "Lahore", designation: "Sales Associate", department: "Sales", managerId: null, joiningDate: "2025-01-01", employmentType: "Full-time", photoUrl: "", emergencyContact: { name: "Father", phone: "0301 2223334", relation: "Parent" }, notes: "", shiftId: null, staffEmail: "", ...over });
const payTerms = (over = {}) => ({ basicSalary: 3000000, salaryMethod: "bank_transfer", payDetails: "HBL ••1234", allowances: [{ name: "Fuel", amount: 200000 }], ...over });
const setPayroll = (unmarked) => ({ departments: ["Sales", "Admin"], designations: ["Sales Associate", "Manager"], employmentTypes: ["Full-time", "Part-time"], leaveTypes: [{ key: "annual", name: "Annual leave", days: 14, paid: true }, { key: "sick", name: "Sick leave", days: 8, paid: true }, { key: "casual", name: "Casual leave", days: 10, paid: true }, { key: "unpaid", name: "Unpaid leave", days: 0, paid: false }], attendance: { halfDayDeductDays: 0.5, absentDeductDays: 1, lateEvery: 3, lateDeductDays: 0.5 }, overtime: { enabled: true, multiplier: 1.5, minMinutes: 30 }, payroll: { dailyRateBasis: "30", unmarked } });
const mark = (token, employeeId, date, status, checkIn = "", checkOut = "") => call("markAttendance", token, { employeeId, date, status, checkIn, checkOut, note: "" });

before(async () => {
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  for (const t of Object.values(TOKENS)) if (t.uid !== "cust-acct") await auth.createUser({ uid: t.uid, ...(t.uid === "hr-emp1" ? { email: "asad@example.test" } : t.uid === "hr-emp2" ? { email: "bilal@example.test" } : {}) }).catch(() => {});
  ids.cat = (await catalog.saveCatalogItem("category", schemas.saveCategoryInput.parse({ name: "Formal", slug: "formal" }), STAFF)).id;
  ids.black = (await catalog.saveCatalogItem("color", { name: "Black", hex: "#111111" }, STAFF)).id;
  ids.s42 = (await catalog.saveCatalogItem("size", { system: "EU", value: "42", sortOrder: 42 }, STAFF)).id;
  await db.doc("settings/public").set({ storeName: "Test Store", isOpen: true });
  await db.doc("settings/private").set({ orderPrefix: "TS", lowStockThreshold: 1, notifyLowStock: false });
  ids.shop = (await warehouses.saveWarehouse(schemas.saveWarehouseInput.parse({ name: "Shop floor", code: "SHOP", sellsOnline: false }), STAFF)).id;
  await accounting.initializeAccounting(STAFF);
  const productId = (await products.saveProduct(schemas.saveProductInput.parse({ name: "Oxford One", slug: "oxford-one", categoryId: ids.cat, sku: "OX-1" }), STAFF)).id;
  await products.createVariants(schemas.createVariantsInput.parse({ productId, colorIds: [ids.black], sizeIds: [ids.s42], price: 1000000, salePrice: null, costPrice: 600000 }), { actorUid: STAFF, canEditCost: true });
  ids.p1 = { productId, variantId: products.variantKey(ids.black, ids.s42) };
  await inventory.adjustStock({ ...ids.p1, warehouseId: ids.shop, change: 100, reason: "initial", note: "" }, STAFF);
  await db.doc(`products/${productId}`).update({ status: "published" });
});

test("the chart gets Employee advances, Salaries payable and Payroll deductions; HR roles are created by the owner and give each job only its own access", async () => {
  const cfg = (await accounting.configRef().get()).data();
  assert.deepEqual(["employee_advances", "salary_payable", "payroll_deductions"].map((r) => cfg.roles[r]), ["1130", "2030", "2040"]);
  assert.equal((await call("createHrRoles", "hrm", {})).status, 403);
  const c = await ok("createHrRoles", "owner", {});
  assert.deepEqual(c.created.sort(), ["employee", "hr_manager", "payroll_accountant"]);
  assert.deepEqual((await ok("createHrRoles", "owner", {})).created, [], "existing roles are left alone");
  const roles = Object.fromEntries((await db.collection("roles").get()).docs.map((d) => [d.id, d.data().permissions]));
  assert.ok(roles.employee.length === 1 && roles.employee[0] === "hr.self");
  assert.ok(!roles.hr_manager.includes("hr.payroll.approve") && !roles.hr_manager.includes("hr.payroll.pay"), "the HR manager prepares payroll but can't approve or pay it");
  assert.ok(roles.payroll_accountant.includes("hr.payroll.approve") && !roles.payroll_accountant.includes("hr.write"), "the accountant approves and pays but can't change employees");
  assert.deepEqual(effectivePermissions(["employee"], { employee: { permissions: ["hr.self"] } }), ["hr.self"]);
});

test("nobody without an HR permission can reach HR data; a cashier can't see anything confidential", async () => {
  for (const name of ["listEmployees", "attendanceDay", "payrollRun", "listAdvances", "hrDashboard", "listShifts"]) {
    for (const who of ["cashier", "emp2"]) assert.equal((await call(name, who, name === "attendanceDay" ? { date: today } : name === "payrollRun" ? { month: CM } : name === "listAdvances" ? {} : {})).status, 403, `${who} → ${name}`);
    assert.equal((await call(name, null, {})).status, 401);
  }
  assert.equal((await call("saveHrSettings", "hrm", setPayroll("present"))).status, 200, "the HR manager sets up the organisation");
  assert.equal((await call("saveHrSettings", "reader", setPayroll("present"))).status, 403);
});

test("employees: unique ID, validation of the configured lists, reporting lines, shift and sign-in link; no loops; audit never carries pay or CNIC", async () => {
  assert.equal((await call("saveEmployee", "hrm", { profile: profile({ department: "Marketing" }) })).status, 400, "a department that isn't configured is refused");
  const shift = await ok("saveShift", "hrm", { name: "Day", start: "09:00", end: "18:00", breakMinutes: 60, graceMinutes: 10, workingDays: [1, 2, 3, 4, 5, 6], isActive: true });
  ids.shift = shift.id;
  const mgr = await ok("saveEmployee", "hrm", { profile: profile({ name: "Maria Manager", phone: "0300 5550001", designation: "Manager", department: "Admin", shiftId: ids.shift }), pay: payTerms({ basicSalary: 5000000, allowances: [] }), sensitive: { cnic: "35202-1111111-1" } });
  assert.equal(mgr.employeeNo, "EMP-0001");
  const e1 = await ok("saveEmployee", "hrm", { profile: profile({ shiftId: ids.shift, managerId: mgr.id, staffEmail: "asad@example.test" }), pay: payTerms(), sensitive: { cnic: "3520222222222" } });
  assert.equal(e1.employeeNo, "EMP-0002");
  ids.e1 = e1.id;
  ids.mgr = mgr.id;
  const e2 = await ok("saveEmployee", "hrm", { profile: profile({ name: "Bilal Khan", phone: "0300 5550002", shiftId: ids.shift, staffEmail: "bilal@example.test" }), pay: payTerms({ basicSalary: 1500000, allowances: [], salaryMethod: "cash", payDetails: "" }) });
  ids.e2 = e2.id;
  assert.equal(e2.employeeNo, "EMP-0003");
  assert.equal((await call("saveEmployee", "hrm", { profile: profile({ name: "Copy", phone: "0300 5550009" }), sensitive: { cnic: "35202-1111111-1" } })).status, 409, "a CNIC belongs to one employee");
  assert.equal((await call("saveEmployee", "hrm", { profile: profile({ name: "Copy", phone: "0300 5550009", staffEmail: "asad@example.test" }) })).status, 409, "one sign-in, one employee");
  assert.equal((await call("saveEmployee", "hrm", { profile: profile({ staffEmail: "nobody@example.test", name: "Ghost" }) })).status, 404);
  assert.equal((await call("saveEmployee", "hrm", { id: mgr.id, profile: profile({ name: "Maria Manager", phone: "0300 5550001", designation: "Manager", department: "Admin", managerId: ids.e1 }) })).status, 400, "a reporting loop is refused");
  assert.equal((await call("saveEmployee", "hrm", { id: ids.e1, profile: profile({ managerId: ids.e1, staffEmail: "asad@example.test" }) })).status, 400, "nobody reports to themselves");
  assert.equal((await call("saveEmployee", "writer", { profile: profile({ name: "X Y", phone: "0300 5550010" }), pay: payTerms() })).status, 403, "pay terms need hr.salary.write");
  assert.equal((await call("saveEmployee", "writer", { profile: profile({ name: "X Y", phone: "0300 5550010" }), sensitive: { cnic: "3520233333333" } })).status, 403, "CNIC needs hr.sensitive");
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => JSON.stringify(d.data()));
  assert.ok(audit.some((a) => a.includes("hr.employee_created")));
  assert.ok(!audit.some((a) => a.includes("3520222222222") || a.includes("35202-1111111-1") || a.includes("basicSalary")), "no CNIC or salary in the audit log");
  const link = await get("employeeLinks/hr-emp1");
  assert.equal(link.employeeId, ids.e1);
});

test("privacy: salary and CNIC are shown only to people with those permissions, in lists, profiles, history, reports and exports", async () => {
  const asReader = await ok("getEmployee", "reader", { id: ids.e1 });
  assert.equal(asReader.employee.pay, undefined);
  assert.equal(asReader.employee.cnic, undefined);
  assert.deepEqual(asReader.documents, []);
  assert.ok(!asReader.history.some((h) => /Salary|CNIC/.test(h.summary)), "restricted history entries are hidden");
  const asSalary = await ok("getEmployee", "salary", { id: ids.e1 });
  assert.equal(asSalary.employee.pay.basicSalary, 3000000);
  assert.equal(asSalary.employee.cnic, undefined, "salary permission doesn't open the CNIC");
  assert.ok(asSalary.history.some((h) => /Salary terms/.test(h.summary)));
  const asHr = await ok("getEmployee", "hrm", { id: ids.e1 });
  assert.equal(asHr.employee.cnic, "3520222222222");
  assert.ok(asHr.history.some((h) => /CNIC/.test(h.summary)));
  const list = await ok("listEmployees", "reader", { status: "all" });
  assert.ok(list.employees.every((e) => e.pay === undefined && e.cnic === undefined));
  assert.equal(list.total, 3);
  assert.ok((await ok("listEmployees", "salary", {})).employees.every((e) => typeof e.pay.basicSalary === "number"));
  assert.deepEqual((await ok("listEmployees", "reader", { q: "bilal" })).employees.map((e) => e.name), ["Bilal Khan"]);
  assert.deepEqual((await ok("listEmployees", "reader", { q: "EMP-0002" })).employees.map((e) => e.name), ["Asad Ali"]);
  assert.deepEqual((await ok("listEmployees", "reader", { q: "0300 5550002" })).employees.map((e) => e.name), ["Bilal Khan"]);
  assert.deepEqual((await ok("listEmployees", "reader", { managerId: ids.mgr })).employees.map((e) => e.name), ["Asad Ali"]);
  const dir = await ok("hrReport", "reader", { report: "directory", from: today, to: today });
  assert.ok(!dir.tables[0].columns.some((c) => c.key === "basic"), "the directory has no salary column without salary permission");
  assert.ok(JSON.stringify(dir).indexOf("3520222222222") < 0);
  assert.ok(dir.tables[0].rows.length === 3);
  assert.equal((await call("hrReport", "reader", { report: "payroll_summary", from: today, to: today })).status, 403);
  assert.equal((await call("hrExport", "reader", { report: "directory", format: "csv", from: today, to: today })).status, 403, "export needs hr.export");
  assert.equal((await call("hrExport", "hrm", { report: "directory", format: "csv", from: today, to: today })).status, 200);
  assert.equal((await call("addEmployeeDocument", "writer", { employeeId: ids.e1, kind: "cnic", name: "CNIC front", url: "hr/x/cnic.png", type: "image/png", size: 1000 })).status, 403);
  await ok("addEmployeeDocument", "hrm", { employeeId: ids.e1, kind: "cnic", name: "CNIC front", url: "hr/x/cnic.png", type: "image/png", size: 1000 });
  assert.equal((await call("addEmployeeDocument", "hrm", { employeeId: ids.e1, kind: "cnic", name: "Bad", url: "http://evil.example/x.png", type: "image/png", size: 10 })).status, 400, "only uploaded files are accepted");
  assert.equal((await ok("getEmployee", "hrm", { id: ids.e1 })).documents.length, 1);
  assert.equal((await ok("getEmployee", "salary", { id: ids.e1 })).documents.length, 0, "documents need hr.sensitive");
});

test("employee status: leaving needs a valid date; history keeps who and why; a left employee can't be marked present after the leaving date", async () => {
  const temp = await ok("saveEmployee", "hrm", { profile: profile({ name: "Temp Worker", phone: "0300 5550003", shiftId: ids.shift }), pay: payTerms({ basicSalary: 900000, allowances: [] }) });
  assert.equal((await call("setEmployeeStatus", "hrm", { id: temp.id, status: "terminated", leavingDate: "2024-12-31", reason: "Test" })).status, 400, "before the joining date");
  await ok("setEmployeeStatus", "hrm", { id: temp.id, status: "terminated", leavingDate: at(2), reason: "Contract ended" });
  assert.equal((await mark("hrm", temp.id, at(3), "present")).status, 400, "not an active employee after leaving");
  assert.ok([400, 412, 409].includes((await mark("hrm", temp.id, at(3), "present")).status));
  assert.equal((await mark("hrm", temp.id, at(1), "present", "09:00", "18:00")).status, 200, "still markable up to the leaving date");
  assert.deepEqual((await ok("listEmployees", "hrm", {})).employees.map((e) => e.name).includes("Temp Worker"), false, "the default list shows active people");
  const h = (await ok("getEmployee", "hrm", { id: temp.id })).history.map((x) => x.summary).join(" | ");
  assert.match(h, /Contract ended/);
  await ok("setEmployeeStatus", "hrm", { id: temp.id, status: "active", reason: "Re-hired" });
  assert.equal((await get(`employees/${temp.id}`)).leavingDate, "");
  ids.temp = temp.id;
});

test("attendance: one record per employee per day, future and pre-joining dates refused, late / early / overtime worked out from the shift, bulk marking skips (never overwrites)", async () => {
  const m = async (employeeId, d, st, i = "", o = "") => ok("markAttendance", "hrm", { employeeId, date: d, status: st, checkIn: i, checkOut: o, note: "" });
  // Shift 09:00–18:00, break 60, grace 10: arriving 09:35 is 25 minutes late; leaving 17:30 is 30 minutes early; leaving 18:45 is 45 minutes overtime.
  const a = await m(ids.e2, at(0), "present", "09:35", "17:30");
  assert.deepEqual([a.status, a.lateMinutes, a.overtimeMinutes], ["late", 25, 0]);
  const rec = await get(`attendance/${ids.e2}__${at(0)}`);
  assert.deepEqual([rec.earlyMinutes, rec.workedMinutes, rec.month], [30, 17 * 60 + 30 - (9 * 60 + 35) - 60, PM]);
  const b = await m(ids.e2, at(1), "present", "09:05", "18:45");
  assert.deepEqual([b.status, b.lateMinutes, b.overtimeMinutes], ["present", 0, 45], "inside the grace period is not late");
  assert.equal((await m(ids.e2, at(2), "present", "09:00", "18:20")).overtimeMinutes, 0, "20 minutes is below the 30-minute minimum");
  const dup = await mark("hrm", ids.e2, at(0), "present");
  assert.equal(dup.status, 409);
  assert.match(dup.body.error.message, /already marked/);
  assert.equal((await call("markAttendance", "hrm", { employeeId: ids.e2, date: addDays(today, 3), status: "present", checkIn: "", checkOut: "", note: "" })).status, 400);
  assert.ok([400, 412].includes((await mark("hrm", ids.e2, addDays(today, 3), "present")).status), "the future");
  assert.ok([400, 412].includes((await mark("hrm", ids.e2, "2024-12-31", "present")).status), "before the joining date");
  assert.equal((await call("markAttendance", "hrm", { employeeId: ids.e2, date: at(3), status: "present", checkIn: "", checkOut: "18:00", note: "" })).status, 400, "a departure needs an arrival");
  assert.equal((await mark("reader", ids.e2, at(3), "present")).status, 403);
  assert.equal((await mark("emp2", ids.e2, at(3), "present")).status, 403, "an employee can't mark attendance");
  const bulk = await ok("bulkMarkAttendance", "hrm", { date: at(0), entries: [{ employeeId: ids.e1, status: "present", checkIn: "09:00", checkOut: "18:00" }, { employeeId: ids.e2, status: "absent" }, { employeeId: ids.mgr, status: "present", checkIn: "", checkOut: "" }] });
  assert.equal(bulk.created, 2);
  assert.deepEqual(bulk.skipped.map((s) => s.employeeId), [ids.e2]);
  assert.equal((await get(`attendance/${ids.e2}__${at(0)}`)).status, "late", "the existing record was not overwritten");
  assert.equal((await db.collection("attendance").where("date", "==", at(0)).get()).size, 3);
  assert.equal((await call("bulkMarkAttendance", "hrm", { date: at(1), entries: [{ employeeId: ids.e1, status: "present" }, { employeeId: ids.e1, status: "absent" }] })).status, 400, "an employee listed twice");
});

test("attendance corrections keep the old values, who changed them and why; the calendar and the day sheet come from the records", async () => {
  assert.equal((await call("correctAttendance", "hrm", { employeeId: ids.e2, date: at(0), status: "present", checkIn: "09:00", checkOut: "18:00", reason: "" })).status, 400, "a reason is required");
  assert.equal((await call("correctAttendance", "hrm", { employeeId: ids.e2, date: at(9), status: "present", checkIn: "", checkOut: "", reason: "Missing" })).status, 404, "nothing to correct");
  const c = await ok("correctAttendance", "hrm", { employeeId: ids.e2, date: at(0), status: "present", checkIn: "09:00", checkOut: "18:00", reason: "Machine was wrong" });
  assert.deepEqual([c.from, c.to], ["late", "present"]);
  const rec = await get(`attendance/${ids.e2}__${at(0)}`);
  assert.equal(rec.corrections.length, 1);
  assert.deepEqual([rec.corrections[0].before.status, rec.corrections[0].after.status, rec.corrections[0].reason, rec.corrections[0].byName], ["late", "present", "Machine was wrong", "HR Manager"]);
  assert.equal(rec.lateMinutes, 0);
  const audit = (await db.collection("auditLogs").get()).docs.map((d) => d.data()).filter((a) => a.action === "hr.attendance_corrected");
  assert.ok(audit.length === 1 && audit[0].changes.reason === "Machine was wrong");
  const day = await ok("attendanceDay", "reader", { date: at(0) });
  assert.equal(day.rows.length, 4, "everyone employed on that day (Maria, Asad, Bilal, Temp)");
  assert.equal(day.rows.find((r) => r.employeeId === ids.e2).record.status, "present");
  const month = await ok("employeeAttendanceMonth", "reader", { employeeId: ids.e2, month: PM });
  assert.equal(month.days.length, new Date(Date.UTC(Number(PM.slice(0, 4)), Number(PM.slice(5, 7)), 0)).getUTCDate());
  assert.deepEqual([month.summary.present, month.summary.overtimeMinutes], [3, 45]);
  assert.equal(month.days.find((d) => d.date === addDays(D, 6)).expected, "weekly_off", "Sunday is the weekly off of this shift");
  assert.equal((await ok("monthlyAttendance", "reader", { month: PM })).rows.find((r) => r.name === "Bilal Khan").present, 3);
});

test("holidays and leave: working days only, balances, overlap, half days, unpaid leave unlimited; approval fills attendance and uses the balance; only managers decide", async () => {
  await ok("saveHoliday", "hrm", { date: at(10), name: "Test holiday" });
  assert.equal((await ok("listHolidays", "emp2", { year: Number(PM.slice(0, 4)) })).holidays.some((h) => h.date === at(10)), true);
  assert.equal((await call("saveHoliday", "reader", { date: at(11), name: "Nope" })).status, 403);
  const apply = (token, over) => call("applyLeave", token, { idempotencyKey: key(), type: "casual", from: at(7), to: at(7), halfDay: false, reason: "Family event", ...over });
  // Friday → Monday covers a Sunday weekly off: 3 working days.
  const span = await ok("applyLeave", "hrm", { idempotencyKey: key(), employeeId: ids.e2, type: "annual", from: at(11), to: addDays(at(11), 3), halfDay: false, reason: "Trip" });
  assert.equal(span.days, weekdayOf(at(11)) === 6 ? 3 : 3 /* at(11) is a Saturday: Sat, (Sun off), Mon, Tue */, "weekly off days don't use up leave");
  const key1 = key();
  const first = await ok("applyLeave", "emp1", { idempotencyKey: key1, type: "casual", from: at(8), to: at(8), halfDay: false, reason: "Cousin's wedding" });
  assert.equal((await ok("applyLeave", "emp1", { idempotencyKey: key1, type: "casual", from: at(8), to: at(8), halfDay: false, reason: "Cousin's wedding" })).id, first.id, "a retried request is the same request");
  assert.equal((await apply("emp1", { from: at(8), to: at(9) })).status, 409, "overlaps the first request");
  assert.equal((await apply("emp1", { from: addDays(D, 40), to: addDays(D, 70) })).status, 400, "more days than the casual balance");
  assert.equal((await apply("emp1", { from: addDays(at(6), 0), to: addDays(at(6), 0) })).status, 400, "a Sunday has no working day to take leave on");
  assert.equal((await apply("emp1", { from: at(10), to: at(10) })).status, 400, "a holiday needs no leave");
  assert.equal((await apply("emp1", { from: at(7), to: at(7), halfDay: true, type: "nope" })).status, 400);
  assert.equal((await apply("emp2", { employeeId: ids.e1 })).status, 403, "an employee can't apply on someone else's behalf");
  assert.equal((await call("decideLeave", "emp1", { id: first.id, decision: "approve" })).status, 403, "an employee can't approve their own leave");
  assert.equal((await call("decideLeave", "hrm", { id: first.id, decision: "approve" })).status, 200);
  assert.equal((await call("decideLeave", "hrm", { id: first.id, decision: "approve" })).status, 400, "already decided");
  const att = await get(`attendance/${ids.e1}__${at(8)}`);
  assert.deepEqual([att.status, att.leaveType, att.leavePaid, att.leaveId], ["leave", "casual", true, first.id]);
  const bal = (await ok("leaveBalance", "emp1", { year: Number(at(8).slice(0, 4)) })).balances.find((b) => b.type === "casual");
  assert.deepEqual([bal.allowance, bal.used, bal.remaining], [10, 1, 9]);
  // Unpaid leave and a conflict with recorded attendance.
  const unpaid = await ok("applyLeave", "emp1", { idempotencyKey: key(), type: "unpaid", from: at(7), to: at(7), halfDay: false, reason: "Personal" });
  await ok("markAttendance", "hrm", { employeeId: ids.e1, date: at(7), status: "present", checkIn: "09:00", checkOut: "18:00", note: "" });
  const clash = await call("decideLeave", "hrm", { id: unpaid.id, decision: "approve" });
  assert.equal(clash.status, 400);
  assert.match(clash.body.error.message, /Attendance is already recorded/);
  await ok("correctAttendance", "hrm", { employeeId: ids.e1, date: at(7), status: "absent", checkIn: "", checkOut: "", reason: "Was absent" });
  await ok("decideLeave", "hrm", { id: unpaid.id, decision: "approve" });
  const u = await get(`attendance/${ids.e1}__${at(7)}`);
  assert.deepEqual([u.status, u.leavePaid], ["leave", false], "approved leave replaced the absence");
  assert.equal((await ok("leaveBalance", "emp1", { year: Number(at(8).slice(0, 4)) })).balances.find((b) => b.type === "unpaid").unlimited, true);
  const rejected = await ok("applyLeave", "emp1", { idempotencyKey: key(), type: "sick", from: at(9), to: at(9), halfDay: false, reason: "Cold" });
  await ok("decideLeave", "hrm", { id: rejected.id, decision: "reject", note: "Short staffed" });
  assert.equal((await get(`leaveRequests/${rejected.id}`)).status, "rejected");
  assert.equal((await get(`attendance/${ids.e1}__${at(9)}`)), undefined, "a rejected request changes nothing");
  assert.equal((await ok("leaveCalendar", "reader", { month: PM })).leave.length >= 3, true);
  assert.equal((await ok("listLeave", "reader", { status: "pending" })).requests.length, 1, "the annual leave for Bilal is still pending");
});

test("leave balances can only be changed by an authorised, audited, repeatable adjustment; future approved leave can be cancelled and the days come back", async () => {
  const year = Number(at(8).slice(0, 4));
  assert.equal((await call("adjustLeaveBalance", "emp1", { idempotencyKey: key(), employeeId: ids.e1, year, type: "casual", days: 5, reason: "Give me more" })).status, 403);
  assert.equal((await call("adjustLeaveBalance", "writer", { idempotencyKey: key(), employeeId: ids.e1, year, type: "casual", days: 5, reason: "No right" })).status, 403);
  const k = key();
  await ok("adjustLeaveBalance", "hrm", { idempotencyKey: k, employeeId: ids.e1, year, type: "casual", days: 2, reason: "Carried over" });
  await ok("adjustLeaveBalance", "hrm", { idempotencyKey: k, employeeId: ids.e1, year, type: "casual", days: 2, reason: "Carried over" });
  assert.equal((await ok("leaveBalance", "emp1", { year })).balances.find((b) => b.type === "casual").remaining, 11, "10 + 2 − 1 used: the repeated request added nothing");
  assert.equal((await call("adjustLeaveBalance", "hrm", { idempotencyKey: key(), employeeId: ids.e1, year, type: "casual", days: 0, reason: "Zero" })).status, 400);
  assert.equal((await call("adjustLeaveBalance", "hrm", { idempotencyKey: key(), employeeId: ids.e1, year, type: "casual", days: 1, reason: "" })).status, 400);
  assert.ok((await db.collection("auditLogs").get()).docs.some((d) => d.data().action === "hr.leave_adjusted" && d.data().changes.reason === "Carried over"));
  assert.equal((await call("leaveBalance", "emp2", { employeeId: ids.e1, year })).status, 403, "an employee can't read someone else's balance");
  // Future leave: apply, approve, cancel — the balance returns and the attendance days disappear.
  let d = addDays(today, 10);
  while (weekdayOf(d) === 0) d = addDays(d, 1);
  const fut = await ok("applyLeave", "emp1", { idempotencyKey: key(), type: "annual", from: d, to: d, halfDay: false, reason: "Holiday" });
  await ok("decideLeave", "hrm", { id: fut.id, decision: "approve" });
  assert.equal((await ok("leaveBalance", "emp1", { year: Number(d.slice(0, 4)) })).balances.find((b) => b.type === "annual").used, 1);
  assert.equal((await call("cancelLeave", "emp2", { id: fut.id })).status, 403, "someone else's request");
  await ok("cancelLeave", "emp1", { id: fut.id });
  assert.equal((await ok("leaveBalance", "emp1", { year: Number(d.slice(0, 4)) })).balances.find((b) => b.type === "annual").used, 0);
  assert.equal((await get(`attendance/${ids.e1}__${d}`)), undefined);
  assert.equal((await call("cancelLeave", "emp1", { id: first_(await ok("listLeave", "hrm", { status: "approved" }), ids.e1) })).status, 400, "leave that has already started can't be cancelled");
});
const first_ = (list, employeeId) => list.requests.find((r) => r.employeeId === employeeId && r.from <= today).id;

test("shifts are assigned to employees; weekly schedule is the shift's working days", async () => {
  const night = await ok("saveShift", "hrm", { name: "Evening", start: "14:00", end: "22:00", breakMinutes: 30, graceMinutes: 0, workingDays: [1, 2, 3, 4, 5], isActive: true });
  assert.equal((await call("saveShift", "hrm", { name: "Bad", start: "09:00", end: "09:00", breakMinutes: 0, graceMinutes: 0, workingDays: [1], isActive: true })).status, 400);
  assert.equal((await call("saveShift", "hrm", { name: "Bad", start: "9am", end: "18:00", breakMinutes: 0, graceMinutes: 0, workingDays: [1], isActive: true })).status, 400);
  assert.equal((await call("saveShift", "reader", { name: "No", start: "09:00", end: "18:00", breakMinutes: 0, graceMinutes: 0, workingDays: [1], isActive: true })).status, 403);
  await ok("assignShift", "hrm", { employeeIds: [ids.temp], shiftId: night.id });
  assert.equal((await get(`employees/${ids.temp}`)).shiftId, night.id);
  const shifts = (await ok("listShifts", "reader", {})).shifts;
  assert.deepEqual(shifts.map((s) => [s.name, s.employees]).sort(), [["Day", 3], ["Evening", 1]]);
  const late = await ok("markAttendance", "hrm", { employeeId: ids.temp, date: at(0), status: "present", checkIn: "14:20", checkOut: "22:00", note: "" });
  assert.equal(late.lateMinutes, 20, "no grace period on this shift");
  await ok("assignShift", "hrm", { employeeIds: [ids.temp], shiftId: ids.shift });
});

test("payroll month 1: hand-checked formula — basic + allowances + overtime + bonuses + commissions − deductions; drafts are recalculated, adjustments kept, nothing the browser sends sets an amount", async () => {
  // Asad (Rs 30,000 basic + Rs 2,000 fuel, shift 480 working minutes) in the month before this one, relative to D (a Monday):
  //  D+0 present (bulk),  D+1 absent,  D+2 half-day,  D+3..D+5 late 09:30 (20 minutes after grace) x3 -> lateEvery 3 -> 0.5 day
  //  D+5 also has overtime? no: separate day D+4... see below.  D+7 unpaid leave (approved above, attendance 'leave' unpaid), D+8 casual leave (paid)
  const e1 = ids.e1;
  await ok("correctAttendance", "hrm", { employeeId: e1, date: at(0), status: "present", checkIn: "09:00", checkOut: "18:00", reason: "Tidy" });
  await ok("markAttendance", "hrm", { employeeId: e1, date: at(1), status: "absent", checkIn: "", checkOut: "", note: "" });
  await ok("markAttendance", "hrm", { employeeId: e1, date: at(2), status: "half_day", checkIn: "09:00", checkOut: "13:00", note: "" });
  for (const n of [3, 4, 5]) assert.equal((await ok("markAttendance", "hrm", { employeeId: e1, date: at(n), status: "present", checkIn: "09:30", checkOut: n === 5 ? "20:00" : "18:00", note: "" })).status, "late");
  // Overtime: D+5 left at 20:00 = 120 minutes overtime.  Bilal: present D+0 D+1 D+2 (45 minutes overtime on D+1).
  // dayRate Asad = 3,000,000 / 30 = 100,000; hourly = 100,000 / 8 = 12,500;  overtime = 2 h x 12,500 x 1.5 = 37,500.
  await ok("addPayrollAdjustment", "hrm", { month: PM, employeeId: e1, kind: "bonus", name: "Eid bonus", amount: 500000, reason: "Festival" });
  await ok("addPayrollAdjustment", "hrm", { month: PM, employeeId: e1, kind: "deduction", name: "Uniform fine", amount: 25000, reason: "Lost uniform" });
  assert.equal((await call("generatePayroll", "acct", { month: PM })).status, 403, "the accountant doesn't prepare payroll");
  assert.equal((await call("generatePayroll", "emp1", { month: PM })).status, 403);
  assert.equal((await call("generatePayroll", "hrm", { month: addDays(today, 40).slice(0, 7) })).status, 400, "a month that hasn't started");
  assert.equal((await call("addPayrollAdjustment", "hrm", { month: PM, employeeId: e1, kind: "commission", name: "Sneaky", amount: 999999, reason: "Try" })).status, 400, "commission can't be typed in");
  assert.equal((await call("addPayrollAdjustment", "hrm", { month: PM, employeeId: e1, kind: "bonus", name: "Zero", amount: 0, reason: "Zero" })).status, 400);
  const gen = await ok("generatePayroll", "hrm", { month: PM });
  const slip = await get(`payslips/${PM}__${e1}`);
  const c = slip.calc;
  // gross = 3,000,000 + 200,000 + 37,500 + 500,000 = 3,737,500 ; attendance = 100,000 (absent) + 50,000 (half) + 50,000 (3 lates) ; unpaid leave = 100,000 ; other = 25,000
  assert.deepEqual([c.basic, c.allowances, c.overtime, c.bonuses, c.commissions, c.gross], [3000000, 200000, 37500, 500000, 0, 3737500]);
  assert.deepEqual([c.absentDeduction, c.halfDeduction, c.lateDeduction, c.attendanceDeduction, c.leaveDeduction, c.otherDeductions, c.deductions], [100000, 50000, 50000, 200000, 100000, 25000, 325000]);
  assert.equal(c.net, 3737500 - 325000, "Net = basic + allowances + overtime + bonuses + commissions − deductions");
  assert.equal(slip.net, 3412500);
  const e2slip = await get(`payslips/${PM}__${ids.e2}`);
  assert.deepEqual([e2slip.calc.gross, e2slip.calc.deductions, e2slip.net], [1500000 + Math.round((45 / 60) * 6250 * 1.5), 0, 1500000 + 7031], "Bilal: 45 min overtime at (50,000 / 8 = 6,250 an hour) x 1.5");
  assert.equal(gen.employees, 4, "Maria, Asad, Bilal and Temp");
  assert.equal(gen.skipped.length, 0);
  assert.equal(gen.totals.net, 5000000 + 3412500 + e2slip.net + 900000);
  // Regenerating while it is a draft keeps the entered adjustments and gives the same numbers.
  const again = await ok("generatePayroll", "hrm", { month: PM });
  assert.equal(again.totals.net, gen.totals.net);
  assert.equal((await get(`payrollRuns/${PM}`)).gen, 2);
  assert.equal((await ok("listPayrollAdjustments", "salary", { month: PM })).adjustments.length, 2);
  const adj = (await ok("listPayrollAdjustments", "salary", { month: PM })).adjustments.find((a) => a.name === "Uniform fine");
  await ok("deletePayrollAdjustment", "hrm", { id: adj.id });
  assert.equal((await ok("generatePayroll", "hrm", { month: PM })).totals.net, gen.totals.net + 25000, "removing the fine gives the pay back");
  await ok("addPayrollAdjustment", "hrm", { month: PM, employeeId: e1, kind: "deduction", name: "Uniform fine", amount: 25000, reason: "Lost uniform" });
  ids.net1 = (await ok("generatePayroll", "hrm", { month: PM })).totals.net;
  assert.equal(ids.net1, gen.totals.net);
});

test("approving payroll posts ONE balanced journal (Dr Salaries, Cr Salaries payable / deductions), locks the month, and can't be repeated", async () => {
  assert.equal((await call("approvePayroll", "hrm", { month: PM })).status, 403, "the HR manager can't approve");
  const t = (await get(`payrollRuns/${PM}`)).totals;
  const a = await ok("approvePayroll", "acct", { month: PM });
  assert.equal(a.journal.number.startsWith("JE-"), true);
  const j = await get(`journalEntries/payroll__${PM}__v1`);
  assert.equal(j.status, "posted");
  assert.equal(j.totalDebit, j.totalCredit, "balanced");
  // Salaries expense = gross − attendance − unpaid-leave deductions;  Salaries payable = net;  deductions held = other.
  const earned = t.gross - t.attendanceDeduction - t.leaveDeduction;
  assert.equal(await net("6020"), earned);
  assert.equal(await net("2030"), -t.net);
  assert.equal(await net("2040"), -25000);
  assert.equal(t.net + 25000, earned, "credits equal the debit");
  assert.equal((await call("approvePayroll", "acct", { month: PM })).status, 400);
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "payroll").get()).size, 1, "approving twice didn't post twice");
  assert.equal((await get(`payslips/${PM}__${ids.e1}`)).status, "approved");
  // The month is locked: attendance, leave and recalculation are refused.
  assert.equal((await call("correctAttendance", "hrm", { employeeId: ids.e1, date: at(1), status: "present", checkIn: "09:00", checkOut: "18:00", reason: "Change" })).status, 400);
  assert.equal((await mark("hrm", ids.mgr, at(1), "present")).status, 400);
  assert.equal((await call("generatePayroll", "hrm", { month: PM })).status, 400);
  assert.equal((await call("addPayrollAdjustment", "hrm", { month: PM, employeeId: ids.e1, kind: "bonus", name: "Late", amount: 1000, reason: "Too late" })).status, 400);
  const day = await ok("attendanceDay", "hrm", { date: at(1) });
  assert.equal(day.locked, true);
});

test("paying salaries: journal per payslip (Dr Salaries payable, Cr bank / cash), repeat requests and double payment change nothing, void is a reversal", async () => {
  assert.equal((await call("paySalaries", "hrm", { idempotencyKey: key(), month: PM, employeeIds: [ids.e1], date: today })).status, 403, "paying needs hr.payroll.pay");
  assert.equal((await call("paySalaries", "acct", { idempotencyKey: key(), month: PM, employeeIds: [ids.e1], date: today })).status, 400, "a bank payment needs its reference");
  const k = key();
  const p = await ok("paySalaries", "acct", { idempotencyKey: k, month: PM, employeeIds: [ids.e1, ids.e2], date: today, reference: "TRX-77" });
  assert.equal(p.paid, 2);
  const e1net = (await get(`payslips/${PM}__${ids.e1}`)).net;
  const e2net = (await get(`payslips/${PM}__${ids.e2}`)).net;
  assert.equal(p.total, e1net + e2net);
  assert.equal(await net("1021"), -e1net, "Asad is paid by bank transfer (his own method)");
  assert.equal(await net("1010"), -e2net, "Bilal by cash");
  assert.equal(await net("2030"), -(await get(`payrollRuns/${PM}`)).totals.net + e1net + e2net);
  assert.deepEqual(await ok("paySalaries", "acct", { idempotencyKey: k, month: PM, employeeIds: [ids.e1, ids.e2], date: today, reference: "TRX-77" }), p, "the same request again returns the same answer");
  const dbl = await ok("paySalaries", "acct", { idempotencyKey: key(), month: PM, employeeIds: [ids.e1], date: today, reference: "TRX-78" });
  assert.deepEqual([dbl.paid, dbl.skipped], [0, [ids.e1]], "a salary already paid is skipped");
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "salarypay").get()).size, 2);
  assert.equal((await call("paySalaries", "acct", { idempotencyKey: key(), month: PM, employeeIds: [ids.e1], date: addDays(today, 2), reference: "X-1" })).status, 400, "not in the future");
  assert.equal((await call("voidSalaryPayment", "acct", { month: PM, employeeId: ids.e2, reason: "" })).status, 400);
  await ok("voidSalaryPayment", "acct", { month: PM, employeeId: ids.e2, reason: "Paid by mistake" });
  assert.equal(await net("1010"), 0, "the cash comes back through a reversal journal");
  assert.equal((await get(`payslips/${PM}__${ids.e2}`)).status, "approved");
  assert.equal((await get(`journalEntries/reversal__salarypay__${PM}__v1__${ids.e2}__n1`)).status, "posted");
  assert.equal((await get(`journalEntries/salarypay__${PM}__v1__${ids.e2}__n1`)).status, "posted", "the original journal is untouched");
  await ok("paySalaries", "acct", { idempotencyKey: key(), month: PM, employeeIds: [ids.e2], date: today });
  assert.equal((await get(`payslips/${PM}__${ids.e2}`)).status, "paid");
  // Pay the rest: the run becomes paid and Salaries payable returns to zero.
  const rest = (await get(`payrollRuns/${PM}`));
  const others = (await db.collection("payslips").where("month", "==", PM).get()).docs.filter((d) => d.data().status === "approved").map((d) => d.data().employeeId);
  await ok("paySalaries", "acct", { idempotencyKey: key(), month: PM, employeeIds: others, date: today, method: "cash" });
  assert.equal((await get(`payrollRuns/${PM}`)).status, "paid");
  assert.equal(await net("2030"), 0, "every net salary was paid");
  assert.ok(rest.totals.net > 0);
  assert.equal((await call("reversePayroll", "acct", { month: PM, reason: "Mistake" })).status, 400, "paid salaries must be undone first");
});

test("reversal: undo the payments, reverse the payroll (a reversal journal, instalments restored), the month reopens as version 2 and can be recalculated", async () => {
  const slips = (await db.collection("payslips").where("month", "==", PM).get()).docs.map((d) => d.data().employeeId);
  for (const id of slips) await ok("voidSalaryPayment", "acct", { month: PM, employeeId: id, reason: "Redo" });
  assert.equal(await net("2030"), -(await get(`payrollRuns/${PM}`)).totals.net, "all payments reversed");
  await ok("reversePayroll", "acct", { month: PM, reason: "Attendance error" });
  assert.equal((await get(`journalEntries/reversal__payroll__${PM}__v1`)).status, "posted");
  for (const code of ["6020", "2030", "2040", "1010", "1021"]) assert.equal(await net(code), 0, `account ${code} is back to zero`);
  const run = await get(`payrollRuns/${PM}`);
  assert.deepEqual([run.status, run.version], ["draft", 2]);
  await ok("correctAttendance", "hrm", { employeeId: ids.e1, date: at(1), status: "present", checkIn: "09:00", checkOut: "18:00", reason: "He was in after all" });
  const g = await ok("generatePayroll", "hrm", { month: PM });
  assert.equal(g.totals.attendanceDeduction, 100000, "the absence is gone: only the half-day and the late deduction remain");
  const a = await ok("approvePayroll", "acct", { month: PM });
  assert.ok(a.journal);
  assert.ok((await get(`journalEntries/payroll__${PM}__v2`)));
  const t = (await get(`payrollRuns/${PM}`)).totals;
  assert.equal(await net("6020"), t.gross - t.attendanceDeduction - t.leaveDeduction);
  ids.net2 = t.net;
  // Pay everyone for good.
  const everyone = (await db.collection("payslips").where("month", "==", PM).get()).docs.map((d) => d.data().employeeId);
  await ok("paySalaries", "acct", { idempotencyKey: key(), month: PM, employeeIds: everyone, date: today, method: "cash" });
  assert.equal(await net("2030"), 0);
});

test("advances and loans: request → approval → one pay-out → monthly instalments taken from pay; no duplicate disbursement; balances equal the books", async () => {
  assert.equal((await call("requestAdvance", "emp2", { idempotencyKey: key(), kind: "loan", amount: 600000, months: 3, startMonth: CM, reason: "Bike" })).status, 200, "an employee asks for their own loan");
  const mine = (await ok("myAdvances", "emp2", {})).advances;
  assert.equal(mine.length, 1);
  assert.equal((await call("requestAdvance", "emp2", { idempotencyKey: key(), kind: "advance", amount: 1000, months: 1, startMonth: CM, reason: "For someone else", employeeId: ids.e1 })).status, 403, "can't ask on someone else's behalf");
  assert.equal((await call("requestAdvance", "hrm", { idempotencyKey: key(), employeeId: ids.e1, kind: "advance", amount: 100000, months: 12, startMonth: CM, reason: "Too long" })).status, 400, "an advance is recovered within 6 months");
  assert.equal((await call("requestAdvance", "hrm", { idempotencyKey: key(), employeeId: ids.e1, kind: "advance", amount: 100000, months: 1, startMonth: PM, reason: "Past" })).status, 400, "the first deduction can't be in the past");
  const id = mine[0].id;
  assert.equal((await call("disburseAdvance", "acct", { idempotencyKey: key(), id, method: "cash", date: today })).status, 400, "must be approved first");
  assert.equal((await call("decideAdvance", "emp2", { id, decision: "approve" })).status, 403);
  await ok("decideAdvance", "acct", { id, decision: "approve" });
  const k = key();
  await ok("disburseAdvance", "acct", { idempotencyKey: k, id, method: "cash", date: today });
  const dup = await ok("disburseAdvance", "acct", { idempotencyKey: key(), id, method: "cash", date: today });
  assert.equal(dup.existing, true, "a second pay-out of the same advance is impossible");
  assert.equal((await db.collection("journalEntries").where("sourceType", "==", "advance").get()).size, 1);
  assert.equal(await net("1130"), 600000);
  const adv = await get(`employeeAdvances/${id}`);
  assert.deepEqual(adv.schedule.map((s) => [s.month, s.amount]).map((x) => x[1]), [200000, 200000, 200000]);
  assert.equal((await ok("listAdvances", "salary", {})).outstanding, 600000);
  ids.adv = id;
});

test("commission is worked out by the server from the POS sales rung up by the employee's sign-in; the client can't set it", async () => {
  assert.equal((await call("saveCommissionRule", "writer", { name: "x", type: "percent", rate: 2, amount: 0, target: 0, aboveRate: 0, scope: "all", designation: "", isActive: true })).status, 403);
  assert.equal((await call("saveCommissionRule", "hrm", { name: "Bad", type: "percent", rate: 0, scope: "all", isActive: true })).status, 400);
  await ok("saveCommissionRule", "hrm", { name: "Sales 2%", type: "percent", rate: 2, scope: "designation", designation: "Sales Associate", isActive: true });
  await ok("saveCommissionRule", "hrm", { name: "Target bonus", type: "target", amount: 30000, target: 1000000, aboveRate: 0, scope: "employee", employeeId: ids.e1, isActive: true });
  const reg = (await ok("openRegister", "emp1", { idempotencyKey: key(), warehouseId: ids.shop, openingFloat: 0 })).sessionId;
  await ok("posCheckout", "emp1", { idempotencyKey: key(), sessionId: reg, items: [{ ...ids.p1, qty: 1 }], tenders: [{ method: "cash", amount: 1000000 }] });
  assert.equal((await ok("listCommissionRules", "salary", {})).rules.length, 2);
  // Asad sold Rs 10,000 net: 2% = 20,000 and the target of Rs 10,000 is met: + 30,000.
  const g = await ok("generatePayroll", "hrm", { month: CM });
  const e1 = await get(`payslips/${CM}__${ids.e1}`);
  assert.equal(e1.salesNet, 1000000);
  assert.deepEqual(e1.commissionLines.map((l) => [l.name, l.amount]).sort(), [["Sales 2%", 20000], ["Target bonus", 30000]]);
  assert.equal(e1.calc.commissions, 50000);
  const e2 = await get(`payslips/${CM}__${ids.e2}`);
  assert.equal(e2.calc.commissions, 0, "Bilal sold nothing and isn't a Sales Associate target employee... the designation rule pays 2% of nothing");
  // Loan instalment of Rs 2,000 is taken from Bilal's pay (basic 15,000): gross 15,000, net 13,000.
  assert.deepEqual([e2.calc.advanceDeduction, e2.calc.net], [200000, 1300000]);
  assert.deepEqual([e1.calc.gross, e1.net], [3000000 + 200000 + 50000, 3250000]);
  assert.equal(g.totals.advanceDeduction, 200000);
});

test("current-month payroll with the loan: approval recovers the instalment (Cr Employee advances), reversal gives it back; outstanding loans equal the books", async () => {
  const unmarked = await ok("saveHrSettings", "hrm", setPayroll("block"));
  assert.equal(unmarked.payroll.unmarked, "block");
  await ok("generatePayroll", "hrm", { month: CM });
  let sofar = 0;
  for (let d = `${CM}-01`; d <= today; d = addDays(d, 1)) if (weekdayOf(d) !== 0) sofar += 1;
  if (sofar > 0) {
    const blocked = await call("approvePayroll", "acct", { month: CM });
    assert.equal(blocked.status, 400, "working days without attendance block approval when the rule says so");
    assert.match(blocked.body.error.message, /no attendance/);
  }
  await ok("saveHrSettings", "hrm", setPayroll("present"));
  await ok("generatePayroll", "hrm", { month: CM });
  const a = await ok("approvePayroll", "acct", { month: CM });
  const t = (await get(`payrollRuns/${CM}`)).totals;
  assert.equal(t.advanceDeduction, 200000);
  const j = await get(`journalEntries/payroll__${CM}__v1`);
  assert.equal(j.totalDebit, j.totalCredit);
  assert.equal(await net("1130"), 400000, "Rs 6,000 paid out less the Rs 2,000 recovered");
  const adv = await get(`employeeAdvances/${ids.adv}`);
  assert.deepEqual([adv.repaid, adv.schedule[0].status, adv.schedule[1].status], [200000, "deducted", "scheduled"]);
  const owed = (await ok("listAdvances", "salary", {})).outstanding;
  assert.equal(owed, await net("1130"), "outstanding employee loans equal the Employee advances account");
  assert.ok(a.journal);
  await ok("reversePayroll", "acct", { month: CM, reason: "Redo" });
  assert.equal(await net("1130"), 600000);
  assert.equal((await get(`employeeAdvances/${ids.adv}`)).repaid, 0);
  assert.equal((await get(`employeeAdvances/${ids.adv}`)).schedule[0].status, "scheduled");
  await ok("generatePayroll", "hrm", { month: CM });
  await ok("approvePayroll", "acct", { month: CM });
  assert.equal((await get(`employeeAdvances/${ids.adv}`)).repaid, 200000, "approved again: recovered exactly once");
  assert.equal(await net("1130"), 400000);
});

test("older charts of accounts: payroll refuses clearly when the salary accounts are missing, and one action adds them", async () => {
  const cfg = accounting.configRef();
  const before = (await cfg.get()).data();
  await ok("reversePayroll", "acct", { month: CM, reason: "Account test" });
  await cfg.update({ "roles.salary_payable": FieldValue.delete() });
  await ok("generatePayroll", "hrm", { month: CM });
  const r = await call("approvePayroll", "acct", { month: CM });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /Salaries payable/);
  assert.equal((await ok("hrAccountStatus", "salary", {})).missing.length, 1);
  assert.equal((await call("setupHrAccounts", "acct", {})).status, 403, "changing the chart of accounts needs accounting.manage");
  assert.deepEqual((await ok("setupHrAccounts", "owner", {})).added, ["salary_payable"]);
  assert.equal((await cfg.get()).data().roles.salary_payable, before.roles.salary_payable);
  await ok("approvePayroll", "acct", { month: CM });
  assert.equal((await db.collection("accountingExceptions").get()).size, 0, "a refused payroll leaves no half-booked exception");
});

test("employee self-service: own profile, attendance, leave and payslips only; payslips appear after approval; nobody else's records are reachable", async () => {
  const me = await ok("hrMyProfile", "emp1", {});
  assert.equal(me.employee.name, "Asad Ali");
  assert.equal(me.employee.cnic, undefined);
  assert.equal(me.employee.pay, undefined, "own profile has no CNIC; salary is on the payslip");
  assert.equal((await call("hrMyProfile", "cashier", {})).status, 403);
  assert.equal((await call("hrMyProfile", "emp3", {})).status, 404, "a sign-in that isn't linked to an employee");
  const mine = await ok("myAttendance", "emp1", { month: PM });
  assert.equal(mine.employee.id, ids.e1);
  assert.ok((await ok("myLeave", "emp1", {})).requests.every((r) => r.employeeId === ids.e1));
  const list = (await ok("myPayslips", "emp1", { limit: 12 })).payslips;
  assert.deepEqual(list.map((p) => p.month).sort(), [PM, CM].sort());
  const ps = await ok("getPayslip", "emp1", { month: PM });
  assert.equal(ps.payslip.employeeId, ids.e1);
  const other = await ok("getPayslip", "emp1", { month: PM, employeeId: ids.e2 });
  assert.equal(other.payslip.employeeId, ids.e1, "asking for someone else's payslip returns your own, never theirs");
  assert.equal((await call("getPayslip", "reader", { month: PM, employeeId: ids.e1 })).status, 403, "hr.read doesn't open salaries");
  const hrView = await ok("getPayslip", "salary", { month: PM, employeeId: ids.e2 });
  assert.equal(hrView.payslip.employeeId, ids.e2);
  assert.equal((await call("payrollRun", "emp1", { month: PM })).status, 403);
  assert.equal((await call("listAdvances", "emp1", {})).status, 403);
  // A draft payslip is not visible to the employee.
  await ok("reversePayroll", "acct", { month: CM, reason: "Hide" });
  assert.deepEqual((await ok("myPayslips", "emp1", { limit: 12 })).payslips.map((p) => p.month), [PM]);
  assert.equal((await call("getPayslip", "emp1", { month: CM })).status, 404);
  await ok("generatePayroll", "hrm", { month: CM });
  await ok("approvePayroll", "acct", { month: CM });
});

test("dashboard and reports come from the real records, and every sensitive report and export is audited", async () => {
  const d = await ok("hrDashboard", "owner", {});
  assert.deepEqual([d.totalEmployees, d.activeEmployees], [4, 4]);
  assert.equal(d.payrollStatus, "approved");
  assert.equal(d.pendingLeave, 1);
  assert.equal(typeof d.outstandingSalary, "number");
  assert.equal(d.outstandingSalary, (await net("2030")) * -1, "outstanding salaries equal Salaries payable in the books");
  const nosal = await ok("hrDashboard", "reader", {});
  assert.deepEqual([nosal.payrollNet, nosal.outstandingSalary, nosal.pendingPayrollApprovals], [null, null, null], "no money without salary permission");
  const rep = async (report, over = {}, token = "owner") => ok("hrReport", token, { report, from: at(0), to: at(13), ...over });
  const att = await rep("attendance_daily");
  assert.ok(att.tables[0].rows.length === 14);
  const mon = await rep("attendance_monthly", { from: at(0) });
  assert.equal(mon.tables[0].rows.find((r) => r.name === "Asad Ali").absent, 0, "the correction made him present");
  const late = await rep("late");
  assert.equal(late.tables[0].rows.find((r) => r.name === "Asad Ali").times, 3);
  const ot = await rep("overtime");
  assert.ok(ot.tables[0].rows.some((r) => r.name === "Asad Ali" && r.hours === 2));
  const lv = await rep("leave");
  assert.ok(lv.tables[0].rows.length >= 3);
  const ps = await rep("payroll_summary", { from: PM + "-01", to: CM + "-28" });
  assert.equal(ps.tables[0].rows.length, 2);
  const sh = await rep("salary_history", { employeeId: ids.e1, from: PM + "-01", to: CM + "-28" });
  assert.equal(sh.tables[0].rows.length, 2);
  assert.ok(sh.tables[1].rows.length >= 1, "the salary terms change history");
  assert.ok((await rep("advances")).tables[0].totals.outstanding >= 400000);
  const cm = await rep("commission", { from: CM + "-01", to: CM + "-28" });
  assert.equal(cm.tables[0].totals.comm, 50000);
  const pf = await rep("performance");
  assert.ok(pf.tables[0].rows.length >= 3);
  assert.equal((await call("hrReport", "reader", { report: "advances", from: at(0), to: at(1) })).status, 403);
  assert.equal((await call("hrReport", "reader", { report: "performance", from: at(0), to: at(1) })).status, 403, "performance also needs sales.read");
  assert.equal((await call("hrReport", "reader", { report: "directory", from: at(1), to: at(0) })).status, 400);
  await ok("hrExport", "owner", { report: "payroll_summary", format: "csv", from: at(0), to: at(1) });
  const audit = (await db.collection("auditLogs").get()).docs.map((x) => x.data());
  for (const action of ["hr.report_run", "hr.exported", "hr.payroll_approved", "hr.salaries_paid", "hr.payroll_reversed", "hr.advance_disbursed", "hr.leave_adjusted", "hr.attendance_corrected", "hr.employee_viewed", "hr.salary_payment_voided"]) assert.ok(audit.some((a) => a.action === action), action);
});

test("HR collections can't be read or written from any browser", async () => {
  const rules = (await import("node:fs")).readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
  for (const c of ["employees", "employeeSecure", "employeeDocs", "employeeHistory", "employeeLinks", "employeeKeys", "hrSettings", "shifts", "holidays", "attendance", "leaveRequests", "leaveBalances", "payrollRuns", "payslips", "payrollAdjustments", "employeeAdvances", "commissionRules"]) assert.match(rules, new RegExp(`match /${c}/\\{id\\} \\{\\s+allow read, write: if false;`), `${c} is server-only`);
});
