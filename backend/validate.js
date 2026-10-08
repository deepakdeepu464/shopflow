// Pure checks on incoming order data (no database needed, so easy to unit-test).
function validateOrder(body) {
  if (!body || typeof body !== "object") return { error: "body must be JSON" };
  const customer_id = Number(body.customer_id);
  if (!Number.isInteger(customer_id) || customer_id <= 0) return { error: "customer_id must be a positive integer" };
  if (!Array.isArray(body.items) || body.items.length === 0) return { error: "items must be a non-empty array" };
  if (body.items.length > 50) return { error: "too many items (max 50)" };
  const seen = new Set();
  const items = [];
  for (const it of body.items) {
    const product_id = Number(it && it.product_id);
    const qty = Number(it && it.qty);
    if (!Number.isInteger(product_id) || product_id <= 0) return { error: "each item needs a valid product_id" };
    if (!Number.isInteger(qty) || qty <= 0 || qty > 1000) return { error: "qty must be a whole number between 1 and 1000" };
    if (seen.has(product_id)) return { error: "same product listed twice; combine the quantities" };
    seen.add(product_id);
    items.push({ product_id, qty });
  }
  return { value: { customer_id, items } };
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

module.exports = { validateOrder, clampInt };
