// ============================================
// ESPD-EDM Parser - Improved Version
// ============================================

import { getLabels } from './fetch-labels.js'
import chalk from 'chalk'

// Configuration and Constants
const NODE_TYPES = {
  LEGISLATION: /\/L\d+(\r?\n)?$/,
  CAPTION: '/CA',
  ADDITIONAL_DESCRIPTION_LINE: '/ADL',
  SUBCRITERION: '/SBC',
  QUESTION: /\/Q\d+(\r?\n)?$/,
  REQUIREMENT: /\/RQ\d+(\r?\n)?$/,
  QUESTION_SUBGROUP: '/QSG',
  QUESTION_GROUP: '/QG',
  REQUIREMENT_SUBGROUP: '/RSG',
  REQUIREMENT_GROUP: '/RG',
  // INFORMATION structures (e.g. Part I contracting body).
  // Anchored to the end of the label so nested paths don't collide
  // (e.g. ".../PAR1" must not match POSTAL_ADDRESS "/PA").
  CONTRACTING_PARTY: /\/CP\d+(\r?\n)?$/,
  PARTY: /\/PAR\d+(\r?\n)?$/,
  PARTY_IDENTIFICATION: /\/PI\d+(\r?\n)?$/,
  PARTY_NAME: /\/PN\d+(\r?\n)?$/,
  POSTAL_ADDRESS: /\/PA\d+(\r?\n)?$/,
  CONTACT: /\/CTC\d+(\r?\n)?$/,
  COUNTRY: /\/CTR\d+(\r?\n)?$/,
  // INFORMATION: additional document reference (I68) and procurement project (I70).
  // End-anchored to avoid ADR/ADL and PP/PPL collisions.
  ADDITIONAL_DOCUMENT_REFERENCE: /\/ADR\d+(\r?\n)?$/,
  ATTACHMENT: /\/ATT\d+(\r?\n)?$/,
  PROCUREMENT_PROJECT_LOT: /\/PPL\d+(\r?\n)?$/,
  PROCUREMENT_PROJECT: /\/PP\d+(\r?\n)?$/,
}

const GROUP_TYPES = new Set([
  'QUESTION_GROUP', 'QUESTION_SUBGROUP',
  'REQUIREMENT_GROUP', 'REQUIREMENT_SUBGROUP',
  'GROUP', 'SUBGROUP', 'SUBCRITERION',
  // INFORMATION container types (have nested components)
  'CONTRACTING_PARTY', 'PARTY', 'POSTAL_ADDRESS',
  'ADDITIONAL_DOCUMENT_REFERENCE',
])
const ROOT_TYPE_ORDER = [
  'CRITERION',
  'SUBCRITERION',
  'LEGISLATION',
  'REQUIREMENT_GROUP',
  'QUESTION_GROUP',
]
const GROUP_TYPES_FOR_ORDERING = [  'REQUIREMENT_GROUP',
  'QUESTION_GROUP',  'REQUIREMENT_SUBGROUP',
  'QUESTION_SUBGROUP','GROUP', 'SUBGROUP']


const CARDINALITY_MAP = {
  '0..1': '0..1',   // Optional single
  '1': '1',         // Mandatory single
  '1..*': '1..n',   // Mandatory multiple
  '0..*': '0..n',   // Optional multiple
}

const log = console.log
// ============================================
// Utility Functions
// ============================================

const normalizeCode = (code) => {
  const match = code.match(/^([A-Za-z]{1,2})(\d{1,2})$/)
  if (!match) return undefined
  const [, letter, digits] = match
  return letter.toUpperCase() + digits.padStart(2, '0')
}

const normalizeCardinality = (card) =>
  CARDINALITY_MAP[String(card || '').trim()] ?? undefined

const getUUID = (obj) => {
  const raw = obj['cbc::ID'] || obj.ea_guid
  return typeof raw === 'string' ? raw.replace(/[{}]/g, '') : undefined
}

const cleanName = (name) =>
  name.split('/').pop().replace(/\r?\n/g, '')

const extractLabel = (nodeName) => {
  const match = nodeName.match(/\/([A-Z]+\d+)(\r?\n)?$/)
  return match ? match[1] : null
}

const getNodeType = (node) => {
  const nodeName = node.Name

  // Check patterns in order of specificity
  for (const [type, pattern] of Object.entries(NODE_TYPES)) {
    if (pattern instanceof RegExp ? pattern.test(nodeName) : nodeName.includes(
      pattern)) {
      return type
    }
  }

  return 'CRITERION'
}

function getLabelPrefix(label) {
  if (!label) return ''
  if (label.startsWith('QSG')) return 'QSG'
  if (label.startsWith('RSG')) return 'RSG'
  if (label.startsWith('Q')) return 'Q'
  if (label.startsWith('R')) return 'R'
  if (label.startsWith('CA')) return 'CA'
  return ''
}

function getLabelNumber(label) {
  if (!label) return Number.MAX_SAFE_INTEGER
  const match = label.match(/\d+$/)
  return match ? parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER
}

// ============================================
// Database Operations
// ============================================

const getPackageElements = (db, code) => {
  const targetPackage = db.packages.find(pkg => {
    const [currentCode] = pkg.Name.split(' ')
    return normalizeCode(currentCode) === code
  })

  return targetPackage
    ? db.objects.filter(obj => obj.Package_ID === targetPackage.Package_ID)
    : []
}

const enrichWithAttributes = (db, node) => {
  const attributes = db.attributes.filter(
    attr => attr.Object_ID === node.Object_ID).reduce((acc, attr) => {
    acc[attr.Name] = attr.Default || undefined
    return acc
  }, {})

  return { ...node, ...attributes }
}

const findRootNode = (db, elements) => {
  const incomingConnections = new Set(
    db.connectors.map(conn => conn.End_Object_ID),
  )

 const structuralElements = elements.filter(
    e => e.Object_Type === "Object"
  )
  var rootNode = structuralElements.find(elem => !incomingConnections.has(elem.Object_ID))
  return rootNode
}

const getChildrenOf = (db, objectId, objectsById) => {
  return db.connectors.filter(conn => conn.Start_Object_ID === objectId).
    map(conn => {
      const child = objectsById.get(conn.End_Object_ID)
      if (!child) return null

      return {
        ...child,
        _cardinality: normalizeCardinality(conn.DestCard),
      }
    }).
    filter(Boolean)
}
function orderChildren({
  children,
  parentPath,
  parentType,
  orderMap,
  isRoot = false
}) {
  // // Explicit structure order (from EA)
  // const explicit = orderMap?.[parentPath]
  // if (explicit) {
  //   return explicit
  //     .map(label => children.find(c => extractLabel(c.Name) === label))
  //     .filter(Boolean)
  // }

  // Root ordering by TYPE
  if (isRoot) {
    return [...children].sort((a, b) => {
    const ta = getNodeType(a)
    const tb = getNodeType(b)

    const ra = ROOT_TYPE_ORDER.indexOf(ta)
    const rb = ROOT_TYPE_ORDER.indexOf(tb)

    // Dfferent types → type order wins
    if (ra !== rb) return ra - rb

    // Same type → order by number (QG1 < QG2, RG1 < RG2, etc.)
    const la = extractLabel(a.Name)
    const lb = extractLabel(b.Name)

    const na = getLabelNumber(la)
    const nb = getLabelNumber(lb)

    return na - nb
  })
}
  // Group ordering by LABEL prefix
  if (GROUP_TYPES_FOR_ORDERING.includes(parentType)) {
    let order = null

    if (
      parentType === 'QUESTION_GROUP' ||
      parentType === 'QUESTION_SUBGROUP'
    ) {
      order = ['CA','Q','RQ', 'QSG','RSG']
    }

    if (
      parentType === 'REQUIREMENT_GROUP' ||
      parentType === 'REQUIREMENT_SUBGROUP'
    ) {
      order = ['CA','RQ', 'Q', 'RSG','QSG']
    }

    if (order) {
      return [...children].sort((a, b) => {
        const la = extractLabel(a.Name) || ''
        const lb = extractLabel(b.Name) || ''

        const pa = getLabelPrefix(la)
        const pb = getLabelPrefix(lb)

        const ra = order.indexOf(pa)
        const rb = order.indexOf(pb)
        if (ra !== rb) return ra - rb

        
      const na = getLabelNumber(la)
      const nb = getLabelNumber(lb)
      return na - nb
      })
    }
  }

  // Fallback
  return children
}

// ============================================
// Component Builders
// ============================================

const buildLegislationFields = (node) => {
  const fields = {
    title: node['cbc::Name'] || cleanName(node.Name),
    description: node['cbc::Description'] || '',
  }

  // Add optional fields if present
  const optionalFields = [
    ['cbc::JurisdictionLevelCode', 'jurisdictionlevelcode'],
    ['cbc::Article', 'article'],
    ['cbc::URI', 'uri'],
  ]

  optionalFields.forEach(([source, target]) => {
    if (node[source]) fields[target] = node[source]
  })

  return fields
}

const buildStandardFields = (node, type) => {
  const fields = {
    description: node['cbc::Description'] || node['cbc::Name'] ||
      cleanName(node.Name),
  }

  // Add datatype for questions and requirements
  if (type === 'QUESTION' || type === 'REQUIREMENT') {
    fields.propertydatatype = node['cbc::ValueDataTypeCode'] || 'INDICATOR'
  }

  // Add optional metadata
  if (node['cbc::TypeCode']) fields.code = node['cbc::TypeCode']
  if (node['cbc::CodeListID']) fields.codelist = node['cbc::CodeListID']

  return fields
}

const buildSimpleComponent = (node, parentPath) => {
  const type = getNodeType(node)
  const label = extractLabel(node.Name)
  const currentPath = parentPath ? `${parentPath}/${label}` : label

  const component = {
    type,
    ...(node._cardinality !== undefined && { cardinality: node._cardinality }),
    requestpath: currentPath,
    ...(type === 'LEGISLATION'
      ? buildLegislationFields(node)
      : buildStandardFields(node, type)),
  }

  // Set response paths based on type
  if (type === 'QUESTION' || type === 'REQUIREMENT') {
    component.responsepath = `${currentPath}/R1`
    component.contentpath = `${currentPath}/R1/RV`
  } else {
    component.responsepath = currentPath
  }

  return { label, component }
}

const generateUniqueLabel = (counters, baseLabel, parentPath, type) => {
  const counterKey = `${parentPath}_${type}`
  counters[counterKey] = (counters[counterKey] || 0) + 1
  const count = counters[counterKey]
  return `${baseLabel}${count > 1 ? count : ''}`
}

const buildGroup = (db, objectsById, counters, orderMap) => (node, parentPath) => {
  const type = getNodeType(node)
  const rawLabel = extractLabel(node.Name)

  // Generate unique label
  const label = rawLabel ?? generateUniqueLabel(
    counters,
    rawLabel || type.substring(0, 2),
    parentPath,
    type,
  )

  const currentPath = parentPath ? `${parentPath}/${label}` : label

  const resolvedCardinality = node._cardinality ?? node['cardinality'] ?? undefined

  const group = {
    type,
    ...(resolvedCardinality !== undefined && { cardinality: resolvedCardinality }),
    components: {},
    requestpath: currentPath,
    responsepath: currentPath,
  }

  // Add PropertyGroupTypeCode if present
  if (node['cbc::PropertyGroupTypeCode']) {
    group.code = node['cbc::PropertyGroupTypeCode']
  }

  // Process children recursively
  const rawChildren = getChildrenOf(db, node.Object_ID, objectsById)

  const children = orderChildren({
    children: rawChildren,
    parentPath: currentPath,
    parentType: type,
    orderMap
  })
  children.forEach(child => {
    const { label: childLabel, component: childComponent } =
      buildComponent(db, objectsById, counters, orderMap)(child, currentPath)
    group.components[childLabel] = childComponent
  })

  return { label, component: group }
}

const buildComponent = (db, objectsById, counters, orderMap) => (
  node, parentPath = '') => {
  const type = getNodeType(node)

  if (GROUP_TYPES.has(type)) {
    return buildGroup(db, objectsById, counters, orderMap)(node, parentPath)
  }

  return buildSimpleComponent(node, parentPath)
}

// ============================================
// Tree Builder
// ============================================

function extractSuffix (code) {
  const parts = code.split('_')
  return parts[1] || null // returns null if no underscore found
}

const createRootCriterion = (rootNode, code) => {
  // Determine criterion type and tag
  let type = 'CRITERION'
  let tag = code

  if (code.startsWith('I')) {
    type = 'INFORMATION'
  }

  // Extract typeCode from TypeCode field or Name suffix
  const typeCode = rootNode['cbc::TypeCode'] ||
    (rootNode.Name ? extractSuffix(rootNode.Name) : undefined)

  // Get labels from codelist database
  const { label, description } = typeCode ? getLabels(typeCode) : { label: '', description: '' }

  return {
    tag,
    type,
    uuid: getUUID(rootNode),
    code: typeCode,
    cardinality: '1',
    components: {},
    name: label || rootNode['cbc::Name'] || rootNode.Name,
    description: description || rootNode['cbc::Description'] || '',
    requestpath: `${tag}_${typeCode}`,
    responsepath: `${tag}_${typeCode}`,
  }
}

const buildEDMTree = (db, rootNode, packageElements, code, orderMap) => {
  // This is until UBL version 2.5 is finalized
  const criterion = createRootCriterion(rootNode, code)
  // Remove the above
  const counters = {}

  // Create lookup map for efficiency
  const objectsById = new Map(
    packageElements.map(elem => [elem.Object_ID, elem]),
  )

  // Process all children
  const rawChildren = getChildrenOf(db, rootNode.Object_ID, objectsById)

  const children = orderChildren({
    children: rawChildren,
    parentPath: criterion.requestpath,
    parentType: 'CRITERION',
    orderMap,
    isRoot: true
  })
  children.forEach(child => {
    const { label, component } = buildComponent(
      db,
      objectsById,
      counters,
    )(child, criterion.requestpath)
    criterion.components[label] = component
  })

  return criterion
}

function toArrayComponents(node) {
  if (!node || typeof node !== 'object') return node

  // If node has components as an object map, convert to array
  if (node.components && !Array.isArray(node.components) && typeof node.components === 'object') {
    const entries = Object.entries(node.components)

    node.components = entries.map(([tag, child]) => {
      const childNode = { tag,...child }
      return toArrayComponents(childNode)
    })
  } else if (Array.isArray(node.components)) {
    node.components = node.components.map(c => toArrayComponents(c))
  }

  return node
}
// ============================================
// Main Export Function
// ============================================

const exportPackage = (db, packageCode, orderMap = null) => {
  const code = normalizeCode(packageCode)
  if (!code) {
    throw new Error(`Invalid package code format: ${packageCode}`)
  }
  if(code === "C37"){
    log(chalk.yellow(`\n[DEBUG C37] packageCode: ${packageCode}, normalized: ${code}`))
  }

  const packageElements = getPackageElements(db, code)

  if (packageElements.length === 0) {
    log(chalk.red(`Warning: No package found with code: ${packageCode} — skipping`))
    return null
  }

  // Enrich elements with attributes
  const enrichedElements = packageElements.map(elem =>
    enrichWithAttributes(db, elem),
  )

  // Find and validate root node
  const rootNode = findRootNode(db, enrichedElements)
  if (!rootNode) {
    throw new Error('No root node found in package')
  }

  if(code === "C37"){
    log(chalk.yellow(`[DEBUG C37] rootNode.Name: ${rootNode.Name}`))
    log(chalk.yellow(`[DEBUG C37] rootNode['cbc::TypeCode']: ${rootNode['cbc::TypeCode']}`))
    log(chalk.yellow(`[DEBUG C37] extractSuffix result: ${extractSuffix(rootNode.Name)}`))
  }
  var criterion
  // TODO: Revert this for version 5.0.0 before final release
  // Remove this if-else statement
  
  criterion = buildEDMTree(db, rootNode, enrichedElements, code, orderMap)
  // Remove the above
  return toArrayComponents(criterion)
}

export { exportPackage }
