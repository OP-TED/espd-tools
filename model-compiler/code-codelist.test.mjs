// Per-leaf CODE codelist — the generator side.
//
// The CODE value type's codelist VARIES by use (financial-ratio-type / occupation /
// eo-role-type), so it is NOT intrinsic to the value type: it is declared per LEAF in the
// enrichment sidecar, attached by the overlay, and read by the generators. Proven with two
// criteria using DIFFERENT codelists and no compiler change:
//   C34 slc-stand-ratio   -> financial-ratio-type
//   C25 slc-suit-reg-prof -> occupation
//
// (That the published request mapping then expands to the right code list attributes, and
// that a form picks the list up, is checked by the consuming application.)
//
// Usage: node code-codelist.test.mjs

import assert from 'node:assert/strict';
import { loadEdm, loadSidecar, compile } from './compile.mjs';
import { generateRequestMapping } from './generate-request-mapping.mjs';
import { edmPath } from './config.mjs';

const edm = loadEdm(edmPath());
const compileC = (code) => compile(edm, code, loadSidecar(code));
function leafById(criterion, id) {
  let found;
  (function w(n) { for (const c of n.children ?? []) { if (c.id === id) found = c; w(c); } })(criterion);
  return found;
}

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

check('CODE value type carries no intrinsic codelist (codelistFromLeaf)', () => {
  const { registry } = compileC('slc-suit-reg-prof');
  const vt = registry.valueTypes.CODE;
  assert.equal(vt.requestXml.codelistFromLeaf, true);
  assert.equal(vt.requestXml.codelist, undefined);
  assert.equal(vt.instanceShape.codeList, undefined);
});

check('the overlay attaches a per-leaf codelist from the sidecar', () => {
  assert.equal(leafById(compileC('slc-suit-reg-prof').compiled, 'slc-suit-reg-prof.occupation').codelist, 'occupation');
  assert.equal(leafById(compileC('slc-stand-ratio').compiled, 'slc-stand-ratio.ratio-type').codelist, 'financial-ratio-type');
});

check('the SAME value type takes DIFFERENT codelists, resolved per leaf', () => {
  const a = leafById(compileC('slc-suit-reg-prof').compiled, 'slc-suit-reg-prof.occupation');
  const b = leafById(compileC('slc-stand-ratio').compiled, 'slc-stand-ratio.ratio-type');
  assert.equal(a.valueType, 'CODE');
  assert.equal(b.valueType, 'CODE');
  assert.notEqual(a.codelist, b.codelist);
});

check('a CODE leaf with no per-leaf codelist fails fast in request mapping', () => {
  const { compiled, registry } = compileC('slc-suit-reg-prof');
  const stripped = structuredClone(compiled);
  (function w(node) { for (const c of node.children ?? []) { if (c.id === 'slc-suit-reg-prof.occupation') delete c.codelist; w(c); } })(stripped);
  assert.throws(() => generateRequestMapping(stripped, registry), /needs a per-leaf 'codelist'/i);
});

console.log(`\nAll ${n} CODE-codelist generator tests passed.`);
