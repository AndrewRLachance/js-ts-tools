const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { runEffectCodemod, effectCodemod } = require("../dist");
const { parseEffectCodemodArgs, mainEffectCodemod } = require("../bin/effect-v3-codemod-cli");

const source = `import { Effect } from "effect";
export const self = Effect.succeed(1);
export const result = Effect.flatMap(self, (value) => Effect.succeed(value + 1));
`;

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "effect-codemod-integration-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const project = path.join(cwd, "packages/app");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(path.join(project, "node_modules"));
  fs.symlinkSync(path.resolve(__dirname, "../node_modules/effect"), path.join(project, "node_modules/effect"), "dir");
  fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "Node16", moduleResolution: "Node16", types: [], skipLibCheck: true },
    include: ["src/**/*.ts"],
  }));
  fs.writeFileSync(path.join(project, "src/input.ts"), source);
  return { cwd, project, input: path.join(project, "src/input.ts") };
}

test("effect-v3-codemod validates its CLI options and exposes all production targets", () => {
  assert.deepEqual(parseEffectCodemodArgs(["--help"]), { help: true });
  assert.throws(() => parseEffectCodemodArgs([]), /--source/);
  for (const args of [["--max-passes", "0"], ["--max-passes", "11"], ["--max-passes", "1.5"], ["--max-passes", "invalid"], ["--wat"], ["--target", "missing"], ["--write", "--dry-run"], ["--cwd", "a", "--cwd", "b"], ["--target"]]) {
    assert.throws(() => parseEffectCodemodArgs(["--source", "src/*.ts", ...args]));
  }
  const options = parseEffectCodemodArgs(["--source", "src/*.ts", "--source", "lib/*.ts", "--target", "map", "--no-review", "--pretty"]);
  assert.deepEqual(options.sources, ["src/*.ts", "lib/*.ts"]);
  assert.deepEqual(options.targets, ["map"]);
  assert.equal(options.maxPasses, 3);
  assert.equal(parseEffectCodemodArgs(["--source", "*.ts", "--max-passes", "1"]).maxPasses, 1);
  assert.equal(options.write, false);
  assert.equal(options.includeReview, false);
  assert.equal(new Set(effectCodemod.PRODUCTION_RULES.map((rule) => rule.target)).size, effectCodemod.ALL_EFFECT_TARGETS.length);
  assert.throws(() => runEffectCodemod({ targets: ["missing"] }), /Unknown Effect target/);
  assert.throws(() => runEffectCodemod({ sources: [] }), /source glob/);
});

test("real adapters correlate nested tsconfig paths, validate previews and commit through the CLI", (t) => {
  const { cwd, input } = fixture(t);
  const options = { cwd, tsconfig: "packages/app/tsconfig.json", sources: ["packages/app/src/**/*.ts"], targets: ["map"] };
  t.mock.method(effectCodemod.NodeSourcePort.prototype, "write", () => { throw new Error("Preview attempted to write source"); });
  const before = fs.statSync(input, { bigint: true });
  const preview = runEffectCodemod(options);
  assert.equal(fs.statSync(input, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(preview.summary.valid, true, JSON.stringify(preview.validation));
  assert.equal(preview.summary.converted, 1, JSON.stringify(preview.candidates));
  assert.equal(preview.summary.written, false);
  assert.equal(preview.files[0].filePath, input);
  assert.match(preview.files[0].editedText, /Effect\.map\(self,/);
  assert.equal(fs.readFileSync(input, "utf8"), source);

  const cli = path.resolve(__dirname, "../bin/effect-v3-codemod-cli.js");
  const args = ["--cwd", cwd, "--tsconfig", options.tsconfig, "--source", options.sources[0], "--target", "map"];
  const invoke = (...tail) => {
    const result = spawnSync(process.execPath, [cli, ...tail], { cwd: __dirname, encoding: "utf8" });
    assert.ifError(result.error);
    return result;
  };
  assert.equal(invoke("--help").status, 0);
  assert.equal(invoke("--unknown").status, 1);
  const outputExists = invoke(...args, "--write", "--out", input);
  assert.equal(outputExists.status, 1);
  assert.equal(fs.readFileSync(input, "utf8"), source);
  const written = invoke(...args, "--write", "--pretty", "--out", "report.json");
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, "");
  const report = JSON.parse(fs.readFileSync(path.join(cwd, "report.json"), "utf8"));
  assert.equal(report.summary.written, true);
  assert.equal(fs.readFileSync(input, "utf8"), preview.files[0].editedText);
  const again = runEffectCodemod(options);
  assert.equal(again.summary.changedFiles, 0);
});

test("real adapters honor exclusions and reconcile imports with absolute candidate paths", (t) => {
  const { cwd, input } = fixture(t);
  const request = { cwd, tsconfig: "packages/app/tsconfig.json", sources: ["packages/app/src/**/*.ts"], excludes: [] };
  const discovered = new effectCodemod.JsTsToolsDiscoveryPort().discover(request, [{ id: "calls", tsquery: "CallExpression" }]);
  assert.ok(discovered.length > 0);
  assert.ok(discovered.every((candidate) => candidate.filePath === input));
  assert.deepEqual(new effectCodemod.JsTsToolsDiscoveryPort().discover({ ...request, excludes: ["input.ts"] }, [{ id: "calls", tsquery: "CallExpression" }]), []);
  const edits = new effectCodemod.JsTsToolsImportPort().plan(request, input, source, [{ moduleSpecifier: "effect", importedName: "Effect", localName: "Effect" }]);
  assert.deepEqual(edits, []);
});


test("CLI failures clean up reserved reports and reject report paths that would create source files", (t) => {
  const { cwd } = fixture(t);
  t.mock.method(process.stderr, "write", () => true);
  const output = path.join(cwd, "report.json");
  const args = ["--source", "*.ts", "--tsconfig", "missing.json", "--out", output];
  assert.equal(mainEffectCodemod(args, cwd), 1);
  assert.equal(fs.existsSync(output), false);
  fs.writeFileSync(output, "existing report");
  assert.equal(mainEffectCodemod(args, cwd), 1);
  assert.equal(fs.readFileSync(output, "utf8"), "existing report");
  const newSource = path.join(cwd, "packages/app/src/report.ts");
  assert.equal(mainEffectCodemod(["--source", "packages/app/src/**/*.ts", "--out", newSource], cwd), 1);
  assert.equal(fs.existsSync(newSource), false);
});
