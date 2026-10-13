# Progress: Helena Joy Shopify ↔ Jewely connector

_Last updated: 2026-10-13_

## What was done

**Setup and access**
- Shopify app (Dev Dashboard, client credentials) connected to `helena-joy.myshopify.com`. Token and scopes verified.
- Jewely API access obtained (static API token). It works, and the development IP is accepted by the allowlist.
- Found the IDs: sale point `1` (Helena Joy) and Shopify location `15 Rue Tunisie`.

**What the live data showed (it changed the design)**
- **Jewely:** 98 products, 137 physical pieces. None is marked "visible on website". Refs look like `HJEECWG1010`.
- **Shopify:** 594 products and 8,212 variants. The stock is **not tracked**: everything is sold made to order. The SKUs use their own code (`PUECGDTGM`) and are shared across sizes and options. The store is **not live yet** (no orders).
- So none of the Shopify SKUs matches a Jewely ref, and pushing Jewely stock to Shopify would have hidden products and blocked sales.

**What was built / changed**
- **Orders first:** a paid web order goes into Jewely as:
  - the customer (found by email, or created);
  - a **commande client** for the products linked to Jewely;
  - the payment recorded as a **deposit**;
  - a **notification** listing the lines the shop must enter by hand.

  The Shopify order is tagged `jewely-sync`, plus `jewely-a-saisir` when lines need to be entered by hand.
- **`mapping.csv` (Shopify SKU → Jewely ref)**, pre-filled by `npm run build-mapping`, which matches products by name and metal (WG/YG/PG, or the materials). **77 of 98** refs are linked. The 21 others need a manual check, mostly prototypes and products not on the site.
- **Catalogue sync turned off** (`SYNC_PRODUCTS=false`): the connector doesn't touch Shopify stock or visibility.
- Fixed `npm run discover`, which wouldn't start while some `.env` values were empty.
- 33 tests pass. A dry run with a realistic order against the real APIs produced the right contact, commande client, deposit and notification. Nothing was written.

Details: [README](../README.md) and [ARCHITECTURE §0](ARCHITECTURE.md).

## Settings chosen (to confirm)
| Setting | Value | Note |
|---|---|---|
| `JEWELY_ORDER_MODE` | `customer_order` | web order → commande client |
| `JEWELY_OPERATOR_ID` | `4` (Helena Joy) | a dedicated "Site web" employee would be cleaner |
| `JEWELY_PAYMENT_OPTION_ID` | `3` (Credit Card) | |
| `SYNC_PRODUCTS` | `false` | Shopify sells made to order |
| `DRY_RUN` | `true` | nothing is written until the go-live test |

## Requests (meeting with Jewely and Helena Joy)

**Helena Joy**
1. Confirm that web orders become a commande client, not a direct sale.
2. Which employee should web orders be recorded under? Is "Credit Card" the right payment method?
3. Check the 21 unlinked products in `mapping.csv`.
4. Approve one real test order in Jewely (deleted afterwards).
5. When does the new Shopify site go live?

**Jewely**
1. Check the test order: is `name` the last name and `surname` the first name? Are amounts sent in euros with decimals (e.g. 9.90)?
2. Add the production server's IP to the allowlist.
3. Give a technical contact.

## Next steps
1. **Shopify app settings:** turn on *protected customer data* (name, email, phone, address). Without it, orders arrive without customer details.
2. **Real test in Jewely:** set `DRY_RUN=false` and push one test order. Check the contact, commande client and deposit in Jewely, then delete them.
3. **Complete `mapping.csv`:** fill in the missing rows and set their status to `manuel`.
4. **Server:** a VPS with a fixed IP. Get it allowlisted by Jewely, set `PUBLIC_URL`, run `docker compose up -d`, then `npm run setup:webhooks`.
5. **At launch:** place one real order on the site and check it in Jewely.
