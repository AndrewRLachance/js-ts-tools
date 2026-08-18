"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseArgs,
  parseLocation,
  run,
} = require("../bin/code-slice-cli");
const {
  createCodeSlice,
  formatCodeSlice,
} = require("../dist/tools/code-slice");

test("code-slice parses selectors, traversal, and output options", () => {
  const options = parseArgs([
    "--source", "src/**/*.ts",
    "--source", "packages/**/*.ts",
    "--test-source", "test/**/*.ts",
    "--tsconfig", "config/tsconfig.json",
    "--exclude", ".generated.ts",
    "--symbol", "OrderService.execute",
    "--file", "src/service.ts",
    "--direction", "outgoing",
    "--max-depth", "4",
    "--max-nodes", "75",
    "--format", "json",
    "--pretty",
    "--out", "slice.json",
  ]);
  assert.deepEqual(options.sourceGlob, ["src/**/*.ts", "packages/**/*.ts"]);
  assert.equal(options.testSourceGlob, "test/**/*.ts");
  assert.equal(options.symbol, "OrderService.execute");
  assert.equal(options.direction, "outgoing");
  assert.equal(options.maxDepth, 4);
  assert.equal(options.maxNodes, 75);
  assert.equal(options.pretty, true);
});

test("code-slice parses line, column, and Windows-style locations from the right", () => {
  assert.deepEqual(parseLocation("src/example.ts:47"), {
    filePath: "src/example.ts", line: 47, column: undefined,
  });
  assert.deepEqual(parseLocation("C:\\work\\example.ts:47:9"), {
    filePath: "C:\\work\\example.ts", line: 47, column: 9,
  });
});

test("code-slice rejects missing, conflicting, unknown, and malformed options", () => {
  assert.throws(() => parseArgs([]), /Missing required option: --source/);
  assert.throws(() => parseArgs(["--source", "src/**/*.ts"]), /Missing target/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--symbol", "run", "--at", "src/a.ts:2",
  ]), /cannot be combined/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--file", "src/a.ts", "--direction", "sideways",
  ]), /Invalid direction/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--file", "src/a.ts", "--max-depth", "1.5",
  ]), /nonnegative integer/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--file", "src/a.ts", "--format", "markdown", "--pretty",
  ]), /only supported with JSON/);
  assert.throws(() => parseLocation("src/a.ts:zero"), /Invalid location/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--file", "src/a.ts", "positional",
  ]), /Unknown argument/);
});

test("code-slice builds calls, tests, types, imports, and external boundaries", () => {
  const fixture = createFixture();
  const report = createCodeSlice(baseOptions(fixture, {
    symbol: "OrderService.execute",
  }));
  const names = new Set(report.selections.map((selection) => selection.node.qualifiedName));
  assert.equal(names.has("OrderService.execute"), true);
  assert.equal(names.has("loadOrder"), true);
  assert.equal(names.has("handle"), true);
  assert.equal(names.has("Order"), true);
  assert.equal(names.has("OrderId"), true);
  assert.equal(report.impactedTests.some((selection) => selection.node.name === "testExecute"), true);
  assert.equal(report.boundaries.some((boundary) =>
    boundary.node.filePath?.includes("node_modules") || boundary.node.name === "InspectOptions"), true);
  assert.equal(report.selections.every((selection) => selection.snippetIds.length > 0), true);
  assert.equal(report.selections.some((selection) =>
    selection.paths.some((selectionPath) => selectionPath.kind === "supporting")), true);
  const serviceFile = report.files.find((file) => file.filePath.endsWith("service.ts"));
  assert.equal(serviceFile.imports.some((item) => item.moduleSpecifier === "./types"), true);
  assert.equal(serviceFile.imports.some((item) => item.moduleSpecifier === "./unused"), false);
});

test("code-slice location targeting resolves a token and falls back to its owner", () => {
  const fixture = createFixture();
  const servicePath = path.join(fixture, "src", "service.ts");
  const source = fs.readFileSync(servicePath, "utf8");
  const callOffset = source.indexOf("loadOrder(id)");
  const beforeCall = source.slice(0, callOffset);
  const line = beforeCall.split("\n").length;
  const column = beforeCall.length - beforeCall.lastIndexOf("\n");
  const symbolReport = createCodeSlice(baseOptions(fixture, {
    at: { filePath: servicePath, line, column },
    direction: "outgoing",
  }));
  assert.equal(symbolReport.targets[0].qualifiedName, "loadOrder");

  const returnOffset = source.indexOf("return order") + "return ".length;
  const beforeReturn = source.slice(0, returnOffset);
  const ownerReport = createCodeSlice(baseOptions(fixture, {
    at: {
      filePath: servicePath,
      line: beforeReturn.split("\n").length,
      column: beforeReturn.length - beforeReturn.lastIndexOf("\n"),
    },
    direction: "outgoing",
  }));
  assert.equal(ownerReport.targets.length > 0, true);

  const lineReport = createCodeSlice(baseOptions(fixture, {
    at: { filePath: servicePath, line },
    direction: "outgoing",
  }));
  assert.equal(lineReport.targets[0].qualifiedName, "OrderService.execute.order");
});

test("code-slice collapses nested snippets and retains covered selections", () => {
  const fixture = createFixture();
  const report = createCodeSlice(baseOptions(fixture, {
    symbol: "OrderService",
    direction: "outgoing",
  }));
  const serviceFile = report.files.find((file) => file.filePath.endsWith("service.ts"));
  const classSnippet = serviceFile.snippets.find((snippet) => snippet.text.includes("class OrderService"));
  assert.equal(Boolean(classSnippet), true);
  assert.equal(classSnippet.selectionIds.length >= 1, true);
  assert.equal(serviceFile.snippets.filter((snippet) => snippet.text.includes("execute(")).length, 1);
});

test("code-slice is deterministic, bounded, and supports file targets and ambiguity", () => {
  const fixture = createFixture();
  const options = baseOptions(fixture, {
    symbol: "OrderService.execute",
    maxNodes: 1,
  });
  const first = createCodeSlice(options);
  const second = createCodeSlice(options);
  assert.deepEqual(first, second);
  assert.equal(first.summary.truncated, true);

  assert.throws(() => createCodeSlice(baseOptions(fixture, { symbol: "save" })), /ambiguous/i);
  const fileReport = createCodeSlice(baseOptions(fixture, {
    filePath: path.join(fixture, "src", "first.ts"),
  }));
  assert.equal(fileReport.targets.every((target) => target.filePath.endsWith("first.ts")), true);

  const overloadReport = createCodeSlice(baseOptions(fixture, { symbol: "overloaded" }));
  assert.equal(overloadReport.targets.length, 1);
  const overloadSelection = overloadReport.selections.find((selection) =>
    selection.node.qualifiedName === "overloaded");
  assert.equal(overloadSelection.snippetIds.length, 3);
});

test("code-slice formats compact JSON, pretty files, and Markdown identically", () => {
  const fixture = createFixture();
  const report = createCodeSlice(baseOptions(fixture, { symbol: "loadOrder" }));
  const compact = formatCodeSlice(report);
  assert.equal(compact, `${JSON.stringify(report)}\n`);
  const markdown = formatCodeSlice(report, { format: "markdown" });
  assert.match(markdown, /^# Code Slice\n/);
  assert.match(markdown, /```ts/);
  assert.equal(markdown.endsWith("\n"), true);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "code-slice-output-"));
  const outputPath = path.join(temporaryDirectory, "nested", "slice.json");
  const stdout = captureStdout(() => run([
    "--source", "src/**/*.ts", "--symbol", "run", "--pretty", "--out", outputPath,
  ], () => report));
  assert.equal(stdout, "");
  assert.equal(fs.readFileSync(outputPath, "utf8"), formatCodeSlice(report, {
    format: "json", pretty: true,
  }));
});

test("code-slice preserves source and location validation errors", () => {
  const fixture = createFixture();
  assert.throws(() => createCodeSlice(baseOptions(fixture, {
    sourceGlob: path.join(fixture, "missing/**/*.ts"), symbol: "run",
  })), /No files matched source glob/);
  assert.throws(() => createCodeSlice(baseOptions(fixture, {
    symbol: "Missing",
  })), /Could not find symbol/);
  assert.throws(() => createCodeSlice(baseOptions(fixture, {
    at: { filePath: path.join(fixture, "src", "service.ts"), line: 999 },
  })), /outside the source file/);
});

function baseOptions(fixture, overrides) {
  return {
    sourceGlob: path.join(fixture, "src/**/*.ts"),
    testSourceGlob: path.join(fixture, "test/**/*.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    ...overrides,
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-slice-fixture-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      types: ["node"],
    },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }));
  fs.writeFileSync(path.join(root, "src", "types.ts"), `
import type { InspectOptions } from "node:util";
export interface Order extends InspectOptions { id: string }
export type OrderId = Order["id"];
`);
  fs.writeFileSync(path.join(root, "src", "repository.ts"), `
import type { Order, OrderId } from "./types";
export function loadOrder(id: OrderId): Order { return { id }; }
`);
  fs.writeFileSync(path.join(root, "src", "unused.ts"), "export const unused = true;\n");
  fs.writeFileSync(path.join(root, "src", "service.ts"), `
import { loadOrder } from "./repository";
import type { Order, OrderId } from "./types";
import { unused } from "./unused";
export class OrderService {
  execute(id: OrderId): Order {
    const order = loadOrder(id);
    return order;
  }
}
export function handle(service: OrderService, id: OrderId): Order {
  return service.execute(id);
}
`);
  fs.writeFileSync(path.join(root, "src", "first.ts"), "export function save(): void {}\n");
  fs.writeFileSync(path.join(root, "src", "second.ts"), "export function save(): void {}\n");
  fs.writeFileSync(path.join(root, "src", "overload.ts"), `
export function overloaded(value: string): string;
export function overloaded(value: number): number;
export function overloaded(value: string | number): string | number { return value; }
`);
  fs.writeFileSync(path.join(root, "test", "service.test.ts"), `
import { OrderService } from "../src/service";
export function testExecute(): void { new OrderService().execute("one"); }
`);
  return root;
}

function captureStdout(callback) {
  let output = "";
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    callback();
  } finally {
    process.stdout.write = original;
  }
  return output;
}
