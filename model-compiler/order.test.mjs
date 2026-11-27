// One ordering for every emitted list: code-point order, independent of the machine's locale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compareCodePoint } from './order.mjs';
import { buildEnvelope } from './envelope.mjs';

test('upper case sorts before lower case and a shorter prefix before a longer string', () => {
  assert.deepEqual(['b', 'A', 'a', 'B', 'ab', 'a-b'].sort(compareCodePoint), ['A', 'B', 'a', 'a-b', 'ab', 'b']);
  assert.equal(compareCodePoint('a', 'a'), 0);
  assert.equal(compareCodePoint('a', 'ab'), -1);
  assert.equal(compareCodePoint('ab', 'a'), 1);
});

test('it differs from localeCompare exactly where a locale would reorder', () => {
  // localeCompare orders a before A before b; code points order A before a before b.
  assert.deepEqual(['b', 'a', 'A'].sort(compareCodePoint), ['A', 'a', 'b']);
});

test('astral characters compare by code point, not by UTF-16 code unit', () => {
  const emoji = '\u{1F600}'; // two UTF-16 units starting with a high surrogate (0xD83D)
  const high = '\uFFFF';
  assert.ok(compareCodePoint(emoji, high) > 0, 'U+1F600 is after U+FFFF');
  assert.ok(emoji < high, 'the default string comparison would say the opposite');
});

test('the envelope lists criteria within a part in code-point order', () => {
  const sha = 'a'.repeat(64);
  const entry = (key) => ({ key, id: key, code: key, part: 'III', leaves: 1, repeatableBindings: 0, valueTypes: [], files: {} });
  const envelope = buildEnvelope({
    espdVersion: '5.0.0', ublVersion: '2.4',
    provenance: { generator: { name: 'x', version: '1' }, structure: { file: 'f', sha256: sha }, enrichment: { sha256: sha, files: 1 }, valueTypeSource: { shortName: 'R', version: '1' } },
    entries: [entry('b-x'), entry('A-y'), entry('a-z'), entry('B-w')],
    valueTypeRegistry: { valueTypes: { b: {}, A: {}, a: {} } },
    registries: ['registries/b.json', 'registries/A.json'],
    parts: [],
  });
  assert.deepEqual(envelope.criteria.map((c) => c.key), ['A-y', 'B-w', 'a-z', 'b-x']);
  assert.deepEqual(envelope.valueTypes.map((v) => v.name), ['A', 'a', 'b']);
  assert.deepEqual(envelope.registries, ['registries/A.json', 'registries/b.json']);
});
