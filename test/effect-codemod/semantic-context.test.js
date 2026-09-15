const test = require("node:test");
const assert = require("node:assert/strict");
const { correlateSemanticContext } = require("../../dist/tools/effect-codemod/core/semantic-context");
const request = {
    cwd: "/project",
    tsconfig: "tsconfig.json",
    sources: ["src/**/*.ts"],
    excludes: ["dist"],
};
const candidate = {
    id: "candidate-1",
    selectorId: "map",
    filePath: "/project/src/a.ts",
    kind: "CallExpression",
    text: "legacyMap(value, f)",
    startOffset: 10,
    endOffset: 29,
    start: { line: 1, column: 11 },
    end: { line: 1, column: 30 },
};
function callSite(id, line, column) {
    return {
        id,
        kind: "call",
        location: { filePath: "src/a.ts", line, column },
        resolution: "resolved",
        resultTypeId: "type-1",
        raw: { id },
    };
}
test("semantic correlation attaches exact call sites by start location and AST patterns by range", () => {
    const rawCallSite = callSite("call-1", 1, 11);
    const context = correlateSemanticContext({
        request,
        candidates: [candidate],
        snapshot: { rawTypeModel: {}, diagnostics: [], callSites: [rawCallSite] },
        astPatternMatches: [{
                requirementId: "legacy.map",
                filePath: "src/a.ts",
                startOffset: 10,
                endOffset: 29,
                text: candidate.text,
            }],
    });
    assert.equal(context.exactCallSiteFor(candidate.id)?.id, "call-1");
    assert.equal(context.hasExactAstPattern(candidate.id, "legacy.map"), true);
    assert.equal(context.factsFor(candidate.id).length, 2);
});
test("point locations inside a candidate are review evidence and never count as exact", () => {
    const context = correlateSemanticContext({
        request,
        candidates: [candidate],
        snapshot: { rawTypeModel: {}, diagnostics: [], callSites: [callSite("inner", 1, 15)] },
        astPatternMatches: [{
                requirementId: "inner",
                filePath: candidate.filePath,
                startOffset: 12,
                endOffset: 20,
                text: "Map(value",
            }],
    });
    assert.equal(context.exactCallSiteFor(candidate.id), undefined);
    assert.equal(context.callSitesFor(candidate.id)[0]?.strength, "contained");
    assert.equal(context.hasExactAstPattern(candidate.id, "inner"), false);
});
test("non-overlapping semantic records are not attached", () => {
    const context = correlateSemanticContext({
        request,
        candidates: [candidate],
        snapshot: { rawTypeModel: {}, diagnostics: [], callSites: [callSite("later", 2, 1)] },
    });
    assert.deepEqual(context.factsFor(candidate.id), []);
    assert.deepEqual(context.callSitesFor(candidate.id), []);
});
test("multiple exact call sites are treated as ambiguous", () => {
    const context = correlateSemanticContext({
        request,
        candidates: [candidate],
        snapshot: {
            rawTypeModel: {},
            diagnostics: [],
            callSites: [callSite("a", 1, 11), callSite("b", 1, 11)],
        },
    });
    assert.equal(context.callSitesFor(candidate.id).length, 2);
    assert.equal(context.exactCallSiteFor(candidate.id), undefined);
});
