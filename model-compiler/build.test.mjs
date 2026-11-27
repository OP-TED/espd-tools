// build.mjs on a full run: a failed run leaves the previous output as it was, and a successful run
// replaces what the compiler owns and nothing else. Runs the real compiler on a copy of the real
// enrichment, so it needs the inputs (espd-edm.json, enrichment, code lists).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { edmPath, enrichmentDir, codelistsDir } from './config.mjs';
import { skipReason, COMPILER_INPUTS } from './testkit.mjs';

const build = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build.mjs');
const skip = skipReason(COMPILER_INPUTS);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-build-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const enrichment = path.join(work, 'enrichment');
if (!skip) fs.cpSync(enrichmentDir(), enrichment, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
const out = path.join(work, 'out');

const GENERATOR_COMMIT = 'c0ffee'.repeat(6) + 'abcd';
const run = (...extra) => spawnSync(process.execPath, [build, '--out', out, '--edm', edmPath(), '--enrichment', enrichment, '--codelists', codelistsDir(), '--generator-commit', GENERATOR_COMMIT, ...extra], { encoding: 'utf8' });
const leftovers = () => fs.readdirSync(work).filter((n) => n.includes('.building-'));

// What a previous run left: files in folders the compiler owns, and a file it does not own.
const seedPreviousOutput = () => {
  fs.mkdirSync(path.join(out, 'compiled'), { recursive: true });
  fs.mkdirSync(path.join(out, 'registries'), { recursive: true });
  fs.writeFileSync(path.join(out, 'compiled', 'previous.json'), '{}');
  fs.writeFileSync(path.join(out, 'registries', 'previous.json'), '{}');
  fs.writeFileSync(path.join(out, 'compiled-model.json'), '{"previous":true}');
  fs.writeFileSync(path.join(out, 'notes.txt'), 'not the compiler\'s');
};

test('a failed full run leaves the previous output untouched and no staging folder behind', { skip }, () => {
  seedPreviousOutput();
  // Break one sidecar: a value leaf without its entry fails the overlay.
  const sidecarFile = path.join(enrichment, 'criteria', 'slc-stand-to-gen.sidecar.json');
  const original = fs.readFileSync(sidecarFile, 'utf8');
  const sidecar = JSON.parse(original);
  delete sidecar.components[Object.keys(sidecar.components)[0]];
  fs.writeFileSync(sidecarFile, JSON.stringify(sidecar));

  const result = run();
  assert.equal(result.status, 1, result.stderr.slice(-600));
  assert.match(result.stderr, /✗ slc-stand-to-gen/);

  assert.equal(fs.readFileSync(path.join(out, 'compiled', 'previous.json'), 'utf8'), '{}', 'previous compiled/ file is still there');
  assert.equal(fs.readFileSync(path.join(out, 'registries', 'previous.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(out, 'compiled-model.json'), 'utf8'), '{"previous":true}', 'the previous envelope is untouched');
  assert.deepEqual(leftovers(), [], 'the staging folder is removed');

  fs.writeFileSync(sidecarFile, original);
});

test('a successful full run replaces what the compiler owns and leaves other files alone', { skip }, () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr.slice(-600));

  assert.ok(!fs.existsSync(path.join(out, 'compiled', 'previous.json')), 'old compiled/ content is gone');
  assert.ok(!fs.existsSync(path.join(out, 'registries', 'previous.json')), 'old registries/ content is gone');
  assert.equal(fs.readFileSync(path.join(out, 'notes.txt'), 'utf8'), 'not the compiler\'s', 'a file the compiler does not own stays');
  const envelope = JSON.parse(fs.readFileSync(path.join(out, 'compiled-model.json'), 'utf8'));
  assert.ok(envelope.counts.criteria > 0 && !envelope.previous, 'the new envelope is in place');
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(build), 'package.json'), 'utf8'));
  assert.deepEqual(envelope.provenance.generator, { name: pkg.name, version: pkg.version, commit: GENERATOR_COMMIT }, 'the envelope records the compiler, its version and its commit');
  for (const name of ['instance-data', 'xml-mapping', 'compiled', 'parts', 'registries', 'schema']) {
    assert.ok(fs.existsSync(path.join(out, name)), `${name}/ is published`);
  }
  assert.ok(fs.existsSync(path.join(out, 'README.md')));
  assert.deepEqual(leftovers(), [], 'no staging folder is left');
});

const verify = path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify.mjs');
const runVerify = () => spawnSync(process.execPath, [verify, '--model', out, '--edm', edmPath()], { encoding: 'utf8' });

test('verify.mjs accepts what the build published, including the mapping schema', { skip }, () => {
  assert.ok(fs.existsSync(path.join(out, 'schema', 'mapping.schema.json')), 'the mapping schema is part of the published model');
  const result = runVerify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Model OK/);
});

test('verify.mjs rejects a published mapping that does not follow the format, and a model without the schema', { skip }, () => {
  const mapping = path.join(out, 'xml-mapping', 'slc-stand-ratio.request.mapping.json');
  const original = fs.readFileSync(mapping, 'utf8');
  assert.ok(original.includes('"forEach": "ratios"'), 'the fixture has the nested group');
  try {
    fs.writeFileSync(mapping, original.replace('"forEach": "ratios"', '"forEach": ""'));
    const bad = runVerify();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /xml-mapping\/slc-stand-ratio\.request\.mapping\.json: .*fewer than 1 characters/);
  } finally {
    fs.writeFileSync(mapping, original);
  }

  const schemaFile = path.join(out, 'schema', 'mapping.schema.json');
  const schema = fs.readFileSync(schemaFile);
  try {
    fs.rmSync(schemaFile);
    const missing = runVerify();
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /schema\/mapping\.schema\.json is missing/);
  } finally {
    fs.writeFileSync(schemaFile, schema);
  }
  assert.equal(runVerify().status, 0, 'and it is accepted again once restored');
});

test('a --generator-commit that is not a full commit hash is refused before any work is done', () => {
  const result = spawnSync(process.execPath, [build, '--out', path.join(work, 'never'), '--generator-commit', 'abc123'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--generator-commit must be a full 40-character commit hash, got 'abc123'/);
  assert.ok(!fs.existsSync(path.join(work, 'never')));
});
