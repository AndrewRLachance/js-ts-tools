const test = require("node:test");
const assert = require("node:assert/strict");
const { planImportInsertion } = require("../../dist/tools/effect-codemod/core/import-planner");
function apply(text, edits) {
    return [...edits]
        .sort((a, b) => b.start - a.start)
        .reduce((acc, edit) => acc.slice(0, edit.start) + edit.replacement + acc.slice(edit.end), text);
}
test("import planner inserts missing imports before the first import", () => {
    const source = 'import { pipe } from "effect/Function";\nconst x = 1;\n';
    const edits = planImportInsertion("/a.ts", source, [{ moduleSpecifier: "effect", importedName: "Effect" }], [{ startOffset: 0, endOffset: 39, text: 'import { pipe } from "effect/Function";' }]);
    assert.equal(apply(source, edits), 'import { Effect } from "effect";\nimport { pipe } from "effect/Function";\nconst x = 1;\n');
});
test("import planner is idempotent for an existing value binding", () => {
    const declaration = 'import { Effect, Option as O } from "effect";';
    const source = `${declaration}\nconst x = 1;\n`;
    const edits = planImportInsertion("/a.ts", source, [{ moduleSpecifier: "effect", importedName: "Effect" }], [{ startOffset: 0, endOffset: declaration.length, text: declaration }]);
    assert.deepEqual(edits, []);
});
test("value requirement is not satisfied by a type-only import", () => {
    const declaration = 'import type { Effect } from "effect";';
    const source = `${declaration}\nconst x = 1;\n`;
    const edits = planImportInsertion("/a.ts", source, [{ moduleSpecifier: "effect", importedName: "Effect" }], [{ startOffset: 0, endOffset: declaration.length, text: declaration }]);
    assert.equal(apply(source, edits), 'import { Effect } from "effect";\nimport type { Effect } from "effect";\nconst x = 1;\n');
});
test("planner preserves shebang and leading comments when there are no imports", () => {
    const source = '#!/usr/bin/env node\n// license\nconst x = 1;\n';
    const edits = planImportInsertion("/a.ts", source, [
        { moduleSpecifier: "effect", importedName: "Effect" },
        { moduleSpecifier: "effect", importedName: "Option" },
    ], []);
    assert.equal(apply(source, edits), '#!/usr/bin/env node\n// license\nimport { Effect, Option } from "effect";\nconst x = 1;\n');
});
