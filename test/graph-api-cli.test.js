"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseArgs,
  run,
  stringifyResult,
  writeOutput,
} = require("../bin/graph-api-cli");

test("parses repeated source and exclude options", () => {
  const options = parseArgs([
    "--source", "src/**/*.ts",
    "--source", "lib/**/*.ts",
    "--exclude", ".test.ts",
    "--call",
    "--pretty",
    "--out", "output/graph.json",
  ]);

  assert.deepEqual(options.sourceGlob, ["src/**/*.ts", "lib/**/*.ts"]);
  assert.deepEqual(options.excludePathIncludes, [".test.ts"]);
  assert.equal(options.includeCallGraph, true);
  assert.equal(options.pretty, true);
  assert.equal(options.outputFilePath, "output/graph.json");
});

test("uses --owner-reference and accepts --owner-use as a legacy alias", () => {
  const canonical = parseArgs([
    "--source", "src/**/*.ts",
    "--owner-reference",
  ]);
  const legacy = parseArgs([
    "--source", "src/**/*.ts",
    "--owner-use",
  ]);

  assert.equal(canonical.includeOwnerReferenceGraph, true);
  assert.equal(legacy.includeOwnerReferenceGraph, true);
});

test("rejects another option where a value is required", () => {
  assert.throws(
    () => parseArgs(["--source", "--call"]),
    /Expected value after --source/,
  );
  assert.throws(
    () => parseArgs(["--source", "src/*.ts", "--call", "--out", "-h"]),
    /Expected value after --out/,
  );
});

test("serializes compact and pretty JSON", () => {
  const result = { callGraph: [{ name: "main", calls: [] }] };

  assert.equal(
    stringifyResult(result, false),
    '{"callGraph":[{"name":"main","calls":[]}]}',
  );
  assert.match(stringifyResult(result, true), /\n  "callGraph":/);
});

test("writes valid JSON with a trailing newline and creates parent directories", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "code-graph-cli-"),
  );
  const outputPath = path.join(temporaryDirectory, "nested", "graph.json");

  writeOutput(stringifyResult({ callGraph: [] }, true), outputPath);

  const output = fs.readFileSync(outputPath, "utf8");
  assert.deepEqual(JSON.parse(output), { callGraph: [] });
  assert.equal(output.endsWith("\n"), true);
});

test("CLI requests JSON-safe graphs and writes JSON to --out without --json", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "code-graph-cli-integration-"),
  );
  const outputPath = path.join(temporaryDirectory, "graph.json");
  let receivedTargetOptions;

  run([
    "--source", "missing-source/**/*.ts",
    "--call",
    "--out", outputPath,
  ], (_sourceOptions, targetOptions) => {
    receivedTargetOptions = targetOptions;
    return { callGraph: [] };
  });

  const output = fs.readFileSync(outputPath, "utf8");
  assert.equal(receivedTargetOptions.toJson, true);
  assert.notEqual(output.trim(), "[object Object]");
  assert.deepEqual(JSON.parse(output).callGraph, []);
});
