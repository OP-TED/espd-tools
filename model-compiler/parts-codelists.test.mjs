// Enum sync of the administrative parts: every field of a part's instance-data schema that names a code
// list (`$codelist`) agrees with the shipped .gc file and with the codelist-governance registry.
//
// The parts are authored (enrichment/parts/<part>/section<L>.schema.json), so nothing derives their enums
// from the code lists. This test is what keeps them honest, for every field, instead of one hand-written
// assertion per field in each consumer:
//   - the name resolves to a registry entry (by name or alias);
//   - a field with an `enum` has a registry entry that is shipped and inlined, and the enum is exactly the
//     .gc codes minus the registry's `excludedCodes`;
//   - a field without an `enum` is a list the registry does not inline, or one that is not shipped (the
//     enum cannot be derived without a .gc, so it is carried by name);
//   - `$codelistEnumIsImplementerChoice`, when present, is true exactly for an inlined list the Schematron
//     does not validate (the only coupling between inlining and validation, see the governance doc).
//
// Usage: node parts-codelists.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { enrichmentFile } from './config.mjs';
import { codelistPath, readCodelistCodes } from './read-codelist.mjs';

/**
 * Problems of one schema node that carries `$codelist`. `entry` is its governance entry (or undefined),
 * `gcCodes` the codes of its .gc (or undefined when the list is not shipped).
 */
export function checkCodelistField(node, entry, gcCodes) {
  const name = node.$codelist;
  if (!entry) return [`$codelist "${name}" is not in the codelist-governance registry (name or alias)`];
  const problems = [];
  const hasEnum = Array.isArray(node.enum);
  if (hasEnum) {
    if (!entry.gc || !gcCodes) {
      problems.push(`"${name}" has an enum but is not shipped, so the enum cannot be checked against a .gc`);
    } else {
      if (!entry.inlineEnum) problems.push(`"${name}" has an enum but the registry says inlineEnum is false`);
      const excluded = new Set(entry.excludedCodes ?? []);
      const expected = gcCodes.filter(c => !excluded.has(c)).sort();
      const actual = [...node.enum].sort();
      const missing = expected.filter(c => !actual.includes(c));
      const extra = actual.filter(c => !expected.includes(c));
      if (missing.length || extra.length) {
        problems.push(`"${name}" enum differs from ${entry.gc} minus excludedCodes` +
          (missing.length ? `; missing: ${missing.join(', ')}` : '') + (extra.length ? `; not in the list or excluded: ${extra.join(', ')}` : ''));
      }
    }
  } else if (entry.inlineEnum && entry.gc) {
    problems.push(`"${name}" is shipped and inlineEnum is true in the registry, but the field has no enum`);
  }
  if ('$codelistEnumIsImplementerChoice' in node) {
    const expectedMarker = hasEnum && !entry.schematronValidated;
    if (node.$codelistEnumIsImplementerChoice !== expectedMarker) {
      problems.push(`"${name}": $codelistEnumIsImplementerChoice is ${node.$codelistEnumIsImplementerChoice}, expected ${expectedMarker} (inlined and not validated)`);
    }
  } else if (hasEnum && !entry.schematronValidated) {
    problems.push(`"${name}": an inlined list that the Schematron does not validate needs $codelistEnumIsImplementerChoice: true`);
  }
  return problems;
}

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

// --- the rule itself, on synthetic input ---------------------------------------------------------------
const entry = (over = {}) => ({ gc: 'X.gc', schematronValidated: true, inlineEnum: true, ...over });
const codes = ['A', 'B', 'C'];

check('an enum equal to the .gc codes is accepted; order does not matter', () => {
  assert.deepEqual(checkCodelistField({ $codelist: 'x', enum: ['C', 'A', 'B'] }, entry(), codes), []);
});

check('excludedCodes are taken out of the expected enum', () => {
  assert.deepEqual(checkCodelistField({ $codelist: 'x', enum: ['A', 'B'] }, entry({ excludedCodes: ['C'] }), codes), []);
  assert.match(checkCodelistField({ $codelist: 'x', enum: ['A', 'B', 'C'] }, entry({ excludedCodes: ['C'] }), codes).join(), /not in the list or excluded: C/);
});

check('a missing code, an extra code and an unknown list are reported', () => {
  assert.match(checkCodelistField({ $codelist: 'x', enum: ['A', 'B'] }, entry(), codes).join(), /missing: C/);
  assert.match(checkCodelistField({ $codelist: 'x', enum: ['A', 'B', 'C', 'Z'] }, entry(), codes).join(), /not in the list or excluded: Z/);
  assert.match(checkCodelistField({ $codelist: 'nope' }, undefined, undefined).join(), /not in the codelist-governance registry/);
});

check('an enum needs the registry to inline the list and the list to be shipped', () => {
  assert.match(checkCodelistField({ $codelist: 'x', enum: codes }, entry({ inlineEnum: false }), codes).join(), /inlineEnum is false/);
  assert.match(checkCodelistField({ $codelist: 'x', enum: codes }, entry({ gc: undefined }), undefined).join(), /not shipped/);
});

check('a field without an enum: fine for a list the registry does not inline or that is not shipped, an error otherwise', () => {
  assert.deepEqual(checkCodelistField({ $codelist: 'x' }, entry({ inlineEnum: false }), codes), []);
  assert.deepEqual(checkCodelistField({ $codelist: 'x' }, entry({ gc: undefined, schematronValidated: false }), undefined), [], 'not shipped: carried by name');
  assert.match(checkCodelistField({ $codelist: 'x' }, entry(), codes).join(), /has no enum/);
});

check('the implementer-choice marker is true only for an inlined list that is not validated', () => {
  const unvalidated = entry({ schematronValidated: false });
  assert.deepEqual(checkCodelistField({ $codelist: 'x', enum: codes, $codelistEnumIsImplementerChoice: true }, unvalidated, codes), []);
  assert.match(checkCodelistField({ $codelist: 'x', enum: codes }, unvalidated, codes).join(), /needs \$codelistEnumIsImplementerChoice: true/);
  assert.match(checkCodelistField({ $codelist: 'x', enum: codes, $codelistEnumIsImplementerChoice: false }, unvalidated, codes).join(), /expected true/);
  assert.match(checkCodelistField({ $codelist: 'x', enum: codes, $codelistEnumIsImplementerChoice: true }, entry(), codes).join(), /expected false/);
  assert.deepEqual(checkCodelistField({ $codelist: 'x', enum: codes, $codelistEnumIsImplementerChoice: false }, entry(), codes), []);
});

// --- the real parts -------------------------------------------------------------------------------------
const { codelists } = JSON.parse(fs.readFileSync(enrichmentFile('registries', 'codelist-governance.json'), 'utf8'));
const byName = new Map();
for (const [name, e] of Object.entries(codelists)) for (const alias of [name, ...(e.aliases ?? [])]) byName.set(alias.toLowerCase(), e);

const fields = []; // { where, node }
const partsDir = enrichmentFile('parts');
for (const part of fs.readdirSync(partsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
  for (const file of fs.readdirSync(path.join(partsDir, part)).filter(f => f.endsWith('.schema.json')).sort()) {
    const schema = JSON.parse(fs.readFileSync(path.join(partsDir, part, file), 'utf8'));
    const walk = (node, trail) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$codelist === 'string') fields.push({ where: `parts/${part}/${file} ${trail.join('.')}`, node });
      for (const [k, v] of Object.entries(node)) walk(v, [...trail, k]);
    };
    walk(schema, []);
  }
}

check('the parts have code list fields to check', () => {
  assert.ok(fields.length >= 5, `found only ${fields.length} $codelist fields in ${partsDir}`);
});

check('every code list field of the parts agrees with its .gc and the governance registry', () => {
  const problems = [];
  for (const { where, node } of fields) {
    const e = byName.get(node.$codelist.toLowerCase());
    let gcCodes;
    if (e?.gc) {
      const file = codelistPath(e.gc);
      assert.ok(fs.existsSync(file), `${where}: ${e.gc} not found at ${file}`);
      gcCodes = readCodelistCodes(file);
    }
    for (const p of checkCodelistField(node, e, gcCodes)) problems.push(`${where}: ${p}`);
  }
  assert.deepEqual(problems, []);
});

console.log(`\nAll ${n} parts-codelists tests passed.`);
