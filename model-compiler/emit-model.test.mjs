// emitModel: a criterion whose XML mapping cannot be generated fails; it is not published without it.
// Uses a real criterion, so it needs the inputs (espd-edm.json and the enrichment).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEdm, loadSidecar, compile, emitModel } from './compile.mjs';
import { edmPath } from './config.mjs';
import { skipReason, COMPILER_INPUTS } from './testkit.mjs';

const code = 'slc-stand-to-gen';
const skip = skipReason(COMPILER_INPUTS);
const { compiled, registry } = skip ? {} : compile(loadEdm(edmPath()), code, loadSidecar(code));

const inTempDir = (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-emit-'));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test('a mapping that cannot be generated fails the criterion, with the cause and the criterion named', { skip }, () => {
  inTempDir((root) => {
    const boom = new Error('unsupported shape');
    assert.throws(
      () => emitModel(code, compiled, registry, { root, partId: 'IV', mappings: () => { throw boom; } }),
      (err) => {
        assert.match(err.message, /XML mapping of 'slc-stand-to-gen' could not be generated: unsupported shape/);
        assert.equal(err.cause, boom);
        return true;
      });
    assert.ok(!fs.existsSync(path.join(root, 'xml-mapping')), 'no half-written mapping folder');
  });
});

test('a criterion that maps writes both mappings and lists them', { skip }, () => {
  inTempDir((root) => {
    const { files } = emitModel(code, compiled, registry, { root, partId: 'IV' });
    assert.equal(files.requestMapping, `xml-mapping/${code}.request.mapping.json`);
    assert.equal(files.responseMapping, `xml-mapping/${code}.response.mapping.json`);
    for (const rel of Object.values(files)) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} exists`);
  });
});
