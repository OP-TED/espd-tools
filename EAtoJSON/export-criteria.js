// ============================================
// ESPD-EDM criteria export — part/section assembly
// ============================================
//
// Public surface: exportCriteria.
//
// EA holds two different things in the pseudo-attribute called "structure":
//   - 61 PER-CRITERION diagrams, each a { diagramName, tree } blob
//   - 1 PART/SECTION INDEX, { partI: { A: [codes] }, partII: ... }, which is
//     what drives this file: it decides which criteria are exported and in
//     which order.
//
// Removed relative to the previous implementation, verified against the model:
//   - buildGlobalOrderMap / buildOrderMap and the `orderMap` they produced
//     (~30 lines). Nothing consumed it: its only reader in export-package.js
//     was commented out, and the root call site already dropped it.
//   - a duplicate JSON.parse of the index attribute (once to detect it in the
//     `find` predicate, once to use it).
//
// Added: the silent paths now report. Four things used to vanish without a
// trace — an unparseable structure blob, an ambiguous index, a malformed
// section, and a criterion package that the index simply doesn't mention.

import {
  exportPackage,
  resetUnrecognizedTypeWarnings,
  normalizeCode,
  normalizeObjectName,
} from './export-package.js'
import chalk from 'chalk'

const log = console.log

const STRUCTURE_ATTRIBUTE = 'structure'

// ============================================
// Reading the "structure" attributes
// ============================================

// Parses every structure blob, keeping the failures instead of swallowing
// them. C65_OT_sme currently has a trailing comma and does not parse, which
// costs that criterion its declared child order.
const parseStructureAttributes = (db) => {
  const objectName = new Map(db.objects.map(o => [o.Object_ID, o.Name]))
  const parsed = []
  const failures = []

  db.attributes
    .filter(attr => attr.Name === STRUCTURE_ATTRIBUTE && attr.Default)
    .forEach(attr => {
      const owner = normalizeObjectName(
        objectName.get(attr.Object_ID) ?? `object ${attr.Object_ID}`
      )
      try {
        parsed.push({ owner, json: JSON.parse(attr.Default) })
      } catch (error) {
        failures.push({ owner, message: error.message })
      }
    })

  if (failures.length > 0) {
    log(chalk.yellow(
      `⚠ ${failures.length} "${STRUCTURE_ATTRIBUTE}" attribute(s) are not valid JSON and were ignored:`
    ))
    failures.forEach(f => log(chalk.yellow(`  - ${f.owner}: ${f.message}`)))
  }

  return parsed
}

// ============================================
// Declared child order
// ============================================

// Flattens one criterion's tree into Map<relativePathFromRoot, childLabels[]>.
// The root's children live under '' — the root segment is deliberately dropped,
// because the blob spells it with the EA object name while the exporter builds
// paths from the requestpath, and those diverge for the OT criteria and C18.
// Keying relative to the criterion also avoids the collisions that made the
// previous global orderMap unusable: 'RG1/RSG1' is not unique across criteria.
const buildCriterionOrderMap = (treeNode, relativePath = '', map = new Map()) => {
  const children = treeNode?.children ?? []
  if (children.length === 0) return map

  const labelOf = (child) => normalizeObjectName(child.path).split('/').pop()

  map.set(relativePath, children.map(labelOf))

  children.forEach(child => {
    const label = labelOf(child)
    buildCriterionOrderMap(
      child,
      relativePath ? `${relativePath}/${label}` : label,
      map
    )
  })

  return map
}

// Map<criterionRootObjectName, Map<relativePath, childLabels[]>>
const buildDeclaredOrders = (structures) =>
  structures.reduce((acc, { owner, json }) => {
    if (json?.tree) acc.set(owner, buildCriterionOrderMap(json.tree))
    return acc
  }, new Map())

// The index is the one structure blob that is NOT a per-criterion diagram:
// it has no `tree` and its top-level keys are the ESPD parts. The previous
// test — `parsed.partIII || parsed.partIV` — happened to be unique but would
// break if the parts were renamed or if only partI/partII survived a revision.
const isPartSectionIndex = (structure) =>
  !!structure &&
  typeof structure === 'object' &&
  !structure.tree &&
  Object.keys(structure).some(key => /^part/i.test(key))

const findPartSectionIndex = (structures) => {
  const candidates = structures.map(s => s.json).filter(isPartSectionIndex)

  if (candidates.length === 0) {
    throw new Error(
      `Part/section index not found: none of the ${structures.length} parseable "${STRUCTURE_ATTRIBUTE}" attributes has part* keys without a "tree".`
    )
  }

  if (candidates.length > 1) {
    log(chalk.yellow(
      `⚠ ${candidates.length} part/section indexes found — using the first. Parts seen: ${
        candidates.map(c => `[${Object.keys(c).join(',')}]`).join(' ')
      }`
    ))
  }

  return candidates[0]
}

// ============================================
// Reconciliation
// ============================================

// Every criterion package that exists in EA with content. Used to catch the
// silent-omission case: the index decides what gets exported, so a package
// added to the model but never added to the index just never appears in
// espd-edm.json, with nothing in the log to say so. C27 and C28 are in exactly
// that state today (superseded by C66, but the tool never said so).
const listCriterionPackages = (db) => {
  const populated = new Set(db.objects.map(obj => obj.Package_ID))

  return db.packages.reduce((acc, pkg) => {
    const [first] = String(pkg.Name).split(' ')
    const code = normalizeCode(first)
    if (code && populated.has(pkg.Package_ID)) acc.set(code, pkg.Name)
    return acc
  }, new Map())
}

const reportUnreferencedPackages = (db, referencedCodes) => {
  const inModel = listCriterionPackages(db)
  const unreferenced = [...inModel.entries()].filter(([code]) => !referencedCodes.has(code))

  if (unreferenced.length === 0) return

  log(chalk.yellow(
    `⚠ ${unreferenced.length} criterion package(s) exist in EA but are not referenced by the part/section index, so they are NOT exported:`
  ))
  unreferenced.forEach(([code, name]) => log(chalk.yellow(`  - ${code} ("${name}")`)))
}

// ============================================
// Export
// ============================================

const exportCriteria = (db) => {
  resetUnrecognizedTypeWarnings()

  const structures = parseStructureAttributes(db)
  const index = findPartSectionIndex(structures)

  // EA's per-criterion diagrams are the authority on child order; the label
  // heuristics in export-package only apply where a tree is missing or stale.
  const declaredOrders = buildDeclaredOrders(structures)
  log(chalk.gray(`  declared child order available for ${declaredOrders.size} criteria`))

  const referencedCodes = new Set()
  const result = []

  // Export criteria grouped by Part and Section, preserving the order the
  // index declares:
  // [ { part, sections: [ { section, criteria: [ <criterion> ] } ] } ]
  for (const [partKey, sections] of Object.entries(index)) {
    const partEntry = { part: partKey, sections: [] }

    for (const [sectionKey, codes] of Object.entries(sections ?? {})) {
      if (!Array.isArray(codes)) {
        log(chalk.yellow(
          `⚠ ${partKey}/${sectionKey}: expected an array of criterion codes, got ${
            codes === null ? 'null' : typeof codes
          } — section skipped.`
        ))
        continue
      }

      const sectionEntry = { section: sectionKey, criteria: [] }

      codes.forEach((code, position) => {
        // EA arrays can be sparse; holes and blanks are not criterion codes.
        if (typeof code !== 'string' || !code.trim()) {
          log(chalk.yellow(
            `⚠ ${partKey}/${sectionKey}[${position}]: skipping ${JSON.stringify(code)} — not a criterion code.`
          ))
          return
        }

        const trimmed = code.trim()
        const normalized = normalizeCode(trimmed)

        if (normalized && referencedCodes.has(normalized)) {
          log(chalk.yellow(
            `⚠ ${partKey}/${sectionKey}[${position}]: ${trimmed} is referenced more than once in the index — exporting it again.`
          ))
        }
        if (normalized) referencedCodes.add(normalized)

        const exported = exportPackage(db, trimmed, declaredOrders)
        if (exported) sectionEntry.criteria.push(exported)
      })

      partEntry.sections.push(sectionEntry)
    }

    result.push(partEntry)
  }

  reportUnreferencedPackages(db, referencedCodes)

  return result
}

export { exportCriteria }
