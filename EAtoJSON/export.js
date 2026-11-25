#!/usr/bin/env node

import fs from 'fs'
import path from 'path'
import MDBReader from 'mdb-reader'
import chalk from 'chalk'
import caporal from '@caporal/core'
import { exportCriteria } from './export-criteria.js'
import { exportCodeLists } from './export-code-lists.js'
import { getUnrecognizedTypeWarnings } from './export-package.js'
import { readModelMetadata, verifyModelVersions, findStaleCodeListTags, METADATA_ELEMENT_NAME } from './model-metadata.js'
import { verifyExportedCodeLists } from './verify-export.js'

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

const printUnrecognizedTypeSummary = () => {
  const warnings = getUnrecognizedTypeWarnings()
  if (warnings.length === 0) return

  log(chalk.yellow(`\n⚠ ${warnings.length} node(s) had an unrecognized label and were defaulted to CRITERION (children not exported):`))
  warnings.forEach(w => log(chalk.yellow(`  - ${w.name}${w.label ? ` (label: ${w.label})` : ''}`)))
}

// Summarises the code list run and aborts on genuine failures.
//
// The previous summary read stats.successful/stats.total/stats.failed, none of
// which exportCodeLists returns at the top level, so it printed
// "undefined/undefined" and its failure branch never ran: a code list that
// failed to download was written out of codelists.json and the run still
// reported success. Deliberate omissions are counted separately so the planned
// at-voc:criterion omission does not abort the export.
const reportCodeListOutcomes = (stats, outputDir) => {
  const written = stats.internal.successful + stats.external.successful
  const attempted = stats.internal.total + stats.external.total
  const skipped = stats.internal.skipped + stats.external.skipped
  const failed = stats.internal.failed + stats.external.failed

  log(chalk.bold(`\nCode Lists: ${written}/${attempted} files written to ${outputDir}`))
  if (skipped > 0) log(chalk.yellow(`⊘ ${skipped} code list(s) deliberately skipped`))
  if (failed > 0) {
    log(chalk.red(`✗ ${failed} code list(s) failed - see the log above`))
    log(chalk.red(`Refusing to continue: codelists.json would be missing them.`))
    process.exit(1)
  }
}

// Reads the document-level versions and cross-checks every version embedded in
// the model against them, then stops the process on the first disagreement.
//
// Exporting on top of an inconsistent model is what produced a codelists.json
// stamped 5.0.0-alpha.2 next to .gc files stamped 5.0.0, so this runs before
// anything is written rather than as a report afterwards. Exit code 1 is what
// the CI gate keys on.
const resolveVersions = (db, { expectedVersion = null, elementName = null } = {}) => {
  if (elementName) {
    log(chalk.yellow(
      `\n⚠ Reading the versions from "${elementName}" instead of the conventional ` +
      `"${METADATA_ELEMENT_NAME}" element. For diagnostics only - do not publish from this run.`))
  }

  let metadata
  try {
    metadata = readModelMetadata(db, elementName ? { elementName } : {})
  } catch (error) {
    log(chalk.red(`\n✗ Cannot determine the ESPD version from the model.\n`))
    log(error.message)
    process.exit(1)
  }

  log(chalk.bold(`\n--- Versions ---`))
  log(`ESPD version: ${chalk.cyan(metadata.espdVersion)}  (from ${metadata.source})`)
  log(`UBL version:  ${chalk.cyan(metadata.ublVersion)}`)
  if (expectedVersion) log(`Expected by the caller: ${chalk.cyan(expectedVersion)}`)

  const problems = verifyModelVersions(db, metadata, { expectedVersion })
  if (problems.length > 0) {
    log(chalk.red(`\n✗ ${problems.length} version inconsistency/ies in the model:`))
    problems.forEach(p => log(chalk.red(`  - ${p}`)))
    log(chalk.red(`\nRefusing to export. Fix the conceptual model so every version agrees.`))
    process.exit(1)
  }

  log(chalk.green(`✓ Model versions are consistent`))

  const stale = findStaleCodeListTags(db, metadata)
  if (stale.length > 0) {
    log(chalk.yellow(`\n⚠ ${stale.length} code list tagged value(s) in the model are ignored:`))
    stale.forEach(w => log(chalk.yellow(`  - ${w}`)))
  }

  return metadata
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
    printUnrecognizedTypeSummary()
  })

  .command('code-lists', 'Export code lists to .gc files')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-o, --output <dir>', 'Output directory', { default: 'outputs/code-lists' })
  .option('--expect-version <version>', 'Fail unless the model declares this ESPD version')
  .option('--metadata-element <name>', 'Diagnostics only: read the versions from a differently named element')
  .action(async ({ args, options }) => {
    log(chalk.bold('\n=== Exporting Code Lists ==='))
    const db = loadDatabase(args.eafile)
    const metadata = resolveVersions(db, {
      expectedVersion: options.expectVersion,
      elementName: options.metadataElement,
    })
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

    const { internal, external, codelistMetadata, stats } = await exportCodeLists(db, metadata)
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
        } else if (result.skipped) {
          log(chalk.yellow(`⊘ Skipped ${result.fileName}: ${result.error}`))
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

    reportCodeListOutcomes(stats, options.output)
  })

  .command('all', 'Export both criteria and code lists')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('-o, --output <dir>', 'Output directory', { default: 'outputs' })
  .option('--expect-version <version>', 'Fail unless the model declares this ESPD version')
  .option('--metadata-element <name>', 'Diagnostics only: read the versions from a differently named element')
  .action(async ({ args, options }) => {
    log(chalk.bold('\n=== Exporting All ==='))
    const db = loadDatabase(args.eafile)
    const metadata = resolveVersions(db, {
      expectedVersion: options.expectVersion,
      elementName: options.metadataElement,
    })

    // Criteria
    log(chalk.bold('\n--- Criteria ---'))
    const criteriaResult = exportCriteria(db)
    if (!fs.existsSync(options.output)) fs.mkdirSync(options.output, { recursive: true })
    const criteriaFile = path.join(options.output, 'espd-edm.json')
    fs.writeFileSync(criteriaFile, JSON.stringify(criteriaResult, null, 2))
    log(chalk.green(`✓ Wrote ${criteriaFile}`))
    printUnrecognizedTypeSummary()

    // Code lists
    log(chalk.bold('\n--- Code Lists ---'))
    const { internal, external,codelistMetadata, stats } = await exportCodeLists(db, metadata)
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
      } else if (result.skipped) {
        log(chalk.yellow(`⊘ Skipped ${result.fileName}: ${result.error}`))
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
    log(`ESPD version: ${metadata.espdVersion} (UBL ${metadata.ublVersion})`)
    log(`Criteria: exported to ${criteriaFile}`)
    reportCodeListOutcomes(stats, codeListsDir)
  })

  .command('check-versions', 'Verify the versions declared in the model agree with each other')
  .argument('[eafile]', 'EA database file', { default: 'ESPD_CM.eapx' })
  .option('--expect-version <version>', 'Fail unless the model declares this ESPD version')
  .option('--metadata-element <name>', 'Diagnostics only: read the versions from a differently named element')
  .action(({ args, options }) => {
    log(chalk.bold('\n=== Checking Versions ==='))
    const db = loadDatabase(args.eafile)
    // Exits 1 on any inconsistency; reaching the next line means the model agrees.
    const metadata = resolveVersions(db, {
      expectedVersion: options.expectVersion,
      elementName: options.metadataElement,
    })
    log(chalk.green(`\n✓ ESPD ${metadata.espdVersion} / UBL ${metadata.ublVersion}`))
  })

  .command('verify-export', 'Verify exported code lists against each other and the expected version')
  .argument('[dir]', 'Folder holding codelists.json and the .gc files', { default: 'outputs/code-lists' })
  .option('--expect-version <version>', 'Fail unless codelists.json declares this ESPD version')
  .option('--schemas <file>', 'schemas.json to cross-check ublVersion against')
  .action(({ args, options }) => {
    log(chalk.bold('\n=== Verifying Exported Code Lists ==='))
    log(`Folder: ${args.dir}`)

    const problems = verifyExportedCodeLists(args.dir, {
      expectedVersion: options.expectVersion,
      schemasFile: options.schemas,
    })

    if (problems.length > 0) {
      log(chalk.red(`\n✗ ${problems.length} problem(s) in the exported artefacts:`))
      problems.forEach(p => log(chalk.red(`  - ${p}`)))
      process.exit(1)
    }

    log(chalk.green(`✓ Exported code lists are internally consistent`))
  })

program.run()