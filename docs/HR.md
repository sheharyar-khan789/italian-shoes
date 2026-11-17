# HR, attendance, leave & payroll (Phase 13)

Built on the existing Firebase Auth staff sign-ins and roles, the Phase 5 double-entry accounting engine, the POS sales (`cashierUid`) and the Phase 12 report/export helpers. **No second user system and no second accounting engine**: an employee record is linked to the existing staff sign-in by uid, and every payroll posting goes through `postInTx` / `reverseInTx`.

## Data (all server-only: Firestore rules deny every browser read and write)
| Collection | Holds |
|---|---|
| `employees/{id}` | profile, contact, designation, department, manager, shift, joining / leaving date, status (hr.read) |
| `employeeSecure/{id}` | pay terms (basic, allowances, method) and CNIC: salary needs `hr.salary.read`, CNIC `hr.sensitive` |
| `employeeDocs`, `employeeHistory`, `employeeLinks/{uid}`, `employeeKeys/cnic_…` | documents (hr.sensitive), history (pay / CNIC entries restricted), sign-in ↔ employee link, unique CNIC |
| `hrSettings/main`, `shifts`, `holidays/{date}` | the owner's own departments, designations, employment types, leave types, rules, shifts, holidays |
| `attendance/{employeeId__date}` | ONE record per employee per day (the id makes a duplicate impossible), corrections kept on the record |
| `leaveRequests`, `leaveBalances/{employeeId__year}` | applications and decisions; adjustments and days used |
| `payrollRuns/{YYYY-MM}`, `payslips/{YYYY-MM__employeeId}`, `payrollAdjustments` | the run (draft → approved → paid, or reversed back to draft with `version + 1`), each payslip, one-off bonuses / deductions |
| `employeeAdvances`, `commissionRules` | advances and loans with their instalment schedule; commission / incentive rules |

Reads go through endpoints (`functions/callable/hr.js`) that filter by the caller's permissions.

## Permissions and roles
`hr.read`, `hr.write`, `hr.sensitive`, `hr.salary.read`, `hr.salary.write`, `hr.attendance`, `hr.leave.manage`, `hr.payroll.generate`, `hr.payroll.approve`, `hr.payroll.pay`, `hr.advances.manage`, `hr.manage`, `hr.export`, `hr.self`. The Owner (Admin) holds all. One action in HR settings creates **HR Manager** (people, attendance, leave, prepares payroll; can't approve or pay), **Payroll Accountant** (approves and pays; can't change employees) and **Employee** (`hr.self`: own profile, attendance, leave, advances, payslips). A POS cashier has none of these.

**Sign-in claim size.** Firebase limits custom claims to 1,000 characters and the full Owner permission list no longer fits (1,219). The Owner's claim is now the single wildcard `"*"` (`claimPerms` / `expandClaimPerms` in `shared/permissions.js`), expanded by the server, the security rules and the admin app; other roles keep a plain list and role changes that would still overflow are refused with a clear message.

## Attendance, shifts, leave
Times are `HH:MM`, dates Pakistan-time keys. Late = minutes after the shift start beyond its grace; early departure = minutes before the end; overtime = minutes after the end, counted from the configured minimum. A month whose payroll is approved or paid is locked. Corrections keep the old values, who and why. Leave counts working days only (weekly offs and holidays don't use it); approval re-checks balance and clashes, fills attendance as leave and uses the balance atomically; balances change only through approval / cancellation / an audited, repeatable adjustment.

## Payroll formula (server-calculated: `shared/hr.js payslipCalc`)
`Net = basic + allowances + overtime + bonuses + commissions − deductions`, deductions = attendance (absent days, half-days, late arrivals every N, days not employed) + unpaid leave + advance / loan instalments + other authorised deductions. A day's pay = salary ÷ 30 (or calendar / working days: configurable). Overtime = hours × hourly rate × multiplier. An instalment is limited to what the rest of the pay can cover; the remainder is **deferred**, never a negative net. Commission is worked out from the saved POS sales of the employee's linked sign-in (net of refunds) by the rules in settings; it cannot be typed into a payslip.

## Accounting
Approve → one journal `payroll__{month}__v{version}`: Dr Salaries (earned = gross − attendance − unpaid-leave deductions); Cr Salaries payable (net); Cr Employee advances & loans (instalments recovered); Cr Payroll deductions payable (other deductions). Pay → per payslip `salarypay__{month}__v{version}__{employee}__n{attempt}`: Dr Salaries payable, Cr cash / bank / wallet. Advance pay-out → `advance__{id}`: Dr Employee advances, Cr cash / bank. Journals are immutable: undoing a payment or reversing payroll posts a **reversal** journal and restores instalments; every id is derived from its source, so repeats cannot double-post, and an accounting problem rolls the whole HR change back. Older charts of accounts get the three new accounts with one action ("Set up payroll accounts").

## Reports and exports
Directory, daily and monthly attendance, late, overtime, leave, payroll summary, salary history, advances and loans, commission, performance — CSV, Excel (.xlsx) and print / PDF with business name, period and totals. Salary reports need `hr.salary.read`; every export needs `hr.export` and is audited.

## Limits
See the completion report.
