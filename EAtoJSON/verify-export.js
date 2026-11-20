// Artefact-level version gate.
//
// model-metadata.js checks the model before anything is written. This checks
// the files that are about to be published, which is a different question: it
// reads codelists.json and the .gc files as a consumer would, with no access to
// the model or to the code that produced them. It is the step that would have
// stopped a codelists.json stamped 5.0.0-alpha.2 from being pushed next to .gc
// files stamped 5.0.0.
//
// Runs against either an exporter output directory or the codelists/ folder of
// the ESPD-EDM repository, which have the same shape.

import fs from 'fs'
import path from 'path'
import { convert } from 'xmlbuilder2'
import { versionPatterns } from './model-metadata.js'

const INDEX_FILE = 'codelists.json'
const ESPD_SOURCE = 'espd'

const byCodeUnit = (a, b) => {
  const x = String(a ?? '')
  const y = String(b ?? '')
  return x < y ? -1 : x > y ? 1 : 0
}

const canonicalOrder = (entries) =>
  [...entries].sort((a, b) => byCodeUnit(a.source, b.source) || byCodeUnit(a.id, b.id))

const readGcIdentification = (filePath) => {
  const doc = convert(fs.readFileSync(filePath, 'utf-8'), { format: 'object' })
  const identification = doc?.['gc:CodeList']?.Identification
  return {
    shortName: identification?.ShortName ?? null,
    version: identification?.Version ?? null,
  }
}

// Returns a list of human-readable problems; empty means the artefacts agree.
const verifyExportedCodeLists = (dir, { expectedVersion = null, schemasFile = null } = {}) => {
  const problems = []
  const indexPath = path.join(dir, INDEX_FILE)

  if (!fs.existsSync(indexPath)) {
    return [`${indexPath} does not exist - nothing to verify`]
  }

  let index
  try {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'))
  } catch (error) {
    return [`${indexPath} is not valid JSON: ${error.message}`]
  }

  const { espdVersion, ublVersion, codelists } = index

  if (!espdVersion) {
    problems.push(`${INDEX_FILE} has no "espdVersion"`)
  } else if (!versionPatterns.espd.test(espdVersion)) {
    problems.push(`${INDEX_FILE} espdVersion "${espdVersion}" is not a major.minor.patch version`)
  } else if (expectedVersion && espdVersion !== expectedVersion) {
    problems.push(
      `${INDEX_FILE} espdVersion is "${espdVersion}" but the release being built ` +
      `is "${expectedVersion}"`)
  }

  if (!ublVersion) {
    problems.push(`${INDEX_FILE} has no "ublVersion"`)
  } else if (!versionPatterns.ubl.test(ublVersion)) {
    problems.push(`${INDEX_FILE} ublVersion "${ublVersion}" is not a major.minor version`)
  }

  if (!Array.isArray(codelists) || codelists.length === 0) {
    problems.push(`${INDEX_FILE} lists no code lists`)
    return problems
  }

  // Duplicate ids would make the index ambiguous for a consumer resolving a
  // code list by id.
  const seen = new Map()
  codelists.forEach(entry => seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1))
  ;[...seen.entries()]
    .filter(([, count]) => count > 1)
    .forEach(([id, count]) => problems.push(`${INDEX_FILE} lists "${id}" ${count} times`))

  // Determinism guard. Without it the index can be reordered by nothing more
  // than network timing, which buries real changes in a permutation diff.
  const expectedOrder = canonicalOrder(codelists).map(e => `${e.source}/${e.id}`)
  const actualOrder = codelists.map(e => `${e.source}/${e.id}`)
  if (expectedOrder.join('\n') !== actualOrder.join('\n')) {
    const firstDivergence = actualOrder.findIndex((value, i) => value !== expectedOrder[i])
    problems.push(
      `${INDEX_FILE} is not in canonical order (source, then id): entry ${firstDivergence + 1} ` +
      `is "${actualOrder[firstDivergence]}", expected "${expectedOrder[firstDivergence]}"`)
  }

  // The index and the folder must describe the same set of files.
  const gcFiles = fs.readdirSync(dir).filter(name => name.endsWith('.gc'))
  const indexed = new Set(codelists.map(entry => `${entry.id}.gc`))

  codelists
    .filter(entry => !gcFiles.includes(`${entry.id}.gc`))
    .forEach(entry => problems.push(
      `${INDEX_FILE} lists "${entry.id}" but ${entry.id}.gc is missing from ${dir}`))

  gcFiles
    .filter(name => !indexed.has(name))
    .forEach(name => problems.push(`${name} is present in ${dir} but absent from ${INDEX_FILE}`))

  // Every ESPD-maintained code list carries the document version. External
  // ones carry their own EU Vocabularies publication date, so only their
  // presence and declared version are compared with the index.
  codelists.forEach(entry => {
    const filePath = path.join(dir, `${entry.id}.gc`)
    if (!fs.existsSync(filePath)) return

    let identification
    try {
      identification = readGcIdentification(filePath)
    } catch (error) {
      problems.push(`${entry.id}.gc cannot be parsed as genericode: ${error.message}`)
      return
    }

    if (!identification.version) {
      problems.push(`${entry.id}.gc has an empty <Version>`)
    } else if (String(identification.version) !== String(entry.version)) {
      problems.push(
        `${entry.id}.gc declares <Version> "${identification.version}" but ` +
        `${INDEX_FILE} records "${entry.version}"`)
    } else if (entry.source === ESPD_SOURCE && espdVersion &&
               String(identification.version) !== String(espdVersion)) {
      problems.push(
        `${entry.id}.gc is ESPD-maintained and declares <Version> ` +
        `"${identification.version}", but the document version is "${espdVersion}"`)
    }

    if (identification.shortName && String(identification.shortName) !== String(entry.id)) {
      problems.push(
        `${entry.id}.gc declares <ShortName> "${identification.shortName}", ` +
        `which does not match its index id "${entry.id}"`)
    }
  })

  if (schemasFile) {
    problems.push(...verifySchemas(schemasFile, ublVersion))
  }

  return problems
}

// The UBL version in codelists.json must match the UBL schemas actually
// shipped, which schemas.json describes per file.
const verifySchemas = (schemasFile, ublVersion) => {
  if (!fs.existsSync(schemasFile)) {
    return [`${schemasFile} does not exist - cannot cross-check ublVersion`]
  }

  let schemas
  try {
    schemas = JSON.parse(fs.readFileSync(schemasFile, 'utf-8')).schemas
  } catch (error) {
    return [`${schemasFile} is not valid JSON: ${error.message}`]
  }

  if (!Array.isArray(schemas) || schemas.length === 0) {
    return [`${schemasFile} lists no schemas`]
  }

  const ublSchemas = schemas.filter(schema => schema.standard === 'UBL')
  if (ublSchemas.length === 0) {
    return [`${schemasFile} lists no UBL schemas - cannot cross-check ublVersion`]
  }

  return ublSchemas
    .filter(schema => String(schema.version) !== String(ublVersion))
    .map(schema =>
      `${schemasFile} declares UBL ${schema.name} at version "${schema.version}", ` +
      `but ${INDEX_FILE} says ublVersion "${ublVersion}"`)
}

export { verifyExportedCodeLists }
