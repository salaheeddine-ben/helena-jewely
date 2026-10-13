import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { extractJewelyRefs, verifyJewelySignature, verifyShopifyHmac } from '../src/webhooks.ts';
import { extractToken } from '../src/jewely/client.ts';
import { parseMoney, totp, toErpDateTime, truthy } from '../src/lib/util.ts';

test('Shopify HMAC: accepts the right signature, rejects a tampered body', () => {
  const body = Buffer.from('{"id":1}');
  const sig = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(verifyShopifyHmac(body, sig, 'secret'), true);
  assert.equal(verifyShopifyHmac(Buffer.from('{"id":2}'), sig, 'secret'), false);
  assert.equal(verifyShopifyHmac(body, undefined, 'secret'), false);
});

test('Jewely signature: Spatie-style hex on the Signature header, with any of the known secrets', () => {
  const body = Buffer.from('{"ref":"BAG-001"}');
  const hex = createHmac('sha256', 's2').update(body).digest('hex');
  assert.equal(verifyJewelySignature(body, { signature: hex }, ['s1', 's2']), true);
  assert.equal(verifyJewelySignature(body, { 'x-signature': `sha256=${hex}` }, ['s2']), true);
  assert.equal(verifyJewelySignature(body, { signature: hex }, ['nope']), false);
  assert.equal(verifyJewelySignature(body, {}, ['s2']), false);
});

test('extractJewelyRefs finds product refs and stock entry ids, and ignores brand refs', () => {
  const payload = {
    event: 'stock-removal',
    data: {
      stockEntry: { id: 55, product: { ref: 'BAG-001', brand: { ref: 'BRAND-X' } } },
      stocksRemovals: [{ stockEntryId: 56, product: { ref: 'COL-002' } }],
    },
  };
  const out = extractJewelyRefs(payload);
  assert.deepEqual(out.refs.sort(), ['BAG-001', 'COL-002']);
  assert.deepEqual(out.stockEntryIds.sort(), [55, 56]);
  assert.deepEqual(extractJewelyRefs(null), { refs: [], stockEntryIds: [] });
});

test('extractToken copes with the usual Laravel response shapes', () => {
  assert.equal(extractToken({ token: '12|abcdefghijklmnop' }), '12|abcdefghijklmnop');
  assert.equal(extractToken({ data: { access_token: 'abcdefghijklmnop' } }), 'abcdefghijklmnop');
  assert.throws(() => extractToken([{ id: 1, name: 'x' }]), /no token found/);
});

test('TOTP matches the RFC 6238 test vector (SHA-1, T=59s)', () => {
  // ASCII "12345678901234567890" in base32
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');
});

test('parseMoney / truthy / toErpDateTime', () => {
  assert.equal(parseMoney('1 250,50 €'), 1250.5);
  assert.equal(parseMoney('1250.00'), 1250);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(truthy('0'), false);
  assert.equal(truthy('1'), true);
  assert.equal(truthy(0), false);
  assert.equal(truthy(null), false);
  assert.equal(toErpDateTime(new Date('2026-07-01T10:00:00Z')), '2026-07-01 12:00:00');
});
