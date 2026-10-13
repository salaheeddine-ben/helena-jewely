// End-to-end flow tests with in-memory fakes for Jewely and Shopify.
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { getOrderLink, heldStockEntryIds, openMemoryDb } from '../src/db.ts';
import { Queue } from '../src/queue.ts';
import { buildSaleBody, handleCancelledOrder, importOrder, type ShopifyOrder, sizeFromVariantTitle } from '../src/sync/orders.ts';
import { syncProduct } from '../src/sync/products.ts';
import type { ErpProduct, ErpStockEntry } from '../src/jewely/types.ts';
import { entry, product, testConfig } from './fixtures.ts';

function fakeJewely(products: ErpProduct[], entries: ErpStockEntry[], customers: Record<string, number> = {}) {
  const calls: { method: string; body: any }[] = [];
  let nextId = 1000;
  const write = (method: string) => async (body: any) => { calls.push({ method, body }); return { data: { id: nextId++ } }; };
  return {
    calls,
    findProductByRef: async (ref: string) => products.find((p) => p.ref === ref),
    stockEntriesByRef: async (ref: string) => entries.filter((e) => e.product?.ref === ref),
    findCustomerByEmail: async (email: string) => (customers[email] ? { type: 'contact' as const, id: customers[email] } : undefined),
    countryIdByIso2: async (iso: string) => (iso === 'FR' ? 75 : null),
    createContact: write('createContact'),
    createSale: write('createSale'),
    createOrder: write('createOrder'),
    createPayment: write('createPayment'),
    notify: write('notify'),
  };
}

function order(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 5001, admin_graphql_api_id: 'gid://shopify/Order/5001', name: '#1001', email: 'claire@example.com',
    processed_at: '2026-10-10T09:00:00+02:00', currency: 'EUR', total_price: '1209.90', buyer_accepts_marketing: true,
    billing_address: { first_name: 'Claire', last_name: 'Martin', address1: '1 rue de la Paix', city: 'Paris', zip: '75002', country_code: 'FR', phone: '+33600000000' },
    line_items: [{ id: 1, sku: 'BAG-001', title: 'Bague', variant_title: 'Or jaune / 52', quantity: 1, price: '1250.00', discount_allocations: [{ amount: '50.00' }] }],
    shipping_lines: [{ title: 'Colissimo', price: '9.90' }],
    ...over,
  };
}

const fakeShopify = () => ({ tags: [] as string[][], addOrderTags: async function (_id: string, t: string[]) { this.tags.push(t); } });

test('stock_first: paid order -> new contact, on_hold sale with the right piece (size from the variant), discount, deposit, hold, tags', async () => {
  const cfg = testConfig({ orderMode: 'stock_first' });
  const db = openMemoryDb();
  const queue = new Queue(db);
  const jewely = fakeJewely([product()], [
    entry(1, { size: '52', salePointId: 1, priceTtc: '1250' }),
    entry(2, { size: '54', salePointId: 2 }),
  ]);
  const shopify = fakeShopify();

  await importOrder({ cfg, db, jewely: jewely as any, shopify: shopify as any, queue }, order());

  const contact = jewely.calls.find((c) => c.method === 'createContact')!.body;
  assert.equal(contact.name, 'Martin');
  assert.equal(contact.surname, 'Claire');
  assert.equal(contact.address.countryId, 75);
  assert.equal(contact.acceptProspecting, true);

  const sale = jewely.calls.find((c) => c.method === 'createSale')!.body;
  assert.equal(sale.externalId, 'shopify-5001');
  assert.equal(sale.status, 'on_hold');
  assert.equal(sale.salePointId, 2);
  assert.deepEqual(sale.customer, { type: 'contact', id: 1000 });
  assert.deepEqual(sale.operatorsIds, [7]);
  assert.deepEqual(sale.stocksRemovals, [{ stockEntryId: 1, priceTtc: 1250, discountTtc: 50 }]);
  assert.equal(sale.autoTransferStock, true, 'the piece is in another sale point');
  assert.equal(sale.salesProvisions, undefined, 'the API only accepts whole amounts for provisions: 9.90 is left to the shop');
  assert.equal(contact.phonesNumbers.length, 2, 'the API requires exactly two phone entries');
  assert.deepEqual(contact.phonesNumbers.map((p: { type: string }) => p.type), ['mobile', 'desk']);

  const payment = jewely.calls.find((c) => c.method === 'createPayment')!.body;
  assert.equal(payment.value, 1209.9);
  assert.equal(payment.isDeposit, true);
  assert.equal(payment.optionId, 5);
  assert.equal(payment.ref, '#1001');

  assert.ok(jewely.calls.some((c) => c.method === 'notify'));
  assert.equal(jewely.calls.some((c) => c.method === 'createOrder'), false);
  assert.deepEqual([...heldStockEntryIds(db)], [1]);
  assert.equal(getOrderLink(db, '5001')!.status, 'synced');
  assert.deepEqual(shopify.tags[0], ['jewely-sync', 'jewely-vente-1001']);
});

test('the webhook arrives again: nothing is created twice', async () => {
  const cfg = testConfig({ orderMode: 'stock_first' });
  const db = openMemoryDb();
  const queue = new Queue(db);
  const jewely = fakeJewely([product()], [entry(1, { size: '52' })], { 'claire@example.com': 42 });
  const deps = { cfg, db, jewely: jewely as any, shopify: fakeShopify() as any, queue };
  await importOrder(deps, order());
  const n = jewely.calls.length;
  await importOrder(deps, order());
  assert.equal(jewely.calls.length, n);
  assert.equal(jewely.calls.some((c) => c.method === 'createContact'), false, 'existing customer reused');
});

test('stock_first: out of stock -> customer order (commande client) with HT price, and the deposit is linked to it', async () => {
  const cfg = testConfig({ orderMode: 'stock_first' });
  const db = openMemoryDb();
  const jewely = fakeJewely([product()], [entry(1, { size: '52', isAvailable: false })], { 'claire@example.com': 42 });
  await importOrder({ cfg, db, jewely: jewely as any, shopify: fakeShopify() as any, queue: new Queue(db) }, order({ total_price: '1200.00', shipping_lines: [] }));

  assert.equal(jewely.calls.some((c) => c.method === 'createSale'), false);
  const o = jewely.calls.find((c) => c.method === 'createOrder')!.body;
  assert.equal(o.type, 'customer_command');
  assert.equal(o.externalId, 'shopify-5001-commande');
  assert.deepEqual(o.orderEntries, [{ product: { id: 100 }, orderProducts: [{ priceHt: 1000 }] }]);
  const payment = jewely.calls.find((c) => c.method === 'createPayment')!.body;
  assert.equal(payment.orderId, 1000);
});

test('unknown SKU -> nothing fails: customer + deposit recorded, the line is listed for the shop, order tagged', async () => {
  const cfg = testConfig();
  const db = openMemoryDb();
  const jewely = fakeJewely([], [], { 'claire@example.com': 42 });
  const shopify = fakeShopify();
  await importOrder({ cfg, db, jewely: jewely as any, shopify: shopify as any, queue: new Queue(db) }, order());

  assert.equal(getOrderLink(db, '5001')!.status, 'partial');
  assert.equal(jewely.calls.some((c) => c.method === 'createOrder' || c.method === 'createSale'), false);
  const payment = jewely.calls.find((c) => c.method === 'createPayment')!.body;
  assert.equal(payment.orderId, null);
  const n = jewely.calls.find((c) => c.method === 'notify')!.body;
  assert.match(n.name, /à saisir/);
  assert.match(n.description, /Bague \(Or jaune \/ 52\) × 1, 1250\.00 € : SKU BAG-001 absent du mapping/);
  assert.match(n.description, /Livraison : 9\.90 €/);
  assert.deepEqual(shopify.tags[0], ['jewely-sync', 'jewely-a-saisir']);
});

test('customer_order (default): SKUs go through mapping.csv, the colour picks the ref, one commande client for the mapped lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hj-map-'));
  const mappingFile = join(dir, 'mapping.csv');
  writeFileSync(mappingFile, [
    'shopify_sku;jewely_ref;statut;produit_shopify;variante;modele_jewely',
    'CHOAMSHINEDT;HJNASWG1001;auto;Choker Amanda Shine;Or blanc;Choker Amanda Shine',
    'CHOAMSHINEDT;HJNASYG1001;auto;Choker Amanda Shine;Or jaune;Choker Amanda Shine',
  ].join('\n'));
  const cfg = { ...testConfig(), mappingFile };
  const db = openMemoryDb();
  const queue = new Queue(db);
  const jewely = fakeJewely(
    [product({ id: 11, ref: 'HJNASWG1001' }), product({ id: 12, ref: 'HJNASYG1001' })],
    [entry(1, { product: { ref: 'HJNASYG1001' } })], // a piece in stock is NOT taken in this mode
    { 'claire@example.com': 42 },
  );
  await importOrder({ cfg, db, jewely: jewely as any, shopify: fakeShopify() as any, queue }, order({
    total_price: '2400.00', shipping_lines: [],
    line_items: [
      { id: 1, sku: 'CHOAMSHINEDT', title: 'Choker Amanda Shine', variant_title: 'Or jaune / S/M', quantity: 1, price: '1200.00' },
      { id: 2, sku: 'CHOAMSHINEDT', title: 'Choker Amanda Shine', variant_title: 'Or blanc / XS', quantity: 1, price: '1200.00' },
    ],
  }));

  assert.equal(jewely.calls.some((c) => c.method === 'createSale'), false);
  const o = jewely.calls.find((c) => c.method === 'createOrder')!.body;
  assert.deepEqual(o.orderEntries.map((e: any) => e.product.id), [12, 11]);
  assert.deepEqual(o.orderEntries[0].orderProducts, [{ priceHt: 1000 }]);
  assert.equal(jewely.calls.find((c) => c.method === 'createPayment')!.body.orderId, 1000);
  assert.match(jewely.calls.find((c) => c.method === 'notify')!.body.description, /Choker Amanda Shine \(Or jaune \/ S\/M\) × 1 \(réf\. HJNASYG1001\)/);
  assert.equal(getOrderLink(db, '5001')!.status, 'synced');
  assert.equal(queue.stats().pending, 2, 'stock re-sync queued (one per ref) only because the test config has SYNC_PRODUCTS=true');
});

test('sizeFromVariantTitle keeps the option value that exists as a piece size', () => {
  const entries = [entry(1, { size: '52' }), entry(2, { size: '54' })];
  assert.equal(sizeFromVariantTitle('Or blanc / 52', entries), '52');
  assert.equal(sizeFromVariantTitle('Or blanc / 50', entries), null);
  assert.equal(sizeFromVariantTitle('Or blanc', [entry(3)]), null);
});

test('a line with quantity 3 spreads the discount so the total matches to the cent', () => {
  const cfg = testConfig();
  const o = order({ line_items: [{ id: 1, sku: 'BAG-001', title: 'x', quantity: 3, price: '100.00', discount_allocations: [{ amount: '10.00' }] }] });
  const body = buildSaleBody(o, [{ line: o.line_items[0], picked: [entry(1), entry(2), entry(3)] }], { type: 'contact', id: 1 }, cfg);
  const discounts = body.stocksRemovals.map((r) => r.discountTtc);
  assert.deepEqual(discounts, [3.33, 3.33, 3.34]);
  assert.equal(body.autoTransferStock, false);
});

test('cancellation releases the holds and notifies the shop', async () => {
  const cfg = testConfig({ orderMode: 'stock_first' });
  const db = openMemoryDb();
  const queue = new Queue(db);
  const jewely = fakeJewely([product()], [entry(1, { size: '52' })], { 'claire@example.com': 42 });
  const deps = { cfg, db, jewely: jewely as any, shopify: fakeShopify() as any, queue };
  await importOrder(deps, order());
  assert.equal(heldStockEntryIds(db).size, 1);
  await handleCancelledOrder(deps, order());
  assert.equal(heldStockEntryIds(db).size, 0);
  assert.equal(getOrderLink(db, '5001')!.status, 'cancelled');
  assert.match(jewely.calls.at(-1)!.body.description, /Vente #1000/);
});

// ---------- ERP -> Shopify ----------

function fakeShopifyCatalog(variants: any[], status = 'ACTIVE') {
  const calls: { name: string; args: any }[] = [];
  return {
    calls,
    variantsBySkus: async (skus: string[]) => new Map(variants.filter((v) => skus.includes(v.sku)).map((v) => [v.sku, v])),
    productWithVariants: async (id: string) => ({ id, status, options: [{ id: 'o', name: 'Taille', values: [] }], variants }),
    updateVariantPrices: async (_p: string, v: any[]) => { if (v.length) calls.push({ name: 'price', args: v }); },
    setAvailable: async (items: any[]) => { if (items.length) calls.push({ name: 'stock', args: items }); },
    createVariants: async (_p: string, v: any[]) => { calls.push({ name: 'createVariants', args: v }); },
    setProductStatus: async (_p: string, s: string) => { calls.push({ name: 'status', args: s }); },
    createProduct: async (input: any) => { calls.push({ name: 'create', args: input }); return 'gid://shopify/Product/9'; },
  };
}

const variant = (sku: string, available: number, price = '1250.00') => ({
  id: `gid://shopify/ProductVariant/${sku}`, sku, price, productId: 'gid://shopify/Product/1', productStatus: 'ACTIVE',
  inventoryItemId: `gid://shopify/InventoryItem/${sku}`, tracked: true, available, selectedOptions: [],
});

test('product sync: updates stock and price, adds a new size, and skips when nothing changed', async () => {
  const cfg = testConfig();
  const db = openMemoryDb();
  const jewely = fakeJewely([product({ priceTtc: '1300.00' })], [
    entry(1, { size: '52', priceTtc: '1300.00' }), entry(2, { size: '52', priceTtc: '1300.00' }), entry(3, { size: '56', priceTtc: '1300.00' }),
  ]);
  const shopify = fakeShopifyCatalog([variant('BAG-001/52', 1), variant('BAG-001/54', 2)]);
  const deps = { cfg, db, jewely: jewely as any, shopify: shopify as any };

  assert.equal(await syncProduct(deps, 'BAG-001'), 'updated');
  const stock = shopify.calls.find((c) => c.name === 'stock')!.args;
  assert.deepEqual(stock.map((s: any) => [s.inventoryItemId.replace('gid://shopify/InventoryItem/', ''), s.quantity, s.changeFromQuantity]), [
    ['BAG-001/52', 2, 1],
    ['BAG-001/54', 0, 2], // size no longer in the ERP: set to 0, not deleted
  ]);
  assert.equal(shopify.calls.find((c) => c.name === 'price')!.args[0].price, '1300.00');
  assert.equal(shopify.calls.find((c) => c.name === 'createVariants')!.args[0].inventoryItem.sku, 'BAG-001/56');

  shopify.calls.length = 0;
  assert.equal(await syncProduct(deps, 'BAG-001'), 'unchanged');
  assert.equal(shopify.calls.length, 0);
});

test('product sync: showOnWebsite=false hides the product (DRAFT) and re-activates only what it hid', async () => {
  const cfg = testConfig();
  const db = openMemoryDb();
  const shopify = fakeShopifyCatalog([variant('BAG-001', 1)]);
  const hiddenJewely = fakeJewely([product({ showOnWebsite: false })], [entry(1)]);
  await syncProduct({ cfg, db, jewely: hiddenJewely as any, shopify: shopify as any }, 'BAG-001');
  assert.deepEqual(shopify.calls.find((c) => c.name === 'status')!.args, 'DRAFT');

  const draftShop = fakeShopifyCatalog([variant('BAG-001', 1)], 'DRAFT');
  await syncProduct({ cfg, db, jewely: fakeJewely([product()], [entry(1)]) as any, shopify: draftShop as any }, 'BAG-001');
  assert.deepEqual(draftShop.calls.find((c) => c.name === 'status')!.args, 'ACTIVE');
});

test('product sync: an unknown product visible on the web is created on Shopify as a DRAFT', async () => {
  const cfg = testConfig();
  const db = openMemoryDb();
  const shopify = fakeShopifyCatalog([]);
  const res = await syncProduct({ cfg, db, jewely: fakeJewely([product()], [entry(1)]) as any, shopify: shopify as any }, 'BAG-001');
  assert.equal(res, 'created');
  assert.equal(shopify.calls[0].args.status, 'DRAFT');
});

test('queue: dedupes pending jobs, retries with backoff, sends permanent errors straight to dead', async () => {
  const db = openMemoryDb();
  const dead: string[] = [];
  const q = new Queue(db, async (job) => { dead.push(job.type); });
  let runs = 0;
  q.on('product.sync', async () => { runs++; throw new Error('boom'); });
  q.on('erp.poll', async () => { const e: any = new Error('bad data'); e.permanent = true; throw e; });

  q.enqueue('product.sync', { ref: 'A' }, { dedupeKey: 'product:A' });
  q.enqueue('product.sync', { ref: 'A' }, { dedupeKey: 'product:A' });
  q.enqueue('erp.poll', {});
  await q.drain();
  assert.equal(runs, 1, 'deduplicated, and the retry is scheduled in the future');
  assert.equal(q.stats().pending, 1);
  assert.deepEqual(dead, ['erp.poll']);
});
