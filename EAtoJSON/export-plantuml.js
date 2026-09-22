/**
 * Export EA model packages to PlantUML (.puml) files.
 *
 * Reads the .eapx database via mdb-reader and generates one .puml file
 * per package, containing classes, interfaces, enumerations, and their
 * relationships.
 *
 * Usage (standalone):
 *   node export-plantuml.js <eapx-file> [--output <dir>]
 *
 * Or via the main export.js CLI:
 *   node export.js plantuml [eafile] [-o dir]
 */

import chalk from 'chalk'

const log = console.log

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VISIBILITY_MAP = {
  Public: '+',
  Private: '-',
  Protected: '#',
  Package: '~',
}

const CONNECTOR_ARROW = {
  Association: ' --> ',
  Aggregation: ' o-- ',
  Composition: ' *-- ',
  Generalization: ' --|> ',
  Realisation: ' ..|> ',
  Dependency: ' ..> ',
  Usage: ' ..> ',
  NoteLink: ' .. ',
  Nesting: ' +-- ',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeAlias (elementId) {
  return `E${elementId}`
}

function escapeQuotes (str) {
  return (str || '').replace(/"/g, '\\"')
}

/**
 * Sanitize a string for use inside PlantUML class bodies.
 * Replaces characters that break PlantUML parsing:
 *   :: → .  (namespace separator conflicts)
 *   /  → .  (path separators confuse the parser)
 *   newlines → stripped
 */
function sanitize (str) {
  return (str || '')
    .replace(/::/g, '.')
    .replace(/\//g, '.')
    .replace(/\r?\n/g, ' ')
    .trim()
}

function buildPackageTree (packages) {
  const byId = new Map()
  packages.forEach(pkg => byId.set(pkg.Package_ID, pkg))

  const roots = []
  packages.forEach(pkg => {
    if (pkg.Parent_ID === 0 || !byId.has(pkg.Parent_ID)) {
      roots.push(pkg)
    }
  })
  return { byId, roots }
}

// ---------------------------------------------------------------------------
// PlantUML generation
// ---------------------------------------------------------------------------

function elementToPlantUML (element, attributes, methods) {
  const stereotype = element.Stereotype ? ` <<${element.Stereotype}>>` : ''
  let keyword = 'class'

  const etype = (element.Object_Type || '').toLowerCase()
  if (etype === 'enumeration' || element.Stereotype === 'enumeration') {
    keyword = 'enum'
  } else if (etype === 'interface') {
    keyword = 'interface'
  } else if (etype === 'package' || etype === 'boundary' || etype === 'note') {
    return null // skip non-class elements
  }

  const lines = []
  const name = escapeQuotes(element.Name || `Element_${element.Object_ID}`)
  lines.push(`${keyword} "${name}" as ${safeAlias(element.Object_ID)}${stereotype} {`)

  // Attributes
  const elAttrs = attributes.filter(a => a.Object_ID === element.Object_ID)
  for (const attr of elAttrs) {
    const vis = VISIBILITY_MAP[attr.Scope || 'Public'] || '+'
    const type = attr.Type ? ` : ${sanitize(attr.Type)}` : ''
    const defaultVal = attr.Default ? ` = ${sanitize(attr.Default)}` : ''
    const name = sanitize(attr.Name)
    lines.push(`    ${vis}${name}${type}${defaultVal}`)
  }

  // Methods / operations
  const elMethods = methods.filter(m => m.Object_ID === element.Object_ID)
  for (const method of elMethods) {
    const vis = VISIBILITY_MAP[method.Scope || 'Public'] || '+'
    const ret = method.Type ? ` : ${sanitize(method.Type)}` : ''
    const name = sanitize(method.Name)
    lines.push(`    ${vis}${name}()${ret}`)
  }

  lines.push('}')
  return lines.join('\n')
}

function connectorToPlantUML (connector, elementIds) {
  const srcId = connector.Start_Object_ID
  const tgtId = connector.End_Object_ID

  // Only include connectors where both ends are in our element set
  if (!elementIds.has(srcId) || !elementIds.has(tgtId)) {
    return null
  }

  const arrow = CONNECTOR_ARROW[connector.Type] || ' --> '
  const label = connector.Name ? ` : "${escapeQuotes(connector.Name)}"` : ''

  const srcCard = connector.SourceCard ? `"${connector.SourceCard}" ` : ''
  const tgtCard = connector.DestCard ? ` "${connector.DestCard}"` : ''

  return `${srcCard}${safeAlias(srcId)}${arrow}${safeAlias(tgtId)}${tgtCard}${label}`
}

function packageToPlantUML (pkg, db) {
  const elements = db.objects.filter(
    obj => obj.Package_ID === pkg.Package_ID &&
      obj.Object_Type !== 'Note' &&
      obj.Object_Type !== 'Boundary' &&
      obj.Object_Type !== 'Text'
  )

  if (elements.length === 0) return null

  const elementIds = new Set(elements.map(e => e.Object_ID))

  const lines = []
  lines.push('@startuml')
  lines.push(`' Package: ${pkg.Name}`)
  lines.push(`' Package_ID: ${pkg.Package_ID}`)
  lines.push('')

  // Elements
  for (const el of elements) {
    const puml = elementToPlantUML(el, db.attributes, db.operations)
    if (puml) {
      lines.push(puml)
      lines.push('')
    }
  }

  // Connectors — only include where BOTH ends are in this package
  const connectors = db.connectors.filter(
    c => elementIds.has(c.Start_Object_ID) && elementIds.has(c.End_Object_ID)
  )

  const seen = new Set()
  for (const conn of connectors) {
    if (seen.has(conn.Connector_ID)) continue
    seen.add(conn.Connector_ID)

    const puml = connectorToPlantUML(conn, elementIds)
    if (puml) lines.push(puml)
  }

  lines.push('')
  lines.push('@enduml')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Diagram generation
// ---------------------------------------------------------------------------

/**
 * Render a single EA diagram (t_diagram row) to PlantUML.
 *
 * Unlike packageToPlantUML (which dumps every element in a package), this
 * renders exactly the elements placed on the diagram via t_diagramobjects,
 * and the connectors drawn on it via t_diagramlinks (falling back to any
 * connector whose both ends are on the diagram, since t_diagramlinks may be
 * empty for auto-routed links).
 *
 * @returns {string|null} PlantUML content, or null if the diagram has no
 *   renderable elements.
 */
function diagramToPlantUML (diagram, db) {
  // Element IDs placed on this diagram
  const objectIds = new Set(
    db.diagramObjects
      .filter(d => d.Diagram_ID === diagram.Diagram_ID)
      .map(d => d.Object_ID)
  )

  if (objectIds.size === 0) return null

  const objectsById = new Map(db.objects.map(o => [o.Object_ID, o]))
  const elements = [...objectIds]
    .map(id => objectsById.get(id))
    .filter(el =>
      el &&
      el.Object_Type !== 'Note' &&
      el.Object_Type !== 'Boundary' &&
      el.Object_Type !== 'Text'
    )

  if (elements.length === 0) return null

  const elementIds = new Set(elements.map(e => e.Object_ID))

  const umlName = (diagram.Name || `Diagram_${diagram.Diagram_ID}`)
    .replace(/\r?\n/g, ' ')

  const lines = []
  lines.push(`@startuml "${escapeQuotes(umlName)}"`)
  lines.push(`' Diagram: ${diagram.Name}`)
  lines.push(`' Diagram_ID: ${diagram.Diagram_ID}`)
  if (diagram.Diagram_Type) lines.push(`' Type: ${diagram.Diagram_Type}`)
  lines.push('')

  // Elements
  for (const el of elements) {
    const puml = elementToPlantUML(el, db.attributes, db.operations)
    if (puml) {
      lines.push(puml)
      lines.push('')
    }
  }

  // Connectors drawn on this diagram. Prefer the explicit t_diagramlinks set;
  // fall back to connectors whose both ends are on the diagram.
  const linkConnectorIds = new Set(
    db.diagramLinks
      .filter(l => l.DiagramID === diagram.Diagram_ID)
      .map(l => l.ConnectorID)
  )

  const connectors = db.connectors.filter(c => {
    const bothEndsOnDiagram =
      elementIds.has(c.Start_Object_ID) && elementIds.has(c.End_Object_ID)
    if (linkConnectorIds.size > 0) {
      return linkConnectorIds.has(c.Connector_ID) && bothEndsOnDiagram
    }
    return bothEndsOnDiagram
  })

  const seen = new Set()
  for (const conn of connectors) {
    if (seen.has(conn.Connector_ID)) continue
    seen.add(conn.Connector_ID)

    const puml = connectorToPlantUML(conn, elementIds)
    if (puml) lines.push(puml)
  }

  lines.push('')
  lines.push('@enduml')
  return lines.join('\n')
}

/**
 * Export every EA diagram to PlantUML, naming each file after its owning
 * package path plus the diagram name.
 *
 * @param {object} db - Database with diagram tables loaded
 * @param {Map<number,string>} packagePrefixById - Sanitized path prefix per package
 * @returns {Array<{kind, packageName, diagramName, fileName, content}>}
 */
function exportDiagrams (db, packagePrefixById) {
  if (!db.diagrams || db.diagrams.length === 0) {
    log(chalk.yellow('⚠ No t_diagram rows found — no diagrams to export'))
    return []
  }

  const results = []
  // Guard against two diagrams with the same name under the same package.
  const usedFileNames = new Set()

  for (const diagram of db.diagrams) {
    const content = diagramToPlantUML(diagram, db)
    if (!content) continue

    const diagramName = (diagram.Name || `Diagram_${diagram.Diagram_ID}`)
      .replace(/[/\\:*?"<>|]/g, '_')
    const pkgPrefix = packagePrefixById.get(diagram.Package_ID) || 'orphan'

    let fileName = `${pkgPrefix}__${diagramName}.puml`
    if (usedFileNames.has(fileName)) {
      fileName = `${pkgPrefix}__${diagramName}__${diagram.Diagram_ID}.puml`
    }
    usedFileNames.add(fileName)

    results.push({
      kind: 'diagram',
      packageName: diagram.Name,
      diagramName: diagram.Name,
      diagramId: diagram.Diagram_ID,
      packageId: diagram.Package_ID,
      fileName,
      content,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

/**
 * Export all packages from the EA database to PlantUML strings.
 *
 * @param {object} db - Database object with tables loaded via mdb-reader
 * @returns {Array<{packageName: string, fileName: string, content: string}>}
 */
function exportPlantUML (db) {
  // Load operations table (methods) — may not be loaded by default export.js
  if (!db.operations) {
    db.operations = []
    log(chalk.yellow('⚠ t_operation table not loaded — methods will be empty'))
  }

  const results = []
  const { roots } = buildPackageTree(db.packages)

  // Track the sanitized path prefix for each package so diagrams can be
  // written next to their owning package (e.g. Parent__Child__DiagramName.puml).
  const packagePrefixById = new Map()

  // Recursive walk of all packages
  function walkPackage (pkg, prefix = '') {
    const pkgName = pkg.Name.replace(/[/\\:*?"<>|]/g, '_')
    const currentPrefix = prefix ? `${prefix}__${pkgName}` : pkgName
    packagePrefixById.set(pkg.Package_ID, currentPrefix)

    const puml = packageToPlantUML(pkg, db)
    if (puml) {
      results.push({
        kind: 'package',
        packageName: pkg.Name,
        packageId: pkg.Package_ID,
        fileName: `${currentPrefix}.puml`,
        content: puml,
      })
    }

    // Find child packages
    const children = db.packages.filter(p => p.Parent_ID === pkg.Package_ID)
    for (const child of children) {
      walkPackage(child, currentPrefix)
    }
  }

  for (const root of roots) {
    walkPackage(root)
  }

  const packageCount = results.length

  // Diagram export — one .puml per EA diagram (t_diagram), using the exact
  // set of elements/connectors placed on the diagram.
  const diagramResults = exportDiagrams(db, packagePrefixById)
  results.push(...diagramResults)

  log(chalk.blue(
    `Exported ${packageCount} package(s) and ${diagramResults.length} diagram(s) to PlantUML`
  ))
  return results
}

export { exportPlantUML }
