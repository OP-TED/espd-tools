import { exportPackage } from './export-package.js'

function exportCriteria (db) {
  const structureStr = db.attributes.find(x => x.Name === 'structure').Default
  const structure = JSON.parse(structureStr)
  const result = {}

  // Get all leaves from the nested structure
  const allLeaves = Object.values(structure).
    flatMap(part => Object.values(part)).
    flat()

  // Generate content for each leaf
  allLeaves.forEach(leaf => {
    console.log('exporting', leaf)
    result[leaf] = exportPackage(db, leaf)
  })

  return result
}

export { exportCriteria }
