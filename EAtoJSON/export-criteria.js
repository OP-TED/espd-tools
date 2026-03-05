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
  const criterionOrder = extractCriterionOrderFromParts(criterionStructure)

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

  // Export criteria in the correct order
  for (const code of criterionOrder) {
    //if (typeof code !== 'string' || !code.trim()) continue
    result.push(exportPackage(db, code.trim(), orderMap))
  }

  return result
}

/* ---------------- helpers ---------------- */

function extractCriterionOrderFromParts(structure) {
  const order = []

  Object.values(structure).forEach(part => {
    Object.values(part).forEach(group => {
      if (!Array.isArray(group)) return

      // IMPORTANT: EA arrays can be sparse; ignore holes/undefined
      for (const code of group) {
        if (typeof code === 'string' && code.trim()) {
          order.push(code.trim())
        }
      }
    })
  })

  return order
}

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
