/**
 * CRM customers: a searchable directory and one customer's profile (details, real purchase history, loyalty,
 * notes / complaints / follow-ups). Every figure is computed by the server from real records. A WhatsApp chat link
 * is offered only for customers who agreed to WhatsApp messages; nothing is ever sent automatically.
 */
import { esc } from "../../lib/format.js";
import { toE164, normalizePkMobile } from "../../../shared/phone.js";
import { NOTE_TYPES, COMPLAINT_STATUS, SEGMENT_LABEL } from "../../../shared/crm.js";
import { toast, confirmDialog, errorState, emptyState, formatWhen } from "../ui/kit.js";
import { money, formDialog, row, input, select, newKey } from "../ui/purchasing.js";
import { call } from "../purchData.js";
import { messageOf, labelTables } from "../financeUi.js";
import { saveCrmCustomerInput, crmNoteInput, fieldErrors } from "../../../shared/schemas/index.js";

const chips = (c) => [...(c.segments ?? []).map((s) => `<span class="tag">${esc(SEGMENT_LABEL[s] ?? s)}</span>`), c.tier ? `<span class="tag tag--low">${esc(c.tierName ?? c.tier)}</span>` : "", c.isActive === false ? `<span class="tag tag--out">Archived</span>` : ""].join(" ");
const table = (head, rows) => `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

/** wa.me chat link, only for customers who agreed to WhatsApp messages. @param {any} c */
function whatsappLink(c) {
  const number = normalizePkMobile(c.whatsapp || c.phone || "");
  if (!number) return `<span class="muted">No mobile number saved</span>`;
  if (!c.consent?.whatsapp) return `<span class="muted">Has not agreed to WhatsApp messages</span>`;
  return `<a class="btn btn--ghost" href="https://wa.me/${esc(toE164(number).slice(1))}" target="_blank" rel="noopener noreferrer">Open WhatsApp chat</a>`;
}

/** @param {{ types: string[], existing: any | null, onDone: (id: string) => void }} o */
function customerDialog({ types, existing, onDone }) {
  const v = existing ?? { name: "", phone: "", whatsapp: "", email: "", address: "", city: "", customerType: types[0] ?? "", tags: [], notes: "", dateOfBirth: "", consent: {} };
  const consent = v.consent ?? {};
  const box = (name, label) => `<label class="check"><input type="checkbox" name="c_${name}" ${consent[name] ? "checked" : ""} /> ${esc(label)}</label>`;
  formDialog({
    title: existing ? "Edit customer" : "Add a customer",
    submit: existing ? "Save changes" : "Add customer",
    body: `
      ${row("name", "Name", input("name", `maxlength="100" value="${esc(v.name)}"`))}
      ${row("phone", "Mobile (optional)", input("phone", `maxlength="30" inputmode="tel" value="${esc(v.phone ?? "")}" placeholder="0300 1234567"`))}
      ${row("whatsapp", "WhatsApp (optional)", input("whatsapp", `maxlength="30" inputmode="tel" value="${esc(v.whatsapp ?? "")}"`))}
      ${row("email", "Email (optional)", input("email", `type="email" maxlength="254" value="${esc(v.email ?? "")}"`))}
      ${row("address", "Address (optional)", input("address", `maxlength="300" value="${esc(v.address ?? "")}"`))}
      ${row("city", "City (optional)", input("city", `maxlength="60" value="${esc(v.city ?? "")}"`))}
      ${row("customerType", "Customer type", select("customerType", [["", "—"], ...types.map((t) => [t, t])], v.customerType ?? ""))}
      ${row("tags", "Tags (optional, separated by commas)", input("tags", `maxlength="200" value="${esc((v.tags ?? []).join(", "))}"`))}
      ${row("dateOfBirth", "Date of birth (optional — only if the customer chose to share it)", input("dateOfBirth", `type="date" value="${esc(v.dateOfBirth ?? "")}"`))}
      ${row("notes", "Notes (optional)", input("notes", `maxlength="1000" value="${esc(v.notes ?? "")}"`))}
      <fieldset class="field"><legend>What the customer agreed to receive</legend><p class="field-hint">Nothing is sent automatically. Leave unticked unless they said yes.</p>${box("marketing", "Offers and promotions")} ${box("whatsapp", "WhatsApp messages")} ${box("sms", "SMS")} ${box("email", "Email")}</fieldset>`,
    async onSubmit(form, { show, close }) {
      const f = /** @type {any} */ (form.elements);
      const parsed = saveCrmCustomerInput.safeParse({
        ...(existing ? { id: existing.id } : {}),
        name: f.name.value, phone: f.phone.value, whatsapp: f.whatsapp.value, email: f.email.value, address: f.address.value, city: f.city.value,
        customerType: f.customerType.value, tags: f.tags.value.split(",").map((t) => t.trim()).filter(Boolean), notes: f.notes.value, dateOfBirth: f.dateOfBirth.value,
        consent: { marketing: f.c_marketing.checked, whatsapp: f.c_whatsapp.checked, sms: f.c_sms.checked, email: f.c_email.checked },
      });
      if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
      const r = await call("saveCrmCustomer", parsed.data);
      close();
      toast(existing ? "Saved." : `Customer added (${r.reference ?? ""}).`);
      onDone(r.id);
    },
  });
}

export default async function crm({ main, user, params, navigate }) {
  const canWrite = user.perms.includes("crm.write");
  const canManage = user.perms.includes("crm.manage");
  const canLoyalty = user.perms.includes("crm.loyalty");
  /** @type {any} */
  let cfg = null;
  try {
    cfg = await call("getCrmSettings", {});
  } catch {
    cfg = null;
  }
  if (!cfg) {
    main.innerHTML = `<div class="adm-page">${errorState("Customer settings couldn't be loaded.")}</div>`;
    main.querySelector("[data-retry]")?.addEventListener("click", () => navigate("/admin/crm"));
    return;
  }
  const types = cfg.customerTypes ?? [];
  if (params[0]) return detail(params[0]);

  main.innerHTML = `
    <div class="adm-page">
      <header class="adm-page__head">
        <h1 class="adm-h1">Cus<em>tomers</em> (CRM)</h1>
        <p class="muted">Your customer directory with purchase history, loyalty and follow-ups.</p>
        ${canWrite ? `<p><button type="button" class="btn btn--primary" data-new><span>Add customer</span></button></p>` : ""}
      </header>
      <form class="adm-filters" data-filters novalidate>
        <div class="field"><label for="cu-q">Search</label><input id="cu-q" type="search" placeholder="Name, phone, email or CUST-…" /></div>
        <div class="field"><label for="cu-seg">Group</label><select id="cu-seg"><option value="">All</option>${Object.entries(SEGMENT_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select></div>
        <div class="field"><label for="cu-tier">Tier</label><select id="cu-tier"><option value="">All</option>${(cfg.tiers ?? []).map((t) => `<option value="${esc(t.key)}">${esc(t.name)}</option>`).join("")}</select></div>
        <div class="field"><label for="cu-status">Status</label><select id="cu-status"><option value="active">Active</option><option value="archived">Archived</option><option value="all">All</option></select></div>
        <div class="field"><label for="cu-sort">Sort by</label><select id="cu-sort"><option value="name">Name</option><option value="newest">Newest</option><option value="spent">Most spent</option><option value="orders">Most orders</option><option value="last">Latest purchase</option></select></div>
      </form>
      <div data-list><p class="muted">Loading…</p></div>
    </div>`;
  const listEl = /** @type {HTMLElement} */ (main.querySelector("[data-list]"));
  const val = (id) => /** @type {HTMLInputElement} */ (main.querySelector(id)).value;
  const alive = () => main.isConnected && main.querySelector("[data-list]") !== null;
  let ticket = 0;
  let offset = 0;
  /** @type {any[]} */
  let rows = [];

  async function load(reset = true) {
    const mine = ++ticket;
    if (reset) {
      offset = 0;
      rows = [];
    }
    try {
      const r = await call("crmListCustomers", { q: val("#cu-q").trim(), segment: val("#cu-seg"), tier: val("#cu-tier"), status: val("#cu-status"), sort: val("#cu-sort"), limit: 50, offset });
      if (mine !== ticket || !alive()) return;
      rows = rows.concat(r.customers);
      offset = rows.length;
      listEl.innerHTML = rows.length
        ? `<p class="muted">${r.total} customer${r.total === 1 ? "" : "s"}</p>${table(["Customer", "Phone", "Orders", "Spent", "Last purchase", "Groups"], rows.map((c) => [`<a class="text-link" href="/admin/crm/${esc(c.id)}" data-link><strong>${esc(c.name)}</strong></a><br /><span class="muted">${esc(c.reference ?? "")}${c.customerType ? ` · ${esc(c.customerType)}` : ""}</span>`, esc(c.phone || "—"), String(c.stats?.orders ?? 0), esc(money(c.stats?.spent ?? 0)), esc(c.stats?.lastAt ? formatWhen(c.stats.lastAt) : "—"), chips({ ...c, tierName: (cfg.tiers ?? []).find((t) => t.key === c.tier)?.name })]))}${rows.length < r.total ? `<p class="adm-table__more"><button type="button" class="btn btn--ghost" data-more>Load more</button></p>` : ""}`
        : emptyState({ title: "No customers found", text: canWrite ? "Add the first customer, or save a sale against a customer in the POS." : "" });
      labelTables(listEl);
      listEl.querySelector("[data-more]")?.addEventListener("click", () => load(false));
    } catch (err) {
      if (!alive()) return;
      listEl.innerHTML = errorState(messageOf(err));
      listEl.querySelector("[data-retry]")?.addEventListener("click", () => load(true));
    }
  }
  let timer;
  main.querySelector("[data-filters]").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => load(true), 350);
  });
  main.querySelector("[data-filters]").addEventListener("submit", (e) => e.preventDefault());
  main.querySelector("[data-new]")?.addEventListener("click", () => customerDialog({ types, existing: null, onDone: (id) => navigate(`/admin/crm/${id}`) }));
  await load(true);

  /* ───── One customer ───── */
  async function detail(id) {
    main.innerHTML = `<div class="adm-page" data-detail><p class="muted">Loading…</p></div>`;
    const page = /** @type {HTMLElement} */ (main.querySelector("[data-detail]"));
    let tab = 0;
    const draw = async () => {
      let d;
      try {
        d = await call("crmCustomerProfile", { id });
      } catch (err) {
        page.innerHTML = /not.?found|doesn't exist/i.test(err?.message ?? "") ? `<p>That customer doesn't exist. <a class="text-link" href="/admin/crm" data-link>Back to customers</a></p>` : errorState(messageOf(err));
        page.querySelector("[data-retry]")?.addEventListener("click", draw);
        return;
      }
      const p = d.profile;
      const st = d.stats;
      /** @type {any} */
      let loyalty = null;
      if (cfg.loyalty?.enabled || canLoyalty) {
        try {
          loyalty = await call("loyaltySummary", { customerId: id });
        } catch {
          loyalty = null;
        }
      }
      page.innerHTML = `
        <p><a class="text-link" href="/admin/crm" data-link>← Customers</a></p>
        <header class="adm-page__head">
          <h1 class="adm-h1">${esc(p.name)}</h1>
          <p>${esc(p.reference ?? "")} ${chips({ ...p, segments: st.segments, tier: st.tier, tierName: st.tierName })}</p>
          <p>${canWrite ? `<button type="button" class="btn btn--ghost" data-edit>Edit</button> ` : ""}${canManage ? `<button type="button" class="btn btn--ghost" data-toggle>${p.isActive === false ? "Restore" : "Archive"}</button> ` : ""}${whatsappLink(p)}</p>
        </header>
        <div class="adm-stats">
          <div class="adm-stat"><span class="adm-stat__label">Total spent</span><span class="adm-stat__value">${esc(money(st.spent))}</span></div>
          <div class="adm-stat"><span class="adm-stat__label">Orders</span><span class="adm-stat__value">${st.orders}</span></div>
          <div class="adm-stat"><span class="adm-stat__label">Average order</span><span class="adm-stat__value">${esc(money(st.orders ? Math.round(st.spent / st.orders) : 0))}</span></div>
          <div class="adm-stat"><span class="adm-stat__label">Last purchase</span><span class="adm-stat__value">${esc(st.lastAt ? formatWhen(st.lastAt) : "—")}</span></div>
          <div class="adm-stat"><span class="adm-stat__label">Owes us</span><span class="adm-stat__value">${esc(money(st.outstanding ?? 0))}</span></div>
          <div class="adm-stat"><span class="adm-stat__label">Refunded</span><span class="adm-stat__value">${esc(money(st.refunded ?? 0))}</span></div>
          ${loyalty && cfg.loyalty?.enabled ? `<div class="adm-stat"><span class="adm-stat__label">Loyalty points</span><span class="adm-stat__value">${loyalty.balance}</span></div>` : ""}
        </div>
        <div class="adm-tabs" role="tablist" aria-label="Customer">${["Details", "Purchases", "Loyalty", "Notes & complaints", "Returns & payments"].map((t, i) => `<button type="button" role="tab" aria-selected="${i === tab}" data-tab="${i}">${t}</button>`).join("")}</div>
        <div data-panel></div>`;
      const panel = /** @type {HTMLElement} */ (page.querySelector("[data-panel]"));
      const consentText = ["marketing", "whatsapp", "sms", "email"].filter((k) => p.consent?.[k]).join(", ") || "none";
      const tabs = [
        () => {
          panel.innerHTML = `<dl class="adm-card adm-details">
            <dt>Mobile</dt><dd>${esc(p.phone || "—")}</dd><dt>WhatsApp</dt><dd>${esc(p.whatsapp || "—")}</dd><dt>Email</dt><dd>${esc(p.email || "—")}</dd>
            <dt>Address</dt><dd>${esc([p.address, p.city].filter(Boolean).join(", ") || "—")}</dd><dt>Type</dt><dd>${esc(p.customerType || "—")}</dd>
            <dt>Tags</dt><dd>${esc((p.tags ?? []).join(", ") || "—")}</dd><dt>Date of birth</dt><dd>${esc(p.dateOfBirth || "—")}</dd>
            <dt>Agreed to receive</dt><dd>${esc(consentText)}</dd><dt>Registered</dt><dd>${esc(formatWhen(p.createdAt))}</dd><dt>Notes</dt><dd>${esc(p.notes || "—")}</dd>
            <dt>Account</dt><dd>${p.userId ? "Has an online account" : "Walk-in customer (no online account)"}</dd></dl>`;
        },
        () => {
          panel.innerHTML = `
            <h2 class="adm-h2">Recent purchases</h2>
            ${d.sales.length ? table(["Sale", "Date", "Total", "Paid", "Due", "Status", "Savings"], d.sales.map((s) => [esc(s.number), esc(formatWhen(s.at)), esc(money(s.total)), esc(money(s.paidTotal)), esc(money(s.amountDue)), esc(s.status), esc([s.crmDiscount ? `${s.crmDiscount.name} −${money(s.crmDiscount.amount)}` : "", s.loyalty?.redeemedPoints ? `${s.loyalty.redeemedPoints} pts used` : ""].filter(Boolean).join(" · ") || "—")])) : `<p class="muted">No purchases yet.</p>`}
            <h2 class="adm-h2">Most bought products</h2>
            ${d.topProducts.length ? table(["Product", "Pairs", "Spent"], d.topProducts.map((x) => [esc(x.name), String(x.qty), esc(money(x.amount))])) : `<p class="muted">—</p>`}
            <p><strong>Sizes bought:</strong> ${esc(Object.entries(d.sizes).map(([k, v]) => `${k} ×${v}`).join(", ") || "—")}</p>
            <p><strong>Colours bought:</strong> ${esc(Object.entries(d.colours).map(([k, v]) => `${k} ×${v}`).join(", ") || "—")}</p>`;
          labelTables(panel);
        },
        () => {
          if (!loyalty) return void (panel.innerHTML = emptyState({ title: "The loyalty programme is off", text: "Switch it on in Customer settings to start earning points." }));
          panel.innerHTML = `
            <p>Balance: <strong>${loyalty.balance} points</strong>${loyalty.nextExpiry ? ` <span class="muted">(${loyalty.nextExpiry.points} expire ${esc(formatWhen(loyalty.nextExpiry.at))})</span>` : ""}. Earned ${loyalty.earned}, redeemed ${loyalty.redeemed}, expired ${loyalty.expired}, reversed ${loyalty.reversed}, adjusted ${loyalty.adjusted}.</p>
            ${canLoyalty ? `<p><button type="button" class="btn btn--ghost" data-adjust>Adjust points</button></p>` : ""}
            ${loyalty.history.length ? table(["When", "Type", "Points", "Note"], loyalty.history.map((h) => [esc(formatWhen(h.at)), esc(h.type), `${h.points > 0 ? "+" : ""}${h.points}`, esc(h.note ?? "")])) : `<p class="muted">No loyalty activity yet.</p>`}`;
          labelTables(panel);
          panel.querySelector("[data-adjust]")?.addEventListener("click", () => adjustDialog());
        },
        () => {
          panel.innerHTML = `
            ${canWrite ? `<p><button type="button" class="btn btn--primary" data-note><span>Add note, feedback or complaint</span></button></p>` : ""}
            ${d.notes.length ? d.notes.map((n) => `<article class="adm-card"><p><strong>${esc(NOTE_TYPES[n.type] ?? n.type)}</strong> ${n.type === "complaint" || n.type === "followup" ? `<span class="tag ${n.status === "open" ? "tag--low" : ""}">${esc(COMPLAINT_STATUS[n.status] ?? n.status)}</span>` : ""} <span class="muted">${esc(formatWhen(n.createdAt))} · ${esc(n.createdByName ?? "")}</span></p><p>${esc(n.text)}</p>${n.rating ? `<p class="muted">Rating: ${n.rating}/5</p>` : ""}${n.warranty ? `<p class="muted">Warranty: ${esc(n.warranty)}</p>` : ""}${n.followUpDate ? `<p class="muted">Follow up on ${esc(n.followUpDate)}</p>` : ""}${n.resolution ? `<p class="muted">Resolution: ${esc(n.resolution)}</p>` : ""}${canWrite && ["open", "in_progress"].includes(n.status) ? `<p><button type="button" class="btn btn--ghost" data-resolve="${esc(n.id)}" data-kind="${esc(n.type)}">Update status</button></p>` : ""}</article>`).join("") : emptyState({ title: "No notes yet" })}`;
          panel.querySelector("[data-note]")?.addEventListener("click", () => noteDialog());
          panel.querySelectorAll("[data-resolve]").forEach((b) => b.addEventListener("click", () => statusDialog(/** @type {HTMLElement} */ (b).dataset.resolve, /** @type {HTMLElement} */ (b).dataset.kind === "complaint")));
        },
        () => {
          panel.innerHTML = `
            <h2 class="adm-h2">Returns and refunds</h2>
            ${d.returns.length ? table(["Sale", "Date", "Items", "Refunded"], d.returns.map((r) => [esc(r.number), esc(formatWhen(r.at)), esc(r.lines.join("; ")), esc(money(r.refundedTotal))])) : `<p class="muted">No returns or refunds.</p>`}
            <h2 class="adm-h2">Payment history</h2>
            ${d.payments.length ? table(["Sale", "Type", "Method", "Amount", "When"], d.payments.map((x) => [esc(x.saleNumber), esc(x.type), esc(x.method ?? "—"), esc(money(x.amount)), esc(formatWhen(x.at))])) : `<p class="muted">No payments recorded.</p>`}`;
          labelTables(panel);
        },
      ];
      tabs[tab]();
      page.querySelector(".adm-tabs").addEventListener("click", (e) => {
        const b = /** @type {HTMLElement} */ (e.target).closest("[data-tab]");
        if (!b) return;
        tab = Number(/** @type {HTMLElement} */ (b).dataset.tab);
        page.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
        tabs[tab]();
      });
      page.querySelector("[data-edit]")?.addEventListener("click", () => customerDialog({ types, existing: p, onDone: draw }));
      page.querySelector("[data-toggle]")?.addEventListener("click", async () => {
        const restore = p.isActive === false;
        if (!restore && !(await confirmDialog({ title: `Archive ${p.name}?`, body: "They no longer appear in searches. Their purchase history and loyalty points stay.", confirm: "Archive" }))) return;
        try {
          await call("setCrmCustomerActive", { id, isActive: restore });
          toast(restore ? "Customer restored." : "Customer archived.");
          draw();
        } catch (err) {
          toast(messageOf(err), "error");
        }
      });

      function noteDialog() {
        formDialog({
          title: "Add to this customer's record",
          body: `${row("type", "What is it?", select("type", Object.entries(NOTE_TYPES), "note"))}${row("text", "Details", input("text", 'maxlength="1000"'))}${row("followUpDate", "Follow up on (optional)", input("followUpDate", 'type="date"'))}${row("rating", "Rating 1–5 (feedback only, optional)", input("rating", 'type="number" min="1" max="5"'))}${row("warranty", "Warranty or repair details (optional)", input("warranty", 'maxlength="200"'))}`,
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            const parsed = crmNoteInput.safeParse({ customerId: id, type: f.type.value, text: f.text.value, followUpDate: f.followUpDate.value, rating: f.rating.value ? Number(f.rating.value) : null, warranty: f.warranty.value });
            if (!parsed.success) return show("Please check the highlighted fields.", fieldErrors(parsed.error));
            await call("crmAddNote", parsed.data);
            close();
            toast("Saved.");
            tab = 3;
            draw();
          },
        });
      }
      function statusDialog(noteId, isComplaint) {
        formDialog({
          title: "Update status",
          body: `${row("status", "New status", select("status", Object.entries(COMPLAINT_STATUS), "in_progress"))}${row("resolution", isComplaint ? "How was it resolved? (needed to resolve or close a complaint)" : "Outcome (optional)", input("resolution", 'maxlength="1000"'))}`,
          async onSubmit(form, { close }) {
            const f = /** @type {any} */ (form.elements);
            await call("crmUpdateNote", { id: noteId, status: f.status.value, resolution: f.resolution.value });
            close();
            toast("Updated.");
            tab = 3;
            draw();
          },
        });
      }
      function adjustDialog() {
        const key = newKey();
        formDialog({
          title: "Adjust loyalty points",
          intro: "Use a negative number to take points away. Every adjustment is recorded with your name and the reason.",
          body: `${row("points", "Points (+ or −)", input("points", 'type="number" step="1"'))}${row("reason", "Reason", input("reason", 'maxlength="200"'))}`,
          async onSubmit(form, { show, close }) {
            const f = /** @type {any} */ (form.elements);
            const points = Number(f.points.value);
            if (!Number.isInteger(points) || points === 0) return show("Enter a whole number other than zero.", { points: "Required" });
            if (f.reason.value.trim().length < 3) return show("Please give a reason.", { reason: "Required" });
            await call("loyaltyAdjust", { idempotencyKey: key, customerId: id, points, reason: f.reason.value.trim() });
            close();
            toast("Points adjusted.");
            tab = 2;
            draw();
          },
        });
      }
    };
    await draw();
  }
}
