import { createHmac } from 'node:crypto';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Jewely API returns money as strings ("1250.00", sometimes "1 250,00"), numbers or null.
 * Returns euros as a number, or null when not parseable.
 */
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[\s €]/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Jewely serialises several flags as "0"/"1", 0/1, true/false or null. */
export function truthy(v: unknown): boolean {
  if (typeof v === 'string') return v !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return Boolean(v);
}

/** Laravel-friendly timestamp in the ERP's timezone: "YYYY-MM-DD HH:mm:ss". */
export function toErpDateTime(d: Date, timeZone = 'Europe/Paris'): string {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return parts.replace('T', ' ');
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — only used if the API account has 2FA enabled.
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, now = Date.now(), step = 30, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(now / 1000 / step), digits);
}

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(buf).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}

/** Pulls `data` out of `{data: [...]}` / `{data: {...}}` envelopes, otherwise returns the value as-is. */
export function unwrap<T = unknown>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}
