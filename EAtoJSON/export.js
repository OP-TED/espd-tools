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

const result = exportCriteria(db)
const outputDir = 'outputs'
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
const outputFile = path.join(outputDir, 'espd-edm.json')
fs.writeFileSync(outputFile, JSON.stringify(result, null, 2))
console.log('wrote', outputFile)

exportCodeLists(db)
