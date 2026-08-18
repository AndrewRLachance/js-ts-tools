#!/usr/bin/env node
'use strict';
const path = require("path");

const {
  createFromJsonFile,
  extractStructure,
  structureToJson,
  writeStructureFile,
} = require("../dist/tools/create-project.js");

function printHelp() {
  console.log(`
Usage:
  create-project <structure.json> [output-directory]

Options:
  -h, --help
                  Show this help message.

  --extract <project-directory> [output.json]
                  Extract a JSON project structure from an existing directory.
                  If output.json is omitted, prints JSON to stdout.

Description:
  Creates directories and blank files from a JSON project structure.

Arguments:
  structure.json
                  Path to a JSON file describing the project structure.

  output-directory
                  Directory where the project structure will be created.
                  Defaults to the current working directory.

JSON format:
  Directories are represented by objects.
  Files are represented by strings, null, false, or any non-object value.

Example JSON:
  {
    "src": {
      "index.js": "",
      "utils": {
        "helpers.js": "",
        "constants.js": ""
      }
    },
    "tests": {
      "index.test.js": ""
    },
    "package.json": "",
    "README.md": ""
  }

Examples:
  create-project structure.json ./my-project
  create-project --extract ./my-project structure.json
`);
}

function runCli(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return 0;
  }

  if (args.includes("--extract")) {
    const extractIndex = args.indexOf("--extract");
    const projectDir = args[extractIndex + 1];
    const outputJsonPath = args[extractIndex + 2];

    if (!projectDir) {
      console.error("Error: Missing project directory after --extract.");
      console.error("Usage: create-project --extract <project-directory> [output.json]");
      return 1;
    }

    try {
      if (outputJsonPath) {
        const result = writeStructureFile(projectDir, outputJsonPath);
        console.log(`Project structure extracted to: ${result.outputPath}`);
      } else {
        const structure = extractStructure(projectDir);
        console.log(structureToJson(structure).trimEnd());
      }

      return 0;
    } catch (error) {
      console.error(`Failed to extract project structure: ${error.message}`);
      return 1;
    }
  }

  const jsonPath = args[0];
  const outputDir = args[1] || process.cwd();

  if (!jsonPath) {
    console.error("Error: Missing required argument <structure.json>.");
    console.error("Run with --help for usage information.");
    return 1;
  }

  try {
    const result = createFromJsonFile(jsonPath, outputDir);
    console.log(`Project structure created in: ${result.outputDir}`);
    return 0;
  } catch (error) {
    console.error(`Failed to create project structure: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli();
}

module.exports = {
  runCli,
};