// Tests for the compiled-model envelope: schema conformance, deterministic ordering and
// counts, and content hashes that do not depend on line endings.
//
// Usage: node envelope.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { buildEnvelope, validateEnvelope, hashFile, hashEnrichment, readVersions } from './envelope.mjs';

const sha = 'a'.repeat(64);
const provenance = {
  generator: { name: 'espd-model-compiler', version: '0.0.0' },
  structure: { file: 'criterion/espd-edm.json', sha256: sha },
  enrichment: { sha256: sha, files: 3 },
  valueTypeSource: { shortName: 'ResponseDataType', version: '5.0.0' },
};
const files = (k) => ({
  instanceSchema: `instance-data/${k}.schema.json`,
  instanceExample: `instance-data/${k}.example.json`,
  compiled: `compiled/${k}.json`,
  requestMapping: `xml-mapping/${k}.request.mapping.json`,
  responseMapping: `xml-mapping/${k}.response.mapping.json`,
});
const entry = (key, part, valueTypes) =>
  ({ key, id: key, code: key, part, leaves: 3, repeatableBindings: 0, valueTypes, files: files(key) });
const valueTypeRegistry = { valueTypes: { INDICATOR: { requestXml: {}, responseXml: {} }, DATE: { responseXml: {} }, URL: {} } };

const section = (p, id) => ({ id, schema: `parts/part${p}/section${id}.schema.json`, example: `parts/part${p}/section${id}.example.json`, mapping: `parts/part${p}/section${id}.mapping.json`, form: `parts/part${p}/section${id}.form.json` });
const partEntry = (p, ids) => ({ part: p, manifest: `parts/part${p}/index.json`, sections: ids.map(id => section(p, id)) });
const defaultParts = [partEntry('VI', ['A']), partEntry('I', ['A', 'B', 'C'])];

const make = (entries, parts = defaultParts) => buildEnvelope({
  espdVersion: '5.0.0', ublVersion: '2.4', provenance, entries, valueTypeRegistry, registries: ['registries/b.json', 'registries/a.json'], parts,
});

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

check('a built envelope conforms to the schema', () => {
  const env = make([entry('slc-b', 'IV', ['INDICATOR', 'DATE']), entry('exg-a', 'III', ['INDICATOR'])]);
  assert.deepEqual(validateEnvelope(env), []);
});

check('criteria are ordered by part then key; value types and registries sorted', () => {
  const env = make([entry('slc-b', 'IV', ['DATE']), entry('ot-z', 'II', []), entry('exg-b', 'III', []), entry('exg-a', 'III', [])]);
  assert.deepEqual(env.criteria.map(c => c.key), ['ot-z', 'exg-a', 'exg-b', 'slc-b']);
  assert.deepEqual(env.valueTypes.map(v => v.name), ['DATE', 'INDICATOR', 'URL']);
  assert.deepEqual(env.registries, ['registries/a.json', 'registries/b.json']);
});

check('the administrative parts are listed ordered by part, and the schema rejects a malformed one', () => {
  const env = make([entry('x', 'III', [])]);
  assert.deepEqual(env.parts.map(p => p.part), ['I', 'VI']);
  assert.equal(env.counts.partSections, 4);
  const noParts = structuredClone(env); delete noParts.parts;
  assert.ok(validateEnvelope(noParts).length, 'parts is required');
  const badPart = structuredClone(env); badPart.parts[0].part = 'III';
  assert.ok(validateEnvelope(badPart).length, 'only the administrative parts are allowed');
  const missingFile = structuredClone(env); delete missingFile.parts[0].sections[0].form;
  assert.ok(validateEnvelope(missingFile).length, 'a section needs all four files');
});

check('the same input in any order yields identical bytes', () => {
  const a = make([entry('x', 'III', ['DATE', 'INDICATOR']), entry('y', 'IV', ['INDICATOR'])]);
  const b = make([entry('y', 'IV', ['INDICATOR']), entry('x', 'III', ['INDICATOR', 'DATE'])]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

check('counts and value-type usage are derived; every criterion has both mappings', () => {
  const env = make([entry('x', 'III', ['INDICATOR', 'DATE']), entry('y', 'IV', ['INDICATOR'])]);
  assert.deepEqual(env.counts, { criteria: 2, valueTypes: 3, instanceDataFiles: 4, xmlMappingFiles: 4, compiledFiles: 2, partSections: 4 });
  const usage = Object.fromEntries(env.valueTypes.map(v => [v.name, v.usedBy]));
  assert.deepEqual(usage, { DATE: 1, INDICATOR: 2, URL: 0 });
  const bindings = Object.fromEntries(env.valueTypes.map(v => [v.name, [v.request, v.response]]));
  assert.deepEqual(bindings, { DATE: [false, true], INDICATOR: [true, true], URL: [false, false] });
  const nullMapping = structuredClone(env); nullMapping.criteria[0].files.requestMapping = null;
  assert.ok(validateEnvelope(nullMapping).length, 'a missing mapping is not valid: a criterion without its mapping fails the build');
  assert.deepEqual(validateEnvelope(env), []);
});

check('the schema rejects a missing field, a bad hash, an unknown field and a bad part', () => {
  const ok = make([entry('x', 'III', [])]);
  const without = structuredClone(ok); delete without.espdVersion;
  assert.ok(validateEnvelope(without).length, 'missing espdVersion');
  const badHash = structuredClone(ok); badHash.provenance.structure.sha256 = 'not-a-hash';
  assert.ok(validateEnvelope(badHash).length, 'bad sha256');
  const extra = structuredClone(ok); extra.surprise = true;
  assert.ok(validateEnvelope(extra).length, 'unknown top-level field');
  const badPart = structuredClone(ok); badPart.criteria[0].part = 'VII';
  assert.ok(validateEnvelope(badPart).length, 'unknown part');
  const badVersion = structuredClone(ok); badVersion.envelopeVersion = 2;
  assert.ok(validateEnvelope(badVersion).length, 'unknown envelope version');
});

check('hashes ignore line endings (a Windows checkout equals a Linux one)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-env-'));
  try {
    fs.writeFileSync(path.join(dir, 'lf.json'), '{\n  "a": 1\n}\n');
    fs.writeFileSync(path.join(dir, 'crlf.json'), '{\r\n  "a": 1\r\n}\r\n');
    assert.equal(hashFile(path.join(dir, 'lf.json')), hashFile(path.join(dir, 'crlf.json')));

    const enr = (name, nl) => {
      const root = path.join(dir, name);
      for (const sub of ['registries', 'criteria']) fs.mkdirSync(path.join(root, sub), { recursive: true });
      fs.writeFileSync(path.join(root, 'registries', 'r.json'), `{${nl}"r": 1${nl}}${nl}`);
      fs.writeFileSync(path.join(root, 'criteria', 'c.sidecar.json'), `{${nl}"c": 1${nl}}${nl}`);
      fs.writeFileSync(path.join(root, 'criteria', 'ignored.md'), 'not a source');
      fs.mkdirSync(path.join(root, 'parts', 'partI'), { recursive: true });
      fs.writeFileSync(path.join(root, 'parts', 'partI', 'index.json'), `{${nl}"p": 1${nl}}${nl}`);
      fs.writeFileSync(path.join(root, 'parts', 'partI', 'README.md'), 'not a source');
      return root;
    };
    const a = hashEnrichment(enr('a', '\n')), b = hashEnrichment(enr('b', '\r\n'));
    assert.equal(a.sha256, b.sha256);
    assert.equal(a.files, 3, 'only .json files under registries/, criteria/ and parts/<part>/ count');

    fs.writeFileSync(path.join(dir, 'b', 'parts', 'partI', 'index.json'), '{"p": 2}\n');
    assert.notEqual(hashEnrichment(path.join(dir, 'b')).sha256, a.sha256, 'a change to a part changes the hash');
    fs.writeFileSync(path.join(dir, 'b', 'parts', 'partI', 'index.json'), '{\r\n"p": 1\r\n}\r\n');

    fs.writeFileSync(path.join(dir, 'b', 'criteria', 'c.sidecar.json'), '{"c": 2}\n');
    assert.notEqual(hashEnrichment(path.join(dir, 'b')).sha256, a.sha256, 'a content change changes the hash');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('versions are read from codelists.json, and a missing or incomplete file is an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-ver-'));
  try {
    assert.throws(() => readVersions(dir), /codelists\.json not found/);
    fs.writeFileSync(path.join(dir, 'codelists.json'), JSON.stringify({ espdVersion: '5.0.0', codelists: [] }));
    assert.throws(() => readVersions(dir), /espdVersion and\/or ublVersion/);
    fs.writeFileSync(path.join(dir, 'codelists.json'), JSON.stringify({ espdVersion: '5.0.0', ublVersion: '2.4', codelists: [] }));
    assert.deepEqual(readVersions(dir), { espdVersion: '5.0.0', ublVersion: '2.4' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nAll ${n} envelope tests passed.`);
