/**
 * Online payment gateways the store could connect later. NONE is connected: each needs a merchant
 * account, credentials and server-side verification (signed webhooks) that haven't been set up, so
 * none can be switched on and the site never pretends to accept online payments.
 */
export const PAYMENT_GATEWAYS = [
  { key: "jazzcash", name: "JazzCash", note: "Needs a JazzCash merchant account and API credentials." },
  { key: "easypaisa", name: "Easypaisa", note: "Needs an Easypaisa merchant account and API credentials." },
  { key: "safepay", name: "Safepay (cards)", note: "Needs a Safepay merchant account and API credentials." },
];
