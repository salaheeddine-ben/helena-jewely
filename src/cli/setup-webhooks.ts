// `npm run setup:webhooks`: registers (or updates) the webhooks on both sides so they point at PUBLIC_URL.
// Idempotent. Honours DRY_RUN (prints what it would do).
import { createApp } from '../app.ts';
import { extractId } from '../jewely/client.ts';
import { WEBHOOK_TYPES } from '../jewely/types.ts';
import { unwrap } from '../lib/util.ts';

const app = createApp();
const { cfg, db, jewely, shopify } = app;

if (!cfg.publicUrl.startsWith('https://')) {
  console.error(`PUBLIC_URL must be a public https URL (got ${cfg.publicUrl})`);
  process.exit(1);
}

// --- Jewely -> connector (4 event types), only needed for the catalogue sync
const existing = cfg.sync.products ? await jewely.listWebhooks() : [];
if (!cfg.sync.products) console.log('Jewely webhooks: skipped (SYNC_PRODUCTS=false)');
for (const type of cfg.sync.products ? WEBHOOK_TYPES : []) {
  const endpoint = `${cfg.publicUrl}/webhooks/jewely/${type}?token=${encodeURIComponent(cfg.jewely.webhookUrlToken)}`;
  const body = { name: `Shopify Helena Joy (${type})`, type, endpoint, method: 'POST' as const };
  const current = existing.find((h) => h.type === type && h.endpoint.startsWith(`${cfg.publicUrl}/webhooks/jewely/`));
  const res = current ? await jewely.updateWebhook(current.id, body) : await jewely.createWebhook(body);
  const hook = unwrap<{ id?: number; secret?: string | null }>(res) ?? {};
  const id = extractId(res) ?? current?.id;
  if (id) {
    db.prepare(`INSERT INTO jewely_webhook_secrets(type, webhook_id, secret) VALUES(?, ?, ?)
                ON CONFLICT(type) DO UPDATE SET webhook_id = excluded.webhook_id, secret = COALESCE(excluded.secret, jewely_webhook_secrets.secret)`)
      .run(type, id, hook.secret ?? current?.secret ?? null);
  }
  console.log(`Jewely webhook ${type}: ${current ? 'updated' : 'created'} (#${id ?? '?'})`);
}

// --- Shopify -> connector
const uri = `${cfg.publicUrl}/webhooks/shopify`;
const subs = await shopify.webhookSubscriptions();
for (const topic of ['ORDERS_PAID', 'ORDERS_CANCELLED', 'REFUNDS_CREATE']) {
  if (subs.some((s) => s.topic === topic && s.uri === uri)) {
    console.log(`Shopify webhook ${topic}: already there`);
    continue;
  }
  await shopify.createWebhookSubscription(topic, uri);
  console.log(`Shopify webhook ${topic}: created`);
}
if (cfg.dryRun) console.log('\nDRY_RUN=true: nothing was written. Re-run with DRY_RUN=false.');
