const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const ts = require("typescript");
const { Schema, Either } = require("effect");
const { convertConditionalToEffectSchemaV3: convert } = require("../dist");
const { parseConditionalToEffectSchemaV3Args: parse } = require("../bin/conditional-to-effect-schema-v3-cli");

const source = `
export function simple(value: number) {
  if (value < 0) throw new Error("negative");
  if (value > 10) throw new Error("too large");
}
function helper(value: number) { if (value % 2) throw "odd"; }
export function nested(value: number) {
  if (value === 0) return;
  const shifted = value + 1;
  if (value > 0) helper(shifted);
  else if (value < -5) throw new Error("too small");
}
export function mutation(value: number) { value++; if (value < 1) throw new Error("small"); }
export function defaults(value = 3) { if (value < 1) throw new Error("small"); }
function restHelper(...values: number[]) { if (values.length !== 1) throw new Error("arity"); }
export function rest(value: number) { restHelper(value); }
export function caught(value: number) { try { throw new Error("caught"); } catch {} }
export function finallyReturn(value: number) { try { throw new Error("caught"); } finally { return; } }
const limit = 3;
export function external(value: number) { if (value < limit) throw new Error("small"); }
function positive(value: number) { return value > 0; }
export function valueCall(value: number) { if (positive(value)) throw new Error("positive"); }
export function constructed(value: number) { new URL(String(value)); }
export function asyncValidator(value: number) { return Promise.reject(new Error("async")); }
export async function explicitlyAsync(value: number) { if (value < 0) throw new Error("async"); }
export function* generator(value: number) { if (value < 0) throw new Error("generator"); }
export function destructured({ value }: { value: number }) { if (value < 0) throw new Error("negative"); }
export function loop(value: number) { while (value > 0) { if (value === 2) throw new Error("two"); value--; } }
export function recursive(value: number) { if (value > 0) recursive(value - 1); }
export const validators = { check(value: number) { if (value < 0) throw new Error("negative"); } };
export class Validator { check(value: number) { if (value < 0) throw new Error("negative"); } }
export function opaque(value: number) { console.log(value); if (value < 0) throw new Error("negative"); }
export function zero() { throw new Error("zero"); }
export const named = function internal(value: number) { if (value < 0) throw new Error("negative"); };
export const otherValidators = { unique(value: number) { if (value < 0) throw new Error("negative"); } };
`;

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "conditional-schema-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "input.ts"), source);
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", types: [], skipLibCheck: true },
    include: ["*.ts"],
  }));
  return cwd;
}

function options(cwd, target, extra = {}) {
  return { cwd, target, sourceGlob: "*.ts", baseSchema: "Schema.Number", ...extra };
}

function load(result) {
  const output = ts.transpileModule(source + "\n" + result.code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.deepEqual(output.diagnostics, []);
  const module = { exports: {} };
  new Function("require", "module", "exports", output.outputText)(require, module, module.exports);
  return module.exports;
}

function compare(result, values, validatorName = result.target) {
  const exports = load(result);
  const validator = validatorName.split(".").reduce((value, key) => value[key], exports);
  const schema = exports[result.schemaName];
  for (const input of values) {
    let accepted = true;
    try { validator(input); } catch { accepted = false; }
    assert.equal(Either.isRight(Schema.decodeUnknownEither(schema)(input)), accepted, `${result.target}: ${input}`);
  }
}

test("static filters preserve branches, early returns, const bindings and local call arguments", (t) => {
  const cwd = fixture(t);
  for (const target of ["simple", "nested"]) {
    const result = convert(options(cwd, target));
    assert.equal(result.mode, "static");
    assert.deepEqual(result.diagnostics, []);
    compare(result, [-10, -5, -1, 0, 1, 2, 3, 10, 11]);
  }
  const nested = convert(options(cwd, "nested"));
  assert.ok(nested.constraints.some((c) => c.callPath.join(" -> ") === "nested -> helper"));
});

test("unsafe static conversions fail and auto wrappers preserve synchronous behavior", (t) => {
  const cwd = fixture(t);
  for (const target of ["mutation", "defaults", "rest", "caught", "finallyReturn", "external", "valueCall", "constructed", "loop"]) {
    assert.throws(() => convert(options(cwd, target)), /Static Effect Schema conversion/);
    const result = convert(options(cwd, target, { mode: "auto" }));
    assert.equal(result.mode, "runtime-wrapper", target);
    assert.ok(result.diagnostics.length > 0);
    compare(result, [-1, 0, 1, 2, 3, 10]);
  }
});

test("wrappers support destructuring and resolve the selected qualified name", (t) => {
  const cwd = fixture(t);
  const result = convert(options(cwd, "destructured", { mode: "auto", baseSchema: "Schema.Struct({ value: Schema.Number })" }));
  compare(result, [{ value: -1 }, { value: 1 }]);
  const qualified = convert(options(cwd, "validators.check", { mode: "runtime-wrapper" }));
  compare(qualified, [-1, 0, 1]);
  const simpleName = convert(options(cwd, "unique", { mode: "runtime-wrapper" }));
  assert.equal(simpleName.target, "otherValidators.unique");
  compare(simpleName, [-1, 0, 1]);
  compare(convert(options(cwd, "named", { mode: "runtime-wrapper" })), [-1, 0, 1]);
  assert.throws(() => convert(options(cwd, "Validator.check", { mode: "runtime-wrapper" })), /instance methods/);
});

test("async, Promise-returning, generator and wrong-arity validators are rejected", (t) => {
  const cwd = fixture(t);
  for (const target of ["asyncValidator", "explicitlyAsync", "generator", "zero"]) {
    for (const mode of ["static", "auto", "runtime-wrapper"]) {
      assert.throws(() => convert(options(cwd, target, { mode })), /async|generator|one-argument|arity/i);
    }
  }
});

test("call depth, recursion, opaque calls and options are validated", (t) => {
  const cwd = fixture(t);
  assert.throws(() => convert(options(cwd, "nested", { maxCallDepth: 0 })), /max-call-depth/);
  assert.throws(() => convert(options(cwd, "recursive")), /recursive-call/);
  assert.throws(() => convert(options(cwd, "opaque")), /opaque-call/);
  assert.equal(convert(options(cwd, "opaque", { allowOpaqueCalls: true })).mode, "static");
  assert.throws(() => convert(options(cwd, "simple", { mode: "typo" })), /Invalid mode/);
  for (const schemaName of ["bad-name", "class", "Schema"]) {
    assert.throws(() => convert(options(cwd, "simple", { schemaName })), /Invalid schemaName/);
  }
});

test("CLI parsing rejects unknown, duplicate, missing and invalid options", () => {
  const required = ["--target", "simple", "--source", "*.ts", "--base-schema", "Schema.Number"];
  assert.deepEqual(parse(["--help"]), { help: true });
  assert.throws(() => parse([]), /Missing required option/);
  for (const tail of [["--typo", "yes"], ["--target", "other"], ["--mode", "wrong"], ["--max-depth", "-1"], ["--allow-opaque-calls", "yes"], ["--source"], ["--pretty"]]) {
    assert.throws(() => parse([...required, ...tail]));
  }
  assert.deepEqual(parse([...required, "--source", "other/*.ts"]).sourceGlob, ["*.ts", "other/*.ts"]);
});

test("selected files outside tsconfig are indexed and unselected helpers remain opaque", (t) => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, "helper.ts"), 'export function check(x: number) { if (x < 0) throw new Error("negative"); }');
  fs.writeFileSync(path.join(cwd, "entry.ts"), 'import { check } from "./helper"; export function validate(x: number) { check(x); }');
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [] }, files: ["input.ts"] }));
  assert.throws(() => convert(options(cwd, "validate", { sourceGlob: "entry.ts" })), /opaque-call/);
  const result = convert(options(cwd, "validate", { sourceGlob: ["entry.ts", "helper.ts"] }));
  assert.equal(result.constraints.length, 1);
  assert.deepEqual(result.constraints[0].callPath, ["validate", "check"]);
  assert.throws(() => convert(options(cwd, "validate", { sourceGlob: "*.ts", excludePathIncludes: ["helper.ts"] })), /opaque-call/);
});

test("generated static and runtime snippets typecheck against Effect v3", (t) => {
  const cwd = fixture(t);
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.symlinkSync(path.resolve(__dirname, "../node_modules/effect"), path.join(cwd, "node_modules/effect"), "dir");
  const statically = convert(options(cwd, "nested"));
  const wrapped = convert(options(cwd, "mutation", { mode: "auto" }));
  fs.writeFileSync(path.join(cwd, "generated.ts"), source + "\n" + statically.code + "\n" + wrapped.code.replace('import { Schema } from "effect"', ""));
  const program = ts.createProgram([path.join(cwd, "generated.ts")], {
    strict: true, skipLibCheck: true, noEmit: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

test("installed CLI emits code/JSON, reports failure and refuses to overwrite files", (t) => {
  const cwd = fixture(t);
  const cli = path.resolve(__dirname, "../bin/conditional-to-effect-schema-v3-cli.js");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
    assert.ifError(result.error);
    return result;
  };
  const args = ["--target", "simple", "--base-schema", "Schema.Number", "--source", "*.ts"];
  assert.equal(run("--help").status, 0);
  assert.equal(run().status, 1);
  const code = run(...args);
  assert.equal(code.status, 0, code.stderr);
  assert.match(code.stdout, /export const simpleSchema/);
  const json = run(...args, "--format", "json", "--pretty");
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).constraints.length, 2);
  const out = run(...args, "--out", "generated/schema.txt");
  assert.equal(out.status, 0, out.stderr);
  assert.equal(fs.readFileSync(path.join(cwd, "generated/schema.txt"), "utf8"), code.stdout);
  assert.equal(run(...args, "--out", "input.ts").status, 1);
  assert.equal(fs.readFileSync(path.join(cwd, "input.ts"), "utf8"), source);
  assert.equal(require("../package.json").bin["conditional-to-effect-schema-v3"], "./bin/conditional-to-effect-schema-v3-cli.js");
});
