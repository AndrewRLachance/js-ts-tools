#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  analyzeCodeImpact,
} = require("../dist/tools/code-impact");

const PROGRAM_NAME = "code-impact";
const DIRECTIONS = new Set(["incoming", "outgoing", "both"]);

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --source <glob> (--symbol <name> [--file <path>] | --file <path>) [options]

Sources:
  --source <glob>                 Source glob. Can be repeated. Required.
  --test-source <glob>            Optional test glob. Can be repeated.
  --tsconfig <path>               Default: tsconfig.json.
  --exclude <substring>           Exclude matching paths. Can be repeated.

Target:
  --symbol <name>                 Simple or qualified symbol name.
  --file <path>                   Target file or symbol disambiguator.

Traversal:
  --direction <direction>         incoming, outgoing, or both. Default: both.
  --max-depth <integer>           Default: 3.
  --max-nodes <integer>           Default: 200.

Output:
  --pretty                        Pretty-print JSON output.
  --out <path>                    Write output to a file instead of stdout.
  -h, --help                      Show this help message.

Examples:
  ${PROGRAM_NAME} \\
    --source "src/**/*.ts" \\
    --test-source "test/**/*.ts" \\
    --symbol OrderService.execute \\
    --pretty

  ${PROGRAM_NAME} --source "src/**/*.ts" --file src/orders.ts
`.trim());
}

function parseArgs(argv) {
  const options = {
    sourceGlob: [],
    testSourceGlob: [],
    excludePathIncludes: [],
    direction: "both",
    maxDepth: 3,
    maxNodes: 200,
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
      case "--direction": {
        const value = readStringValue(argv, ++index, arg);
        if (!DIRECTIONS.has(value)) {
          throw new Error(`Invalid direction: ${value}`);
        }
        options.direction = value;
        break;
      }
      case "--max-depth":
        options.maxDepth = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--max-nodes":
        options.maxNodes = readNonnegativeInteger(argv, ++index, arg);
        break;
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
  if (!options.symbol && !options.filePath) {
    throw new Error("Missing target: specify --symbol, --file, or both.");
  }

  options.sourceGlob = collapse(options.sourceGlob);
  if (options.testSourceGlob.length === 0) delete options.testSourceGlob;
  else options.testSourceGlob = collapse(options.testSourceGlob);
  if (options.excludePathIncludes.length === 0) delete options.excludePathIncludes;
  return options;
}

function collapse(values) {
  return values.length === 1 ? values[0] : values;
}

function assertUnset(current, flag) {
  if (current !== undefined) throw new Error(`${flag} may only be specified once.`);
}

function readStringValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected value after ${flag}`);
  }
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
  const text = output.endsWith("\n") ? output : `${output}\n`;
  if (!outputFilePath) {
    process.stdout.write(text);
    return;
  }
  const resolvedPath = path.resolve(outputFilePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(resolvedPath, text, "utf8");
}

function run(argv, analyzer = analyzeCodeImpact) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  const { pretty, outputFilePath, ...analysisOptions } = parsed;
  const report = analyzer(analysisOptions);
  writeOutput(JSON.stringify(report, null, pretty ? 2 : 0), outputFilePath);
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

module.exports = { parseArgs, run, writeOutput };
