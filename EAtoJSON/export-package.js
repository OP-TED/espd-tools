// ============================================
// ESPD-EDM Parser
// ============================================
//
// Public surface: exportPackage / getUnrecognizedTypeWarnings /
// resetUnrecognizedTypeWarnings, plus normalizeCode / normalizeObjectName for
// export-criteria.js.
//
// Output is unchanged from the previous implementation except for one
// deliberate fix, documented under CHILD_ORDER below, which reorders the
// children of RG1/RSG1 in C37, C38 and C39.
//
// Removed relative to the previous implementation, all verified against the
// EA model:
//   - the `orderMap` parameter chain (its only reader was commented out, and
//     buildEDMTree already dropped it at the root call)
//   - the [DEBUG C37] trace blocks
//   - `var criterion` and the stale "remove this if-else" / UBL 2.5 markers
//   - the `node['cardinality']` fallback (no such EA attribute exists)
//   - 'GROUP' / 'SUBGROUP' type entries (getNodeType can never return them)
//   - a dead `rawLabel ||` and a redundant `.slice()`

import { getLabels } from './fetch-labels.js'
import chalk from 'chalk'

const log = console.log

// ============================================
// Node classification
// ============================================

// Every node below a criterion root is named with a trailing "/<PREFIX><n>"
// label (Q1, QSG3, PPLR2, ...). Classification is therefore an exact lookup on
// that one token — which removes the precedence problem the previous pattern
// table had: it tested unanchored substrings ('/SBC', '/CA', '/QG') against the
// WHOLE path, so an ancestor's label could win over the node's own. A question
// group nested under a subcriterion ("…/SBC1/QG1") classified as SUBCRITERION,
// because '/SBC' was checked first. Harmless today only because every /SBC
// node in the model happens to be childless.
const TYPE_BY_LABEL_PREFIX = {
  // Criterion structures
  L: 'LEGISLATION',
  CA: 'CAPTION',
  ADL: 'ADDITIONAL_DESCRIPTION_LINE',
  SBC: 'SUBCRITERION',
  Q: 'QUESTION',
  RQ: 'REQUIREMENT',
  QSG: 'QUESTION_SUBGROUP',
  QG: 'QUESTION_GROUP',
  RSG: 'REQUIREMENT_SUBGROUP',
  RG: 'REQUIREMENT_GROUP',
  // INFORMATION structures: contracting body / party chain (I68, I69)
  CP: 'CONTRACTING_PARTY',
  PAR: 'PARTY',
  PI: 'PARTY_IDENTIFICATION',
  PN: 'PARTY_NAME',
  PA: 'POSTAL_ADDRESS',
  CTC: 'CONTACT',
  CTR: 'COUNTRY',
  // INFORMATION: document reference (I68) and procurement project (I70)
  ADR: 'ADDITIONAL_DOCUMENT_REFERENCE',
  ATT: 'ATTACHMENT',
  PPL: 'PROCUREMENT_PROJECT_LOT',
  PP: 'PROCUREMENT_PROJECT',
  PPLR: 'LOT_REFERENCE',
  // INFORMATION: economic operator party (I71) and power of attorney (I72)
  EOP: 'ECONOMIC_OPERATOR_PARTY',
  QP: 'QUALIFYING_PARTY',
  POA: 'POWER_OF_ATTORNEY',
  // INFORMATION: signature (I73) chain — SIG -> SP -> PL
  SIG: 'SIGNATURE',
  SP: 'SIGNATORY_PARTY',
  PL: 'PHYSICAL_LOCATION',
}

// Types that own nested components and must be recursed into. Leaves are
// everything else — including PHYSICAL_LOCATION and LOT_REFERENCE, which are
// deliberately absent.
const GROUP_TYPES = new Set([
  'QUESTION_GROUP', 'QUESTION_SUBGROUP',
  'REQUIREMENT_GROUP', 'REQUIREMENT_SUBGROUP',
  'SUBCRITERION',
  'CONTRACTING_PARTY', 'PARTY', 'POSTAL_ADDRESS',
  'ADDITIONAL_DOCUMENT_REFERENCE',
  'ECONOMIC_OPERATOR_PARTY', 'QUALIFYING_PARTY', 'POWER_OF_ATTORNEY',
  'SIGNATURE', 'SIGNATORY_PARTY',
])

// ============================================
// Child ordering
// ============================================

// Order of a criterion root's direct children, by node type.
const ROOT_TYPE_ORDER = [
  'CRITERION',
  'SUBCRITERION',
  'LEGISLATION',
  'REQUIREMENT_GROUP',
  'QUESTION_GROUP',
]

// Order of a group's children, by label prefix, keyed on the parent's type.
// Within one prefix, children are ordered by their label number.
//
// FIX: the previous implementation declared these same sequences but derived
// the prefix with a hand-rolled startsWith ladder that returned 'R' for an
// "RQ1" label. 'R' is in neither sequence, so indexOf gave -1 and every
// requirement sorted ahead of everything — captions included. Visible in three
// criteria (C37, C38, C39), which emitted [RQ1, RQ2, CA1, QSG1…] instead of
// [CA1, RQ1, RQ2, QSG1…]. Deriving the prefix from the label token below keeps
// the two vocabularies in sync by construction.
const CHILD_ORDER = {
  QUESTION_GROUP: ['CA', 'Q', 'RQ', 'QSG', 'RSG'],
  QUESTION_SUBGROUP: ['CA', 'Q', 'RQ', 'QSG', 'RSG'],
  REQUIREMENT_GROUP: ['CA', 'RQ', 'Q', 'RSG', 'QSG'],
  REQUIREMENT_SUBGROUP: ['CA', 'RQ', 'Q', 'RSG', 'QSG'],
}

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

// EA names routinely carry trailing newlines. Declared-order maps are keyed by
// the criterion root object's name, so both sides must normalise identically.
const normalizeObjectName = (name) =>
  String(name ?? '').replace(/\r?\n/g, '').trim()

// The trailing "<PREFIX><n>" token of a node's name, e.g. "QSG1". Null for a
// criterion root, whose name is "C01_exg-crim-part" with no label segment.
const extractLabel = (nodeName) => {
  const match = nodeName.match(/\/([A-Z]+\d+)(\r?\n)?$/)
  return match ? match[1] : null
}

// "QSG1" -> "QSG". The single source of truth for prefixes, shared by
// classification (TYPE_BY_LABEL_PREFIX) and ordering (CHILD_ORDER).
const getLabelPrefix = (label) =>
  label ? label.replace(/\d+$/, '') : ''

const getLabelNumber = (label) => {
  if (!label) return Number.MAX_SAFE_INTEGER
  const match = label.match(/\d+$/)
  return match ? parseInt(match[0], 10) : Number.MAX_SAFE_INTEGER
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
  nodeAttributes
    .filter(attr => typeof attr.Name === 'string' && attr.Name.trim())
    .filter(attr => !NON_XML_ATTRIBUTES.has(attr.Name.trim()))
    .sort((a, b) => (a.Pos ?? 0) - (b.Pos ?? 0) || (a.ID ?? 0) - (b.ID ?? 0))
    .map(attr => {
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

// ============================================
// Node type resolution
// ============================================

// Accumulates every fallback so callers (export.js) can print a summary
// after a run, instead of these being silently swallowed.
let unrecognizedTypeWarnings = []

const getNodeType = (node) => {
  const label = extractLabel(node.Name)
  const type = TYPE_BY_LABEL_PREFIX[getLabelPrefix(label)]
  if (type) return type

  // The node's label carries a prefix with no mapping (e.g. a new EA suffix).
  // Defaulting silently to CRITERION would treat it as a leaf and drop its
  // children, so warn loudly instead of failing silently.
  unrecognizedTypeWarnings.push({ name: node.Name, label })
  log(chalk.yellow(
    `⚠ Unrecognized node type for "${node.Name}"${label ? ` (label: ${label})` : ''} — defaulting to CRITERION. Children of this node will NOT be exported. Add a TYPE_BY_LABEL_PREFIX entry for this label if it's expected.`
  ))

  return 'CRITERION'
}

const getUnrecognizedTypeWarnings = () => unrecognizedTypeWarnings

const resetUnrecognizedTypeWarnings = () => {
  unrecognizedTypeWarnings = []
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

// The root is the one structural object in the package that nothing points at.
// More than one candidate means a detached object in the diagram, which would
// otherwise be picked up silently as a criterion root.
const findRootNode = (db, elements) => {
  const incomingConnections = new Set(
    db.connectors.map(conn => conn.End_Object_ID),
  )

  const candidates = elements
    .filter(elem => elem.Object_Type === 'Object')
    .filter(elem => !incomingConnections.has(elem.Object_ID))

  if (candidates.length > 1) {
    log(chalk.yellow(
      `⚠ ${candidates.length} root candidates in package — using the first. Candidates: ${candidates.map(c => cleanName(c.Name)).join(', ')}`
    ))
  }

  return candidates[0]
}

const getChildrenOf = (db, objectId, objectsById) =>
  db.connectors
    .filter(conn => conn.Start_Object_ID === objectId)
    .map(conn => {
      const child = objectsById.get(conn.End_Object_ID)
      if (!child) return null

      return {
        ...child,
        _cardinality: normalizeCardinality(conn.DestCard),
      }
    })
    .filter(Boolean)

// EA's per-criterion `structure` tree declares the real child order of every
// node, so it is the authority. It is only usable when the labels it lists are
// exactly the children the model actually has: a blob that is stale (missing a
// child, naming one that no longer exists, or carrying a typo like "SCB1" for
// "SBC1") would otherwise silently drop or duplicate nodes. Returns null when
// the declared order cannot be trusted, so the caller can fall back.
const applyDeclaredOrder = (children, declared) => {
  if (!Array.isArray(declared) || declared.length === 0) return null

  const actual = children.map(child => extractLabel(child.Name))
  if (actual.some(label => !label)) return null

  // Labels must be unique on both sides, or "find by label" is ambiguous.
  if (new Set(actual).size !== actual.length) return null
  if (new Set(declared).size !== declared.length) return null

  if (actual.length !== declared.length) return null
  if ([...actual].sort().join(',') !== [...declared].sort().join(',')) return null

  return declared.map(label => children.find(c => extractLabel(c.Name) === label))
}

const orderChildren = ({ children, parentType, isRoot = false, declared, where }) => {
  // EA's declared order wins whenever it is consistent with the model.
  const byDeclaredOrder = applyDeclaredOrder(children, declared)
  if (byDeclaredOrder) return byDeclaredOrder

  if (declared) {
    log(chalk.yellow(
      `⚠ ${where}: the structure blob declares [${declared.join(',')}] but the model has [${
        children.map(c => extractLabel(c.Name) ?? '?').join(',')
      }] — ignoring the declared order here and falling back to label order.`
    ))
  }

  // A criterion root orders its children by node TYPE, then by label number
  // within a type (QG1 before QG2).
  if (isRoot) {
    return [...children].sort((a, b) => {
      const rankA = ROOT_TYPE_ORDER.indexOf(getNodeType(a))
      const rankB = ROOT_TYPE_ORDER.indexOf(getNodeType(b))

      // Different types → type order wins
      if (rankA !== rankB) return rankA - rankB

      // Same type → order by number
      return getLabelNumber(extractLabel(a.Name)) -
        getLabelNumber(extractLabel(b.Name))
    })
  }

  // A group orders its children by label PREFIX, then by label number.
  const order = CHILD_ORDER[parentType]
  if (!order) return children

  return [...children].sort((a, b) => {
    const labelA = extractLabel(a.Name)
    const labelB = extractLabel(b.Name)

    const rankA = order.indexOf(getLabelPrefix(labelA))
    const rankB = order.indexOf(getLabelPrefix(labelB))
    if (rankA !== rankB) return rankA - rankB

    return getLabelNumber(labelA) - getLabelNumber(labelB)
  })
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

  // Add optional metadata. For a leaf, cbc::TypeCode is the property type
  // ("QUESTION"), not a criterion code.
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

// Fallback label for a group whose EA name carries no "/<PREFIX><n>" segment.
// No node in the current model needs this.
const generateUniqueLabel = (counters, parentPath, type) => {
  const counterKey = `${parentPath}_${type}`
  counters[counterKey] = (counters[counterKey] || 0) + 1
  const count = counters[counterKey]
  return `${type.substring(0, 2)}${count > 1 ? count : ''}`
}

const buildGroup = (ctx, node, parentPath, parentRelativePath) => {
  const type = getNodeType(node)
  const label = extractLabel(node.Name) ??
    generateUniqueLabel(ctx.counters, parentPath, type)

  const currentPath = parentPath ? `${parentPath}/${label}` : label

  // Path relative to the criterion root ("QG1/QSG1"). The declared-order map is
  // keyed this way rather than by requestpath: the blob's root segment is the EA
  // object name, which diverges from the requestpath for the OT criteria
  // ("C57_OT_shelt-worksh" vs "OT57_shelt-worksh") and for C18.
  const currentRelativePath = parentRelativePath
    ? `${parentRelativePath}/${label}`
    : label

  const group = {
    type,
    ...(node._cardinality !== undefined && { cardinality: node._cardinality }),
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
  const children = orderChildren({
    children: getChildrenOf(ctx.db, node.Object_ID, ctx.objectsById),
    parentType: type,
    declared: ctx.declaredOrder?.get(currentRelativePath),
    where: `${ctx.criterionCode} @ ${currentRelativePath}`,
  })

  children.forEach(child => {
    const { label: childLabel, component: childComponent } =
      buildComponent(ctx, child, currentPath, currentRelativePath)
    group.components[childLabel] = childComponent
  })

  return { label, component: group }
}

const buildComponent = (ctx, node, parentPath = '', parentRelativePath = '') =>
  GROUP_TYPES.has(getNodeType(node))
    ? buildGroup(ctx, node, parentPath, parentRelativePath)
    : buildSimpleComponent(node, parentPath)

// ============================================
// Tree Builder
// ============================================

// Legacy part markers that some EA root object names still carry between the
// package number and the criterion code ("C57_OT_shelt-worksh"). They are a
// leftover of the v3/v4 naming scheme and are not part of the code itself.
const LEGACY_PART_MARKERS = /^(?:EG|SC|OT)_/

// Last-resort derivation of the criterion/information code from the EA root
// object's name. Everything after the FIRST underscore is the code — splitting
// on '_' and taking [1] truncates hyphen-free-but-underscored names and, for
// the OT packages, returns the part marker ("OT") instead of the code.
const extractSuffix = (name) => {
  const underscore = name.indexOf('_')
  if (underscore === -1) return null

  const suffix = name.slice(underscore + 1).replace(/\r?\n/g, '').trim()
  if (!suffix) return null

  return suffix.replace(LEGACY_PART_MARKERS, '') || null
}

const createRootCriterion = (rootNode, code) => {
  const tag = code
  const type = code.startsWith('I') ? 'INFORMATION' : 'CRITERION'

  // The criterion code lives in cbc::CriterionTypeCode on the root object —
  // that is the authoritative value and the one that must end up in
  // cbc:CriterionTypeCode in the XML. cbc::TypeCode is kept as a secondary
  // source, and the root object's name suffix only as a last resort: the
  // INFORMATION packages (I68-I73) carry no CriterionTypeCode, and the OT
  // packages are still named with the legacy "C57_OT_<code>" scheme, where the
  // name alone cannot be trusted to yield the code.
  const typeCode = rootNode['cbc::CriterionTypeCode'] ||
    rootNode['cbc::TypeCode'] ||
    (rootNode.Name ? extractSuffix(rootNode.Name) : undefined)

  // typeCode is the path prefix for every node in the subtree, so losing it
  // would stamp "<tag>_undefined" into several hundred cbc:ID values.
  if (!typeCode) {
    log(chalk.red(
      `✗ ${tag}: no criterion code found (cbc::CriterionTypeCode, cbc::TypeCode and the name suffix "${cleanName(rootNode.Name)}" all failed) — paths will contain "undefined".`
    ))
  }

  // Get labels from codelist database
  const { label, description } = typeCode
    ? getLabels(typeCode)
    : { label: '', description: '' }

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

const buildEDMTree = (db, rootNode, packageElements, code, declaredOrder) => {
  const criterion = createRootCriterion(rootNode, code)

  const ctx = {
    db,
    // Lookup map for efficiency
    objectsById: new Map(packageElements.map(elem => [elem.Object_ID, elem])),
    counters: {},
    declaredOrder,
    criterionCode: code,
  }

  const children = orderChildren({
    children: getChildrenOf(db, rootNode.Object_ID, ctx.objectsById),
    parentType: 'CRITERION',
    isRoot: true,
    // The root's own children are keyed under the empty relative path.
    declared: declaredOrder?.get(''),
    where: `${code} @ root`,
  })

  children.forEach(child => {
    const { label, component } = buildComponent(ctx, child, criterion.requestpath, '')
    criterion.components[label] = component
  })

  return criterion
}

// The builders keep `components` as a label-keyed object so siblings can be
// addressed while the tree is being assembled; the published shape is an array
// with the label folded in as `tag`.
const toArrayComponents = (node) => {
  if (!node || typeof node !== 'object') return node

  if (Array.isArray(node.components)) {
    node.components = node.components.map(toArrayComponents)
  } else if (node.components && typeof node.components === 'object') {
    node.components = Object.entries(node.components).map(
      ([tag, child]) => toArrayComponents({ tag, ...child })
    )
  }

  return node
}

// ============================================
// Main Export Function
// ============================================

// declaredOrders: Map<rootObjectName, Map<relativePath, string[]>> built from
// EA's per-criterion `structure` trees by export-criteria.js. Omit it and the
// label heuristics are used throughout.
const exportPackage = (db, packageCode, declaredOrders = null) => {
  const code = normalizeCode(packageCode)
  if (!code) {
    throw new Error(`Invalid package code format: ${packageCode}`)
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

  const rootNode = findRootNode(db, enrichedElements)
  if (!rootNode) {
    throw new Error(`No root node found in package ${code}`)
  }

  // Declared order is looked up by the root object's name, which is what EA
  // stores as the tree's root path.
  const declaredOrder = declaredOrders?.get(normalizeObjectName(rootNode.Name))

  if (declaredOrders && !declaredOrder) {
    log(chalk.yellow(
      `⚠ ${code}: no usable structure tree for "${normalizeObjectName(rootNode.Name)}" — child order falls back to label heuristics.`
    ))
  }

  return toArrayComponents(
    buildEDMTree(db, rootNode, enrichedElements, code, declaredOrder)
  )
}

export {
  exportPackage,
  getUnrecognizedTypeWarnings,
  resetUnrecognizedTypeWarnings,
  // Exported so export-criteria.js can reconcile the part/section index
  // against the packages in the model using the same matching rule, and key
  // the declared-order maps the same way this module looks them up.
  normalizeCode,
  normalizeObjectName,
}
