#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import MDBReader from 'mdb-reader'
import { create } from 'xmlbuilder2'

const [, , eaFile = 'ESPD_CM.eapx', outputDir = './outputs/code-lists'] = process.argv

const EXTERNAL_VOCABULARY_PREFIXES = ['at-voc:', 'esco:']

// const LANGUAGE_CODES = [
//   'bul', 'spa', 'ces', 'dan', 'deu', 'est', 'ell', 'eng',
//   'fra', 'gle', 'hrv', 'ita', 'lav', 'lit', 'hun', 'mlt',
//   'nld', 'pol', 'por', 'ron', 'slk', 'slv', 'fin', 'swe',
// ]

const LANGUAGE_CODES = [
  'eng',
]

// ============================================================================
// Data Filtering
// ============================================================================

const isEnumeration = (obj) => obj.Object_Type === 'Enumeration'

const isNotExternalVocabulary = (obj) =>
  !EXTERNAL_VOCABULARY_PREFIXES.some(prefix => obj.Name.startsWith(prefix))

const isEnumerationValue = (objectId) => (attr) =>
  attr.Object_ID === objectId &&
  attr.Stereotype === 'enum' &&
  attr.StyleEx?.includes('IsLiteral=1')

// ============================================================================
// Pure Functions - Data Transformation
// ============================================================================

function normalizeKey (key) {
  return key.trim().replace(/_+/g, ' ')       // collapse multiple underscores
    .replace(/\s+/g, ' ')      // normalize spaces
    .toLowerCase()
}

const transformEnumerationValue = (attr) => ({
  code: attr.Name,
  name: attr.Default || normalizeKey(attr.Name),
  type: attr.Type || null,
  notes: attr.Notes || null,
  scope: attr.Scope || null,
  attributeId: attr.ID,
  eaGuid: attr.ea_guid,
  default: attr.Default || null,
})

const transformEnumeration = (attributes) => (enumObj) => {
  const enumValues = attributes.filter(isEnumerationValue(enumObj.Object_ID)).
    map(transformEnumerationValue)

  return {
    name: enumObj.Name,
    objectId: enumObj.Object_ID,
    packageId: enumObj.Package_ID,
    eaGuid: enumObj.ea_guid,
    description: enumObj.Note || null,
    stereotype: enumObj.Stereotype || null,
    valueCount: enumValues.length,
    values: enumValues,
  }
}

// ============================================================================
// XML Generation
// ============================================================================

const generateGcXml = (enumeration) => {
  const shortName = enumeration.name.replace('espd:', '')
  const listId = shortName.replace(/([A-Z])/g, '-$1').toLowerCase().substring(1)

  // Build the document
  const root = create({ version: '1.0', encoding: 'UTF-8' }).
    ele('gc:CodeList',
      { 'xmlns:gc': 'http://docs.oasis-open.org/codelist/ns/genericode/1.0/' })

  // Identification section
  const identification = root.ele('Identification')
  identification.ele('ShortName').txt(shortName)
  identification.ele('LongName').txt(shortName)
  identification.ele('LongName', { 'Identifier': 'listId' }).txt(listId)
  identification.ele('Version').txt('4.1.0')
  identification.ele('CanonicalUri').txt('https://github.com/OP-TED/ESPD-EDM')
  identification.ele('CanonicalVersionUri').
    txt('https://github.com/OP-TED/ESPD-EDM/tree/v4.1.0/')
  identification.ele('LocationUri').
    txt(
      `https://raw.githubusercontent.com/OP-TED/ESPD-EDM/v4.1.0/codelists/gc/${shortName}.gc`)

  const agency = identification.ele('Agency')
  agency.ele('ShortName').txt('Publications Office')
  agency.ele('LongName').txt('Publications Office of the European Union')
  agency.ele('Identifier', { 'Identifier': 'TED-OP-ESPD' })

  // ColumnSet section
  const columnSet = root.ele('ColumnSet')

  // Add code column
  const codeCol = columnSet.ele('Column', { 'Id': 'code', 'Use': 'required' })
  codeCol.ele('ShortName').txt('Code')
  codeCol.ele('Data', { 'Type': 'normalizedString', 'Lang': 'eng' })

  // Add Name column
  const nameCol = columnSet.ele('Column', { 'Id': 'Name', 'Use': 'optional' })
  nameCol.ele('ShortName').txt('Name')
  nameCol.ele('Data', { 'Type': 'string', 'Lang': 'eng' })

  // Add status column
  const statusCol = columnSet.ele('Column',
    { 'Id': 'status', 'Use': 'required' })
  statusCol.ele('ShortName').txt('Status')
  statusCol.ele('Data', { 'Type': 'normalizedString', 'Lang': 'eng' })

  // Add language columns
  LANGUAGE_CODES.forEach(lang => {
    const langCol = columnSet.ele('Column',
      { 'Id': `name-${lang}`, 'Use': 'optional' })
    langCol.ele('ShortName').txt('Name')
    langCol.ele('Data', { 'Type': 'string', 'Lang': lang })
  })

  // Add Key
  const key = columnSet.ele('Key', { 'Id': 'codeKey' })
  key.ele('ShortName').txt('CodeKey')
  key.ele('ColumnRef', { 'Ref': 'code' })

  // SimpleCodeList section
  const simpleCodeList = root.ele('SimpleCodeList')

  // Add rows
  enumeration.values.forEach(value => {
    const row = simpleCodeList.ele('Row')

    row.ele('Value', { 'ColumnRef': 'code' }).ele('SimpleValue').txt(value.code)

    row.ele('Value', { 'ColumnRef': 'Name' }).ele('SimpleValue').txt(value.name)

    row.ele('Value', { 'ColumnRef': 'status' }).ele('SimpleValue').txt('ACTIVE')

    row.ele('Value', { 'ColumnRef': 'name-eng' }).
      ele('SimpleValue').
      txt(value.name)
  })

  return root.end({ prettyPrint: true, indent: '  ' })
}

// ============================================================================
// Composition Functions
// ============================================================================

const extractEnumerations = (database) => {
  const { objects, attributes } = database

  const enumerations = objects.filter(isEnumeration).
    filter(isNotExternalVocabulary).
    map(transformEnumeration(attributes))

  return {
    enumerations,
    stats: {
      totalFound: objects.filter(isEnumeration).length,
      espdCount: enumerations.length,
      externalCount: objects.filter(isEnumeration).length - enumerations.length,
    },
  }
}

// ============================================================================
// Main Processing
// ============================================================================

function exportCodeLists (db) {

  const { enumerations, stats } = extractEnumerations(db)

  console.log(
    `Found ${stats.totalFound} total enumerations (${stats.espdCount} ESPD, ${stats.externalCount} external excluded)`)

// Create output directory
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })

// Generate .gc files
  let successCount = 0
  enumerations.forEach(enumeration => {
    const shortName = enumeration.name.replace('espd:', '')
    const outputFile = path.join(outputDir, `${shortName}.gc`)

    try {
      const xml = generateGcXml(enumeration)
      fs.writeFileSync(outputFile, xml, 'utf-8')
      console.log(
        `✓ Generated ${shortName}.gc (${enumeration.values.length} values)`)
      successCount++
    } catch (error) {
      console.error(`✗ Failed to generate ${shortName}.gc:`, error.message)
    }
  })

  console.log(`
Wrote ${successCount}/${enumerations.length} .gc files in ${outputDir}`)

}

export { exportCodeLists }
