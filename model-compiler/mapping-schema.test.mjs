// The schema of the mapping format (schema/mapping.schema.json): what it accepts, what it rejects, and that
// everything the compiler generates, and the hand-authored mappings of the parts, follow it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateMapping, mappingSchemaPath } from './mapping-schema.mjs';
import { loadEdm, loadSidecar, listModeledCodes, compile, generateMappings } from './compile.mjs';
import { edmPath, enrichmentFile } from './config.mjs';
import { listParts } from './parts.mjs';
import { skipReason, COMPILER_INPUTS } from './testkit.mjs';

const target = { root: 'Doc', namespaces: { '': 'urn:x', cbc: 'urn:cbc' } };
const spec = (...rules) => ({ target, rules });
const problemsOf = (...rules) => validateMapping(spec(...rules));

// ---------------------------------------------------------------------------------------------------------
// what it accepts
// ---------------------------------------------------------------------------------------------------------

test('the schema compiles in strict mode (a consumer can use it with a strict validator)', () => {
  assert.deepEqual(validateMapping(spec()), []);
  assert.ok(JSON.parse(fs.readFileSync(mappingSchemaPath, 'utf8')).$id.endsWith('/model/schema/mapping.schema.json'));
});

test('a value rule, with attributes of every kind and a guard', () => {
  assert.deepEqual(problemsOf(
    { from: 'a.b', to: 'cbc:ID' },
    { const: 'x', to: 'cbc:Name' },
    { from: 'a.c', const: 'fallback', to: 'cbc:Note', attributes: { listID: 'code', n: 3, flag: true }, when: { path: 'a.kind', equals: 'x' } },
    { from: 'a.d', to: 'cbc:Code', attributes: { currencyID: { from: 'a.currency' } } },
  ), []);
});

test('an attribute derived with fromMap, as published (a profile) and as an engine runs it (the map)', () => {
  assert.deepEqual(problemsOf(
    { from: 'a', to: 'cbc:ID', attributes: { schemeAgencyID: { fromMap: { profile: 'identifier-scheme-agency' } } } },
    { from: 'a', to: 'cbc:ID', attributes: { schemeAgencyID: { fromMap: { path: 'a.scheme', profile: 'identifier-scheme-agency' } } } },
    { from: 'a', to: 'cbc:ID', attributes: { schemeAgencyID: { fromMap: { path: 'a.scheme', map: { VAT: 'VIES' }, default: 'OP' } } } },
  ), []);
});

test('a forEach rule with fields, with a scalar item path and with a bare scalar', () => {
  assert.deepEqual(problemsOf(
    { forEach: 'a.list', to: 'cac:Item', item: { fields: [{ from: 'name', to: 'cbc:Name' }] } },
    { forEach: 'a.lots', to: 'cac:Lot', item: { path: 'cbc:ID' } },
    { forEach: 'a.tags', to: 'cbc:Tag' },
  ), []);
});

test('a records rule in each of its forms', () => {
  const key = { to: 'cbc:ID', attributes: { schemeID: 'criterion' } };
  assert.deepEqual(problemsOf(
    // fixed entries: a value, an object and references
    { records: 'cac:Response', key, entries: [
      { key: 'K1', value: { from: 'a.value', to: 'cbc:Value', type: 'number', attributes: { unitCode: 'YEAR', currencyID: { from: 'a.cur' } } } },
      { key: 'K2', object: { from: 'a.period', to: 'cac:Period', fields: [{ from: 'start', to: 'cbc:StartDate' }] } },
      { key: 'K3', references: { forEach: 'a.docs', key: 'id', to: 'cac:Supplied/cbc:ID', resolve: { records: 'cac:Evidence', key: { to: 'cbc:ID', from: 'id' }, fields: [{ from: 'name', to: 'cbc:Name' }] } } },
    ] },
    // entries once per item, with a nested array
    { records: 'cac:Response', key, forEach: 'a.items', entries: [{ key: 'K1', value: { from: 'v', to: 'cbc:Value' } }],
      childRecords: [{ records: 'cac:Response', key, forEach: 'sub', entries: [{ key: 'K9', value: { from: 'v', to: 'cbc:Value' } }] }] },
    // aggregate: one record per item
    { records: 'cac:Evidence', key: { to: 'cbc:ID', from: 'id' }, forEach: 'a.evidence', item: { fields: [{ from: 'id', to: 'cbc:ID' }, { from: 'name', to: 'cbc:Name' }] }, importVia: 'references' },
    // scalar items with a fixed key
    { records: 'cac:Property', key: { to: 'cbc:ID', key: 'LOT' }, forEach: 'a.lots', item: { path: 'cbc:ExpectedID', attributes: { schemeID: 'criterion' } } },
  ), []);
});

test('a structure rule: containers, constants, bound leaves, repeated elements and a value map', () => {
  assert.deepEqual(problemsOf({
    structure: {
      element: 'cac:TenderingCriterion',
      attributes: { x: 'y' },
      children: [
        { element: 'cbc:ID', const: 'C01' },
        { element: 'cbc:Name', from: 'a.name', type: 'string' },
        { element: 'cbc:Flag', from: 'a.flag', type: 'boolean', valueMap: { true: 'CHECK_BOX_TRUE', false: 'CHECK_BOX_FALSE' } },
        { element: 'cac:Lot', forEach: 'a.lots', children: [{ element: 'cbc:ID', fromItem: '.' }] },
      ],
    },
  }), []);
});

test('a comment-only rule is a placeholder and is accepted', () => {
  assert.deepEqual(problemsOf({ $comment: 'to do' }), []);
});

// ---------------------------------------------------------------------------------------------------------
// what it rejects
// ---------------------------------------------------------------------------------------------------------

const rejects = (name, rules, pattern, doc = null) => test(`rejects ${name}`, () => {
  const problems = doc ? validateMapping(doc) : problemsOf(...rules);
  assert.ok(problems.length > 0, 'expected problems, got none');
  if (pattern) assert.match(problems.join('\n'), pattern);
});

rejects('an empty forEach path (the defect that was in a generated mapping)', [{ structure: { element: 'a', forEach: '', children: [{ element: 'b', const: 'x' }] } }], /forEach must NOT have fewer than 1 characters/);
rejects('an empty path in a value rule', [{ from: '', to: 'cbc:ID' }], /must NOT have fewer than 1 characters/);
rejects('a value rule that has neither a source nor a constant', [{ to: 'cbc:ID' }], /must match a schema in anyOf/);
rejects('a construct the format does not define', [{ from: 'a', to: 'cbc:ID', transform: 'upper' }], /must NOT have additional properties \("transform"\)/);
rejects('a rule that is not of any kind', [{ from: 'a' }], /must have required property '\$comment'|must NOT have additional properties/);
rejects('a structure node without an element', [{ structure: { const: 'x' } }], /must have required property 'element'/);
rejects('a structure node of an unknown type', [{ structure: { element: 'a', from: 'x', type: 'date' } }], /must be equal to one of the allowed values/);
rejects('a records rule with neither entries nor items', [{ records: 'cac:R', key: { to: 'cbc:ID' } }], /must match a schema in anyOf/);
rejects('a record entry with two bodies', [{ records: 'cac:R', key: { to: 'cbc:ID' }, entries: [{ key: 'K', value: { from: 'a', to: 'b' }, object: { from: 'a', to: 'b', fields: [] } }] }], /must match exactly one schema in oneOf/);
rejects('a record entry with no body', [{ records: 'cac:R', key: { to: 'cbc:ID' }, entries: [{ key: 'K' }] }], /must match exactly one schema in oneOf/);
rejects('an attribute that is neither a constant, a path nor a derived value', [{ from: 'a', to: 'b', attributes: { x: { value: 1 } } }], /must/);
rejects('a derived attribute that names both a profile and a map', [{ from: 'a', to: 'b', attributes: { x: { fromMap: { profile: 'p', map: {}, default: 'd' } } } }], /must/);
rejects('a derived attribute that has a map without a default', [{ from: 'a', to: 'b', attributes: { x: { fromMap: { map: { a: 'b' } } } } }], /must/);
rejects('a guard without a value to compare with', [{ from: 'a', to: 'b', when: { path: 'x' } }], /must have required property 'equals'/);
rejects('a spec without a target', null, /must have required property 'target'/, { rules: [] });
rejects('a spec with a key of its own', null, /must NOT have additional properties \("extra"\)/, { target, rules: [], extra: 1 });

test('a problem is reported with the path of the rule it is in', () => {
  const problems = problemsOf({ from: 'a', to: 'b' }, { from: 'a', to: 'b', bogus: 1 });
  assert.ok(problems.some((p) => p.startsWith('/rules/1 ')), problems.join('; '));
});

// ---------------------------------------------------------------------------------------------------------
// what the compiler generates and the parts author
// ---------------------------------------------------------------------------------------------------------

const skip = skipReason(COMPILER_INPUTS);

test('every request and response mapping the compiler generates follows the format', { skip }, () => {
  const edm = loadEdm(edmPath());
  const problems = [];
  const codes = listModeledCodes();
  assert.ok(codes.length >= 50, `expected the modeled criteria, got ${codes.length}`);
  for (const code of codes) {
    const { compiled, registry } = compile(edm, code, loadSidecar(code));
    const { request, response } = generateMappings(compiled, registry);
    for (const [side, mapping] of [['request', request], ['response', response]]) {
      for (const p of validateMapping(mapping)) problems.push(`${code} ${side}: ${p}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('no generated request mapping repeats an element over an empty path', { skip }, () => {
  // The case that made the schema necessary: a response-side group nested in a requirement-side array
  // (the evidence blocks of a ratio period) was given the path left over after cutting the other side's
  // prefix, an empty string.
  const edm = loadEdm(edmPath());
  const { compiled, registry } = compile(edm, 'slc-stand-ratio', loadSidecar('slc-stand-ratio'));
  const { request } = generateMappings(compiled, registry);
  const forEachs = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.forEach === 'string') forEachs.push(n.forEach);
    Object.values(n).forEach(walk);
  })(request);
  assert.ok(forEachs.length >= 3, 'the criterion has repeated groups');
  assert.ok(forEachs.every((f) => f.length > 0), `empty forEach among ${JSON.stringify(forEachs)}`);
  assert.ok(forEachs.includes('partIV.selectionCriteria.slc-stand-ratio.response.evidenceBlocks'), 'the response-side group keeps its absolute path');
  assert.ok(forEachs.includes('ratios'), 'a requirement group nested in a requirement array stays relative to the item');
});

test('the hand-authored mappings of the administrative parts follow the format', { skip: skipReason(['enrichment']) }, () => {
  const problems = [];
  let n = 0;
  for (const part of listParts()) {
    for (const f of fs.readdirSync(enrichmentFile('parts', part)).filter((x) => x.endsWith('.mapping.json'))) {
      n++;
      const doc = JSON.parse(fs.readFileSync(path.join(enrichmentFile('parts', part), f), 'utf8'));
      for (const p of validateMapping(doc)) problems.push(`${part}/${f}: ${p}`);
    }
  }
  assert.ok(n >= 6, `expected the part mappings, got ${n}`);
  assert.deepEqual(problems, []);
});
