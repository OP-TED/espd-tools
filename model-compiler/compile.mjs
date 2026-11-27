// The model compiler core: joins the EA structure (espd-edm.json) with the
// enrichment sidecars, gates on structural equivalence, validates value types, and
// emits the implementer-neutral model layers per criterion:
//
//   instance-data/<code>.schema.json + <code>.example.json   instance-data schema + example
//   xml-mapping/<code>.request.mapping.json + .response.mapping.json   UBL mapping specs
//
// Presentation layers (form structure, UI bundle) are NOT produced here; they are
// the consuming application's concern.
//
// All inputs come from ./config.mjs; see build.mjs for the CLI.

import fs from 'node:fs';
import path from 'node:path';
import { readStructuralCore, leavesOf } from './read-structural-core.mjs';
import { overlayEnrichment } from './overlay-enrichment.mjs';
import { assertStructuralEquivalence } from './structural-equivalence.mjs';
import { loadValidatedRegistry, validateCriterionValueTypes } from './value-type-registry.mjs';
import { generateRequestMapping } from './generate-request-mapping.mjs';
import { generateResponseMapping } from './generate-response-mapping.mjs';
import { generateInstanceSchema, generateExample } from './generate-instance-schema.mjs';
import { criteriaDir } from './config.mjs';
import { compareCodePoint } from './order.mjs';
import { validateMapping } from './mapping-schema.mjs';

export function loadEdm(sourcePath) {
  return JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
}

export function loadSidecar(code, dir = criteriaDir()) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${code}.sidecar.json`), 'utf8'));
}

export function loadHints(code, dir = criteriaDir()) {
  const hintsPath = path.join(dir, `${code}.hints.json`);
  if (!fs.existsSync(hintsPath)) return null;
  return JSON.parse(fs.readFileSync(hintsPath, 'utf8'));
}

/** The criterion codes that have a sidecar in the enrichment folder (sorted). */
export function listModeledCodes(dir = criteriaDir()) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.sidecar.json'))
    .map(f => f.replace('.sidecar.json', ''))
    .sort(compareCodePoint);
}

export function compile(edm, code, sidecar) {
  // The EA lookup uses the sidecar's declared `criterion.code` (the real
  // espd-edm.json code) when present; the `code` argument is the sidecar/output
  // identity (its filename stem), which equals the EA code for the usual case
  // but differs for the Part II/V 'other' criteria (filename e.g.
  // 'ot-reduction-of-candidates', EA code 'staff-red'). `tag` (e.g. 'C63_OT')
  // disambiguates codes that are not unique.
  const eaCode = sidecar?.criterion?.code ?? code;
  const tag = sidecar?.criterion?.tag;
  const core = readStructuralCore(edm, eaCode, tag);
  if (!sidecar) return { core, leaves: leavesOf(core) };
  const compiled = overlayEnrichment(core, sidecar);
  assertStructuralEquivalence(edm, eaCode, compiled, tag);
  const { registry, provenance } = loadValidatedRegistry();
  validateCriterionValueTypes(compiled, registry);
  return { core, compiled, leaves: leavesOf(compiled), registry, provenance };
}

/** Generate both XML mapping specs for a compiled criterion. */
export function generateMappings(compiled, registry) {
  return {
    request: generateRequestMapping(compiled, registry),
    response: generateResponseMapping(compiled, registry),
  };
}

/**
 * Emit the neutral layers for a compiled criterion as per-criterion files under
 * `root`:
 *   instance-data/<key>.schema.json + <key>.example.json
 *   xml-mapping/<key>.request.mapping.json + <key>.response.mapping.json
 *   compiled/<key>.json   the joined EA structure + enrichment (+ hints), so a
 *                         consumer can derive its own layers (e.g. a form) from the
 *                         published model without the EA export or the sidecars.
 *
 * A mapping that cannot be generated is an error: the criterion fails to compile and nothing
 * is published, rather than publishing a model that lacks its XML mapping. So is a mapping that
 * does not match schema/mapping.schema.json, the contract of the mapping format. (`mappings` is
 * the mapping generator; it is a parameter so that this can be tested.)
 *
 * Returns { written, files }: `written` are the paths relative to the cwd, `files`
 * the paths relative to `root` (forward slashes).
 */
export function emitModel(code, compiled, registry, { root, partId, mappings = generateMappings } = {}) {
  if (!root) throw new Error('emitModel: { root } is required');
  const written = [];
  const write = (sub, name, obj) => {
    const dir = path.join(root, sub);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
    written.push(path.relative(process.cwd(), p));
    return `${sub}/${name}`;
  };

  const hints = loadHints(code);
  const instanceSchema = write('instance-data', `${code}.schema.json`, generateInstanceSchema(compiled, registry, { partId, hints, outputId: code }));
  const instanceExample = write('instance-data', `${code}.example.json`, generateExample(compiled, registry, hints));

  let request, response;
  try {
    ({ request, response } = mappings(compiled, registry));
  } catch (err) {
    throw new Error(`The XML mapping of '${code}' could not be generated: ${err.message}`, { cause: err });
  }
  for (const [side, spec] of [['request', request], ['response', response]]) {
    const problems = validateMapping(spec);
    if (problems.length) {
      throw new Error(`The ${side} XML mapping of '${code}' does not match schema/mapping.schema.json:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    }
  }
  const requestMapping = write('xml-mapping', `${code}.request.mapping.json`, request);
  const responseMapping = write('xml-mapping', `${code}.response.mapping.json`, response);

  const compiledFile = write('compiled', `${code}.json`, {
    $comment: 'GENERATED. The criterion as compiled from the EA structure plus the enrichment: structure, semantic ids, instance bindings and value types, with the instance-data constraint hints. Lets a consumer derive its own layers (for example a form) from the published model. Do not hand-edit; regenerate.',
    key: code,
    partId: partId ?? null,
    criterion: compiled,
    hints: hints ?? null,
  });
  // The key order is the one the published envelope has always had; keeping it keeps the published bytes the same.
  const files = { requestMapping, responseMapping, instanceSchema, instanceExample, compiled: compiledFile };
  return { written, files };
}
