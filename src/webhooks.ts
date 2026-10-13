// Webhook authentication, plus pulling product refs out of Jewely payloads.
import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Shopify: X-Shopify-Hmac-Sha256 = base64(HMAC-SHA256(raw body, app secret)). */
export function verifyShopifyHmac(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, header);
}

/**
 * Jewely: the spec says "POST signé HMAC" but doesn't name the header or the encoding. The ERP is Laravel
 * (Spatie), so the likely format is spatie/laravel-webhook-server: header `Signature` = hex(HMAC-SHA256(body, secret)).
 * We accept hex or base64, on the usual headers, against any known secret (one per webhook).
 */
export function verifyJewelySignature(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, secrets: string[]): boolean {
  const names = ['signature', 'x-signature', 'x-jewely-signature', 'x-hub-signature-256', 'x-webhook-signature'];
  const provided = names
    .map((n) => headers[n])
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
    .map((v) => v.replace(/^sha256=/i, '').trim());
  if (!provided.length) return false;
  for (const secret of secrets.filter(Boolean)) {
    const mac = createHmac('sha256', secret).update(rawBody);
    const digest = mac.digest();
    const candidates = [digest.toString('hex'), digest.toString('base64')];
    if (provided.some((p) => candidates.some((c) => safeEqual(c, p)))) return true;
  }
  return false;
}

/**
 * The Jewely webhook body format isn't documented. This walks the JSON and collects anything that
 * looks like a product ref or a stock entry id, so the connector can re-read the fresh state from the API.
 */
export function extractJewelyRefs(payload: unknown): { refs: string[]; stockEntryIds: number[] } {
  const refs = new Set<string>();
  const stockEntryIds = new Set<number>();

  const walk = (node: unknown, parentKey: string, depth: number) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, parentKey, depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const key = k.toLowerCase();
      if ((key === 'ref' || key === 'productref' || key === 'product_ref') && typeof v === 'string' && v.trim()) {
        // "ref" under a product/stock-entry/root object; refs of brands or suppliers are ignored.
        if (!['brand', 'supplier', 'category', 'subcategory'].includes(parentKey)) refs.add(v.trim());
      }
      const isStockEntryObject = ['stockentry', 'stock_entry', 'stocksentries', 'stocks_entries'].includes(parentKey);
      if (key === 'stockentryid' || key === 'stock_entry_id' || (key === 'id' && isStockEntryObject)) {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) stockEntryIds.add(n);
      }
      if (v && typeof v === 'object') walk(v, key, depth + 1);
    }
  };
  walk(payload, '', 0);
  return { refs: [...refs], stockEntryIds: [...stockEntryIds] };
}
