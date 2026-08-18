#!/usr/bin/env node
'use strict';
const { once } = require("node:events");
const { applyJSPathToFilesStream } = require("../dist/tools/json-jspath.js");

function printUsage() {
  console.error(`
Usage:
  json-jspath <file-pattern> <jspath-expression> [options]

Arguments:
  file-pattern          Glob/path pattern for JSON files
  jspath-expression     JSPath expression to apply to each JSON document

Options:
  --pretty              Pretty-print JSON output
  --ndjson              Print one JSON result per line
  --jsonl               Alias for --ndjson
  --json-lines          Alias for --ndjson
  --with-file           Include source filename with each result
  --first               Print only the first JSPath match per file
  --fail-empty          Exit with code 2 if no JSPath matches are found
  --continue-on-error   Keep processing files after JSON/file errors
  -h, --help            Show help

Examples:
  json-jspath "data/*.json" ".users"
  json-jspath "data/**/*.json" ".users{.active === true}"
  json-jspath "data/**/*.json" ".orders.items{.price > 20}" --pretty
  json-jspath "data/**/*.json" ".name" --ndjson --with-file
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes("-h") || args.includes("--help")) {
    return { help: true };
  }

  const options = {
    pretty: false,
    ndjson: false,
    withFile: false,
    first: false,
    failEmpty: false,
    continueOnError: false
  };

  const positional = [];

  for (const arg of args) {
    switch (arg) {
      case "--pretty":
        options.pretty = true;
        break;
      case "--ndjson":
      case "--jsonl":
      case "--json-lines":
        options.ndjson = true;
        break;
      case "--with-file":
        options.withFile = true;
        break;
      case "--first":
        options.first = true;
        break;
      case "--fail-empty":
        options.failEmpty = true;
        break;
      case "--continue-on-error":
        options.continueOnError = true;
        break;
      default:
        positional.push(arg);
    }
  }

  if (positional.length < 2) {
    return { error: "Missing required arguments." };
  }

  if (positional.length > 2) {
    return {
      error:
        "Too many positional arguments. Quote your file pattern and JSPath expression."
    };
  }

  return {
    filePattern: positional[0],
    expression: positional[1],
    options
  };
}

async function writeStdout(text) {
  if (!process.stdout.write(text)) {
    await once(process.stdout, "drain");
  }
}

function stringifyJson(value, pretty) {
  const json = JSON.stringify(value, null, pretty ? 2 : 0);

  if (json === undefined) {
    throw new Error("Cannot serialize result as JSON.");
  }

  return json;
}

async function writeNdjsonResult(result) {
  await writeStdout(`${stringifyJson(result, false)}\n`);
}

async function writeJsonArrayStart(pretty) {
  await writeStdout(pretty ? "[\n" : "[");
}

async function writeJsonArrayResult(result, index, pretty) {
  const json = stringifyJson(result, pretty);

  if (pretty) {
    const indented = json
      .split("\n")
      .map(line => `  ${line}`)
      .join("\n");

    await writeStdout(`${index === 0 ? "" : ",\n"}${indented}`);
  } else {
    await writeStdout(`${index === 0 ? "" : ","}${json}`);
  }
}

async function writeJsonArrayEnd(count, pretty) {
  if (pretty) {
    await writeStdout(count > 0 ? "\n]\n" : "]\n");
  } else {
    await writeStdout("]\n");
  }
}

async function main() {
  const parsed = parseArgs(process.argv);

  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    printUsage();
    process.exit(1);
  }

  const { filePattern, expression, options } = parsed;

  let count = 0;
  let errorCount = 0;
  let jsonArrayStarted = false;
  let jsonArrayClosed = false;

  const onError = async item => {
    errorCount += 1;
    console.error(`${item.file}: ${item.error.message}`);
  };

  try {
    if (!options.ndjson) {
      await writeJsonArrayStart(options.pretty);
      jsonArrayStarted = true;
    }

    for await (const result of applyJSPathToFilesStream(filePattern, expression, {
      withFile: options.withFile,
      first: options.first,
      continueOnError: options.continueOnError,
      onError
    })) {
      if (options.ndjson) {
        await writeNdjsonResult(result);
      } else {
        await writeJsonArrayResult(result, count, options.pretty);
      }

      count += 1;
    }

    if (!options.ndjson) {
      await writeJsonArrayEnd(count, options.pretty);
      jsonArrayClosed = true;
    }

    if (options.failEmpty && count === 0) {
      console.error("No JSPath matches found.");
      process.exit(2);
    }

    if (errorCount > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (jsonArrayStarted && !jsonArrayClosed) {
      try {
        await writeJsonArrayEnd(count, options.pretty);
      } catch {
        // Ignore close-output failure; original error is more important.
      }
    }

    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});