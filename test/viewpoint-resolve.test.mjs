import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveViewpoint, lockSource } from '../src/features/configurator/viewpoint-resolve.js';

const T = { theta: 1, phi: 1, r: 1, tgt: [0, 0, 0] };
const S = { theta: 2, phi: 1, r: 2, tgt: [0, 0, 0] };
const D = { theta: 3, phi: 1, r: 3, tgt: [0, 0, 0] };

test('tenant lock wins over global and default', () => {
  assert.equal(resolveViewpoint('chair', { chair: T }, { chair: S }, { chair: D }), T);
  assert.equal(lockSource('chair', { chair: T }, { chair: S }, { chair: D }), 'tenant');
});

test('global S3 lock wins over shipped default', () => {
  assert.equal(resolveViewpoint('chair', {}, { chair: S }, { chair: D }), S);
  assert.equal(lockSource('chair', {}, { chair: S }, { chair: D }), 'published');
});

test('falls through to shipped default, then null/none', () => {
  assert.equal(resolveViewpoint('chair', {}, {}, { chair: D }), D);
  assert.equal(lockSource('chair', {}, {}, { chair: D }), 'default');
  assert.equal(resolveViewpoint('sofa', {}, {}, {}), null);
  assert.equal(lockSource('sofa', {}, {}, {}), 'none');
});
