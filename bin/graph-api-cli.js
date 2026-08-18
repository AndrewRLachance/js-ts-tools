#!/usr/bin/env node
'use strict';
const fs = require("node:fs")
const path = require("node:path")

const {
  buildGraphs,
} = require("../dist/tools/graph-api");

const PROGRAM_NAME = "code-graph";

function printHelp() {
  console.log(`
Usage:
  ${PROGRAM_NAME} --source <glob> [options]

Required:
  --source <glob>                 Source glob. Can be repeated.

Options:
  --tsconfig <path>               Path to tsconfig.json.
  --exclude <substring>           Exclude paths containing substring. Can be repeated.

Graph targets:
  --structure                     Build structure forest.
  --call                          Build call graph.
  --owner-reference               Build owner reference graph.
  --definition-use                Build definition-use graph.
  --all                           Build all graph types.

Output:
  --pretty                        Pretty-print JSON output.
  --out <path>                    Write output to file instead of stdout.

Other:
  -h, --help                      Show this help message.

Examples:
  ${PROGRAM_NAME} \\
    --source "/home/ai-developer/development/js-edi/packages/**/*.ts" \\
    --tsconfig tsconfig.json \\
    --all \\
    --pretty

  ${PROGRAM_NAME} \\
    --source "src/**/*.ts" \\
    --exclude "node_modules" \\
    --exclude ".test.ts" \\
    --call \\
    --definition-use \\
    --out graph-output.json
`.trim());
}

function parseArgs(argv) {
  const options = {
    sourceGlob: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case "-h":
      case "--help": {
        printHelp();
        return;
      }

      case "--source": {
        const value = argv[++i];
        assertValue(arg, value);

        const current = Array.isArray(options.sourceGlob)
          ? options.sourceGlob
          : [options.sourceGlob];

        current.push(value);
        options.sourceGlob = current;
        break;
      }

      case "--tsconfig": {
        const value = argv[++i];
        assertValue(arg, value);
        options.tsConfigFilePath = value;
        break;
      }

      case "--exclude": {
        const value = argv[++i];
        assertValue(arg, value);

        options.excludePathIncludes ??= [];
        options.excludePathIncludes.push(value);
        break;
      }

      case "--structure": {
        options.includeStructureForest = true;
        break;
      }

      case "--call": {
        options.includeCallGraph = true;
        break;
      }

      case "--owner-reference":
      case "--owner-use": {
        options.includeOwnerReferenceGraph = true;
        break;
      }

      case "--definition-use": {
        options.includeDefinitionUseGraph = true;
        break;
      }

      case "--all": {
        options.includeStructureForest = true;
        options.includeCallGraph = true;
        options.includeOwnerReferenceGraph = true;
        options.includeDefinitionUseGraph = true;
        break;
      }

      case "--json": {
        options.toJson = true;
        break;
      }

      case "--pretty": {
        options.pretty = true;
        break;
      }

      case "--out": {
        const value = argv[++i];
        assertValue(arg, value);
        options.outputFilePath = value;
        break;
      }

      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  const sourceGlobArray = Array.isArray(options.sourceGlob)
    ? options.sourceGlob
    : [options.sourceGlob];

  if (sourceGlobArray.length === 0) {
    throw new Error(`Missing required argument: --source <glob>`);
  }

  options.sourceGlob =
    sourceGlobArray.length === 1
      ? sourceGlobArray[0]
      : sourceGlobArray;

  const hasAnyGraphTarget =
    options.includeStructureForest ||
    options.includeCallGraph ||
    options.includeOwnerReferenceGraph ||
    options.includeDefinitionUseGraph;

  if (!hasAnyGraphTarget) {
    throw new Error(
      `No graph target selected. Use --all, --call, --structure, --owner-reference, or --definition-use.`,
    );
  }

  return options;
}

function assertValue(
  flag,
  value,
) {
  if (!value || value.startsWith("-")) {
    throw new Error(`Expected value after ${flag}`);
  }
}

function writeOutput(output, outputFilePath) {
  const outputWithNewline = output.endsWith("\n") ? output : `${output}\n`;

  if (!outputFilePath) {
    process.stdout.write(outputWithNewline);
    return;
  }

  const resolvedOutputPath = path.resolve(outputFilePath);

  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, outputWithNewline, "utf8");
}

function stringifyResult(result, pretty) {
  return JSON.stringify(result, null, pretty ? 2 : 0);
}

function run(argv, graphBuilder = buildGraphs) {
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const {
    sourceGlob,
    tsConfigFilePath,
    excludePathIncludes,
    outputFilePath,
    pretty,
    ...targetOptions
  } = parseArgs(argv);

  const sourceOptions = {
    sourceGlob,
    tsConfigFilePath,
    excludePathIncludes,
  };

  // Maps and Sets used by the in-memory graph representation cannot be
  // meaningfully written by a CLI. Always request the JSON-safe form.
  const result = graphBuilder(sourceOptions, {
    ...targetOptions,
    toJson: true,
  });

  const output = stringifyResult(result, pretty);

  writeOutput(output, outputFilePath);
}

function main() {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(`${PROGRAM_NAME} error: ${message}`);
    console.error(`Run with --help for usage.`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  run,
  stringifyResult,
  writeOutput,
};
