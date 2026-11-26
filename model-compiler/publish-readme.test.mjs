// Tests for the README of the published model folder: it is rendered from model-readme.template.md,
// every placeholder is filled from the envelope, and it documents what implementers need to know.
//
// Usage: node publish-readme.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { publishReadme } from './publish.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const envelope = {
  envelopeVersion: 1,
  espdVersion: '9.8.7',
  ublVersion: '6.5',
  counts: { criteria: 11, valueTypes: 22, instanceDataFiles: 33, xmlMappingFiles: 44, compiledFiles: 55, partSections: 66 },
};

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

const render = (registries = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-readme-'));
  try {
    if (Object.keys(registries).length) fs.mkdirSync(path.join(dir, 'registries'));
    for (const [name, doc] of Object.entries(registries)) fs.writeFileSync(path.join(dir, 'registries', name), JSON.stringify(doc));
    publishReadme(dir, envelope);
    return fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

check('every placeholder is filled from the envelope', () => {
  const text = render();
  assert.doesNotMatch(text, /\{\{/, 'no placeholder is left');
  assert.match(text, /ESPD version 9\.8\.7, UBL 6\.5\. 11 criteria, 22 value types, 66 sections/);
  assert.match(text, /currently 1\)/, 'the envelope version is stated');
  for (const count of ['33', '44', '55']) assert.match(text, new RegExp(` ${count} files\\.`), `${count} files are counted`);
});

check('the README documents the status, the use, the origin and the verification', () => {
  const text = render();
  for (const heading of ['## Status', '## Layout', '## Using the model', '## Where it comes from, and how to change it', '## Verifying', '## Provenance']) {
    assert.ok(text.includes(`\n${heading}\n`), `has ${heading}`);
  }
  assert.match(text, /Compatibility policy/);
  assert.match(text, /Known limitations/);
});

check('provisional registries are listed from their own status, confirmed ones are not', () => {
  const text = render({
    'b.json': { status: 'provisional', statusNote: 'Pending review of B.' },
    'a.json': { status: 'provisional', statusNote: 'Pending review of A.' },
    'c.json': { status: 'confirmed', statusNote: 'Agreed.' },
    'd.json': { profiles: {} },
  });
  assert.match(text, /These registries are provisional now:\n  - `registries\/a\.json`: Pending review of A\.\n  - `registries\/b\.json`: Pending review of B\./, 'listed, sorted by file name');
  assert.doesNotMatch(text, /c\.json|Agreed|d\.json/, 'confirmed and unmarked registries are not listed');
});

check('with no provisional registry (or no registries) the list says none', () => {
  assert.match(render({ 'a.json': { status: 'confirmed' } }), /provisional now:\n  - none/);
  assert.match(render(), /provisional now:\n  - none/);
});
check('an unknown placeholder in the template is an error', () => {
  const template = path.join(here, 'model-readme.template.md');
  const original = fs.readFileSync(template, 'utf8');
  try {
    fs.writeFileSync(template, original + '\n{{noSuchValue}}\n');
    assert.throws(() => render(), /unknown placeholder \{\{noSuchValue\}\}/);
  } finally {
    fs.writeFileSync(template, original);
  }
});

console.log(`\nAll ${n} publish-readme tests passed.`);
