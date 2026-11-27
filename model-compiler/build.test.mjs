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

const build = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build.mjs');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-build-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));

const enrichment = path.join(work, 'enrichment');
fs.cpSync(enrichmentDir(), enrichment, { recursive: true, filter: (src) => !src.split(path.sep).includes('node_modules') });
const out = path.join(work, 'out');

const run = () => spawnSync(process.execPath, [build, '--out', out, '--edm', edmPath(), '--enrichment', enrichment, '--codelists', codelistsDir()], { encoding: 'utf8' });
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

test('a failed full run leaves the previous output untouched and no staging folder behind', () => {
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

test('a successful full run replaces what the compiler owns and leaves other files alone', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr.slice(-600));

  assert.ok(!fs.existsSync(path.join(out, 'compiled', 'previous.json')), 'old compiled/ content is gone');
  assert.ok(!fs.existsSync(path.join(out, 'registries', 'previous.json')), 'old registries/ content is gone');
  assert.equal(fs.readFileSync(path.join(out, 'notes.txt'), 'utf8'), 'not the compiler\'s', 'a file the compiler does not own stays');
  const envelope = JSON.parse(fs.readFileSync(path.join(out, 'compiled-model.json'), 'utf8'));
  assert.ok(envelope.counts.criteria > 0 && !envelope.previous, 'the new envelope is in place');
  for (const name of ['instance-data', 'xml-mapping', 'compiled', 'parts', 'registries', 'schema']) {
    assert.ok(fs.existsSync(path.join(out, name)), `${name}/ is published`);
  }
  assert.ok(fs.existsSync(path.join(out, 'README.md')));
  assert.deepEqual(leftovers(), [], 'no staging folder is left');
});
