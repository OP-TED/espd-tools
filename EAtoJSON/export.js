#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import MDBReader from 'mdb-reader'
import chalk from 'chalk'
import caporal from '@caporal/core'
import { exportCriteria } from './export-criteria.js'
import { exportCodeLists } from './export-code-lists.js'

const { program } = caporal
const log = console.log

// Load database
const loadDatabase = (filePath) => {
  const buffer = fs.readFileSync(path.resolve(filePath))
  const reader = new MDBReader(buffer)

  return {
    objects: reader.getTable('t_object').getData(),
    objectProperties: reader.getTable('t_objectproperties').getData(),
    attributes: reader.getTable('t_attribute').getData(),
    packages: reader.getTable('t_package').getData(),
    connectors: reader.getTable('t_connector').getData(),
  }
}

program
  .version('1.0.0')
  .name('export')
  .description('Tool to export ESPD data from EA database')

  .command('criteria', 'Export criteria to JSON')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-o, --output <dir>', 'Output directory', { default: 'outputs' })
  .action(({ args, options }) => {
    log(chalk.bold('\n=== Exporting Criteria ==='))
    const db = loadDatabase(args.eafile)
    const result = exportCriteria(db)

    if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true })
    const outputFile = path.join(options.output, 'espd-edm.json')
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2))
    log(chalk.green(`✓ Wrote ${outputFile}`))
  })

  .command('code-lists', 'Export code lists to .gc files')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-o, --output <dir>', 'Output directory', { default: 'outputs/code-lists' })
  .action(async ({ args, options }) => {
    log(chalk.bold('\n=== Exporting Code Lists ==='))
    const db = loadDatabase(args.eafile)
    const { results, stats } = await exportCodeLists(db)

    if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true })

    results.forEach(result => {
      if (result.success) {
        const filePath = path.join(options.output, result.fileName)
        fs.writeFileSync(filePath, result.content, 'utf-8')
        log(chalk.green(`✓ Generated ${result.fileName} (${result.valueCount} values)`))
      } else {
        log(chalk.red(`✗ Failed to generate ${result.fileName}: ${result.error}`))
      }
    })

    log(chalk.bold(`\n${stats.successful}/${stats.total} files written to ${options.output}`))
    if (stats.failed > 0) log(chalk.yellow(`⚠ ${stats.failed} code list(s) failed`))
  })

  .command('all', 'Export both criteria and code lists')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-o, --output <dir>', 'Output directory', { default: 'outputs' })
  .action(async ({ args, options }) => {
    log(chalk.bold('\n=== Exporting All ==='))
    const db = loadDatabase(args.eafile)

    // Criteria
    log(chalk.bold('\n--- Criteria ---'))
    const criteriaResult = exportCriteria(db)
    if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true })
    const criteriaFile = path.join(options.output, 'espd-edm.json')
    fs.writeFileSync(criteriaFile, JSON.stringify(criteriaResult, null, 2))
    log(chalk.green(`✓ Wrote ${criteriaFile}`))

    // Code lists
    log(chalk.bold('\n--- Code Lists ---'))
    const { internal, external, stats } = await exportCodeLists(db)
    const codeListsDir = path.join(options.output, 'code-lists')
    if (!fs.existsSync(codeListsDir)) fs.mkdirSync(codeListsDir, { recursive: true })

    internal.forEach(result => {
      if (result.success) {
        const filePath = path.join(codeListsDir, result.fileName)
        fs.writeFileSync(filePath, result.content, 'utf-8')
        log(chalk.green(`✓ Generated ${result.fileName} (${result.valueCount} values)`))
      } else {
        log(chalk.red(`✗ Failed to generate ${result.fileName}: ${result.error}`))
      }
    })
    external.forEach(result => {
      if (result.success) {
        const filePath = path.join(codeListsDir, result.fileName)
        fs.writeFileSync(filePath, result.content, 'utf-8')
        log(chalk.green(`✓ Downloaded ${result.fileName}`))
      } else {
        log(chalk.red(`✗ Failed to download ${result.fileName}: ${result.error}`))
      }
    })
    // Summary
    log(chalk.bold('\n=== Summary ==='))
    log(`Criteria: exported to ${criteriaFile}`)
    log(`Code Lists: ${stats.successful}/${stats.total} files written to ${codeListsDir}`)
    if (stats.failed > 0) log(chalk.yellow(`⚠ ${stats.failed} code list(s) failed`))
  })

program.run()