// `npm run test-order -- [--ref <jewely ref>] [--write]`: pushes one fake paid Shopify order through the real
// order import, against the Jewely instance in JEWELY_BASE_URL (use the sandbox). Shopify is not called: only
// Jewely credentials and ids are needed. Without --write nothing is written (writes are only logged).
// The order has one line linked to Jewely (--ref, default: the first product of the catalogue), one line that is
// not in Jewely (it must show up as "à saisir" in the notification) and a 9.90 € shipping fee.
import { loadConfig } from '../config.ts';
import { getOrderLink, openMemoryDb } from '../db.ts';
import { JewelyClient } from '../jewely/client.ts';
import type { ErpProduct } from '../jewely/types.ts';
import type { Queue } from '../queue.ts';
import type { ShopifyClient } from '../shopify/client.ts';
import { importOrder, type ShopifyOrder } from '../sync/orders.ts';

const args = process.argv.slice(2);
const write = args.includes('--write');
const refArg = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : undefined;

// Shopify isn't used here: placeholders so the config loads with Jewely settings only.
process.env.SHOPIFY_SHOP ||= 'test.myshopify.com';
process.env.SHOPIFY_ADMIN_TOKEN ||= 'unused';
process.env.SHOPIFY_LOCATION_ID ||= 'unused';
process.env.JEWELY_WEBHOOK_URL_TOKEN ||= 'unset';
process.env.ADMIN_TOKEN ||= 'unset';

const base = loadConfig();
const cfg = { ...base, dryRun: !write, sync: { ...base.sync, products: false } };
const jewely = new JewelyClient(cfg.jewely, cfg.dryRun);

console.log(`Jewely: ${cfg.jewely.baseUrl}  mode=${cfg.jewely.orderMode}  ${write ? 'WRITE' : 'dry run (add --write to create the records)'}`);

let product: ErpProduct | undefined;
if (refArg) {
  product = await jewely.findProductByRef(refArg);
  if (!product) throw new Error(`Ref ${refArg} not found in this Jewely instance`);
} else {
  product = (await jewely.listAll<ErpProduct>('/products', { perPage: 5 }, 1))[0];
  if (!product) throw new Error('This Jewely instance has no product: pass --ref');
}
console.log(`Linked line: ${product.ref} (${product.model}), ${product.priceTtc} € TTC`);

const stamp = Date.now();
const price = Number(product.priceTtc ?? 0) || 100;
const shipping = 9.9;
const order: ShopifyOrder = {
  id: stamp, // unique, so every run is a new order for Jewely (externalId shopify-<id>)
  name: `#TEST-${String(stamp).slice(-6)}`,
  email: `test-connecteur+${stamp}@example.com`,
  processed_at: new Date().toISOString(),
  currency: 'EUR',
  total_price: (price + 50 + shipping).toFixed(2),
  buyer_accepts_marketing: false,
  note: 'Commande de test du connecteur Shopify, à supprimer',
  customer: { first_name: 'Test', last_name: 'Connecteur', phone: '+33600000000' },
  billing_address: { first_name: 'Test', last_name: 'Connecteur', address1: '15 Rue de Tunisie', city: 'Paris', zip: '75001', country_code: 'FR', phone: '+33600000000' },
  line_items: [
    { id: 1, sku: product.ref, title: product.model ?? product.ref, variant_title: null, quantity: 1, price: price.toFixed(2) },
    { id: 2, sku: 'TEST-NON-RELIE', title: 'Article non relié à Jewely', variant_title: 'Or jaune', quantity: 1, price: '50.00' },
  ],
  shipping_lines: [{ title: 'Colissimo', price: shipping.toFixed(2) }],
};

const db = openMemoryDb();
const shopify = { addOrderTags: async () => {} } as unknown as ShopifyClient;
await importOrder({ cfg, db, jewely, shopify, queue: {} as Queue }, order);

const link = getOrderLink(db, String(order.id));
console.log('\nResult:');
console.log(`  order       ${order.name} (externalId shopify-${order.id})`);
console.log(`  status      ${link?.status}`);
console.log(`  customer    ${link?.erp_customer_type} #${link?.erp_customer_id}`);
console.log(`  sale        ${link?.erp_sale_id ?? '-'}`);
console.log(`  commande    ${link?.erp_order_id ?? '-'}`);
console.log(`  deposit     ${link?.erp_payment_id ?? '-'}`);
if (link?.detail) console.log(`  to enter by hand:\n    ${link.detail.replace(/\n/g, '\n    ')}`);
if (write) console.log('\nCheck the contact, commande client, deposit and notification in Jewely, then delete them.');
