// Services that are not stock: mobile recharge, and mobile wallet cash-in and cash-out (bKash, Nagad, Rocket…).
// Everything is calculated from the amount and the fee rules the admin sets:
//  • fee = rule (percent or flat) with optional min and max
//  • the transfer moves the wallet float (or operator float); the float can never go below zero
//  • only the fee is income; the transfer is not a sale
import { ACCOUNTS, round2, settings } from "./core.js";

export const SERVICE_TYPES = {
  recharge: { label: "Mobile recharge", providers: "rechargeOperators", providerLabel: "Operator", amountLabel: "Recharge amount", phoneRequired: true },
  cashin:   { label: "Wallet cash-in", providers: "walletProviders", providerLabel: "Wallet", amountLabel: "Amount sent to the customer's wallet", phoneRequired: false },
  cashout:  { label: "Wallet cash-out", providers: "walletProviders", providerLabel: "Wallet", amountLabel: "Amount given to the customer in cash", phoneRequired: false },
};

export const DEFAULT_SERVICE_FEES = {
  recharge: { mode: "percent", value: 0, min: 0, max: 0 },
  cashin: { mode: "flat", value: 0, min: 0, max: 0 },
  cashout: { mode: "percent", value: 0, min: 0, max: 0 },
};

export const serviceProviders = (type) => (settings[SERVICE_TYPES[type].providers] || []);

// Bangladesh mobile numbers: 01XXXXXXXXX, optionally with +88 or 88 in front.
export const cleanPhone = (v) => String(v || "").replace(/[\s-]/g, "");
export const validPhone = (digits) => /^(\+?88)?01\d{9}$/.test(digits);

/** Fee for a service, from the admin's rule. Pure: the same numbers come out in the till, the reports and the email. */
export function calcFee(type, amount, rules = settings.serviceFees || {}) {
  const rule = { ...DEFAULT_SERVICE_FEES[type], ...(rules[type] || {}) };
  const T = round2(Number(amount) || 0);
  const value = Number(rule.value) || 0;
  let fee = rule.mode === "percent" ? (T * value) / 100 : value;
  if (Number(rule.min) > 0) fee = Math.max(fee, Number(rule.min));
  if (Number(rule.max) > 0) fee = Math.min(fee, Number(rule.max));
  return round2(Math.max(0, fee));
}

/** What the customer hands over and receives, and what the shop's cash drawer does, for one service. */
export function serviceBreakdown(type, transfer, fee) {
  const T = round2(transfer), F = round2(fee);
  if (type === "cashout") {
    // Customer sends T to the shop's wallet and gets T in cash; pays the fee in cash.
    return { customerGives: F, customerGets: T, floatChange: T, floatDirection: "in", cashChange: round2(F - T) };
  }
  // cash-in and recharge: customer gives T + fee in cash; the shop sends T from its float.
  return { customerGives: round2(T + F), customerGets: 0, floatChange: T, floatDirection: "out", cashChange: round2(T + F) };
}

/** Key of the float document: one per wallet, and one per operator for recharge. */
export const floatKey = (type, provider) =>
  `${type === "recharge" ? "operator" : "wallet"}_${String(provider).trim().replace(/[^A-Za-z0-9]+/g, "_")}`;

/** Builds one cart line. The fee is calculated, not typed. */
export function serviceLine({ type, provider, amount, phone = "", balance = null, rules }) {
  const def = SERVICE_TYPES[type];
  if (!def) throw new Error("Unknown service");
  if (!provider) throw new Error(`Choose a ${def.providerLabel.toLowerCase()}`);
  const transfer = round2(Number(amount) || 0);
  if (!(transfer > 0)) throw new Error("Enter an amount above 0");
  const digits = cleanPhone(phone);
  if (def.phoneRequired && !digits) throw new Error("Enter the mobile number to recharge");
  if (digits && !validPhone(digits)) throw new Error("Enter a valid mobile number, for example 01712345678");
  const fee = calcFee(type, transfer, rules);
  // Cash-in and recharge send money out of the float, so the float must cover the transfer.
  if (balance !== null && serviceBreakdown(type, transfer, fee).floatDirection === "out" && balance < transfer) {
    throw new Error(`${provider} float is ${balance}. It cannot send ${transfer}. Top up the float first.`);
  }
  return {
    kind: "service",
    serviceType: type,
    provider,
    phone: digits,
    transfer,
    fee,
    name: `${def.label} · ${provider}`,
    qty: 1,
    price: fee,
    listPrice: fee,
    minPrice: fee,
    vatRate: 0,
  };
}

/**
 * Journal lines for one service. cashAccount is where the customer's cash goes.
 *  cashin:   customer pays T + F; the shop sends T from its wallet float.
 *  cashout:  customer sends T to the shop's wallet float and gets T cash; pays F cash.
 *  recharge: customer pays T + F; the shop tops up the operator from its float.
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

/** Float balance after one service. Returns the new balance; throws if a send would take it below zero. */
export function applyFloat(type, balance, transfer, provider) {
  const T = round2(transfer);
  const b = round2(Number(balance) || 0);
  if (type === "cashout") return round2(b + T);
  if (b < T) throw new Error(`${provider} float is ${b}. It cannot send ${T}. Top up the float first.`);
  return round2(b - T);
}

/** Effect of one service on its float (positive = float grows). */
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
