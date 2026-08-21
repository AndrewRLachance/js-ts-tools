#!/usr/bin/env node
"use strict";

const path = require("node:path");
const {
  searchGitHubPackageImports,
} = require("../dist/tools/github-js-ts-search");

const PROGRAM_NAME = "github-js-ts-search";

function printHelp(stream = process.stdout) {
  stream.write(`${`
Usage:
  ${PROGRAM_NAME} [--out <directory>] <package> [package ...]

Arguments:
  <package>                      npm package name. May be repeated.

Output:
  --out <directory>             Output root. Defaults to OUT_DIR, then downloads.
  -h, --help                    Show this help message.

Authentication:
  Set GITHUB_TOKEN to a GitHub access token.

Example:
  ${PROGRAM_NAME} --out corpus lodash @tanstack/react-query
`.trim()}\n`);
}

function parseArgs(argv) {
  const packages = [];
  let outputDirectory;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "-h":
      case "--help":
        return { help: true };
      case "--out": {
        if (outputDirectory !== undefined) {
          throw new Error("--out may only be specified once.");
        }
        const value = argv[++index];
        if (!value || value.startsWith("--")) {
          throw new Error("Expected a directory after --out.");
        }
        outputDirectory = value;
        break;
      }
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        packages.push(arg);
    }
  }

  if (packages.length === 0) {
    throw new Error("At least one package name is required.");
  }
  return { packages, outputDirectory };
}

async function run(argv, dependencies = {}) {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const search = dependencies.search ?? searchGitHubPackageImports;
  const parsed = parseArgs(argv);

  if (parsed.help) {
    printHelp(stdout);
    return undefined;
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_TOKEN.trim()) {
    throw new Error("Set GITHUB_TOKEN to a GitHub access token.");
  }

  const outputDirectory = parsed.outputDirectory ?? env.OUT_DIR ?? "downloads";
  stderr.write(`Searching GitHub for ${parsed.packages.join(", ")}...\n`);
  const report = await search({
    packages: parsed.packages,
    token: env.GITHUB_TOKEN,
    outputDirectory,
  });

  for (const match of report.matches) {
    stdout.write(`${path.join(report.outputDirectory, match.outputPath)}\n`);
  }
  for (const query of report.queries) {
    if (!query.incomplete && !query.truncated) continue;
    const reasons = [
      query.truncated ? "truncated at GitHub's result limit" : undefined,
      query.incomplete ? "reported incomplete by GitHub" : undefined,
    ].filter(Boolean);
    stderr.write(
      `Warning: ${query.packageName} *.${query.extension} ${reasons.join(" and ")}.\n`,
    );
  }
  stderr.write(
    `Saved ${report.savedFileCount} matching file${report.savedFileCount === 1 ? "" : "s"}; manifest: ${report.manifestPath}\n`,
  );
  return report;
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

module.exports = { main, parseArgs, printHelp, run };
