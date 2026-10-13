// Jewely ERP REST client (https://<tenant>.jewely.fr/api/v1), Bearer token auth.
import type { Config } from '../config.ts';
import { log } from '../lib/log.ts';
import { sleep, totp, unwrap } from '../lib/util.ts';
import type {
  CreateContactBody, CreateOrderBody, CreatePaymentBody, CreateSaleBody, ErpProduct, ErpStockEntry, ErpWebhook, WebhookType,
} from './types.ts';

export class JewelyHttpError extends Error {
  status: number;
  body: unknown;
  permanent: boolean;
  constructor(method: string, path: string, status: number, body: unknown) {
    super(`Jewely ${method} ${path} -> HTTP ${status}: ${JSON.stringify(body).slice(0, 800)}`);
    this.status = status;
    this.body = body;
    // Validation errors and missing resources won't fix themselves when retried.
    this.permanent = status === 422 || status === 404 || status === 400;
  }
}

type Query = Record<string, string | number | boolean | undefined | null | (string | number)[]>;

export class JewelyClient {
  private token?: string;
  private lastRequestAt = 0;
  private cfg: Config['jewely'];
  private dryRun: boolean;

  constructor(cfg: Config['jewely'], dryRun: boolean) {
    this.cfg = cfg;
    this.dryRun = dryRun;
    this.token = cfg.apiToken;
  }

  // ---------- auth ----------

  /**
   * POST /login (step 1). An account without 2FA gets its token right away. An account with 2FA gets a
   * short-lived challenge token, which we exchange on /login/two-factor-challenge using the TOTP secret.
   * The spec doesn't document the token field name (the response is typed as PermissionResource[]),
   * so we look for the usual Sanctum/Passport names.
   */
  private async login(): Promise<string> {
    if (!this.cfg.identifier || !this.cfg.password) {
      throw new Error('Jewely auth: set JEWELY_API_TOKEN, or JEWELY_IDENTIFIER + JEWELY_PASSWORD');
    }
    const step1 = await this.raw('POST', '/login', undefined, { identifier: this.cfg.identifier, password: this.cfg.password }, false);
    const s1 = step1 as Record<string, unknown>;
    if (s1 && s1.two_factor === true && typeof s1.two_factor_token === 'string') {
      if (!this.cfg.totpSecret) throw new Error('Jewely account has 2FA enabled: set JEWELY_TOTP_SECRET or use an API account without 2FA');
      const step2 = await this.raw('POST', '/login/two-factor-challenge', undefined, { code: totp(this.cfg.totpSecret) }, false, s1.two_factor_token);
      return extractToken(step2);
    }
    return extractToken(step1);
  }

  private async ensureToken(): Promise<string> {
    if (!this.token) {
      this.token = await this.login();
      log.info('jewely: authenticated');
    }
    return this.token;
  }

  // ---------- transport ----------

  private async raw(method: string, path: string, query?: Query, body?: unknown, auth = true, bearer?: string): Promise<unknown> {
    const url = new URL(this.cfg.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
      else url.searchParams.set(k, String(v));
    }

    for (let attempt = 1; ; attempt++) {
      const wait = this.lastRequestAt + this.cfg.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();

      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const token = bearer ?? (auth ? await this.ensureToken() : undefined);
      if (token) headers.Authorization = `Bearer ${token}`;

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (attempt >= 4) throw err;
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }

      if (res.status === 401 && auth && !bearer && attempt === 1 && this.cfg.identifier) {
        this.token = undefined; // expired or revoked token: log in again once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 403) {
        // "IP not allowed" -> the server's outgoing IP has to be added to the API account's allowlist in Jewely.
        log.error('jewely: access forbidden', { path, body: parsed });
      }
      if (!res.ok) throw new JewelyHttpError(method, path, res.status, parsed);
      return parsed;
    }
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return (await this.raw('GET', path, query)) as T;
  }

  /** Writes are skipped and only logged when DRY_RUN=true. */
  async write<T = unknown>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
    if (this.dryRun) {
      log.info('jewely: DRY_RUN, write skipped', { method, path, body });
      return null;
    }
    return (await this.raw(method, path, undefined, body)) as T;
  }

  /** Walks a Laravel paginated listing ({data, links, meta}); also copes with plain arrays. */
  async listAll<T>(path: string, query: Query = {}, maxPages = 500): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.get<unknown>(path, { ...query, page });
      const data = unwrap<unknown>(body);
      if (!Array.isArray(data)) break;
      out.push(...(data as T[]));
      const meta = (body as { meta?: { current_page?: number; last_page?: number } })?.meta;
      if (!meta || !meta.last_page || (meta.current_page ?? page) >= meta.last_page || data.length === 0) break;
    }
    return out;
  }

  // ---------- typed helpers ----------

  /** The `ref` filter may be a LIKE match, so we keep exact matches only. */
  async findProductByRef(ref: string): Promise<ErpProduct | undefined> {
    const items = await this.listAll<ErpProduct>('/products', { ref, perPage: 50 }, 5);
    return items.find((p) => p.ref === ref) ?? items.find((p) => p.ref?.toLowerCase() === ref.toLowerCase());
  }

  async stockEntriesByRef(ref: string): Promise<ErpStockEntry[]> {
    const items = await this.listAll<ErpStockEntry>('/stocks-entries', { ref, perPage: 100 }, 20);
    return items.filter((e) => !e.product?.ref || e.product.ref === ref);
  }

  async stockEntryById(id: number): Promise<ErpStockEntry | undefined> {
    const items = await this.listAll<ErpStockEntry>('/stocks-entries', { id, perPage: 5 }, 1);
    return items.find((e) => e.id === id);
  }

  async findCustomerByEmail(email: string): Promise<{ type: 'contact' | 'company'; id: number } | undefined> {
    const rows = await this.listAll<Record<string, unknown>>('/customers', { email, perPage: 20 }, 2);
    const wanted = email.trim().toLowerCase();
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const emails = [r.email, r.email2].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
      if (!emails.includes(wanted)) continue;
      const id = Number(r.id);
      if (!Number.isFinite(id)) continue;
      const type = String(r.type ?? r.customerType ?? 'contact').toLowerCase().includes('company') ? 'company' : 'contact';
      return { type, id };
    }
    return undefined;
  }

  private countryIds?: Map<string, number>;
  async countryIdByIso2(iso2: string | null | undefined): Promise<number | null> {
    if (!iso2) return null;
    if (!this.countryIds) {
      const rows = await this.listAll<{ id: number; codeIso2: string }>('/countries', { perPage: 300 }, 5);
      this.countryIds = new Map(rows.map((c) => [String(c.codeIso2).toUpperCase(), c.id]));
    }
    return this.countryIds.get(iso2.toUpperCase()) ?? null;
  }

  createContact(body: CreateContactBody) { return this.write<unknown>('POST', '/contacts', body); }
  createSale(body: CreateSaleBody) { return this.write<unknown>('POST', '/sales', body); }
  createOrder(body: CreateOrderBody) { return this.write<unknown>('POST', '/orders', body); }
  createPayment(body: CreatePaymentBody) { return this.write<unknown>('POST', '/payments', body); }

  notify(input: { name: string; description: string; roles: string[]; salePointId?: number; href?: string }) {
    return this.write('POST', '/notifications', { ...input, userTrigger: 'helena-shopify', type: 'integration' });
  }

  listWebhooks() { return this.listAll<ErpWebhook>('/webhooks', { perPage: 100 }, 5); }
  createWebhook(body: { name: string; type: WebhookType; endpoint: string; method: 'POST' }) {
    return this.write<unknown>('POST', '/webhooks', body);
  }
  updateWebhook(id: number, body: { name: string; type: WebhookType; endpoint: string; method: 'POST' }) {
    return this.write<unknown>('PUT', `/webhooks/${id}`, body);
  }
}

export function extractToken(body: unknown): string {
  const b = (body ?? {}) as Record<string, any>;
  const candidates = [
    b.token, b.access_token, b.accessToken, b.plainTextToken, b.plain_text_token,
    b.data?.token, b.data?.access_token, b.data?.accessToken, b.data?.plainTextToken,
  ];
  const tok = candidates.find((c) => typeof c === 'string' && c.length > 10);
  if (!tok) throw new Error(`Jewely login: no token found in response keys [${Object.keys(b).join(', ')}]`);
  return tok;
}

/** Pulls the numeric id out of a Jewely resource response ({data:{id}} or {id}). */
export function extractId(body: unknown): number | null {
  const d = unwrap<Record<string, unknown>>(body);
  const id = d && typeof d === 'object' ? Number((d as Record<string, unknown>).id) : NaN;
  return Number.isFinite(id) ? id : null;
}
