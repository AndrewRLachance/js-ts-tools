const test = require("node:test");
const assert = require("node:assert/strict");
const { TypedTypeModelIndex } = require("../../dist/tools/effect-codemod/adapters/type-model-bridge");
function model() {
    return {
        schemaVersion: "2",
        project: {
            typescriptVersion: "5.7.0",
            tsconfigPath: "/project/tsconfig.json",
            scope: "all",
            includeCallSites: true,
            sourceGlobs: ["src/**/*.ts"],
            selectedFiles: ["/project/src/a.ts"],
        },
        modules: [{ id: "m1", filePath: "/project/src/a.ts", roots: [], exports: [], callSites: ["c1"] }],
        roots: [],
        symbols: {
            effectType: {
                id: "effectType",
                name: "Effect",
                qualifiedName: "Effect",
                kind: "interface",
                flags: ["Interface"],
                external: true,
                declarations: [{ filePath: "/project/node_modules/effect/dist/dts/Effect.d.ts", line: 10, column: 1 }],
            },
            flatMap: {
                id: "flatMap",
                name: "flatMap",
                qualifiedName: "flatMap",
                kind: "variable",
                flags: ["BlockScopedVariable"],
                external: true,
                declarations: [{ filePath: "/project/node_modules/effect/dist/dts/Effect.d.ts", line: 100, column: 1 }],
            },
            importedFlatMap: {
                id: "importedFlatMap",
                name: "flatMap",
                qualifiedName: "flatMap",
                kind: "alias",
                flags: ["Alias"],
                external: false,
                declarations: [{ filePath: "/project/src/a.ts", line: 1, column: 10 }],
                aliasTarget: "flatMap",
            },
            arrayMap: {
                id: "arrayMap",
                name: "map",
                qualifiedName: "Array.map",
                kind: "method",
                flags: ["Method"],
                external: true,
                declarations: [{ filePath: "/project/node_modules/typescript/lib/lib.es5.d.ts", line: 1260, column: 5 }],
            },
            arrayFlatMap: {
                id: "arrayFlatMap",
                name: "flatMap",
                qualifiedName: "Array.flatMap",
                kind: "variable",
                flags: [],
                external: true,
                declarations: [{ filePath: "/project/node_modules/effect/dist/dts/Array.d.ts", line: 20, column: 1 }],
            },
        },
        types: {
            tEffect: {
                id: "tEffect",
                kind: "external",
                displayText: "Effect<number, never, never>",
                flags: ["Object"],
                symbolId: "effectType",
                typeArguments: [],
            },
        },
        signatures: {
            sig: {
                id: "sig",
                kind: "call",
                typeParameters: [],
                parameters: [],
                returnType: "tEffect",
                returnAnnotation: "inferred",
            },
        },
        callSites: {
            c1: {
                id: "c1",
                kind: "call",
                location: { filePath: "src/a.ts", line: 3, column: 5 },
                resolution: "resolved",
                resultType: "tEffect",
                calleeSymbolId: "importedFlatMap",
                resolvedSignatureId: "sig",
            },
        },
        diagnostics: [],
    };
}
test("typed index reads exact public TypeModel call-site contracts", () => {
    const index = new TypedTypeModelIndex(model(), "/project");
    const call = index.callSite("c1");
    assert.equal(call?.location.filePath, "src/a.ts");
    assert.equal(call?.location.line, 3);
    assert.equal(index.callSitesAt({ filePath: "/project/src/a.ts", line: 3, column: 5 }, "call").length, 1);
    assert.equal(index.resolveAliasSymbol("importedFlatMap")?.id, "flatMap");
});
test("typed index proves Effect module bindings and Effect result types", () => {
    const index = new TypedTypeModelIndex(model(), "/project");
    const call = index.callSite("c1");
    if (!call)
        throw new Error("missing call site");
    assert.equal(index.callSiteCalleeIsEffectFunction(call, "flatMap"), true);
    assert.equal(index.callSiteResultIsEffect(call), true);
    assert.equal(index.isEffectModuleSymbol("flatMap", "Effect", "flatMap"), true);
    assert.equal(index.isEffectModuleSymbol("arrayFlatMap", "Effect", "flatMap"), false);
});
test("typed index distinguishes TypeScript lib methods from Effect module methods", () => {
    const index = new TypedTypeModelIndex(model(), "/project");
    assert.equal(index.isTypeScriptLibSymbol("arrayMap", "map"), true);
    assert.equal(index.isEffectPackageSymbol("arrayMap", "map"), false);
});
