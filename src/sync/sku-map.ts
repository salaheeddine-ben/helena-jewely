// Shopify SKU -> Jewely ref table. The two catalogues use different codes (Shopify "PUECGDTGM", Jewely "HJEECWG1010"),
// so the link is kept in a CSV that `npm run build-mapping` pre-fills and the shop can correct by hand:
// a Jewely product = the Shopify product with the same name, restricted to the variants of its metal (WG/YG/PG in the ref
// <-> the "Couleur" option). Several Shopify SKUs can point to one ref (e.g. "with chain" / "without chain").
import { readFileSync, statSync } from 'node:fs';
import { log } from '../lib/log.ts';

export type MappingStatus = 'auto' | 'manuel' | 'conflit' | 'introuvable';

export interface MappingRow {
  sku: string;
  ref: string;
  status: MappingStatus;
  shopifyProduct: string;
  variant: string;
  erpModel: string;
}

export interface CatalogVariant {
  sku: string | null;
  selectedOptions: { name: string; value: string }[];
  product: { id: string; title: string; status: string };
}

const METAL_COLOURS: Record<string, string> = { YG: 'or jaune', WG: 'or blanc', PG: 'or rose' };
const COLOUR_OPTION = 'couleur';
const USABLE: MappingStatus[] = ['auto', 'manuel'];

/** Lower case, no accents, no punctuation: "Boucle d’oreille Éclipse " == "boucle d'oreille eclipse". */
export function normText(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Metal colour of a Jewely product: from the end of the ref (HJEECWG1010 -> "or blanc"), else from its materials. */
export function metalOf(ref: string, materials: { name?: string | null }[] = []): string | null {
  const m = ref.toUpperCase().match(/(YG|WG|PG)\d*$/);
  if (m) return METAL_COLOURS[m[1]];
  const names = materials.map((x) => normText(x?.name));
  for (const metal of [...Object.values(METAL_COLOURS), 'argent']) if (names.some((n) => n.includes(metal))) return metal;
  return null;
}

/** "Argent 925" matches "argent", "Or blanc" matches "or blanc". */
const sameMetal = (colourValue: string, metal: string) => {
  const v = normText(colourValue);
  return v === metal || v.startsWith(`${metal} `);
};

const colourOf = (v: CatalogVariant) => v.selectedOptions.find((o) => normText(o.name) === COLOUR_OPTION)?.value ?? '';

/** Pre-fills the table. Rows marked `manuel` in `keep` win over anything guessed. */
export function buildMapping(
  erpProducts: { ref: string; model: string | null; materials?: { name?: string | null }[] | null }[],
  variants: CatalogVariant[],
  keep: MappingRow[] = [],
): MappingRow[] {
  const manual = keep.filter((r) => r.status === 'manuel');
  const manualKeys = new Set(manual.map((r) => `${r.sku}|${normText(r.variant)}`));
  const manualRefs = new Set(manual.map((r) => r.ref));

  const byProduct = new Map<string, CatalogVariant[]>();
  for (const v of variants) {
    if (!byProduct.has(v.product.id)) byProduct.set(v.product.id, []);
    byProduct.get(v.product.id)!.push(v);
  }
  const byTitle = new Map<string, CatalogVariant[][]>();
  for (const vs of byProduct.values()) {
    const key = normText(vs[0].product.title);
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key)!.push(vs);
  }

  const rows: MappingRow[] = [];
  for (const p of [...erpProducts].sort((a, b) => a.ref.localeCompare(b.ref))) {
    if (manualRefs.has(p.ref)) continue;
    const base = { ref: p.ref, erpModel: (p.model ?? '').trim(), shopifyProduct: '', variant: '' };
    const candidates = byTitle.get(normText(p.model)) ?? [];
    const active = candidates.filter((vs) => vs[0].product.status === 'ACTIVE');
    const chosen = active.length === 1 ? active[0] : !active.length && candidates.length === 1 ? candidates[0] : null;
    if (!chosen) {
      const why = candidates.length ? `${candidates.length} produits Shopify portent ce nom` : 'aucun produit Shopify de ce nom';
      rows.push({ ...base, sku: '', status: candidates.length ? 'conflit' : 'introuvable', variant: why });
      continue;
    }
    const title = chosen[0].product.title;
    const colours = new Set(chosen.map(colourOf).filter(Boolean));
    const metal = metalOf(p.ref, p.materials ?? []);
    let picked = chosen;
    if (colours.size > 0 && metal) picked = chosen.filter((v) => sameMetal(colourOf(v), metal));
    else if (colours.size > 1) {
      rows.push({ ...base, sku: '', status: 'conflit', shopifyProduct: title, variant: 'métal inconnu côté Jewely' });
      continue;
    }
    // One row per (SKU, colour): the colour tells refs apart when Shopify reuses a SKU across colours.
    const pairs = new Map<string, { sku: string; variant: string }>();
    for (const v of picked) {
      const sku = (v.sku ?? '').trim();
      const variant = colourOf(v);
      if (sku && !manualKeys.has(`${sku}|${normText(variant)}`)) pairs.set(`${sku}|${variant}`, { sku, variant });
    }
    if (!pairs.size) {
      const why = picked.length ? 'variantes sans SKU' : `pas de variante « ${metal} »`;
      rows.push({ ...base, sku: '', status: 'introuvable', shopifyProduct: title, variant: why });
      continue;
    }
    for (const { sku, variant } of pairs.values()) rows.push({ ...base, sku, status: 'auto', shopifyProduct: title, variant });
  }

  // The same SKU + colour guessed for two refs is not used until someone decides.
  const refsByKey = new Map<string, Set<string>>();
  const key = (r: MappingRow) => `${r.sku}|${normText(r.variant)}`;
  for (const r of rows) if (r.sku) (refsByKey.get(key(r)) ?? refsByKey.set(key(r), new Set()).get(key(r))!).add(r.ref);
  for (const r of rows) if (r.sku && refsByKey.get(key(r))!.size > 1) r.status = 'conflit';

  return [...manual, ...rows];
}

// ---------- CSV (";" separated, UTF-8 with BOM so Excel opens it correctly) ----------

const HEADER = ['shopify_sku', 'jewely_ref', 'statut', 'produit_shopify', 'variante', 'modele_jewely'];

export function toCsv(rows: MappingRow[]): string {
  const cell = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = rows.map((r) => [r.sku, r.ref, r.status, r.shopifyProduct, r.variant, r.erpModel].map(cell).join(';'));
  return `﻿${HEADER.join(';')}\n${lines.join('\n')}\n`;
}

export function parseCsv(text: string): MappingRow[] {
  const records: string[][] = [];
  let field = '', record: string[] = [], quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ';') { record.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field); records.push(record); field = ''; record = [];
    } else field += c;
  }
  if (field || record.length) { record.push(field); records.push(record); }

  return records
    .filter((r) => r.some((c) => c.trim()) && r[0] !== HEADER[0])
    .map(([sku = '', ref = '', status = '', shopifyProduct = '', variant = '', erpModel = '']) => ({
      sku: sku.trim(), ref: ref.trim(), status: (status.trim().toLowerCase() || 'manuel') as MappingStatus, shopifyProduct, variant, erpModel,
    }));
}

export type SkuMap = Map<string, { ref: string; variant: string }[]>;

/** Only usable rows (auto / manuel, both codes filled). */
export function skuMapFrom(rows: MappingRow[]): SkuMap {
  const map: SkuMap = new Map();
  for (const r of rows) {
    if (!r.sku || !r.ref || !USABLE.includes(r.status)) continue;
    if (!map.has(r.sku)) map.set(r.sku, []);
    map.get(r.sku)!.push({ ref: r.ref, variant: r.variant });
  }
  return map;
}

/**
 * Jewely ref of an order line. When the SKU is shared by several refs (one per colour), the colour found in the
 * Shopify variant title ("Or blanc / XS") decides. Returns null when the line can't be told apart for sure.
 */
export function refForLine(map: SkuMap, sku: string, variantTitle: string | null | undefined): string | null {
  const entries = map.get(sku.trim());
  if (!entries?.length) return null;
  const refs = new Set(entries.map((e) => e.ref));
  if (refs.size === 1) return entries[0].ref;
  const parts = (variantTitle ?? '').split(' / ').map(normText);
  const byColour = new Set(entries.filter((e) => e.variant && parts.includes(normText(e.variant))).map((e) => e.ref));
  return byColour.size === 1 ? [...byColour][0] : null;
}

let cache: { path: string; mtimeMs: number; map: SkuMap } | null = null;

/** Reads the CSV, re-reading it only when the file changes (it can be edited while the connector runs). */
export function loadSkuMap(path: string): SkuMap {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    if (cache?.path !== path) log.warn('mapping: file not found, Shopify SKUs are looked up as Jewely refs', { path });
    cache = { path, mtimeMs: -1, map: new Map() };
    return cache.map;
  }
  if (cache?.path === path && cache.mtimeMs === mtimeMs) return cache.map;
  const map = skuMapFrom(parseCsv(readFileSync(path, 'utf8')));
  cache = { path, mtimeMs, map };
  log.info('mapping: loaded', { path, skus: map.size });
  return map;
}
