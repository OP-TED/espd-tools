#!/usr/bin/env node
// Verifies a published model folder (ESPD-EDM/model): the envelope conforms to its
// schema, every file it lists exists, nothing unlisted lingers in the generated
// folders, and, when the structure export is given, that the model was built from it.
//
// Usage: node verify.mjs --model <model dir> [--edm <criterion/espd-edm.json>]
//
// Intended for ESPD-EDM's own checks (a hand edit or a stale model is reported).
// Exit code: 0 ok, 1 problems found, 2 unusable arguments.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { validateEnvelope, hashFile } from './envelope.mjs';
import { validateMapping } from './mapping-schema.mjs';

const { values } = parseArgs({ options: { model: { type: 'string' }, edm: { type: 'string' } } });
if (!values.model) {
  process.stderr.write('Usage: node verify.mjs --model <model dir> [--edm <espd-edm.json>]\n');
  process.exit(2);
}

const root = path.resolve(values.model);
const problems = [];
const envelopeFile = path.join(root, 'compiled-model.json');
if (!fs.existsSync(envelopeFile)) {
  process.stderr.write(`No compiled-model.json in ${root}\n`);
  process.exit(1);
}

const envelope = JSON.parse(fs.readFileSync(envelopeFile, 'utf8'));
for (const p of validateEnvelope(envelope)) problems.push(`compiled-model.json: ${p}`);

if (!problems.length) {
  const listed = new Set();
  for (const c of envelope.criteria) {
    for (const rel of Object.values(c.files)) if (rel) listed.add(rel);
  }
  for (const rel of envelope.registries) listed.add(rel);
  for (const p of envelope.parts) {
    listed.add(p.manifest);
    for (const s of p.sections) for (const k of ['schema', 'example', 'mapping', 'form']) listed.add(s[k]);
  }
  for (const rel of listed) if (!fs.existsSync(path.join(root, rel))) problems.push(`listed file is missing: ${rel}`);

  for (const dir of ['instance-data', 'xml-mapping', 'compiled', 'registries']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (!listed.has(`${dir}/${f}`)) problems.push(`file not in the envelope (stale or hand-added): ${dir}/${f}`);
  }
  const partsAbs = path.join(root, 'parts');
  if (fs.existsSync(partsAbs)) {
    for (const d of fs.readdirSync(partsAbs, { withFileTypes: true })) {
      if (!d.isDirectory()) { problems.push(`file not in the envelope (stale or hand-added): parts/${d.name}`); continue; }
      for (const f of fs.readdirSync(path.join(partsAbs, d.name))) {
        if (!listed.has(`parts/${d.name}/${f}`)) problems.push(`file not in the envelope (stale or hand-added): parts/${d.name}/${f}`);
      }
    }
  }

  // Every mapping follows the mapping format, checked against the schema the model itself carries.
  const mappingSchema = path.join(root, 'schema', 'mapping.schema.json');
  if (!fs.existsSync(mappingSchema)) {
    problems.push('schema/mapping.schema.json is missing: a published model carries the schema of its mapping format');
  } else {
    for (const rel of [...listed].filter((r) => r.endsWith('.mapping.json') && fs.existsSync(path.join(root, r)))) {
      let spec;
      try { spec = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch (err) { problems.push(`${rel}: not valid JSON (${err.message})`); continue; }
      for (const p of validateMapping(spec, mappingSchema)) problems.push(`${rel}: ${p}`);
    }
  }

  if (values.edm) {
    const actual = hashFile(path.resolve(values.edm));
    if (actual !== envelope.provenance.structure.sha256) {
      problems.push(`the model was not built from this structure export (sha256 ${actual.slice(0, 12)}… vs recorded ${envelope.provenance.structure.sha256.slice(0, 12)}…)`);
    }
  }
}

if (problems.length) {
  process.stderr.write(`Model verification FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map(p => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Model OK: ${envelope.counts.criteria} criteria, ESPD ${envelope.espdVersion}, UBL ${envelope.ublVersion}${values.edm ? ', structure hash matches' : ''}.\n`);

