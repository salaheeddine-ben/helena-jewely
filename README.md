# Helena Joy: Shopify ↔ Jewely connector

Syncs the Helena Joy Shopify store with the Jewely (HBJO) ERP:

- **Shopify → ERP (on):** each paid web order is booked in Jewely. Lines linked to a Jewely product (through `mapping.csv`) become a customer order ("commande client"), the payment is recorded as a deposit, and lines whose product isn't in Jewely are listed in an ERP notification for the shop to enter by hand. Cancellations and refunds also send a notification.
- **ERP → Shopify (off, `SYNC_PRODUCTS=false`):** web stock, prices, visibility. Helena Joy's Shopify sells made to order with untracked stock and no Jewely product is "visible on website", so this stays off.

**Why a mapping file:** the two catalogues use different codes (Shopify `PUECGDTGM`, Jewely `HJEECWG1010`). `npm run build-mapping` links them by product name + metal (WG/YG/PG in the ref ↔ the "Couleur" option); the shop fixes the rest by hand in `mapping.csv` (status `manuel`). The connector re-reads the file when it changes.

Full analysis, flows, data mapping and points to validate: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Requirements
- Node **22.18+** (runs TypeScript natively, ships `node:sqlite`). No runtime dependencies.
- A server with a **fixed outgoing IP**, added to the Jewely API account's allowlist.

## Getting started
```bash
cp .env.example .env        # fill in the Jewely + Shopify credentials, keep DRY_RUN=true
npm install                 # dev dependencies only (typescript, @types/node)
npm run discover            # lists sale point / payment / employee / location ids
npm run build-mapping       # pre-fills mapping.csv (Shopify SKU -> Jewely ref); review the conflit / introuvable rows
npm start                   # server + queue
```

Production (Docker + automatic HTTPS):
```bash
CONNECTOR_DOMAIN=sync.helenajoy.example docker compose up -d --build
docker compose exec connector node --disable-warning=ExperimentalWarning src/cli/setup-webhooks.ts
```

## Commands
| Command | Purpose |
|---|---|
| `npm run discover` | Read-only: ids to configure, catalogue match, raw samples saved in `./samples/` |
| `npm run build-mapping` | Read-only on both sides: rebuilds `mapping.csv`, keeping the rows marked `manuel` |
| `npm run setup:webhooks` | Registers the 3 Shopify webhooks on `PUBLIC_URL` (+ the 4 Jewely webhooks when `SYNC_PRODUCTS=true`), idempotent |
| `npm run sync -- <ref>` / `-- --all` | Forced sync of one product / of the whole web catalogue (`SYNC_PRODUCTS=true` only) |
| `npm run test-order -- [--ref <ref>] [--write]` | One fake paid order through the real import, Jewely only (no Shopify). Dry run unless `--write`; point `JEWELY_BASE_URL` at the sandbox |
| `npm test` | Unit and flow tests (fake Jewely and Shopify clients) |
| `npm run typecheck` | `tsc --noEmit` |

## HTTP routes
| Route | Purpose |
|---|---|
| `GET /health` | Health check |
| `POST /webhooks/shopify` | `orders/paid`, `orders/cancelled`, `refunds/create` (HMAC checked) |
| `POST /webhooks/jewely/:type?token=…` | `stock-entry`, `stock-removal`, `update-price`, `product-visibility-change` |
| `GET /admin/status` | Queue, failed jobs, recent orders, holds (Bearer `ADMIN_TOKEN`) |
| `GET /admin/webhook-samples` | Latest raw Jewely payloads (the format isn't documented) |
| `POST /admin/sync[?ref=]` | Starts a sync (one product or everything) |
| `POST /admin/retry-dead` | Puts failed jobs back in the queue |

## mapping.csv
`;`-separated, opens in Excel. Columns: `shopify_sku;jewely_ref;statut;produit_shopify;variante;modele_jewely`.
- `auto`: guessed by `build-mapping` (overwritten on the next run). `manuel`: typed or corrected by hand (kept). `conflit` / `introuvable`: not used.
- One Shopify SKU can appear on several rows with different `variante` (colour) when Shopify reuses the SKU across colours; the order line's colour picks the ref.
- A Shopify SKU with no row is looked up as a Jewely ref directly.

## Layout
```
src/
  config.ts            env configuration
  db.ts                SQLite: queue, links, holds, cursors
  queue.ts             persistent queue (retries, backoff, dedupe)
  server.ts            webhooks + admin
  webhooks.ts          HMAC checks, ref extraction from Jewely payloads
  jewely/              REST client (auth, 2FA, pagination, retries) + types from the spec
  shopify/             Admin GraphQL 2026-10 client (client credentials, throttling)
  sync/sku-map.ts      Shopify SKU -> Jewely ref table (build, CSV, lookup by colour)
  sync/mapping.ts      pure rules: pieces → variants, stock, price, SKU, picking
  sync/products.ts     ERP → Shopify (+ poll and nightly reconciliation)
  sync/orders.ts       Shopify → ERP (sale, customer order, deposit, contact)
  cli/                 discover, setup-webhooks, sync
test/                  node:test
```
