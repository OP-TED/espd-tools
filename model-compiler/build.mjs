#!/usr/bin/env node
// Compile every modeled criterion (one with a <code>.sidecar.json in the enrichment
// folder) and publish the implementer-neutral model into the output directory:
//
//   instance-data/  xml-mapping/  compiled/   per criterion
//   parts/  registries/  schema/  compiled-model.json  README.md   (full runs only)
//
// Usage:
//   node build.mjs [--out <dir>] [--code <criterion-code>]... [--source-ref <text>]
//                  [--edm <espd-edm.json>] [--enrichment <dir>]
//                  [--codelists <dir>] [--schematron <espd-validation-schematron>]
//                  [--generator-commit <sha>]
//
// Inputs default to the sibling-checkout layout and can also be set through
// ESPD_EDM_JSON / ESPD_ENRICHMENT_DIR / ESPD_CODELISTS_DIR / ESPD_SCHEMATRON_ROOT
// (see config.mjs). --codelists must contain the .gc files and codelists.json.
//
// A full run (no --code) builds everything, including the envelope, in a staging folder next to
// --out. Only when all of it succeeded does it replace what a previous run produced under --out,
// so a failed run leaves the previous output as it was. A --code run only (re)writes those
// criteria in place and leaves the rest of --out alone.
//
// Exit code: 1 if any criterion fails to compile (nothing is published then),
// 2 for unusable arguments or inputs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configure, edmPath, enrichmentDir, codelistsDir, schematronRoot } from './config.mjs';
import { loadEdm, loadSidecar, listModeledCodes, compile, emitModel } from './compile.mjs';
import { leavesOf } from './read-structural-core.mjs';
import { buildEnvelope, validateEnvelope, hashFile, hashEnrichment, readVersions } from './envelope.mjs';
import { cleanOwned, OWNED, publishRegistries, publishSchema, publishReadme } from './publish.mjs';
import { publishParts } from './parts.mjs';
import { generatorCommit, COMMIT_PATTERN } from './generator-commit.mjs';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'outputs' },
    code: { type: 'string', multiple: true },
    'source-ref': { type: 'string' },
    'generator-commit': { type: 'string' },
    edm: { type: 'string' },
    enrichment: { type: 'string' },
    codelists: { type: 'string' },
    schematron: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write('Usage: node build.mjs [--out <dir>] [--code <code>]... [--source-ref <text>] [--generator-commit <sha>] [--edm <file>] [--enrichment <dir>] [--codelists <dir>] [--schematron <dir>]\n');
  process.exit(0);
}

if (values['generator-commit'] !== undefined && !COMMIT_PATTERN.test(values['generator-commit'])) {
  process.stderr.write(`--generator-commit must be a full 40-character commit hash, got '${values['generator-commit']}'\n`);
  process.exit(2);
}

configure({ edm: values.edm, enrichment: values.enrichment, codelists: values.codelists, schematron: values.schematron });
const root = path.resolve(values.out);
const fullRun = !values.code?.length;

// Map the instanceModel container's first segment to a part id.
const PART_BY_CONTAINER = { partI: 'I', partII: 'II', partIII: 'III', partIV: 'IV', partV: 'V', partVI: 'VI' };

process.stderr.write(
  `edm:        ${edmPath()}\nenrichment: ${enrichmentDir()}\ncodelists:  ${codelistsDir()}\nout:        ${root}\n\n`);

let all;
try {
  all = listModeledCodes();
} catch (err) {
  process.stderr.write(`Cannot read the enrichment criteria directory: ${err.message}\nSet --enrichment or ESPD_ENRICHMENT_DIR to the espd-conceptual-model/enrichment folder.\n`);
  process.exit(2);
}
const codes = fullRun ? all : values.code;
for (const c of codes) {
  if (!all.includes(c)) {
    process.stderr.write(`Unknown criterion '${c}' (no ${c}.sidecar.json in the enrichment folder)\n`);
    process.exit(2);
  }
}

// Where this run writes. A full run stages its output (see the header) and swaps it in at the end.
const stage = fullRun ? path.join(path.dirname(root), `.${path.basename(root)}.building-${process.pid}`) : null;
const outRoot = stage ?? root;
if (stage) {
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  // process.exit() is used for every failure below; this removes the staging folder on each of them.
  process.on('exit', () => fs.rmSync(stage, { recursive: true, force: true }));
}

const edm = loadEdm(edmPath());
const entries = [];
let ok = 0, failed = 0, files = 0, registry, valueTypeSource;
for (const code of codes) {
  try {
    const sidecar = loadSidecar(code);
    const result = compile(edm, code, sidecar);
    const { compiled } = result;
    registry = result.registry;
    valueTypeSource = result.provenance;
    const partId = PART_BY_CONTAINER[sidecar.criterion.instanceModel.containerPath[0]];
    const emitted = emitModel(code, compiled, registry, { root: outRoot, partId });
    files += emitted.written.length;
    const leaves = leavesOf(compiled);
    entries.push({
      key: code,
      id: compiled.id,
      code: sidecar.criterion.code,
      ...(sidecar.criterion.tag ? { tag: sidecar.criterion.tag } : {}),
      part: partId,
      leaves: leaves.length,
      repeatableBindings: Object.values(sidecar.components).filter(c => c.instanceBinding.repeatable).length,
      valueTypes: [...new Set(leaves.map(l => l.valueType))],
      files: emitted.files,
    });
    ok++;
    process.stderr.write(`✓ ${code}\n`);
  } catch (err) {
    failed++;
    process.stderr.write(`✗ ${code}: ${err.message.split('\n')[0]}\n`);
  }
}

process.stderr.write(`\nGenerated ${files} files for ${ok}/${codes.length} criteria` + (failed ? `; ${failed} failed` : '') + ` under ${root}.\n`);
if (failed) process.exit(1);

if (fullRun) {
  let versions;
  try {
    versions = readVersions(codelistsDir());
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const compilerDir = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(compilerDir, 'package.json'), 'utf8'));
  // The commit of this compiler, recorded in the envelope. Given explicitly, or read from the git checkout when it is
  // clean; otherwise none is recorded and the build says why.
  let commit = values['generator-commit'];
  if (commit === undefined) {
    const found = generatorCommit(compilerDir);
    commit = found.commit;
    if (!commit) process.stderr.write(`No generator commit is recorded: ${found.reason}.\n`);
  }
  const registries = publishRegistries(outRoot);
  let parts;
  try {
    parts = publishParts(outRoot);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  publishSchema(outRoot);
  const envelope = buildEnvelope({
    ...versions,
    provenance: {
      generator: { name: pkg.name, version: pkg.version, ...(commit ? { commit } : {}) },
      structure: { file: 'criterion/espd-edm.json', sha256: hashFile(edmPath()) },
      enrichment: hashEnrichment(enrichmentDir()),
      valueTypeSource: { shortName: valueTypeSource.shortName, version: valueTypeSource.version },
      ...(values['source-ref'] ? { sourceRef: values['source-ref'] } : {}),
    },
    entries,
    valueTypeRegistry: registry,
    registries,
    parts,
  });
  const problems = validateEnvelope(envelope);
  if (problems.length) {
    process.stderr.write(`The generated compiled-model.json does not match its schema:\n${problems.map(p => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  fs.writeFileSync(path.join(outRoot, 'compiled-model.json'), JSON.stringify(envelope, null, 2) + '\n');
  publishReadme(outRoot, envelope);

  // Everything succeeded: replace the previous output (and only the files this compiler owns).
  if (stage) {
    cleanOwned(root);
    fs.mkdirSync(root, { recursive: true });
    for (const name of OWNED) {
      if (fs.existsSync(path.join(stage, name))) fs.renameSync(path.join(stage, name), path.join(root, name));
    }
  }
  process.stderr.write(`Wrote compiled-model.json (ESPD ${envelope.espdVersion}, UBL ${envelope.ublVersion}), parts, registries, schema and README.\n`);
}
