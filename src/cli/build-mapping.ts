// `npm run build-mapping`: read-only on both sides. Pre-fills MAPPING_FILE (Shopify SKU -> Jewely ref) by matching the
// Jewely model name with the Shopify product title, and the metal of the ref (WG/YG/PG) with the "Couleur" option.
// Rows marked `manuel` in the existing file are kept as they are. Review `conflit` / `introuvable` rows by hand:
// fill in the SKU and/or ref and set the status to `manuel`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { JewelyClient } from '../jewely/client.ts';
import type { ErpProduct } from '../jewely/types.ts';
import { ShopifyClient } from '../shopify/client.ts';
import { buildMapping, parseCsv, toCsv } from '../sync/sku-map.ts';

// Placeholders so the command can run before these IDs are known.
for (const k of ['JEWELY_WEB_SALE_POINT_ID', 'JEWELY_OPERATOR_ID']) process.env[k] ||= '0';
process.env.JEWELY_WEBHOOK_URL_TOKEN ||= 'unset';
process.env.ADMIN_TOKEN ||= 'unset';
process.env.SHOPIFY_LOCATION_ID ||= 'unset';

const cfg = loadConfig();
const jewely = new JewelyClient(cfg.jewely, true);
const shopify = new ShopifyClient(cfg.shopify, true);

const keep = existsSync(cfg.mappingFile) ? parseCsv(readFileSync(cfg.mappingFile, 'utf8')) : [];
const [erpProducts, variants] = await Promise.all([
  jewely.listAll<ErpProduct>('/products', { perPage: 200 }),
  shopify.catalogVariants(),
]);
const rows = buildMapping(erpProducts, variants, keep);
writeFileSync(cfg.mappingFile, toCsv(rows));

const count = (s: string) => rows.filter((r) => r.status === s).length;
const refs = (s: string) => new Set(rows.filter((r) => r.status === s).map((r) => r.ref)).size;
console.log(`${erpProducts.length} Jewely products, ${variants.length} Shopify variants -> ${cfg.mappingFile}`);
console.log(`  auto        ${refs('auto')} refs (${count('auto')} SKUs)`);
console.log(`  manuel      ${refs('manuel')} refs (${count('manuel')} SKUs, kept from the previous file)`);
console.log(`  conflit     ${refs('conflit')} refs  <- to check by hand`);
console.log(`  introuvable ${refs('introuvable')} refs  <- no Shopify product with that name/metal`);
for (const r of rows.filter((x) => x.status === 'conflit' || x.status === 'introuvable')) {
  console.log(`    ${r.status.padEnd(11)} ${r.ref.padEnd(16)} ${r.erpModel}${r.variant ? `  (${r.variant})` : ''}`);
}
