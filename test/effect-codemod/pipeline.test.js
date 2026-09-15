const test = require("node:test");
const assert = require("node:assert/strict");
const { EffectCodemod } = require("../../dist/tools/effect-codemod/core/pipeline");
const { RuleRegistry } = require("../../dist/tools/effect-codemod/core/registry");
const { probeMapRule } = require("../../dist/tools/effect-codemod/rules/probe-map");
const candidate = {
    id: "c1",
    selectorId: "probe.map-call.call",
    filePath: "/project/src/a.ts",
    kind: "CallExpression",
    text: "xs.map(f)",
    startOffset: 10,
    endOffset: 19,
    start: { line: 1, column: 11 },
    end: { line: 1, column: 20 },
};
function editor(text, edits) {
    return [...edits]
        .sort((a, b) => b.start - a.start)
        .reduce((acc, edit) => acc.slice(0, edit.start) + edit.replacement + acc.slice(edit.end), text);
}
test("walking skeleton discovers and safely skips unproven map", () => {
    const codemod = new EffectCodemod(new RuleRegistry([probeMapRule]), {
        discovery: { discover: () => [candidate] },
        semantics: { snapshot: () => ({ rawTypeModel: {}, diagnostics: [] }) },
        astPatterns: { match: () => [] },
        source: { read: () => "const y = xs.map(f);", write: () => { throw new Error("must not write"); } },
        edits: { apply: (text) => text },
        imports: { plan: () => [] },
        validation: {
            validate: (_request, _files, baseline) => ({
                ok: true,
                baselineDiagnostics: baseline.diagnostics,
                resultingDiagnostics: baseline.diagnostics,
                newDiagnostics: [],
            }),
        },
    });
    const report = codemod.run({ cwd: "/project", write: false });
    assert.equal(report.summary.candidates, 1);
    assert.equal(report.summary.skipped, 1);
    assert.equal(report.summary.converted, 0);
    assert.equal(report.summary.written, false);
});
test("conversion plans body edits and imports before validation", () => {
    const sourceText = "const result = legacyMap(value, f);\n";
    const start = sourceText.indexOf("legacyMap");
    const end = sourceText.indexOf(";", start);
    const convertingCandidate = {
        ...candidate,
        selectorId: "test.map",
        startOffset: start,
        endOffset: end,
        text: sourceText.slice(start, end),
    };
    const rule = {
        id: "test.map",
        target: "map",
        description: "integration conversion rule",
        selectors: [{ id: "test.map", tsquery: "CallExpression" }],
        analyze(item) {
            return {
                kind: "convert",
                match: {
                    ruleId: this.id,
                    target: this.target,
                    candidate: item,
                    captures: {},
                    confidence: "safe",
                    evidence: [],
                },
            };
        },
        rewrite(match) {
            return {
                replacements: [{
                        filePath: match.candidate.filePath,
                        start: match.candidate.startOffset,
                        end: match.candidate.endOffset,
                        replacement: "Effect.map(value, f)",
                        reason: "test conversion",
                    }],
                imports: [{ moduleSpecifier: "effect", importedName: "Effect" }],
            };
        },
    };
    let current = sourceText;
    let validatedText = "";
    const codemod = new EffectCodemod(new RuleRegistry([rule]), {
        discovery: { discover: () => [convertingCandidate] },
        semantics: { snapshot: () => ({ rawTypeModel: {}, diagnostics: [] }) },
        astPatterns: { match: () => [] },
        source: {
            read: () => current,
            write: (_filePath, text) => { current = text; },
        },
        edits: { apply: editor },
        imports: {
            plan: (_request, filePath) => [{
                    filePath,
                    start: 0,
                    end: 0,
                    replacement: 'import { Effect } from "effect";\n',
                    reason: "import-reconciliation",
                }],
        },
        validation: {
            validate: (_request, files, baseline) => {
                validatedText = files[0]?.editedText ?? "";
                return {
                    ok: true,
                    baselineDiagnostics: baseline.diagnostics,
                    resultingDiagnostics: baseline.diagnostics,
                    newDiagnostics: [],
                };
            },
        },
    });
    const report = codemod.run({ cwd: "/project", write: false });
    assert.equal(report.summary.converted, 1);
    assert.equal(report.summary.changedFiles, 1);
    assert.equal(report.summary.written, false);
    assert.equal(current, sourceText);
    assert.equal(validatedText, 'import { Effect } from "effect";\nconst result = Effect.map(value, f);\n');
});
