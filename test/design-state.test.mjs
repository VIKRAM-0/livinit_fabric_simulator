// test/design-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ds = await import('../src/lib/design-state.js');

const LIB = [
  { group: 'My Fabrics', vendor: 'Uploaded', items: [] },
  { group: 'Kimono', vendor: '', items: [{ name: 'Aragon', hex: '#803020', series: 'Kimono' }] },
];
const CUSTOMS = [{ name: 'Navy Linen', vendor: 'custom', series: 'My Fabrics', img: 'data:image/jpeg;base64,xx', _defaults: { diffUrl: 'data:image/jpeg;base64,xx' } }];

test('findFabricRef prefers custom items, embeds by value', () => {
  const ref = ds.findFabricRef('Navy Linen', LIB, CUSTOMS);
  assert.equal(ref.kind, 'custom');
  assert.equal(ref.item.name, 'Navy Linen');
  assert.notEqual(ref.item, CUSTOMS[0]); // copied, not aliased
});

test('findFabricRef resolves catalog items by name+group', () => {
  assert.deepEqual(ds.findFabricRef('Aragon', LIB, CUSTOMS), { kind: 'lib', name: 'Aragon', group: 'Kimono' });
  assert.equal(ds.findFabricRef('Nope', LIB, CUSTOMS), null);
});

test('resolveFabricRef round-trips both kinds', () => {
  const libRef = ds.findFabricRef('Aragon', LIB, CUSTOMS);
  assert.equal(ds.resolveFabricRef(libRef, LIB, CUSTOMS).hex, '#803020');
  const cusRef = ds.findFabricRef('Navy Linen', LIB, CUSTOMS);
  assert.equal(ds.resolveFabricRef(cusRef, LIB, []).name, 'Navy Linen'); // resolves from the embedded copy
  assert.equal(ds.resolveFabricRef({ kind: 'lib', name: 'Gone', group: 'X' }, LIB, CUSTOMS), null);
});

test('defaultDesignState nulls every part and uses factory sliders', () => {
  const s = ds.defaultDesignState('chair', ['Frame', 'Seat']);
  assert.equal(s.v, 1);
  assert.deepEqual(s.parts, { Frame: null, Seat: null });
  assert.equal(s.sliders.roughness, 0.72);
  assert.equal(s.baseColorHex, '#ffffff');
  assert.equal(s.curtain.shape, 'drape');
});

test('fingerprint ignores custom-item payload churn but sees real changes', () => {
  const a = ds.defaultDesignState('chair', ['Seat']);
  const b = ds.defaultDesignState('chair', ['Seat']);
  a.parts.Seat = { kind: 'custom', item: { ...CUSTOMS[0] } };
  b.parts.Seat = { kind: 'custom', item: { ...CUSTOMS[0], img: 'data:image/jpeg;base64,DIFFERENT' } };
  assert.equal(ds.fingerprintDesignState(a), ds.fingerprintDesignState(b)); // same name → same design
  b.parts.Seat = { kind: 'lib', name: 'Aragon', group: 'Kimono' };
  assert.notEqual(ds.fingerprintDesignState(a), ds.fingerprintDesignState(b));
  b.parts.Seat = a.parts.Seat; b.sliders = { ...b.sliders, roughness: 0.1 };
  assert.notEqual(ds.fingerprintDesignState(a), ds.fingerprintDesignState(b));
});
