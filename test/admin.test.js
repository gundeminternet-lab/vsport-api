import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAdjust } from '../admin.js';

test('token düzeltme doğrulaması', () => {
  assert.doesNotThrow(() => validateAdjust({ delta: 100, reason: 'Kampanya ödülü' }));
  assert.doesNotThrow(() => validateAdjust({ delta: -50, reason: 'İade düzeltmesi' }));
  for (const bad of [{ delta: 0, reason: 'xxx' }, { delta: 1.5, reason: 'xxx' }, { delta: 200000, reason: 'xxx' }, { delta: 5, reason: 'x' }]) {
    assert.throws(() => validateAdjust(bad), (e) => e.code === 'invalid-argument');
  }
});
