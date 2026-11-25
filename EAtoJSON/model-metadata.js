// Document-level versions for the export, read from the conceptual model.
//
// These were string literals at the bottom of exportCodeLists(), which is how
// codelists.json shipped "5.0.0-alpha.2" while every .gc file produced by the
// same run said 5.0.0. The literal was correct when it was written and nothing
// compared it to anything afterwards.
//
// The conceptual model is already the source of truth for every other version
// in the export - each code list reads its own <Version> from an EA tagged
// value - so the document-level versions are read the same way. A missing or
// malformed version aborts the export instead of falling back to a default: a
// silently wrong version is what reached a release branch last time, and a
// default is just a literal with extra steps.

// Code lists whose names carry one of these prefixes are maintained outside the
// ESPD model (EU Vocabularies, ESCO) and are downloaded at export time, so they
// carry their own publication dates as versions and are not checked against the
// ESPD version.
const EXTERNAL_VOCABULARY_PREFIXES = ['at-voc:', 'esco:']

// The EA element that carries the document-level versions as tagged values.
const METADATA_ELEMENT_NAME = 'ESPDMetadata'
const ESPD_VERSION_TAG = 'espdVersion'
const UBL_VERSION_TAG = 'ublVersion'

// major.minor.patch, with an optional pre-release tail: 5.0.0, 5.0.0-beta,
// 5.0.0-alpha.2. Deliberately strict: "5.0" and "v5.0.0" are rejected, because
// the value is copied verbatim into codelists.json, the .gc files and the
// Maven coordinate, all of which need the same spelling.
// Where the ESPD-maintained code lists are published, per release tag.
const ESPD_EDM_REPOSITORY = 'OP-TED/ESPD-EDM'

const ESPD_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const UBL_VERSION_PATTERN = /^\d+\.\d+$/

// Shared so the exported artefacts are held to the same spelling as the model.
const versionPatterns = {
  espd: ESPD_VERSION_PATTERN,
  ubl: UBL_VERSION_PATTERN,
}

const howToAddMetadata = (elementName) => [
  `Add the model metadata element to the conceptual model, in Enterprise Architect:`,
  `  1. create a Class named "${elementName}" in any package - it is found by name, not by location,`,
  `  2. give it the tagged value "${ESPD_VERSION_TAG}", e.g. 5.0.0,`,
  `  3. give it the tagged value "${UBL_VERSION_TAG}", e.g. 2.4,`,
  `  4. save the model and commit ESPD_CM.eapx.`,
].join('\n')

const isEnumeration = (obj) => obj.Object_Type === 'Enumeration'

const isExternalName = (name) =>
  EXTERNAL_VOCABULARY_PREFIXES.some(prefix => String(name ?? '').startsWith(prefix))

// "espd:CriterionElementType" -> "CriterionElementType"
const stripNamespace = (name) => String(name ?? '').replace(/^[^:]+:/, '')

const listInternalEnumerations = (db) =>
  db.objects.filter(obj => isEnumeration(obj) && !isExternalName(obj.Name))

const readTaggedValue = (db, objectId, property) => {
  const found = db.objectProperties.find(
    p => p.Object_ID === objectId && p.Property === property)
  const value = found?.Value
  return value == null || String(value).trim() === '' ? null : String(value).trim()
}

// Anywhere in the model: the element is located by name, not by package, so
// modellers can file it wherever it belongs in the model's own structure.
const findMetadataElements = (db, elementName) => {
  const wanted = elementName.toLowerCase()
  return db.objects.filter(
    obj => stripNamespace(obj.Name).trim().toLowerCase() === wanted)
}

const describe = (element) =>
  `Object_ID ${element.Object_ID}${element.Stereotype ? ` «${element.Stereotype}»` : ''}`

// Collects one declared value from however many elements carry the name.
//
// EA offers several ways to hang tagged values off an element, and some of them
// produce a second element with the same name - a «tag» child next to the class,
// for instance. Insisting on exactly one element rejected a model that was
// perfectly unambiguous about the version, so what matters here is the value,
// not how many elements spell it: duplicates agreeing on a value are accepted,
// and only genuinely conflicting declarations are an error.
const readDeclaredValue = (db, elements, property) => {
  const declarations = elements
    .map(element => ({ element, value: readTaggedValue(db, element.Object_ID, property) }))
    .filter(declaration => declaration.value !== null)

  const distinct = [...new Set(declarations.map(d => d.value))]

  if (distinct.length > 1) {
    const where = declarations
      .map(d => `"${d.value}" on ${describe(d.element)}`)
      .join(', ')
    throw new Error(
      `The model declares conflicting values for "${property}": ${where}. ` +
      `Leave exactly one declaration, or make them agree.`)
  }

  return { value: distinct[0] ?? null, declaredOn: declarations.map(d => d.element) }
}

// Points at elements that carry the right tagged values under the wrong name.
//
// The lookup is by name and stays that way, but "no ESPDMetadata element" is a
// dead end for a modeller who has just created the element and filled in both
// tagged values correctly - a leftover "1" on the name is enough to miss, and
// nothing in the message says so. Naming the near misses turns the failure into
// an instruction.
const describeNearMisses = (db, elementName) => {
  const owners = new Map()
  db.objectProperties
    .filter(p => p.Property === ESPD_VERSION_TAG || p.Property === UBL_VERSION_TAG)
    .forEach(p => {
      if (!owners.has(p.Object_ID)) owners.set(p.Object_ID, [])
      owners.get(p.Object_ID).push(`${p.Property}="${p.Value}"`)
    })

  if (owners.size === 0) return ''

  const found = [...owners.entries()].map(([objectId, declared]) => {
    const owner = db.objects.find(o => o.Object_ID === objectId)
    return `  - "${owner?.Name ?? `Object_ID ${objectId}`}" (${describe({ Object_ID: objectId, Stereotype: owner?.Stereotype })}) carries ${declared.join(', ')}`
  })

  return `\nThese elements carry the right tagged values but not the name ` +
    `"${elementName}":\n${found.join('\n')}\n` +
    `Rename one of them to exactly "${elementName}" and remove the others.\n`
}

// Reads the document-level versions, or throws. Never returns a default.
//
// elementName exists to diagnose a model that is not yet correct - pointing the
// read at a differently named element to rehearse the pipeline before the
// rename lands. It defaults to ESPDMetadata and the CI workflow never sets it,
// so the convention stays enforced where it matters.
const readModelMetadata = (db, { elementName = METADATA_ELEMENT_NAME } = {}) => {
  const elements = findMetadataElements(db, elementName)

  if (elements.length === 0) {
    throw new Error(
      `The conceptual model has no "${elementName}" element, so the ` +
      `ESPD and UBL versions cannot be determined.\n` +
      describeNearMisses(db, elementName) + `\n${howToAddMetadata(elementName)}`)
  }

  const espd = readDeclaredValue(db, elements, ESPD_VERSION_TAG)
  const ubl = readDeclaredValue(db, elements, UBL_VERSION_TAG)

  const problems = []
  if (!espd.value) {
    problems.push(`tagged value "${ESPD_VERSION_TAG}" is missing or empty`)
  } else if (!ESPD_VERSION_PATTERN.test(espd.value)) {
    problems.push(
      `tagged value "${ESPD_VERSION_TAG}" = "${espd.value}" is not a ` +
      `major.minor.patch version (expected e.g. 5.0.0 or 5.0.0-beta)`)
  }
  if (!ubl.value) {
    problems.push(`tagged value "${UBL_VERSION_TAG}" is missing or empty`)
  } else if (!UBL_VERSION_PATTERN.test(ubl.value)) {
    problems.push(
      `tagged value "${UBL_VERSION_TAG}" = "${ubl.value}" is not a ` +
      `major.minor version (expected e.g. 2.4)`)
  }

  if (problems.length > 0) {
    const found = elements.map(describe).join(', ')
    throw new Error(
      `The "${elementName}" declaration is incomplete (found on ${found}):\n` +
      problems.map(p => `  - ${p}`).join('\n') +
      `\n\n${howToAddMetadata(elementName)}`)
  }

  const carriers = [...new Set([...espd.declaredOn, ...ubl.declaredOn])]
  return {
    espdVersion: espd.value,
    ublVersion: ubl.value,
    source: `${elementName} (${carriers.map(describe).join(', ')})`,
  }
}

// Checks the document-level version against the release being built. Returns a
// list of human-readable problems; empty means consistent. The ESPD code lists
// used to be cross-checked here too; their versions are now derived from the
// document version, so they can no longer disagree with it.
//
// expectedVersion is the version the caller believes is being released (from a
// release branch name or a tag). Supplying it turns the check into a gate: it
// is what stops an export stamped 5.0.0-alpha.2 from being published as 5.0.0.
const verifyModelVersions = (db, metadata, { expectedVersion = null } = {}) => {
  const problems = []
  const { espdVersion } = metadata

  if (expectedVersion && expectedVersion !== espdVersion) {
    problems.push(
      `the model declares ${ESPD_VERSION_TAG} "${espdVersion}" but the release ` +
      `being built is "${expectedVersion}" - bump the "${METADATA_ELEMENT_NAME}" ` +
      `element in the conceptual model, or build the matching release`)
  }

  return problems
}

// The versioned identification of an ESPD-maintained code list, derived from
// the document version instead of being read from three EA tagged values per
// code list. Those 21 values (7 code lists x Version, CanonicalVersionUri,
// LocationUri) had to be edited by hand for every release and agree with
// ESPDMetadata; now ESPDMetadata.espdVersion is the only place the version is
// written. The shape is the one every 5.0.0 code list already uses, so a model
// at 5.0.0 exports byte-identical files.
const espdCodeListIdentification = (shortName, espdVersion) => ({
  version: espdVersion,
  canonicalVersionUri: `https://github.com/${ESPD_EDM_REPOSITORY}/tree/v${espdVersion}/`,
  locationUri: `https://raw.githubusercontent.com/${ESPD_EDM_REPOSITORY}/v${espdVersion}/codelists/${shortName}.gc`,
})

// The per-code-list tagged values are no longer read, so a stale one cannot
// reach a published file. They are still reported, so the model can be cleaned
// up, but they never stop an export.
const findStaleCodeListTags = (db, metadata) => {
  const warnings = []
  listInternalEnumerations(db).forEach(enumObj => {
    const name = enumObj.Name
    const derived = espdCodeListIdentification(stripNamespace(name), metadata.espdVersion)
    for (const [tag, key] of [['Version', 'version'], ['CanonicalVersionUri', 'canonicalVersionUri'], ['LocationUri', 'locationUri']]) {
      const declared = readTaggedValue(db, enumObj.Object_ID, tag)
      if (declared !== null && declared !== derived[key]) {
        warnings.push(
          `code list "${name}" tagged value ${tag} "${declared}" is ignored; ` +
          `the export writes "${derived[key]}". Remove the tagged value from the model.`)
      }
    }
  })
  return warnings
}

export {
  EXTERNAL_VOCABULARY_PREFIXES,
  METADATA_ELEMENT_NAME,
  ESPD_VERSION_TAG,
  UBL_VERSION_TAG,
  versionPatterns,
  isExternalName,
  stripNamespace,
  listInternalEnumerations,
  readModelMetadata,
  verifyModelVersions,
  espdCodeListIdentification,
  findStaleCodeListTags,
}
