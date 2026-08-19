#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { extractTypeModel } = require("../dist/tools/type-model");

const PROGRAM_NAME = "type-model";
const SCOPES = new Set(["exports", "all"]);

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --source <glob> [options]

Required:
  --source <glob>                 Source glob. Can be repeated.

Project:
  --tsconfig <path>               Default: tsconfig.json.
  --exclude <substring>           Exclude matching root files. Can be repeated.
  --scope <scope>                 exports or all. Default: exports.
  --include-call-sites            Include resolved call-like expressions in matched files.

Output:
  --pretty                        Pretty-print JSON output.
  --out <path>                    Write output to a file instead of stdout.
  -h, --help                      Show this help message.

Example:
  ${PROGRAM_NAME} \\
    --source "src/**/*.ts" \\
    --scope exports \\
    --pretty \\
    --out type-model.json
`.trim());
}

function parseArgs(argv) {
  const options = {
    sourceGlob: [],
    excludePathIncludes: [],
    scope: "exports",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--source":
        options.sourceGlob.push(readValue(argv, ++index, arg));
        break;
      case "--tsconfig":
        options.tsConfigFilePath = readValue(argv, ++index, arg);
        break;
      case "--exclude":
        options.excludePathIncludes.push(readValue(argv, ++index, arg));
        break;
      case "--scope": {
        const value = readValue(argv, ++index, arg);
        if (!SCOPES.has(value)) throw new Error(`Invalid scope: ${value}`);
        options.scope = value;
        break;
      }
      case "--pretty":
        options.pretty = true;
        break;
      case "--include-call-sites":
        options.includeCallSites = true;
        break;
      case "--out":
        options.outputFilePath = readValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.sourceGlob.length === 0) {
    throw new Error("Missing required option: --source <glob>");
  }
  options.sourceGlob = options.sourceGlob.length === 1
    ? options.sourceGlob[0]
    : options.sourceGlob;
  if (options.excludePathIncludes.length === 0) delete options.excludePathIncludes;
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected value after ${flag}`);
  }
  return value;
}

function stringifyResult(result, pretty) {
  return `${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`;
}

function writeOutput(output, outputFilePath) {
  if (!outputFilePath) {
    process.stdout.write(output);
    return;
  }
  const resolvedPath = path.resolve(outputFilePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, output, "utf8");
}

function run(argv, extractor = extractTypeModel) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  const { pretty, outputFilePath, ...extractOptions } = parsed;
  const result = extractor(extractOptions);
  writeOutput(stringifyResult(result, pretty), outputFilePath);
}

function main() {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${PROGRAM_NAME} error: ${message}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, run, stringifyResult, writeOutput };
