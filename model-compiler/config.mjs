// Explicit inputs of the model compiler.
//
// Every external input is resolved in one place, in this order of precedence:
//   1. a value passed to configure() (the build CLI maps its flags to this)
//   2. an environment variable
//   3. the sibling-checkout default (this repo, espd-conceptual-model, ESPD-EDM and
//      espd-validation-schematron checked out next to each other)
//
//   input                          flag             env                     default
//   EA export (espd-edm.json)      --edm            ESPD_EDM_JSON           ../EAtoJSON/outputs/espd-edm.json
//   enrichment folder              --enrichment     ESPD_ENRICHMENT_DIR     ../../espd-conceptual-model/enrichment
//   codelists (.gc)                --codelists      ESPD_CODELISTS_DIR      ../../ESPD-EDM/codelists
//   espd-validation-schematron     --schematron     ESPD_SCHEMATRON_ROOT    ../../espd-validation-schematron

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsRoot = path.resolve(here, '..');
const workspaceRoot = path.resolve(toolsRoot, '..');

const overrides = {};

/** Set explicit input locations (relative paths resolve against the cwd). */
export function configure({ edm, enrichment, codelists, schematron } = {}) {
  if (edm) overrides.edm = path.resolve(edm);
  if (enrichment) overrides.enrichment = path.resolve(enrichment);
  if (codelists) overrides.codelists = path.resolve(codelists);
  if (schematron) overrides.schematron = path.resolve(schematron);
}

const pick = (override, envName, fallback) =>
  override ?? (process.env[envName] ? path.resolve(process.env[envName]) : fallback);

/** The EA export (espd-edm.json). */
export const edmPath = () =>
  pick(overrides.edm, 'ESPD_EDM_JSON', path.join(toolsRoot, 'EAtoJSON', 'outputs', 'espd-edm.json'));

/** The enrichment folder (registries/, criteria/). */
export const enrichmentDir = () =>
  pick(overrides.enrichment, 'ESPD_ENRICHMENT_DIR', path.join(workspaceRoot, 'espd-conceptual-model', 'enrichment'));

/** The shipped Genericode code lists. */
export const codelistsDir = () =>
  pick(overrides.codelists, 'ESPD_CODELISTS_DIR', path.join(workspaceRoot, 'ESPD-EDM', 'codelists'));

/** The espd-validation-schematron checkout. */
export const schematronRoot = () =>
  pick(overrides.schematron, 'ESPD_SCHEMATRON_ROOT', path.join(workspaceRoot, 'espd-validation-schematron'));

/** A file inside the enrichment folder, e.g. enrichmentFile('registries', 'roles.json'). */
export const enrichmentFile = (...segments) => path.join(enrichmentDir(), ...segments);

/** The per-criterion enrichment directory (sidecars and hints). */
export const criteriaDir = () => enrichmentFile('criteria');

/** A code list file by name, e.g. codelistFile('ResponseDataType.gc'). */
export const codelistFile = (name) => path.join(codelistsDir(), name);

/** The Schematron file that defines the fixed codelist attribute sets. */
export const schematronAttributesFile = () =>
  path.join(schematronRoot(), 'common', 'sch', '01-ESPD-common-cl-attributes.sch');
