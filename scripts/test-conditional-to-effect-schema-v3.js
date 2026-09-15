#!/usr/bin/env node
"use strict";

// Build this checkout first: npm run build
// This exercises code generation only: it never imports or runs target code.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const ts = require("typescript");
const fg = require("fast-glob");

const defaultSource = path.resolve(__dirname,
  "../../alternate-templating/effect-native-constrained-synthesis-v0.1.1/src");

function discover(files) {
  const candidates = [];
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const consider = (name, node) => {
      if (!node.body || node.parameters.length !== 1) return;
      let throws = false;
      const visit = (child) => {
        if (child !== node && ts.isFunctionLike(child)) return;
        if (ts.isThrowStatement(child)) throws = true;
        ts.forEachChild(child, visit);
      };
      visit(node);
      if (throws || /^(validate|assert|check|verify|require)[A-Z_]/.test(name)) {
        candidates.push({
          target: name,
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    };
    // Intentionally limited to named top-level functions and function variables.
    // Use --target for methods, nested functions, or other naming conventions.
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        consider(statement.name.text, statement);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const init = declaration.initializer;
          if (ts.isIdentifier(declaration.name) && init
            && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            consider(declaration.name.text, init);
          }
        }
      }
    }
  }
  return candidates;
}

function main() {
  const { values } = parseArgs({ options: {
    "source-dir": { type: "string", default: defaultSource },
    tsconfig: { type: "string" },
    target: { type: "string", multiple: true },
    "base-schema": { type: "string", default: "Schema.Unknown" },
    mode: { type: "string", default: "auto" },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log(`Usage: node scripts/test-conditional-to-effect-schema-v3.js [options]

  --source-dir <dir>       Default: ${defaultSource}
  --tsconfig <file>        Default: tsconfig.json beside the source directory
  --target <symbol>        Repeatable; otherwise discover one-argument candidates
  --base-schema <expr>     Default: Schema.Unknown (preview placeholder only)
  --mode <mode>            auto (default), static, or runtime-wrapper
  --out <new-directory>    Default: a new temporary directory

Writes report.json and numbered .ts.txt schema previews. Target errors are
recorded and processing continues; exit status is 1 if any conversion fails.
Discovery is heuristic, not proof that a function is a pure validator.
Generated snippets need a base schema enforcing the original input type;
runtime wrappers also need the original validator in scope. Target functions
are never executed. This is a conversion smoke test, not an equivalence test.`);
    return;
  }

  if (!["auto", "static", "runtime-wrapper"].includes(values.mode)) {
    throw new Error(`Invalid mode: ${values.mode}`);
  }
  if (!values["base-schema"].trim()) throw new Error("--base-schema must not be empty");
  const sourceDir = fs.realpathSync(path.resolve(values["source-dir"]));
  if (!fs.statSync(sourceDir).isDirectory()) throw new Error("--source-dir must be a directory");
  const tsconfig = fs.realpathSync(values.tsconfig
    ? path.resolve(values.tsconfig) : path.join(path.dirname(sourceDir), "tsconfig.json"));
  const cwd = path.dirname(tsconfig);
  const files = fg.sync("**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", {
    cwd: sourceDir, absolute: true, onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
  }).sort();
  if (!files.length) throw new Error(`No source files found in ${sourceDir}`);
  const candidates = values.target
    ? [...new Set(values.target)].map((target) => ({ target })) : discover(files);
  if (!candidates.length) throw new Error("No candidates discovered; select a function with --target");

  // Resolve the package root's public API from this checkout, independent of cwd.
  const { convertConditionalToEffectSchemaV3 } = require("..");
  const out = values.out ? path.resolve(values.out)
    : fs.mkdtempSync(path.join(os.tmpdir(), "conditional-to-effect-schema-v3-"));
  if (values.out) fs.mkdirSync(out); // Refuse to overwrite an existing run.
  const options = {
    cwd, sourceGlob: files, tsConfigFilePath: tsconfig,
    baseSchema: values["base-schema"], mode: values.mode,
    allowOpaqueCalls: false,
  };
  const report = {
    sourceDir, options, filesScanned: files.length,
    note: "Code-generation smoke test only. Schema.Unknown is a preview placeholder, not an inferred input schema. Candidates may have side effects. No target code or generated code was executed or typechecked.",
    summary: { candidates: candidates.length, static: 0, runtimeWrapper: 0, failed: 0, constraints: 0 },
    results: [],
  };
  console.log(`Scanning ${files.length} files; converting ${candidates.length} candidates.\nOutput: ${out}`);
  for (const [index, candidate] of candidates.entries()) {
    const started = performance.now();
    let result;
    try {
      result = convertConditionalToEffectSchemaV3({ ...options, target: candidate.target });
    } catch (error) {
      report.summary.failed++;
      report.results.push({ ...candidate, status: "failed", error: String(error.message ?? error) });
      console.log(`[${index + 1}/${candidates.length}] ${candidate.target}: failed (${String(error.message ?? error).split("\n")[0]})`);
    }
    if (result) {
      const snippet = `${String(index + 1).padStart(3, "0")}-${result.schemaName}.ts.txt`;
      fs.writeFileSync(path.join(out, snippet), result.code, { flag: "wx" });
      report.summary[result.mode === "static" ? "static" : "runtimeWrapper"]++;
      report.summary.constraints += result.constraints.length;
      report.results.push({ ...candidate, status: "converted", snippet, result });
      console.log(`[${index + 1}/${candidates.length}] ${candidate.target}: ${result.mode} (${result.diagnostics.length} diagnostics)`);
    }
    report.results.at(-1).durationMs = Math.round(performance.now() - started);
    // Checkpoint each result so long batch runs remain inspectable.
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Report: ${path.join(out, "report.json")}`);
  if (report.summary.failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.message ?? error);
  process.exitCode = 1;
}
