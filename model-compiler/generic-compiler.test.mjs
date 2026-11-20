// The compiler stays generic: NO criterion code may appear in the LOGIC of any
// transformation module, and none may hard-code a part container.
//
// The durable, self-maintaining form of the guarantee "adding a criterion needs only
// data files" (a sidecar in the enrichment folder). It
//   - DISCOVERS the transformation modules by globbing this folder and excluding tests and
//     infrastructure, so a NEW generator module is covered automatically; and
//   - DISCOVERS the modeled criteria from the sidecar file names in the enrichment folder,
//     so a NEW criterion is covered automatically.
//
// Infrastructure modules (CLI/build loop, loaders, validators, publishing) carry no
// per-criterion branching and may legitimately mention a criterion in a usage example.
//
// Usage: node generic-compiler.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModeledCodes } from './compile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Keep this list TIGHT: anything with per-node transformation logic must NOT be here.
// Default to NOT excluding a new module; only add it if it is a pure loader / validator /
// CLI with no per-node branching, and say why.
const INFRA = new Set([
  'build.mjs',                 // CLI + build loop; maps a part container to a part id by design
  'compile.mjs',               // loaders + the join; discovers criteria from sidecar file names
  'config.mjs',                // input locations
  'envelope.mjs',              // envelope assembly + hashing
  'publish.mjs',               // registries / schema / README of the published folder
  'verify.mjs',                // verifies a published folder
  'read-codelist.mjs',         // Genericode reader
  'value-type-registry.mjs',   // loads/validates value-types.json vs ResponseDataType.gc
  'codelist-attributes.mjs',   // loads/validates codelist-attributes.json vs the Schematron
  'structural-equivalence.mjs', // the EA-projection correctness gate (no per-node shaping)
]);

const transformationModules = () => fs.readdirSync(here)
  .filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs') && !INFRA.has(f)).sort();

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

const modules = transformationModules();
const codes = listModeledCodes();

check('the discovery sets are non-trivial (guards the guard)', () => {
  assert.ok(modules.length >= 5, `expected to discover the transformation modules, got ${modules.join(', ')}`);
  assert.ok(codes.length >= 5, `expected to discover modeled criteria, got ${codes.length}`);
});

check("no modeled criterion code appears in any transformation module's logic", () => {
  for (const file of modules) {
    const logic = stripComments(fs.readFileSync(path.join(here, file), 'utf8'));
    for (const code of codes) {
      assert.ok(!logic.includes(code), `${file} logic must not name criterion '${code}' — adding a criterion must need data files only`);
    }
  }
});

check('no transformation module hard-codes a part container key', () => {
  const partKeys = ['partI', 'partII', 'partIII', 'partIV', 'partV', 'partVI'];
  for (const file of modules) {
    const logic = stripComments(fs.readFileSync(path.join(here, file), 'utf8'));
    for (const key of partKeys) {
      assert.ok(!new RegExp(`['"]${key}['"]`).test(logic), `${file} logic must not hard-code the part container '${key}'`);
    }
  }
});

console.log(`\nAll ${n} generic-compiler checks passed (${modules.length} modules, ${codes.length} criteria).`);
