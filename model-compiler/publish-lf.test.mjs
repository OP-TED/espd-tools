// Published text files carry LF line endings, whatever the checkout has (a Windows checkout with
// core.autocrlf turns the sources into CRLF). Registries need the enrichment folder; the rest does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configure, enrichmentDir } from './config.mjs';
import { publishRegistries, publishSchema, REGISTRY_FILES } from './publish.mjs';
import { readLf, writeLf, copyLf } from './lf.mjs';
import { schemaPath } from './envelope.mjs';
import { skipReason } from './testkit.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'espd-lf-'));
const hasCr = (file) => fs.readFileSync(file, 'utf8').includes('\r');

test('readLf, writeLf and copyLf turn CRLF into LF and leave lone CR and LF alone', () => {
  const dir = tmpDir();
  try {
    const src = path.join(dir, 'in.txt');
    fs.writeFileSync(src, 'a\r\nb\nc\rd\r\n');
    assert.equal(readLf(src), 'a\nb\nc\rd\n');
    copyLf(src, path.join(dir, 'sub', 'out.txt'));
    assert.equal(fs.readFileSync(path.join(dir, 'sub', 'out.txt'), 'utf8'), 'a\nb\nc\rd\n', 'creates the folder, normalises');
    writeLf(path.join(dir, 'w.txt'), 'x\r\ny');
    assert.equal(fs.readFileSync(path.join(dir, 'w.txt'), 'utf8'), 'x\ny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the envelope schema and the mapping schema are published with LF, also when the source has CRLF', () => {
  const dir = tmpDir();
  try {
    publishSchema(dir);
    assert.ok(!hasCr(path.join(dir, 'schema', 'compiled-model.schema.json')));
    assert.ok(fs.existsSync(path.join(dir, 'schema', 'mapping.schema.json')), 'the schema of the mapping format is published too');
    assert.ok(!hasCr(path.join(dir, 'schema', 'mapping.schema.json')));
    // The same, from a source that certainly has CRLF (the checkout on this machine may not).
    const crlfSource = path.join(dir, 'crlf.schema.json');
    fs.writeFileSync(crlfSource, fs.readFileSync(schemaPath, 'utf8').replace(/\r?\n/g, '\r\n'));
    assert.ok(hasCr(crlfSource), 'the fixture has CRLF');
    publishSchema(path.join(dir, 'from-crlf'), crlfSource);
    assert.ok(!hasCr(path.join(dir, 'from-crlf', 'schema', 'compiled-model.schema.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('registries checked out with CRLF are published with LF', { skip: skipReason(['enrichment']) }, () => {
  const work = tmpDir();
  try {
    // A copy of the real registries, converted to CRLF as a Windows checkout would have them.
    const registries = path.join(work, 'enrichment', 'registries');
    fs.mkdirSync(registries, { recursive: true });
    for (const f of REGISTRY_FILES) {
      const text = fs.readFileSync(path.join(enrichmentDir(), 'registries', f), 'utf8').replace(/\r?\n/g, '\r\n');
      fs.writeFileSync(path.join(registries, f), text);
      assert.ok(text.includes('\r\n'), `${f}: the fixture has CRLF`);
    }
    const before = enrichmentDir();
    configure({ enrichment: path.join(work, 'enrichment') });
    try {
      const out = path.join(work, 'out');
      const published = publishRegistries(out);
      assert.equal(published.length, REGISTRY_FILES.length);
      for (const rel of published) assert.ok(!hasCr(path.join(out, rel)), `${rel} has no CR`);
    } finally {
      configure({ enrichment: before });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
