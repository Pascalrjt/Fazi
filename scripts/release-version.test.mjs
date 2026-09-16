import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseVersion, replaceCargoVersion } from './release-version.mjs';

test('increments the highest release version numerically', () => {
  assert.equal(chooseVersion('0.7.0', ['v0.7.9', 'v0.7.10', 'other'], []), '0.7.11');
  assert.equal(chooseVersion('0.8.0', ['v0.7.10'], []), '0.8.1');
  assert.equal(chooseVersion('0.7.0', [], []), '0.7.1');
});

test('reruns reuse the reserved version even after later releases', () => {
  assert.equal(chooseVersion('0.7.0', ['v0.7.1', 'v0.7.2'], ['v0.7.1']), '0.7.1');
});

test('rejects ambiguous tags and unsupported base versions', () => {
  assert.throws(() => chooseVersion('0.7.0', [], ['v0.7.1', 'v0.7.2']));
  assert.throws(() => chooseVersion('0.7.0-beta.1', [], []));
});

test('updates only the app version in Cargo.lock', () => {
  const content = 'version = 4\n\n[[package]]\nname = "fazi"\nversion = "0.7.0"\n\n[[package]]\nname = "other"\nversion = "1.2.3"\n';
  const section = /\[\[package\]\]\nname = "fazi"\n[\s\S]*?(?=\n\[\[package\]\]|$)/g;
  const updated = replaceCargoVersion(content, section, '0.7.1');
  assert.equal(updated, content.replace('version = "0.7.0"', 'version = "0.7.1"'));
  assert.equal(replaceCargoVersion(updated, section, '0.7.1'), updated);
  assert.throws(() => replaceCargoVersion('', section, '0.7.1'));
});
