import { create, convert } from 'xmlbuilder2'

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

const transformEnumeration = (attributes, objectProperties) => (enumObj) => {
  const locationUriProp = objectProperties.find(p =>
  p.Object_ID === enumObj.Object_ID && p.Property === 'LocationUri')

  const canonicalUriProp = objectProperties.find(p =>
  p.Object_ID === enumObj.Object_ID && p.Property == 'CanonicalUri')

  const canonicalVersionUriProp = objectProperties.find(p =>
  p.Object_ID === enumObj.Object_ID && p.Property == 'CanonicalVersionUri')

  const versionProp = objectProperties.find(p =>
  p.Object_ID === enumObj.Object_ID && p.Property == 'Version')

  const longNameProp = objectProperties.find(p =>
  p.Object_ID === enumObj.Object_ID && p.Property == 'LongName')

  const locationUri = locationUriProp?.Value ?? null
  const canonicalUri = canonicalUriProp?.Value ?? null
  const canonicalVersionUri = canonicalVersionUriProp?.Value ?? null
  const version = versionProp?.Value ?? null
  const longName = longNameProp?.Value ?? null

  const enumValues = attributes.filter(isEnumerationValue(enumObj.Object_ID))
  .map(transformEnumerationValue)

  return {
    name: enumObj.Name,
    longName: longName,
    objectId: enumObj.Object_ID,
    packageId: enumObj.Package_ID,
    eaGuid: enumObj.ea_guid,
    description: enumObj.Note || null,
    stereotype: enumObj.Stereotype || null,
    valueCount: enumValues.length,
    values: enumValues,
    locationUri: locationUri,
    canonicalUri: canonicalUri,
    canonicalVersionUri: canonicalVersionUri,
    version: version
  }
}

// ============================================================================
// XML Generation
// ============================================================================

const generateGcXml = (enumeration) => {
  const shortName = enumeration.name.replace('espd:', '')
  const longName = enumeration.longName || shortName
  const listId = shortName.replace(/([A-Z])/g, '-$1').toLowerCase().substring(1)

  // Build the document
  const root = create({ version: '1.0', encoding: 'UTF-8' }).
    ele('gc:CodeList',
      { 'xmlns:gc': 'http://docs.oasis-open.org/codelist/ns/genericode/1.0/' })

  // Identification section
  const identification = root.ele('Identification')
  identification.ele('ShortName').txt(shortName)
  identification.ele('LongName').txt(longName)
  identification.ele('Version').txt(enumeration.version)
  identification.ele('CanonicalUri').txt(enumeration.canonicalUri)
  identification.ele('CanonicalVersionUri').txt(enumeration.canonicalVersionUri)
  identification.ele('LocationUri').txt(enumeration.locationUri)
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
  // We will use one column with multiple languages in this form: {"eng" : "Check Box FALSE"}
  LANGUAGE_CODES.forEach(lang => {
    const langCol = columnSet.ele('Column',
      { 'Id': `name-${lang}`, 'Use': 'optional' })
    langCol.ele('ShortName').txt('Name')
    langCol.ele('Data', { 'Type': 'string', 'Lang': lang })
  })

  function extractLangText (raw, lang) {
  if (raw == null) return ''
  if (typeof raw !== 'string') return String(raw)

  const t = raw.trim()

  // Common case in your output: JSON object as string
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const obj = JSON.parse(t)
      const v = obj?.[lang]
      if (typeof v === 'string') return v
    } catch (error) {
      return {
        Language: lang,
        error: error.message,
        success: false
      }
    }
  }

  return raw
}  
  // Add Key
  const key = columnSet.ele('Key', { 'Id': 'codeKey' })
  key.ele('ShortName').txt('CodeKey')
  key.ele('ColumnRef', { 'Ref': 'code' })

  // SimpleCodeList section
  const simpleCodeList = root.ele('SimpleCodeList')

  // Add rows
  enumeration.values.forEach(value => {
    const row = simpleCodeList.ele('Row')

    const codeText = extractLangText(value.code, 'eng')
    row.ele('Value', { 'ColumnRef': 'code' }).ele('SimpleValue').txt(codeText)
  
    const nameText = extractLangText(value.name, 'eng')
    row.ele('Value', { 'ColumnRef': 'Name' }).ele('SimpleValue').txt(nameText)


    row.ele('Value', { 'ColumnRef': 'status' }).ele('SimpleValue').txt('ACTIVE')

    row.ele('Value', { 'ColumnRef': 'name-eng' }).
      ele('SimpleValue').
      txt(nameText)
  })

  return root.end({ prettyPrint: true, indent: '  ' })
}

// ============================================================================
// XML Downloading
// ============================================================================
const USER_AGENT = 'OP-SDK-codelist-update'

async function downloadGcXml(enumeration) {
  const url = enumeration.locationUri
  if (!url) {
    throw new Error(
      `No download URL provided for external codelist "${enumeration.name}"`
    )
  }
  if( enumeration.name === 'at-voc:criterion') {
     throw new Error(
      `"${enumeration.name}" has been replaced by selection-criterion and exclusion ground.`
    )
  }
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Referer': 'https://github.com/OP-TED/eForms-SDK',
      'Origin': 'https://github.com/OP-TED/eForms-SDK',
    },
    redirect: 'follow',
  })

  if (!response.ok) {
    throw new Error(
      `Cannot download ${url} (HTTP ${response.status} ${response.statusText})`
    )
  }

  return await response.text()
}

// ============================================================================
// Composition Functions
// ============================================================================

const extractEnumerations = (database) => {
  const { objects, objectProperties, attributes } = database

  const enumerations = objects.filter(isEnumeration).
    map(transformEnumeration(attributes, objectProperties))
  
  // Split into internal vs external
  const enumerationsInternal = enumerations.filter(
    e => !EXTERNAL_VOCABULARY_PREFIXES.some(prefix =>
      e.name.startsWith(prefix)
    )
  )

  const enumerationsExternal = enumerations.filter(
    e => EXTERNAL_VOCABULARY_PREFIXES.some(prefix =>
      e.name.startsWith(prefix)
    )
  ) 
  return {
    enumerationsInternal,
    enumerationsExternal,
    stats: {
      totalFound: objects.filter(isEnumeration).length,
      espdCount: enumerationsInternal.length,
      externalCount: enumerationsExternal.length,
    },
  }
}

  function buildCodelistMetadata({
    id,
    version,
    source
  }) {
    return {
      id,
      version,
      source
    }
  }

function extractFromGcXml(xml, property) {
  try {
    const doc = convert(xml, { format: 'object' })
    if(property === "Version") {
      return (
        doc?.['gc:CodeList']
          ?.Identification
          ?.Version
          ?? null
      )
    } else if (property === "ShortName") {
      return (
      doc?.['gc:CodeList']
        ?.Identification
        ?.ShortName
        ?? null
      )
    }
  } catch {
    return null
  }
}

// ============================================================================
// Main Processing
// ============================================================================

async function exportCodeLists (db) {
  const { enumerationsInternal, enumerationsExternal, stats } = extractEnumerations(db)

  console.log(
    `Found ${stats.totalFound} total enumerations (${stats.espdCount} ESPD, ${stats.externalCount} external from EU vocabularies).`)
  const codelistIndex = []

  // Generate XML for each enumeration
  const resultsInternal = enumerationsInternal.map(enumeration => {
    const fullNameInt = enumeration.name.split(":")
    const source = fullNameInt[0]
    const shortName = fullNameInt[1]
    const longName = enumeration.longName
    try {
      const xml = generateGcXml(enumeration)
      const version = extractFromGcXml(xml, "Version")


      codelistIndex.push(
      buildCodelistMetadata({
        id: shortName,
        version,
        source
      })
    )

      return {
        kind: 'internal',
        fileName: `${shortName}.gc`,
        content: xml,
        valueCount: enumeration.values.length,
        success: true
      }
    } catch (error) {
      return {
        kind: 'internal',
        fileName: `${shortName}.gc`,
        error: error.message,
        success: false
      }
    }
  })

  const resultsExternal = await Promise.all(
    enumerationsExternal.map(async (enumeration) => {
      const fullNameExt  = enumeration.name.split(":")
        // .replace('at-voc:', '')
        // .replace('esco:', '')
      const source = fullNameExt[0]
      var shortName = fullNameExt[1]
      try {
        const xml = await downloadGcXml(enumeration)
        const version = extractFromGcXml(xml, "Version")
        shortName = extractFromGcXml(xml, "ShortName") || shortName
      codelistIndex.push(
        buildCodelistMetadata({
          id: shortName,
          version,
          source
        })
      )
        
        return {
          kind: 'external',
          fileName: `${shortName}.gc`,
          content: xml,
          success: true
        }
      } catch (error) {
        return {
          kind: 'external',
          fileName: `${shortName}.gc`,
          error: error.message,
          success: false
        }
      }
    })
  )

  const codelistMetadataFile = {
  ublVersion: '2.4',
  espdVersion: '5.0.0-alpha.2',
  codelists: codelistIndex
}

  return {
    internal: resultsInternal,
    external: resultsExternal,
    codelistMetadata: codelistMetadataFile,
    stats: {
      ...stats,
      internal: {
        total: resultsInternal.length,
        successful: resultsInternal.filter(r => r.success).length,
        failed: resultsInternal.filter(r => !r.success).length
      },
      external: {
        total: resultsExternal.length,
        successful: resultsExternal.filter(r => r.success).length,
        failed: resultsExternal.filter(r => !r.success).length
      }
    }
  }
}
export { exportCodeLists }
