// Local state, kept in a single SQLite file (node:sqlite, no native dependency).
// It holds only integration state: queue, ID links, stock holds and sync cursors. No business data is stored here.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'connector.sqlite'));
  migrate(db);
  return db;
}

export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      dedupe_key TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | dead
      attempts INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_pending_dedupe ON jobs(dedupe_key) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);

    CREATE TABLE IF NOT EXISTS webhook_events (
      source TEXT NOT NULL,
      event_id TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (source, event_id)
    );

    -- Raw payload samples: the Jewely webhook body format is not documented, keep a few for inspection.
    CREATE TABLE IF NOT EXISTS webhook_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      topic TEXT,
      body TEXT NOT NULL,
      received_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_links (
      erp_ref TEXT PRIMARY KEY,
      erp_product_id INTEGER,
      shopify_product_id TEXT,
      state_hash TEXT,
      created_by_connector INTEGER NOT NULL DEFAULT 0,
      hidden_by_connector INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    -- ERP stock entries allocated to a Shopify order but possibly still "available" in the ERP
    -- (e.g. the sale is still on_hold). They are excluded from the web stock so they can't be sold twice.
    CREATE TABLE IF NOT EXISTS stock_holds (
      stock_entry_id INTEGER PRIMARY KEY,
      erp_ref TEXT NOT NULL,
      shopify_order_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_links (
      shopify_order_id TEXT PRIMARY KEY,
      shopify_order_name TEXT,
      erp_sale_id INTEGER,
      erp_order_id INTEGER,
      erp_payment_id INTEGER,
      erp_customer_type TEXT,
      erp_customer_id INTEGER,
      status TEXT NOT NULL,          -- synced | partial | failed | cancelled
      detail TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jewely_webhook_secrets (
      type TEXT PRIMARY KEY,
      webhook_id INTEGER NOT NULL,
      secret TEXT
    );
  `);
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Returns true the first time an event id is seen (webhook de-duplication). */
export function markEventSeen(db: Db, source: string, eventId: string): boolean {
  const res = db.prepare('INSERT OR IGNORE INTO webhook_events(source, event_id, received_at) VALUES(?, ?, ?)')
    .run(source, eventId, Date.now());
  return Number(res.changes) > 0;
}

export function saveWebhookSample(db: Db, source: string, topic: string | null, body: string): void {
  db.prepare('INSERT INTO webhook_samples(source, topic, body, received_at) VALUES(?, ?, ?, ?)')
    .run(source, topic, body.slice(0, 50_000), Date.now());
  db.prepare(`DELETE FROM webhook_samples WHERE id NOT IN (SELECT id FROM webhook_samples ORDER BY id DESC LIMIT 100)`).run();
}

export function heldStockEntryIds(db: Db): Set<number> {
  const rows = db.prepare('SELECT stock_entry_id FROM stock_holds').all() as { stock_entry_id: number }[];
  return new Set(rows.map((r) => r.stock_entry_id));
}

export function addStockHold(db: Db, stockEntryId: number, erpRef: string, shopifyOrderId: string): void {
  db.prepare('INSERT OR REPLACE INTO stock_holds(stock_entry_id, erp_ref, shopify_order_id, created_at) VALUES(?, ?, ?, ?)')
    .run(stockEntryId, erpRef, shopifyOrderId, Date.now());
}

export function releaseHoldsForOrder(db: Db, shopifyOrderId: string): string[] {
  const refs = db.prepare('SELECT DISTINCT erp_ref FROM stock_holds WHERE shopify_order_id = ?').all(shopifyOrderId) as { erp_ref: string }[];
  db.prepare('DELETE FROM stock_holds WHERE shopify_order_id = ?').run(shopifyOrderId);
  return refs.map((r) => r.erp_ref);
}

export function releaseHold(db: Db, stockEntryId: number): void {
  db.prepare('DELETE FROM stock_holds WHERE stock_entry_id = ?').run(stockEntryId);
}

export function expireHolds(db: Db, ttlDays: number): number {
  const res = db.prepare('DELETE FROM stock_holds WHERE created_at < ?').run(Date.now() - ttlDays * 86_400_000);
  return Number(res.changes);
}

export interface ProductLink {
  erp_ref: string;
  erp_product_id: number | null;
  shopify_product_id: string | null;
  state_hash: string | null;
  created_by_connector: number;
  hidden_by_connector: number;
}

export function getProductLink(db: Db, ref: string): ProductLink | undefined {
  return db.prepare('SELECT * FROM product_links WHERE erp_ref = ?').get(ref) as ProductLink | undefined;
}

export function upsertProductLink(db: Db, link: Partial<ProductLink> & { erp_ref: string }): void {
  const cur = getProductLink(db, link.erp_ref);
  const merged = {
    erp_product_id: null, shopify_product_id: null, state_hash: null,
    created_by_connector: 0, hidden_by_connector: 0,
    ...cur, ...link,
  };
  db.prepare(`
    INSERT INTO product_links(erp_ref, erp_product_id, shopify_product_id, state_hash, created_by_connector, hidden_by_connector, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(erp_ref) DO UPDATE SET
      erp_product_id = excluded.erp_product_id,
      shopify_product_id = excluded.shopify_product_id,
      state_hash = excluded.state_hash,
      created_by_connector = excluded.created_by_connector,
      hidden_by_connector = excluded.hidden_by_connector,
      updated_at = excluded.updated_at
  `).run(merged.erp_ref, merged.erp_product_id, merged.shopify_product_id, merged.state_hash,
    merged.created_by_connector, merged.hidden_by_connector, Date.now());
}

export interface OrderLink {
  shopify_order_id: string;
  shopify_order_name: string | null;
  erp_sale_id: number | null;
  erp_order_id: number | null;
  erp_payment_id: number | null;
  erp_customer_type: string | null;
  erp_customer_id: number | null;
  status: string;
  detail: string | null;
}

export function getOrderLink(db: Db, shopifyOrderId: string): OrderLink | undefined {
  return db.prepare('SELECT * FROM order_links WHERE shopify_order_id = ?').get(shopifyOrderId) as OrderLink | undefined;
}

export function upsertOrderLink(db: Db, link: Partial<OrderLink> & { shopify_order_id: string; status: string }): void {
  const cur = getOrderLink(db, link.shopify_order_id);
  const m = {
    shopify_order_name: null, erp_sale_id: null, erp_order_id: null, erp_payment_id: null,
    erp_customer_type: null, erp_customer_id: null, detail: null,
    ...cur, ...link,
  };
  db.prepare(`
    INSERT INTO order_links(shopify_order_id, shopify_order_name, erp_sale_id, erp_order_id, erp_payment_id,
                            erp_customer_type, erp_customer_id, status, detail, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(shopify_order_id) DO UPDATE SET
      shopify_order_name = excluded.shopify_order_name, erp_sale_id = excluded.erp_sale_id,
      erp_order_id = excluded.erp_order_id, erp_payment_id = excluded.erp_payment_id,
      erp_customer_type = excluded.erp_customer_type, erp_customer_id = excluded.erp_customer_id,
      status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at
  `).run(m.shopify_order_id, m.shopify_order_name, m.erp_sale_id, m.erp_order_id, m.erp_payment_id,
    m.erp_customer_type, m.erp_customer_id, m.status, m.detail, Date.now());
}
