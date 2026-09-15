const assert = require("node:assert/strict");
const { test } = require("node:test");
const { InMemoryValidationPort } = require("../../dist/tools/effect-codemod/core/in-memory-validation");

const request = { cwd: "/project", tsconfig: "tsconfig.json", sources: ["*.ts"], excludes: [] };
const baseline = { rawTypeModel: {}, diagnostics: [] };
const files = [{ filePath: "/project/input.ts", originalText: "before", editedText: "after", replacements: [] }];

test("in-memory validation supplies all edits without writing, and rejects new diagnostics", () => {
  let overlays;
  const source = { read: () => "before", write: () => assert.fail("validation wrote source") };
  const semantics = {
    snapshot: () => assert.fail("validation ignored the overlay"),
    snapshotWithOverrides: (_request, overrides) => {
      overlays = overrides;
      return { rawTypeModel: {}, diagnostics: [{ code: 2322, message: "new error" }] };
    },
  };
  const result = new InMemoryValidationPort(source, semantics).validate(request, files, baseline);
  assert.deepEqual([...overlays], [["/project/input.ts", "after"]]);
  assert.equal(result.ok, false);
  assert.equal(result.newDiagnostics.length, 1);
});

test("in-memory validation rejects source changes before and during analysis", () => {
  let current = "changed";
  let calls = 0;
  const source = { read: () => current, write: () => assert.fail("validation wrote source") };
  const semantics = {
    snapshot: () => baseline,
    snapshotWithOverrides: () => { calls++; current = "changed during analysis"; return baseline; },
  };
  const validator = new InMemoryValidationPort(source, semantics);
  assert.throws(() => validator.validate(request, files, baseline), /Source changed/);
  assert.equal(calls, 0);
  current = "before";
  assert.throws(() => validator.validate(request, files, baseline), /Source changed/);
  assert.equal(calls, 1);
});
