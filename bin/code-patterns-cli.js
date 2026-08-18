#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  detectPatternsFromSources,
  patternKeys,
} = require("../dist/tools/code-patterns");
const {
  defaultPatternDetectorConfig,
} = require("../dist/patterns/pattern-core");

const PROGRAM_NAME = "code-patterns";
const CONFIDENCE_LEVELS = new Set(["low", "medium", "high"]);
const PATTERN_KEYS = new Set(patternKeys);

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --source <glob> [options]

Required:
  --source <glob>                 Source glob. Can be repeated.

Project:
  --tsconfig <path>               Default: tsconfig.json.
  --exclude <substring>           Exclude matching paths. Can be repeated.
  --include-tests                 Include test and mock files.
  --include-declarations          Include .d.ts files.

Filtering:
  --pattern <key>                 Pattern key, with or without "pattern.". Repeatable.
  --min-confidence <level>        low, medium, or high. Default: low.

Detector tuning:
  --graph-max-depth <integer>
  --graph-max-records <integer>
  --graph-score-cap <number>
  --call-max-depth <integer>
  --call-max-calls <integer>
  --call-score-cap <number>
  --confidence-low <number>
  --confidence-medium <number>
  --confidence-high <number>

Output:
  --pretty                        Pretty-print JSON output.
  --out <path>                    Write output to a file instead of stdout.
  -h, --help                      Show this help message.

Example:
  ${PROGRAM_NAME} \\
    --source "src/**/*.ts" \\
    --pattern repository \\
    --min-confidence medium \\
    --pretty
`.trim());
}

function parseArgs(argv) {
  const options = {
    sourceGlob: [],
    excludePathIncludes: [],
    patterns: [],
    minConfidence: "low",
    config: {
      confidenceThresholds: {},
    },
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
      case "--tsconfig":
        options.tsConfigFilePath = readStringValue(argv, ++index, arg);
        break;
      case "--exclude":
        options.excludePathIncludes.push(readStringValue(argv, ++index, arg));
        break;
      case "--include-tests":
        options.config.includeTestFiles = true;
        break;
      case "--include-declarations":
        options.config.includeDeclarationFiles = true;
        break;
      case "--pattern": {
        const value = readStringValue(argv, ++index, arg);
        const key = value.startsWith("pattern.") ? value : `pattern.${value}`;
        if (!PATTERN_KEYS.has(key)) {
          throw new Error(`Unknown pattern key: ${value}`);
        }
        options.patterns.push(key);
        break;
      }
      case "--min-confidence": {
        const value = readStringValue(argv, ++index, arg);
        if (!CONFIDENCE_LEVELS.has(value)) {
          throw new Error(`Invalid confidence level: ${value}`);
        }
        options.minConfidence = value;
        break;
      }
      case "--graph-max-depth":
        options.config.graphMaxDepth = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--graph-max-records":
        options.config.graphMaxRecordsPerTraversal = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--graph-score-cap":
        options.config.graphScoreCapPerPattern = readNonnegativeNumber(argv, ++index, arg);
        break;
      case "--call-max-depth":
        options.config.callGraphMaxDepth = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--call-max-calls":
        options.config.callGraphMaxCallsPerTraversal = readNonnegativeInteger(argv, ++index, arg);
        break;
      case "--call-score-cap":
        options.config.callGraphScoreCapPerPattern = readNonnegativeNumber(argv, ++index, arg);
        break;
      case "--confidence-low":
        options.config.confidenceThresholds.low = readNonnegativeNumber(argv, ++index, arg);
        break;
      case "--confidence-medium":
        options.config.confidenceThresholds.medium = readNonnegativeNumber(argv, ++index, arg);
        break;
      case "--confidence-high":
        options.config.confidenceThresholds.high = readNonnegativeNumber(argv, ++index, arg);
        break;
      case "--pretty":
        options.pretty = true;
        break;
      case "--out":
        options.outputFilePath = readStringValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.sourceGlob.length === 0) {
    throw new Error("Missing required option: --source <glob>");
  }

  const thresholds = {
    ...defaultPatternDetectorConfig.confidenceThresholds,
    ...options.config.confidenceThresholds,
  };
  if (!(thresholds.low <= thresholds.medium && thresholds.medium <= thresholds.high)) {
    throw new Error("Confidence thresholds must satisfy low <= medium <= high.");
  }

  options.config.confidenceThresholds = thresholds;
  options.sourceGlob = options.sourceGlob.length === 1
    ? options.sourceGlob[0]
    : options.sourceGlob;
  if (options.excludePathIncludes.length === 0) {
    delete options.excludePathIncludes;
  }
  if (options.patterns.length === 0) {
    delete options.patterns;
  }

  return options;
}

function readStringValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected value after ${flag}`);
  }
  return value;
}

function readNumericValue(argv, index, flag) {
  const raw = argv[index];
  if (raw === undefined || raw === "" || raw.startsWith("--") || raw === "-h") {
    throw new Error(`Expected numeric value after ${flag}`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a nonnegative number.`);
  }
  return value;
}

function readNonnegativeNumber(argv, index, flag) {
  return readNumericValue(argv, index, flag);
}

function readNonnegativeInteger(argv, index, flag) {
  const value = readNumericValue(argv, index, flag);
  if (!Number.isInteger(value)) {
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

function run(argv, detector = detectPatternsFromSources) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printHelp();
    return;
  }

  const { pretty, outputFilePath, ...detectorOptions } = parsed;
  const detections = detector(detectorOptions);
  writeOutput(JSON.stringify(detections, null, pretty ? 2 : 0), outputFilePath);
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

if (require.main === module) {
  main();
}

module.exports = { parseArgs, run, writeOutput };
