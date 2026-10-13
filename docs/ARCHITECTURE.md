# Shopify ↔ Jewely (HBJO) integration: analysis and architecture

> Client: **Helena Joy** (Shopify jewellery store) · ERP: **Jewely Retail** (jewely.fr) · Instance: `https://helena-joy-quhc2l.jewely.fr/api/v1`
> Main source: `Documentation Clé API Helena Joy.json` (OpenAPI 3.1, API **v1.2**: 66 paths, 95 operations, 65 schemas).

---

## 0. What the live instances showed (2026-10-12), and what changed

Checked with real credentials (Jewely static API token, Shopify Dev Dashboard app):

| | Jewely | Shopify |
|---|---|---|
| Catalogue | 98 products, 137 pieces, all `showOnWebsite=false` | 594 products, 8,212 variants, store not live yet (created 2026-06, no orders) |
| Codes | `HJEECWG1010` (type + collection + metal + number) | `PUECGDTGM` (own code); one SKU shared by every size / chain option |
| Stock | physical pieces | **not tracked**, sold made to order (`CONTINUE`) |

So the original design (SKU = ref, ERP stock drives Shopify) doesn't fit. Changes:
1. **Orders first.** `JEWELY_ORDER_MODE=customer_order`: mapped lines → one commande client, payment → deposit, unmapped lines → listed in the ERP notification ("à saisir"), order tagged `jewely-a-saisir` on Shopify. An unmapped line no longer fails the import. `stock_first` keeps the old sale-from-stock flow (ring size read from the variant title).
2. **`mapping.csv`** links SKUs to refs: same name + same metal (ref suffix WG/YG/PG, else the product's materials, e.g. silver prototypes ↔ "Argent 925"). First run: 77 of 98 refs linked, 21 to check by hand (mostly prototypes and products not on the site).
3. **Catalogue sync off** (`SYNC_PRODUCTS=false`): no poll, no nightly run, Jewely webhooks ignored and not registered. Turning it on as is would draft the products and push stock onto made-to-order items.
4. The real stock entries carry `isSellable` (honoured) and don't carry `isUnderRepair`, `isConfided`, `isInPendingSale`, `isSold` or `priceTtc`.

## 1. What the documentation tells us

### 1.1 The Jewely API
- **REST JSON with Bearer auth.** `POST /login` (`identifier` + `password`) returns a token. If the account has 2FA, it returns a `two_factor_token` instead, which is exchanged on `POST /login/two-factor-challenge` with a TOTP code.
- **Documented errors on login:**
  - `403 "API access not allowed"`: the account doesn't have the **Accès API** permission.
  - `403 "IP not allowed"`: there is an **IP allowlist** per account.
  - `403 "Account not active"`.
- **Pagination:** Laravel style (`data`, `links`, `meta.last_page`), with `page` / `perPage` (max 200 on `/products`).
- **Incremental filters:** `updatedAt` + `endUpdatedAt=now`, plus `orderBy=updated_at`. Available on `/products`, `/sales`, `/stocks-entries`, `/customers` and `/orders`.
- **The ERP is Laravel.** Signs: Spatie role names in `/notifications`, Laravel paginator, Scramble-generated documentation. This matters for the webhook signature (§7).

### 1.2 Endpoints used by the integration

| Need | Endpoint | Notes |
|---|---|---|
| Catalogue | `GET /products?ref=&updatedAt=` | `showOnWebsite`, `priceTtc`, `quantity`, `brand`, `categoryName`, `images`, `materials`, `stones` |
| Physical stock | `GET /stocks-entries?ref=&id=&updatedAt=` | **one entry = one physical piece**: `size`, `salePointId`, `priceTtc`, `isAvailable`, `isReserved`, `isUnderRepair`, `isConfided`, `transferId` |
| Web sale | `POST /sales` | **"Crée une vente depuis une source externe (e-commerce…)", idempotent on `externalId`**; `status` `on_hold` (draft) or `processed`; `stocksRemovals[]`, `salesProvisions[]`, `autoTransferStock` |
| Customer order | `POST /orders` | `type: customer_command`, `externalId`, `date` = "**Shopify processedAt**" |
| Deposit | `POST /payments` | `isDeposit`, `orderId` ("**N8n l'envoie sur les acomptes de commandes synchronisées depuis Shopify**") |
| Customers | `GET /customers?email=`, `POST /contacts` | contact = individual, company = business |
| Countries | `GET /countries?codeIso2=` | country ids for addresses |
| Setup | `GET /sales-points`, `GET /payment-options`, `GET /employees` | ids to configure |
| Outgoing webhooks | `GET/POST/PUT /webhooks`, `rotate-secret` | events `stock-entry`, `stock-removal`, `update-price`, `product-visibility-change`; "**POST signé HMAC**" |
| Alerts | `POST /notifications` | in-ERP notification, `userTrigger` (e.g. "**n8n-shopify**"), `type: integration` |

Everything else (repairs/SAV, police book, quotes, purchases, buybacks, HBJO taxation…) stays inside the ERP and is not part of the web flow.

---

## 2. How other Jewely clients do it

The spec contains the traces of an **existing Shopify integration for another tenant**:

- `POST /orders.brand`: "*brand fournie par **n8n** (mapping vendor **Shopify** → brand ERP). **Sophie d'Agon** mono-marque…, on garde la clé générique pour supporter d'autres tenants multi-marques.*"
- `POST /orders.date`: "*Date de la commande côté source (**Shopify processedAt**)*".
- `POST /orders.supplier`: "*une commande client venant d'un **webhook e-commerce** n'a pas de fournisseur connu…*".
- `POST /payments.orderId`: "*N8n l'envoie sur les acomptes de commandes synchronisées depuis Shopify*"; `exchangeRate`: "*Taux réellement appliqué par la source (Shopify)*".
- `POST /notifications.userTrigger`: example "`n8n-shopify`".
- Webhooks tag: "*Webhooks sortants vers les intégrations (n8n, etc.)*".

On the marketing side, Jewely sells a Shopify connection ("synchronize your products, stocks, orders and customers in real time"). Capterra lists Shopify, WooCommerce and Pennylane integrations.

**Conclusion:** the existing Jewely ↔ Shopify setup is **middleware (n8n) between Shopify webhooks and the Jewely REST API**, with Jewely's outgoing webhooks for stock and prices. For Sophie d'Agon (made-to-order pieces), web orders become **customer orders + deposits**. For Helena Joy (pieces in stock), the right flow is **`POST /sales`**, which was designed for "external e-commerce sources", with customer orders kept as a fallback for out-of-stock items.

---

## 3. Target architecture

```
           ┌─────────────────────────── Jewely ERP (source of truth: catalogue / stock / price) ───────────────────────────┐
           │  webhooks: stock-entry · stock-removal · update-price · product-visibility-change (HMAC + URL token)           │
           └───────────────┬──────────────────────────────────────────────────────────────▲─────────────────────────────┘
                           │ (1) event                                                     │ (4) POST /sales, /orders,
                           ▼                                                               │     /payments, /contacts,
┌────────────────────────────────────────── Helena–Jewely connector (Node 22, this repo) ──┴───────────────────────────┐
│  HTTP: /webhooks/jewely/:type · /webhooks/shopify · /admin/*                                                          │
│  SQLite queue (retries, backoff, dedupe) · links ref↔product, order↔sale · stock holds · sync cursor              │
│  Scheduler: incremental poll every 10 min (safety net) + full reconciliation at 03:00                               │
└───────────────┬──────────────────────────────────────────────────────────────▲───────────────────────────────────────┘
                │ (2) Admin GraphQL 2026-10: inventorySetQuantities,           │ (3) webhooks orders/paid,
                │     productVariantsBulkUpdate, productSet (DRAFT), status    │     orders/cancelled, refunds/create (HMAC)
                ▼                                                              │
           ┌─────────────────────────── Shopify (source of truth: web orders / web customers) ─────────────────────────┐
           └──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Who owns which data

| Data | Master | Direction | Trigger |
|---|---|---|---|
| Product (ref, title, brand, category, images) | **Jewely** | ERP → Shopify | creation only, as **DRAFT** (the merchant polishes the product page) |
| Price TTC | **Jewely** | ERP → Shopify | webhook `update-price` + poll |
| Web stock | **Jewely** | ERP → Shopify | webhooks `stock-entry` / `stock-removal` + poll + nightly |
| Website visibility | **Jewely** (`showOnWebsite`) | ERP → Shopify | webhook `product-visibility-change` |
| Web orders | **Shopify** | Shopify → ERP | `orders/paid` |
| Web customers | **Shopify** | Shopify → ERP (on demand) | created when the first order comes in |
| Cancellation / refund | Shopify | Shopify → ERP **notification** | the API has no endpoint to cancel a sale or create a credit note: the shop does it in Jewely |

**Why not two-way sync on products?** Jewellery is unique pieces (serial numbers, sizes, HBJO certificates and taxation, police book). The ERP is the legal and accounting record. If Shopify could edit catalogue data, the two systems would drift.

### 3.2 Model mapping (the core point)

- Jewely: **1 product (ref) → N stock entries** (one per **physical piece**, each with a size, sale point and price).
- Shopify: **1 product → variants (SKU) → quantity per location**.
- **Rule:**
  - Variant SKU = **ERP ref** for products without sizes.
  - Variant SKU = **`ref/size`** for rings and other sized items. The separator is configurable.
  - Quantity = the number of pieces that can be sold online: `isAvailable` and not reserved, under repair, confided, in transfer, or already held for a web order. Only the configured sale points count.
  - Price = the cheapest available piece for that size, falling back to the product's `priceTtc`.
- A sold-out size keeps its variant at 0. A size the ERP no longer knows is set to 0, never deleted.

### 3.3 Web order flow (`orders/paid`)
1. HMAC check → webhook-id dedupe → job queued → `200` answered in under 5 s.
2. **Customer:** `GET /customers?email=`, otherwise `POST /contacts` (name, address, ISO country → `countryId`, phone, marketing consent).
3. **Each line:**
   1. SKU → ref (+ size).
   2. `GET /stocks-entries?ref=`.
   3. Pick the pieces. The web sale point comes first, then the cheapest piece.
4. **`POST /sales`**:
   - `externalId = shopify-<id>`, which makes the call **idempotent**.
   - `status = on_hold` (default): the shop finalises the sale and issues the invoice.
   - One `stocksRemovals` per piece, with the discount spread to the cent.
   - Shipping goes in as a `salesProvision` called "Livraison".
   - `autoTransferStock = true` when the piece sits in a physical shop.
5. **Pieces out of stock or made to order:** `POST /orders` (`customer_command`, HT price), the same pattern as Sophie d'Agon.
6. **Payment:** `POST /payments` as a deposit (`isDeposit`) on the customer, linked to the customer order if there is one. The shop uses it to settle the sale.
7. **ERP notification** to the configured roles. The Shopify order gets the tags `jewely-sync` and `jewely-vente-<id>`.
8. The pieces are put **on hold** locally until the ERP no longer lists them as available. This prevents selling the same piece twice while the sale is still `on_hold`.

### 3.4 Reliability
- **Idempotency everywhere:**
  - `externalId` on sales.
  - An `order_links` table so a retry never repeats a step that already succeeded (contact, sale, customer order, deposit).
  - Shopify webhooks deduplicated on `X-Shopify-Event-Id`.
  - Shopify stock updates use `@idempotent` + compare-and-swap (`changeFromQuantity`).
- **Persistent queue:** exponential backoff (30 s → 1 h, 8 attempts). After that the job is marked `dead` and an ERP notification goes out.
  - 422/404/400 errors are treated as permanent: no pointless retries.
- **Three layers of change detection:**
  1. Jewely webhooks (real time).
  2. Incremental poll every 10 min on `/products`, `/stocks-entries` and `/sales` (`updatedAt`), with a 5 min overlap.
  3. **Nightly full reconciliation** with force.
- **Hash** of the target state per product: no Shopify call when nothing changed.
- **`DRY_RUN`:** reads are real and writes are only logged. Use it to validate before go-live.

---

## 4. Security
- Jewely account dedicated to the API, with a role limited to the permissions it needs (products, stock, sales, orders, payments, customers, webhooks, notifications) plus **Accès API**. Ideally no 2FA; if it has 2FA, a TOTP secret is supported.
- **IP allowlist:** the connector must run on a server with a **fixed outgoing IP**, and that IP must be added in Jewely. Serverless platforms (Vercel, Netlify functions) are not suitable.
- Shopify webhooks: HMAC-SHA256 on the raw body. Jewely webhooks: a secret URL token (which we control) **or** the HMAC signature.
- `/admin/*` is protected by a Bearer token. Secrets live in `.env` only. Customer personal data is not stored locally (only IDs).

## 5. Hosting
A small VPS in the EU (OVH, Scaleway, Hetzner…) with a fixed IP, running Docker Compose (connector + Caddy for HTTPS). The SQLite database sits on a volume. Load is tiny: a few hundred API calls a day.

**Why code and not n8n?** Jewely uses n8n for its other tenant, and that is a valid option. We chose a typed, tested service because:
- the stock rule (pieces → variants by size, holds) and the idempotency need real logic and unit tests;
- it has no dependency on an n8n instance;
- it is versioned in git.

The trade-off: n8n would let a non-developer edit the flows.

---

## 6. Points to validate with Jewely and on the instance (before go-live)

`npm run discover` saves the real responses in `./samples/` so you can check each point:

1. **Login token:** the field name in the `/login` response. The spec types it as `PermissionResource[]`, which is clearly wrong. The client tries `token`, `access_token` and `plainTextToken`. Or ask Jewely for a static token.
2. **Webhook signature:** header name and format. We assume Spatie (`Signature` = hex HMAC-SHA256). The URL token works either way.
3. **Webhook payload:** not documented. The connector pulls `ref` / stock entry ids out of the body, falls back to polling otherwise, and keeps samples (`GET /admin/webhook-samples`).
4. **`POST /contacts`:** `name` = last name and `surname` = first name? To be confirmed with a test contact.
5. **Amounts:** euros as decimals (assumed) or cents? `salesProvisions[].priceTtc` is typed `integer` in the spec, so the connector only sends whole shipping amounts (e.g. 10 €); a 9.90 € shipping fee is left out of the sale and the shop is told to add it. Ask Jewely whether decimals are accepted.
6. **`on_hold` sale:** stock entries have an `isInPendingSale` flag (and `isSold`). The connector treats those pieces as not sellable online, and drops its local hold once the ERP sets one of them.
7. **`updatedAt` format** accepted by the filters (we send `YYYY-MM-DD HH:mm:ss`, Paris time).
8. **Does a stock movement change the product's `updatedAt`?** If not, polling `/stocks-entries` and `/sales` covers it.
9. **Sale point and operator:** is there a "Boutique Web" sale point and an "e-shop" employee? Otherwise, create them.
10. **Payment option** for "Shopify / CB web": create it in Jewely if it doesn't exist.
11. **Standard VAT rate:** `POST /sales` returns HTTP 500 "TVA standard introuvable (sluggy_name=taux-normal)" if the instance has no VAT rate with slug `taux-normal`. Check on the first test sale.

## 7. Go-live checklist
1. Jewely: API account + role + **server IP** in the allowlist; "Boutique Web" sale point, "Site web" operator and "Shopify" payment option.
2. Shopify: app (Dev Dashboard) with scopes `read_products, write_products, read_inventory, write_inventory, read_orders, write_orders, read_locations`. Also request **protected customer data** access (name, email, phone, address) in the app's settings, otherwise order webhooks arrive without the customer's details. The app must be in the same Shopify organization as the store for the client credentials grant to work.
3. `.env` filled in (`npm run discover` gives the ids). `DRY_RUN=true`.
4. `npm run discover`: check the SKU ↔ ref match rate and fix the SKUs on Shopify (or in the ERP) until it is close to 100 %. Only then set `SHOPIFY_CREATE_PRODUCTS=true`, if you want it (otherwise unmatched ERP products would be created as duplicate drafts).
5. `npm run sync -- <ref>` on a few products, read the logs (planned changes).
6. `DRY_RUN=false`, then `npm run setup:webhooks`.
7. Test order on Shopify (test product, discount code, shipping) → check the sale, contact, deposit and notification in Jewely.
8. `POST /admin/sync` (full) once, then let the scheduler run.
