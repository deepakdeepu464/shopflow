const express = require("express");
const { Pool, types } = require("pg");
const fs = require("fs");
const path = require("path");
const { validateOrder, clampInt } = require("./validate");

types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT -> JS number

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_MAX || "10", 10),   // at most 10 open DB connections per pod
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10000,                              // no query may run longer than 10s
});
pool.on("error", (e) => console.error("idle db client error", e.message));

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

const httpError = (status, message) => Object.assign(new Error(message), { status });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- health ----------
app.get("/live", (_req, res) => res.json({ status: "alive" }));                 // is the process running?
app.get("/ready", wrap(async (_req, res) => { await pool.query("SELECT 1"); res.json({ status: "ready" }); })); // can it reach the DB?

// ---------- customers ----------
app.get("/api/customers", wrap(async (_req, res) => {
  const { rows } = await pool.query("SELECT id, name, email FROM customers ORDER BY name");
  res.json(rows);
}));
app.post("/api/customers", wrap(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!name || !/^\S+@\S+\.\S+$/.test(email)) throw httpError(400, "valid name and email required");
  const { rows } = await pool.query("INSERT INTO customers (name, email) VALUES ($1,$2) RETURNING id, name, email", [name, email]);
  res.status(201).json(rows[0]);
}));

// ---------- products (paged + searchable) ----------
app.get("/api/products", wrap(async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const offset = clampInt(req.query.offset, 0, 0, 1000000);
  const q = String(req.query.q || "").trim();
  const { rows } = await pool.query(
    `SELECT id, sku, name, price_cents, stock FROM products
     WHERE ($1 = '' OR name ILIKE '%' || $1 || '%' OR sku ILIKE '%' || $1 || '%')
     ORDER BY id LIMIT $2 OFFSET $3`, [q, limit, offset]);
  res.json(rows);
}));
app.post("/api/products", wrap(async (req, res) => {
  const { sku, name } = req.body;
  const price = Number(req.body.price_cents), stock = Number(req.body.stock ?? 0);
  if (!sku || !name || !Number.isInteger(price) || price < 0 || !Number.isInteger(stock) || stock < 0)
    throw httpError(400, "sku, name, price_cents (>=0) and stock (>=0) required");
  const { rows } = await pool.query(
    "INSERT INTO products (sku, name, price_cents, stock) VALUES ($1,$2,$3,$4) RETURNING *", [sku, name, price, stock]);
  res.status(201).json(rows[0]);
}));

// ---------- orders ----------
// Placing an order is ONE all-or-nothing transaction:
// lock the products -> check stock -> create order + items -> reduce stock -> write audit rows.
app.post("/api/orders", wrap(async (req, res) => {
  const v = validateOrder(req.body);
  if (v.error) throw httpError(400, v.error);
  const { customer_id, items } = v.value;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ids = items.map((i) => i.product_id).sort((a, b) => a - b);
    // ORDER BY id + FOR UPDATE: everyone locks rows in the same order, so two orders can't deadlock,
    // and two buyers can't both grab the last item.
    const { rows: products } = await client.query(
      "SELECT id, price_cents, stock FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
    const byId = new Map(products.map((p) => [p.id, p]));

    let total = 0;
    for (const it of items) {
      const p = byId.get(it.product_id);
      if (!p) throw httpError(404, `product ${it.product_id} not found`);
      if (p.stock < it.qty) throw httpError(409, `not enough stock for product ${p.id} (have ${p.stock}, want ${it.qty})`);
      total += p.price_cents * it.qty;
    }
    const { rows: [order] } = await client.query(
      "INSERT INTO orders (customer_id, total_cents) VALUES ($1,$2) RETURNING *", [customer_id, total]);
    for (const it of items) {
      const p = byId.get(it.product_id);
      await client.query("INSERT INTO order_items (order_id, product_id, qty, unit_price_cents) VALUES ($1,$2,$3,$4)",
        [order.id, p.id, it.qty, p.price_cents]);
      await client.query("UPDATE products SET stock = stock - $1 WHERE id = $2", [it.qty, p.id]);
      await client.query("INSERT INTO stock_movements (product_id, change, reason, order_id) VALUES ($1,$2,'order_placed',$3)",
        [p.id, -it.qty, order.id]);
    }
    await client.query("COMMIT");
    res.status(201).json(order);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

app.get("/api/orders", wrap(async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const offset = clampInt(req.query.offset, 0, 0, 1000000);
  const cid = req.query.customer_id ? Number(req.query.customer_id) : null;
  const { rows } = await pool.query(
    `SELECT o.id, o.status, o.total_cents, o.created_at, c.name AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE ($1::int IS NULL OR o.customer_id = $1)
     ORDER BY o.created_at DESC LIMIT $2 OFFSET $3`, [cid, limit, offset]);
  res.json(rows);
}));

app.get("/api/orders/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, "bad id");
  const { rows: [order] } = await pool.query(
    "SELECT o.*, c.name AS customer_name FROM orders o JOIN customers c ON c.id=o.customer_id WHERE o.id=$1", [id]);
  if (!order) throw httpError(404, "order not found");
  const { rows: items } = await pool.query(
    `SELECT oi.product_id, p.name, oi.qty, oi.unit_price_cents
     FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=$1 ORDER BY oi.id`, [id]);
  res.json({ ...order, items });
}));

// Cancelling puts the stock back, also in one transaction.
app.post("/api/orders/:id/cancel", wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(400, "bad id");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [order] } = await client.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [id]);
    if (!order) throw httpError(404, "order not found");
    if (order.status !== "placed") throw httpError(409, "order is already " + order.status);
    const { rows: items } = await client.query("SELECT product_id, qty FROM order_items WHERE order_id=$1 ORDER BY product_id", [id]);
    for (const it of items) {
      await client.query("UPDATE products SET stock = stock + $1 WHERE id=$2", [it.qty, it.product_id]);
      await client.query("INSERT INTO stock_movements (product_id, change, reason, order_id) VALUES ($1,$2,'order_cancelled',$3)",
        [it.product_id, it.qty, id]);
    }
    const { rows: [updated] } = await client.query("UPDATE orders SET status='cancelled' WHERE id=$1 RETURNING *", [id]);
    await client.query("COMMIT");
    res.json(updated);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}));

// ---------- errors ----------
app.use((req, res) => res.status(404).json({ error: "not found" }));
app.use((err, _req, res, _next) => {
  // Translate database complaints into friendly answers
  const map = { "23505": [409, "already exists"], "23503": [400, "referenced customer or product does not exist"], "23514": [400, "value not allowed"] };
  if (err.code && map[err.code]) return res.status(map[err.code][0]).json({ error: map[err.code][1] });
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

// ---------- startup: create tables (+ sample data once) ----------
async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const seed = fs.readFileSync(path.join(__dirname, "seed.sql"), "utf8");
  for (let attempt = 1; attempt <= 10; attempt++) {
    const client = await pool.connect().catch((e) => { console.log(`DB not ready (${attempt}/10): ${e.message}`); return null; });
    if (!client) { await new Promise((r) => setTimeout(r, 3000)); continue; }
    try {
      await client.query("SELECT pg_advisory_lock(727274)");      // only one pod sets up tables at a time
      await client.query(schema);
      const { rows } = await client.query("SELECT count(*)::int AS n FROM products");
      if (rows[0].n === 0) { await client.query(seed); console.log("sample data inserted"); }
      await client.query("SELECT pg_advisory_unlock(727274)");
      return;
    } finally { client.release(); }
  }
  throw new Error("database never became reachable");
}

const port = process.env.PORT || 3000;
let server;
initDb().then(() => { server = app.listen(port, () => console.log(`API listening on :${port}`)); })
        .catch((e) => { console.error(e); process.exit(1); });

// Kubernetes sends SIGTERM when stopping a pod: finish current requests, then close DB connections.
process.on("SIGTERM", () => { console.log("shutting down"); (server ? server.close.bind(server) : (f) => f())(() => pool.end().then(() => process.exit(0))); });
