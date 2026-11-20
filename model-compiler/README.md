# ESPD model compiler

Compiles the EA export plus the enrichment sources into the published, implementer-neutral
ESPD model (`ESPD-EDM/model`). It is the model-driven successor of the ad-hoc compiler that grew
up inside the `espd-demo` reference implementation.

```
espd-edm.json      (EA structure, from EAtoJSON)      --+
enrichment/        (espd-conceptual-model/enrichment)   +--> model-compiler --> model/
codelists/*.gc     (exported with the structure)      --+
```

## What it does

For every criterion that has a `<code>.sidecar.json` in the enrichment folder it:

1. reads the structural core from `espd-edm.json` and overlays the sidecar (semantic ids,
   instance bindings, value types),
2. **gates on structural equivalence**: the compiled criterion projected back onto the EA
   structure must equal the source, so enrichment that drifted from a changed EA model fails the
   build instead of silently diverging,
3. validates every value type used against the value-type registry and `ResponseDataType.gc`,
4. emits the per-criterion layers (below).

A full run then adds the registries, the envelope schema, the envelope `compiled-model.json` and a
README. Presentation (form layout, UI types, labels, translations) is not produced here; it is the
concern of each implementation.

## The published model

```
model/
  README.md                      generated; explains the layout to consumers
  compiled-model.json            the envelope: versions, provenance hashes, inventory
  schema/compiled-model.schema.json
  instance-data/<key>.schema.json, <key>.example.json
  xml-mapping/<key>.request.mapping.json, <key>.response.mapping.json
  compiled/<key>.json            the criterion as joined from structure + enrichment (+ hints)
  registries/                    value-types, encoding-profile, codelist-attributes,
                                 scheme-agency-profile, roles, codelist-governance
```

`<key>` is the output identity of a criterion: its EA code, or `ot-<id>` for the Part II/V "other"
criteria.

`compiled/<key>.json` is what lets an implementation derive its own layers (for example a form)
from the published model without the EA export or the enrichment sources. This was checked with
the `espd-demo` form generator: all 62 forms derived from `compiled/` plus
`registries/value-types.json` are identical to the ones the demo generates today.

The envelope records the ESPD and UBL versions (read from `codelists.json`), the SHA-256 of the
structure export and of the enrichment sources (taken over text with line endings normalised to LF,
so Windows and Linux agree), the value-type source, and an inventory of criteria and value types
with their files. It is deterministic: the same inputs always yield the same bytes, so a publish
step that commits only on change stays quiet when nothing changed.

Two `source` paths inside the published registries are adapted to the ESPD-EDM layout
(`../../codelists/ResponseDataType.gc`, `../../validation/common/sch/01-ESPD-common-cl-attributes.sch`).
They are informational.

## Usage

```
cd model-compiler
npm ci
node build.mjs [--out <dir>] [--code <criterion-code>]... [--source-ref <text>]
               [--edm <espd-edm.json>] [--enrichment <dir>]
               [--codelists <dir>] [--schematron <espd-validation-schematron>]
```

A full run (no `--code`) first removes what a previous run produced under `--out`, then writes
everything. A run with `--code` only writes those criteria and leaves the rest of `--out` alone.
`--source-ref` is recorded in the envelope (the workflow passes the source commits).

### Inputs

Every external input is explicit, resolved in this order: flag, environment variable,
sibling-checkout default (see `config.mjs`).

| Input | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| EA export | `--edm` | `ESPD_EDM_JSON` | `../EAtoJSON/outputs/espd-edm.json` |
| Enrichment folder | `--enrichment` | `ESPD_ENRICHMENT_DIR` | `../../espd-conceptual-model/enrichment` |
| Code lists and `codelists.json` | `--codelists` | `ESPD_CODELISTS_DIR` | `../../ESPD-EDM/codelists` |
| Schematron checkout | `--schematron` | `ESPD_SCHEMATRON_ROOT` | `../../espd-validation-schematron` |

`--codelists` must hold the `.gc` files and the `codelists.json` that carries `espdVersion` and
`ublVersion`. When publishing, point it at the code lists exported together with the structure so
that both come from the same run. The Schematron is only read to cross-check the codelist-attribute
profile (`validateCodelistProfile`), not by the build.

Exit code: 0 ok, 1 a criterion failed to compile (nothing is published), 2 unusable arguments or
inputs.

## Verifying a published model

> **TODO:** run this in ESPD-EDM's own Checks workflow, which is not on the 5.0.0 branches yet. The call is
> `node verify.mjs --model model --edm criterion/espd-edm.json`. Until then nothing verifies the published folder automatically.

```
node verify.mjs --model <ESPD-EDM/model> [--edm <ESPD-EDM/criterion/espd-edm.json>]
```

Checks that the envelope conforms to its schema, that every file it lists exists, that no unlisted
file lingers in the generated folders, and, with `--edm`, that the model was built from that
structure export. Meant for ESPD-EDM's own checks.

## Publishing

`espd-conceptual-model/.github/workflows/export-update-edm.yml` exports the model, runs this
compiler on the fresh export, and copies the result to `ESPD-EDM/model` on the branch named like the
run, or on the branch given as `edm_branch` (which must already exist). It never pushes to `main`:
the check is on the ESPD-EDM branch being written, so a run with `edm_branch=main` is a dry run. The compile step runs before ESPD-EDM is touched, so a model that does not
compile stops the run. The `espd_tools_ref` it is given must contain `model-compiler`.

ESPD-EDM's README lists its folders; a row for the new folder belongs there:

| Folder | Content |
| --- | --- |
| **model** | The implementer-neutral model, generated by `espd-tools/model-compiler`: per criterion the instance-data JSON Schema and example, the UBL request/response mapping specs and the compiled criterion, plus the shared registries. `compiled-model.json` is the manifest and records which structure export and enrichment sources it was built from. |

## Tests

```
npm ci
npm test
```

These are the tests that need only the compiler's own inputs (the generators, the envelope).
Tests that run the generated mapping specs through the mapping engine, and tests of the demo's UI
generation, stay in `espd-demo`.

## Status

This is the only model compiler. The generators started as the neutral half of the compiler in
`espd-demo`, with all hard-coded sibling paths replaced by `config.mjs`. `espd-demo` has since been
switched to consume the published model and no longer contains a compiler: it vendors
`ESPD-EDM/model` and builds only its own presentation layers from it. Changes to the generators are
therefore made here only.

Known limitations of the published mappings, found by the demo's roundtrip test over every published
example (candidates for fixes in the generators):

- a numeric `QUANTITY` answer comes back as a string (`slc-stand-ratio`: the response mapping has no
  numeric type);
- a buyer `URL` requirement is not written to the Request (`slc-suit-reg-trade`: `URL` is response-only
  in the value-type registry);
- the branching criterion `slc-stand-other` (rating / descriptive / amountRequirements) loses requirement
  leaves, gains extra array items, and returns a rating as a string.

The generator-focused probe tests that used to live in `espd-demo` (nested arrays, repeatable groups,
the C07 and breadth probes, the response-mapping roundtrip) were not ported: they also exercised the
mapping engine and the form generator, which stay in the demo. Their intent is covered by the generic
roundtrip over all 62 published criteria in the demo and by the parity and generic tests here; porting
their generator-only assertions is open work.
