// `npm run discover`: read-only. Lists the IDs to put in .env (sale points, payment methods, employees,
// Shopify locations) and measures the SKU <-> ref match between the two catalogues before go-live.
// Raw responses are saved to ./samples/ so the field-shape assumptions in docs/ARCHITECTURE.md can be checked.
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { JewelyClient } from '../jewely/client.ts';
import type { ErpProduct } from '../jewely/types.ts';
import { ShopifyClient } from '../shopify/client.ts';
import { unwrap } from '../lib/util.ts';

// Placeholders so discover can run before these IDs are known.
for (const k of ['JEWELY_WEB_SALE_POINT_ID', 'JEWELY_OPERATOR_ID']) process.env[k] ||= '0';
process.env.JEWELY_WEBHOOK_URL_TOKEN ||= 'unset';
process.env.ADMIN_TOKEN ||= 'unset';
process.env.SHOPIFY_LOCATION_ID ||= 'unset';

const cfg = loadConfig();
const jewely = new JewelyClient(cfg.jewely, true);
mkdirSync('samples', { recursive: true });
const save = (name: string, data: unknown) => writeFileSync(`samples/${name}.json`, JSON.stringify(data, null, 2));

async function section<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  console.log(`\n=== ${title} ===`);
  try {
    return await fn();
  } catch (err) {
    console.log(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

await section('Jewely: sale points (JEWELY_WEB_SALE_POINT_ID, JEWELY_STOCK_SALE_POINT_IDS)', async () => {
  const body = await jewely.get('/sales-points', { perPage: 100 });
  save('sales-points', body);
  for (const sp of unwrap<any[]>(body) ?? []) console.log(`  #${sp.id}  ${sp.name}  ${sp.websiteUrl ?? ''}`);
});

await section('Jewely: payment options (JEWELY_PAYMENT_OPTION_ID)', async () => {
  const body = await jewely.get('/payment-options');
  save('payment-options', body);
  for (const o of unwrap<any[]>(body) ?? []) console.log(`  #${o.id}  ${o.name}  (${o.sluggyName})`);
});

await section('Jewely: employees (JEWELY_OPERATOR_ID)', async () => {
  const body = await jewely.get('/employees', { perPage: 100 });
  save('employees', body);
  for (const e of unwrap<any[]>(body) ?? []) console.log(`  #${e.id}  ${[e.firstname ?? e.surname, e.name ?? e.lastname].filter(Boolean).join(' ') || JSON.stringify(e).slice(0, 80)}`);
});

await section('Jewely: existing webhooks', async () => {
  const hooks = await jewely.listWebhooks();
  save('webhooks', hooks);
  for (const h of hooks) console.log(`  #${h.id}  ${h.type}  ${h.method} ${h.endpoint}  active=${h.isActive}`);
  if (!hooks.length) console.log('  (none)');
});

const products = await section('Jewely: catalogue', async () => {
  const all = await jewely.listAll<ErpProduct>('/products', { perPage: 200 });
  save('products-first-3', all.slice(0, 3));
  const web = all.filter((p) => p.showOnWebsite);
  console.log(`  ${all.length} products, ${web.length} with showOnWebsite=true`);
  const sample = web[0] ?? all[0];
  if (sample) {
    const entries = await jewely.get('/stocks-entries', { ref: sample.ref, perPage: 20 });
    save('stock-entries-sample', entries);
    const customers = await jewely.get('/customers', { perPage: 2 });
    save('customers-sample', customers);
    console.log(`  samples saved for ref ${sample.ref} (samples/stock-entries-sample.json, customers-sample.json)`);
  }
  return all;
});

if (cfg.shopify.adminToken || cfg.shopify.clientId) {
  const shopify = new ShopifyClient(cfg.shopify, true);

  await section('Shopify: locations (SHOPIFY_LOCATION_ID)', async () => {
    for (const l of await shopify.locations()) console.log(`  ${l.id}  ${l.name}  ${l.isActive ? '' : '(inactive)'}`);
  });

  await section('Catalogue match: Shopify SKU <-> Jewely ref', async () => {
    const skus: string[] = [];
    let after: string | null = null;
    do {
      const data: any = await shopify.graphql(
        `query($after: String) { productVariants(first: 250, after: $after) { pageInfo { hasNextPage endCursor } nodes { sku } } }`,
        { after },
      );
      skus.push(...data.productVariants.nodes.map((n: any) => n.sku).filter(Boolean));
      after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
    } while (after);

    const refs = new Set((products ?? []).map((p) => p.ref));
    const sep = cfg.shopify.sizeSkuSeparator;
    const matched = skus.filter((s) => refs.has(s) || (s.includes(sep) && refs.has(s.slice(0, s.lastIndexOf(sep)))));
    const unmatched = skus.filter((s) => !matched.includes(s));
    console.log(`  ${skus.length} Shopify variants with a SKU, ${matched.length} match a Jewely ref, ${unmatched.length} do not`);
    if (unmatched.length) console.log(`  examples not matched: ${unmatched.slice(0, 15).join(', ')}`);
    save('sku-unmatched', unmatched);
  });
} else {
  console.log('\n(Shopify credentials not set: Shopify checks skipped)');
}

console.log('\nDone. Raw responses are in ./samples/');
