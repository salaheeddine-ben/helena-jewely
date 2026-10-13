// HTTP entry points. Every webhook is authenticated, de-duplicated, queued, and answered with 200 right away.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import { type Db, markEventSeen, saveWebhookSample } from './db.ts';
import { log } from './lib/log.ts';
import type { Queue } from './queue.ts';
import { extractJewelyRefs, verifyJewelySignature, verifyShopifyHmac } from './webhooks.ts';
import { WEBHOOK_TYPES } from './jewely/types.ts';

const SHOPIFY_TOPICS: Record<string, 'order.import' | 'order.cancelled' | 'order.refund'> = {
  'orders/paid': 'order.import',
  'orders/cancelled': 'order.cancelled',
  'refunds/create': 'order.refund',
};

export function buildServer(cfg: Config, db: Db, queue: Queue): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

      if (req.method === 'POST' && url.pathname === '/webhooks/shopify') {
        return await handleShopify(req, res, cfg, db, queue);
      }
      const jewelyMatch = url.pathname.match(/^\/webhooks\/jewely\/([a-z-]+)$/);
      if (req.method === 'POST' && jewelyMatch) {
        return await handleJewely(req, res, url, jewelyMatch[1], cfg, db, queue);
      }
      if (url.pathname.startsWith('/admin/')) return await handleAdmin(req, res, url, cfg, db, queue);

      json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error('http: unhandled error', { error: err });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }
  });
}

async function handleShopify(req: IncomingMessage, res: ServerResponse, cfg: Config, db: Db, queue: Queue) {
  const raw = await readBody(req);
  if (!verifyShopifyHmac(raw, header(req, 'x-shopify-hmac-sha256'), cfg.shopify.webhookSecret)) {
    log.warn('shopify webhook: bad HMAC');
    return json(res, 401, { error: 'invalid signature' });
  }
  const topic = header(req, 'x-shopify-topic') ?? '';
  const eventId = header(req, 'x-shopify-event-id') ?? header(req, 'x-shopify-webhook-id');
  if (eventId && !markEventSeen(db, 'shopify', eventId)) return json(res, 200, { duplicate: true });

  const kind = SHOPIFY_TOPICS[topic];
  if (!kind) return json(res, 200, { ignored: topic });
  const payload = JSON.parse(raw.toString('utf8'));
  queue.enqueue(kind, kind === 'order.refund' ? { refund: payload } : { order: payload }, { dedupeKey: `${kind}:${payload.id}` });
  log.info('shopify webhook queued', { topic, order: payload.name ?? payload.order_id });
  json(res, 200, { queued: true });
}

async function handleJewely(req: IncomingMessage, res: ServerResponse, url: URL, type: string, cfg: Config, db: Db, queue: Queue) {
  const raw = await readBody(req);
  // Two ways to authenticate: the secret token in the URL (which we control), or the HMAC signature (format inferred, see webhooks.ts).
  const tokenOk = safeEq(url.searchParams.get('token') ?? '', cfg.jewely.webhookUrlToken);
  const secrets = (db.prepare('SELECT secret FROM jewely_webhook_secrets WHERE secret IS NOT NULL').all() as { secret: string }[]).map((r) => r.secret);
  const sigOk = verifyJewelySignature(raw, req.headers, secrets);
  if (!tokenOk && !sigOk) {
    log.warn('jewely webhook: rejected (bad token and signature)', { type });
    return json(res, 401, { error: 'unauthorized' });
  }
  if (!WEBHOOK_TYPES.includes(type as never)) return json(res, 404, { error: 'unknown type' });
  if (!cfg.sync.products) return json(res, 200, { ignored: 'SYNC_PRODUCTS=false' });

  const text = raw.toString('utf8');
  saveWebhookSample(db, 'jewely', type, text);
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* body that isn't JSON: falls back to polling */ }

  const { refs, stockEntryIds } = extractJewelyRefs(payload);
  for (const ref of refs) queue.enqueue('product.sync', { ref }, { dedupeKey: `product:${ref}` });
  // A stock entry id alone (no ref) costs one extra API call to resolve the ref.
  if (!refs.length) for (const id of stockEntryIds) queue.enqueue('product.sync', { stockEntryId: id }, { dedupeKey: `stock-entry:${id}` });
  // Nothing recognisable: queue an incremental poll to catch up (deduplicated).
  if (!refs.length && !stockEntryIds.length) queue.enqueue('erp.poll', {}, { dedupeKey: 'erp.poll', delayMs: 5_000 });

  log.info('jewely webhook queued', { type, refs: refs.length, stockEntryIds: stockEntryIds.length, sigOk });
  json(res, 200, { queued: true });
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL, cfg: Config, db: Db, queue: Queue) {
  const auth = header(req, 'authorization') ?? '';
  if (!safeEq(auth, `Bearer ${cfg.adminToken}`)) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname === '/admin/status') {
    return json(res, 200, {
      dryRun: cfg.dryRun,
      orderMode: cfg.jewely.orderMode,
      syncProducts: cfg.sync.products,
      jobs: queue.stats(),
      deadJobs: queue.deadJobs(20),
      orders: db.prepare('SELECT status, COUNT(*) AS n FROM order_links GROUP BY status').all(),
      recentOrders: db.prepare('SELECT * FROM order_links ORDER BY updated_at DESC LIMIT 20').all(),
      holds: db.prepare('SELECT COUNT(*) AS n FROM stock_holds').get(),
      linkedProducts: db.prepare('SELECT COUNT(*) AS n FROM product_links WHERE shopify_product_id IS NOT NULL').get(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/admin/webhook-samples') {
    return json(res, 200, db.prepare('SELECT * FROM webhook_samples ORDER BY id DESC LIMIT 20').all());
  }
  if (req.method === 'POST' && url.pathname === '/admin/sync') {
    if (!cfg.sync.products) return json(res, 409, { error: 'SYNC_PRODUCTS=false: the catalogue sync is disabled' });
    const ref = url.searchParams.get('ref');
    if (ref) queue.enqueue('product.sync', { ref, force: true }, { dedupeKey: `product:${ref}` });
    else queue.enqueue('erp.full_sync', {}, { dedupeKey: 'erp.full_sync' });
    return json(res, 202, { queued: ref ?? 'full' });
  }
  if (req.method === 'POST' && url.pathname === '/admin/retry-dead') {
    return json(res, 200, { retried: queue.retryDead() });
  }
  json(res, 404, { error: 'not found' });
}

// ---------- utils ----------

function readBody(req: IncomingMessage, limit = 5_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function safeEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
