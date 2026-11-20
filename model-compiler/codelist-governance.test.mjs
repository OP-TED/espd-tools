// Checks the codelist-governance registry (espd-conceptual-model/enrichment/registries/
// codelist-governance.json) against the things it describes: the shipped code lists, the
// Schematron CVA, and what the compiler really publishes.
//
// The registry is hand-authored. Its schema and internal consistency are checked by the
// enrichment validator; this test needs the real inputs, so it lives with the compiler:
//   - every `gc` file exists, and an unshipped list resolves to no .gc by name or alias;
//   - every .gc in the code list folder has an entry (a new shipped list must be recorded);
//   - `excludedCodes` are codes the .gc really contains;
//   - `schematronValidated` matches the CVA ValueList declarations (skipped, with a note, if the
//     espd-validation-schematron checkout is not available);
//   - every codelist used by a value type, a criterion leaf or the codelist-attribute profile has
//     an entry;
//   - `inlineEnum` matches what the compiler actually publishes, for every list a criterion uses.
//
// Usage: node codelist-governance.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadEdm, loadSidecar, listModeledCodes, compile } from './compile.mjs';
import { generateInstanceSchema } from './generate-instance-schema.mjs';
import { edmPath, enrichmentFile, codelistsDir, schematronRoot } from './config.mjs';
import { codelistPath, gcFileForCodelist, readCodelistCodes } from './read-codelist.mjs';

const { codelists } = JSON.parse(fs.readFileSync(enrichmentFile('registries', 'codelist-governance.json'), 'utf8'));
const byName = new Map(); // lower-case name or alias -> [canonical name, entry]
for (const [name, e] of Object.entries(codelists)) for (const n of [name, ...(e.aliases ?? [])]) byName.set(n.toLowerCase(), [name, e]);

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

check('every gc file exists, and an unshipped list resolves to no .gc', () => {
  for (const [name, e] of Object.entries(codelists)) {
    if (e.gc) {
      assert.ok(fs.existsSync(codelistPath(e.gc)), `${name}: gc '${e.gc}' not found in ${codelistsDir()}`);
    } else {
      const resolved = [name, ...(e.aliases ?? [])].map(gcFileForCodelist).find(Boolean);
      assert.ok(!resolved, `${name}: not shipped in the registry, but ${resolved} resolves; add gc`);
    }
  }
});

check('every .gc in the code list folder has an entry', () => {
  const named = new Set(Object.values(codelists).map(e => e.gc).filter(Boolean));
  const unrecorded = fs.readdirSync(codelistsDir()).filter(f => f.endsWith('.gc') && !named.has(f));
  assert.deepEqual(unrecorded, [], `shipped code lists missing from the governance registry: ${unrecorded.join(', ')}`);
});

check('excludedCodes are codes the .gc really contains', () => {
  for (const [name, e] of Object.entries(codelists)) {
    if (!e.excludedCodes) continue;
    const codes = new Set(readCodelistCodes(codelistPath(e.gc)));
    for (const c of e.excludedCodes) assert.ok(codes.has(c), `${name}: excluded code '${c}' is not in ${e.gc}`);
    assert.ok(codes.size > e.excludedCodes.length, `${name}: every code is excluded`);
  }
});

const CVA = path.join(schematronRoot(), 'common', 'cva', '01-ESPD-codelist-values.cva');
if (fs.existsSync(CVA)) {
  check('`schematronValidated` matches the CVA ValueList declarations', () => {
    const ids = new Set([...fs.readFileSync(CVA, 'utf8').matchAll(/<ValueList\s+xml:id="([^"]+)"/g)].map(m => m[1].toLowerCase()));
    for (const [name, e] of Object.entries(codelists)) {
      const inCva = [name, ...(e.aliases ?? [])].some(x => ids.has(x.toLowerCase()));
      assert.equal(e.schematronValidated, inCva,
        `${name}: schematronValidated=${e.schematronValidated} but CVA ValueList present=${inCva}${e.aliases ? ` (aliases: ${e.aliases.join(', ')})` : ''}`);
    }
  });
} else {
  console.log(`- skipped: schematronValidated vs the CVA (no espd-validation-schematron checkout at ${schematronRoot()})`);
}

check('every codelist used by a value type, a criterion leaf or the attribute profile has an entry', () => {
  const used = new Set();
  const vt = JSON.parse(fs.readFileSync(enrichmentFile('registries', 'value-types.json'), 'utf8')).valueTypes;
  const collect = (shape) => {
    if (!shape || typeof shape !== 'object') return;
    if (shape.codeList) used.add(shape.codeList);
    if (shape.properties) for (const v of Object.values(shape.properties)) collect(v);
    if (shape.items) collect(shape.items);
  };
  for (const def of Object.values(vt)) {
    collect(def.instanceShape);
    if (def.requestXml?.codelist) used.add(def.requestXml.codelist);
    if (def.responseXml?.codelist) used.add(def.responseXml.codelist);
  }
  for (const code of listModeledCodes()) {
    for (const m of fs.readFileSync(enrichmentFile('criteria', `${code}.sidecar.json`), 'utf8').matchAll(/"codelist"\s*:\s*"([^"]+)"/g)) used.add(m[1]);
  }
  const prof = JSON.parse(fs.readFileSync(enrichmentFile('registries', 'codelist-attributes.json'), 'utf8')).codelists;
  for (const key of Object.keys(prof)) if (key !== 'criterion-id') used.add(key); // 'criterion-id' is a UBL scheme, not a codelist
  const missing = [...used].filter(x => !byName.has(x.toLowerCase()));
  assert.deepEqual(missing, [], `codelists used but absent from the governance registry: ${missing.join(', ')}`);
});

check('`inlineEnum` matches what the compiler publishes, for every list a criterion uses', () => {
  const PART = { partI: 'I', partII: 'II', partIII: 'III', partIV: 'IV', partV: 'V', partVI: 'VI' };
  const edm = loadEdm(edmPath());
  const seen = new Map(); // canonical name -> { inlined: bool, in: first criterion }
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.forEach(x => walk(x, key));
    if (!node || typeof node !== 'object') return;
    if (typeof node.codeList === 'string') {
      const hit = byName.get(node.codeList.toLowerCase());
      if (hit) {
        const [canonical] = hit;
        const inlined = Array.isArray(node.enum);
        const prev = seen.get(canonical);
        if (prev && prev.inlined !== inlined) assert.fail(`${canonical} is inlined in ${prev.in} but not in ${key}: the compiler must treat one list one way`);
        if (!prev) seen.set(canonical, { inlined, in: key });
      }
    }
    for (const v of Object.values(node)) walk(v, key);
  };
  for (const code of listModeledCodes()) {
    const sidecar = loadSidecar(code);
    const { compiled, registry } = compile(edm, code, sidecar);
    const hints = fs.existsSync(enrichmentFile('criteria', `${code}.hints.json`)) ? JSON.parse(fs.readFileSync(enrichmentFile('criteria', `${code}.hints.json`), 'utf8')) : null;
    walk(generateInstanceSchema(compiled, registry, { partId: PART[sidecar.criterion.instanceModel.containerPath[0]], hints, outputId: code }), code);
  }
  assert.ok(seen.size >= 4, `expected criteria to use several code lists, saw ${seen.size}`);
  for (const [name, { inlined, in: where }] of seen) {
    assert.equal(codelists[name].inlineEnum, inlined,
      `${name}: registry says inlineEnum=${codelists[name].inlineEnum} but the compiler ${inlined ? 'inlines' : 'does not inline'} it (e.g. in ${where})`);
  }
  console.log(`    lists used by criteria: ${[...seen].map(([k, v]) => `${k}${v.inlined ? '*' : ''}`).join(', ')}  (* = inlined)`);
});

console.log(`\nAll ${n} codelist-governance checks passed.`);
