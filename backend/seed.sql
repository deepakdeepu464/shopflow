INSERT INTO customers (name, email) VALUES
  ('Asha Rao',   'asha@example.com'),
  ('Ravi Kumar', 'ravi@example.com'),
  ('Meena Iyer', 'meena@example.com')
ON CONFLICT DO NOTHING;

INSERT INTO products (sku, name, price_cents, stock) VALUES
  ('BK-001', 'Notebook A5',        12000, 50),
  ('PN-001', 'Gel Pen (pack of 5)', 25000, 40),
  ('BG-001', 'Canvas Backpack',    199900, 10),
  ('MG-001', 'Steel Mug',           45000, 25),
  ('LP-001', 'Desk Lamp',           89900, 15),
  ('CB-001', 'USB-C Cable',         29900, 60)
ON CONFLICT DO NOTHING;
