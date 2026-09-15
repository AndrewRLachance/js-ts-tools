const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");
const { Cause, Effect, Exit } = require("effect");
const { runEffectCodemod, effectCodemod } = require("../dist");
const { compactEvidence } = require("../dist/tools/effect-codemod/core/report");

const code = `import { Effect } from "effect";
export const mapped = Effect.flatMap((n: number) => Effect.succeed(n + 1));
export const mappedError = Effect.catchAll((e: string) => Effect.fail(e.length));
export const constant = Effect.map(() => 123);
export const discarded = Effect.map(() => void 0);
export const asyncConstant = Effect.map(async () => 123);
export const asyncDiscarded = Effect.map(async () => void 0);
export const asyncFirst = Effect.map(Effect.succeed(1), async () => 123);
export let evaluations = 0;
const replacement = () => { evaluations++; return "replacement"; };
export const replaced = Effect.mapError(() => replacement());
export const replacedFirst = Effect.mapError(Effect.fail("original"), () => replacement());
export const usesError = Effect.mapError((error: string) => error.toUpperCase());
export const usesArguments = Effect.mapError(function () { return arguments[0]; });
export const unrelated = (Effect: { mapError: (f: () => string) => string }) => Effect.mapError(() => "other");
export const nested = Effect.gen(function* () { return yield* Effect.fail("nested").pipe(replaced); });
`;

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "effect-curried-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "node_modules"));
  fs.symlinkSync(path.resolve(__dirname, "../node_modules/effect"), path.join(cwd, "node_modules/effect"), "dir");
  fs.writeFileSync(path.join(cwd, "input.ts"), code);
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [], target: "ES2022", module: "Node16", moduleResolution: "Node16", skipLibCheck: true }, include: ["*.ts"] }));
  return cwd;
}

function load(source) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  new Function("require", "module", "exports", output.outputText)(require, module, module.exports);
  return module.exports;
}

test("curried conversions preserve values and leave error replacement for review", (t) => {
  const cwd = fixture(t);
  const report = runEffectCodemod({ cwd, sources: ["*.ts"], targets: ["map", "mapError", "as", "asVoid", "orElseFail"] });
  assert.equal(report.summary.valid, true, JSON.stringify(report.validation));
  assert.equal(report.summary.converted, 4, JSON.stringify(report.candidates.map(({ target, status, reason }) => ({ target, status, reason }))));
  assert.equal(report.summary.review, 2);
  const edited = report.files[0].editedText;
  assert.match(edited, /mapped = Effect\.map\(/);
  assert.match(edited, /mappedError = Effect\.mapError\(/);
  assert.match(edited, /constant = Effect\.as\(123\)/);
  assert.match(edited, /discarded = Effect\.asVoid;/);
  assert.ok(edited.includes('replaced = Effect.mapError(() => replacement())'));
  assert.ok(edited.includes('asyncConstant = Effect.map(async () => 123)'));
  assert.ok(edited.includes('asyncDiscarded = Effect.map(async () => void 0)'));
  assert.ok(edited.includes('asyncFirst = Effect.map(Effect.succeed(1), async () => 123)'));
  assert.ok(edited.includes('usesError = Effect.mapError((error: string) => error.toUpperCase())'));
  assert.ok(edited.includes('usesArguments = Effect.mapError(function () { return arguments[0]; })'));
  assert.ok(edited.includes('=> Effect.mapError(() => "other")'));
  assert.equal(fs.readFileSync(path.join(cwd, "input.ts"), "utf8"), code);
  assert.ok(report.candidates.every((candidate) => candidate.line > 0 && candidate.column > 0));
  assert.equal(report.summary.skipReasons.reduce((sum, item) => sum + item.count, 0), report.summary.skipped);
  for (const source of [code, edited]) {
    const values = load(source);
    assert.equal(values.evaluations, 0);
    assert.equal(Effect.runSync(values.replaced(Effect.succeed(7))), 7);
    assert.equal(values.evaluations, 0);
    assert.equal(Effect.runSync(values.mapped(Effect.succeed(2))), 3);
    assert.equal(Effect.runSync(values.constant(Effect.succeed(2))), 123);
    assert.equal(Effect.runSync(values.discarded(Effect.succeed(2))), undefined);
    assert.ok(Effect.runSync(values.asyncConstant(Effect.succeed(2))) instanceof Promise);
    assert.ok(Effect.runSync(values.asyncDiscarded(Effect.succeed(2))) instanceof Promise);
    assert.equal(Effect.runSync(Effect.flip(values.mappedError(Effect.fail("bad")))), 3);
    assert.equal(Effect.runSync(Effect.flip(values.replaced(Effect.fail("old")))), "replacement");
    assert.equal(values.evaluations, 1);
    assert.equal(Effect.runSync(Effect.flip(values.replacedFirst)), "replacement");
    assert.equal(values.evaluations, 2);
    const defect = Effect.runSyncExit(values.replaced(Effect.die("defect")));
    assert.ok(Exit.isFailure(defect));
    assert.equal(values.evaluations, 2);
  }
});

test("orElseFail review suggestions are never written because compound causes differ", (t) => {
  const cwd = fixture(t);
  const report = runEffectCodemod({ cwd, sources: ["*.ts"], targets: ["orElseFail"], write: true });
  assert.equal(report.summary.converted, 0);
  assert.equal(report.summary.review, 2);
  assert.equal(report.files.length, 0);
  assert.equal(fs.readFileSync(path.join(cwd, "input.ts"), "utf8"), code);
  assert.ok(report.candidates.filter((item) => item.status === "review").every((item) => item.reason.includes("compound causes")));
  const combined = Effect.failCause(Cause.parallel(Cause.fail("old"), Cause.die("defect")));
  assert.equal(Effect.runSync(Effect.flip(Effect.mapError(combined, () => "replacement"))), "replacement");
  const alternative = Effect.runSyncExit(Effect.orElseFail(combined, () => "replacement"));
  assert.ok(Exit.isFailure(alternative));
  assert.ok(Array.from(Cause.defects(alternative.cause)).length > 0);
});

test("production discovery selects the callee rather than matching enclosing calls or arrays", (t) => {
  const cwd = fixture(t);
  fs.writeFileSync(path.join(cwd, "input.ts"), 'import { Effect } from "effect"; Effect.gen(function* () { yield* Effect.succeed(1).pipe(Effect.flatMap(n => Effect.succeed(n))); }); [1].map(n => n);');
  const selectors = effectCodemod.PRODUCTION_RULES.find((rule) => rule.id === "effect.map.from-flatMap-succeed").selectors;
  const candidates = new effectCodemod.JsTsToolsDiscoveryPort().discover({ cwd, tsconfig: "tsconfig.json", sources: ["*.ts"], excludes: [] }, selectors);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].text, 'Effect.flatMap(n => Effect.succeed(n))');
  const allCandidates = new effectCodemod.JsTsToolsDiscoveryPort().discover(
    { cwd, tsconfig: "tsconfig.json", sources: ["*.ts"], excludes: [] },
    effectCodemod.PRODUCTION_RULES.flatMap((rule) => rule.selectors),
  );
  assert.equal(allCandidates.filter((item) => item.selectorId === selectors[0].id).length, 1);
  assert.ok(allCandidates.every((item) => item.text.startsWith("Effect.flatMap") || item.text.startsWith("Effect.gen")));
});

test("compact evidence retains exact call identity without nested compiler records", () => {
  const callSite = { id: "call", kind: "call", location: { filePath: "a.ts", line: 1, column: 1 }, resolution: "resolved", calleeSymbolId: "symbol", resultTypeId: "type", raw: { duplicate: "payload" } };
  const facts = [
    { kind: "call-site", summary: "exact", data: { strength: "exact", callSite } },
    { kind: "call-site", summary: "nested", data: { strength: "contained", callSite } },
    { kind: "binding", summary: "proven", data: "symbol" },
  ];
  const compact = compactEvidence(facts);
  assert.equal(compact.length, 2);
  assert.equal(compact[0].data.callSite.calleeSymbolId, "symbol");
  assert.equal(compact[0].data.callSite.raw, undefined);
  assert.equal(facts[0].data.callSite.raw.duplicate, "payload");
});
