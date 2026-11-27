// Tests for publishing the administrative parts: a complete part is copied and inventoried, and
// every way a part can be unpublishable (missing file, stray file, wrong identity, bad example)
// is reported.
//
// Usage: node parts.test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { configure } from './config.mjs';
import { checkPart, listParts, publishParts } from './parts.mjs';

let n = 0;
const check = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'espd-parts-'));
try {
  const enrichment = path.join(tmp, 'enrichment');
  const dir = path.join(enrichment, 'parts', 'partI');
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const build = () => {
    fs.rmSync(enrichment, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    write('index.json', { part: 'I', titleKey: 't', descriptionKey: 'd', filledBy: 'x', sections: ['A'] });
    write('sectionA.schema.json', { type: 'object', properties: { partI: { type: 'object' } }, required: ['partI'] });
    write('sectionA.example.json', { partI: {} });
    write('sectionA.mapping.json', { target: { root: 'R', namespaces: { '': 'urn:x' } }, rules: [] });
    write('sectionA.form.json', { part: 'I', section: 'A', title: 'T', titleKey: 'k', filledBy: 'x', fields: [] });
  };
  configure({ enrichment });

  check('a complete part is listed, has no problems and is inventoried in manifest order', () => {
    build();
    assert.deepEqual(listParts(), ['partI']);
    assert.deepEqual(checkPart('partI').problems, []);
    const out = path.join(tmp, 'out');
    const parts = publishParts(out);
    assert.deepEqual(parts, [{
      part: 'I',
      manifest: 'parts/partI/index.json',
      sections: [{
        id: 'A',
        schema: 'parts/partI/sectionA.schema.json',
        example: 'parts/partI/sectionA.example.json',
        mapping: 'parts/partI/sectionA.mapping.json',
        form: 'parts/partI/sectionA.form.json',
      }],
    }]);
    for (const rel of [parts[0].manifest, ...Object.values(parts[0].sections[0]).filter((v) => v.startsWith('parts/'))]) {
      const lf = (text) => text.replace(/\r\n/g, '\n');
      assert.equal(fs.readFileSync(path.join(out, rel), 'utf8'), lf(fs.readFileSync(path.join(enrichment, rel), 'utf8')), `${rel} is copied (line endings normalised to LF)`);
    }
  });

  check('parts written with CRLF line endings are published with LF', () => {
    build();
    for (const f of ['index.json', 'sectionA.schema.json', 'sectionA.example.json', 'sectionA.mapping.json', 'sectionA.form.json']) {
      write(f, fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    assert.ok(fs.readFileSync(path.join(dir, 'sectionA.form.json'), 'utf8').includes('\r\n'), 'the fixture really has CRLF');
    const out = path.join(tmp, 'out-lf');
    const parts = publishParts(out);
    for (const rel of [parts[0].manifest, ...Object.values(parts[0].sections[0]).filter((v) => v.startsWith('parts/'))]) {
      assert.ok(!fs.readFileSync(path.join(out, rel), 'utf8').includes('\r'), `${rel} has no CR`);
    }
  });

  check('a README.md (design notes) is allowed and is not published', () => {
    build();
    write('README.md', '# notes');
    assert.deepEqual(checkPart('partI').problems, []);
    const out = path.join(tmp, 'out3');
    publishParts(out);
    assert.equal(fs.existsSync(path.join(out, 'parts', 'partI', 'README.md')), false);
  });

  check('a section file missing from disk is reported', () => {
    build();
    fs.rmSync(path.join(dir, 'sectionA.mapping.json'));
    assert.match(checkPart('partI').problems.join('\n'), /sectionA\.mapping\.json: listed in the manifest but missing/);
  });

  check('a file the manifest does not list is reported', () => {
    build();
    write('sectionB.form.json', {});
    assert.match(checkPart('partI').problems.join('\n'), /sectionB\.form\.json: not in the manifest/);
  });

  check('a form that names another part or section is reported', () => {
    build();
    write('sectionA.form.json', { part: 'II', section: 'B', title: 'T', titleKey: 'k', filledBy: 'x', fields: [] });
    const text = checkPart('partI').problems.join('\n');
    assert.match(text, /part is "II", expected "I"/);
    assert.match(text, /section is "B", expected "A"/);
  });

  check('a manifest that does not match its folder is reported', () => {
    build();
    write('index.json', { part: 'II', titleKey: 't', descriptionKey: 'd', filledBy: 'x', sections: ['A'] });
    assert.match(checkPart('partI').problems.join('\n'), /does not match the folder name/);
  });

  check('an example that does not validate against its schema is reported', () => {
    build();
    write('sectionA.example.json', {});
    assert.match(checkPart('partI').problems.join('\n'), /sectionA\.example\.json: .*partI/);
  });

  check('publishing refuses an unpublishable part and an absent parts folder, and writes nothing for them', () => {
    build();
    write('sectionA.example.json', {});
    const out = path.join(tmp, 'out2');
    assert.throws(() => publishParts(out), /cannot be published/);
    assert.equal(fs.existsSync(path.join(out, 'parts')), false);
    fs.rmSync(path.join(enrichment, 'parts'), { recursive: true });
    assert.throws(() => publishParts(out), /no administrative parts found/);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nAll ${n} parts tests passed.`);
