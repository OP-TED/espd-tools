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
  // INFORMATION: economic operator party (I71) and power of attorney (I72).
  // End-anchored to avoid QP/QG, POA/PA and EOP/EO collisions.
  ECONOMIC_OPERATOR_PARTY: /\/EOP\d+(\r?\n)?$/,
  QUALIFYING_PARTY: /\/QP\d+(\r?\n)?$/,
  POWER_OF_ATTORNEY: /\/POA\d+(\r?\n)?$/,
  // INFORMATION: signature (I73) chain — SIG -> SP -> PL.
  // End-anchored, and checked before PROCUREMENT_PROJECT_LOT below since
  // "PPLR" starts with "PPL" but is a distinct, unrelated leaf node.
  LOT_REFERENCE: /\/PPLR\d+(\r?\n)?$/,
  SIGNATURE: /\/SIG\d+(\r?\n)?$/,
  SIGNATORY_PARTY: /\/SP\d+(\r?\n)?$/,
  PHYSICAL_LOCATION: /\/PL\d+(\r?\n)?$/,
}

const GROUP_TYPES = new Set([
  'QUESTION_GROUP', 'QUESTION_SUBGROUP',
  'REQUIREMENT_GROUP', 'REQUIREMENT_SUBGROUP',
  'GROUP', 'SUBGROUP', 'SUBCRITERION',
  // INFORMATION container types (have nested components)
  'CONTRACTING_PARTY', 'PARTY', 'POSTAL_ADDRESS',
  'ADDITIONAL_DOCUMENT_REFERENCE',
  'ECONOMIC_OPERATOR_PARTY', 'QUALIFYING_PARTY', 'POWER_OF_ATTORNEY',
  // INFORMATION: signature (I73) container types.
  // PHYSICAL_LOCATION and LOT_REFERENCE are leaves and intentionally excluded.
  'SIGNATURE', 'SIGNATORY_PARTY',
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

// ============================================
// XML mapping configuration
// ============================================

// EA stores the diagram/ordering metadata of a criterion as a pseudo-attribute
// called "structure" (a JSON blob). It is model tooling, not an XML child
// element, so it is never emitted in xmlChildren.
const NON_XML_ATTRIBUTES = new Set(['structure'])

// Namespace prefixes we know how to classify. "cbc" elements carry a value of
// their own (scalar / leaf text nodes); "cac" elements are aggregates whose
// content is the node's own children, so a serializer must recurse into
// `components` instead of emitting text.
const XML_PREFIX_KINDS = {
  cbc: 'scalar',
  cac: 'relationship',
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

// ============================================
// XML mapping helpers (object classifier + node attributes)
// ============================================

// EA writes namespaced names with a double colon ("cbc::ID") and the PlantUML
// export renders them with a dot ("cbc.ID"). Downstream consumers serialize
// XML, so xmlChildren[].name is normalised to the XML QName form: "cbc:ID".
// Only the first separator is rewritten, so a local name containing a dot
// survives untouched.
const toXmlQName = (eaName) =>
  String(eaName).trim().replace(/\s*(?:::|:|\.)\s*/, ':')

// Tells a consumer whether a child element holds a value of its own or is a
// container to be filled from the node's `components`.
const classifyXmlChild = (qName) => {
  const prefix = qName.includes(':') ? qName.split(':')[0] : ''
  return XML_PREFIX_KINDS[prefix] ?? 'unknown'
}

// t_object.Classifier points at the Object_ID of the class an instance is
// classified by, and that class's Name is the XML element name
// ("cac::TenderingCriterionProperty"). Memoised per database because the
// lookup is needed for every node of every package.
const classifierIndexCache = new WeakMap()

const getClassifierIndex = (db) => {
  let index = classifierIndexCache.get(db)
  if (!index) {
    index = new Map(db.objects.map(obj => [obj.Object_ID, obj.Name]))
    classifierIndexCache.set(db, index)
  }
  return index
}

// Same resolution the PlantUML export uses for the <<stereotype>> shown on a
// class: the instance's own Stereotype when EA has one, otherwise the name of
// its classifier. No instance in the current ESPD model carries a Stereotype,
// so the classifier is what actually resolves; the first branch is kept so
// xmlElementName keeps matching the diagrams if that ever changes.
const resolveXmlElementName = (node, classifierIndex) => {
  if (typeof node.Stereotype === 'string' && node.Stereotype.trim()) {
    return node.Stereotype.trim()
  }

  const classifierId = Number(node.Classifier)
  if (!Number.isInteger(classifierId) || classifierId <= 0) return null

  const name = classifierIndex.get(classifierId)
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

const normalizeAttributeValue = (raw) => {
  if (raw === null || raw === undefined) return null
  const value = String(raw).trim()
  return value === '' ? null : value
}

// Flat, order-preserving list of the XML child elements of a node.
// t_attribute rows do not come back in model order, so they are sorted by Pos
// (EA's own attribute ordering) with the row ID as a deterministic tie-break.
const buildXmlChildren = (nodeAttributes) =>
  nodeAttributes.
    filter(attr => typeof attr.Name === 'string' && attr.Name.trim()).
    filter(attr => !NON_XML_ATTRIBUTES.has(attr.Name.trim())).
    slice().
    sort((a, b) => (a.Pos ?? 0) - (b.Pos ?? 0) || (a.ID ?? 0) - (b.ID ?? 0)).
    map(attr => {
      const name = toXmlQName(attr.Name)
      return {
        name,
        value: normalizeAttributeValue(attr.Default),
        kind: classifyXmlChild(name),
      }
    })

// Appends the XML mapping to a built component. Both keys are always present:
// a node with no attributes gets an empty xmlChildren array rather than having
// the key omitted.
const withXmlMapping = (component, node) => {
  component.xmlElementName = node._xmlElementName ?? null
  component.xmlChildren = node._xmlChildren ?? []
  return component
}

// Accumulates every fallback so callers (export.js) can print a summary
// after a run, instead of these being silently swallowed.
let unrecognizedTypeWarnings = []

const getNodeType = (node) => {
  const nodeName = node.Name

  // Check patterns in order of specificity
  for (const [type, pattern] of Object.entries(NODE_TYPES)) {
    if (pattern instanceof RegExp ? pattern.test(nodeName) : nodeName.includes(
      pattern)) {
      return type
    }
  }

  // No known pattern matched this node's label (e.g. an EA suffix like
  // /SIG, /SP, /PL that hasn't been added to NODE_TYPES yet). Defaulting
  // silently to CRITERION would misclassify it as a leaf and drop any of
  // its children — so warn loudly instead of failing silently.
  const label = extractLabel(nodeName)
  unrecognizedTypeWarnings.push({ name: nodeName, label })
  log(chalk.yellow(
    `⚠ Unrecognized node type for "${nodeName}"${label ? ` (label: ${label})` : ''} — defaulting to CRITERION. Children of this node will NOT be exported. Add a NODE_TYPES pattern for this label if it's expected.`
  ))

  return 'CRITERION'
}

const getUnrecognizedTypeWarnings = () => unrecognizedTypeWarnings

const resetUnrecognizedTypeWarnings = () => {
  unrecognizedTypeWarnings = []
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

const enrichWithAttributes = (db, node, classifierIndex) => {
  const nodeAttributes = db.attributes.filter(
    attr => attr.Object_ID === node.Object_ID)

  const attributes = nodeAttributes.reduce((acc, attr) => {
    acc[attr.Name] = attr.Default || undefined
    return acc
  }, {})

  // The flat map above is lossy by design (it drops order, and collapses
  // "present with no value" into undefined) and is what the existing field
  // builders read. _xmlChildren keeps the ordered, value-preserving view an XML
  // serializer needs; _xmlElementName keeps the object classifier.
  return {
    ...node,
    ...attributes,
    _xmlElementName: resolveXmlElementName(node, classifierIndex),
    _xmlChildren: buildXmlChildren(nodeAttributes),
  }
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

  withXmlMapping(component, node)

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

  withXmlMapping(group, node)

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

  return withXmlMapping({
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
  }, rootNode)
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

  // Enrich elements with attributes and with their XML mapping
  // (object classifier + ordered list of child elements)
  const classifierIndex = getClassifierIndex(db)
  const enrichedElements = packageElements.map(elem =>
    enrichWithAttributes(db, elem, classifierIndex),
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

export { exportPackage, getUnrecognizedTypeWarnings, resetUnrecognizedTypeWarnings }
