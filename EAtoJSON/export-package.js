// ============================================
// ESPD-EDM Parser - Improved Version
// ============================================

import { getLabels } from './fetch-labels.js'

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
}

const GROUP_TYPES = new Set([
  'QUESTION_GROUP', 'QUESTION_SUBGROUP',
  'REQUIREMENT_GROUP', 'REQUIREMENT_SUBGROUP',
  'GROUP', 'SUBGROUP', 'SUBCRITERION',
])

const CARDINALITY_MAP = {
  '0..1': '1',      // Optional single -> mandatory
  '1': '1',         // Mandatory single
  '1..*': '1..n',   // Mandatory multiple
  '0..*': '0..n',   // Optional multiple
}

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
  CARDINALITY_MAP[String(card || '').trim()] || '1'

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

  return elements.find(elem => !incomingConnections.has(elem.Object_ID))
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
    cardinality: node._cardinality || '1',
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

const buildGroup = (db, objectsById, counters) => (node, parentPath) => {
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

  const group = {
    type,
    cardinality: node['cardinality'] || '1',
    components: {},
    requestpath: currentPath,
    responsepath: currentPath,
  }

  // Add PropertyGroupTypeCode if present
  if (node['cbc::PropertyGroupTypeCode']) {
    group.code = node['cbc::PropertyGroupTypeCode']
  }

  // Process children recursively
  const children = getChildrenOf(db, node.Object_ID, objectsById)
  children.forEach(child => {
    const { label: childLabel, component: childComponent } =
      buildComponent(db, objectsById, counters)(child, currentPath)
    group.components[childLabel] = childComponent
  })

  return { label, component: group }
}

const buildComponent = (db, objectsById, counters) => (
  node, parentPath = '') => {
  const type = getNodeType(node)

  if (GROUP_TYPES.has(type)) {
    return buildGroup(db, objectsById, counters)(node, parentPath)
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

  if (code.startsWith('AI')) {
    type = 'ADDITIONAL_INFORMATION'
    tag = `${code}`
  } else if (code.startsWith('C')) {
    tag = `${code}`
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

const buildEDMTree = (db, rootNode, packageElements, code) => {
  // Create lookup map for efficiency
  const objectsById = new Map(
    packageElements.map(elem => [elem.Object_ID, elem]),
  )

  const criterion = createRootCriterion(rootNode, code)
  const counters = {}

  // Process all children
  const children = getChildrenOf(db, rootNode.Object_ID, objectsById)
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

function reorderByOrderMap(node, orderMap, currentPath = '') {
  if (!node?.components || !orderMap) return

  const order = orderMap[currentPath]
  if (!order) return

  const reordered = {}

  order.forEach(key => {
    if (node.components[key]) {
      reordered[key] = node.components[key]
    }
  })

  Object.keys(node.components).forEach(key => {
    if (!reordered[key]) {
      reordered[key] = node.components[key]
    }
  })

  node.components = reordered

  // recurse
  Object.entries(node.components).forEach(([key, child]) => {
    const nextPath = currentPath ? `${currentPath}/${key}` : key
    reorderByOrderMap(child, orderMap, nextPath)
  })
}

// ============================================
// Main Export Function
// ============================================

const exportPackage = (db, packageCode, orderMap = null) => {
  const code = normalizeCode(packageCode)
  if (!code) {
    throw new Error(`Invalid package code format: ${packageCode}`)
  }

  const packageElements = getPackageElements(db, code)

  if (packageElements.length === 0) {
    throw new Error(`No package found with code: ${packageCode}`)
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

  const criterion = buildEDMTree(db, rootNode, enrichedElements, code)

  if (orderMap) {
    reorderByOrderMap(criterion, orderMap)
  }
  return criterion
}

export { exportPackage }
