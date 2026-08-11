/**
 * Apply SQL statements to an EA .eapx (Access/JET) database.
 *
 * Uses the Windows built-in Microsoft Access ODBC driver to execute
 * INSERT/UPDATE/DELETE statements against the .eapx file.
 *
 * Usage:
 *   node apply-sql.js <eapx-file> <sql-file>
 *
 * Requirements:
 *   - Windows with Microsoft Access Database Engine or MS Office installed
 *   - The ODBC driver "Microsoft Access Driver (*.mdb, *.accdb)" must be available
 *
 * Alternative for Linux/macOS:
 *   Install mdbtools and use: mdb-sql -p <eapx-file> < import-changes.sql
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import chalk from 'chalk'

const log = console.log

/**
 * Apply a SQL file to the .eapx database using PowerShell + ODBC.
 */
function applySqlViaODBC (eapxPath, sqlFile) {
  const resolvedEapx = path.resolve(eapxPath)
  const resolvedSql = path.resolve(sqlFile)

  if (!fs.existsSync(resolvedEapx)) {
    throw new Error(`Database not found: ${resolvedEapx}`)
  }
  if (!fs.existsSync(resolvedSql)) {
    throw new Error(`SQL file not found: ${resolvedSql}`)
  }

  const statements = fs.readFileSync(resolvedSql, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('--'))

  log(chalk.blue(`Applying ${statements.length} SQL statements to ${resolvedEapx}`))

  // Generate a PowerShell script that opens ODBC and runs each statement
  const psScript = `
$connectionString = "Driver={Microsoft Access Driver (*.mdb, *.accdb)};Dbq=${resolvedEapx.replace(/\\/g, '\\\\')};"
$connection = New-Object System.Data.Odbc.OdbcConnection($connectionString)
$connection.Open()
$errors = 0
$success = 0

${statements.map((stmt, i) => `
try {
  $cmd = $connection.CreateCommand()
  $cmd.CommandText = "${stmt.replace(/"/g, '`"').replace(/\n/g, '')}"
  $cmd.ExecuteNonQuery() | Out-Null
  $success++
} catch {
  Write-Host "ERROR [${i + 1}]: $_"
  $errors++
}
`).join('\n')}

$connection.Close()
Write-Host "Done: $success successful, $errors failed out of ${statements.length} total"
if ($errors -gt 0) { exit 1 }
`

  const psFile = path.join(path.dirname(resolvedSql), '_apply_import.ps1')
  fs.writeFileSync(psFile, psScript, 'utf-8')

  try {
    const result = execSync(
      `powershell -ExecutionPolicy Bypass -File "${psFile}"`,
      { encoding: 'utf-8', stdio: 'pipe' }
    )
    log(chalk.green(result.trim()))
  } catch (err) {
    log(chalk.red('Import failed:'))
    log(err.stdout || err.message)
    throw err
  } finally {
    // Clean up temp script
    try { fs.unlinkSync(psFile) } catch {}
  }
}

/**
 * Try to apply SQL using mdb-sql (mdbtools) — works on Linux/macOS/WSL.
 */
function applySqlViaMdbTools (eapxPath, sqlFile) {
  const resolvedEapx = path.resolve(eapxPath)

  try {
    execSync(`mdb-sql -p "${resolvedEapx}" < "${sqlFile}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    })
    log(chalk.green('✓ Applied via mdb-sql'))
  } catch (err) {
    throw new Error(`mdb-sql failed: ${err.message}`)
  }
}

/**
 * Detect platform and apply SQL using the best available method.
 */
function applySql (eapxPath, sqlFile) {
  if (process.platform === 'win32') {
    applySqlViaODBC(eapxPath, sqlFile)
  } else {
    // Try mdbtools
    try {
      execSync('which mdb-sql', { stdio: 'pipe' })
      applySqlViaMdbTools(eapxPath, sqlFile)
    } catch {
      log(chalk.yellow('⚠ mdb-sql not found. Install mdbtools or run on Windows with Access ODBC driver.'))
      log(chalk.yellow(`  SQL file written to: ${sqlFile}`))
      log(chalk.yellow('  Apply manually with: mdb-sql -p <eapx> < ' + sqlFile))
    }
  }
}

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('apply-sql.js')) {
  const [,, eapxPath, sqlFile] = process.argv

  if (!eapxPath || !sqlFile) {
    console.error('Usage: node apply-sql.js <eapx-file> <sql-file>')
    process.exit(1)
  }

  applySql(eapxPath, sqlFile)
}

export { applySql, applySqlViaODBC, applySqlViaMdbTools }
