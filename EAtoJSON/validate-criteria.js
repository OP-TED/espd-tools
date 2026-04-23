#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import chalk from 'chalk';
import caporal from '@caporal/core';

const { program } = caporal;
const log = console.log;

const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

program
  .version('1.0.0')
  .name('validate')
  .description('Validate ESPD criteria JSON against the schema')

  .argument('[jsonfile]', 'ESPD criteria JSON file', { default: 'outputs/espd-edm.json' })
  .option('-s, --schema <file>', 'JSON schema file', { default: 'espd_schema.json' })
  .action(({ args, options }) => {
    log(chalk.bold('\n=== Validating ESPD Criteria ==='));

    // Load schema
    const schemaPath = path.resolve(options.schema);
    if (!fs.existsSync(schemaPath)) {
      log(chalk.red(`❌ Schema file not found: ${schemaPath}`));
      process.exit(1);
    }
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    log(chalk.blue(`Loaded schema: ${options.schema}`));

    // Load data
    const dataPath = path.resolve(args.jsonfile);
    if (!fs.existsSync(dataPath)) {
      log(chalk.red(`❌ Data file not found: ${dataPath}`));
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    log(chalk.blue(`Loaded data: ${args.jsonfile}`));

    // Validate
    const validate = ajv.compile(schema);
    const valid = validate(data);

    if (valid) {
      log(chalk.green('✅ Validation successful'));
    } else {
      log(chalk.red('❌ Validation failed:'));
      console.log(JSON.stringify(validate.errors, null, 2));
      process.exit(1);
    }
  });

program.run();