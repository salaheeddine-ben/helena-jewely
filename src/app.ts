// Wiring: clients + queue + job handlers. Shared by the server (index.ts) and the CLI commands.
import { type Config, loadConfig } from './config.ts';
import { type Db, openDb } from './db.ts';
import { JewelyClient } from './jewely/client.ts';
import { log } from './lib/log.ts';
import { PermanentError, Queue } from './queue.ts';
import { ShopifyClient } from './shopify/client.ts';
import { handleCancelledOrder, handleRefund, importOrder } from './sync/orders.ts';
import { pollErpChanges, queueFullSync, syncProduct } from './sync/products.ts';

export interface App {
  cfg: Config;
  db: Db;
  jewely: JewelyClient;
  shopify: ShopifyClient;
  queue: Queue;
}

export function createApp(cfg: Config = loadConfig()): App {
  const db = openDb(cfg.dataDir);
  const jewely = new JewelyClient(cfg.jewely, cfg.dryRun);
  const shopify = new ShopifyClient(cfg.shopify, cfg.dryRun);

  // When a job fails for good, the shop staff get an alert inside the ERP.
  const queue = new Queue(db, async (job, err) => {
    await jewely.notify({
      roles: cfg.jewely.notifyRoles,
      name: `Synchro Shopify : échec (${job.type})`,
      description: `${job.dedupe_key ?? ''}\n${err instanceof Error ? err.message : String(err)}`.slice(0, 2000),
    });
  });

  const deps = { cfg, db, jewely, shopify };

  queue.on('product.sync', async (p: { ref?: string; stockEntryId?: number; force?: boolean }) => {
    let ref = p.ref;
    if (!ref && p.stockEntryId) {
      ref = (await jewely.stockEntryById(p.stockEntryId))?.product?.ref;
      if (!ref) throw new PermanentError(`Stock entry ${p.stockEntryId} not found`);
    }
    if (!ref) throw new PermanentError('product.sync without ref');
    await syncProduct(deps, ref, p.force ?? false);
  });
  queue.on('order.import', async (p) => importOrder({ ...deps, queue }, p.order));
  queue.on('order.cancelled', async (p) => handleCancelledOrder({ ...deps, queue }, p.order));
  queue.on('order.refund', async (p) => handleRefund({ ...deps, queue }, p.refund));
  queue.on('erp.poll', async () => { await pollErpChanges(deps, queue); });
  queue.on('erp.full_sync', async () => { await queueFullSync(deps, queue); });

  return { cfg, db, jewely, shopify, queue };
}

/** Timers: incremental poll every N minutes, full reconciliation once a day. Only with SYNC_PRODUCTS=true. */
export function startScheduler(app: App): () => void {
  const { cfg, queue } = app;
  if (!cfg.sync.products) {
    log.info('scheduler: SYNC_PRODUCTS=false, the Shopify catalogue is not touched (orders only)');
    return () => {};
  }
  const poll = setInterval(() => queue.enqueue('erp.poll', {}, { dedupeKey: 'erp.poll' }), cfg.sync.pollIntervalMinutes * 60_000);
  let lastFullDay = '';
  const full = setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(now));
    if (hour === cfg.sync.fullSyncHour && day !== lastFullDay) {
      lastFullDay = day;
      queue.enqueue('erp.full_sync', {}, { dedupeKey: 'erp.full_sync' });
      log.info('scheduler: nightly full sync queued');
    }
  }, 60_000);
  queue.enqueue('erp.poll', {}, { dedupeKey: 'erp.poll' }); // catch up at startup
  return () => { clearInterval(poll); clearInterval(full); };
}
