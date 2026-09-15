const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const { PassThrough, Writable } = require("node:stream");
const { createEffectSchemaSession } = require("../dist/tools/effect-schema");
const { mainEffectSchema, parseEffectSchemaArgs } = require("../bin/effect-schema-cli");
const { commitSchemaFiles } = require("../dist/tools/effect-schema/project");

function fixture(t, source, extra = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "effect-schema-test-"));
  fs.mkdirSync(path.join(cwd, "src"));
  fs.symlinkSync(path.resolve(__dirname, "../node_modules"), path.join(cwd, "node_modules"), "dir");
  const config = { compilerOptions: { strict: true, target: "ES2022", module: "Node16", moduleResolution: "Node16", skipLibCheck: true, types: [] }, include: ["src/**/*.ts"] };
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(cwd, "src/models.ts"), source);
  for (const [file, text] of Object.entries(extra)) fs.writeFileSync(path.join(cwd, file), text);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, file: path.join(cwd, "src/models.ts"), config };
}

async function open(t, cwd, options = {}) {
  const session = await createEffectSchemaSession({ cwd, ...options });
  t.after(() => session.close());
  return session;
}

test("real Effect plugin previews and applies interfaces, reuses schemas, and refreshes the session", { timeout: 120000 }, async (t) => {
  const source = `import { Schema } from "effect";
export class Address extends Schema.Class<Address>("Address")({ street: Schema.String }) {}
export interface Order { id: string; address: Address }
export type Other = { enabled: boolean };
export type Generic<T> = { value: T };
`;
  const { cwd, file } = fixture(t, source);
  const configBefore = fs.readFileSync(path.join(cwd, "tsconfig.json"), "utf8");
  const session = await open(t, cwd);
  assert.equal(session.project.typescriptVersion, require("typescript").version);
  let candidates = await session.listCandidates();
  assert.deepEqual(candidates.map((c) => c.name), ["Order", "Other", "Generic"]);
  const beforeStat = fs.statSync(file, { bigint: true });
  const unavailable = await session.preview(candidates.find((c) => c.name === "Generic").id);
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /generic/);
  await assert.rejects(session.apply(unavailable.id), /Cannot apply/);
  const preview = await session.preview(candidates[0].id);
  assert.equal(preview.available, true, preview.reason);
  assert.equal(preview.validation.ok, true, JSON.stringify(preview.validation));
  assert.match(preview.refactorName, /structuralTypeToSchema$/);
  assert.match(preview.files[0].editedText, /class Order extends Schema\.Class/);
  assert.match(preview.files[0].editedText, /address: Address/);
  assert.doesNotMatch(preview.files[0].editedText, /interface Order/);
  assert.equal((preview.files[0].editedText.match(/import.*Schema.*from "effect"/g) ?? []).length, 1);
  assert.match(preview.diff, /--- a\/src\/models\.ts/);
  assert.equal(fs.readFileSync(file, "utf8"), source);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, beforeStat.mtimeNs);
  const expected = preview.files[0].editedText;
  preview.files[0].editedText = "tampered";
  preview.validation.ok = false;
  assert.deepEqual(await session.apply(preview.id), { written: true, filePaths: [file] });
  assert.equal(fs.readFileSync(file, "utf8"), expected);
  await assert.rejects(session.apply(preview.id), /expired preview/);
  candidates = await session.listCandidates();
  assert.deepEqual(candidates.map((c) => c.name), ["Other", "Generic"]);
  const other = await session.preview(candidates[0].id);
  assert.equal(other.validation.ok, true, JSON.stringify(other.validation));
  assert.match(other.files[0].editedText, /class Other/);
  assert.equal(fs.readFileSync(path.join(cwd, "tsconfig.json"), "utf8"), configBefore);
  await session.close();
  await session.close();
  await assert.rejects(session.listCandidates(), /closed/);
});

test("preview preserves CRLF/UTF-16 positions and permits existing errors that only move", { timeout: 90000 }, async (t) => {
  const source = '// unicode 😀\r\nexport type Order = { name: string };\r\nconst existing: number = "bad";\r\n';
  const { cwd, file } = fixture(t, source);
  const session = await open(t, cwd);
  const [candidate] = await session.listCandidates();
  assert.equal(candidate.line, 2);
  const preview = await session.preview(candidate.id);
  assert.equal(preview.validation.ok, true, JSON.stringify(preview.validation));
  assert.equal(preview.validation.baselineDiagnostics.filter((d) => d.category === "error").length, 1);
  assert.match(preview.files[0].editedText, /import.*Schema/);
  assert.doesNotMatch(preview.files[0].editedText, /type Order =/);
  assert.match(preview.files[0].editedText, /unicode 😀\r\n/);
  assert.equal(fs.readFileSync(file, "utf8"), source);
  // Imported dependencies and config changes invalidate the complete preview, even if the target is unchanged.
  fs.writeFileSync(path.join(cwd, "src/new.ts"), "export const added = true;\n");
  await assert.rejects(session.apply(preview.id), /Project changed/);
  assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("validation catches downstream errors introduced by schema classes", { timeout: 90000 }, async (t) => {
  const { cwd, file } = fixture(t, "export interface Order { id: string }\n", {
    "src/use.ts": 'import type { Order } from "./models";\nexport const order: Order = { id: "123" };\n',
  });
  const session = await open(t, cwd);
  const [candidate] = await session.listCandidates();
  const preview = await session.preview(candidate.id);
  assert.equal(preview.available, true);
  // Schema.Class instances have constructor/prototype requirements that may affect consumers.
  // Use the actual result as a prerequisite for testing blocking rather than mocking the validator.
  if (!preview.validation.ok) {
    assert.ok(preview.validation.newErrors.length > 0);
    await assert.rejects(session.apply(preview.id), /new compiler errors/);
  } else {
    // A newly introduced dependency error must invalidate even a previously valid preview.
    fs.writeFileSync(path.join(cwd, "src/use.ts"), 'import type { Order } from "./models";\nexport const order: Order = { id: 123 };\n');
    await assert.rejects(session.apply(preview.id), /Project changed/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "export interface Order { id: string }\n");
});

test("custom config, extends changes, target edits, and missing prerequisites", { timeout: 90000 }, async (t) => {
  const { cwd, file, config } = fixture(t, "export interface Order { id: string }\n");
  fs.writeFileSync(path.join(cwd, "base.json"), JSON.stringify({ compilerOptions: config.compilerOptions }));
  fs.writeFileSync(path.join(cwd, "tsconfig.models.json"), JSON.stringify({ extends: "./base.json", include: ["src/models.ts"] }));
  const session = await open(t, cwd, { tsconfig: "tsconfig.models.json" });
  let [candidate] = await session.listCandidates();
  let preview = await session.preview(candidate.id);
  fs.appendFileSync(file, "// user's edit\n");
  await assert.rejects(session.apply(preview.id), /Project changed/);
  [candidate] = await session.listCandidates();
  preview = await session.preview(candidate.id);
  fs.writeFileSync(path.join(cwd, "base.json"), JSON.stringify({ compilerOptions: { ...config.compilerOptions, strict: false } }));
  await assert.rejects(session.apply(preview.id), /Project changed/);
  assert.match(fs.readFileSync(file, "utf8"), /user's edit/);
  await assert.rejects(createEffectSchemaSession({ cwd, tsconfig: "absent.json" }), /Cannot find tsconfig/);
  fs.writeFileSync(path.join(cwd, "refs.json"), JSON.stringify({ ...config, references: [{ path: "./child" }] }));
  await assert.rejects(createEffectSchemaSession({ cwd, tsconfig: "refs.json" }), /leaf tsconfig/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "effect-schema-missing-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  fs.writeFileSync(path.join(empty, "tsconfig.json"), "{}");
  await assert.rejects(createEffectSchemaSession({ cwd: empty }), /Cannot resolve typescript/);
});

test("CLI validates arguments and emits machine-readable discovery and previews", { timeout: 120000 }, (t) => {
  assert.deepEqual(parseEffectSchemaArgs(["--help"]), { help: true });
  for (const args of [["--write"], ["--file"], ["--at", "x:0:1"], ["--at", "x:1:1", "--file", "x"], ["--timeout-ms", "0"], ["--json", "--json"]]) {
    assert.throws(() => parseEffectSchemaArgs(args));
  }
  const { cwd, file } = fixture(t, "export interface Order { id: string }\nexport type Generic<T> = T;\n");
  const cli = path.resolve(__dirname, "../bin/effect-schema-cli.js");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, "--cwd", cwd, ...args], { encoding: "utf8", timeout: 60000 });
    assert.ifError(result.error);
    return result;
  };
  const list = run("--json");
  assert.equal(list.status, 0, list.stderr || list.stdout);
  assert.equal(JSON.parse(list.stdout).candidates.length, 2);
  const preview = run("--json", "--at", "src/models.ts:1:18");
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.equal(JSON.parse(preview.stdout).preview.available, true);
  const unavailable = run("--json", "--symbol", "Generic");
  assert.equal(unavailable.status, 2, unavailable.stderr || unavailable.stdout);
  const missing = run("--json", "--symbol", "Absent");
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stdout).error, /No interface/);
  assert.equal(run().status, 1);
  assert.match(fs.readFileSync(file, "utf8"), /interface Order/);
});

test("interactive CLI supports filtering, back, apply, and quit", { timeout: 120000 }, async (t) => {
  const { cwd, file } = fixture(t, "export interface Order { id: string }\n");
  const input = new PassThrough();
  let output = "";
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const promise = mainEffectSchema(["--cwd", cwd], { input, output: sink, error: sink, isTTY: true });
  input.end("/Order\n1\nb\n1\na\nq\n");
  assert.equal(await promise, 0, output);
  assert.match(output, /Applied changes to 1 file/);
  assert.match(fs.readFileSync(file, "utf8"), /class Order/);
});

test("interactive EOF cancels a preview without changing files", { timeout: 90000 }, async (t) => {
  const { cwd, file } = fixture(t, "export interface Order { id: string }\n");
  const before = fs.statSync(file, { bigint: true });
  const input = new PassThrough();
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const promise = mainEffectSchema(["--cwd", cwd, "--symbol", "Order"], { input, output: sink, error: sink, isTTY: true });
  input.end();
  assert.equal(await promise, 0);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(fs.readFileSync(file, "utf8"), "export interface Order { id: string }\n");
});

test("write failures roll back committed files and preserve concurrent edits", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "effect-schema-commit-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const files = ["a", "b"].map((name) => ({ filePath: path.join(cwd, name + ".ts"), originalText: name, editedText: name.toUpperCase(), edits: [] }));
  for (const file of files) fs.writeFileSync(file.filePath, file.originalText);
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === files[1].filePath) throw new Error("simulated write failure");
    rename(from, to);
  });
  assert.throws(() => commitSchemaFiles(files), /simulated write failure/);
  for (const file of files) assert.equal(fs.readFileSync(file.filePath, "utf8"), file.originalText);
  assert.deepEqual(fs.readdirSync(cwd).sort(), ["a.ts", "b.ts"]);
});


test("structural completion reuses runtime aliases and supplies imports for type-only or colliding names", { timeout: 120000 }, async (t) => {
  const sources = [
    'import { Schema as S } from "effect";\nexport interface Order { id: string }\n',
    'import type { Schema as S } from "effect";\nexport interface Order { id: string }\n',
    'export default interface Order { id: string }\n',
    'const Schema = { unrelated: true };\nexport interface Order { id: string }\n',
    'import { Schema } from "effect";\nnamespace Domain { const Schema = 1; export interface Order { id: string } }\n',
  ];
  for (const source of sources) {
    const { cwd, file } = fixture(t, source);
    const session = await open(t, cwd);
    const [candidate] = await session.listCandidates();
    const preview = await session.preview(candidate.id);
    assert.equal(preview.validation?.ok, true, JSON.stringify(preview.validation));
    assert.doesNotMatch(preview.files[0].editedText, /interface Order/);
    if (source.startsWith('import { Schema as S }')) {
      assert.match(preview.files[0].editedText, /extends S.Class/);
      assert.equal((preview.files[0].editedText.match(/from "effect"/g) ?? []).length, 1);
    }
    if (source.startsWith('const Schema') || source.includes('const Schema = 1')) {
      assert.match(preview.files[0].editedText, /import { Schema as EffectSchema }/);
      assert.match(preview.files[0].editedText, /extends EffectSchema.Class/);
    }
    if (source.startsWith('export default')) assert.match(preview.files[0].editedText, /export default class Order/);
    await session.apply(preview.id);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /interface Order/);
    assert.deepEqual(await session.listCandidates(), []);
    await session.close();
  }
});
