import { exportPackage } from './export-package.js'

function exportCriteria (db) {
  const result = []

  // Collect all structure attributes
  const structureAttrs = db.attributes.filter(
    a => a.Name === 'structure' && a.Default
  )

  // Find the criterion-order structure
  const criterionStructureAttr = structureAttrs.find(attr => {
    try {
      const parsed = JSON.parse(attr.Default)
      return parsed.partIII || parsed.partIV
    } catch {
      return false
    }
  })

  if (!criterionStructureAttr) {
    throw new Error('Criterion-order structure not found')
  }

  const criterionStructure = JSON.parse(criterionStructureAttr.Default)

  // Build ONE global orderMap from ALL tree-based structures
  const orderMap = buildGlobalOrderMap(
    structureAttrs
      .map(a => {
        try {
          return JSON.parse(a.Default)
        } catch {
          return null
        }
      })
      .filter(s => s?.tree)
  )

  // Export criteria grouped by Part and Section, preserving order:
  // [ { part, sections: [ { section, criteria: [ <criterion> ] } ] } ]
  for (const [partKey, sections] of Object.entries(criterionStructure)) {
    const partEntry = { part: partKey, sections: [] }

    for (const [sectionKey, codes] of Object.entries(sections)) {
      if (!Array.isArray(codes)) continue

      const sectionEntry = { section: sectionKey, criteria: [] }

      // IMPORTANT: EA arrays can be sparse; ignore holes/undefined
      for (const code of codes) {
        if (typeof code !== 'string' || !code.trim()) continue
        const exported = exportPackage(db, code.trim(), orderMap)
        if (exported) sectionEntry.criteria.push(exported)
      }

      partEntry.sections.push(sectionEntry)
    }

    result.push(partEntry)
  }

  return result
}

/* ---------------- helpers ---------------- */

function buildGlobalOrderMap(structures) {
  const orderMap = {}

  structures.forEach(structure => {
    buildOrderMap(structure.tree, '', orderMap)
  })

  return orderMap
}

function buildOrderMap(structureNode, parentPath = '', map = {}) {
  if (!structureNode?.children) return map

  const keys = structureNode.children
    .map(c => c.path.split('/').pop())
    .filter(Boolean)

  map[parentPath] = keys

  structureNode.children.forEach(child => {
    const key = child.path.split('/').pop()
    const nextPath = parentPath ? `${parentPath}/${key}` : key
    buildOrderMap(child, nextPath, map)
  })

  return map
}

export { exportCriteria }
