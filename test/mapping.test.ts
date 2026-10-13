import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desiredState, isSellableOnline, parseSku, pickStockEntries, productSetInput, stateHash } from '../src/sync/mapping.ts';
import { entry, product } from './fixtures.ts';

const opts = { sizeSkuSeparator: '/', stockSalePointIds: [] as number[] };

test('a product without sizes maps to one variant whose SKU is the ref', () => {
  const s = desiredState(product(), [entry(1), entry(2)], opts, new Set());
  assert.equal(s.variants.length, 1);
  assert.deepEqual(s.variants[0], { sku: 'BAG-001', size: null, price: '1250.00', quantity: 2, stockEntryIds: [1, 2] });
});

test('pieces that are reserved, under repair, confided, in transfer, held or unavailable are not counted', () => {
  const entries = [
    entry(1),
    entry(2, { isReserved: 1 }),
    entry(3, { isUnderRepair: '1' }),
    entry(4, { isConfided: 'true' }),
    entry(5, { transferId: 9 }),
    entry(6, { isAvailable: false }),
    entry(7),
    entry(8, { isInPendingSale: true }),
    entry(9, { isSold: true }),
  ];
  const s = desiredState(product(), entries, opts, new Set([7]));
  assert.equal(s.variants[0].quantity, 1);
  assert.deepEqual(s.variants[0].stockEntryIds, [1]);
});

test('ring sizes become variants; a sold-out size stays at 0; the price is the cheapest available piece', () => {
  const entries = [
    entry(1, { size: '52', priceTtc: '1300.00' }),
    entry(2, { size: '52', priceTtc: '1250.00' }),
    entry(3, { size: '54', isAvailable: false }),
    entry(4, { size: '50' }),
  ];
  const s = desiredState(product(), entries, opts, new Set());
  assert.deepEqual(s.variants.map((v) => [v.sku, v.quantity, v.price]), [
    ['BAG-001/50', 1, '1250.00'],
    ['BAG-001/52', 2, '1250.00'],
    ['BAG-001/54', 0, '1250.00'],
  ]);
});

test('stockSalePointIds limits which sale points count for the web stock', () => {
  const s = desiredState(product(), [entry(1, { salePointId: 1 }), entry(2, { salePointId: 3 })], { ...opts, stockSalePointIds: [1] }, new Set());
  assert.equal(s.variants[0].quantity, 1);
  assert.equal(isSellableOnline(entry(2, { salePointId: 3 }), { ...opts, stockSalePointIds: [1] }, new Set()), false);
});

test('the state hash changes with stock, price and visibility', () => {
  const base = desiredState(product(), [entry(1)], opts, new Set());
  assert.equal(stateHash(base), stateHash(desiredState(product(), [entry(1)], opts, new Set())));
  assert.notEqual(stateHash(base), stateHash(desiredState(product(), [entry(1), entry(2)], opts, new Set())));
  assert.notEqual(stateHash(base), stateHash(desiredState(product({ showOnWebsite: false }), [entry(1)], opts, new Set())));
  assert.notEqual(stateHash(base), stateHash(desiredState(product(), [entry(1, { priceTtc: '999' })], opts, new Set())));
});

test('parseSku splits on the last separator and copes with refs that contain it', () => {
  assert.deepEqual(parseSku('BAG-001/52', '/'), { ref: 'BAG-001', size: '52' });
  assert.deepEqual(parseSku('BAG-001', '/'), { ref: 'BAG-001', size: null });
  assert.deepEqual(parseSku('A/B', '/', (r) => r === 'A/B'), { ref: 'A/B', size: null });
  assert.deepEqual(parseSku('A/B/52', '/', (r) => r === 'A/B'), { ref: 'A/B', size: '52' });
});

test('pickStockEntries prefers the web sale point, then the cheapest, and matches the size', () => {
  const entries = [
    entry(1, { size: '52', salePointId: 1, priceTtc: '1000' }),
    entry(2, { size: '52', salePointId: 2, priceTtc: '1300' }),
    entry(3, { size: '54', salePointId: 2 }),
    entry(4, { size: '52', salePointId: 1, priceTtc: '900' }),
  ];
  const picked = pickStockEntries(entries, '52', 2, opts, new Set(), 2);
  assert.deepEqual(picked.map((e) => e.id), [2, 4]);
  assert.equal(pickStockEntries(entries, '52', 5, opts, new Set([2]), 2).length, 2);
});

test('productSetInput creates a DRAFT product with SKU, stock, images and the ERP id metafield', () => {
  const p = product();
  const s = desiredState(p, [entry(1, { size: '52' }), entry(2, { size: '54' })], opts, new Set());
  const input = productSetInput(p, s, { locationId: 'gid://shopify/Location/1', sizeOptionName: 'Taille' }) as any;
  assert.equal(input.status, 'DRAFT');
  assert.equal(input.title, 'Bague Solitaire');
  assert.equal(input.vendor, 'Helena Joy');
  assert.deepEqual(input.productOptions[0].values, [{ name: '52' }, { name: '54' }]);
  assert.equal(input.variants[0].sku, 'BAG-001/52');
  assert.deepEqual(input.variants[0].inventoryQuantities, [{ locationId: 'gid://shopify/Location/1', name: 'available', quantity: 1 }]);
  assert.equal(input.files[0].originalSource, 'https://cdn.test/a.jpg');
  assert.equal(input.metafields[0].value, '100');
  assert.ok(input.tags.includes('Bagues') && input.tags.includes('Or jaune 18k'));
});

test('productSetInput uses the default Title option when there are no sizes', () => {
  const p = product();
  const input = productSetInput(p, desiredState(p, [entry(1)], opts, new Set()), { locationId: 'L', sizeOptionName: 'Taille' }) as any;
  assert.deepEqual(input.productOptions, [{ name: 'Title', position: 1, values: [{ name: 'Default Title' }] }]);
  assert.deepEqual(input.variants[0].optionValues, [{ optionName: 'Title', name: 'Default Title' }]);
});
