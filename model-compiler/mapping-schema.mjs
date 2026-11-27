// Validation of XML mapping specs against schema/mapping.schema.json, the contract of the mapping format.
//
// Every mapping the compiler generates, and every hand-authored mapping of the administrative parts, is
// checked against it before it is published, and verify.mjs checks the published ones again. A generator that
// starts to emit a construct the format does not define, or an empty path, fails the build instead of
// publishing a mapping an engine would silently skip.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const mappingSchemaPath = path.join(here, 'schema', 'mapping.schema.json');

const validators = new Map();
function validatorFor(schemaFile) {
  if (!validators.has(schemaFile)) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    validators.set(schemaFile, ajv.compile(JSON.parse(fs.readFileSync(schemaFile, 'utf8'))));
  }
  return validators.get(schemaFile);
}

/**
 * The problems of a mapping spec (empty = valid). `schemaFile` is the schema to use: the compiler's own by
 * default, the one published next to a model when that model is verified.
 */
export function validateMapping(spec, schemaFile = mappingSchemaPath) {
  const validate = validatorFor(schemaFile);
  if (validate(spec)) return [];
  return validate.errors
    // The rule dispatch is an if/then/else chain; its own "must match then/else schema" errors only repeat
    // what the branch that applied has already said.
    .filter((e) => e.keyword !== 'if')
    .map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` ("${e.params.additionalProperty}")` : ''}`);
}
