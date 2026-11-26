// Pure helpers for the services report, shared by the till code, the reports and the scheduled email.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Effect of one service on its float (positive = float grows). */
export const floatEffect = (type, transfer) => {
  const T = round2(transfer);
  return type === "cashout" ? T : type === "cashin" || type === "recharge" ? -T : 0;
};

/** One row per service type and provider from a list of sales. */
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
