# ESPD model compiler

Compiles the EA export plus the enrichment sources into the implementer-neutral ESPD model
layers. It is the model-driven successor of the ad-hoc compiler that grew up inside the
`espd-demo` reference implementation.

```
espd-edm.json      (EA structure, from EAtoJSON)      --+
enrichment/        (espd-conceptual-model/enrichment)   +--> model-compiler --> instance-data/, xml-mapping/
codelists/*.gc     (ESPD-EDM/codelists)               --+
```

## What it does

For every criterion that has a `<code>.sidecar.json` in the enrichment folder it:

1. reads the structural core from `espd-edm.json` and overlays the sidecar (semantic ids,
   instance bindings, value types),
2. **gates on structural equivalence**: the compiled criterion projected back onto the EA
   structure must equal the source, so enrichment that drifted from a changed EA model fails,
3. validates every value type used against the value-type registry and `ResponseDataType.gc`,
4. emits, per criterion:
   - `instance-data/<code>.schema.json` and `<code>.example.json`
   - `xml-mapping/<code>.request.mapping.json` and `<code>.response.mapping.json`

Presentation layers (form structure, UI bundle, i18n) are not produced here. They are the
consuming application's concern.

## Usage

```
cd model-compiler
node build.mjs [--out <dir>] [--code <criterion-code>]...
               [--edm <espd-edm.json>] [--enrichment <dir>]
               [--codelists <dir>] [--schematron <espd-validation-schematron>]
```

No dependencies are needed to build (Node 18 or newer). `npm install` is only needed to run the
tests (`ajv`).

### Inputs

Every external input is explicit, resolved in this order: flag, environment variable,
sibling-checkout default (see `config.mjs`).

| Input | Flag | Environment variable | Default |
| --- | --- | --- | --- |
| EA export | `--edm` | `ESPD_EDM_JSON` | `../EAtoJSON/outputs/espd-edm.json` |
| Enrichment folder | `--enrichment` | `ESPD_ENRICHMENT_DIR` | `../../espd-conceptual-model/enrichment` |
| Code lists | `--codelists` | `ESPD_CODELISTS_DIR` | `../../ESPD-EDM/codelists` |
| Schematron checkout | `--schematron` | `ESPD_SCHEMATRON_ROOT` | `../../espd-validation-schematron` |

The Schematron is only read to cross-check the codelist-attribute profile. The `source` paths
inside the enrichment registries are informational; the flags above decide what is read.

The exit code is 1 if any criterion fails to compile, 2 for unusable arguments or inputs.

## Tests

```
npm install
npm test
```

The tests here are the ones that need only the compiler's own inputs. Tests that run the generated
mapping specs through the mapping engine, and tests of the demo's UI generation, stay in
`espd-demo`.

## Status

This is a copy of the neutral half of `espd-demo/model/compiler` with all hard-coded sibling
paths replaced by `config.mjs`. Both produce byte-identical output for all 62 criteria. Until the
demo is switched to consume the published model, the demo keeps its own copy, so a change to a
generator has to be made in both places.
