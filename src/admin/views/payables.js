import { partiesView } from "./accountingParties.js";

/** Accounts payable: suppliers. */
export default (ctx) => partiesView(ctx, "supplier");
