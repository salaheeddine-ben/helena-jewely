// The subset of the Helena Joy OpenAPI spec (v1.2) the connector uses.
// Field names follow the spec. Where the spec has wrong types (e.g. "0"/"1" strings typed as boolean),
// fields are typed `unknown` and read through helpers (truthy, parseMoney).

export type CustomerRef = { type: 'contact' | 'company'; id: number };

export interface ErpProduct {
  id: number;
  ref: string;
  model: string | null;
  description: string | null;
  longDescription: string | null;
  typeName: string | null;
  categoryName: string | null;
  subCategoryName: string | null;
  collection: string | null;
  priceTtc: string | null;
  priceHt: string | null;
  brand: string | null;
  isOccasion: boolean;
  condition: string | null;
  showOnWebsite: boolean;
  gender: string;
  quantity: number;
  images: unknown[];
  stones: { name: string | null; caratage: string; number: string; color: string; purity: string; shape: string }[];
  materials: { name: string | null; color: string; weight: string; purity: string | null }[];
  updatedAt: string | null;
  createdAt: string | null;
}

export interface ErpStockEntry {
  id: number;
  productId: number;
  salePointId: number;
  size: string | null;
  priceTtc: string | null;
  serialNumber: string | null;
  isAvailable: unknown;
  isReserved: unknown;
  isUnderRepair: unknown;
  isConfided: unknown;
  isDeleted: unknown;
  isInPendingSale?: unknown; // in a draft (on_hold) sale: already taken, even though isAvailable may still be true
  isSold?: unknown;
  isSellable?: unknown; // returned by the live API (not in the spec)
  transferId: unknown;
  product?: { id?: unknown; ref?: string; model?: string };
  createdAt?: string | null;
}

export interface CreateSaleBody {
  externalId: string;
  date?: string;
  status?: 'on_hold' | 'processed';
  invoiceCurrency?: 'EUR' | 'USD' | 'GBP' | 'CHF';
  salePointId: number;
  customer: CustomerRef;
  operatorsIds: number[];
  stocksRemovals: { stockEntryId: number; priceTtc: number; discountTtc: number }[];
  salesProvisions?: { priceTtc: number; provision: { name: string } }[];
  autoTransferStock?: boolean;
}

export interface CreateOrderBody {
  operator: { id: number };
  salePointId?: number;
  customer: CustomerRef;
  externalId: string;
  date?: string;
  orderEntries: { product: { id: number }; orderProducts: { priceHt: number; serialNumber?: string | null }[] }[];
  type: 'customer_command';
}

export interface CreatePaymentBody {
  customer: CustomerRef;
  salePointId: number;
  optionId: number;
  value: number;
  currency?: 'EUR' | 'USD';
  date?: string;
  description?: string | null;
  ref?: string | null;
  isDeposit?: boolean;
  orderId?: number | null;
}

export interface CreateContactBody {
  name: string | null;
  surname: string | null;
  email?: string | null;
  acceptProspecting: boolean;
  type: 'contact';
  address: { city?: string | null; countryId?: number | null; street?: string | null; zipCode?: string | null };
  phonesNumbers: { number: string | null; type: 'mobile' | 'desk'; iso: string | null }[];
  note?: { description: string | null };
}

export type WebhookType = 'stock-entry' | 'stock-removal' | 'update-price' | 'product-visibility-change';
export const WEBHOOK_TYPES: WebhookType[] = ['stock-entry', 'stock-removal', 'update-price', 'product-visibility-change'];

export interface ErpWebhook {
  id: number;
  name: string;
  type: WebhookType;
  endpoint: string;
  method: string;
  isActive: boolean;
  secret: string | null;
}
