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
} = require("../bin/context-pack-cli");
const {
  createContextPack,
  estimateContextPackTokens,
  formatContextPack,
} = require("../dist/tools/context-pack");

test("context-pack parses task, repeated context inputs, selection, and output", () => {
  const options = parseArgs([
    "--source", "src/**/*.ts",
    "--source", "packages/**/*.ts",
    "--test-source", "test/**/*.ts",
    "--task", "repair invoice validation",
    "--tsconfig", "config/tsconfig.json",
    "--exclude", ".generated.ts",
    "--symbol", "save", "--in", "src/first.ts",
    "--symbol", "run",
    "--file", "src/types.ts",
    "--at", "src/service.ts:12:4",
    "--doc", "docs/**/*.md",
    "--config", "config/tool.json",
    "--max-seeds", "3",
    "--direction", "incoming",
    "--max-depth", "4",
    "--max-nodes", "80",
    "--max-tokens", "9000",
    "--format", "json",
    "--pretty",
    "--out", "pack.json",
  ]);
  assert.deepEqual(options.sourceGlob, ["src/**/*.ts", "packages/**/*.ts"]);
  assert.equal(options.task, "repair invoice validation");
  assert.deepEqual(options.seeds[0], {
    kind: "symbol", symbol: "save", filePath: "src/first.ts",
  });
  assert.deepEqual(options.seeds[3], {
    kind: "location",
    location: { filePath: "src/service.ts", line: 12, column: 4 },
  });
  assert.equal(options.maxSeeds, 3);
  assert.equal(options.maxTokens, 9000);
  assert.equal(options.pretty, true);
});

test("context-pack validates CLI ordering, task selection, formats, and locations", () => {
  assert.deepEqual(parseLocation("C:\\work\\service.ts:20:7"), {
    filePath: "C:\\work\\service.ts", line: 20, column: 7,
  });
  assert.throws(() => parseArgs([]), /Missing required option: --source/);
  assert.throws(() => parseArgs(["--source", "src/**/*.ts"]), /Missing task/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--task", "one", "--task-file", "task.md",
  ]), /mutually exclusive/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--task", "one", "--in", "src/a.ts",
  ]), /immediately follow/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--task", "one", "--symbol", "save",
    "--direction", "both", "--in", "src/a.ts",
  ]), /immediately follow/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--task", "one", "--max-tokens", "0",
  ]), /greater than zero/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--task", "one", "--format", "markdown", "--pretty",
  ]), /only supported with JSON/);
  assert.throws(() => parseArgs([
    "--source", "src/**/*.ts", "--task", "one", "positional",
  ]), /Unknown argument/);
});

test("context-pack ranks task code and assembles docs, config, tests, and types", () => {
  const fixture = createFixture();
  const report = createContextPack(baseOptions(fixture));
  assert.equal(report.seeds[0].origin, "automatic");
  assert.equal(report.seeds[0].node.qualifiedName, "processInvoice");
  assert.equal(report.code.targets.some((target) => target.qualifiedName === "processInvoice"), true);
  assert.equal(report.code.impactedTests.some((selection) => selection.node.name === "testInvoice"), true);
  assert.equal(report.code.selections.some((selection) => selection.node.qualifiedName === "Invoice"), true);
  assert.equal(report.instructions.some((chunk) => chunk.filePath.endsWith("AGENTS.md")), true);
  assert.equal(report.instructions.some((chunk) => chunk.filePath.endsWith("src/AGENTS.md")), true);
  assert.equal(report.configuration.some((chunk) => chunk.filePath.endsWith("package.json")), true);
  assert.equal(report.configuration.some((chunk) => chunk.filePath.endsWith("tsconfig.json")), true);
  assert.equal(report.documentation.length > 0, true);
  assert.equal(report.documentation.every((chunk) => !chunk.filePath.endsWith("secret.md")), true);
  assert.equal(report.summary.estimatedTokens, estimateContextPackTokens(report));
  assert.equal(report.summary.estimatedTokens <= report.summary.maxTokens, true);
});

test("context-pack supports explicit seeds, ambiguity disambiguation, and maxSeeds zero", () => {
  const fixture = createFixture();
  assert.throws(() => createContextPack(baseOptions(fixture, {
    seeds: [{ kind: "symbol", symbol: "save" }],
  })), /ambiguous/i);
  const report = createContextPack(baseOptions(fixture, {
    task: "unmatched qzxwv",
    maxSeeds: 0,
    seeds: [{
      kind: "symbol",
      symbol: "save",
      filePath: path.join(fixture, "src", "first.ts"),
    }],
  }));
  assert.equal(report.summary.automaticSeedCount, 0);
  assert.equal(report.seeds.some((seed) => seed.node.filePath.endsWith("first.ts")), true);
});

test("context-pack merges multiple targets without duplicate snippets", () => {
  const fixture = createFixture();
  const report = createContextPack(baseOptions(fixture, {
    maxSeeds: 0,
    seeds: [
      { kind: "symbol", symbol: "InvoiceService" },
      { kind: "symbol", symbol: "InvoiceService.validate" },
      { kind: "location", location: locationOf(fixture, "validate(invoice)") },
    ],
  }));
  const snippetIds = report.code.files.flatMap((file) => file.snippets.map((snippet) => snippet.id));
  assert.equal(new Set(snippetIds).size, snippetIds.length);
  assert.equal(report.seeds.filter((seed) => seed.origin === "explicit").length >= 2, true);
});

test("context-pack discovers fenced Markdown safely and honors explicit files", () => {
  const fixture = createFixture();
  const report = createContextPack(baseOptions(fixture, {
    maxSeeds: 0,
    seeds: [{ kind: "symbol", symbol: "processInvoice" }],
    docGlobs: [path.join(fixture, "docs/**/*.md")],
    configFilePaths: [path.join(fixture, "config", "tool.json")],
  }));
  assert.equal(report.documentation.some((chunk) => chunk.text.includes("# not a section")), true);
  assert.equal(report.configuration.some((chunk) => chunk.filePath.endsWith("tool.json") && chunk.explicit), true);
  assert.equal(report.documentation.every((chunk) => !chunk.filePath.endsWith(".env")), true);
  assert.equal(report.configuration.every((chunk) => !chunk.filePath.endsWith("package-lock.json")), true);
  assert.throws(() => createContextPack(baseOptions(fixture, {
    seeds: [{ kind: "symbol", symbol: "processInvoice" }],
    docGlobs: ["missing/**/*.md"],
  })), /No documentation files matched/);
  assert.throws(() => createContextPack(baseOptions(fixture, {
    seeds: [{ kind: "symbol", symbol: "processInvoice" }],
    configFilePaths: ["missing.json"],
  })), /Configuration file not found/);
  assert.throws(() => createContextPack(baseOptions(fixture, {
    seeds: [{ kind: "symbol", symbol: "processInvoice" }],
    docGlobs: [path.join(fixture, "docs", "binary.txt")],
  })), /binary/);
});

test("context-pack fails unmatched retrieval and mandatory budget overflow", () => {
  const fixture = createFixture();
  assert.throws(() => createContextPack(baseOptions(fixture, {
    task: "qzxwv plmokn",
    maxSeeds: 5,
  })), /did not match.*explicit seed/i);
  assert.throws(() => createContextPack(baseOptions(fixture, {
    maxTokens: 20,
    seeds: [{ kind: "symbol", symbol: "processInvoice" }],
  })), /Mandatory context requires approximately/);
});

test("context-pack budgets whole optional chunks deterministically", () => {
  const fixture = createFixture();
  const generous = createContextPack(baseOptions(fixture, { maxTokens: 12000 }));
  const constrained = createContextPack(baseOptions(fixture, { maxTokens: 3500 }));
  const repeated = createContextPack(baseOptions(fixture, { maxTokens: 3500 }));
  assert.deepEqual(constrained, repeated);
  assert.equal(constrained.summary.estimatedTokens <= 3500, true);
  assert.equal(constrained.omitted.length > 0, true);
  assert.equal(constrained.summary.snippetCount <= generous.summary.snippetCount, true);
  for (const file of constrained.code.files) {
    for (const snippet of file.snippets) assert.equal(snippet.text.length > 0, true);
  }
});

test("context-pack formats Markdown and JSON and keeps file output quiet", () => {
  const fixture = createFixture();
  const report = createContextPack(baseOptions(fixture, { maxTokens: 5000 }));
  const markdown = formatContextPack(report);
  assert.match(markdown, /^# Context Pack\n/);
  assert.match(markdown, /## Task/);
  assert.match(markdown, /## Code Context/);
  assert.equal(markdown.endsWith("\n"), true);
  assert.equal(formatContextPack(report, { format: "json" }), `${JSON.stringify(report)}\n`);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "context-pack-output-"));
  const taskFile = path.join(directory, "task.md");
  const outputFile = path.join(directory, "nested", "pack.json");
  fs.writeFileSync(taskFile, "repair invoice validation\n");
  const stdout = captureStdout(() => run([
    "--source", "src/**/*.ts",
    "--task-file", taskFile,
    "--format", "json",
    "--pretty",
    "--out", outputFile,
  ], () => report));
  assert.equal(stdout, "");
  assert.equal(fs.readFileSync(outputFile, "utf8"), formatContextPack(report, {
    format: "json", pretty: true,
  }));
});

function baseOptions(fixture, overrides = {}) {
  return {
    task: "repair invoice processing validation",
    sourceGlob: path.join(fixture, "src/**/*.ts"),
    testSourceGlob: path.join(fixture, "test/**/*.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    cwd: fixture,
    ...overrides,
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-pack-fixture-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "invoice-fixture", scripts: { test: "node --test" },
  }, null, 2));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      types: ["node"],
    },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }, null, 2));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep invoice validation deterministic.\n");
  fs.writeFileSync(path.join(root, "src", "AGENTS.md"), "Use the repository abstraction in this directory.\n");
  fs.writeFileSync(path.join(root, "README.md"), `# Invoice Tool

This project processes customer invoices.

## Validation

Validation rejects empty invoice identifiers.
`);
  fs.writeFileSync(path.join(root, "docs", "design.md"), `# Design

Invoice processing uses a repository.

\`\`\`markdown
# not a section
\`\`\`

## Tests

Tests cover validation.
`);
  fs.writeFileSync(path.join(root, "config", "tool.json"), '{"strictInvoices":true}\n');
  fs.writeFileSync(path.join(root, "docs", "binary.txt"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(root, "docs", "secret.md"), "# Credentials\n\nDo not include automatically.\n");
  fs.writeFileSync(path.join(root, ".env"), "INVOICE_SECRET=hidden\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.writeFileSync(path.join(root, "src", "types.ts"), `
import type { InspectOptions } from "node:util";
export interface Invoice extends InspectOptions { id: string; total: number }
export type InvoiceId = Invoice["id"];
`);
  fs.writeFileSync(path.join(root, "src", "repository.ts"), `
import type { Invoice, InvoiceId } from "./types";
export function loadInvoice(id: InvoiceId): Invoice { return { id, total: 10 }; }
`);
  fs.writeFileSync(path.join(root, "src", "service.ts"), `
import { loadInvoice } from "./repository";
import type { Invoice, InvoiceId } from "./types";
export class InvoiceService {
  validate(invoice: Invoice): boolean { return invoice.id.length > 0; }
}
export function processInvoice(id: InvoiceId): Invoice {
  const invoice = loadInvoice(id);
  const service = new InvoiceService();
  if (!service.validate(invoice)) throw new Error("invalid invoice");
  return invoice;
}
export function unrelatedUtility(): number { return 42; }
`);
  fs.writeFileSync(path.join(root, "src", "first.ts"), "export function save(): void {}\n");
  fs.writeFileSync(path.join(root, "src", "second.ts"), "export function save(): void {}\n");
  fs.writeFileSync(path.join(root, "test", "service.test.ts"), `
import { processInvoice } from "../src/service";
export function testInvoice(): void { processInvoice("one"); }
`);
  return root;
}

function locationOf(fixture, needle) {
  const filePath = path.join(fixture, "src", "service.ts");
  const source = fs.readFileSync(filePath, "utf8");
  const offset = source.indexOf(needle);
  const before = source.slice(0, offset);
  return {
    filePath,
    line: before.split("\n").length,
    column: before.length - before.lastIndexOf("\n"),
  };
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
