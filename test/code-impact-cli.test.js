"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseArgs,
  run,
} = require("../bin/code-impact-cli");
const {
  analyzeCodeImpact,
} = require("../dist/tools/code-impact");
const {
  buildDefinitionUseGraph,
} = require("../dist/graphs/definition-use-graph");

test("code-impact parses sources, target, traversal, and output options", () => {
  const options = parseArgs([
    "--source", "src/**/*.ts",
    "--source", "packages/**/*.ts",
    "--test-source", "test/**/*.ts",
    "--tsconfig", "config/tsconfig.json",
    "--exclude", ".generated.ts",
    "--symbol", "OrderService.execute",
    "--file", "src/service.ts",
    "--direction", "incoming",
    "--max-depth", "4",
    "--max-nodes", "75",
    "--pretty",
    "--out", "impact.json",
  ]);

  assert.deepEqual(options.sourceGlob, ["src/**/*.ts", "packages/**/*.ts"]);
  assert.equal(options.testSourceGlob, "test/**/*.ts");
  assert.equal(options.symbol, "OrderService.execute");
  assert.equal(options.filePath, "src/service.ts");
  assert.equal(options.direction, "incoming");
  assert.equal(options.maxDepth, 4);
  assert.equal(options.maxNodes, 75);
});

test("code-impact rejects missing, duplicate, unknown, and malformed options", () => {
  assert.throws(() => parseArgs([]), /Missing required option: --source/);
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts"]),
    /Missing target/,
  );
  assert.throws(
    () => parseArgs([
      "--source", "src/**/*.ts",
      "--symbol", "one",
      "--symbol", "two",
    ]),
    /may only be specified once/,
  );
  assert.throws(
    () => parseArgs([
      "--source", "src/**/*.ts",
      "--symbol", "one",
      "--direction", "sideways",
    ]),
    /Invalid direction/,
  );
  assert.throws(
    () => parseArgs([
      "--source", "src/**/*.ts",
      "--symbol", "one",
      "--max-depth", "1.5",
    ]),
    /nonnegative integer/,
  );
  assert.throws(
    () => parseArgs([
      "--source", "src/**/*.ts",
      "--symbol", "one",
      "--unknown",
    ]),
    /Unknown argument/,
  );
});

test("code-impact writes compact stdout and pretty file JSON", () => {
  const report = emptyReport();
  const stdout = captureStdout(() => run([
    "--source", "src/**/*.ts",
    "--symbol", "run",
  ], () => report));
  assert.equal(stdout, `${JSON.stringify(report)}\n`);

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "code-impact-output-"),
  );
  const outputPath = path.join(temporaryDirectory, "nested", "impact.json");
  run([
    "--source", "src/**/*.ts",
    "--symbol", "run",
    "--pretty",
    "--out", outputPath,
  ], () => report);
  const output = fs.readFileSync(outputPath, "utf8");
  assert.deepEqual(JSON.parse(output), report);
  assert.match(output, /\n  "query"/);
  assert.equal(output.endsWith("\n"), true);
});

test("code-impact traverses calls and references in both directions", () => {
  const fixture = createImpactFixture();
  const report = analyzeCodeImpact(baseOptions(fixture, {
    symbol: "OrderService.execute",
  }));

  assert.equal(report.targets.length, 1);
  assert.equal(report.targets[0].qualifiedName, "OrderService.execute");
  assert.equal(hasImpact(report, "handle", "incoming"), true);
  assert.equal(hasImpact(report, "testOrder", "incoming"), true);
  assert.equal(hasImpact(report, "loadOrder", "outgoing"), true);
  assert.equal(report.impactedTests.some((item) => item.name === "testOrder"), true);
  assert.equal(
    report.impacted.every((item) =>
      item.paths.every((impactPath) => impactPath.steps.length === impactPath.distance),
    ),
    true,
  );
});

test("code-impact incorporates initializer, assignment, and read flow", () => {
  const fixture = createImpactFixture();
  const report = analyzeCodeImpact(baseOptions(fixture, {
    symbol: "result",
    filePath: path.join(fixture, "src", "service.ts"),
    maxDepth: 2,
  }));

  const relations = new Set(report.impacted.flatMap((item) => item.relations));
  assert.equal(relations.has("reads"), true);
  assert.equal(relations.has("assigned_from"), true);
  assert.equal(
    report.impacted.some((item) => item.qualifiedName.endsWith(".raw")),
    true,
  );
});

test("definition-use repair preserves text fields and adds stable metadata", () => {
  const fixture = createImpactFixture();
  const graph = buildDefinitionUseGraph({
    sourceGlob: path.join(fixture, "src/**/*.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
  });
  const result = [...graph.values()].find((record) => record.name === "result");

  assert.equal(result.initializer.definedBy, "raw");
  assert.deepEqual(result.initializer.dependsOn, ["raw"]);
  assert.equal(result.initializer.dependencyIds.length, 1);
  assert.equal(result.assignments[0].definedBy, "formatOrder(result)");
  assert.equal(result.assignments[0].dependencyIds.length >= 1, true);
  assert.equal(result.ownerId.includes("OrderService.execute"), true);
  assert.equal(result.readSites.some((site) => site.text === "result"), true);
});

test("code-impact supports file-wide targets", () => {
  const fixture = createImpactFixture();
  const targetFile = path.join(fixture, "src", "repository.ts");
  const report = analyzeCodeImpact(baseOptions(fixture, {
    filePath: targetFile,
    direction: "incoming",
  }));

  assert.equal(report.targets.length > 0, true);
  assert.equal(report.targets.every((item) => item.filePath === targetFile), true);
  assert.equal(report.impacted.some((item) => item.qualifiedName === "OrderService.execute"), true);
});

test("code-impact reports ambiguity and supports file disambiguation", () => {
  const fixture = createImpactFixture();
  assert.throws(
    () => analyzeCodeImpact(baseOptions(fixture, { symbol: "save" })),
    /ambiguous.*Candidates:/i,
  );

  const report = analyzeCodeImpact(baseOptions(fixture, {
    symbol: "save",
    filePath: path.join(fixture, "src", "first.ts"),
  }));
  assert.equal(report.targets.length, 1);
  assert.equal(report.targets[0].filePath.endsWith("first.ts"), true);
});

test("code-impact treats overload declarations as one logical target", () => {
  const fixture = createImpactFixture();
  const report = analyzeCodeImpact(baseOptions(fixture, {
    symbol: "overloaded",
  }));
  assert.equal(report.summary.targetCount, 1);
});

test("code-impact returns an empty successful cone for an unused target", () => {
  const fixture = createImpactFixture();
  const report = analyzeCodeImpact(baseOptions(fixture, {
    symbol: "save",
    filePath: path.join(fixture, "src", "first.ts"),
  }));
  assert.deepEqual(report.impacted, []);
  assert.deepEqual(report.impactedTests, []);
  assert.equal(report.summary.truncated, false);
});

test("code-impact includes direct external leaves without traversing them", () => {
  const fixture = createImpactFixture();
  const report = analyzeCodeImpact(baseOptions(fixture, {
    symbol: "serialize",
    direction: "outgoing",
  }));
  const external = report.impacted.filter((item) => item.external);
  assert.equal(external.length > 0, true);
  assert.equal(external.every((item) => item.distance === 1), true);
});

test("code-impact enforces bounds deterministically and reports truncation", () => {
  const fixture = createImpactFixture();
  const options = baseOptions(fixture, {
    symbol: "OrderService.execute",
    maxDepth: 3,
    maxNodes: 1,
  });
  const first = analyzeCodeImpact(options);
  const second = analyzeCodeImpact(options);
  assert.equal(first.summary.impactedCount, 1);
  assert.equal(first.summary.truncated, true);
  assert.deepEqual(first, second);
});

test("code-impact rejects missing sources, targets, and unmatched files", () => {
  const fixture = createImpactFixture();
  assert.throws(
    () => analyzeCodeImpact(baseOptions(fixture, {
      sourceGlob: path.join(fixture, "missing/**/*.ts"),
      symbol: "run",
    })),
    /No files matched source glob/,
  );
  assert.throws(
    () => analyzeCodeImpact(baseOptions(fixture, { symbol: "Missing" })),
    /Could not find symbol/,
  );
  assert.throws(
    () => analyzeCodeImpact(baseOptions(fixture, {
      filePath: path.join(fixture, "not-selected.ts"),
    })),
    /not part of the selected sources/,
  );
});

function hasImpact(report, name, direction) {
  return report.impacted.some(
    (item) => item.name === name && item.directions.includes(direction),
  );
}

function baseOptions(fixture, overrides) {
  return {
    sourceGlob: path.join(fixture, "src/**/*.ts"),
    testSourceGlob: path.join(fixture, "test/**/*.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    ...overrides,
  };
}

function createImpactFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-impact-fixture-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
    },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }));
  fs.writeFileSync(path.join(root, "src", "repository.ts"), `
export function loadOrder(id: string): string { return id; }
`);
  fs.writeFileSync(path.join(root, "src", "service.ts"), `
import { loadOrder } from "./repository";
export function formatOrder(value: string): string { return value.trim(); }
export class OrderService {
  execute(id: string): string {
    const raw = loadOrder(id);
    let result = raw;
    result = formatOrder(result);
    return result;
  }
}
`);
  fs.writeFileSync(path.join(root, "src", "controller.ts"), `
import { OrderService } from "./service";
const service = new OrderService();
export function handle(): string { return service.execute("1"); }
`);
  fs.writeFileSync(path.join(root, "src", "serialize.ts"), `
import { handle } from "./controller";
export function serialize(): string { return JSON.stringify(handle()); }
`);
  fs.writeFileSync(path.join(root, "src", "first.ts"), `
export function save(): string { return "first"; }
`);
  fs.writeFileSync(path.join(root, "src", "second.ts"), `
export function save(): string { return "second"; }
`);
  fs.writeFileSync(path.join(root, "src", "overloaded.ts"), `
export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number { return value; }
`);
  fs.writeFileSync(path.join(root, "test", "service.test.ts"), `
import { OrderService } from "../src/service";
export function testOrder(): string { return new OrderService().execute("test"); }
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

function emptyReport() {
  return {
    query: {},
    targets: [],
    impacted: [],
    impactedTests: [],
    summary: {
      targetCount: 0,
      impactedCount: 0,
      impactedTestCount: 0,
      externalCount: 0,
      truncated: false,
    },
  };
}
