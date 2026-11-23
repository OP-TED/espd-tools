// Publishing helpers: the files of the published model folder that are not
// per-criterion output (registries, schema, README) and the clean-up of a previous
// run. Everything here is deterministic.

import fs from 'node:fs';
import path from 'node:path';
import { enrichmentFile } from './config.mjs';
import { schemaPath } from './envelope.mjs';

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
    const text = patchSource(f, fs.readFileSync(enrichmentFile('registries', f), 'utf8'));
    fs.writeFileSync(path.join(dir, f), text);
  }
  return REGISTRY_FILES.map(f => `registries/${f}`);
}

/** Copy the envelope schema into <root>/schema. */
export function publishSchema(root) {
  const dir = path.join(root, 'schema');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(schemaPath, path.join(dir, 'compiled-model.schema.json'));
}

/** Write <root>/README.md describing the published layout. */
export function publishReadme(root, envelope) {
  const c = envelope.counts;
  const text = `# ESPD model

Generated. Do not hand-edit: this folder is rebuilt from the EA model and the enrichment
sources by \`espd-tools/model-compiler\` and replaced as a whole.

It is the implementer-neutral model that sits beside the criterion structure
(\`../criterion/espd-edm.json\`): for each modeled criterion, the shape of the data an
implementation stores and the mapping of that data to and from the UBL documents.

ESPD version ${envelope.espdVersion}, UBL ${envelope.ublVersion}. ${c.criteria} criteria, ${c.valueTypes} value types, ${c.partSections} sections of the administrative parts.

## Layout

| Path | Content |
| --- | --- |
| \`compiled-model.json\` | The manifest: versions, provenance, and an inventory of every criterion and value type with its files. Validated by \`schema/compiled-model.schema.json\`. Start here. |
| \`instance-data/<key>.schema.json\`, \`<key>.example.json\` | JSON Schema (draft 2020-12) and a minimal valid example of the instance data for one criterion. ${c.instanceDataFiles} files. |
| \`xml-mapping/<key>.request.mapping.json\`, \`<key>.response.mapping.json\` | Declarative specs that map the instance data to and from the UBL ESPD Request and Response. ${c.xmlMappingFiles} files. |
| \`compiled/<key>.json\` | The criterion as compiled from the EA structure plus the enrichment (structure, semantic ids, instance bindings, value types) with its constraint hints. Lets an implementation derive its own layers, such as a form, without the EA export. ${c.compiledFiles} files. |
| \`parts/<part>/index.json\`, \`section<L>.schema.json\`, \`.example.json\`, \`.mapping.json\`, \`.form.json\` | The administrative parts (I, II, VI), which are not criteria: for each section the instance-data schema, an example, the UBL mapping, and the form (fields, input types, labels, code lists). Authored in the enrichment and published verbatim. ${c.partSections} sections. |
| \`registries/\` | The shared registries: value types (JSON shape and UBL bindings), the XML encoding profile, fixed code list attribute sets, the scheme-agency policy, the roles, the codelist governance, and the vocabulary of form affordances (UI hints). |
| \`schema/\` | JSON Schema of \`compiled-model.json\`. |

\`<key>\` is the criterion's output identity and the file stem of all its files. Most criteria use
their EA code (for example \`slc-stand-to-gen\`); the Part II and V "other" criteria use
\`ot-<id>\` (for example \`ot-eo-size\`), which keeps their identity stable.

## Provenance

\`compiled-model.json\` records the SHA-256 of the exact structure export and of the enrichment
sources the model was built from, so the same inputs can be recognised and a stale model detected.
The hashes are taken over text with line endings normalised to LF.

## What is not here

The form of the criteria (layout, grouping, labels, translations) is the concern of each
implementation and is not part of this model. The forms of the administrative parts are, because
every implementation has to fill in the same Part I, II and VI.
`;
  fs.writeFileSync(path.join(root, 'README.md'), text);
}
