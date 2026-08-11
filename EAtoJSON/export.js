#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import MDBReader from 'mdb-reader'
import chalk from 'chalk'
import caporal from '@caporal/core'
import { exportCriteria } from './export-criteria.js'
import { exportCodeLists } from './export-code-lists.js'
import { exportPlantUML } from './export-plantuml.js'
import { planImport, executeImport } from './import-plantuml.js'
import { applySql } from './apply-sql.js'

const { program } = caporal
const log = console.log

// Load database
const loadDatabase = (filePath) => {
  const buffer = fs.readFileSync(path.resolve(filePath))
  const reader = new MDBReader(buffer)

  let operations = []
  try {
    operations = reader.getTable('t_operation').getData()
  } catch {
    // t_operation may not exist in minimal .eapx files
  }

  return {
    objects: reader.getTable('t_object').getData(),
    objectProperties: reader.getTable('t_objectproperties').getData(),
    attributes: reader.getTable('t_attribute').getData(),
    packages: reader.getTable('t_package').getData(),
    connectors: reader.getTable('t_connector').getData(),
    operations,
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
    // const { results, stats } = await exportCodeLists(db)

    // if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true })

    // results.forEach(result => {
    //   if (result.success) {
    //     const filePath = path.join(options.output, result.fileName)
    //     fs.writeFileSync(filePath, result.content, 'utf-8')
    //     log(chalk.green(`✓ Generated ${result.fileName} (${result.valueCount} values)`))
    //   } else {
    //     log(chalk.red(`✗ Failed to generate ${result.fileName}: ${result.error}`))
    //   }
    // })

    const { internal, external, codelistMetadata, stats } = await exportCodeLists(db)
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

    const metadataFilePath = path.join(
      codeListsDir,
      'codelists.json'
    )

    fs.writeFileSync(
      metadataFilePath,
      JSON.stringify(codelistMetadata, null, 2),
      'utf-8'
    )

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
    const { internal, external,codelistMetadata, stats } = await exportCodeLists(db)
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

    const metadataFilePath = path.join(
    codeListsDir,
    'codelists.json'
  )

  fs.writeFileSync(
    metadataFilePath,
    JSON.stringify(codelistMetadata, null, 2),
    'utf-8'
  )

log(chalk.green(`✓ Generated codelist metadata (codelists.json)`))
    // Summary
    log(chalk.bold('\n=== Summary ==='))
    log(`Criteria: exported to ${criteriaFile}`)
    log(`Code Lists: ${stats.successful}/${stats.total} files written to ${codeListsDir}`)
    if (stats.failed > 0) log(chalk.yellow(`⚠ ${stats.failed} code list(s) failed`))
  })

  // =========================================================================
  // PlantUML Roundtrip Commands
  // =========================================================================

  .command('plantuml', 'Export model to PlantUML (.puml) files')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-o, --output <dir>', 'Output directory', { default: 'outputs/plantuml' })
  .action(({ args, options }) => {
    log(chalk.bold('\n=== Exporting to PlantUML ==='))
    const db = loadDatabase(args.eafile)

    const results = exportPlantUML(db)

    if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true })

    results.forEach(result => {
      const filePath = path.join(options.output, result.fileName)
      fs.writeFileSync(filePath, result.content, 'utf-8')
      log(chalk.green(`  ✓ ${result.fileName} (${result.packageName})`))
    })

    log(chalk.bold(`\n${results.length} .puml file(s) written to ${options.output}`))
  })

  .command('plantuml-import', 'Import PlantUML changes back into EA database')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-i, --input <dir>', 'Directory with .puml files', { default: 'outputs/plantuml' })
  .option('-o, --output <dir>', 'Directory for generated SQL', { default: 'outputs' })
  .option('--target-package <name>', 'Target package name for new elements')
  .option('--dry-run', 'Parse and plan only, do not apply changes', { default: false })
  .option('--apply', 'Apply SQL directly to the database (requires ODBC driver)', { default: false })
  .action(({ args, options }) => {
    log(chalk.bold('\n=== Importing PlantUML into EA ==='))

    const { sql, summary, parsed } = planImport(args.eafile, options.input, {
      targetPackage: options.targetPackage,
      dryRun: options.dryRun,
    })

    log(chalk.blue(`\nParsed ${parsed.files} file(s): ${parsed.elements} elements, ${parsed.relations} relations`))

    if (options.dryRun) {
      log(chalk.yellow('\n[DRY RUN] No changes applied.'))
      log(`  Would create: ${summary.created} element(s)`)
      log(`  Would update: ${summary.updated} element(s)`)
      log(`  Would add: ${summary.connectors} connector(s)`)
      log(`  Total SQL statements: ${sql.length}`)
      return
    }

    // Write SQL file
    const sqlFile = executeImport(args.eafile, sql, options.output)

    log(chalk.blue(`\nSummary:`))
    log(`  Created: ${summary.created} element(s)`)
    log(`  Updated: ${summary.updated} element(s)`)
    log(`  Connectors: ${summary.connectors}`)
    log(`  SQL file: ${sqlFile}`)

    // Optionally apply directly
    if (options.apply) {
      log(chalk.bold('\nApplying changes to database...'))
      applySql(args.eafile, sqlFile)
    } else {
      log(chalk.yellow(`\nTo apply changes, run:`))
      log(chalk.yellow(`  node apply-sql.js ${args.eafile} ${sqlFile}`))
    }
  })

program.run()