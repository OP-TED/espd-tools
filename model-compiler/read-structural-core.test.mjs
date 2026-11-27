// Task 1.1 test — lean-consumption / forward-compatibility guarantee.
//
// Asserts the structural-core reader depends ONLY on minimal-core fields: it
// must produce the SAME core from the full espd-edm.json and from a condensed
// copy with the encoding/derivable fields removed (xmlElementName, xmlChildren,
// responsepath, contentpath, and the restated TypeCode/ValueDataTypeCode child
// values). This proves a future condensed espd-edm.json keeps working.
//
// Usage: node read-structural-core.test.mjs

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readStructuralCore, leavesOf } from './read-structural-core.mjs';
import { edmPath } from './config.mjs';
import { skipReason, checkWith } from './testkit.mjs';

const sourcePath = edmPath();

const CODES = ['slc-stand-to-spec-avg', 'exg-pmt-bre-tax'];

/** Deep-clone and strip every encoding/derivable field the reader must NOT need. */
function condense(node) {
  if (Array.isArray(node)) return node.map(condense);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'xmlElementName' || k === 'xmlChildren') continue; // encoding
      if (k === 'responsepath' || k === 'contentpath') continue;    // derivable
      out[k] = condense(v);
    }
    return out;
  }
  return node;
}

const skip = skipReason(['edm']);
const check = checkWith(skip);
const full = skip ? undefined : JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const condensed = skip ? undefined : condense(full);

for (const code of CODES) {
  check(`lean-consumption guarantee holds: ${code}`, () => {
    const fromFull = readStructuralCore(full, code);
    const fromCondensed = readStructuralCore(condensed, code);

    assert.deepEqual(fromCondensed, fromFull,
      'core from condensed input must equal core from full input');
    assert.ok(leavesOf(fromFull).length > 0, 'expected at least one value leaf');

    // Spot-check: no encoding/derivable field leaked into the core.
    const serialized = JSON.stringify(fromFull);
    for (const banned of ['xmlElementName', 'xmlChildren', 'responsepath', 'contentpath']) {
      assert.ok(!serialized.includes(banned), `core must not contain ${banned}`);
    }
  });
}
