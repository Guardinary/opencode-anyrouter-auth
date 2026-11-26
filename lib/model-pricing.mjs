import { isRecord } from "./safety.mjs";

const price = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
function multiply(a, b) {
  if (!price(a) || !price(b)) return undefined;
  const result = a * b;
  return price(result) && (result > 0 || a === 0 || b === 0) ? result : undefined;
}
function cleanCost(value) {
  if (!isRecord(value)) return undefined;
  const cost = {}, cache = {};
  for (const key of ["input", "output"]) if (price(value[key])) cost[key] = value[key];
  for (const key of ["read", "write"]) {
    const amount = Object.hasOwn(value, `cache_${key}`) ? value[`cache_${key}`] : value.cache?.[key];
    if (price(amount)) cache[key] = amount;
  }
  if (Object.keys(cache).length) cost.cache = cache;
  return Object.keys(cost).length ? cost : undefined;
}

// Public AnyRouter quotes are USD per million tokens for a selected group.
// They are not maker prices, a recharge exchange rate, or actual call charges.
// Never assume the signed-in account is in the public default group.
export function modelPricing(user, row, group, groupRatios) {
  if (Object.hasOwn(user, "cost")) return cleanCost(user.cost);
  if (!isRecord(row) || row.quota_type !== 0 || !price(row.model_ratio) ||
      typeof group !== "string" || !Array.isArray(row.enable_groups) || !row.enable_groups.includes(group) ||
      !isRecord(groupRatios) || !Object.hasOwn(groupRatios, group) || !price(groupRatios[group])) return undefined;
  const input = multiply(multiply(row.model_ratio, 2), groupRatios[group]);
  if (!price(input)) return undefined;
  return cleanCost({ input,
    output: multiply(input, row.completion_ratio),
    cache_read: multiply(input, row.cache_ratio),
    cache_write: multiply(input, row.create_cache_ratio),
  });
}
