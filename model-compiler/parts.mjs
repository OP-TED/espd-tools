// The administrative parts (I, II, VI) of the published model.
//
// Unlike the criteria, these are not compiled from the EA structure: they are authored (and,
// later, to be derived from the EA model) in enrichment/parts/<part>/ and published here
// verbatim, so that every consumer fills in the same Part I, II and VI. This module checks
// that what it publishes is complete and consistent, and returns the inventory the envelope
// records. The wider cross-checks (form paths against the schema, code lists, UI hints) live
// in the enrichment's own validate.mjs, which runs on every change to the sources.

import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import { enrichmentFile } from './config.mjs';
import { compareCodePoint } from './order.mjs';
import { copyLf } from './lf.mjs';
import { validateMapping } from './mapping-schema.mjs';

/** Per section: the four files, in the order the envelope lists them. */
export const SECTION_KINDS = [
  ['schema', 'schema'],
  ['example', 'example'],
  ['mapping', 'mapping'],
  ['form', 'form'],
];

const partsDir = () => enrichmentFile('parts');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** The part folders in the enrichment, in a stable order (partI, partII, partVI). */
export function listParts() {
  const dir = partsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(compareCodePoint);
}

/**
 * Check one part's sources. Returns the problems (empty = ok) and, when usable, its manifest.
 * Checks: the manifest names the part the folder says; every listed section has its four files;
 * no file is unlisted; each section identifies itself; each mapping follows the mapping format
 * (schema/mapping.schema.json); each example validates against its schema.
 */
export function checkPart(dirName) {
  const problems = [];
  const dir = path.join(partsDir(), dirName);
  const manifestFile = path.join(dir, 'index.json');
  if (!fs.existsSync(manifestFile)) return { problems: [`parts/${dirName}: no index.json`], manifest: null };
  const manifest = readJson(manifestFile);
  if (dirName !== `part${manifest.part}`) problems.push(`parts/${dirName}/index.json: part "${manifest.part}" does not match the folder name`);
  if (!Array.isArray(manifest.sections) || !manifest.sections.length) {
    return { problems: [...problems, `parts/${dirName}/index.json: sections must be a non-empty array`], manifest };
  }

  const expected = new Set(['index.json', 'README.md']); // README.md: design notes, not published
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const id of manifest.sections) {
    const where = `parts/${dirName}/section${id}`;
    const docs = {};
    for (const [kind] of SECTION_KINDS) {
      const name = `section${id}.${kind}.json`;
      expected.add(name);
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) { problems.push(`${where}.${kind}.json: listed in the manifest but missing`); continue; }
      try { docs[kind] = readJson(file); } catch (err) { problems.push(`${where}.${kind}.json: not valid JSON (${err.message})`); }
    }
    if (docs.form) {
      if (docs.form.part !== manifest.part) problems.push(`${where}.form.json: part is "${docs.form.part}", expected "${manifest.part}"`);
      if (docs.form.section !== id) problems.push(`${where}.form.json: section is "${docs.form.section}", expected "${id}"`);
    }
    if (docs.mapping) {
      for (const p of validateMapping(docs.mapping)) problems.push(`${where}.mapping.json: ${p}`);
    }
    if (docs.schema && docs.example) {
      try {
        const validate = ajv.compile(docs.schema);
        if (!validate(docs.example)) {
          for (const e of validate.errors) problems.push(`${where}.example.json: ${e.instancePath || '/'} ${e.message}`);
        }
      } catch (err) {
        problems.push(`${where}.schema.json: does not compile (${err.message})`);
      }
    }
  }
  for (const f of fs.readdirSync(dir)) {
    if (!expected.has(f)) problems.push(`parts/${dirName}/${f}: not in the manifest (unexpected file)`);
  }
  return { problems, manifest };
}

/**
 * Check every part and copy it into <root>/parts/<part>/. Returns the inventory for the
 * envelope: [{ part, manifest, sections: [{ id, schema, example, mapping, form }] }].
 * Throws with all problems when any part is not publishable.
 */
export function publishParts(root) {
  const names = listParts();
  if (!names.length) throw new Error(`no administrative parts found in ${partsDir()}`);
  const problems = [];
  const checked = names.map((name) => ({ name, ...checkPart(name) }));
  for (const c of checked) problems.push(...c.problems);
  if (problems.length) throw new Error(`The administrative parts cannot be published:\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  return checked.map(({ name, manifest }) => {
    const target = path.join(root, 'parts', name);
    fs.mkdirSync(target, { recursive: true });
    const copy = (file) => { copyLf(path.join(partsDir(), name, file), path.join(target, file)); return `parts/${name}/${file}`; };
    const out = { part: manifest.part, manifest: copy('index.json'), sections: [] };
    for (const id of manifest.sections) {
      const section = { id };
      for (const [kind, key] of SECTION_KINDS) section[key] = copy(`section${id}.${kind}.json`);
      out.sections.push(section);
    }
    return out;
  });
}
