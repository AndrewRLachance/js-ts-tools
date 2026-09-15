const test = require("node:test");
const assert = require("node:assert/strict");
const { planFiles } = require("../../dist/tools/effect-codemod/core/edit-planner");
const source = {
    read: () => "abcdef",
    write: () => undefined,
};
const editor = {
    apply(text, edits) {
        return [...edits]
            .sort((a, b) => b.start - a.start)
            .reduce((acc, edit) => acc.slice(0, edit.start) + edit.replacement + acc.slice(edit.end), text);
    },
};
test("planner applies non-overlapping replacements", () => {
    const files = planFiles([
        { filePath: "/a.ts", start: 1, end: 3, replacement: "XX", reason: "test" },
    ], source, editor);
    assert.equal(files[0]?.editedText, "aXXdef");
});
test("planner rejects overlaps", () => {
    assert.throws(() => planFiles([
        { filePath: "/a.ts", start: 1, end: 4, replacement: "x", reason: "a" },
        { filePath: "/a.ts", start: 3, end: 5, replacement: "y", reason: "b" },
    ], source, editor), /Overlapping replacements/);
});
