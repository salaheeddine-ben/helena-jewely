import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapping, type CatalogVariant, metalOf, parseCsv, refForLine, skuMapFrom, toCsv } from '../src/sync/sku-map.ts';

const v = (productId: string, title: string, sku: string | null, opts: Record<string, string>, status = 'ACTIVE'): CatalogVariant => ({
  sku, selectedOptions: Object.entries(opts).map(([name, value]) => ({ name, value })), product: { id: productId, title, status },
});

const catalog: CatalogVariant[] = [
  // Two SKUs per colour (with / without chain)
  v('p1', "Puce d'oreille Eclipse", 'PUECGDTGM', { Couleur: 'Or blanc', Chaîne: 'Avec' }),
  v('p1', "Puce d'oreille Eclipse", 'PUECGDTGM.', { Couleur: 'Or blanc', Chaîne: 'Sans' }),
  v('p1', "Puce d'oreille Eclipse", 'PUECJDTGM', { Couleur: 'Or jaune', Chaîne: 'Avec' }),
  // One SKU for every colour: the colour tells the refs apart
  v('p2', 'Choker Amanda Shine', 'CHOAM', { Couleur: 'Or blanc', Taille: 'XS' }),
  v('p2', 'Choker Amanda Shine', 'CHOAM', { Couleur: 'Or jaune', Taille: 'XS' }),
  // Gold only on Shopify
  v('p3', 'Alliance Dentelle Brillant', 'ALJJG', { Couleur: 'Or blanc', 'Taille bague': '52' }),
  // Same title twice, only one active
  v('p4', 'Collier Stone', 'COLAG', { Couleur: 'Argent 925' }),
  v('p4', 'Collier Stone', 'COLG', { Couleur: 'Or blanc' }),
  v('p5', 'Collier Stone', 'OLD', { Couleur: 'Argent 925' }, 'ARCHIVED'),
];

test('metal comes from the end of the ref, else from the materials', () => {
  assert.equal(metalOf('HJEECWG1010'), 'or blanc');
  assert.equal(metalOf('HJCREACOCOTTEPG'), 'or rose');
  assert.equal(metalOf('PROTOBAGUE2', [{ name: 'Argent' }]), 'argent');
  assert.equal(metalOf('PROTOBAGUE2'), null);
});

test('build: name + metal pick the SKUs; silver prototype is not linked to gold rings; archived duplicates ignored', () => {
  const rows = buildMapping([
    { ref: 'HJEECWG1010', model: "Puce d’oreille Éclipse " },
    { ref: 'HJNASWG1001', model: 'Choker Amanda Shine' },
    { ref: 'HJNASYG1001', model: 'Choker Amanda Shine' },
    { ref: 'PROTOBAGUE2', model: 'Alliance Dentelle Brillant', materials: [{ name: 'Argent' }] },
    { ref: 'HJNSTAR14001', model: 'Collier Stone', materials: [{ name: 'Argent' }] },
    { ref: 'HJX', model: 'Inconnu' },
  ], catalog);
  const of = (ref: string) => rows.filter((r) => r.ref === ref).map((r) => [r.sku, r.status, r.variant]);
  assert.deepEqual(of('HJEECWG1010'), [['PUECGDTGM', 'auto', 'Or blanc'], ['PUECGDTGM.', 'auto', 'Or blanc']]);
  assert.deepEqual(of('HJNASWG1001'), [['CHOAM', 'auto', 'Or blanc']]);
  assert.deepEqual(of('HJNASYG1001'), [['CHOAM', 'auto', 'Or jaune']]);
  assert.deepEqual(of('PROTOBAGUE2'), [['', 'introuvable', 'pas de variante « argent »']]);
  assert.deepEqual(of('HJNSTAR14001'), [['COLAG', 'auto', 'Argent 925']]);
  assert.equal(of('HJX')[0][1], 'introuvable');
});

test('build: unknown metal on a multi-colour product, or the same SKU+colour for two refs, is a conflict', () => {
  const rows = buildMapping([
    { ref: 'NOMETAL1', model: 'Choker Amanda Shine' },
    { ref: 'HJA1WG1', model: 'Alliance Dentelle Brillant' },
    { ref: 'HJA2WG1', model: 'Alliance Dentelle Brillant' },
  ], catalog);
  assert.deepEqual(rows.map((r) => [r.ref, r.status]), [['HJA1WG1', 'conflit'], ['HJA2WG1', 'conflit'], ['NOMETAL1', 'conflit']]);
});

test('build: rows marked manuel are kept and win', () => {
  const manual = { sku: 'PUECJDTGM', ref: 'CUSTOM', status: 'manuel' as const, shopifyProduct: '', variant: 'Or jaune', erpModel: '' };
  const rows = buildMapping([{ ref: 'HJEECYG1010', model: "Puce d'oreille Eclipse" }, { ref: 'CUSTOM', model: 'x' }], catalog, [manual]);
  assert.deepEqual(rows[0], manual);
  assert.equal(rows.find((r) => r.ref === 'HJEECYG1010')!.status, 'introuvable', 'its only SKU is taken by the manual row');
  assert.equal(rows.filter((r) => r.ref === 'CUSTOM').length, 1);
});

test('CSV round trip (BOM, ";" and quotes) and line resolution by colour', () => {
  const rows = buildMapping([{ ref: 'HJNASWG1001', model: 'Choker Amanda Shine' }, { ref: 'HJNASYG1001', model: 'Choker Amanda Shine' }], catalog);
  rows.push({ sku: 'X;1', ref: 'R"1', status: 'manuel', shopifyProduct: 'a;b', variant: '', erpModel: 'c"d' });
  const back = parseCsv(toCsv(rows));
  assert.deepEqual(back, rows);

  const map = skuMapFrom(back);
  assert.equal(refForLine(map, 'CHOAM', 'Or jaune / XS'), 'HJNASYG1001');
  assert.equal(refForLine(map, 'CHOAM', 'or blanc / XS'), 'HJNASWG1001');
  assert.equal(refForLine(map, 'CHOAM', 'Or rose / XS'), null, 'no row for that colour');
  assert.equal(refForLine(map, 'X;1', null), 'R"1');
  assert.equal(refForLine(map, 'NOPE', null), null);
});

test('conflict / introuvable rows and rows typed by hand without a status', () => {
  const map = skuMapFrom(parseCsv('shopify_sku;jewely_ref;statut\nA;R1;conflit\nB;R2;\nC;;auto\n'));
  assert.deepEqual([...map.keys()], ['B'], 'an empty status counts as manuel; conflicts and empty refs are ignored');
});
