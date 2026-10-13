// ERP -> Shopify: catalogue, stock, price and visibility. Jewely is the source of truth for these.
import type { Config } from '../config.ts';
import { type Db, expireHolds, getProductLink, heldStockEntryIds, kvGet, kvSet, releaseHold, upsertProductLink } from '../db.ts';
import type { JewelyClient } from '../jewely/client.ts';
import type { ErpProduct, ErpStockEntry } from '../jewely/types.ts';
import { log } from '../lib/log.ts';
import { toErpDateTime, truthy } from '../lib/util.ts';
import type { Queue } from '../queue.ts';
import type { ShopifyClient, ShopifyVariant } from '../shopify/client.ts';
import { desiredState, type MappingOptions, productSetInput, stateHash } from './mapping.ts';

export interface ProductSyncDeps {
  cfg: Config;
  db: Db;
  jewely: JewelyClient;
  shopify: ShopifyClient;
}

export function mappingOptions(cfg: Config): MappingOptions {
  return { sizeSkuSeparator: cfg.shopify.sizeSkuSeparator, stockSalePointIds: cfg.jewely.stockSalePointIds };
}

export type SyncOutcome = 'unchanged' | 'updated' | 'created' | 'skipped' | 'not_found';

/** Brings one ERP product (by ref) in line on Shopify. Safe to run any number of times. */
export async function syncProduct(deps: ProductSyncDeps, ref: string, force = false): Promise<SyncOutcome> {
  const { cfg, db, jewely, shopify } = deps;

  const product = await jewely.findProductByRef(ref);
  if (!product) {
    log.warn('product.sync: ref not found in ERP', { ref });
    return 'not_found';
  }
  const entries = await jewely.stockEntriesByRef(ref);
  releaseResolvedHolds(db, entries);

  const state = desiredState(product, entries, mappingOptions(cfg), heldStockEntryIds(db));
  const hash = stateHash(state);
  const link = getProductLink(db, ref);
  if (!force && link?.state_hash === hash) return 'unchanged';

  const existing = await shopify.variantsBySkus(state.variants.map((v) => v.sku));
  let productId = link?.shopify_product_id ?? [...existing.values()][0]?.productId ?? null;

  // Product not on Shopify yet
  if (!productId) {
    const inStock = state.variants.some((v) => v.quantity > 0);
    if (!state.visible || !cfg.shopify.createProducts || !inStock) {
      upsertProductLink(db, { erp_ref: ref, erp_product_id: product.id, state_hash: hash });
      return 'skipped';
    }
    const id = await shopify.createProduct(productSetInput(product, state, cfg.shopify));
    upsertProductLink(db, { erp_ref: ref, erp_product_id: product.id, shopify_product_id: id, state_hash: id ? hash : null, created_by_connector: 1 });
    log.info('product.sync: created on Shopify as DRAFT', { ref, shopifyProductId: id, variants: state.variants.length });
    return 'created';
  }

  // Existing product: fetch every variant (including sizes the ERP doesn't know about) to reconcile.
  const shopProduct = await shopify.productWithVariants(productId);
  if (!shopProduct) {
    // Deleted on Shopify: forget the link, the next run will recreate or re-link it.
    upsertProductLink(db, { erp_ref: ref, shopify_product_id: null, state_hash: null });
    throw new Error(`Shopify product ${productId} not found (deleted?)`);
  }
  const bySku = new Map<string, ShopifyVariant>(shopProduct.variants.filter((v) => v.sku).map((v) => [v.sku, v]));

  const priceUpdates: { id: string; price: string }[] = [];
  const stockUpdates: { inventoryItemId: string; quantity: number; changeFromQuantity: number | null }[] = [];
  const missing = [];

  for (const want of state.variants) {
    const have = bySku.get(want.sku);
    if (!have) {
      missing.push(want);
      continue;
    }
    if (Number(have.price) !== Number(want.price)) priceUpdates.push({ id: have.id, price: want.price });
    if (have.tracked && have.available !== want.quantity) {
      stockUpdates.push({ inventoryItemId: have.inventoryItemId, quantity: want.quantity, changeFromQuantity: have.available });
    }
  }
  // Variants whose ERP ref/size no longer exists: set them to 0 rather than delete them (the merchant decides).
  const wantedSkus = new Set(state.variants.map((v) => v.sku));
  for (const v of shopProduct.variants) {
    if (v.sku && !wantedSkus.has(v.sku) && v.sku.startsWith(ref) && v.tracked && (v.available ?? 0) > 0) {
      stockUpdates.push({ inventoryItemId: v.inventoryItemId, quantity: 0, changeFromQuantity: v.available });
    }
  }

  await shopify.updateVariantPrices(shopProduct.id, priceUpdates);
  await shopify.setAvailable(stockUpdates, `gid://helena-jewely/ErpProduct/${product.id}`);

  if (missing.length) {
    const sizeOption = shopProduct.options.find((o) => o.name.toLowerCase() === cfg.shopify.sizeOptionName.toLowerCase());
    if (sizeOption && missing.every((m) => m.size)) {
      await shopify.createVariants(shopProduct.id, missing.map((m) => ({
        optionValues: [{ optionName: sizeOption.name, name: m.size }],
        price: m.price,
        inventoryPolicy: 'DENY',
        inventoryItem: { sku: m.sku, tracked: true },
        inventoryQuantities: [{ locationId: cfg.shopify.locationId, availableQuantity: m.quantity }],
      })));
    } else {
      log.warn('product.sync: SKUs missing on Shopify product and cannot be added automatically', {
        ref, shopifyProductId: shopProduct.id, missing: missing.map((m) => m.sku),
      });
    }
  }

  // Visibility (ERP "showOnWebsite"): the connector only re-activates products it hid itself.
  let hidden = link?.hidden_by_connector ?? 0;
  if (!state.visible && shopProduct.status === 'ACTIVE') {
    if (cfg.shopify.hideMode === 'draft') {
      await shopify.setProductStatus(shopProduct.id, 'DRAFT');
      hidden = 1;
    } else {
      const zero = shopProduct.variants.filter((v) => v.tracked && (v.available ?? 0) > 0)
        .map((v) => ({ inventoryItemId: v.inventoryItemId, quantity: 0, changeFromQuantity: null }));
      await shopify.setAvailable(zero, `gid://helena-jewely/ErpProduct/${product.id}`);
    }
  } else if (state.visible && shopProduct.status === 'DRAFT' && hidden) {
    await shopify.setProductStatus(shopProduct.id, 'ACTIVE');
    hidden = 0;
  }

  upsertProductLink(db, {
    erp_ref: ref, erp_product_id: product.id, shopify_product_id: shopProduct.id,
    state_hash: cfg.dryRun ? null : hash, hidden_by_connector: hidden,
  });
  const changed = priceUpdates.length + stockUpdates.length + missing.length > 0;
  if (changed) log.info('product.sync: updated', { ref, prices: priceUpdates.length, stock: stockUpdates.length, newVariants: missing.length });
  return changed ? 'updated' : 'unchanged';
}

/** A hold ends once the ERP itself blocks the piece (in a draft sale, sold or unavailable). */
function releaseResolvedHolds(db: Db, entries: ErpStockEntry[]): void {
  const held = heldStockEntryIds(db);
  for (const e of entries) {
    if (held.has(e.id) && (!truthy(e.isAvailable) || truthy(e.isInPendingSale) || truthy(e.isSold))) releaseHold(db, e.id);
  }
}

// ---------- change detection (fallback for missed webhooks) ----------

const CURSOR_KEY = 'erp.poll.cursor';

/** Incremental poll: queues a sync for every ref the ERP changed since the last cursor. */
export async function pollErpChanges(deps: ProductSyncDeps, queue: Queue): Promise<number> {
  const { db, jewely } = deps;
  const startedAt = new Date();
  const since = kvGet(db, CURSOR_KEY) ?? toErpDateTime(new Date(Date.now() - 24 * 3600_000));
  const refs = new Set<string>();

  const products = await jewely.listAll<ErpProduct>('/products', {
    updatedAt: since, endUpdatedAt: 'now', orderBy: 'updated_at', order: 'asc', perPage: 200, minimal: true,
  });
  products.forEach((p) => p.ref && refs.add(p.ref));

  const entries = await jewely.listAll<ErpStockEntry>('/stocks-entries', { updatedAt: since, perPage: 100 });
  entries.forEach((e) => e.product?.ref && refs.add(e.product.ref));

  // Shop sales take pieces out of stock, and the stock entry itself isn't always touched.
  const sales = await jewely.listAll<{ stocksRemovals?: { product?: { ref?: string | null } }[] }>('/sales', {
    updatedAt: since, endUpdatedAt: 'now', perPage: 100,
  });
  sales.forEach((s) => s.stocksRemovals?.forEach((r) => r.product?.ref && refs.add(r.product.ref)));

  for (const ref of refs) queue.enqueue('product.sync', { ref }, { dedupeKey: `product:${ref}` });
  // 5 minute overlap so nothing slips through between the ERP clock and ours.
  kvSet(db, CURSOR_KEY, toErpDateTime(new Date(startedAt.getTime() - 5 * 60_000)));
  expireHolds(db, deps.cfg.sync.holdTtlDays);
  if (refs.size) log.info('erp.poll: changes queued', { since, refs: refs.size });
  return refs.size;
}

/** Nightly full reconciliation: every product listed on the web is re-checked with force=true. */
export async function queueFullSync(deps: ProductSyncDeps, queue: Queue): Promise<number> {
  // No `minimal` here: we need showOnWebsite.
  const products = await deps.jewely.listAll<ErpProduct>('/products', { perPage: 200, orderBy: 'ref', order: 'asc' });
  let n = 0;
  for (const p of products) {
    const link = getProductLink(deps.db, p.ref);
    // Only products that are on the web or already linked to Shopify are relevant.
    if (!p.showOnWebsite && !link?.shopify_product_id) continue;
    queue.enqueue('product.sync', { ref: p.ref, force: true }, { dedupeKey: `product:${p.ref}` });
    n++;
  }
  log.info('erp.full_sync: queued', { products: n, scanned: products.length });
  return n;
}
