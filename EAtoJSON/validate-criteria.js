#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import chalk from 'chalk';
import caporal from '@caporal/core';

const { program } = caporal;
const log = console.log;

// AJV instance for validating data
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);

// AJV instance for validating schemas (validates against meta-schema)
const ajvMeta = new Ajv2020({ 
  allErrors: true, 
  validateSchema: true,  // Enable meta-schema validation
  strict: false 
});
addFormats(ajvMeta);

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

    // Validate the schema itself against JSON Schema spec
    log(chalk.blue('Validating schema conformance...'));
    
    // Check if schema declares a $schema keyword
    const schemaId = schema.$schema || 'https://json-schema.org/draft/2020-12/schema';
    log(chalk.gray(`Schema declares: ${schemaId}`));

    // Validate schema against its declared meta-schema
    const schemaValid = ajvMeta.validateSchema(schema);
    
    if (!schemaValid) {
      log(chalk.red('❌ Schema validation failed - schema does not conform to JSON Schema spec:'));
      console.log(JSON.stringify(ajvMeta.errors, null, 2));
      process.exit(1);
    }
    log(chalk.green('✅ Schema is valid (conforms to JSON Schema spec)'));

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