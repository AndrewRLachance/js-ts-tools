const test = require("node:test");
const assert = require("node:assert/strict");
const { BasicSemanticContext } = require("../../dist/tools/effect-codemod/core/semantic-context");
const { requireExactAstPattern, requireSingleExactCallSite } = require("../../dist/tools/effect-codemod/core/semantic-guards");
const snapshot = { rawTypeModel: {}, diagnostics: [] };
const callSite = {
    id: "x",
    kind: "call",
    location: { filePath: "/a.ts", line: 1, column: 2 },
    resolution: "resolved",
    resultTypeId: "t",
    raw: { id: "x" },
};
test("exact call-site gate accepts one exact record", () => {
    const context = new BasicSemanticContext(snapshot, new Map([[
            "c",
            { facts: [], callSites: [{ strength: "exact", callSite }], astPatterns: [] },
        ]]));
    const gate = requireSingleExactCallSite("c", context);
    assert.equal(gate.ok, true);
    if (gate.ok)
        assert.equal(gate.value, callSite);
});
test("exact call-site gate rejects ambiguity", () => {
    const second = { ...callSite, id: "y", raw: { id: "y" } };
    const context = new BasicSemanticContext(snapshot, new Map([[
            "c",
            {
                facts: [],
                callSites: [
                    { strength: "exact", callSite },
                    { strength: "exact", callSite: second },
                ],
                astPatterns: [],
            },
        ]]));
    const gate = requireSingleExactCallSite("c", context);
    assert.equal(gate.ok, false);
});
test("AST-pattern gate requires an exact requirement match", () => {
    const context = new BasicSemanticContext(snapshot, new Map([[
            "c",
            {
                facts: [],
                callSites: [],
                astPatterns: [{
                        strength: "exact",
                        requirementId: "rule.map",
                        filePath: "/a.ts",
                        startOffset: 1,
                        endOffset: 2,
                        text: "x",
                    }],
            },
        ]]));
    assert.equal(requireExactAstPattern("c", "rule.map", context).ok, true);
    assert.equal(requireExactAstPattern("c", "other", context).ok, false);
});
