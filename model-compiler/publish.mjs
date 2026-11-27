// Publishing helpers: the files of the published model folder that are not
// per-criterion output (registries, schema, README) and the clean-up of a previous
// run. Everything here is deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichmentFile } from './config.mjs';
import { schemaPath } from './envelope.mjs';
import { compareCodePoint } from './order.mjs';
import { mappingSchemaPath } from './mapping-schema.mjs';
import { readLf, writeLf, copyLf } from './lf.mjs';

/** Registries published verbatim from the enrichment folder (see patchSource below). */
export const REGISTRY_FILES = [
  'value-types.json',
  'encoding-profile.json',
  'codelist-attributes.json',
  'scheme-agency-profile.json',
  'roles.json',
  'codelist-governance.json',
  'ui-hints.json',
];

/** Paths inside the published model folder that this compiler owns and may delete. */
export const OWNED = ['instance-data', 'xml-mapping', 'compiled', 'parts', 'registries', 'schema', 'compiled-model.json', 'README.md'];

/** Remove everything a previous full run produced, so stale criteria cannot linger. */
export function cleanOwned(root) {
  for (const name of OWNED) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

// The `source` paths inside two registries are informational and written relative to
// the sibling-checkout layout (espd-conceptual-model/enrichment/registries/...).
// Inside ESPD-EDM they are relative to model/registries/, so rewrite them. The
// replacement is textual to keep the files' formatting, and must hit exactly once.
const SOURCE_PATCHES = {
  'value-types.json': [
    [/"path":\s*"[^"]*\/(ResponseDataType\.gc)"/, (m, gc) => m.replace(/"[^"]*"$/, `"../../codelists/${gc}"`)],
  ],
  'codelist-attributes.json': [
    [/"schematron":\s*"[^"]*"/, (m) => m.replace(/"[^"]*"$/, '"../../validation/common/sch/01-ESPD-common-cl-attributes.sch"')],
  ],
};

function patchSource(file, text) {
  for (const [re, fn] of SOURCE_PATCHES[file] ?? []) {
    if (!re.test(text)) throw new Error(`registries/${file}: expected source path not found; cannot adapt it for publication`);
    text = text.replace(re, fn);
  }
  return text;
}

/** Copy the registries into <root>/registries. Returns their paths relative to root. */
export function publishRegistries(root) {
  const dir = path.join(root, 'registries');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of REGISTRY_FILES) {
    const text = patchSource(f, readLf(enrichmentFile('registries', f)));
    writeLf(path.join(dir, f), text);
  }
  return REGISTRY_FILES.map(f => `registries/${f}`);
}

/** Copy the envelope schema and the schema of the mapping format into <root>/schema. */
export function publishSchema(root, source = schemaPath) {
  const dir = path.join(root, 'schema');
  fs.mkdirSync(dir, { recursive: true });
  copyLf(source, path.join(dir, 'compiled-model.schema.json'));
  copyLf(mappingSchemaPath, path.join(dir, 'mapping.schema.json'));
}

/**
 * The registries of the published folder that are still provisional, as a nested Markdown list for the
 * README. A registry says so itself (status "provisional" and a statusNote), so the list cannot go stale
 * when its status changes.
 */
function provisionalRegistriesList(root) {
  const dir = path.join(root, 'registries');
  const items = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort(compareCodePoint)) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (doc.status === 'provisional') items.push(`  - \`registries/${f}\`: ${doc.statusNote ?? '(no note)'}`);
    }
  }
  return items.length ? items.join('\n') : '  - none';
}
const readmeTemplate = path.join(path.dirname(fileURLToPath(import.meta.url)), 'model-readme.template.md');

/**
 * Write <root>/README.md, the documentation of the published folder. The text lives in
 * model-readme.template.md; {{name}} placeholders are filled from the envelope. An unknown or
 * unfilled placeholder is an error, so the README cannot ship with a hole in it.
 */
export function publishReadme(root, envelope) {
  const c = envelope.counts;
  const values = {
    provisionalRegistries: provisionalRegistriesList(root),
    espdVersion: envelope.espdVersion,
    ublVersion: envelope.ublVersion,
    envelopeVersion: envelope.envelopeVersion,
    criteria: c.criteria,
    valueTypes: c.valueTypes,
    partSections: c.partSections,
    instanceDataFiles: c.instanceDataFiles,
    xmlMappingFiles: c.xmlMappingFiles,
    compiledFiles: c.compiledFiles,
  };
  const text = fs.readFileSync(readmeTemplate, 'utf8').replace(/\r\n/g, '\n').replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`model-readme.template.md: unknown placeholder {{${name}}}`);
    return String(values[name]);
  });
  fs.writeFileSync(path.join(root, 'README.md'), text);
}
