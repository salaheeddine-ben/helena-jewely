// Shopify Admin GraphQL client. It authenticates with either a static Admin API token (legacy custom app)
// or the client credentials grant (Dev Dashboard app in the same organisation as the store; the token lasts 24 h).
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.ts';
import { log } from '../lib/log.ts';
import { sleep } from '../lib/util.ts';
import type { CatalogVariant } from '../sync/sku-map.ts';

export class ShopifyError extends Error {
  permanent: boolean;
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

export class ShopifyClient {
  private token?: string;
  private tokenExpiresAt = 0;
  private cfg: Config['shopify'];
  private dryRun: boolean;

  constructor(cfg: Config['shopify'], dryRun: boolean) {
    this.cfg = cfg;
    this.dryRun = dryRun;
  }

  private async accessToken(): Promise<string> {
    if (this.cfg.adminToken) return this.cfg.adminToken;
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.cfg.clientId || !this.cfg.clientSecret) {
      throw new Error('Shopify auth: set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET');
    }
    const res = await fetch(`https://${this.cfg.shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    });
    if (!res.ok) throw new Error(`Shopify token request failed: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.token;
  }

  /** Runs a GraphQL operation. It retries on throttling and 5xx, and turns top-level `errors` into exceptions. */
  async graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const url = `https://${this.cfg.shop}/admin/api/${this.cfg.apiVersion}/graphql.json`;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await this.accessToken() },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      }).catch((e) => e as Error);

      if (res instanceof Error || res.status >= 500 || res.status === 429) {
        if (attempt >= 5) throw res instanceof Error ? res : new ShopifyError(`Shopify HTTP ${res.status}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 && !this.cfg.adminToken && attempt === 1) {
        this.token = undefined;
        continue;
      }
      const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: any };
      if (body.errors?.length) {
        const throttled = body.errors.some((e) => e.extensions?.code === 'THROTTLED');
        if (throttled && attempt < 8) {
          const status = body.extensions?.cost?.throttleStatus;
          const needed = body.extensions?.cost?.requestedQueryCost ?? 100;
          const waitMs = status ? Math.max(500, ((needed - status.currentlyAvailable) / status.restoreRate) * 1000) : 2000;
          await sleep(waitMs);
          continue;
        }
        throw new ShopifyError(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`, !throttled);
      }
      if (!res.ok) throw new ShopifyError(`Shopify HTTP ${res.status}`, res.status < 500);
      return body.data as T;
    }
  }

  /** Mutations are skipped and only logged when DRY_RUN=true. Throws when the mutation returns userErrors. */
  async mutate<T = any>(name: string, query: string, variables: Record<string, unknown>, resultKey: string): Promise<T | null> {
    if (this.dryRun) {
      log.info('shopify: DRY_RUN, mutation skipped', { name, variables });
      return null;
    }
    const data = await this.graphql<Record<string, any>>(query, variables);
    const result = data[resultKey];
    const userErrors = result?.userErrors ?? [];
    if (userErrors.length) {
      throw new ShopifyError(`Shopify ${name} userErrors: ${JSON.stringify(userErrors)}`, true);
    }
    return result as T;
  }

  // ---------- reads ----------

  /** Finds variants by exact SKU. Returns a map of sku -> variant info. */
  async variantsBySkus(skus: string[]): Promise<Map<string, ShopifyVariant>> {
    const out = new Map<string, ShopifyVariant>();
    for (let i = 0; i < skus.length; i += 20) {
      const chunk = skus.slice(i, i + 20);
      const q = chunk.map((s) => `sku:"${s.replace(/(["\\])/g, '\\$1')}"`).join(' OR ');
      const data = await this.graphql<{ productVariants: { nodes: any[] } }>(VARIANTS_BY_QUERY, { q, first: 100, locationId: this.cfg.locationId });
      for (const v of data.productVariants.nodes) {
        if (!v.sku || !chunk.includes(v.sku)) continue; // search is fuzzy: keep exact matches only
        out.set(v.sku, toVariant(v));
      }
    }
    return out;
  }

  async productWithVariants(productId: string): Promise<ShopifyProduct | null> {
    const data = await this.graphql<{ product: any }>(PRODUCT_QUERY, { id: productId, locationId: this.cfg.locationId });
    const p = data.product;
    if (!p) return null;
    return {
      id: p.id,
      status: p.status,
      options: p.options.map((o: any) => ({ id: o.id, name: o.name, values: o.values })),
      variants: p.variants.nodes.map(toVariant),
    };
  }

  /** Every variant of the store (SKU, options, product), for `npm run build-mapping`. */
  async catalogVariants(): Promise<CatalogVariant[]> {
    const out: CatalogVariant[] = [];
    let after: string | null = null;
    do {
      const data: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: CatalogVariant[] } } =
        await this.graphql(CATALOG_VARIANTS, { after });
      out.push(...data.productVariants.nodes);
      after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  // ---------- writes ----------

  /** Sets "available" to an absolute value, with a compare-and-swap on the quantity we last read. */
  async setAvailable(items: { inventoryItemId: string; quantity: number; changeFromQuantity: number | null }[], reference: string) {
    if (!items.length) return;
    return this.mutate('inventorySetQuantities', INVENTORY_SET, {
      idempotencyKey: randomUUID(),
      input: {
        name: 'available',
        reason: 'correction',
        referenceDocumentUri: reference,
        quantities: items.map((i) => ({
          inventoryItemId: i.inventoryItemId,
          locationId: this.cfg.locationId,
          quantity: i.quantity,
          changeFromQuantity: i.changeFromQuantity,
        })),
      },
    }, 'inventorySetQuantities');
  }

  async updateVariantPrices(productId: string, variants: { id: string; price: string }[]) {
    if (!variants.length) return;
    return this.mutate('productVariantsBulkUpdate', VARIANTS_BULK_UPDATE, { productId, variants }, 'productVariantsBulkUpdate');
  }

  async createVariants(productId: string, variants: Record<string, unknown>[]) {
    if (!variants.length) return;
    return this.mutate('productVariantsBulkCreate', VARIANTS_BULK_CREATE, { productId, variants }, 'productVariantsBulkCreate');
  }

  async setProductStatus(productId: string, status: 'ACTIVE' | 'DRAFT') {
    return this.mutate('productUpdate', PRODUCT_UPDATE_STATUS, { product: { id: productId, status } }, 'productUpdate');
  }

  async createProduct(input: Record<string, unknown>): Promise<string | null> {
    const res = await this.mutate<{ product: { id: string } }>('productSet', PRODUCT_SET, { input, synchronous: true }, 'productSet');
    return res?.product.id ?? null;
  }

  async addOrderTags(orderGid: string, tags: string[]) {
    return this.mutate('tagsAdd', TAGS_ADD, { id: orderGid, tags }, 'tagsAdd');
  }

  // ---------- setup helpers ----------

  async locations(): Promise<{ id: string; name: string; isActive: boolean }[]> {
    const data = await this.graphql<{ locations: { nodes: any[] } }>(`query { locations(first: 50) { nodes { id name isActive } } }`);
    return data.locations.nodes;
  }

  async webhookSubscriptions(): Promise<{ id: string; topic: string; uri: string }[]> {
    const data = await this.graphql<{ webhookSubscriptions: { nodes: any[] } }>(
      `query { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`,
    );
    return data.webhookSubscriptions.nodes;
  }

  async createWebhookSubscription(topic: string, uri: string) {
    return this.mutate('webhookSubscriptionCreate', WEBHOOK_CREATE, { topic, webhookSubscription: { uri, format: 'JSON' } }, 'webhookSubscriptionCreate');
  }
}

export interface ShopifyVariant {
  id: string;
  sku: string;
  price: string;
  productId: string;
  productStatus: string;
  inventoryItemId: string;
  tracked: boolean;
  available: number | null; // null = not stocked at the configured location
  selectedOptions: { name: string; value: string }[];
}

export interface ShopifyProduct {
  id: string;
  status: string;
  options: { id: string; name: string; values: string[] }[];
  variants: ShopifyVariant[];
}

function toVariant(v: any): ShopifyVariant {
  const level = v.inventoryItem?.inventoryLevel;
  const available = level?.quantities?.find((q: any) => q.name === 'available')?.quantity;
  return {
    id: v.id,
    sku: v.sku,
    price: v.price,
    productId: v.product?.id,
    productStatus: v.product?.status,
    inventoryItemId: v.inventoryItem?.id,
    tracked: Boolean(v.inventoryItem?.tracked),
    available: level ? (available ?? 0) : null,
    selectedOptions: v.selectedOptions ?? [],
  };
}

const VARIANT_FIELDS = `
  id sku price
  selectedOptions { name value }
  product { id status }
  inventoryItem {
    id tracked
    inventoryLevel(locationId: $locationId) { quantities(names: ["available"]) { name quantity } }
  }`;

const CATALOG_VARIANTS = `
query CatalogVariants($after: String) {
  productVariants(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { sku selectedOptions { name value } product { id title status } }
  }
}`;

const VARIANTS_BY_QUERY = `
query VariantsBySku($q: String!, $first: Int!, $locationId: ID!) {
  productVariants(first: $first, query: $q) { nodes { ${VARIANT_FIELDS} } }
}`;

const PRODUCT_QUERY = `
query ProductWithVariants($id: ID!, $locationId: ID!) {
  product(id: $id) {
    id status
    options { id name values }
    variants(first: 100) { nodes { ${VARIANT_FIELDS} } }
  }
}`;

// Since 2026-04, inventorySetQuantities requires @idempotent and changeFromQuantity (null skips the check).
const INVENTORY_SET = `
mutation InventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup { reason changes { name delta } }
    userErrors { field message code }
  }
}`;

const VARIANTS_BULK_UPDATE = `
mutation VariantsPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id price }
    userErrors { field message }
  }
}`;

const VARIANTS_BULK_CREATE = `
mutation VariantsCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkCreate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message }
  }
}`;

const PRODUCT_UPDATE_STATUS = `
mutation ProductStatus($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id status }
    userErrors { field message }
  }
}`;

const PRODUCT_SET = `
mutation ProductCreate($input: ProductSetInput!, $synchronous: Boolean!) {
  productSet(input: $input, synchronous: $synchronous) {
    product { id }
    userErrors { field message code }
  }
}`;

const TAGS_ADD = `
mutation TagsAdd($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
}`;

const WEBHOOK_CREATE = `
mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;
