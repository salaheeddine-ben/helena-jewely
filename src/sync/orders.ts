// Shopify -> ERP: a paid web order is booked in Jewely.
// - Each line is linked to a Jewely product through the SKU mapping (mapping.csv, see sku-map.ts).
// - JEWELY_ORDER_MODE=customer_order (default, made-to-order shop): mapped lines become a customer order
//   ("commande client", POST /orders), the same flow Jewely runs for its other Shopify tenant.
//   stock_first: pieces in stock are sold first (POST /sales, idempotent on externalId), the rest is ordered.
// - Lines whose product isn't in Jewely are listed in the ERP notification for the shop to enter by hand.
// - The Shopify payment is recorded as a deposit (POST /payments) on the customer.
import type { Config } from '../config.ts';
import { addStockHold, type Db, getOrderLink, heldStockEntryIds, releaseHoldsForOrder, upsertOrderLink } from '../db.ts';
import { extractId, type JewelyClient } from '../jewely/client.ts';
import type { CreateContactBody, CreateSaleBody, CustomerRef, ErpProduct, ErpStockEntry } from '../jewely/types.ts';
import { log } from '../lib/log.ts';
import { parseMoney, round2 } from '../lib/util.ts';
import { PermanentError, type Queue } from '../queue.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { normaliseSize, pickStockEntries } from './mapping.ts';
import { mappingOptions } from './products.ts';
import { loadSkuMap, refForLine } from './sku-map.ts';

// Shopify REST webhook payload (orders/paid). Only the fields we use are listed.
export interface ShopifyAddress {
  first_name?: string | null; last_name?: string | null; company?: string | null;
  address1?: string | null; address2?: string | null; city?: string | null; zip?: string | null;
  country_code?: string | null; phone?: string | null;
}
export interface ShopifyLineItem {
  id: number; sku: string | null; title: string; variant_title?: string | null; quantity: number;
  price: string; total_discount?: string; discount_allocations?: { amount: string }[];
}
export interface ShopifyOrder {
  id: number; admin_graphql_api_id?: string; name: string; email?: string | null; contact_email?: string | null;
  processed_at?: string | null; created_at?: string; currency: string; total_price: string;
  buyer_accepts_marketing?: boolean; note?: string | null;
  customer?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null } | null;
  billing_address?: ShopifyAddress | null; shipping_address?: ShopifyAddress | null;
  line_items: ShopifyLineItem[];
  shipping_lines?: { title: string; price: string; discounted_price?: string }[];
}

export interface OrderDeps {
  cfg: Config;
  db: Db;
  jewely: JewelyClient;
  shopify: ShopifyClient;
  queue: Queue;
}

interface ResolvedLine {
  line: ShopifyLineItem;
  product?: ErpProduct;
  size: string | null;
  picked: ErpStockEntry[];
  backorderQty: number;
  /** Why the line couldn't be booked automatically (the shop enters it by hand). */
  manual?: string;
}

export const externalIdFor = (order: Pick<ShopifyOrder, 'id'>) => `shopify-${order.id}`;

export async function importOrder(deps: OrderDeps, order: ShopifyOrder): Promise<void> {
  const { cfg, db, jewely } = deps;
  const orderId = String(order.id);
  const link = getOrderLink(db, orderId);
  if (link?.status === 'synced' || link?.status === 'cancelled') {
    log.info('order.import: already processed', { order: order.name, status: link.status });
    return;
  }
  if (order.currency !== 'EUR') {
    throw new PermanentError(`Order ${order.name}: shop currency ${order.currency} is not EUR (ERP sales are booked in EUR)`);
  }

  // 1. Customer
  const customer = link?.erp_customer_id
    ? { type: link.erp_customer_type as CustomerRef['type'], id: link.erp_customer_id }
    : await resolveCustomer(deps, order);
  upsertOrderLink(db, { shopify_order_id: orderId, shopify_order_name: order.name, status: link?.status ?? 'pending', erp_customer_type: customer.type, erp_customer_id: customer.id });

  // 2. Line resolution: SKU -> ERP product -> physical pieces
  const resolved = await resolveLines(deps, order);
  const date = order.processed_at ?? order.created_at;

  // 3. Sale for the pieces in stock
  let saleId = link?.erp_sale_id ?? null;
  const saleLines = resolved.filter((r) => r.picked.length > 0);
  if (!saleId && saleLines.length) {
    const body = buildSaleBody(order, saleLines, customer, cfg);
    const res = await jewely.createSale(body);
    saleId = extractId(res);
    if (!cfg.dryRun) {
      for (const r of saleLines) for (const e of r.picked) addStockHold(db, e.id, r.product!.ref, orderId);
    }
    upsertOrderLink(db, { shopify_order_id: orderId, status: 'pending', erp_sale_id: saleId });
    log.info('order.import: ERP sale created', { order: order.name, saleId, pieces: body.stocksRemovals.length });
  }

  // 4. Customer order (commande client) for pieces out of stock or made to order
  let erpOrderId = link?.erp_order_id ?? null;
  const backorders = resolved.filter((r) => r.product && r.backorderQty > 0);
  if (!erpOrderId && backorders.length) {
    const res = await jewely.createOrder({
      operator: { id: cfg.jewely.operatorId },
      salePointId: cfg.jewely.webSalePointId,
      customer,
      externalId: `${externalIdFor(order)}-commande`,
      date: date ?? undefined,
      type: 'customer_command',
      orderEntries: backorders.map((r) => ({
        product: { id: r.product!.id },
        orderProducts: Array.from({ length: r.backorderQty }, () => ({ priceHt: round2(unitNet(r.line) / (1 + cfg.jewely.vatRate)) })),
      })),
    });
    erpOrderId = extractId(res);
    upsertOrderLink(db, { shopify_order_id: orderId, status: 'pending', erp_order_id: erpOrderId });
    log.info('order.import: ERP customer order created', { order: order.name, erpOrderId, lines: backorders.length });
  }

  // 5. The Shopify payment, recorded as a deposit (acompte) on the customer
  let paymentId = link?.erp_payment_id ?? null;
  const total = parseMoney(order.total_price) ?? 0;
  if (!paymentId && cfg.jewely.paymentOptionId && total > 0) {
    const res = await jewely.createPayment({
      customer,
      salePointId: cfg.jewely.webSalePointId,
      optionId: cfg.jewely.paymentOptionId,
      value: total,
      currency: 'EUR',
      date: date ?? undefined,
      isDeposit: true,
      ref: order.name,
      description: `Paiement Shopify ${order.name}`,
      orderId: !saleId && erpOrderId ? erpOrderId : null,
    });
    paymentId = extractId(res);
    upsertOrderLink(db, { shopify_order_id: orderId, status: 'pending', erp_payment_id: paymentId });
  }

  // 6. Status, alerting and traceability
  const manual = resolved.filter((r) => r.manual);
  const status = manual.length ? 'partial' : 'synced';
  upsertOrderLink(db, { shopify_order_id: orderId, status, detail: manual.map((r) => `${describe(r.line)} : ${r.manual}`).join('\n') || null });

  const shipping = shippingTotal(order);
  await jewely.notify({
    roles: cfg.jewely.notifyRoles,
    salePointId: cfg.jewely.webSalePointId,
    name: manual.length ? `Commande web ${order.name} : article(s) à saisir` : `Nouvelle commande web ${order.name}`,
    description: [
      saleLines.length ? `Vente${saleId ? ` #${saleId}` : ''} créée (${cfg.jewely.saleStatus === 'on_hold' ? 'en attente, à finaliser' : 'traitée'}) :` : null,
      ...saleLines.map((r) => `• ${describe(r.line, r.picked.length)} (réf. ${r.product!.ref})`),
      backorders.length ? `Commande client${erpOrderId ? ` #${erpOrderId}` : ''} créée :` : null,
      ...backorders.map((r) => `• ${describe(r.line, r.backorderQty)} (réf. ${r.product!.ref})`),
      manual.length ? 'À saisir à la main (produit non relié à Jewely) :' : null,
      ...manual.map((r) => `⚠ ${describe(r.line)}, ${r.line.price} € : ${r.manual}`),
      shipping > 0 ? `Livraison : ${shipping.toFixed(2)} €${saleId && !Number.isInteger(shipping) ? ' (à ajouter à la vente : montant non entier, refusé par l\'API)' : ''}.` : null,
      paymentId ? `Acompte Shopify de ${total.toFixed(2)} € enregistré.` : null,
      order.note ? `Note client : ${order.note}` : null,
    ].filter(Boolean).join('\n'),
  }).catch((e) => log.warn('order.import: notification failed', { error: e }));

  if (order.admin_graphql_api_id && (saleId || erpOrderId || paymentId)) {
    const tags = [
      'jewely-sync',
      saleId ? `jewely-vente-${saleId}` : null,
      erpOrderId ? `jewely-commande-${erpOrderId}` : null,
      manual.length ? 'jewely-a-saisir' : null,
    ].filter((t): t is string => !!t);
    await deps.shopify.addOrderTags(order.admin_graphql_api_id, tags).catch((e) => log.warn('order.import: tagging failed', { error: e }));
  }

  // Push the stock again (pieces are now on hold) so every channel agrees.
  if (cfg.sync.products) {
    for (const r of resolved) if (r.product) deps.queue.enqueue('product.sync', { ref: r.product.ref }, { dedupeKey: `product:${r.product.ref}` });
  }

  log.info('order.import: done', { order: order.name, status, saleId, erpOrderId, paymentId, manualLines: manual.length });
}

/** Cancelled on Shopify: the ERP has no API to cancel a sale, so staff are notified to do it (credit note). */
export async function handleCancelledOrder(deps: OrderDeps, order: ShopifyOrder): Promise<void> {
  const orderId = String(order.id);
  const link = getOrderLink(deps.db, orderId);
  const refs = releaseHoldsForOrder(deps.db, orderId);
  if (deps.cfg.sync.products) refs.forEach((ref) => deps.queue.enqueue('product.sync', { ref }, { dedupeKey: `product:${ref}` }));
  if (!link) return;
  upsertOrderLink(deps.db, { shopify_order_id: orderId, status: 'cancelled' });
  await deps.jewely.notify({
    roles: deps.cfg.jewely.notifyRoles,
    salePointId: deps.cfg.jewely.webSalePointId,
    name: `Commande web ${order.name} annulée`,
    description: [
      'La commande a été annulée sur Shopify.',
      link.erp_sale_id ? `Vente #${link.erp_sale_id} : à annuler / contre-passer dans Jewely.` : null,
      link.erp_order_id ? `Commande client #${link.erp_order_id} : à annuler.` : null,
      link.erp_payment_id ? `Acompte #${link.erp_payment_id} : à rembourser si besoin.` : null,
    ].filter(Boolean).join('\n'),
  });
}

/** Refund on Shopify: notify the shop so it creates the credit note (avoir) in Jewely. */
export async function handleRefund(deps: OrderDeps, refund: { order_id: number; transactions?: { amount: string }[] }): Promise<void> {
  const link = getOrderLink(deps.db, String(refund.order_id));
  if (!link) return;
  const amount = (refund.transactions ?? []).reduce((s, t) => s + (parseMoney(t.amount) ?? 0), 0);
  await deps.jewely.notify({
    roles: deps.cfg.jewely.notifyRoles,
    salePointId: deps.cfg.jewely.webSalePointId,
    name: `Remboursement web ${link.shopify_order_name ?? refund.order_id}`,
    description: `Remboursement Shopify de ${amount.toFixed(2)} €. ${link.erp_sale_id ? `Créer l'avoir sur la vente #${link.erp_sale_id}.` : ''}`.trim(),
  });
}

// ---------- helpers ----------

async function resolveCustomer(deps: OrderDeps, order: ShopifyOrder): Promise<CustomerRef> {
  const { jewely } = deps;
  const email = (order.email || order.contact_email || order.customer?.email || '').trim() || null;
  if (email) {
    const found = await jewely.findCustomerByEmail(email);
    if (found) return found;
  }
  const body = await buildContactBody(deps, order, email);
  const res = await jewely.createContact(body);
  const id = extractId(res);
  if (id === null) {
    if (deps.cfg.dryRun) return { type: 'contact', id: 0 };
    throw new Error(`Contact creation returned no id: ${JSON.stringify(res).slice(0, 300)}`);
  }
  log.info('order.import: ERP contact created', { order: order.name, contactId: id });
  return { type: 'contact', id };
}

export async function buildContactBody(deps: Pick<OrderDeps, 'jewely'>, order: ShopifyOrder, email: string | null): Promise<CreateContactBody> {
  const addr = order.billing_address ?? order.shipping_address ?? {};
  const firstName = addr.first_name ?? order.customer?.first_name ?? null;
  const lastName = addr.last_name ?? order.customer?.last_name ?? null;
  const phone = addr.phone ?? order.customer?.phone ?? null;
  return {
    // Jewely: name = last name, surname = first name (see docs/ARCHITECTURE.md, "points à valider").
    name: lastName,
    surname: firstName,
    email,
    acceptProspecting: Boolean(order.buyer_accepts_marketing),
    type: 'contact',
    address: {
      street: [addr.address1, addr.address2].filter(Boolean).join(', ') || null,
      zipCode: addr.zip ?? null,
      city: addr.city ?? null,
      countryId: await deps.jewely.countryIdByIso2(addr.country_code),
    },
    // The spec requires exactly two entries (minItems = maxItems = 2): one mobile, one landline.
    phonesNumbers: [
      { number: phone, type: 'mobile', iso: addr.country_code?.toLowerCase() ?? null },
      { number: null, type: 'desk', iso: addr.country_code?.toLowerCase() ?? null },
    ],
    note: { description: `Client créé depuis Shopify (commande ${order.name})` },
  };
}

async function resolveLines(deps: OrderDeps, order: ShopifyOrder): Promise<ResolvedLine[]> {
  const { cfg, db, jewely } = deps;
  const opts = mappingOptions(cfg);
  const held = heldStockEntryIds(db);
  const skuMap = loadSkuMap(cfg.mappingFile);
  const productCache = new Map<string, ErpProduct | undefined>();
  const entriesCache = new Map<string, ErpStockEntry[]>();
  const findProduct = async (ref: string) => {
    if (!productCache.has(ref)) productCache.set(ref, await jewely.findProductByRef(ref));
    return productCache.get(ref);
  };

  const out: ResolvedLine[] = [];
  for (const line of order.line_items) {
    const sku = line.sku?.trim();
    if (!sku) {
      out.push({ line, size: null, picked: [], backorderQty: 0, manual: 'article sans SKU sur Shopify' });
      continue;
    }
    // The mapping gives the ref; without a row, the SKU itself may be the Jewely ref.
    const mapped = refForLine(skuMap, sku, line.variant_title);
    const ref = mapped ?? sku;
    const product = await findProduct(ref);
    if (!product) {
      const why = mapped ? `réf. ${ref} introuvable dans Jewely` : skuMap.has(sku) ? `SKU ${sku} : couleur non reconnue dans le mapping` : `SKU ${sku} absent du mapping`;
      out.push({ line, size: null, picked: [], backorderQty: 0, manual: why });
      continue;
    }
    if (cfg.jewely.orderMode === 'customer_order') {
      out.push({ line, product, size: null, picked: [], backorderQty: line.quantity });
      continue;
    }
    if (!entriesCache.has(ref)) entriesCache.set(ref, await jewely.stockEntriesByRef(ref));
    const entries = entriesCache.get(ref)!;
    const size = sizeFromVariantTitle(line.variant_title, entries);
    const picked = pickStockEntries(entries, size, line.quantity, opts, held, cfg.jewely.webSalePointId);
    picked.forEach((e) => held.add(e.id)); // two lines of the same order must not take the same piece
    out.push({ line, product, size, picked, backorderQty: line.quantity - picked.length });
  }
  return out;
}

/** The ring size is one of the Shopify option values ("Or blanc / 52"): keep the one that exists as a piece size. */
export function sizeFromVariantTitle(variantTitle: string | null | undefined, entries: ErpStockEntry[]): string | null {
  const sizes = new Set(entries.map((e) => normaliseSize(e.size)).filter((s): s is string => s !== null));
  if (!sizes.size || !variantTitle) return null;
  return variantTitle.split(' / ').map((p) => normaliseSize(p)).find((p): p is string => p !== null && sizes.has(p)) ?? null;
}

/** "Bague Iris (Or blanc / 52) × 2" */
function describe(line: ShopifyLineItem, qty = line.quantity): string {
  return `${line.title}${line.variant_title ? ` (${line.variant_title})` : ''} × ${qty}`;
}

/** Net unit price after discounts (TTC). */
function unitNet(line: ShopifyLineItem): number {
  const price = parseMoney(line.price) ?? 0;
  return round2(price - lineDiscount(line) / Math.max(1, line.quantity));
}

function lineDiscount(line: ShopifyLineItem): number {
  const alloc = (line.discount_allocations ?? []).reduce((s, d) => s + (parseMoney(d.amount) ?? 0), 0);
  return alloc || parseMoney(line.total_discount) || 0;
}

/** Builds the POST /sales body. One stock removal per piece; the line discount is spread so that totals match to the cent. */
export function buildSaleBody(order: ShopifyOrder, lines: Pick<ResolvedLine, 'line' | 'picked'>[], customer: CustomerRef, cfg: Config): CreateSaleBody {
  const stocksRemovals: CreateSaleBody['stocksRemovals'] = [];
  let needsTransfer = false;

  for (const { line, picked } of lines) {
    const unitPrice = parseMoney(line.price) ?? 0;
    const discountTotal = round2(lineDiscount(line) * (picked.length / Math.max(1, line.quantity)));
    const perUnit = Math.floor((discountTotal / picked.length) * 100) / 100;
    picked.forEach((entry, i) => {
      const isLast = i === picked.length - 1;
      const discountTtc = isLast ? round2(discountTotal - perUnit * (picked.length - 1)) : perUnit;
      stocksRemovals.push({ stockEntryId: entry.id, priceTtc: unitPrice, discountTtc });
      if (entry.salePointId !== cfg.jewely.webSalePointId) needsTransfer = true;
    });
  }

  const shipping = shippingTotal(order);
  const body: CreateSaleBody = {
    externalId: externalIdFor(order),
    date: order.processed_at ?? order.created_at,
    status: cfg.jewely.saleStatus,
    invoiceCurrency: 'EUR',
    salePointId: cfg.jewely.webSalePointId,
    customer,
    operatorsIds: [cfg.jewely.operatorId],
    stocksRemovals,
    // Pieces held in a physical shop get moved to the web sale point before the sale is created.
    autoTransferStock: needsTransfer,
  };
  // The spec types salesProvisions[].priceTtc as an integer, so 9.90 would be rejected (422) and block the whole
  // sale. Only whole amounts are sent; the shop is told to add the others by hand (see importOrder).
  if (shipping > 0 && Number.isInteger(shipping)) {
    body.salesProvisions = [{ priceTtc: shipping, provision: { name: cfg.jewely.shippingProvisionName } }];
  }
  return body;
}

export function shippingTotal(order: ShopifyOrder): number {
  return round2((order.shipping_lines ?? []).reduce((s, l) => s + (parseMoney(l.discounted_price ?? l.price) ?? 0), 0));
}
