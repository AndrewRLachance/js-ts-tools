"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const { Project } = require("ts-morph");
const {
  AST_XPATH_PATTERN_SCHEMA_VERSION,
  AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION,
  AST_XPATH_XML_SCHEMA_VERSION,
  generateAstXPathPattern,
  matchAstXPathPattern,
  readAstXPathPattern,
  serializeAstToXml,
} = require("../dist/tools/ast-xpath");
const {
  parseAstXPathArgs,
} = require("../dist/tools/ast-xpath-cli");

function createProject(files, compilerOptions = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ast-xpath-"));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", ...compilerOptions },
    include: ["src/**/*"],
  }));
  for (const [name, source] of Object.entries(files)) {
    const filePath = path.join(cwd, "src", name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  return cwd;
}

describe("AST XML projection", () => {
  it("serializes stable node kinds, field names, collection indices, values, and escaping", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("example.ts", `function f() { return "a&\\\"b"; }`);
    const first = serializeAstToXml(sourceFile);
    const second = serializeAstToXml(sourceFile);

    assert.equal(first, second);
    assert.match(first, /^<ast schemaVersion="1" typescriptVersion="[^"]+"><file/);
    assert.match(first, /<field name="statements" collection="true"><node[^>]+index="1"/);
    assert.match(first, /<field name="parameters" collection="true"\/>/);
    assert.match(first, /kind="Identifier"[^>]+value="f"/);
    assert.match(first, /value="a&amp;&quot;b"/);
    assert.doesNotMatch(first, /parent=|symbol=|flowNode=|emitNode=/);
  });

  it("preserves TSX structure, modifiers, and operator tokens", () => {
    const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: 4 } });
    const sourceFile = project.createSourceFile(
      "view.tsx",
      "async function view() { return <div>{left + right}</div>; }",
    );
    const xml = serializeAstToXml(sourceFile);
    assert.match(xml, /kind="JsxElement"/);
    assert.match(xml, /kind="AsyncKeyword"/);
    assert.match(xml, /kind="PlusToken"/);
  });
});

describe("AST XPath generation and matching", () => {
  it("generates versioned exact and shape patterns", () => {
    const cwd = createProject({
      "example.ts": `
declare function audit(value: string): void;
declare function other(value: string): void;
/* ast-xpath-root */ audit("alpha");
audit("beta");
other("gamma");
`,
    });

    const exact = generateAstXPathPattern({ cwd, exampleFilePath: "src/example.ts" });
    assert.equal(exact.pattern.schemaVersion, AST_XPATH_PATTERN_SCHEMA_VERSION);
    assert.equal(exact.pattern.xmlSchemaVersion, AST_XPATH_XML_SCHEMA_VERSION);
    assert.match(exact.pattern.xpath, /@value = 'audit'/);
    assert.match(exact.pattern.xpath, /@value = 'alpha'/);
    const exactMatches = matchAstXPathPattern({ cwd, pattern: exact.pattern });
    assert.deepEqual(exactMatches.matches.map((match) => match.text), ['audit("alpha");']);

    const shape = generateAstXPathPattern({
      cwd,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    assert.doesNotMatch(shape.pattern.xpath, /@value =/);
    const shapeMatches = matchAstXPathPattern({ cwd, pattern: shape.pattern });
    assert.deepEqual(shapeMatches.matches.map((match) => match.text), [
      'audit("alpha");',
      'audit("beta");',
    ]);
    assert.equal(shapeMatches.summary.xpathCandidates, 3);
    assert.equal(shapeMatches.summary.semanticRejected, 1);
  });

  it("finds markers after interpolated template literals", () => {
    const cwd = createProject({
      "example.ts": `
const name = "world";
const greeting = \`hello \${name}\`;
/* ast-xpath-root */ const selected = greeting;
`,
    });
    const generated = generateAstXPathPattern({ cwd, exampleFilePath: "src/example.ts" });
    assert.equal(generated.pattern.example.root.kind, "VariableStatement");
  });

  it("treats paired ignored collection nodes as a zero-or-more ordered gap", () => {
    const cwd = createProject({
      "example.ts": `
declare function sink(value: unknown): void;
declare function first(): unknown;
declare function middle(): unknown;
declare function last(): unknown;
/* ast-xpath-root */ sink([
  first(),
  /* ast-xpath-ignore-start */ middle(), /* ast-xpath-ignore-end */
  last(),
]);
sink([first(), last()]);
sink([first(), middle(), middle(), last()]);
`,
    });
    const generated = generateAstXPathPattern({ cwd, exampleFilePath: "src/example.ts" });
    assert.equal(generated.pattern.ignored.length, 1);
    assert.equal(generated.pattern.ignored[0].marker, "paired");
    assert.match(generated.pattern.xpath, /following-sibling::node/);
    const report = matchAstXPathPattern({ cwd, pattern: generated.pattern });
    assert.equal(report.summary.matches, 3);
  });

  it("allows a single ignored fixed field to contain any subtree", () => {
    const cwd = createProject({
      "example.ts": `
declare function audit(): void;
/* ast-xpath-root */ if (/* ast-xpath-ignore */ true) audit();
if (someUnknownName) audit();
`,
    });
    const generated = generateAstXPathPattern({ cwd, exampleFilePath: "src/example.ts" });
    const report = matchAstXPathPattern({ cwd, pattern: generated.pattern });
    assert.equal(report.summary.matches, 2);
  });

  it("preserves local binding topology while allowing shape-mode renames", () => {
    const cwd = createProject({
      "example.ts": `
/* ast-xpath-root */ function first(value: string) { return value; }
function second(renamed: string) { return renamed; }
function broken(left: string) { const right = left; return right; }
`,
    });
    const generated = generateAstXPathPattern({
      cwd,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    const report = matchAstXPathPattern({ cwd, pattern: generated.pattern });
    assert.deepEqual(report.matches.map((match) => match.text), [
      "function first(value: string) { return value; }",
      "function second(renamed: string) { return renamed; }",
    ]);
  });

  it("resolves aliases and rejects a different selected overload", () => {
    const aliasCwd = createProject({
      "library.ts": `export function audit(value: string): void { void value; }`,
      "example.ts": `
import { audit as firstAudit } from "./library";
import { audit as secondAudit } from "./library";
/* ast-xpath-root */ firstAudit("before");
secondAudit("after");
`,
    });
    const aliasPattern = generateAstXPathPattern({
      cwd: aliasCwd,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    const aliasReport = matchAstXPathPattern({ cwd: aliasCwd, pattern: aliasPattern.pattern });
    assert.deepEqual(aliasReport.matches.map((match) => match.text), [
      'firstAudit("before");',
      'secondAudit("after");',
    ]);

    const overloadCwd = createProject({
      "example.ts": `
function choose(value: string): number;
function choose(value: number): number;
function choose(value: string | number): number { return String(value).length; }
/* ast-xpath-root */ choose(/* ast-xpath-ignore */ "text");
choose(42);
`,
    });
    const overloadPattern = generateAstXPathPattern({
      cwd: overloadCwd,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    assert.ok(Object.values(overloadPattern.pattern.semantics).some((fact) =>
      fact.signature?.parameters?.length === 1 && typeof fact.signature.returnTypeText === "string"
    ));
    const overloadReport = matchAstXPathPattern({ cwd: overloadCwd, pattern: overloadPattern.pattern });
    assert.equal(overloadReport.summary.xpathCandidates, 2);
    assert.equal(overloadReport.summary.semanticRejected, 1);
    assert.deepEqual(overloadReport.matches.map((match) => match.text), ['choose(/* ast-xpath-ignore */ "text");']);
  });

  it("matches a self-contained pattern after the origin project is removed", () => {
    const origin = createProject({
      "library.ts": `export function audit(value: string): void { void value; }\nexport function other(value: string): void { void value; }`,
      "example.ts": `
import { audit as originAudit } from "./library";
/* ast-xpath-root */ originAudit("before");
`,
    });
    const generated = generateAstXPathPattern({
      cwd: origin,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    assert.equal(generated.pattern.schemaVersion, 2);
    assert.equal(generated.pattern.template.kind, "node");

    const target = createProject({
      "library.ts": `export function audit(value: string): void { void value; }\nexport function other(value: string): void { void value; }`,
      "candidate.ts": `
import { audit as targetAudit, other } from "./library";
targetAudit("accepted");
other("structural-only");
`,
    });
    fs.rmSync(origin, { recursive: true, force: true });

    const strict = matchAstXPathPattern({
      cwd: target,
      pattern: generated.pattern,
      targetTsConfigFilePath: "tsconfig.json",
    });
    assert.deepEqual(strict.matches.map((match) => match.text), ['targetAudit("accepted");']);
    assert.equal(strict.summary.xpathCandidates, 2);
    assert.equal(strict.summary.semanticRejected, 1);

    const structural = matchAstXPathPattern({
      cwd: target,
      pattern: generated.pattern,
      semanticMode: "structural",
    });
    assert.deepEqual(structural.matches.map((match) => match.text), [
      'targetAudit("accepted");',
      'other("structural-only");',
    ]);
  });

  it("preserves internal binding topology across projects", () => {
    const origin = createProject({
      "example.ts": `/* ast-xpath-root */ function first(value: string) { return value; }`,
    });
    const generated = generateAstXPathPattern({
      cwd: origin,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    const target = createProject({
      "candidate.ts": `
function accepted(renamed: string) { return renamed; }
function rejected(left: string) { const right = left; return right; }
`,
    });
    fs.rmSync(origin, { recursive: true, force: true });
    const report = matchAstXPathPattern({ cwd: target, pattern: generated.pattern });
    assert.deepEqual(report.matches.map((match) => match.text), [
      "function accepted(renamed: string) { return renamed; }",
    ]);
  });

  it("uses target-checker mutual assignability for portable types", () => {
    const origin = createProject({
      "library.ts": `export const value = "text";\nexport function consume(input: unknown): void { void input; }`,
      "example.ts": `import { consume, value } from "./library";\n/* ast-xpath-root */ consume(value);`,
    });
    const generated = generateAstXPathPattern({
      cwd: origin,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    const target = createProject({
      "library.ts": `export const value = 42;\nexport function consume(input: unknown): void { void input; }`,
      "candidate.ts": `import { consume, value } from "./library";\nconsume(value);`,
    });
    fs.rmSync(origin, { recursive: true, force: true });

    const strict = matchAstXPathPattern({ cwd: target, pattern: generated.pattern });
    assert.equal(strict.summary.xpathCandidates, 1);
    assert.equal(strict.summary.semanticRejected, 1);
    assert.equal(strict.summary.matches, 0);
    const structural = matchAstXPathPattern({
      cwd: target,
      pattern: generated.pattern,
      semanticMode: "structural",
    });
    assert.equal(structural.summary.matches, 1);
  });

  it("diagnoses semantic facts that cannot be made portable", () => {
    const cwd = createProject({
      "example.ts": `
interface PrivateShape { value: string }
/* ast-xpath-root */ function use(value: PrivateShape): PrivateShape { return value; }
`,
    });
    const generated = generateAstXPathPattern({
      cwd,
      exampleFilePath: "src/example.ts",
      strictness: "shape",
    });
    assert.ok(generated.pattern.diagnostics.some((diagnostic) => diagnostic.code === "unportable-type"));
  });

  it("rejects malformed markers and preserves legacy project anchors", () => {
    const malformed = createProject({
      "example.ts": `/* ast-xpath-root */ foo(/* ast-xpath-ignore-start */ value);`,
    });
    assert.throws(
      () => generateAstXPathPattern({ cwd: malformed, exampleFilePath: "src/example.ts" }),
      /no matching ignore-end/,
    );

    const cwd = createProject({
      "example.ts": `/* ast-xpath-root */ const value = 1;`,
    });
    const generated = generateAstXPathPattern({ cwd, exampleFilePath: "src/example.ts" });
    const legacy = {
      ...generated.pattern,
      schemaVersion: AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION,
      semanticPolicy: {
        automatic: true,
        mode: "binding-aware-exact",
        typeRelation: "mutually-assignable",
      },
    };
    delete legacy.template;
    delete legacy.semantics;
    fs.appendFileSync(path.join(cwd, "src/example.ts"), "\n");
    assert.throws(
      () => matchAstXPathPattern({ cwd, pattern: legacy }),
      /example source hash mismatch/,
    );

    const configDrift = createProject({
      "example.ts": `/* ast-xpath-root */ const value = 1;`,
    });
    const anchoredV2 = generateAstXPathPattern({ cwd: configDrift, exampleFilePath: "src/example.ts" });
    const anchored = {
      ...anchoredV2.pattern,
      schemaVersion: AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION,
      semanticPolicy: { automatic: true, mode: "binding-aware-exact", typeRelation: "mutually-assignable" },
    };
    delete anchored.template;
    delete anchored.semantics;
    fs.writeFileSync(path.join(configDrift, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: false },
      include: ["src/**/*"],
    }));
    assert.throws(
      () => matchAstXPathPattern({ cwd: configDrift, pattern: anchored }),
      /tsconfig hash mismatch/,
    );
    assert.throws(
      () => matchAstXPathPattern({ cwd: configDrift, pattern: anchored, targetTsConfigFilePath: "other.json" }),
      /regenerate the pattern as version 2/,
    );
  });

  it("validates persisted pattern schemas", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ast-xpath-pattern-"));
    const filePath = path.join(cwd, "invalid.json");
    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 999 }));
    assert.throws(() => readAstXPathPattern(filePath), /unsupported/);

    const project = createProject({
      "example.ts": `/* ast-xpath-root */ const value = 1;`,
    });
    const generated = generateAstXPathPattern({ cwd: project, exampleFilePath: "src/example.ts" });
    assert.throws(
      () => matchAstXPathPattern({ cwd: project, pattern: { ...generated.pattern, template: null } }),
      /malformed portable template/,
    );
    assert.throws(
      () => matchAstXPathPattern({
        cwd: project,
        pattern: {
          ...generated.pattern,
          project: { ...generated.pattern.project, typescriptVersion: "0.0.0" },
        },
      }),
      /TypeScript version drift/,
    );
  });
});

describe("ast-xpath CLI", () => {
  const executable = path.resolve(__dirname, "../bin/ast-xpath-cli.js");

  it("parses all three subcommands", () => {
    assert.equal(parseAstXPathArgs(["generate", "--example", "src/a.ts"]).command, "generate");
    const match = parseAstXPathArgs([
      "match", "--pattern", "pattern.json", "--tsconfig", "target.json", "--semantics", "structural",
    ]);
    assert.equal(match.command, "match");
    assert.equal(match.targetTsConfigFilePath, "target.json");
    assert.equal(match.semanticMode, "structural");
    assert.equal(parseAstXPathArgs(["run", "--example", "src/a.ts"]).command, "run");
    assert.throws(() => parseAstXPathArgs(["match"]), /requires --pattern/);
    assert.throws(
      () => parseAstXPathArgs(["generate", "--example", "src/a.ts", "--semantics", "structural"]),
      /does not accept matching options/,
    );
  });

  it("generates, persists, and matches a pattern", () => {
    const cwd = createProject({
      "example.ts": `
declare function audit(value: string): void;
/* ast-xpath-root */ audit("one");
audit("two");
`,
    });
    const generate = spawnSync(process.execPath, [
      executable,
      "generate",
      "--example", "src/example.ts",
      "--strictness", "shape",
      "--out", "pattern.json",
      "--xml-out", "example.xml",
      "--pretty",
    ], { cwd, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    assert.equal(fs.existsSync(path.join(cwd, "pattern.json")), true);
    assert.match(fs.readFileSync(path.join(cwd, "example.xml"), "utf8"), /^<ast/);

    const match = spawnSync(process.execPath, [
      executable,
      "match",
      "--pattern", "pattern.json",
      "--pretty",
    ], { cwd, encoding: "utf8" });
    assert.equal(match.status, 0, match.stderr);
    const report = JSON.parse(match.stdout);
    assert.equal(report.summary.matches, 2);
  });

  it("matches from another project after the generating project is deleted", () => {
    const origin = createProject({
      "library.ts": `export function audit(value: string): void { void value; }`,
      "example.ts": `import { audit as first } from "./library";\n/* ast-xpath-root */ first("one");`,
    });
    const target = createProject({
      "library.ts": `export function audit(value: string): void { void value; }`,
      "candidate.ts": `import { audit as second } from "./library";\nsecond("two");`,
    });
    const patternPath = path.join(target, "portable-pattern.json");
    const generate = spawnSync(process.execPath, [
      executable,
      "generate",
      "--example", "src/example.ts",
      "--strictness", "shape",
      "--out", patternPath,
    ], { cwd: origin, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    fs.rmSync(origin, { recursive: true, force: true });

    const match = spawnSync(process.execPath, [
      executable,
      "match",
      "--pattern", patternPath,
      "--tsconfig", "tsconfig.json",
      "--semantics", "strict",
      "--pretty",
    ], { cwd: target, encoding: "utf8" });
    assert.equal(match.status, 0, match.stderr);
    assert.deepEqual(JSON.parse(match.stdout).matches.map((entry) => entry.text), ['second("two");']);
  });

  it("returns status 2 for a fail-empty run", () => {
    const cwd = createProject({
      "example.ts": `/* ast-xpath-root */ const value = 1;`,
    });
    const result = spawnSync(process.execPath, [
      executable,
      "run",
      "--example", "src/example.ts",
      "--source", "src/no-such-file-*.ts",
      "--fail-empty",
    ], { cwd, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).summary.matches, 0);
  });
});
