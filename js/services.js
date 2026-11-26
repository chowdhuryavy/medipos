// Services that are not stock: mobile recharge, and mobile wallet cash-in and cash-out (bKash, Nagad, Rocket…).
// Only the fee is revenue. The transfer amount moves through the shop's wallet float (or cash), so it never counts as sales.
// Operators and wallets are lists the admin edits under Administration → Lists & payments.
import { ACCOUNTS, round2, settings } from "./core.js";

export const SERVICE_TYPES = {
  recharge: { label: "Mobile recharge", providers: "rechargeOperators", providerLabel: "Operator", amountLabel: "Recharge amount", phoneRequired: true },
  cashin:   { label: "Wallet cash-in", providers: "walletProviders", providerLabel: "Wallet", amountLabel: "Amount sent to the customer's wallet", phoneRequired: false },
  cashout:  { label: "Wallet cash-out", providers: "walletProviders", providerLabel: "Wallet", amountLabel: "Amount given to the customer in cash", phoneRequired: false },
};

export const serviceProviders = (type) => (settings[SERVICE_TYPES[type].providers] || []);

// Bangladesh mobile numbers: 01XXXXXXXXX, optionally with +88 or 88 in front.
export const cleanPhone = (v) => String(v || "").replace(/[\s-]/g, "");
export const validPhone = (digits) => /^(\+?88)?01\d{9}$/.test(digits);

/** Builds one cart line for a service. amount is the transfer; fee is what the customer pays for the service. */
export function serviceLine({ type, provider, amount, fee = 0, phone = "" }) {
  const def = SERVICE_TYPES[type];
  if (!def) throw new Error("Unknown service");
  if (!provider) throw new Error(`Choose a ${def.providerLabel.toLowerCase()}`);
  const transfer = round2(Number(amount) || 0);
  const charge = round2(Number(fee) || 0);
  if (!(transfer > 0)) throw new Error("Enter an amount above 0");
  if (charge < 0) throw new Error("The fee cannot be negative");
  const digits = cleanPhone(phone);
  if (def.phoneRequired && !digits) throw new Error("Enter the mobile number to recharge");
  if (digits && !validPhone(digits)) throw new Error("Enter a valid mobile number, for example 01712345678");
  return {
    kind: "service",
    serviceType: type,
    provider,
    phone: digits,
    transfer,
    name: `${def.label} · ${provider}`,
    qty: 1,
    price: charge,        // what the customer pays for the service (revenue); editable at the till
    listPrice: charge,
    minPrice: 0,
    vatRate: 0,
  };
}

/**
 * Journal lines for one service. cashAccount is where the customer's money goes (cash or bank).
 *  cashin:   customer pays transfer + fee; the shop sends the transfer from its wallet float.
 *  cashout:  customer sends the transfer to the shop's wallet float and receives cash; pays the fee.
 *  recharge: customer pays transfer + fee; the shop tops up the operator from its float.
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

/** Effect of one service on the wallet float (positive = float grows). */
export const floatEffect = (type, transfer) => {
  const T = round2(transfer);
  return type === "cashout" ? T : type === "cashin" || type === "recharge" ? -T : 0;
};

/** Report rows for services in a list of sales: one row per service type and provider. */
export function serviceReportRows(sales) {
  const map = new Map();
  for (const s of sales) {
    for (const it of s.items || []) {
      if (it.kind !== "service") continue;
      const key = `${it.serviceType}|${it.provider}`;
      const a = map.get(key) || { type: it.serviceType, provider: it.provider, count: 0, transfer: 0, fees: 0 };
      a.count += 1;
      a.transfer += Number(it.transfer) || 0;
      a.fees += Number(it.lineNet) || 0;
      map.set(key, a);
    }
  }
  return [...map.values()].sort((a, b) => a.type.localeCompare(b.type) || a.provider.localeCompare(b.provider));
}
