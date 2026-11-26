// Services that are not stock: mobile recharge, and mobile wallet cash-in and cash-out (bKash, Nagad, Rocket…).
// Only the fee is revenue. The amount that moves through the shop is money in or out of the wallet float,
// so it never counts as sales. Operators and wallets are lists the admin edits in settings.
import { ACCOUNTS, round2, settings } from "./core.js";

export const SERVICE_TYPES = {
  recharge: { label: "Mobile recharge", providers: "rechargeOperators", providerLabel: "Operator", amountLabel: "Recharge amount" },
  cashin:   { label: "Wallet cash-in", providers: "walletProviders", providerLabel: "Wallet", amountLabel: "Amount to send to the customer's wallet" },
  cashout:  { label: "Wallet cash-out", providers: "walletProviders", providerLabel: "Wallet", amountLabel: "Amount to give the customer in cash" },
};

export const serviceProviders = (type) => (settings[SERVICE_TYPES[type].providers] || []);

/** Builds one cart line for a service. amount is the transfer; fee is what the customer pays for the service. */
export function serviceLine({ type, provider, amount, fee = 0, phone = "" }) {
  const def = SERVICE_TYPES[type];
  if (!def) throw new Error("Unknown service");
  if (!provider) throw new Error(`Choose a ${def.providerLabel.toLowerCase()}`);
  const transfer = round2(Number(amount) || 0);
  const charge = round2(Number(fee) || 0);
  if (!(transfer > 0)) throw new Error("Enter an amount above 0");
  if (charge < 0) throw new Error("The fee cannot be negative");
  const digits = String(phone || "").replace(/[\s-]/g, "");
  if (type === "recharge" && digits && !/^(\+?88)?01\d{9}$/.test(digits)) {
    throw new Error("Enter a valid mobile number");
  }
  return {
    kind: "service",
    serviceType: type,
    provider,
    phone: digits,
    transfer,
    name: `${def.label} · ${provider}`,
    qty: 1,
    price: charge,
    listPrice: charge,
    minPrice: charge,
    vatRate: 0,
  };
}

/**
 * Journal lines for a service sale. cashAccount is the account the customer pays into (cash or bank).
 *  cashin:   customer pays transfer + fee in cash; the shop sends the transfer from its wallet float.
 *  cashout:  customer sends the transfer to the shop's wallet float and receives cash; pays the fee in cash.
 *  recharge: customer pays transfer + fee in cash; the shop tops up the operator from its float.
 */
export function serviceJournalLines(type, transfer, fee, cashAccount) {
  const T = round2(transfer);
  const F = round2(fee);
  const FLOAT = ACCOUNTS.WALLET_FLOAT;
  const COMM = ACCOUNTS.SERVICE_COMMISSION;
  if (type === "cashin" || type === "recharge") {
    return [
      { account: cashAccount, debit: round2(T + F) },
      { account: FLOAT, credit: T },
      { account: COMM, credit: F },
    ];
  }
  if (type === "cashout") {
    return [
      { account: FLOAT, debit: T },
      { account: cashAccount, credit: T },
      { account: cashAccount, debit: F },
      { account: COMM, credit: F },
    ];
  }
  throw new Error("Unknown service");
}

/** Cash the shop must collect on top of the fees for a set of cart lines (cash-in and recharge only). */
export function cashForServices(lines) {
  return round2(lines.reduce((s, l) => {
    if (l.kind !== "service") return s;
    return l.serviceType === "cashin" || l.serviceType === "recharge" ? s + l.transfer : s;
  }, 0));
}
