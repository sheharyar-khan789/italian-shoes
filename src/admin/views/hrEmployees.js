/**
 * Employees: the directory and one employee's profile (details, pay terms, documents, attendance calendar, leave, history).
 * Salary shows only to people with hr.salary.read, the CNIC and documents only to hr.sensitive; the server decides what it sends.
 */
import { esc } from "../../lib/format.js";
import { privateFileButton, privateImage, wirePrivateFiles } from "../privateFileUi.js";
import { ATTENDANCE_STATUS, weekdayOf } from "../../../shared/hr.js";
import { saveEmployeeInput, fieldErrors } from "../../../shared/schemas/index.js";
import { toast, confirmDialog, errorState, emptyState, formatWhen } from "../ui/kit.js";
import { money, formDialog, row, input, select } from "../ui/purchasing.js";
import { rupeesField, toPaisa } from "../ui/money.js";
import { labelTables } from "../financeUi.js";
import { call, messageOf, statusTag, uploadHrFile, thisMonth, methodOptions, METHOD_NAME } from "../hrUi.js";

const table = (head, rows) => `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

/** Allowances typed one per line as “Fuel: 2000”. @param {string} text @returns {{ name: string, amount: number }[] | null} */
function parseAllowances(text) {
  const out = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [name, amount] = line.split(":").map((x) => x.trim());
    const paisa = toPaisa(amount ?? "");
    if (!name || paisa === null || Number.isNaN(paisa)) return null;
    out.push({ name, amount: paisa });
  }
  return out;
}

/** @param {{ existing: any | null, view: any | null, settings: any, shifts: any[], employees: any[], perms: string[], onDone: (id: string) => void }} o */
function employeeDialog({ existing, view, settings, shifts, employees, perms, onDone }) {
  const e = existing ?? { name: "", phone: "", email: "", address: "", designation: "", department: "", managerId: "", joiningDate: "", employmentType: settings.employmentTypes[0] ?? "", photoUrl: "", emergencyContact: {}, notes: "", shiftId: "" };
  const pay = view?.pay ?? { basicSalary: 0, salaryMethod: "cash", payDetails: "", allowances: [] };
  const canPay = perms.includes("hr.salary.write");
  const canCnic = perms.includes("hr.sensitive");
  const list = (name, items, value, blank = "— none —") => select(name, [["", blank], ...items.map((x) => [x, x])], value ?? "");
  let photo = e.photoUrl ?? "";
  formDialog({
    title: existing ? "Edit employee" : "Add an employee",
    wide: true,
    body: `
      ${row("name", "Full name", input("name", `maxlength="100" value="${esc(e.name)}"`))}
      ${row("phone", "Phone", input("phone", `maxlength="30" inputmode="tel" value="${esc(e.phone)}" placeholder="0300 1234567"`))}
      ${row("email", "Email (optional)", input("email", `type="email" maxlength="254" value="${esc(e.email ?? "")}"`))}
      ${row("address", "Address (optional)", input("address", `maxlength="300" value="${esc(e.address ?? "")}"`))}
      ${row("department", "Department", list("department", settings.departments, e.department, settings.departments.length ? "— choose —" : "— add departments in HR settings —"))}
      ${row("designation", "Designation", list("designation", settings.designations, e.designation, settings.designations.length ? "— choose —" : "— add designations in HR settings —"))}
      ${row("employmentType", "Employment type", list("employmentType", settings.employmentTypes, e.employmentType))}
      ${row("joiningDate", "Joining date", input("joiningDate", `type="date" value="${esc(e.joiningDate)}"`))}
      ${row("managerId", "Reports to", select("managerId", [["", "— nobody —"], ...employees.filter((m) => m.id !== existing?.id && m.status === "active").map((m) => [m.id, m.name])], e.managerId ?? ""))}
      ${row("shiftId", "Shift", select("shiftId", [["", "— none —"], ...shifts.filter((s) => s.isActive !== false).map((s) => [s.id, `${s.name} (${s.start}–${s.end})`])], e.shiftId ?? ""))}
      ${row("staffEmail", "Sign-in email (so they can see their own records — optional)", input("staffEmail", `type="email" maxlength="254" value="" placeholder="${existing?.staffUid ? "already linked" : "their staff account email"}"`))}
      ${row("ecName", "Emergency contact name", input("ecName", `maxlength="80" value="${esc(e.emergencyContact?.name ?? "")}"`))}
      ${row("ecPhone", "Emergency contact phone", input("ecPhone", `maxlength="30" value="${esc(e.emergencyContact?.phone ?? "")}"`))}
      ${row("ecRelation", "Relation", input("ecRelation", `maxlength="40" value="${esc(e.emergencyContact?.relation ?? "")}"`))}
      <div class="field"><label for="pd-photo">Photo (optional)</label><input id="pd-photo" type="file" accept="image/jpeg,image/png,image/webp" /><p class="field-hint" data-photo>${photo ? "A photo is saved." : ""}</p></div>
      ${row("notes", "Notes (optional)", input("notes", `maxlength="1000" value="${esc(e.notes ?? "")}"`))}
      ${canCnic ? row("cnic", "CNIC (optional, restricted)", input("cnic", `maxlength="15" inputmode="numeric" value="${esc(view?.cnic ?? "")}" placeholder="35202-1234567-1"`)) : ""}
      ${canPay ? `<h3 class="adm-h2">Pay terms</h3>
        ${row("basic", "Basic salary per month (Rs)", input("basic", `inputmode="decimal" value="${esc(rupeesField(pay.basicSalary))}"`))}
        ${row("method", "Salary paid by", select("method", methodOptions, pay.salaryMethod))}
        ${row("payDetails", "Account / wallet details (optional)", input("payDetails", `maxlength="120" value="${esc(pay.payDetails ?? "")}"`))}
        <div class="field" data-field="allowances"><label for="pd-allow">Monthly allowances — one per line, like “Fuel: 2000”</label><textarea id="pd-allow" name="allow" rows="3">${esc((pay.allowances ?? []).map((a) => `${a.name}: ${a.amount / 100}`).join("\n"))}</textarea><p class="field-error" hidden></p></div>` : ""}`,
    onOpen(form) {
      form.querySelector("#pd-photo")?.addEventListener("change", async (ev) => {
        const f = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
        if (!f) return;
        const note = /** @type {HTMLElement} */ (form.querySelector("[data-photo]"));
        note.textContent = "Uploading…";
        try {
          photo = (await uploadHrFile(f, "hrphoto")).url;
          note.textContent = "Photo ready.";
        } catch (err) {
          note.textContent = /** @type {Error} */ (err).message || "Upload failed.";
        }
      });
    },
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      /** @type {Record<string, any>} */
      const input2 = {
        ...(existing ? { id: existing.id } : {}),
        profile: { name: f.name.value, phone: f.phone.value, email: f.email.value, address: f.address.value, designation: f.designation.value, department: f.department.value, employmentType: f.employmentType.value, joiningDate: f.joiningDate.value, managerId: f.managerId.value || null, shiftId: f.shiftId.value || null, staffEmail: f.staffEmail.value, photoUrl: photo, notes: f.notes.value, emergencyContact: { name: f.ecName.value, phone: f.ecPhone.value, relation: f.ecRelation.value } },
      };
      if (canCnic && (f.cnic.value.trim() || view?.cnic)) input2.sensitive = { cnic: f.cnic.value.trim() };
      if (canPay) {
        const basic = toPaisa(f.basic.value);
        const allowances = parseAllowances(f.allow.value);
        if (basic === null || Number.isNaN(basic)) return show("Enter the basic salary in rupees.", { basic: "Required" });
        if (allowances === null) return show("Write each allowance like “Fuel: 2000”.", { allowances: "Check the format" });
        input2.pay = { basicSalary: basic, salaryMethod: f.method.value, payDetails: f.payDetails.value, allowances };
      }
      const parsed = saveEmployeeInput.safeParse(input2);
      if (!parsed.success) return show("Please check the highlighted fields.", Object.fromEntries(Object.entries(fieldErrors(parsed.error)).map(([k, v]) => [k.replace(/^profile\./, "").replace(/^sensitive\./, "").replace(/^pay\./, ""), v])));
      const r = await call("saveEmployee", parsed.data);
      close();
      toast(existing ? "Saved." : `Employee added (${r.employeeNo}).`);
      onDone(r.id);
    },
  });
}

export default async function hrEmployees({ main, user, params, navigate }) {
  const perms = user.perms;
  const canWrite = perms.includes("hr.write");
  /** @type {any} */
  let settings = null;
  try {
    settings = await call("getHrSettings", {});
  } catch (err) {
    main.innerHTML = `<div class="adm-page">${errorState(messageOf(err))}</div>`;
    return;
  }
  const shifts = await call("listShifts", {}).then((r) => r.shifts).catch(() => []);
  /** @type {any[]} */
  let all = [];
  if (params[0]) return detail(params[0]);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head"><h1 class="adm-h1">Em<em>ployees</em></h1><p class="muted">Your people, their roles and their records. Salary and CNIC show only to those allowed to see them.</p>
        ${canWrite ? `<p><button type="button" class="btn btn--primary" data-new><span>Add employee</span></button></p>` : ""}</header>
      <form class="adm-filters" data-filters novalidate>
        <div class="field"><label for="em-q">Search</label><input id="em-q" type="search" placeholder="Name, ID, phone or email" /></div>
        <div class="field"><label for="em-status">Status</label><select id="em-status"><option value="active">Active</option><option value="inactive">Inactive</option><option value="terminated">Left</option><option value="all">All</option></select></div>
        <div class="field"><label for="em-dept">Department</label><select id="em-dept"><option value="">All</option>${settings.departments.map((d) => `<option>${esc(d)}</option>`).join("")}</select></div>
        <div class="field"><label for="em-desig">Designation</label><select id="em-desig"><option value="">All</option>${settings.designations.map((d) => `<option>${esc(d)}</option>`).join("")}</select></div>
      </form>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const listEl = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const val = (id) => /** @type {HTMLInputElement} */ (main.querySelector(id)).value;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  let ticket = 0;
  async function load() {
    const mine = ++ticket;
    try {
      const r = await call("listEmployees", { q: val("#em-q").trim(), status: val("#em-status"), department: val("#em-dept"), designation: val("#em-desig"), limit: 200 });
      if (mine !== ticket || !alive()) return;
      all = r.employees;
      listEl.innerHTML = all.length ? `<p class="muted">${r.total} employee${r.total === 1 ? "" : "s"}</p>${table(["Employee", "Department", "Phone", "Joined", "Status", ...(all[0]?.pay ? ["Basic salary"] : [])], all.map((e) => [`<a class="text-link" href="/admin/hr-employees/${esc(e.id)}" data-link><strong>${esc(e.name)}</strong></a><br /><span class="muted">${esc(e.employeeNo)}${e.designation ? ` · ${esc(e.designation)}` : ""}</span>`, esc(e.department || "—"), esc(e.phone), esc(e.joiningDate), statusTag(e.status), ...(e.pay ? [esc(money(e.pay.basicSalary))] : [])]))}` : emptyState({ title: "No employees found", text: canWrite ? "Add the first employee. Set up departments and designations in HR settings first." : "" });
      labelTables(listEl);
    } catch (err) {
      if (!alive()) return;
      listEl.innerHTML = errorState(messageOf(err));
      listEl.querySelector("[data-retry]")?.addEventListener("click", load);
    }
  }
  let timer;
  main.querySelector("[data-filters]").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  });
  main.querySelector("[data-filters]").addEventListener("submit", (ev) => ev.preventDefault());
  main.querySelector("[data-new]")?.addEventListener("click", () => employeeDialog({ existing: null, view: null, settings, shifts, employees: all, perms, onDone: (id) => navigate(`/admin/hr-employees/${id}`) }));
  await load();

  /* ───── One employee ───── */
  async function detail(id) {
    main.innerHTML = `<div class="adm-page" data-detail><p class="muted">Loading…</p></div>`;
    const page = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
    let tab = 0;
    let month = thisMonth();
    if (!all.length) all = await call("listEmployees", { status: "all", limit: 200 }).then((r) => r.employees).catch(() => []);
    const draw = async () => {
      let d;
      try {
        d = await call("getEmployee", { id });
      } catch (err) {
        page.innerHTML = /exist/i.test(err?.message ?? "") ? `<p>That employee doesn't exist. <a class="text-link" href="/admin/hr-employees" data-link>Back to employees</a></p>` : errorState(messageOf(err));
        return;
      }
      const e = d.employee;
      const canPay = perms.includes("hr.salary.read");
      const names = ["Details", ...(canPay ? ["Pay"] : []), ...(perms.includes("hr.sensitive") ? ["Documents"] : []), "Attendance", "Leave", "History"];
      page.innerHTML = `
        <p><a class="text-link" href="/admin/hr-employees" data-link>← Employees</a></p>
        <header class="adm-page__head"><h1 class="adm-h1">${e.photoUrl ? `${privateImage(e.photoUrl, "hr-photo")} ` : ""}${esc(e.name)}</h1>
          <p>${esc(e.employeeNo)} ${statusTag(e.status)} ${e.designation ? `· ${esc(e.designation)}` : ""} ${e.department ? `· ${esc(e.department)}` : ""}</p>
          <p>${canWrite ? `<button type="button" class="btn btn--ghost" data-edit>Edit</button> <button type="button" class="btn btn--ghost" data-status>${e.status === "active" ? "Deactivate / left the company" : "Make active again"}</button>` : ""}</p></header>
        <div class="adm-tabs" role="tablist" aria-label="Employee">${names.map((t, i) => `<button type="button" role="tab" aria-selected="${i === tab}" data-tab="${i}">${t}</button>`).join("")}</div>
        <div data-panel></div>`;
      const panel = /** @type {HTMLElement} */ (page.querySelector("[data-panel]"));
      const render = {
        Details: () => {
          panel.innerHTML = `<dl class="adm-card adm-details"><dt>Phone</dt><dd>${esc(e.phone)}</dd><dt>Email</dt><dd>${esc(e.email || "—")}</dd><dt>Address</dt><dd>${esc(e.address || "—")}</dd><dt>Employment type</dt><dd>${esc(e.employmentType || "—")}</dd><dt>Joined</dt><dd>${esc(e.joiningDate)}</dd>${e.leavingDate ? `<dt>Left on</dt><dd>${esc(e.leavingDate)}</dd>` : ""}<dt>Reports to</dt><dd>${esc(d.managerName || "—")}</dd><dt>Shift</dt><dd>${esc(d.shift?.name || "—")}</dd><dt>Sign-in linked</dt><dd>${e.staffUid ? "Yes" : "No"}</dd><dt>Emergency contact</dt><dd>${esc([e.emergencyContact?.name, e.emergencyContact?.phone, e.emergencyContact?.relation].filter(Boolean).join(" · ") || "—")}</dd>${perms.includes("hr.sensitive") ? `<dt>CNIC</dt><dd>${esc(e.cnic || "—")}</dd>` : ""}<dt>Notes</dt><dd>${esc(e.notes || "—")}</dd></dl>${d.reports.length ? `<h2 class="adm-h2">Team</h2>${table(["Name", "Designation"], d.reports.map((r) => [`<a class="text-link" href="/admin/hr-employees/${esc(r.id)}" data-link>${esc(r.name)}</a>`, esc(r.designation || "—")]))}` : ""}`;
        },
        Pay: () => {
          const p = e.pay;
          panel.innerHTML = p?.configured ? `<dl class="adm-card adm-details"><dt>Basic salary</dt><dd><strong>${esc(money(p.basicSalary))}</strong> a month</dd><dt>Paid by</dt><dd>${esc(METHOD_NAME[p.salaryMethod] ?? p.salaryMethod)}${p.payDetails ? ` · ${esc(p.payDetails)}` : ""}</dd><dt>Allowances</dt><dd>${p.allowances.length ? esc(p.allowances.map((a) => `${a.name} ${money(a.amount)}`).join(", ")) : "—"}</dd></dl><p><a class="text-link" href="/admin/hr-reports?report=salary_history&employee=${esc(id)}" data-link>Salary history report →</a></p>` : emptyState({ title: "No salary set yet", text: perms.includes("hr.salary.write") ? "Edit the employee to set the basic salary. They are left out of payroll until then." : "" });
        },
        Documents: () => {
          panel.innerHTML = `<p class="muted">Files are kept in private storage and open only for people allowed to see them (each opening is logged). Only people with permission to see documents can see this tab.</p>${canWrite ? `<p><button type="button" class="btn btn--primary" data-adddoc><span>Add a document</span></button></p>` : ""}${d.documents.length ? table(["Document", "Kind", "Added", ""], d.documents.map((x) => [privateFileButton(x.url, x.name), esc(x.kind), esc(formatWhen(x.at)), canWrite ? `<button type="button" class="text-btn" data-rmdoc="${esc(x.id)}">Remove</button>` : ""])) : emptyState({ title: "No documents" })}`;
          panel.querySelector("[data-adddoc]")?.addEventListener("click", () => docDialog());
          wirePrivateFiles(panel);
          panel.querySelectorAll("[data-rmdoc]").forEach((b) => b.addEventListener("click", async () => {
            if (!(await confirmDialog({ title: "Remove this document?", body: "The record is removed from the employee.", confirm: "Remove", danger: true }))) return;
            try {
              await call("removeEmployeeDocument", { employeeId: id, docId: /** @type {HTMLElement} */ (b).dataset.rmdoc });
              draw();
            } catch (err) {
              toast(messageOf(err), "error");
            }
          }));
        },
        Attendance: async () => {
          panel.innerHTML = `<div class="adm-filters"><div class="field"><label for="am">Month</label><input id="am" type="month" value="${month}" /></div></div><div data-cal><p class="muted">Loading…</p></div>`;
          const draw2 = async () => {
            const box = /** @type {HTMLElement} */ (panel.querySelector("[data-cal]"));
            try {
              const m = await call("employeeAttendanceMonth", { employeeId: id, month });
              const lead = (weekdayOf(`${month}-01`) + 6) % 7;
              const cells = [...Array(lead).fill(`<div class="hr-day hr-day--blank"></div>`), ...m.days.map((x) => `<div class="hr-day hr-day--${esc(x.record?.status ?? x.expected)}" title="${esc(x.record ? `${ATTENDANCE_STATUS[x.record.status]}${x.record.checkIn ? ` ${x.record.checkIn}–${x.record.checkOut || "?"}` : ""}` : x.expected === "working" ? "Not marked" : x.expected === "holiday" ? "Holiday" : "Weekly off")}"><strong>${Number(x.date.slice(8))}</strong><span>${esc(x.record ? ATTENDANCE_STATUS[x.record.status] : x.expected === "working" ? "—" : x.expected === "holiday" ? "Holiday" : "Off")}</span></div>`)];
              const s = m.summary;
              box.innerHTML = `${m.locked ? `<p class="muted">This month's payroll is approved: attendance is locked.</p>` : ""}<p class="muted">Present ${s.present} · Late ${s.late} · Half-day ${s.half_day} · Absent ${s.absent} · Leave ${s.leave} · Overtime ${s.overtimeMinutes} min</p><div class="hr-cal"><div class="hr-dow">Mon</div><div class="hr-dow">Tue</div><div class="hr-dow">Wed</div><div class="hr-dow">Thu</div><div class="hr-dow">Fri</div><div class="hr-dow">Sat</div><div class="hr-dow">Sun</div>${cells.join("")}</div>`;
            } catch (err) {
              box.innerHTML = errorState(messageOf(err));
            }
          };
          panel.querySelector("#am")?.addEventListener("change", (ev) => {
            month = /** @type {HTMLInputElement} */ (ev.target).value || thisMonth();
            draw2();
          });
          draw2();
        },
        Leave: async () => {
          panel.innerHTML = `<p class="muted">Loading…</p>`;
          try {
            const [b, l] = await Promise.all([call("leaveBalance", { employeeId: id, year: Number(thisMonth().slice(0, 4)) }), call("listLeave", { employeeId: id, limit: 50 })]);
            panel.innerHTML = `<h2 class="adm-h2">Balances this year</h2>${table(["Leave type", "Allowance", "Adjusted", "Used", "Pending", "Left"], b.balances.map((x) => [esc(x.name + (x.paid ? "" : " (unpaid)")), x.unlimited ? "—" : String(x.allowance), String(x.adjustments), String(x.used), String(x.pending), x.unlimited ? "No limit" : `<strong>${x.remaining}</strong>`]))}<h2 class="adm-h2">Requests</h2>${l.requests.length ? table(["Type", "From", "To", "Days", "Status", "Reason"], l.requests.map((x) => [esc(x.typeName), esc(x.from), esc(x.to), String(x.days), statusTag(x.status), esc(x.reason)])) : `<p class="muted">No leave requests.</p>`}`;
          } catch (err) {
            panel.innerHTML = errorState(messageOf(err));
          }
        },
        History: () => {
          panel.innerHTML = d.history.length ? table(["When", "What", "By"], d.history.map((h) => [esc(formatWhen(h.at)), esc(h.summary), esc(h.byName ?? "")])) : emptyState({ title: "No history yet" });
        },
      };
      const run = () => render[names[tab]]();
      run();
      wirePrivateFiles(page);
      page.querySelector(".adm-tabs").addEventListener("click", (ev) => {
        const b = /** @type {HTMLElement} */ (ev.target).closest("[data-tab]");
        if (!b) return;
        tab = Number(/** @type {HTMLElement} */ (b).dataset.tab);
        page.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        run();
      });
      page.querySelector("[data-edit]")?.addEventListener("click", () => employeeDialog({ existing: e, view: e, settings, shifts, employees: all, perms, onDone: draw }));
      page.querySelector("[data-status]")?.addEventListener("click", () => statusDialog(e));
      function docDialog() {
        let file = null;
        formDialog({
          title: "Add a document",
          body: `${row("name", "Name (e.g. CNIC front)", input("name", 'maxlength="120"'))}${row("kind", "Kind", select("kind", [["cnic", "CNIC"], ["contract", "Contract"], ["certificate", "Certificate"], ["medical", "Medical"], ["other", "Other"]], "other"))}<div class="field"><label for="pd-file">File (PDF or image, up to 5 MB)</label><input id="pd-file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" /><p class="field-hint" data-fnote></p></div>`,
          onOpen(form) {
            form.querySelector("#pd-file")?.addEventListener("change", async (ev) => {
              const f = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
              const note = /** @type {HTMLElement} */ (form.querySelector("[data-fnote]"));
              if (!f) return;
              note.textContent = "Uploading…";
              try {
                file = await uploadHrFile(f);
                note.textContent = "Ready.";
              } catch (err) {
                note.textContent = /** @type {Error} */ (err).message || "Upload failed.";
              }
            });
          },
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            if (!file) return show("Choose a file first.");
            await call("addEmployeeDocument", { employeeId: id, kind: f.kind.value, name: f.name.value.trim() || file.name, url: file.url, type: file.type, size: file.size });
            close();
            toast("Document added.");
            tab = names.indexOf("Documents");
            draw();
          },
        });
      }
      function statusDialog(emp) {
        const leaving = emp.status === "active";
        formDialog({
          title: leaving ? "Deactivate or record leaving" : "Make active again",
          body: `${leaving ? row("status", "What happened", select("status", [["inactive", "Inactive for now"], ["terminated", "Left the company"]], "terminated")) : ""}${leaving ? row("leavingDate", "Last working day", input("leavingDate", 'type="date"')) : ""}${row("reason", "Reason", input("reason", 'maxlength="200"'))}`,
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            if (f.reason.value.trim().length < 3) return show("Give a reason.", { reason: "Required" });
            await call("setEmployeeStatus", { id, status: leaving ? f.status.value : "active", leavingDate: leaving ? f.leavingDate.value : "", reason: f.reason.value.trim() });
            close();
            toast("Updated.");
            draw();
          },
        });
      }
    };
    await draw();
  }
}
