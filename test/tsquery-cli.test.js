"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const {
  applyTextEdits,
  coalesceDeleteEdits,
  globToRegExp,
  parseArgs,
  run,
} = require("../dist/tools/tsquery-cli");

describe("globToRegExp", () => {
  it("matches ** across zero or more directories", () => {
    const pattern = globToRegExp("src/**/*.ts");
    assert.equal(pattern.test("src/a.ts"), true);
    assert.equal(pattern.test("src/lib/a.ts"), true);
    assert.equal(pattern.test("test/a.ts"), false);
  });
});

describe("applyTextEdits", () => {
  it("applies edits using original offsets", () => {
    const source = "const a = 1;\nconst b = 2;\n";
    const result = applyTextEdits(source, [
      { start: 0, end: 0, replacement: "// header\n" },
      { start: 13, end: 25, replacement: "const b = 3;" },
    ]);
    assert.equal(result, "// header\nconst a = 1;\nconst b = 3;\n");
  });
});

describe("coalesceDeleteEdits", () => {
  it("merges nested and overlapping deletion ranges", () => {
    assert.deepEqual(
      coalesceDeleteEdits([
        { start: 10, end: 20, replacement: "" },
        { start: 12, end: 15, replacement: "" },
        { start: 19, end: 25, replacement: "" },
      ]),
      [{ start: 10, end: 25, replacement: "" }],
    );
  });
});

describe("parseArgs", () => {
  it("parses a query invocation", () => {
    const parsed = parseArgs([
      'CallExpression > Identifier[name="fetch"]',
      "--source",
      "src/**/*.ts",
      "--pretty",
    ]);
    assert.equal("help" in parsed, false);
    if ("help" in parsed) return;
    assert.equal(parsed.selector, 'CallExpression > Identifier[name="fetch"]');
    assert.deepEqual(parsed.sources, ["src/**/*.ts"]);
    assert.equal(parsed.pretty, true);
  });

  it("loads insertion snippets from a file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tsquery-cli-"));
    fs.writeFileSync(path.join(cwd, "snippet.ts"), "@dec()\n");
    const parsed = parseArgs([
      "MethodDeclaration",
      "--insert-before-file",
      "snippet.ts",
    ], cwd);
    assert.equal("help" in parsed, false);
    if ("help" in parsed) return;
    assert.deepEqual(parsed.mutation, { kind: "insert-before", text: "@dec()\n" });
  });

  it("rejects multiple mutation modes", () => {
    assert.throws(
      () => parseArgs(["Identifier", "--delete", "--insert-after", ";"]),
      /mutually exclusive/,
    );
  });
});

describe("mutation integration", () => {
  it("previews by default and only changes source with --write", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tsquery-cli-project-"));
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    const sourcePath = path.join(cwd, "src", "input.ts");
    fs.writeFileSync(sourcePath, "const removeMe = 1;\n");

    const preview = parseArgs([
      "VariableStatement",
      "--source", "src/**/*.ts",
      "--delete",
      "--out", "preview.json",
    ], cwd);
    assert.equal("help" in preview, false);
    if ("help" in preview) return;
    assert.equal(run(preview, cwd), 0);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "const removeMe = 1;\n");

    const apply = parseArgs([
      "VariableStatement",
      "--source", "src/**/*.ts",
      "--delete",
      "--write",
      "--out", "applied.json",
    ], cwd);
    assert.equal("help" in apply, false);
    if ("help" in apply) return;
    assert.equal(run(apply, cwd), 0);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "\n");
  });

  it("rejects a report path that would overwrite a matched source file", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tsquery-cli-collision-"));
    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
    const sourcePath = path.join(cwd, "src", "input.ts");
    fs.writeFileSync(sourcePath, "const keepMe = 1;\n");

    const parsed = parseArgs([
      "VariableStatement",
      "--delete",
      "--write",
      "--out", "src/input.ts",
    ], cwd);
    assert.equal("help" in parsed, false);
    if ("help" in parsed) return;
    assert.throws(() => run(parsed, cwd), /--out cannot overwrite a matched source file/);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "const keepMe = 1;\n");
  });
});

describe("executable exit statuses", () => {
  const executable = path.resolve(__dirname, "../bin/tsquery-cli.js");

  it("exits with status 1 for invalid arguments", () => {
    const result = spawnSync(process.execPath, [executable], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing TSQuery selector/);
  });

  it("exits with status 2 when --fail-empty finds no matches", () => {
    const result = spawnSync(process.execPath, [
      executable,
      'InterfaceDeclaration[name="__no_such_interface_83924"]',
      "--source", "src/**/*.ts",
      "--fail-empty",
    ], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "[]\n");
  });
});
