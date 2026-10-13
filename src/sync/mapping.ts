// Pure mapping rules between the Jewely and Shopify models. No I/O here, so it is fully unit-tested.
//
// Jewelry model difference:
//   Jewely : a Product (ref) has N Stock entries, one per physical piece (serial no., size, sale point, price).
//   Shopify: a Product has Variants (SKU), each with a quantity per Location.
// Rule: Shopify variant SKU = ERP ref, or `${ref}${sep}${size}` when the pieces come in several sizes (rings).
import { createHash } from 'node:crypto';
import type { ErpProduct, ErpStockEntry } from '../jewely/types.ts';
import { parseMoney, round2, truthy } from '../lib/util.ts';

export interface MappingOptions {
  sizeSkuSeparator: string;
  stockSalePointIds: number[]; // empty = every sale point counts for the web stock
}

export interface DesiredVariant {
  sku: string;
  size: string | null;
  price: string;          // Shopify Money string, e.g. "1250.00"
  quantity: number;
  stockEntryIds: number[];
}

export interface DesiredProductState {
  ref: string;
  erpProductId: number;
  visible: boolean;
  variants: DesiredVariant[];
}

export function normaliseSize(size: unknown): string | null {
  if (size === null || size === undefined) return null;
  const s = String(size).trim();
  return s === '' ? null : s;
}

export function skuFor(ref: string, size: string | null, sep: string): string {
  return size ? `${ref}${sep}${size}` : ref;
}

/** Splits a Shopify SKU back into the ERP ref and size. `knownRef` handles refs that contain the separator. */
export function parseSku(sku: string, sep: string, knownRef?: (ref: string) => boolean): { ref: string; size: string | null } {
  const trimmed = sku.trim();
  if (knownRef?.(trimmed)) return { ref: trimmed, size: null };
  const idx = trimmed.lastIndexOf(sep);
  if (idx > 0 && idx < trimmed.length - sep.length) {
    const ref = trimmed.slice(0, idx);
    if (!knownRef || knownRef(ref)) return { ref, size: trimmed.slice(idx + sep.length) };
  }
  return { ref: trimmed, size: null };
}

/** Can this physical piece be sold online right now? */
export function isSellableOnline(e: ErpStockEntry, opts: MappingOptions, held: Set<number>): boolean {
  if (held.has(e.id)) return false;
  if (!truthy(e.isAvailable) || truthy(e.isInPendingSale) || truthy(e.isSold)) return false;
  if (e.isSellable !== undefined && e.isSellable !== null && !truthy(e.isSellable)) return false;
  if (truthy(e.isReserved) || truthy(e.isUnderRepair) || truthy(e.isConfided) || truthy(e.isDeleted)) return false;
  if (e.transferId !== null && e.transferId !== undefined && e.transferId !== '') return false;
  if (opts.stockSalePointIds.length && !opts.stockSalePointIds.includes(e.salePointId)) return false;
  return true;
}

/** Works out what Shopify should show for one ERP product. */
export function desiredState(product: ErpProduct, entries: ErpStockEntry[], opts: MappingOptions, held: Set<number>): DesiredProductState {
  const productPrice = parseMoney(product.priceTtc);
  const bySize = new Map<string | null, ErpStockEntry[]>();
  const allSizes = new Set<string | null>();

  for (const e of entries) {
    const size = normaliseSize(e.size);
    allSizes.add(size);
    if (!isSellableOnline(e, opts, held)) continue;
    if (!bySize.has(size)) bySize.set(size, []);
    bySize.get(size)!.push(e);
  }

  // Sold-out sizes stay as variants with quantity 0 so they don't disappear from Shopify.
  const hasSizes = [...allSizes].some((s) => s !== null);
  const sizes = hasSizes ? [...allSizes].filter((s): s is string => s !== null).sort(compareSizes) : [null];

  const variants: DesiredVariant[] = sizes.map((size) => {
    const pieces = (bySize.get(size) ?? []).slice().sort((a, b) => (parseMoney(a.priceTtc) ?? Infinity) - (parseMoney(b.priceTtc) ?? Infinity));
    // Price shown = the cheapest available piece (the one that gets allocated first), else the catalogue price.
    const price = parseMoney(pieces[0]?.priceTtc) ?? productPrice ?? 0;
    return {
      sku: skuFor(product.ref, size, opts.sizeSkuSeparator),
      size,
      price: round2(price).toFixed(2),
      quantity: pieces.length,
      stockEntryIds: pieces.map((p) => p.id),
    };
  });

  return { ref: product.ref, erpProductId: product.id, visible: Boolean(product.showOnWebsite), variants };
}

function compareSizes(a: string, b: string): number {
  const na = Number(a.replace(',', '.'));
  const nb = Number(b.replace(',', '.'));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, 'fr');
}

/** Stable hash used to skip Shopify calls when nothing changed since the last sync. */
export function stateHash(s: DesiredProductState): string {
  const canonical = { v: s.visible, x: s.variants.map((v) => [v.sku, v.price, v.quantity]) };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

/** Picks `quantity` pieces to sell for one order line, cheapest first, preferring the web sale point's own stock. */
export function pickStockEntries(
  entries: ErpStockEntry[], size: string | null, quantity: number, opts: MappingOptions, held: Set<number>, webSalePointId: number,
): ErpStockEntry[] {
  const candidates = entries
    .filter((e) => normaliseSize(e.size) === size && isSellableOnline(e, opts, held))
    .sort((a, b) => {
      const local = Number(b.salePointId === webSalePointId) - Number(a.salePointId === webSalePointId);
      if (local) return local;
      return (parseMoney(a.priceTtc) ?? 0) - (parseMoney(b.priceTtc) ?? 0);
    });
  return candidates.slice(0, quantity);
}

/** Shopify product payload for productSet when a product is created from the ERP (created as DRAFT). */
export function productSetInput(product: ErpProduct, state: DesiredProductState, cfg: { locationId: string; sizeOptionName: string }) {
  const hasSizes = state.variants.some((v) => v.size !== null);
  const optionName = hasSizes ? cfg.sizeOptionName : 'Title';
  const optionValue = (v: DesiredVariant) => (hasSizes ? v.size! : 'Default Title');
  const imageUrls = (product.images ?? []).map(imageUrl).filter((u): u is string => !!u).slice(0, 20);

  const tags = [product.categoryName, product.subCategoryName, product.collection, product.isOccasion ? 'Occasion' : null,
    ...(product.materials ?? []).map((m) => m.name), 'jewely']
    .filter((t): t is string => !!t && t.trim() !== '');

  return {
    title: product.model?.trim() || product.description?.trim() || product.ref,
    descriptionHtml: textToHtml(product.longDescription || product.description || ''),
    vendor: product.brand ?? undefined,
    productType: product.categoryName ?? undefined,
    status: 'DRAFT',
    tags: [...new Set(tags)],
    productOptions: [{ name: optionName, position: 1, values: state.variants.map((v) => ({ name: optionValue(v) })) }],
    files: imageUrls.map((u) => ({ originalSource: u, contentType: 'IMAGE' })),
    metafields: [{ namespace: 'jewely', key: 'product_id', type: 'number_integer', value: String(product.id) }],
    variants: state.variants.map((v) => ({
      optionValues: [{ optionName, name: optionValue(v) }],
      sku: v.sku,
      price: v.price,
      inventoryPolicy: 'DENY',
      inventoryItem: { tracked: true },
      inventoryQuantities: [{ locationId: cfg.locationId, name: 'available', quantity: v.quantity }],
    })),
  };
}

function imageUrl(img: unknown): string | null {
  if (typeof img === 'string') return /^https?:\/\//.test(img) ? img : null;
  if (img && typeof img === 'object') {
    const o = img as Record<string, unknown>;
    const u = o.url ?? o.src ?? o.originalUrl;
    return typeof u === 'string' && /^https?:\/\//.test(u) ? u : null;
  }
  return null;
}

function textToHtml(text: string): string {
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}
