#!/usr/bin/env node
// Compile every modeled criterion (one with a <code>.sidecar.json in the enrichment
// folder) and emit the implementer-neutral model layers into the output directory.
//
// Usage:
//   node build.mjs [--out <dir>] [--code <criterion-code>]...
//                  [--edm <espd-edm.json>] [--enrichment <dir>]
//                  [--codelists <dir>] [--schematron <espd-validation-schematron>]
//
// Inputs default to the sibling-checkout layout and can also be set through
// ESPD_EDM_JSON / ESPD_ENRICHMENT_DIR / ESPD_CODELISTS_DIR / ESPD_SCHEMATRON_ROOT
// (see config.mjs). Exit code is 1 if any criterion fails to compile.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { configure, edmPath, enrichmentDir, codelistsDir, schematronRoot } from './config.mjs';
import { loadEdm, loadSidecar, listModeledCodes, compile, emitModel } from './compile.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'outputs' },
    code: { type: 'string', multiple: true },
    edm: { type: 'string' },
    enrichment: { type: 'string' },
    codelists: { type: 'string' },
    schematron: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write('Usage: node build.mjs [--out <dir>] [--code <code>]... [--edm <file>] [--enrichment <dir>] [--codelists <dir>] [--schematron <dir>]\n');
  process.exit(0);
}

configure({ edm: values.edm, enrichment: values.enrichment, codelists: values.codelists, schematron: values.schematron });
const root = path.resolve(values.out);

// Map the instanceModel container's first segment to a part id.
const PART_BY_CONTAINER = { partI: 'I', partII: 'II', partIII: 'III', partIV: 'IV', partV: 'V', partVI: 'VI' };

process.stderr.write(
  `edm:        ${edmPath()}\nenrichment: ${enrichmentDir()}\ncodelists:  ${codelistsDir()}\nschematron: ${schematronRoot()}\nout:        ${root}\n\n`);

let all;
try {
  all = listModeledCodes();
} catch (err) {
  process.stderr.write(`Cannot read the enrichment criteria directory: ${err.message}\nSet --enrichment or ESPD_ENRICHMENT_DIR to the espd-conceptual-model/enrichment folder.\n`);
  process.exit(2);
}
const codes = values.code?.length ? values.code : all;
for (const c of codes) {
  if (!all.includes(c)) {
    process.stderr.write(`Unknown criterion '${c}' (no ${c}.sidecar.json in the enrichment folder)\n`);
    process.exit(2);
  }
}

const edm = loadEdm(edmPath());
let ok = 0, failed = 0, files = 0;
for (const code of codes) {
  try {
    const sidecar = loadSidecar(code);
    const { compiled, registry } = compile(edm, code, sidecar);
    const partId = PART_BY_CONTAINER[sidecar.criterion.instanceModel.containerPath[0]];
    files += emitModel(code, compiled, registry, { root, partId }).length;
    ok++;
    process.stderr.write(`✓ ${code}\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`✗ ${code}: ${err.message.split('\n')[0]}\n`);
  }
}

process.stderr.write(`\nGenerated ${files} files for ${ok}/${codes.length} criteria` + (failed ? `; ${failed} failed` : '') + ` under ${root}.\n`);
if (failed) process.exit(1);
