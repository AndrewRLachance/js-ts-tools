#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createCodeSlice,
  formatCodeSlice,
} = require("../dist/tools/code-slice");

const PROGRAM_NAME = "code-slice";
const DIRECTIONS = new Set(["incoming", "outgoing", "both"]);
const FORMATS = new Set(["json", "markdown"]);

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --source <glob> (--symbol <name> [--file <path>] | --file <path> | --at <file:line[:column]>) [options]

Sources:
  --source <glob>                 Source glob. Can be repeated. Required.
  --test-source <glob>            Optional test glob. Can be repeated.
  --tsconfig <path>               Default: tsconfig.json.
  --exclude <substring>           Exclude matching paths. Can be repeated.

Target:
  --symbol <name>                 Simple or qualified symbol name.
  --file <path>                   File target or symbol disambiguator.
  --at <file:line[:column]>       Symbol or enclosing declaration at a location.

Traversal:
  --direction <direction>         incoming, outgoing, or both. Default: both.
  --max-depth <integer>           Default: 2.
  --max-nodes <integer>           Default: 50.

Output:
  --format <format>               json or markdown. Default: json.
  --pretty                        Pretty-print JSON output.
  --out <path>                    Write output to a file instead of stdout.
  -h, --help                      Show this help message.

Examples:
  ${PROGRAM_NAME} --source "src/**/*.ts" --symbol OrderService.execute --pretty
  ${PROGRAM_NAME} --source "src/**/*.ts" --at src/orders.ts:47 --format markdown
`.trim());
}

function parseArgs(argv) {
  const options = {
    sourceGlob: [],
    testSourceGlob: [],
    excludePathIncludes: [],
    direction: "both",
    maxDepth: 2,
    maxNodes: 50,
    format: "json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--source":
        options.sourceGlob.push(readStringValue(argv, ++index, arg));
        break;
      case "--test-source":
        options.testSourceGlob.push(readStringValue(argv, ++index, arg));
        break;
      case "--tsconfig":
        assertUnset(options.tsConfigFilePath, arg);
        options.tsConfigFilePath = readStringValue(argv, ++index, arg);
        break;
      case "--exclude":
        options.excludePathIncludes.push(readStringValue(argv, ++index, arg));
        break;
      case "--symbol":
        assertUnset(options.symbol, arg);
        options.symbol = readStringValue(argv, ++index, arg);
        break;
      case "--file":
        assertUnset(options.filePath, arg);
        options.filePath = readStringValue(argv, ++index, arg);
        break;
      case "--at":
        assertUnset(options.at, arg);
        options.at = parseLocation(readStringValue(argv, ++index, arg));
        break;
      case "--direction": {
        const value = readStringValue(argv, ++index, arg);
        if (!DIRECTIONS.has(value)) throw new Error(`Invalid direction: ${value}`);
        options.direction = value;
        break;
      }
      case "--max-depth":
        options.maxDepth = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--max-nodes":
        options.maxNodes = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--format": {
        const value = readStringValue(argv, ++index, arg);
        if (!FORMATS.has(value)) throw new Error(`Invalid format: ${value}`);
        options.format = value;
        break;
      }
      case "--pretty":
        options.pretty = true;
        break;
      case "--out":
        assertUnset(options.outputFilePath, arg);
        options.outputFilePath = readStringValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.sourceGlob.length === 0) {
    throw new Error("Missing required option: --source <glob>");
  }
  if (!options.symbol && !options.filePath && !options.at) {
    throw new Error("Missing target: specify --symbol, --file, or --at.");
  }
  if (options.at && (options.symbol || options.filePath)) {
    throw new Error("--at cannot be combined with --symbol or --file.");
  }
  if (options.pretty && options.format === "markdown") {
    throw new Error("--pretty is only supported with JSON output.");
  }

  options.sourceGlob = collapse(options.sourceGlob);
  if (options.testSourceGlob.length === 0) delete options.testSourceGlob;
  else options.testSourceGlob = collapse(options.testSourceGlob);
  if (options.excludePathIncludes.length === 0) delete options.excludePathIncludes;
  return options;
}

function parseLocation(value) {
  const match = value.match(/^(.*):(\d+):(\d+)$/) ?? value.match(/^(.*):(\d+)$/);
  if (!match || !match[1]) {
    throw new Error(`Invalid location: ${value}. Expected <file:line[:column]>.`);
  }
  const line = Number(match[2]);
  const column = match[3] === undefined ? undefined : Number(match[3]);
  if (!Number.isInteger(line) || line < 1 ||
    (column !== undefined && (!Number.isInteger(column) || column < 1))) {
    throw new Error(`Invalid location: ${value}. Line and column must be positive integers.`);
  }
  return { filePath: match[1], line, column };
}

function collapse(values) {
  return values.length === 1 ? values[0] : values;
}

function assertUnset(current, flag) {
  if (current !== undefined) throw new Error(`${flag} may only be specified once.`);
}

function readStringValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`Expected value after ${flag}`);
  return value;
}

function readNonnegativeInteger(argv, index, flag) {
  const raw = argv[index];
  if (raw === undefined || raw === "" || raw.startsWith("--") || raw === "-h") {
    throw new Error(`Expected numeric value after ${flag}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a nonnegative integer.`);
  }
  return value;
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

function run(argv, slicer = createCodeSlice, formatter = formatCodeSlice) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  const { format, pretty, outputFilePath, ...sliceOptions } = parsed;
  const report = slicer(sliceOptions);
  writeOutput(formatter(report, { format, pretty }), outputFilePath);
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

module.exports = { parseArgs, parseLocation, run, writeOutput };
