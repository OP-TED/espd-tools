// Task 2.1 test — value-type registry validation + provenance.
//
// Usage: node value-type-registry.test.mjs

import fs from 'node:fs';
import assert from 'node:assert/strict';
import { readStructuralCore } from './read-structural-core.mjs';
import {
  loadRegistry, validateRegistry, loadValidatedRegistry,
  validateCriterionValueTypes, parseGenericode,
} from './value-type-registry.mjs';
import { edmPath, codelistFile } from './config.mjs';
import { skipReason, checkWith, expectThrowWith, COMPILER_INPUTS } from './testkit.mjs';

const skip = skipReason(COMPILER_INPUTS);

const sourcePath = edmPath();
const { edm } = skip ? {} : (() => {
  const edm = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  return { edm };
})();

const check = checkWith(skip);
const expectThrow = expectThrowWith(skip);

// Registry validates cleanly against ResponseDataType.gc, with correct provenance.
check('registry validates against ResponseDataType.gc; provenance = 5.0.0', () => {
  const { provenance, registry } = loadValidatedRegistry();
  assert.equal(provenance.shortName, 'ResponseDataType');
  assert.equal(provenance.version, '5.0.0');
  assert.ok(Object.keys(registry.valueTypes).length >= 10);
});

// Every value type C31 uses is defined in the registry.
check('all C31 value types are defined in the registry', () => {
  const core = readStructuralCore(edm, 'slc-stand-to-spec-avg');
  const { registry } = loadValidatedRegistry();
  validateCriterionValueTypes(core, registry); // throws if any unknown
});

// Fail: a tampered description is rejected.
expectThrow('wrong sourceDescription is rejected', () => {
  const loaded = loadRegistry();
  loaded.registry.valueTypes.INDICATOR.sourceDescription = 'totally wrong';
  validateRegistry(loaded);
}, 'description differs');

// Fail: an unknown value type code is rejected.
expectThrow('unknown value-type code is rejected', () => {
  const loaded = loadRegistry();
  loaded.registry.valueTypes.NOT_A_REAL_TYPE = { sourceDescription: 'x', instanceShape: {} };
  validateRegistry(loaded);
}, 'absent from ResponseDataType.gc');

// Fail: a criterion using an undefined value type is reported.
expectThrow('criterion using an undefined value type is reported', () => {
  const core = readStructuralCore(edm, 'slc-stand-to-spec-avg');
  const { registry } = loadValidatedRegistry();
  const stripped = structuredClone(registry);
  delete stripped.valueTypes.MINIMUM_AMOUNT;
  validateCriterionValueTypes(core, stripped);
}, 'Unknown value types');

// Genericode parser sanity.
check('genericode parser extracts ACTIVE rows', () => {
  const { gcRows } = { gcRows: parseGenericode(fs.readFileSync(
    codelistFile('ResponseDataType.gc'), 'utf8')) };
  assert.equal(gcRows.get('INDICATOR')?.get('status'), 'ACTIVE');
});
