// Pure calculations for returns and voids: which stock comes back, how much money goes back, and the journal entry.
// No database access here, so every rule can be tested on its own. server/till.js does the reads and writes.
//
// A sale stores, for each product line: qty (units sold), pieces (base pieces), lineNet, lineVat, lineTotal, cogs
// and batches: [{ id, pieces, cost }] = the batches the stock was taken from, in order.
// The return ledger (saleReturns/{saleId}) stores what has already come back:
//   { items: { [index]: units }, pieces: { [index]: pieces }, money: { [index]: { net, vat, total, cogs } },
//     batches: { "index:batchId": pieces }, refunded }

export const ACCOUNTS = {
  CASH: "1000", BANK: "1010", AR: "1100", INVENTORY: "1200",
  VAT_PAYABLE: "2100", SALES: "4000", COGS: "5000",
};

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const MONEY = { net: "lineNet", vat: "lineVat", total: "lineTotal", cogs: "cogs" };

/**
 * Plans the stock and money for returning some units of product lines.
 * lines: [{ index, qty }] with whole units. Returns one plan entry per line.
 * A line that returns its last unit takes whatever is left of its money, so rounding never leaves a cent behind.
 */
export function planReturn(sale, agg, lines) {
  const items = sale.items || [];
  if (items.some((it) => it.kind === "service")) {
    throw new Error("This sale has mobile-money or service lines. Those are reversed in Accounting, so this sale cannot be returned here.");
  }
  if (!lines.length) throw new Error("Choose at least one item to return.");
  const plan = [];
  const seen = new Set();
  for (const line of lines) {
    const i = Number(line.index);
    const q = Number(line.qty);
    if (!Number.isInteger(i) || i < 0 || i >= items.length) throw new Error("A line in this return does not exist on the sale.");
    if (seen.has(i)) throw new Error("The same item is in this return twice.");
    seen.add(i);
    if (!Number.isInteger(q) || q <= 0) throw new Error("Return quantities must be whole numbers above zero.");
    const it = items[i];
    const left = it.qty - (agg.items?.[i] || 0);
    if (q > left) throw new Error(`Only ${left} ${it.name} can still be returned.`);
    if (it.pieces > 0 && !(it.batches?.length)) {
      throw new Error(`${it.name} was sold before returns were available, so its batch is not recorded. Correct its stock with Stock adjustment instead.`);
    }
    const last = q === left;
    const ratio = q / it.qty;
    const pieces = last ? it.pieces - (agg.pieces?.[i] || 0) : Math.round(it.pieces * ratio);
    const share = (field) => {
      const key = MONEY[field];
      const soldAmount = Number(it[key]) || 0;
      const done = Number(agg.money?.[i]?.[field]) || 0;
      return last ? round2(soldAmount - done) : round2(soldAmount * ratio);
    };
    const net = share("net");
    const vat = share("vat");
    // Total is always net + VAT, so the refund and the journal stay in balance.
    const total = round2(net + vat);
    const cogs = share("cogs");

    let toRestore = pieces;
    const restores = [];
    for (const b of it.batches || []) {
      const key = `${i}:${b.id}`;
      const avail = (Number(b.pieces) || 0) - (agg.batches?.[key] || 0);
      const take = Math.min(avail, toRestore);
      if (take > 0) {
        restores.push({ batchId: b.id, pieces: take, key });
        toRestore -= take;
      }
    }
    if (toRestore !== 0) throw new Error(`The returned ${it.name} does not match the batches it was sold from.`);

    plan.push({
      index: i, qty: q, name: it.name, productId: it.productId, pieces, restores,
      net, vat, total, cogs,
    });
  }
  return plan;
}

/** Totals of a plan. */
export function summarize(plan) {
  const t = { net: 0, vat: 0, total: 0, cogs: 0, pieces: {} };
  for (const p of plan) {
    t.net += p.net; t.vat += p.vat; t.total += p.total; t.cogs += p.cogs;
  }
  t.net = round2(t.net); t.vat = round2(t.vat); t.total = round2(t.total); t.cogs = round2(t.cogs);
  return t;
}

/** The return ledger after this plan has been applied. The input is not changed. */
export function applyAgg(agg, plan) {
  const next = {
    items: { ...(agg.items || {}) },
    pieces: { ...(agg.pieces || {}) },
    money: JSON.parse(JSON.stringify(agg.money || {})),
    batches: { ...(agg.batches || {}) },
    refunded: round2((Number(agg.refunded) || 0)),
  };
  for (const p of plan) {
    next.items[p.index] = (next.items[p.index] || 0) + p.qty;
    next.pieces[p.index] = (next.pieces[p.index] || 0) + p.pieces;
    const m = next.money[p.index] || { net: 0, vat: 0, total: 0, cogs: 0 };
    next.money[p.index] = {
      net: round2(m.net + p.net), vat: round2(m.vat + p.vat), total: round2(m.total + p.total), cogs: round2(m.cogs + p.cogs),
    };
    for (const r of p.restores) next.batches[r.key] = (next.batches[r.key] || 0) + r.pieces;
  }
  next.refunded = round2(next.refunded + plan.reduce((s, p) => s + p.total, 0));
  return next;
}

/** Whether every product unit on the sale has now come back. */
export function fullyReturned(sale, agg) {
  return (sale.items || []).every((it, i) => it.kind === "service" || (agg.items?.[i] || 0) >= it.qty);
}

/**
 * The journal entry that reverses the sale's revenue and cost for the returned units.
 * The sale posted: Dr payment account (total), Cr Sales (net), Cr VAT payable (VAT), Dr COGS, Cr Inventory.
 * This reverses those amounts. paymentAccount is the account the original sale was paid into.
 */
export function returnJournal({ net, vat, total, cogs, paymentAccount, memo, ref }) {
  const raw = [
    { account: ACCOUNTS.SALES, debit: net },
    { account: ACCOUNTS.VAT_PAYABLE, debit: vat },
    { account: paymentAccount, credit: total },
    { account: ACCOUNTS.INVENTORY, debit: cogs },
    { account: ACCOUNTS.COGS, credit: cogs },
  ];
  for (const l of raw) {
    const d = round2(l.debit || 0), c = round2(l.credit || 0);
    if (d < 0 || c < 0) throw new Error(`Return amounts cannot be negative (account ${l.account}).`);
    if (d > 0 && c > 0) throw new Error(`Account ${l.account} has a debit and a credit on one line.`);
  }
  const lines = raw.filter((l) => (l.debit || 0) > 0 || (l.credit || 0) > 0);
  if (!lines.length) throw new Error("Return has no amounts to post.");
  const debit = round2(lines.reduce((s, l) => s + (l.debit || 0), 0));
  const credit = round2(lines.reduce((s, l) => s + (l.credit || 0), 0));
  if (Math.abs(debit - credit) > 0.005) throw new Error(`Return entry does not balance (${debit} vs ${credit})`);
  return { date: null, memo, ref, lines, debit, credit };
}
