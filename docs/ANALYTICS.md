# Analytics, business intelligence & reporting (Phase 12)

A **reading layer** over the records the earlier phases keep. It never re-implements accounting, stock or CRM rules.

## Where each figure comes from
| Figure | Source | Status |
|---|---|---|
| Revenue, cost of goods sold, gross / net profit, operating expenses, cash, bank, receivables, payables, P&L, balance sheet, cash flow, trial balance, ledger | **Posted journals** through the accounting services (`profitAndLoss`, `balancesAsOf`, `cashFlow`, `trialBalance`, `generalLedger`, `financeReport`) | Verified |
| Sales, net sales, orders, average order, discounts, refunds, trends, product / category / size / colour / variant / payment / warehouse / salesperson | Saved `sales` (counted = not cancelled / returned / refunded) | Verified operational figures |
| Product and category gross profit, margin, discount impact | The cost saved WITH each sale (`saleCosts`), i.e. the weighted-average cost at the time of sale. Lines without a recorded cost are left out and counted | Verified; "what-if" margin is labelled an illustration |
| Stock quantity and valuation | The existing inventory scan (weighted average cost) beside the inventory account in the books; the difference is shown | Verified |
| Turnover | Cost of goods sold (books) ÷ average of opening and closing inventory (books) | Verified inputs |
| Fast / slow / dead stock, days of stock left, reorder quantities, overstock, ageing by last receipt | Sales history over the chosen window | **Estimate** (marked ESTIMATE on screen, CSV, Excel and print) |
| Customers, retention, lifetime value, segments, loyalty, discount usage | Sales + CRM (`crmDashboard`, `crmReport`) | Verified; needs `crm.read` |
| Purchases, supplier payments, returns, delivery performance, unit-cost spread | Goods receipts, supplier payments, returns, purchase orders (`purchaseReportTables` + own tables) | Verified |

**Reconciliation shown on the dashboard:** net sales per the sale records + delivery vs net revenue per the posted journals (difference line). Receivable / payable ageing shows the control-account balance beside the open items. Inventory valuation shows the inventory account beside the physical valuation.

## Permissions (checked on the server from the verified token)
`analytics.read` (sales, product, customer, inventory, purchase analytics), `analytics.financial` (profit, statements), `analytics.executive` (**Owner only** – cannot be granted to another role), `analytics.export`, `analytics.manage` (saved reports, schedules). Each report needs ALL of the permissions listed in `shared/analytics.js` (for example profit needs `analytics.financial` + `costs.read`; customer analytics needs `crm.read`). Financial, profit, customer and executive reports, and every export, are written to the audit log (`analytics.*`).

## Architecture
- `shared/analytics.js` – report catalogue and PURE rules (growth, margin, buckets, movement class, cover, turnover, reorder, ageing).
- `shared/reportFormat.js`, `shared/xlsx.js` – CSV, print / PDF HTML, and a dependency-free `.xlsx` writer (ZIP, stored). Used by the screens and the tests.
- `functions/services/analyticsData.js` – bounded reads, line-level "facts", cache. `analytics.js` – the report builders and the executive dashboard. `analyticsSchedules.js` – saved reports, schedules, inbox.
- `functions/callable/analytics.js` – endpoints. Screens: `src/admin/views/analytics*.js`; charts: `src/admin/ui/charts.js` (inline SVG, no library).

## Performance and consistency
- One bounded query per source (≤ 5,000 sales per range; a clear message beyond that); products and categories are read by id in chunks, never per sale; ledger figures use the accounting engine's day / month totals.
- Cache: `analyticsCache/{key}` stores a finished result with a **stamp** = the newest record (created or updated) in every source it depends on. It is reused only while the stamp is unchanged, it is under 10 minutes old and it is from the same day. A new sale, refund, journal, stock movement or edit changes the stamp, so money is never stale.

## Scheduled reports (what exists and what doesn't)
There is no background job in this project and no messaging service is used. Summaries (daily sales, weekly performance, monthly financial, low stock, outstanding payments) are generated when they are **due and a permitted person opens the Report inbox** (or presses "Run due reports now"); each period is generated once (`reportRuns/{schedule}__{period}`). Recipients read them in the admin, and only if their role may still see that report. A timed run would need a Vercel cron entry and a secret (not added; no deployment was made).

## Limits
See the completion report.
