const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { extractTypeModel } = require("../dist/tools/type-model");

test("type-model overlays affect dependent diagnostics without touching disk or later extractions", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-overrides-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, types: [] }, include: ["*.ts"] }));
  const original = "export const value = 1;\n";
  const file = path.join(cwd, "value.ts");
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(cwd, "consumer.ts"), 'import { value } from "./value"; export const result: number = value;\n');
  const options = { cwd, sourceGlob: "*.ts", scope: "all" };
  const baseline = extractTypeModel(options);
  assert.deepEqual(baseline.diagnostics, []);
  const before = fs.statSync(file, { bigint: true });
  const edited = extractTypeModel({ ...options, sourceTextOverrides: new Map([["value.ts", 'export const value = "changed";\n']]) });
  assert.ok(edited.diagnostics.some((d) => d.code === 2322 && d.location.filePath === "consumer.ts"));
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.deepEqual(extractTypeModel(options).diagnostics, baseline.diagnostics);
  assert.throws(() => extractTypeModel({ ...options, sourceTextOverrides: new Map([["missing.ts", ""]]) }), /not an existing project file/);
  assert.throws(() => extractTypeModel({ ...options, sourceTextOverrides: new Map([[file, original]]), includeDeclarationBundles: true }), /cannot be combined with declaration bundles/);
});
