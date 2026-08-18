"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseArgs,
  run,
} = require("../bin/code-patterns-cli");
const {
  detectPatternsFromSources,
} = require("../dist/tools/code-patterns");

test("code-patterns parses selection, filtering, and tuning options", () => {
  const options = parseArgs([
    "--source", "src/**/*.ts",
    "--source", "packages/**/*.ts",
    "--tsconfig", "config/tsconfig.json",
    "--exclude", ".generated.ts",
    "--include-tests",
    "--include-declarations",
    "--pattern", "repository",
    "--pattern", "pattern.service",
    "--min-confidence", "medium",
    "--graph-max-depth", "3",
    "--graph-max-records", "75",
    "--graph-score-cap", "6.5",
    "--call-max-depth", "4",
    "--call-max-calls", "80",
    "--call-score-cap", "5.5",
    "--confidence-low", "2",
    "--confidence-medium", "5",
    "--confidence-high", "9",
    "--pretty",
    "--out", "patterns.json",
  ]);

  assert.deepEqual(options.sourceGlob, ["src/**/*.ts", "packages/**/*.ts"]);
  assert.deepEqual(options.patterns, ["pattern.repository", "pattern.service"]);
  assert.equal(options.minConfidence, "medium");
  assert.equal(options.config.includeTestFiles, true);
  assert.equal(options.config.includeDeclarationFiles, true);
  assert.equal(options.config.graphMaxDepth, 3);
  assert.equal(options.config.graphMaxRecordsPerTraversal, 75);
  assert.equal(options.config.graphScoreCapPerPattern, 6.5);
  assert.equal(options.config.callGraphMaxDepth, 4);
  assert.equal(options.config.callGraphMaxCallsPerTraversal, 80);
  assert.equal(options.config.callGraphScoreCapPerPattern, 5.5);
  assert.deepEqual(options.config.confidenceThresholds, {
    low: 2,
    medium: 5,
    high: 9,
  });
});

test("code-patterns rejects missing and malformed options", () => {
  assert.throws(() => parseArgs([]), /Missing required option: --source/);
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--pattern", "not-real"]),
    /Unknown pattern key/,
  );
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--min-confidence", "certain"]),
    /Invalid confidence level/,
  );
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--graph-max-depth", "1.5"]),
    /nonnegative integer/,
  );
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--call-score-cap", "-1"]),
    /nonnegative number/,
  );
  assert.throws(
    () => parseArgs([
      "--source", "src/**/*.ts",
      "--confidence-low", "5",
      "--confidence-medium", "4",
    ]),
    /low <= medium <= high/,
  );
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--unknown"]),
    /Unknown argument/,
  );
});

test("code-patterns writes filtered, pretty JSON through --out", () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "code-patterns-output-"),
  );
  const outputPath = path.join(temporaryDirectory, "nested", "patterns.json");
  let receivedOptions;

  run([
    "--source", "src/**/*.ts",
    "--pattern", "service",
    "--pretty",
    "--out", outputPath,
  ], (options) => {
    receivedOptions = options;
    return [{ pattern: "pattern.service", confidence: "medium" }];
  });

  const output = fs.readFileSync(outputPath, "utf8");
  assert.deepEqual(receivedOptions.patterns, ["pattern.service"]);
  assert.deepEqual(JSON.parse(output), [
    { pattern: "pattern.service", confidence: "medium" },
  ]);
  assert.match(output, /\n  \{/);
  assert.equal(output.endsWith("\n"), true);
});

test("code-patterns writes compact JSON to stdout by default", () => {
  const output = captureStdout(() => run([
    "--source", "src/**/*.ts",
  ], () => []));

  assert.equal(output, "[]\n");
});

test("code-patterns builds graphs and honors source exclusions and test filtering", () => {
  const fixture = createPatternFixture();
  const commonOptions = {
    sourceGlob: path.join(fixture, "src/**/*.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    excludePathIncludes: ["/excluded/"],
    patterns: ["pattern.service"],
  };

  const normal = detectPatternsFromSources(commonOptions);
  assert.equal(normal.some((item) => item.nodeName === "UserService"), true);
  assert.equal(normal.some((item) => item.nodeName === "IgnoredService"), false);
  assert.equal(normal.some((item) => item.nodeName === "TestService"), false);

  const withTests = detectPatternsFromSources({
    ...commonOptions,
    config: { includeTestFiles: true },
  });
  assert.equal(withTests.some((item) => item.nodeName === "TestService"), true);

  const withDeclarations = detectPatternsFromSources({
    ...commonOptions,
    patterns: ["pattern.interface_based"],
    config: { includeDeclarationFiles: true },
  });
  assert.equal(
    withDeclarations.some((item) => item.nodeName === "AuditRepository"),
    true,
  );

  const highOnly = detectPatternsFromSources({
    ...commonOptions,
    minConfidence: "high",
  });
  assert.equal(highOnly.every((item) => item.confidence === "high"), true);
});

test("code-patterns rejects source globs with no matches", () => {
  const fixture = createPatternFixture();
  assert.throws(
    () => detectPatternsFromSources({
      sourceGlob: path.join(fixture, "missing/**/*.ts"),
      tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    }),
    /No source files matched/,
  );
});

function createPatternFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-patterns-fixture-"));
  fs.mkdirSync(path.join(root, "src", "excluded"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
    },
    include: ["src/**/*.ts"],
  }));
  fs.writeFileSync(path.join(root, "src", "UserService.ts"), `
export class UserService {
  execute(): string { return "ok"; }
}
`);
  fs.writeFileSync(path.join(root, "src", "UserService.test.ts"), `
export class TestService {
  execute(): string { return "test"; }
}
`);
  fs.writeFileSync(path.join(root, "src", "excluded", "IgnoredService.ts"), `
export class IgnoredService {
  execute(): string { return "ignored"; }
}
`);
  fs.writeFileSync(path.join(root, "src", "contracts.d.ts"), `
export interface AuditRepository {
  save(value: string): Promise<void>;
}
`);
  return root;
}

function captureStdout(callback) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    callback();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
