// Centralised configuration, read once from the environment (.env loaded by `node --env-file`).

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name}`);
}

function optStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function int(name: string, fallback?: number): number {
  const raw = optStr(name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var ${name}`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  return n;
}

function optInt(name: string): number | undefined {
  return optStr(name) === undefined ? undefined : int(name);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optStr(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function intList(name: string): number[] {
  const raw = optStr(name);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
}

function list(name: string, fallback: string[]): string[] {
  const raw = optStr(name);
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export type SaleStatus = 'on_hold' | 'processed';
// customer_order: every mapped line becomes a "commande client" (made-to-order shop).
// stock_first: lines are taken from the pieces in stock first (POST /sales), the rest becomes a commande client.
export type OrderMode = 'customer_order' | 'stock_first';

export interface Config {
  port: number;
  publicUrl: string;
  dataDir: string;
  dryRun: boolean;
  adminToken: string;
  logLevel: string;
  /** CSV that links Shopify SKUs to Jewely refs (built by `npm run build-mapping`). */
  mappingFile: string;

  jewely: {
    baseUrl: string;
    apiToken?: string;
    identifier?: string;
    password?: string;
    totpSecret?: string;
    webhookUrlToken: string;
    webSalePointId: number;
    stockSalePointIds: number[];
    operatorId: number;
    saleStatus: SaleStatus;
    orderMode: OrderMode;
    paymentOptionId?: number;
    notifyRoles: string[];
    shippingProvisionName: string;
    vatRate: number;
    minIntervalMs: number;
  };

  shopify: {
    shop: string;
    apiVersion: string;
    adminToken?: string;
    clientId?: string;
    clientSecret?: string;
    webhookSecret: string;
    locationId: string;
    createProducts: boolean;
    sizeOptionName: string;
    sizeSkuSeparator: string;
    hideMode: 'draft' | 'zero_stock';
  };

  sync: {
    /** ERP -> Shopify catalogue sync (stock, price, visibility). Off: only orders flow, Shopify -> ERP. */
    products: boolean;
    pollIntervalMinutes: number;
    fullSyncHour: number;
    holdTtlDays: number;
  };
}

export function loadConfig(): Config {
  const shopifyClientSecret = optStr('SHOPIFY_CLIENT_SECRET');
  return {
    port: int('PORT', 3000),
    publicUrl: str('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
    dataDir: str('DATA_DIR', './data'),
    dryRun: bool('DRY_RUN', true),
    adminToken: str('ADMIN_TOKEN'),
    logLevel: str('LOG_LEVEL', 'info'),
    mappingFile: str('MAPPING_FILE', './mapping.csv'),

    jewely: {
      baseUrl: str('JEWELY_BASE_URL', 'https://helena-joy-quhc2l.jewely.fr/api/v1').replace(/\/$/, ''),
      apiToken: optStr('JEWELY_API_TOKEN'),
      identifier: optStr('JEWELY_IDENTIFIER'),
      password: optStr('JEWELY_PASSWORD'),
      totpSecret: optStr('JEWELY_TOTP_SECRET'),
      webhookUrlToken: str('JEWELY_WEBHOOK_URL_TOKEN'),
      webSalePointId: int('JEWELY_WEB_SALE_POINT_ID'),
      stockSalePointIds: intList('JEWELY_STOCK_SALE_POINT_IDS'),
      operatorId: int('JEWELY_OPERATOR_ID'),
      saleStatus: (str('JEWELY_SALE_STATUS', 'on_hold') as SaleStatus),
      orderMode: (str('JEWELY_ORDER_MODE', 'customer_order') as OrderMode),
      paymentOptionId: optInt('JEWELY_PAYMENT_OPTION_ID'),
      notifyRoles: list('JEWELY_NOTIFY_ROLES', ['Admin', 'Super Admin']),
      shippingProvisionName: str('JEWELY_SHIPPING_PROVISION_NAME', 'Livraison'),
      vatRate: Number(str('JEWELY_VAT_RATE', '0.20')),
      minIntervalMs: int('JEWELY_MIN_INTERVAL_MS', 150),
    },

    shopify: {
      shop: str('SHOPIFY_SHOP').replace(/^https?:\/\//, '').replace(/\/$/, ''),
      apiVersion: str('SHOPIFY_API_VERSION', '2026-10'),
      adminToken: optStr('SHOPIFY_ADMIN_TOKEN'),
      clientId: optStr('SHOPIFY_CLIENT_ID'),
      clientSecret: shopifyClientSecret,
      // Webhooks are signed with the app's client secret (or the secret shown in admin for legacy apps).
      webhookSecret: str('SHOPIFY_WEBHOOK_SECRET', shopifyClientSecret ?? ''),
      locationId: str('SHOPIFY_LOCATION_ID'),
      createProducts: bool('SHOPIFY_CREATE_PRODUCTS', false),
      sizeOptionName: str('SHOPIFY_SIZE_OPTION_NAME', 'Taille'),
      sizeSkuSeparator: str('SHOPIFY_SIZE_SKU_SEPARATOR', '/'),
      hideMode: (str('SHOPIFY_HIDE_MODE', 'draft') as 'draft' | 'zero_stock'),
    },

    sync: {
      products: bool('SYNC_PRODUCTS', false),
      pollIntervalMinutes: int('SYNC_POLL_INTERVAL_MINUTES', 10),
      fullSyncHour: int('SYNC_FULL_HOUR', 3),
      holdTtlDays: int('SYNC_HOLD_TTL_DAYS', 30),
    },
  };
}
