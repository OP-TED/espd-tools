import fs from 'fs'
import MDBReader from 'mdb-reader'
import path from 'path'
import { exportCodeLists } from './export-code-lists.js'
import { exportCriteria } from './export-criteria.js'
import { exportPackage } from './export-package.js'

// Load database tables
const loadDatabase = (filePath) => {
  const buffer = fs.readFileSync(path.resolve(filePath))
  const reader = new MDBReader(buffer)

  return {
    objects: reader.getTable('t_object').getData(),
    attributes: reader.getTable('t_attribute').getData(),
    packages: reader.getTable('t_package').getData(),
    connectors: reader.getTable('t_connector').getData(),
  }
}

const db = loadDatabase('ESPD_CM.eapx')

// Export criteria
console.log('\n=== Exporting Criteria ===')
const criteriaResult = exportCriteria(db)
const outputDir = 'outputs'
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
const criteriaFile = path.join(outputDir, 'espd-edm.json')
fs.writeFileSync(criteriaFile, JSON.stringify(criteriaResult, null, 2))
console.log(`✓ Wrote ${criteriaFile}`)

// Export code lists
console.log('\n=== Exporting Code Lists ===')
const codeListsResult = exportCodeLists(db)
const codeListsDir = path.join(outputDir, 'code-lists')
if (!fs.existsSync(codeListsDir)) fs.mkdirSync(codeListsDir, { recursive: true })

// Write each code list file
codeListsResult.results.forEach(result => {
  if (result.success) {
    const filePath = path.join(codeListsDir, result.fileName)
    fs.writeFileSync(filePath, result.content, 'utf-8')
    console.log(`✓ Generated ${result.fileName} (${result.valueCount} values)`)
  } else {
    console.error(`✗ Failed to generate ${result.fileName}: ${result.error}`)
  }
})

// Final summary
console.log('\n=== Summary ===')
console.log(`Criteria: exported to ${criteriaFile}`)
console.log(`Code Lists: ${codeListsResult.stats.successful}/${codeListsResult.stats.total} files written to ${codeListsDir}`)
if (codeListsResult.stats.failed > 0) {
  console.log(`⚠ ${codeListsResult.stats.failed} code list(s) failed`)
}