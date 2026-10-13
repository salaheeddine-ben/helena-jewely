import type { Config } from '../src/config.ts';
import type { ErpProduct, ErpStockEntry } from '../src/jewely/types.ts';

export function testConfig(overrides: Partial<Config['jewely']> = {}): Config {
  return {
    port: 0, publicUrl: 'https://connector.test', dataDir: ':memory:', dryRun: false, adminToken: 'admin', logLevel: 'error',
    mappingFile: '/nonexistent/mapping.csv',
    jewely: {
      baseUrl: 'https://erp.test/api/v1', webhookUrlToken: 'tok', webSalePointId: 2, stockSalePointIds: [],
      operatorId: 7, saleStatus: 'on_hold', orderMode: 'customer_order', paymentOptionId: 5, notifyRoles: ['Admin'], shippingProvisionName: 'Livraison',
      vatRate: 0.2, minIntervalMs: 0, ...overrides,
    },
    shopify: {
      shop: 'helena.myshopify.com', apiVersion: '2026-10', webhookSecret: 'shh', locationId: 'gid://shopify/Location/1',
      createProducts: true, // the production default is false
      sizeOptionName: 'Taille', sizeSkuSeparator: '/', hideMode: 'draft',
    },
    sync: { products: true, pollIntervalMinutes: 10, fullSyncHour: 3, holdTtlDays: 30 },
  };
}

export function product(over: Partial<ErpProduct> = {}): ErpProduct {
  return {
    id: 100, ref: 'BAG-001', model: 'Bague Solitaire', description: 'Bague or jaune', longDescription: null, typeName: 'Bijou',
    categoryName: 'Bagues', subCategoryName: 'Solitaires', collection: 'Joy', priceTtc: '1250.00', priceHt: '1041.67',
    brand: 'Helena Joy', isOccasion: false, condition: null, showOnWebsite: true, gender: 'F', quantity: 2,
    images: ['https://cdn.test/a.jpg'], stones: [], materials: [{ name: 'Or jaune 18k', color: 'jaune', weight: '3', purity: '750' }],
    updatedAt: null, createdAt: null, ...over,
  };
}

export function entry(id: number, over: Partial<ErpStockEntry> = {}): ErpStockEntry {
  return {
    id, productId: 100, salePointId: 2, size: null, priceTtc: '1250.00', serialNumber: `SN${id}`,
    isAvailable: true, isReserved: 0, isUnderRepair: '0', isConfided: '0', isDeleted: false, transferId: null,
    product: { ref: 'BAG-001' }, ...over,
  };
}
