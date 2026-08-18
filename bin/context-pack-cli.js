#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  createContextPack,
  formatContextPack,
} = require("../dist/tools/context-pack");

const PROGRAM_NAME = "context-pack";
const DIRECTIONS = new Set(["incoming", "outgoing", "both"]);
const FORMATS = new Set(["markdown", "json"]);

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --source <glob> (--task <text> | --task-file <path>) [options]

Sources:
  --source <glob>                 Source glob. Can be repeated. Required.
  --test-source <glob>            Optional test glob. Can be repeated.
  --tsconfig <path>               Default: tsconfig.json.
  --exclude <substring>           Exclude matching paths. Can be repeated.

Explicit context:
  --symbol <name>                 Symbol seed. Can be repeated.
  --in <path>                     Disambiguate the immediately preceding symbol.
  --file <path>                   File-wide seed. Can be repeated.
  --at <file:line[:column]>       Location seed. Can be repeated.
  --doc <glob>                    Additional documentation glob. Can be repeated.
  --config <path>                 Additional configuration file. Can be repeated.

Selection:
  --max-seeds <integer>           Maximum automatic seeds. Default: 5.
  --direction <direction>         incoming, outgoing, or both. Default: both.
  --max-depth <integer>           Default: 2.
  --max-nodes <integer>           Default: 100.
  --max-tokens <integer>          Default: 12000.

Output:
  --format <format>               markdown or json. Default: markdown.
  --pretty                        Pretty-print JSON output.
  --out <path>                    Write output to a file instead of stdout.
  -h, --help                      Show this help message.

Examples:
  ${PROGRAM_NAME} --source "src/**/*.ts" --task "repair invoice calculation"
  ${PROGRAM_NAME} --source "src/**/*.ts" --task-file task.md --symbol calculateInvoice --format json --pretty
`.trim());
}

function parseArgs(argv) {
  const options = {
    sourceGlob: [],
    testSourceGlob: [],
    excludePathIncludes: [],
    seeds: [],
    docGlobs: [],
    configFilePaths: [],
    maxSeeds: 5,
    direction: "both",
    maxDepth: 2,
    maxNodes: 100,
    maxTokens: 12000,
    format: "markdown",
  };
  let pendingSymbolIndex;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--in") pendingSymbolIndex = undefined;
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
      case "--task":
        assertUnset(options.task, arg);
        options.task = readStringValue(argv, ++index, arg);
        break;
      case "--task-file":
        assertUnset(options.taskFilePath, arg);
        options.taskFilePath = readStringValue(argv, ++index, arg);
        break;
      case "--symbol": {
        const symbol = readStringValue(argv, ++index, arg);
        options.seeds.push({ kind: "symbol", symbol });
        pendingSymbolIndex = options.seeds.length - 1;
        break;
      }
      case "--in": {
        if (pendingSymbolIndex === undefined) {
          throw new Error("--in must immediately follow a --symbol option.");
        }
        const seed = options.seeds[pendingSymbolIndex];
        if (seed.filePath !== undefined) throw new Error("A symbol may only have one --in path.");
        seed.filePath = readStringValue(argv, ++index, arg);
        pendingSymbolIndex = undefined;
        break;
      }
      case "--file":
        options.seeds.push({ kind: "file", filePath: readStringValue(argv, ++index, arg) });
        break;
      case "--at":
        options.seeds.push({ kind: "location", location: parseLocation(readStringValue(argv, ++index, arg)) });
        break;
      case "--doc":
        options.docGlobs.push(readStringValue(argv, ++index, arg));
        break;
      case "--config":
        options.configFilePaths.push(readStringValue(argv, ++index, arg));
        break;
      case "--max-seeds":
        options.maxSeeds = readNonnegativeInteger(argv, ++index, arg);
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
      case "--max-tokens":
        options.maxTokens = readPositiveInteger(argv, ++index, arg);
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
  if (!options.task && !options.taskFilePath) {
    throw new Error("Missing task: specify --task or --task-file.");
  }
  if (options.task && options.taskFilePath) {
    throw new Error("--task and --task-file are mutually exclusive.");
  }
  if (options.pretty && options.format === "markdown") {
    throw new Error("--pretty is only supported with JSON output.");
  }

  options.sourceGlob = collapse(options.sourceGlob);
  if (options.testSourceGlob.length === 0) delete options.testSourceGlob;
  else options.testSourceGlob = collapse(options.testSourceGlob);
  if (options.excludePathIncludes.length === 0) delete options.excludePathIncludes;
  if (options.seeds.length === 0) delete options.seeds;
  if (options.docGlobs.length === 0) delete options.docGlobs;
  if (options.configFilePaths.length === 0) delete options.configFilePaths;
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

function readPositiveInteger(argv, index, flag) {
  const value = readNonnegativeInteger(argv, index, flag);
  if (value === 0) throw new Error(`${flag} must be greater than zero.`);
  return value;
}

function readTaskFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  let contents;
  try {
    contents = fs.readFileSync(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read task file ${resolvedPath}: ${message}`);
  }
  if (contents.includes(0)) throw new Error(`Task file is binary: ${resolvedPath}`);
  const task = contents.toString("utf8").trim();
  if (!task) throw new Error(`Task file is empty: ${resolvedPath}`);
  return task;
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

function run(argv, creator = createContextPack, formatter = formatContextPack) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }
  const { format, pretty, outputFilePath, ...packOptions } = parsed;
  if (packOptions.taskFilePath) packOptions.task = readTaskFile(packOptions.taskFilePath);
  const report = creator(packOptions);
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

module.exports = { parseArgs, parseLocation, readTaskFile, run, writeOutput };
