// Shared helpers of the compiler's tests.
//
// Most tests need real inputs: the EA export, the enrichment folder, the shipped code lists and, for a
// few, the Schematron checkout (see config.mjs). Without them a test cannot say anything:
//
//   - run by hand, it is SKIPPED, with a note that says which input is missing and how to set it;
//   - with ESPD_REQUIRE_INPUTS=1 (what CI sets) a missing input is a FAILURE, so a misconfigured CI
//     cannot pass by skipping everything.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { edmPath, enrichmentDir, codelistsDir, schematronRoot } from './config.mjs';

export const inputsRequired = process.env.ESPD_REQUIRE_INPUTS === '1';

const INPUTS = {
  edm: { label: 'the EA export (espd-edm.json)', env: 'ESPD_EDM_JSON', where: edmPath, present: (p) => fs.existsSync(p) },
  enrichment: { label: 'the enrichment folder', env: 'ESPD_ENRICHMENT_DIR', where: enrichmentDir, present: (p) => fs.existsSync(path.join(p, 'criteria')) && fs.existsSync(path.join(p, 'registries')) },
  codelists: { label: 'the code lists (with codelists.json)', env: 'ESPD_CODELISTS_DIR', where: codelistsDir, present: (p) => fs.existsSync(path.join(p, 'codelists.json')) },
  schematron: { label: 'the espd-validation-schematron checkout', env: 'ESPD_SCHEMATRON_ROOT', where: schematronRoot, present: (p) => fs.existsSync(path.join(p, 'common', 'sch')) },
};

/** What the criterion tests need: the export, the enrichment and the code lists. */
export const COMPILER_INPUTS = ['edm', 'enrichment', 'codelists'];

/** The inputs among `needs` that are not there, described for a human. */
export function missingInputs(needs) {
  return needs
    .map((name) => ({ name, ...INPUTS[name] }))
    .filter((i) => !i.present(i.where()))
    .map((i) => `${i.label} not found at ${i.where()} (set ${i.env})`);
}

/**
 * Why the tests that need `needs` cannot run, or false when they can. When ESPD_REQUIRE_INPUTS=1 a
 * missing input throws instead, which fails the test file that asked.
 */
export function skipReason(needs) {
  for (const name of needs) if (!INPUTS[name]) throw new Error(`testkit: unknown input '${name}'`);
  const missing = missingInputs(needs);
  if (!missing.length) return false;
  const text = `missing input: ${missing.join('; ')}`;
  if (inputsRequired) throw new Error(`${text}. ESPD_REQUIRE_INPUTS=1 is set, so this is a failure and not a skip.`);
  return text;
}

/** `check(name, fn)`: a test that is skipped when `skip` is a reason (a string). `fn` may be async. */
export const checkWith = (skip = false) => (name, fn) => test(name, { skip }, fn);

/** A check that passes with no inputs. */
export const check = checkWith(false);

/**
 * `expectThrow(name, fn, snippet)`: fn must throw, and when `snippet` is given the message must contain it.
 */
export const expectThrowWith = (skip = false) => (name, fn, snippet) => test(name, { skip }, () => {
  assert.throws(fn, (err) => {
    if (snippet) assert.ok(err.message.includes(snippet), `error missing '${snippet}' (got: ${err.message.split('\n')[0]})`);
    return true;
  });
});
