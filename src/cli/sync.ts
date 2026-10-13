// `npm run sync -- <ref>` : syncs one product now (force).
// `npm run sync -- --all` : full reconciliation of the web catalogue.
// Set DRY_RUN=true to see the planned changes without writing anything.
import { createApp } from '../app.ts';

const app = createApp();
const args = process.argv.slice(2);
if (!app.cfg.sync.products) {
  console.error('SYNC_PRODUCTS=false: the catalogue sync is disabled (set SYNC_PRODUCTS=true to use this command).');
  process.exit(1);
}

if (args.includes('--all')) {
  app.queue.enqueue('erp.full_sync', {}, { dedupeKey: 'erp.full_sync' });
} else if (args[0]) {
  app.queue.enqueue('product.sync', { ref: args[0], force: true }, { dedupeKey: `product:${args[0]}` });
} else {
  console.error('Usage: npm run sync -- <ref> | --all');
  process.exit(1);
}
await app.queue.drain();
console.log('Jobs:', app.queue.stats());
