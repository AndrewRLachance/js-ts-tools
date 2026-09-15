const test = require("node:test");
const assert = require("node:assert/strict");
const { newDiagnostics } = require("../../dist/tools/effect-codemod/core/diagnostics");
test("diagnostic diff is order-insensitive and multiset-aware", () => {
    const a = { code: 1, message: "a" };
    const b = { code: 2, message: "b" };
    const c = { code: 3, message: "c" };
    assert.deepEqual(newDiagnostics([a, b], [b, a, c]), [c]);
    assert.deepEqual(newDiagnostics([a, a], [a]), []);
    assert.deepEqual(newDiagnostics([a], [a, a]), [a]);
});
