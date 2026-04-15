# ESPD Tools
The ESPD-EDM Tools repository contains the JavaScript-based transformation engine for the European Single Procurement Document (ESPD). 
It automates the extraction of criteria and code lists from a conceptual model and generates the technical specifications for the ESPD Exchange Data Model(EDM) [ESPD-EDM repository](https://github.com/OP-TED/ESPD-EDM).

## Overview
Starting with version 5.0.0, this project has transitioned to a Model-Driven Architecture. 
The "Source of Truth" is the Enterprise Architect binary file (.eapx) located in the [espd-conceptual-model repository](https://www.example.com).

## Key Capabilities

* **Automated Extraction:** Converts the binary EA model into JSON and Genericode.
* **Criteria Generation:** Recursively parses the model tree to build complex procurement criteria json structures.
* **Codelist Management:** Generates OASIS Genericode (.gc) files for internal lists and automatically downloads the latest external EU Vocabularies.
## Requirements

* **NodeJS:** version 18.X or higher.
* **Input File:** ESPD_CM.eapx (The Enterprise Architect database).

## Installation
To setup and install all necessary JavaScript libraries:

### Usage
### Available Commands

The tools use the `caporal` framework. The main entry point is `export.js`.

| Command | Description | Output Location |
| :--- | :--- | :--- |
| `node export.js criteria` | Extracts criteria logic and structures from the EA model. | `outputs/espd-edm.json` |
| `node export.js code-lists` | Generates internal and downloads external codelists in `.gc` format. | `outputs/code-lists/` |
| `node export.js all` | Performs a full extraction of both criteria and codelists. | `outputs/` |

Use the `--output` or `-o` flag to specify a custom destination directory.


### Command Options:
Use --help for details on arguments like custom input files or output directories:

## Project Structure

* export.js: Main CLI orchestrator.

* export-package.js: Logic for parsing EA packages into EDM criteria.

* export-code-lists.js: Logic for generating Genericode XML and fetching external vocabularies.

 export-criteria.js: Structural logic for ordering and filtering criteria.
<details>

# Legacy Tools (v4.0.0 and earlier)
The following tools and folders have been preserved for archival purposes in [tag](https://github.com/OP-TED/espd-tools/commits/v4.1.0) but are no longer the primary workflow:

* XSLT/: Original XSL Transform files used to process Excel files prior to v4.0.0.

* xslx-criterion-VBA/: VBA code used for legacy Excel tag generation.

* check.js, codelist.js, convert_to.js, excel2espd.js: Legacy Node.js tools designed for Excel-based inputs.

[![EUPL Licence](https://img.shields.io/badge/Licence-EUPL%20v1.2-blue.svg)](https://eupl.eu/1.2/en)


## Licence

This software is shared using the [European Union Public Licence (EUPL) version 1.2](https://joinup.ec.europa.eu/collection/eupl/eupl-text-eupl-12).
