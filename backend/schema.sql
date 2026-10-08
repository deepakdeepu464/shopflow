-- ShopFlow schema. Safe to run many times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  email      TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  sku         TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  price_cents INTEGER     NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER     NOT NULL DEFAULT 0 CHECK (stock >= 0),   -- DB itself refuses negative stock
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id          BIGSERIAL PRIMARY KEY,
  customer_id INTEGER     NOT NULL REFERENCES customers(id),
  status      TEXT        NOT NULL DEFAULT 'placed' CHECK (status IN ('placed','cancelled')),
  total_cents BIGINT      NOT NULL CHECK (total_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
  id               BIGSERIAL PRIMARY KEY,
  order_id         BIGINT  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),  -- price frozen at purchase time
  UNIQUE (order_id, product_id)
);

-- Audit trail: every stock change is written down.
CREATE TABLE IF NOT EXISTS stock_movements (
  id         BIGSERIAL PRIMARY KEY,
  product_id INTEGER     NOT NULL REFERENCES products(id),
  change     INTEGER     NOT NULL,
  reason     TEXT        NOT NULL,
  order_id   BIGINT      REFERENCES orders(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for the queries the app really runs
CREATE INDEX IF NOT EXISTS idx_orders_customer_created ON orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created          ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order       ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product     ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_stock_mov_product_time  ON stock_movements (product_id, created_at DESC);
