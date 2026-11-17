import { partiesView } from "./accountingParties.js";

/** Accounts receivable: customers and cash-on-delivery balances. */
export default (ctx) => partiesView(ctx, "customer");
