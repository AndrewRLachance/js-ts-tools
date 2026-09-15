const test = require("node:test");
const assert = require("node:assert/strict");
const { TransactionalValidationPort, commitPlannedFiles } = require("../../dist/tools/effect-codemod/core/transaction");
const request = {
    cwd: "/project",
    tsconfig: "tsconfig.json",
    sources: ["src/**/*.ts"],
    excludes: ["dist"],
};
function memorySource(initial) {
    const values = new Map(Object.entries(initial));
    return {
        values,
        port: {
            read(filePath) {
                const value = values.get(filePath);
                if (value === undefined)
                    throw new Error(`missing ${filePath}`);
                return value;
            },
            write(filePath, text) {
                values.set(filePath, text);
            },
        },
    };
}
test("transactional validation stages edits, detects diagnostics, and restores source", () => {
    const { values, port } = memorySource({ "/project/src/a.ts": "const x = 1;" });
    let observed = "";
    const validator = new TransactionalValidationPort(port, {
        snapshot: () => {
            observed = port.read("/project/src/a.ts");
            return { rawTypeModel: {}, diagnostics: [{ code: 100, message: "new" }] };
        },
    });
    const result = validator.validate(request, [{
            filePath: "/project/src/a.ts",
            originalText: "const x = 1;",
            editedText: "const x: Missing = 1;",
            replacements: [],
        }], { rawTypeModel: {}, diagnostics: [] });
    assert.equal(observed, "const x: Missing = 1;");
    assert.equal(values.get("/project/src/a.ts"), "const x = 1;");
    assert.equal(result.ok, false);
    assert.equal(result.newDiagnostics.length, 1);
});
test("transactional validation restores source when semantic analysis throws", () => {
    const { values, port } = memorySource({ "/project/src/a.ts": "before" });
    const validator = new TransactionalValidationPort(port, {
        snapshot: () => { throw new Error("analysis failed"); },
    });
    assert.throws(() => validator.validate(request, [{
            filePath: "/project/src/a.ts",
            originalText: "before",
            editedText: "after",
            replacements: [],
        }], { rawTypeModel: {}, diagnostics: [] }), /analysis failed/);
    assert.equal(values.get("/project/src/a.ts"), "before");
});
test("transactional validation rejects stale sources before staging", () => {
    const { values, port } = memorySource({ "/project/src/a.ts": "changed elsewhere" });
    const validator = new TransactionalValidationPort(port, {
        snapshot: () => ({ rawTypeModel: {}, diagnostics: [] }),
    });
    assert.throws(() => validator.validate(request, [{
            filePath: "/project/src/a.ts",
            originalText: "before",
            editedText: "after",
            replacements: [],
        }], { rawTypeModel: {}, diagnostics: [] }), /Source changed after planning/);
    assert.equal(values.get("/project/src/a.ts"), "changed elsewhere");
});
test("commit preflights and writes all planned files", () => {
    const { values, port } = memorySource({
        "/project/src/a.ts": "a",
        "/project/src/b.ts": "b",
    });
    const written = commitPlannedFiles([
        { filePath: "/project/src/a.ts", originalText: "a", editedText: "A", replacements: [] },
        { filePath: "/project/src/b.ts", originalText: "b", editedText: "B", replacements: [] },
    ], port);
    assert.equal(written, true);
    assert.equal(values.get("/project/src/a.ts"), "A");
    assert.equal(values.get("/project/src/b.ts"), "B");
});

test("commit restores every attempted file after partial writes, even when one restoration fails", () => {
  const { values, port } = memorySource({ "/a.ts": "a", "/b.ts": "b", "/c.ts": "c" });
  const commitFailure = new Error("partial write");
  const restoreFailure = new Error("restore b failed");
  const restored = [];
  port.write = (filePath, text) => {
    if (text === text.toLowerCase()) {
      restored.push(filePath);
      if (filePath === "/b.ts") throw restoreFailure;
    }
    values.set(filePath, text);
    if (filePath === "/c.ts" && text === "C") throw commitFailure;
  };
  const files = ["a", "b", "c"].map((name) => ({ filePath: `/${name}.ts`, originalText: name, editedText: name.toUpperCase(), replacements: [] }));
  assert.throws(() => commitPlannedFiles(files, port), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.ok(error.errors.includes(commitFailure));
    assert.ok(error.errors.includes(restoreFailure));
    return true;
  });
  assert.deepEqual(restored, ["/c.ts", "/b.ts", "/a.ts"]);
  assert.equal(values.get("/a.ts"), "a");
  assert.equal(values.get("/c.ts"), "c");
});

test("commit notices changes between writes and preserves the changed file", () => {
  const { values, port } = memorySource({ "/a.ts": "a", "/b.ts": "b" });
  port.write = (filePath, text) => {
    values.set(filePath, text);
    if (filePath === "/a.ts" && text === "A") values.set("/b.ts", "external change");
  };
  const files = ["a", "b"].map((name) => ({ filePath: `/${name}.ts`, originalText: name, editedText: name.toUpperCase(), replacements: [] }));
  assert.throws(() => commitPlannedFiles(files, port), /Source changed/);
  assert.equal(values.get("/a.ts"), "a");
  assert.equal(values.get("/b.ts"), "external change");
});
