DROP SCHEMA IF EXISTS dwh_import_e2e CASCADE;
CREATE SCHEMA dwh_import_e2e;

CREATE TABLE dwh_import_e2e.notes (
  id integer PRIMARY KEY,
  body text
);

CREATE TABLE dwh_import_e2e.supplier_products (
  supplier_id text,
  external_sku text,
  title text
);

CREATE TABLE dwh_import_e2e.products (
  product_id text,
  variant_code text,
  name text
);

CREATE TABLE dwh_import_e2e._map_supplier_products (
  id bigserial PRIMARY KEY,
  supplier_id text NOT NULL,
  external_sku text NOT NULL,
  product_id text NOT NULL,
  variant_code text,
  note text,
  UNIQUE (supplier_id, external_sku)
);

CREATE TABLE dwh_import_e2e.map_dups (
  supplier_id text,
  product_id text
);

INSERT INTO dwh_import_e2e.notes VALUES (1, 'not a map');
INSERT INTO dwh_import_e2e.supplier_products VALUES ('s1', 'sku-1', 'Widget');
INSERT INTO dwh_import_e2e.products VALUES ('p1', 'v1', 'Widget');
INSERT INTO dwh_import_e2e._map_supplier_products
  (supplier_id, external_sku, product_id, variant_code, note)
VALUES ('s1', 'sku-1', 'p1', 'v1', 'ok');
INSERT INTO dwh_import_e2e.map_dups VALUES ('s1', 'p1'), ('s1', 'p2'), (NULL, 'p3');

CREATE VIEW dwh_import_e2e.v_suppliers AS
SELECT supplier_id, title FROM dwh_import_e2e.supplier_products;

CREATE MATERIALIZED VIEW dwh_import_e2e.mv_supplier_names AS
SELECT supplier_id FROM dwh_import_e2e.supplier_products
WITH NO DATA;
