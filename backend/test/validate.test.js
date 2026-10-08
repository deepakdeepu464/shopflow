const test = require("node:test");
const assert = require("node:assert");
const { validateOrder, clampInt } = require("../validate");

test("accepts a good order", () => {
  const r = validateOrder({ customer_id: 1, items: [{ product_id: 2, qty: 3 }] });
  assert.deepStrictEqual(r.value, { customer_id: 1, items: [{ product_id: 2, qty: 3 }] });
});
test("rejects empty items", () => assert.ok(validateOrder({ customer_id: 1, items: [] }).error));
test("rejects zero or negative qty", () => {
  assert.ok(validateOrder({ customer_id: 1, items: [{ product_id: 1, qty: 0 }] }).error);
  assert.ok(validateOrder({ customer_id: 1, items: [{ product_id: 1, qty: -2 }] }).error);
});
test("rejects duplicate products", () =>
  assert.ok(validateOrder({ customer_id: 1, items: [{ product_id: 1, qty: 1 }, { product_id: 1, qty: 2 }] }).error));
test("rejects bad customer", () => assert.ok(validateOrder({ customer_id: "x", items: [{ product_id: 1, qty: 1 }] }).error));
test("clampInt limits values", () => {
  assert.strictEqual(clampInt("500", 20, 1, 100), 100);
  assert.strictEqual(clampInt("abc", 20, 1, 100), 20);
  assert.strictEqual(clampInt("-5", 0, 0, 100), 0);
});
