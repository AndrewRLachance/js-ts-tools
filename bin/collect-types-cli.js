#!/usr/bin/env node
"use strict";

const {
  collectAssociatedTypes,
} = require("../dist/collection/type-collector");
const {
  formatAssociatedTypes,
  saveAssociatedTypes,
} = require("../dist/collection/emit-collected");

const PROGRAM_NAME = "collect-types";
const GENERATED_BANNER = "/* Generated associated type closure. */";

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --name <declaration> --source <file> [options]

Required:
  --name <declaration>            Root declaration name. Can be repeated.
  --source <file>                 Declaration file or barrel containing the roots.

Options:
  --tsconfig <path>               Default: tsconfig.json.
  --exclude-node-modules          Exclude declarations supplied by dependencies.
  --include-typescript-libs       Include TypeScript lib.*.d.ts declarations.
  --out <path>                    Write output to a file instead of stdout.
  -h, --help                      Show this help message.

Example:
  ${PROGRAM_NAME} \\
    --name User \\
    --name UserId \\
    --source src/types.ts \\
    --out generated/user-types.ts
`.trim());
}

function parseArgs(argv) {
  const options = {
    names: [],
    tsConfigFilePath: "tsconfig.json",
    includeNodeModules: true,
    includeTypeScriptLibs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--name":
        options.names.push(readValue(argv, ++index, arg));
        break;
      case "--source":
        options.sourceFilePath = readValue(argv, ++index, arg);
        break;
      case "--tsconfig":
        options.tsConfigFilePath = readValue(argv, ++index, arg);
        break;
      case "--exclude-node-modules":
        options.includeNodeModules = false;
        break;
      case "--include-typescript-libs":
        options.includeTypeScriptLibs = true;
        break;
      case "--out":
        options.outputFilePath = readValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.names.length === 0) {
    throw new Error("Missing required option: --name <declaration>");
  }
  if (!options.sourceFilePath) {
    throw new Error("Missing required option: --source <file>");
  }

  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected value after ${flag}`);
  }
  return value;
}

async function run(argv, dependencies = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }

  const collect = dependencies.collectAssociatedTypes ?? collectAssociatedTypes;
  const format = dependencies.formatAssociatedTypes ?? formatAssociatedTypes;
  const save = dependencies.saveAssociatedTypes ?? saveAssociatedTypes;
  const { outputFilePath, ...collectorOptions } = parsed;
  const result = collect(collectorOptions);
  const formatOptions = { banner: GENERATED_BANNER };

  if (outputFilePath) {
    await save(result, outputFilePath, formatOptions);
    return;
  }

  process.stdout.write(format(result, formatOptions));
}

async function main() {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${PROGRAM_NAME} error: ${message}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = { GENERATED_BANNER, parseArgs, run };
