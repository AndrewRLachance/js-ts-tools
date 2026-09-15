const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const { TypedTypeModelIndex } = require("../../dist/tools/effect-codemod/adapters/type-model-bridge");
const { correlateSemanticContext } = require("../../dist/tools/effect-codemod/core/semantic-context");
const {
  allFromIdentityForEachRule,
  filterOrFailFromFlatMapRule,
  forEachFromDenseArrayAllRule,
  mapErrorFromCatchAllFailRule,
  mapFromFlatMapSucceedRule,
  whenFromSuspendedConditionalRule,
} = require("../../dist/tools/effect-codemod/rules/effect-compositions");
const {
  everyFromFindFirstNegatedRule,
  existsFromFindFirstRule,
  filterFromForEachOptionsRule,
  filterMapFromAllArrayFilterMapRule,
  filterOrDieFromFlatMapRule,
  filterOrDieMessageFromFlatMapRule,
  isFailureFromMatchRule,
  isSuccessFromMatchRule,
  liftPredicateFromFilterOrFailSucceedRule,
} = require("../../dist/tools/effect-codemod/rules/predicate-filter-expansion");
const {
  allSuccessesFromAllExitsRule,
  allWithFromArrowAllRule,
  mergeAllFromArrayReduceZipWithRule,
  replicateEffectFromAllReplicateRule,
} = require("../../dist/tools/effect-codemod/rules/collecting-expansion");
const {
  dropUntilFromMapAccumRule,
  dropWhileFromMapAccumRule,
  findFirstFromReduceWhileOptionRule,
  headFromFlatMapOptionFromIterableRule,
  reduceEffectFromArrayReduceZipWithRule,
  reduceFromArrayReduceRule,
  reduceRightFromArrayReduceRightRule,
  reduceWhileFromIterateStateRule,
  takeUntilFromMapAccumRule,
  takeWhileFromMapAccumRule,
} = require("../../dist/tools/effect-codemod/rules/collection-folding-expansion");
const {
  asFromMapConstantPrimitiveRule,
  asSomeErrorFromMapErrorOptionSomeRule,
  asSomeFromMapOptionSomeRule,
  asVoidFromMapRule,
  filterOrElseFromFlatMapRule,
  flipFromMatchEffectRule,
  mapBothFromMatchEffectRule,
  mapErrorCauseFromCatchAllCauseFailCauseRule,
  mergeFromMatchRule,
} = require("../../dist/tools/effect-codemod/rules/rule-expansion");
const {
  unlessEffectFromFlatMapRule,
  unlessFromSuspendedConditionalRule,
  whenEffectFromFlatMapRule,
  whenFiberRefFromGetFlatMapRule,
  whenRefFromGetFlatMapRule,
} = require("../../dist/tools/effect-codemod/rules/conditional-expansion");
const {
  filterEffectOrElseFromNestedFlatMapRule,
  filterEffectOrFailFromNestedFlatMapRule,
  negateFromMapBooleanNotRule,
} = require("../../dist/tools/effect-codemod/rules/effectful-filter-mapping-expansion");
const {
  flipWithFromNestedFlipRule,
  iterateFromSuspendedUnrollRule,
  loopFromSuspendedUnrollRule,
  mapAccumFromSuspendedReduceRule,
} = require("../../dist/tools/effect-codemod/rules/remaining-expansion");
function ast(source) {
    const sourceFile = {
        getLineAndCharacterOfPosition(position) {
            const before = source.slice(0, position);
            const lines = before.split("\n");
            return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
        },
    };
    const span = (text, from = 0) => {
        const start = source.indexOf(text, from);
        if (start < 0)
            throw new Error(`Missing test text: ${text}`);
        return [start, start + text.length];
    };
    const node = (start, end, extra = {}) => ({
        getStart: () => start,
        getEnd: () => end,
        getSourceFile: () => sourceFile,
        getText: () => source.slice(start, end),
        ...extra,
    });
    const identifier = (text, from = 0) => {
        const [start, end] = span(text, from);
        return node(start, end, { text });
    };
    const property = (namespace, name, from = 0) => {
        const [start] = span(`${namespace}.${name}`, from);
        const ns = identifier(namespace, start);
        const member = identifier(name, start + namespace.length + 1);
        return node(start, member.getEnd(), { expression: ns, name: member });
    };
    const call = (text, expression, args, from = 0) => {
        const [start, end] = span(text, from);
        return node(start, end, { expression, arguments: [...args] });
    };
    const parameter = (name, from = 0) => {
        const id = identifier(name, from);
        return node(id.getStart(sourceFile), id.getEnd(), { name: id });
    };
    const arrow = (text, parameters, body, from = 0) => {
        const [start, end] = span(text, from);
        return node(start, end, { parameters: [...parameters], body, equalsGreaterThanToken: {} });
    };
    const conditional = (text, condition, whenTrue, whenFalse, from = 0) => {
        const [start, end] = span(text, from);
        return node(start, end, { condition, whenTrue, whenFalse, questionToken: {}, colonToken: {} });
    };
    const array = (text, elements, from = 0) => {
        const [start, end] = span(text, from);
        return node(start, end, { elements: [...elements] });
    };
    const propertyAssignment = (name, initializer, from = 0) => {
        const key = identifier(name, from);
        return node(key.getStart(sourceFile), initializer.getEnd(), { name: key, initializer });
    };
    const object = (text, properties, from = 0) => {
        const [start, end] = span(text, from);
        return node(start, end, { properties: [...properties] });
    };
    const location = (offset) => {
        const pos = sourceFile.getLineAndCharacterOfPosition(offset);
        return { filePath: "/project/src/a.ts", line: pos.line + 1, column: pos.character + 1 };
    };
    return { source, sourceFile, span, node, identifier, property, call, parameter, arrow, conditional, array, propertyAssignment, object, location };
}
function effectSymbol(name, module = "Effect") {
    return {
        id: `${module}.${name}`,
        name,
        qualifiedName: `${module}.${name}`,
        kind: "variable",
        flags: ["BlockScopedVariable"],
        external: true,
        declarations: [{
                filePath: `/project/node_modules/effect/dist/dts/${module}.d.ts`,
                line: 1,
                column: 1,
            }],
    };
}
function semanticModel(factory, calls, extraSymbols = []) {
    const symbols = {
        "Effect.Effect": {
            id: "Effect.Effect",
            name: "Effect",
            qualifiedName: "Effect.Effect",
            kind: "interface",
            flags: ["Interface"],
            external: true,
            declarations: [{ filePath: "/project/node_modules/effect/dist/dts/Effect.d.ts", line: 10, column: 1 }],
        },
    };
    for (const call of calls) {
        const module = call.module ?? "Effect";
        const id = `${module}.${call.symbol}`;
        symbols[id] ??= effectSymbol(call.symbol, module);
    }
    for (const symbol of extraSymbols)
        symbols[symbol.id] = symbol;
    const callSites = {};
    for (const call of calls) {
        const module = call.module ?? "Effect";
        callSites[call.id] = {
            id: call.id,
            kind: "call",
            location: factory.location(call.node.getStart()),
            resolution: "resolved",
            resultType: call.resultEffect ? "tEffect" : "tUnknown",
            calleeSymbolId: `${module}.${call.symbol}`,
        };
    }
    const model = {
        schemaVersion: "2",
        project: {
            typescriptVersion: "5.7.0",
            tsconfigPath: "/project/tsconfig.json",
            scope: "all",
            includeCallSites: true,
            sourceGlobs: ["src/**/*.ts"],
            selectedFiles: ["/project/src/a.ts"],
        },
        modules: [{ id: "m", filePath: "/project/src/a.ts", roots: [], exports: [], callSites: Object.keys(callSites) }],
        roots: [],
        symbols,
        types: {
            tEffect: {
                id: "tEffect",
                kind: "external",
                displayText: "Effect<number, Error, never>",
                flags: ["Object"],
                symbolId: "Effect.Effect",
                typeArguments: [],
            },
            tUnknown: { id: "tUnknown", kind: "intrinsic", displayText: "unknown", flags: ["Unknown"], name: "unknown" },
        },
        signatures: {},
        callSites,
        diagnostics: [],
    };
    return { model, index: new TypedTypeModelIndex(model, "/project") };
}
function runRule(rule, factory, outer, calls, extraSymbols = []) {
    const { model, index } = semanticModel(factory, calls, extraSymbols);
    const candidate = {
        id: "candidate",
        selectorId: rule.selectors[0]?.id ?? "selector",
        filePath: "/project/src/a.ts",
        kind: "CallExpression",
        text: factory.source,
        startOffset: outer.getStart(),
        endOffset: outer.getEnd(),
        start: {
            line: factory.location(outer.getStart()).line,
            column: factory.location(outer.getStart()).column,
        },
        end: {
            line: factory.location(outer.getEnd()).line,
            column: factory.location(outer.getEnd()).column,
        },
        nativeNode: outer,
    };
    const semantics = correlateSemanticContext({
        request: { cwd: "/project", tsconfig: "tsconfig.json", sources: ["src/**/*.ts"], excludes: [] },
        candidates: [candidate],
        snapshot: { rawTypeModel: model, diagnostics: [], callSites: index.allCallSites(), model: index },
    });
    const context = { semantics, sourceText: factory.source };
    const decision = rule.analyze(candidate, context);
    const rewrite = decision.kind === "convert" ? rule.rewrite(decision.match, context) : undefined;
    return { decision, rewrite };
}
function runArrowRule(rule, factory, outer, calls, extraSymbols = []) {
    const { model, index } = semanticModel(factory, calls, extraSymbols);
    const candidate = {
        id: "candidate",
        selectorId: rule.selectors[0]?.id ?? "selector",
        filePath: "/project/src/a.ts",
        kind: "ArrowFunction",
        text: factory.source,
        startOffset: outer.getStart(),
        endOffset: outer.getEnd(),
        start: factory.location(outer.getStart()),
        end: factory.location(outer.getEnd()),
        nativeNode: outer,
    };
    const semantics = correlateSemanticContext({
        request: { cwd: "/project", tsconfig: "tsconfig.json", sources: ["src/**/*.ts"], excludes: [] },
        candidates: [candidate],
        snapshot: { rawTypeModel: model, diagnostics: [], callSites: index.allCallSites(), model: index },
    });
    const context = { semantics, sourceText: factory.source };
    const decision = rule.analyze(candidate, context);
    const rewrite = decision.kind === "convert" ? rule.rewrite(decision.match, context) : undefined;
    return { decision, rewrite };
}
test("map rule converts flatMap+succeed only with proven Effect bindings", () => {
    const f = ast("Effect.flatMap(input, x => Effect.succeed(x + 1))");
    const outerProp = f.property("Effect", "flatMap");
    const self = f.node(...f.span("input"));
    const succeedProp = f.property("Effect", "succeed");
    const value = f.node(...f.span("x + 1"));
    const succeed = f.call("Effect.succeed(x + 1)", succeedProp, [value]);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow("x => Effect.succeed(x + 1)", [param], succeed);
    const outer = f.call(f.source, outerProp, [self, mapper]);
    const result = runRule(mapFromFlatMapSucceedRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.map(input, x => x + 1)");
});
test("map rule rejects a lexical Effect.flatMap when semantic binding resolves outside Effect module", () => {
    const f = ast("Effect.flatMap(input, x => Effect.succeed(x + 1))");
    const outerProp = f.property("Effect", "flatMap");
    const self = f.node(...f.span("input"));
    const succeedProp = f.property("Effect", "succeed");
    const value = f.node(...f.span("x + 1"));
    const succeed = f.call("Effect.succeed(x + 1)", succeedProp, [value]);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow("x => Effect.succeed(x + 1)", [param], succeed);
    const outer = f.call(f.source, outerProp, [self, mapper]);
    const wrongBinding = {
        id: "Effect.flatMap",
        name: "flatMap",
        qualifiedName: "Array.flatMap",
        kind: "variable",
        flags: [],
        external: true,
        declarations: [{ filePath: "/project/node_modules/effect/dist/dts/Array.d.ts", line: 20, column: 1 }],
    };
    const result = runRule(mapFromFlatMapSucceedRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ], [wrongBinding]);
    assert.equal(result.decision.kind, "skip");
});
test("mapError rule converts catchAll+fail", () => {
    const f = ast('Effect.catchAll(input, e => Effect.fail(new Error(e)))');
    const outerProp = f.property("Effect", "catchAll");
    const self = f.node(...f.span("input"));
    const failProp = f.property("Effect", "fail");
    const error = f.node(...f.span("new Error(e)"));
    const fail = f.call("Effect.fail(new Error(e))", failProp, [error]);
    const param = f.parameter("e", f.span("e =>")[0]);
    const mapper = f.arrow("e => Effect.fail(new Error(e))", [param], fail);
    const outer = f.call(f.source, outerProp, [self, mapper]);
    const result = runRule(mapErrorFromCatchAllFailRule, f, outer, [
        { id: "outer", node: outer, symbol: "catchAll", resultEffect: true },
        { id: "fail", node: fail, symbol: "fail", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, 'Effect.mapError(input, e => new Error(e))');
});
test("filterOrFail rule converts success/fail validation while preserving predicate/error evaluation", () => {
    const f = ast('Effect.flatMap(input, x => x > 0 ? Effect.succeed(x) : Effect.fail("bad"))');
    const outerProp = f.property("Effect", "flatMap");
    const self = f.node(...f.span("input"));
    const condition = f.node(...f.span("x > 0"));
    const succeedArg = f.identifier("x", f.span("Effect.succeed(x)")[0] + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedArg]);
    const failArg = f.node(...f.span('"bad"'));
    const fail = f.call('Effect.fail("bad")', f.property("Effect", "fail"), [failArg]);
    const conditionalText = 'x > 0 ? Effect.succeed(x) : Effect.fail("bad")';
    const conditional = f.conditional(conditionalText, condition, succeed, fail);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${conditionalText}`, [param], conditional);
    const outer = f.call(f.source, outerProp, [self, mapper]);
    const result = runRule(filterOrFailFromFlatMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "fail", node: fail, symbol: "fail", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, 'Effect.filterOrFail(input, x => x > 0, x => "bad")');
});
test("all rule converts identity Effect.forEach", () => {
    const f = ast("Effect.forEach(effects, effect => effect)");
    const outerProp = f.property("Effect", "forEach");
    const effects = f.node(...f.span("effects"));
    const paramStart = f.span("effect =>")[0];
    const param = f.parameter("effect", paramStart);
    const body = f.identifier("effect", paramStart + "effect => ".length);
    const mapper = f.arrow("effect => effect", [param], body);
    const outer = f.call(f.source, outerProp, [effects, mapper]);
    const result = runRule(allFromIdentityForEachRule, f, outer, [
        { id: "outer", node: outer, symbol: "forEach", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.all(effects)");
});
test("when rule only moves a pure Effect.suspend constructor across the conditional boundary", () => {
    const source = "Effect.suspend(() => ready ? Effect.asSome(Effect.suspend(() => work)) : Effect.succeed(Option.none()))";
    const f = ast(source);
    const outerProp = f.property("Effect", "suspend");
    const condition = f.node(...f.span("ready"));
    const innerSuspendText = "Effect.suspend(() => work)";
    const innerSuspendProp = f.property("Effect", "suspend", f.span(innerSuspendText)[0]);
    const work = f.node(...f.span("work"));
    const innerThunk = f.arrow("() => work", [], work, f.span(innerSuspendText)[0]);
    const innerSuspend = f.call(innerSuspendText, innerSuspendProp, [innerThunk]);
    const asSome = f.call(`Effect.asSome(${innerSuspendText})`, f.property("Effect", "asSome"), [innerSuspend]);
    const none = f.call("Option.none()", f.property("Option", "none"), []);
    const falseSucceed = f.call("Effect.succeed(Option.none())", f.property("Effect", "succeed"), [none]);
    const conditionalText = `ready ? Effect.asSome(${innerSuspendText}) : Effect.succeed(Option.none())`;
    const conditional = f.conditional(conditionalText, condition, asSome, falseSucceed);
    const outerThunk = f.arrow(`() => ${conditionalText}`, [], conditional);
    const outer = f.call(source, outerProp, [outerThunk]);
    const result = runRule(whenFromSuspendedConditionalRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "asSome", node: asSome, symbol: "asSome", resultEffect: true },
        { id: "innerSuspend", node: innerSuspend, symbol: "suspend", resultEffect: true },
        { id: "succeed", node: falseSucceed, symbol: "succeed", resultEffect: true },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, `Effect.when(${innerSuspendText}, () => ready)`);
});
test("forEach rule converts only dense array map callbacks that construct Effect.suspend", () => {
    const source = "Effect.all([1, 2].map(x => Effect.suspend(() => Effect.succeed(x))))";
    const f = ast(source);
    const outerProp = f.property("Effect", "all");
    const element1 = f.node(...f.span("1"));
    const element2 = f.node(...f.span("2"));
    const receiver = f.array("[1, 2]", [element1, element2]);
    const mapProperty = f.node(...f.span("[1, 2].map"), { expression: receiver, name: f.identifier("map", f.span(".map")[0] + 1) });
    const suspendText = "Effect.suspend(() => Effect.succeed(x))";
    const succeedArg = f.identifier("x", f.span("Effect.succeed(x)")[0] + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedArg]);
    const suspendThunk = f.arrow("() => Effect.succeed(x)", [], succeed);
    const suspended = f.call(suspendText, f.property("Effect", "suspend"), [suspendThunk]);
    const mapperParam = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${suspendText}`, [mapperParam], suspended);
    const mapped = f.call(`[1, 2].map(x => ${suspendText})`, mapProperty, [mapper]);
    const outer = f.call(source, outerProp, [mapped]);
    const arrayMapSymbol = {
        id: "Array.map",
        name: "map",
        qualifiedName: "Array.map",
        kind: "method",
        flags: ["Method"],
        external: true,
        declarations: [{ filePath: "/project/node_modules/typescript/lib/lib.es5.d.ts", line: 1, column: 1 }],
    };
    const result = runRule(forEachFromDenseArrayAllRule, f, outer, [
        { id: "outer", node: outer, symbol: "all", resultEffect: true },
        { id: "mapped", node: mapped, symbol: "map", module: "Array", resultEffect: false },
        { id: "suspend", node: suspended, symbol: "suspend", resultEffect: true },
    ], [arrayMapSymbol]);
    // semanticModel normally creates Effect package symbols; override the Array.map alias target used by the nested call.
    // The helper's module-derived id is the same as the supplied symbol id, so this resolves to the TS lib declaration.
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, `Effect.forEach([1, 2], x => ${suspendText})`);
});
test("forEach rule rejects Array.map callbacks that observe the third array argument", () => {
    const source = "Effect.all([1].map((x, index, array) => Effect.suspend(() => Effect.succeed(array[index]))))";
    const f = ast(source);
    const outerProp = f.property("Effect", "all");
    const element = f.node(...f.span("1"));
    const receiver = f.array("[1]", [element]);
    const mapProperty = f.node(...f.span("[1].map"), {
        expression: receiver,
        name: f.identifier("map", f.span(".map")[0] + 1),
    });
    const succeedArg = f.node(...f.span("array[index]"));
    const succeed = f.call("Effect.succeed(array[index])", f.property("Effect", "succeed"), [succeedArg]);
    const suspendThunk = f.arrow("() => Effect.succeed(array[index])", [], succeed);
    const suspended = f.call("Effect.suspend(() => Effect.succeed(array[index]))", f.property("Effect", "suspend"), [suspendThunk]);
    const callbackStart = f.span("(x, index, array) =>")[0];
    const mapper = f.arrow("(x, index, array) => Effect.suspend(() => Effect.succeed(array[index]))", [
        f.parameter("x", callbackStart + 1),
        f.parameter("index", callbackStart + 4),
        f.parameter("array", callbackStart + 11),
    ], suspended);
    const mapped = f.call("[1].map((x, index, array) => Effect.suspend(() => Effect.succeed(array[index])))", mapProperty, [mapper]);
    const outer = f.call(source, outerProp, [mapped]);
    const arrayMapSymbol = {
        id: "Array.map",
        name: "map",
        qualifiedName: "Array.map",
        kind: "method",
        flags: ["Method"],
        external: true,
        declarations: [{ filePath: "/project/node_modules/typescript/lib/lib.es5.d.ts", line: 1, column: 1 }],
    };
    const result = runRule(forEachFromDenseArrayAllRule, f, outer, [
        { id: "outer", node: outer, symbol: "all", resultEffect: true },
        { id: "mapped", node: mapped, symbol: "map", module: "Array", resultEffect: false },
        { id: "suspend", node: suspended, symbol: "suspend", resultEffect: true },
    ], [arrayMapSymbol]);
    assert.equal(result.decision.kind, "skip");
});
test("as rule converts only primitive constant mappings", () => {
    const source = "Effect.map(input, () => 42)";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const value = f.node(...f.span("42"));
    const mapper = f.arrow("() => 42", [], value);
    const outer = f.call(source, f.property("Effect", "map"), [self, mapper]);
    const result = runRule(asFromMapConstantPrimitiveRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.as(input, 42)");
});
test("as rule does not move object allocation to Effect construction time", () => {
    const source = "Effect.map(input, () => ({ value: 1 }))";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const value = f.node(...f.span("({ value: 1 })"));
    const mapper = f.arrow("() => ({ value: 1 })", [], value);
    const outer = f.call(source, f.property("Effect", "map"), [self, mapper]);
    const result = runRule(asFromMapConstantPrimitiveRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("asVoid rule converts side-effect-free void mapping", () => {
    const source = "Effect.map(input, () => void 0)";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const body = f.node(...f.span("void 0"));
    const mapper = f.arrow("() => void 0", [], body);
    const outer = f.call(source, f.property("Effect", "map"), [self, mapper]);
    const result = runRule(asVoidFromMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.asVoid(input)");
});
test("asSome rule converts identity Option.some mapping with proven Option binding", () => {
    const source = "Effect.map(input, x => Option.some(x))";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const param = f.parameter("x", f.span("x =>")[0]);
    const someStart = f.span("Option.some(x)")[0];
    const value = f.identifier("x", someStart + "Option.some(".length);
    const some = f.call("Option.some(x)", f.property("Option", "some"), [value]);
    const mapper = f.arrow("x => Option.some(x)", [param], some);
    const outer = f.call(source, f.property("Effect", "map"), [self, mapper]);
    const result = runRule(asSomeFromMapOptionSomeRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.asSome(input)");
});
test("asSomeError rule converts identity Option.some error mapping", () => {
    const source = "Effect.mapError(input, error => Option.some(error))";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const param = f.parameter("error", f.span("error =>")[0]);
    const someStart = f.span("Option.some(error)")[0];
    const value = f.identifier("error", someStart + "Option.some(".length);
    const some = f.call("Option.some(error)", f.property("Option", "some"), [value]);
    const mapper = f.arrow("error => Option.some(error)", [param], some);
    const outer = f.call(source, f.property("Effect", "mapError"), [self, mapper]);
    const result = runRule(asSomeErrorFromMapErrorOptionSomeRule, f, outer, [
        { id: "outer", node: outer, symbol: "mapError", resultEffect: true },
        { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.asSomeError(input)");
});
test("mapErrorCause rule converts catchAllCause+failCause", () => {
    const source = "Effect.catchAllCause(input, cause => Effect.failCause(transform(cause)))";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const transformed = f.node(...f.span("transform(cause)"));
    const failCause = f.call("Effect.failCause(transform(cause))", f.property("Effect", "failCause"), [transformed]);
    const param = f.parameter("cause", f.span("cause =>")[0]);
    const mapper = f.arrow("cause => Effect.failCause(transform(cause))", [param], failCause);
    const outer = f.call(source, f.property("Effect", "catchAllCause"), [self, mapper]);
    const result = runRule(mapErrorCauseFromCatchAllCauseFailCauseRule, f, outer, [
        { id: "outer", node: outer, symbol: "catchAllCause", resultEffect: true },
        { id: "failCause", node: failCause, symbol: "failCause", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.mapErrorCause(input, cause => transform(cause))");
});
test("filterOrElse rule converts identity-success conditional with proven effect fallback", () => {
    const source = "Effect.flatMap(input, x => x > 0 ? Effect.succeed(x) : recover(x))";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const condition = f.node(...f.span("x > 0"));
    const succeedStart = f.span("Effect.succeed(x)")[0];
    const succeedValue = f.identifier("x", succeedStart + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedValue]);
    const recoverExpression = f.identifier("recover", f.span("recover(x)")[0]);
    const recoverArg = f.identifier("x", f.span("recover(x)")[0] + "recover(".length);
    const fallback = f.call("recover(x)", recoverExpression, [recoverArg]);
    const conditionalText = "x > 0 ? Effect.succeed(x) : recover(x)";
    const conditional = f.conditional(conditionalText, condition, succeed, fallback);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${conditionalText}`, [param], conditional);
    const outer = f.call(source, f.property("Effect", "flatMap"), [self, mapper]);
    const result = runRule(filterOrElseFromFlatMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "fallback", node: fallback, symbol: "recover", module: "User", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.filterOrElse(input, x => x > 0, x => recover(x))");
});
test("filterOrElse rule defers Effect.fail fallback to filterOrFail", () => {
    const source = 'Effect.flatMap(input, x => x > 0 ? Effect.succeed(x) : Effect.fail("bad"))';
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const condition = f.node(...f.span("x > 0"));
    const succeedStart = f.span("Effect.succeed(x)")[0];
    const succeedValue = f.identifier("x", succeedStart + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedValue]);
    const error = f.node(...f.span('"bad"'));
    const fail = f.call('Effect.fail("bad")', f.property("Effect", "fail"), [error]);
    const conditionalText = 'x > 0 ? Effect.succeed(x) : Effect.fail("bad")';
    const conditional = f.conditional(conditionalText, condition, succeed, fail);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${conditionalText}`, [param], conditional);
    const outer = f.call(source, f.property("Effect", "flatMap"), [self, mapper]);
    const result = runRule(filterOrElseFromFlatMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "fail", node: fail, symbol: "fail", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("mapBoth rule converts matchEffect channel transformations", () => {
    const source = "Effect.matchEffect(input, { onFailure: e => Effect.fail(normalize(e)), onSuccess: a => Effect.succeed(a + 1) })";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const failureValue = f.node(...f.span("normalize(e)"));
    const fail = f.call("Effect.fail(normalize(e))", f.property("Effect", "fail"), [failureValue]);
    const failureParam = f.parameter("e", f.span("e =>")[0]);
    const onFailure = f.arrow("e => Effect.fail(normalize(e))", [failureParam], fail);
    const successValue = f.node(...f.span("a + 1"));
    const succeed = f.call("Effect.succeed(a + 1)", f.property("Effect", "succeed"), [successValue]);
    const successParam = f.parameter("a", f.span("a =>")[0]);
    const onSuccess = f.arrow("a => Effect.succeed(a + 1)", [successParam], succeed);
    const failureProperty = f.propertyAssignment("onFailure", onFailure);
    const successProperty = f.propertyAssignment("onSuccess", onSuccess);
    const optionsText = "{ onFailure: e => Effect.fail(normalize(e)), onSuccess: a => Effect.succeed(a + 1) }";
    const options = f.object(optionsText, [failureProperty, successProperty]);
    const outer = f.call(source, f.property("Effect", "matchEffect"), [self, options]);
    const result = runRule(mapBothFromMatchEffectRule, f, outer, [
        { id: "outer", node: outer, symbol: "matchEffect", resultEffect: true },
        { id: "fail", node: fail, symbol: "fail", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.mapBoth(input, { onFailure: e => normalize(e), onSuccess: a => a + 1 })");
});
test("flip rule converts exact matchEffect channel swap", () => {
    const source = "Effect.matchEffect(input, { onFailure: e => Effect.succeed(e), onSuccess: a => Effect.fail(a) })";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const failureParamStart = f.span("e =>")[0];
    const failureParam = f.parameter("e", failureParamStart);
    const succeedArg = f.identifier("e", f.span("Effect.succeed(e)")[0] + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(e)", f.property("Effect", "succeed"), [succeedArg]);
    const onFailure = f.arrow("e => Effect.succeed(e)", [failureParam], succeed);
    const successParamStart = f.span("a =>")[0];
    const successParam = f.parameter("a", successParamStart);
    const failArg = f.identifier("a", f.span("Effect.fail(a)")[0] + "Effect.fail(".length);
    const fail = f.call("Effect.fail(a)", f.property("Effect", "fail"), [failArg]);
    const onSuccess = f.arrow("a => Effect.fail(a)", [successParam], fail);
    const options = f.object("{ onFailure: e => Effect.succeed(e), onSuccess: a => Effect.fail(a) }", [f.propertyAssignment("onFailure", onFailure), f.propertyAssignment("onSuccess", onSuccess)]);
    const outer = f.call(source, f.property("Effect", "matchEffect"), [self, options]);
    const result = runRule(flipFromMatchEffectRule, f, outer, [
        { id: "outer", node: outer, symbol: "matchEffect", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "fail", node: fail, symbol: "fail", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.flip(input)");
});
test("merge rule converts Effect.match with two identity handlers", () => {
    const source = "Effect.match(input, { onFailure: e => e, onSuccess: a => a })";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const failureParamStart = f.span("e =>")[0];
    const failureParam = f.parameter("e", failureParamStart);
    const failureBody = f.identifier("e", failureParamStart + "e => ".length);
    const onFailure = f.arrow("e => e", [failureParam], failureBody);
    const successParamStart = f.span("a =>")[0];
    const successParam = f.parameter("a", successParamStart);
    const successBody = f.identifier("a", successParamStart + "a => ".length);
    const onSuccess = f.arrow("a => a", [successParam], successBody);
    const options = f.object("{ onFailure: e => e, onSuccess: a => a }", [f.propertyAssignment("onFailure", onFailure), f.propertyAssignment("onSuccess", onSuccess)]);
    const outer = f.call(source, f.property("Effect", "match"), [self, options]);
    const result = runRule(mergeFromMatchRule, f, outer, [
        { id: "outer", node: outer, symbol: "match", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.merge(input)");
});
test("filterOrDie rule converts identity validation with Effect.die", () => {
    const source = 'Effect.flatMap(input, x => x > 0 ? Effect.succeed(x) : Effect.die(new Error("bad")))';
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const condition = f.node(...f.span("x > 0"));
    const succeedStart = f.span("Effect.succeed(x)")[0];
    const succeedValue = f.identifier("x", succeedStart + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedValue]);
    const defect = f.node(...f.span('new Error("bad")'));
    const die = f.call('Effect.die(new Error("bad"))', f.property("Effect", "die"), [defect]);
    const conditionalText = 'x > 0 ? Effect.succeed(x) : Effect.die(new Error("bad"))';
    const conditional = f.conditional(conditionalText, condition, succeed, die);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${conditionalText}`, [param], conditional);
    const outer = f.call(source, f.property("Effect", "flatMap"), [self, mapper]);
    const result = runRule(filterOrDieFromFlatMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "die", node: die, symbol: "die", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, 'Effect.filterOrDie(input, x => x > 0, x => new Error("bad"))');
});
test("filterOrDieMessage rule converts only literal messages", () => {
    const source = 'Effect.flatMap(input, x => x > 0 ? Effect.succeed(x) : Effect.dieMessage("bad value"))';
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const condition = f.node(...f.span("x > 0"));
    const succeedStart = f.span("Effect.succeed(x)")[0];
    const succeedValue = f.identifier("x", succeedStart + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedValue]);
    const message = f.node(...f.span('"bad value"'));
    const dieMessage = f.call('Effect.dieMessage("bad value")', f.property("Effect", "dieMessage"), [message]);
    const conditionalText = 'x > 0 ? Effect.succeed(x) : Effect.dieMessage("bad value")';
    const conditional = f.conditional(conditionalText, condition, succeed, dieMessage);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${conditionalText}`, [param], conditional);
    const outer = f.call(source, f.property("Effect", "flatMap"), [self, mapper]);
    const result = runRule(filterOrDieMessageFromFlatMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "dieMessage", node: dieMessage, symbol: "dieMessage", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, 'Effect.filterOrDieMessage(input, x => x > 0, "bad value")');
});
test("filterOrDieMessage rule rejects a dynamic message whose evaluation would move earlier", () => {
    const source = 'Effect.flatMap(input, x => x > 0 ? Effect.succeed(x) : Effect.dieMessage(message()))';
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const condition = f.node(...f.span("x > 0"));
    const succeedStart = f.span("Effect.succeed(x)")[0];
    const succeedValue = f.identifier("x", succeedStart + "Effect.succeed(".length);
    const succeed = f.call("Effect.succeed(x)", f.property("Effect", "succeed"), [succeedValue]);
    const message = f.node(...f.span("message()"));
    const dieMessage = f.call("Effect.dieMessage(message())", f.property("Effect", "dieMessage"), [message]);
    const conditionalText = "x > 0 ? Effect.succeed(x) : Effect.dieMessage(message())";
    const conditional = f.conditional(conditionalText, condition, succeed, dieMessage);
    const param = f.parameter("x", f.span("x =>")[0]);
    const mapper = f.arrow(`x => ${conditionalText}`, [param], conditional);
    const outer = f.call(source, f.property("Effect", "flatMap"), [self, mapper]);
    const result = runRule(filterOrDieMessageFromFlatMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "dieMessage", node: dieMessage, symbol: "dieMessage", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("liftPredicate rule converts filterOrFail over Effect.succeed", () => {
    const source = 'Effect.filterOrFail(Effect.succeed(value()), x => x > 0, x => `bad ${x}`)';
    const f = ast(source);
    const value = f.node(...f.span("value()"));
    const succeed = f.call("Effect.succeed(value())", f.property("Effect", "succeed"), [value]);
    const predicate = f.node(...f.span("x => x > 0"));
    const onFailure = f.node(...f.span('x => `bad ${x}`'));
    const outer = f.call(source, f.property("Effect", "filterOrFail"), [succeed, predicate, onFailure]);
    const result = runRule(liftPredicateFromFilterOrFailSucceedRule, f, outer, [
        { id: "outer", node: outer, symbol: "filterOrFail", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, 'Effect.liftPredicate(value(), x => x > 0, x => `bad ${x}`)');
});
test("isSuccess and isFailure rules recognize the exact boolean Effect.match folds", () => {
    const successSource = "Effect.match(input, { onFailure: () => false, onSuccess: () => true })";
    const sf = ast(successSource);
    const successSelf = sf.node(...sf.span("input"));
    const falseBody = sf.node(...sf.span("false"));
    const trueBody = sf.node(...sf.span("true"));
    const onFailure = sf.arrow("() => false", [], falseBody);
    const onSuccess = sf.arrow("() => true", [], trueBody);
    const successOptions = sf.object("{ onFailure: () => false, onSuccess: () => true }", [sf.propertyAssignment("onFailure", onFailure), sf.propertyAssignment("onSuccess", onSuccess)]);
    const successOuter = sf.call(successSource, sf.property("Effect", "match"), [successSelf, successOptions]);
    const successResult = runRule(isSuccessFromMatchRule, sf, successOuter, [
        { id: "outer", node: successOuter, symbol: "match", resultEffect: true },
    ]);
    assert.equal(successResult.decision.kind, "convert");
    assert.equal(successResult.rewrite?.replacements[0]?.replacement, "Effect.isSuccess(input)");
    const failureSource = "Effect.match(input, { onFailure: () => true, onSuccess: () => false })";
    const ff = ast(failureSource);
    const failureSelf = ff.node(...ff.span("input"));
    const trueFailure = ff.node(...ff.span("true"));
    const falseSuccess = ff.node(...ff.span("false"));
    const failureOptions = ff.object("{ onFailure: () => true, onSuccess: () => false }", [
        ff.propertyAssignment("onFailure", ff.arrow("() => true", [], trueFailure)),
        ff.propertyAssignment("onSuccess", ff.arrow("() => false", [], falseSuccess)),
    ]);
    const failureOuter = ff.call(failureSource, ff.property("Effect", "match"), [failureSelf, failureOptions]);
    const failureResult = runRule(isFailureFromMatchRule, ff, failureOuter, [
        { id: "outer", node: failureOuter, symbol: "match", resultEffect: true },
    ]);
    assert.equal(failureResult.decision.kind, "convert");
    assert.equal(failureResult.rewrite?.replacements[0]?.replacement, "Effect.isFailure(input)");
});
test("exists rule converts findFirst followed by Option.isSome", () => {
    const source = "Effect.map(Effect.findFirst(items, (item, i) => check(item, i)), option => Option.isSome(option))";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const predicate = f.node(...f.span("(item, i) => check(item, i)"));
    const findFirst = f.call("Effect.findFirst(items, (item, i) => check(item, i))", f.property("Effect", "findFirst"), [items, predicate]);
    const optionParam = f.parameter("option", f.span("option =>")[0]);
    const optionArgStart = f.span("Option.isSome(option)")[0] + "Option.isSome(".length;
    const optionArg = f.identifier("option", optionArgStart);
    const isSome = f.call("Option.isSome(option)", f.property("Option", "isSome"), [optionArg]);
    const mapper = f.arrow("option => Option.isSome(option)", [optionParam], isSome);
    const outer = f.call(source, f.property("Effect", "map"), [findFirst, mapper]);
    const result = runRule(existsFromFindFirstRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "findFirst", node: findFirst, symbol: "findFirst", resultEffect: true },
        { id: "isSome", node: isSome, symbol: "isSome", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.exists(items, (item, i) => check(item, i))");
});
test("every rule preserves findFirst short-circuiting while removing the double negation", () => {
    const source = "Effect.map(Effect.findFirst(items, (item, i) => Effect.map(check(item, i), ok => !ok)), option => Option.isNone(option))";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const predicateEffect = f.node(...f.span("check(item, i)"));
    const okParam = f.parameter("ok", f.span("ok =>")[0]);
    const negated = f.node(...f.span("!ok"));
    const negateMapper = f.arrow("ok => !ok", [okParam], negated);
    const innerMap = f.call("Effect.map(check(item, i), ok => !ok)", f.property("Effect", "map", f.span("Effect.map(check")[0]), [predicateEffect, negateMapper]);
    const itemParam = f.parameter("item", f.span("(item, i) =>")[0] + 1);
    const iParam = f.parameter("i", f.span("(item, i) =>")[0] + "(item, ".length);
    const findPredicate = f.arrow("(item, i) => Effect.map(check(item, i), ok => !ok)", [itemParam, iParam], innerMap);
    const findFirst = f.call("Effect.findFirst(items, (item, i) => Effect.map(check(item, i), ok => !ok))", f.property("Effect", "findFirst"), [items, findPredicate]);
    const optionParam = f.parameter("option", f.span("option =>")[0]);
    const optionArg = f.identifier("option", f.span("Option.isNone(option)")[0] + "Option.isNone(".length);
    const isNone = f.call("Option.isNone(option)", f.property("Option", "isNone"), [optionArg]);
    const outerMapper = f.arrow("option => Option.isNone(option)", [optionParam], isNone);
    const outer = f.call(source, f.property("Effect", "map"), [findFirst, outerMapper]);
    const result = runRule(everyFromFindFirstNegatedRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "findFirst", node: findFirst, symbol: "findFirst", resultEffect: true },
        { id: "innerMap", node: innerMap, symbol: "map", resultEffect: true },
        { id: "isNone", node: isNone, symbol: "isNone", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.every(items, (item, i) => check(item, i))");
});
test("filterMap rule converts sequential all plus Effect Array.filterMap", () => {
    const source = "Effect.map(Effect.all(effects), values => Array.filterMap(values, toOption))";
    const f = ast(source);
    const effects = f.node(...f.span("effects"));
    const all = f.call("Effect.all(effects)", f.property("Effect", "all"), [effects]);
    const valuesParam = f.parameter("values", f.span("values =>")[0]);
    const valuesArg = f.identifier("values", f.span("Array.filterMap(values")[0] + "Array.filterMap(".length);
    const toOption = f.identifier("toOption", f.span("toOption")[0]);
    const arrayFilterMap = f.call("Array.filterMap(values, toOption)", f.property("Array", "filterMap"), [valuesArg, toOption]);
    const mapper = f.arrow("values => Array.filterMap(values, toOption)", [valuesParam], arrayFilterMap);
    const outer = f.call(source, f.property("Effect", "map"), [all, mapper]);
    const result = runRule(filterMapFromAllArrayFilterMapRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "all", node: all, symbol: "all", resultEffect: true },
        { id: "arrayFilterMap", node: arrayFilterMap, symbol: "filterMap", module: "Array", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.filterMap(effects, toOption)");
});
test("filter rule converts sequential forEach Option compaction", () => {
    const source = "Effect.map(Effect.forEach(items, (item, i) => Effect.map(check(item, i), keep => keep ? Option.some(item) : Option.none())), options => Array.getSomes(options))";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const predicateEffect = f.node(...f.span("check(item, i)"));
    const keepParam = f.parameter("keep", f.span("keep =>")[0]);
    const keepCondition = f.identifier("keep", f.span("keep ?")[0]);
    const someArg = f.identifier("item", f.span("Option.some(item)")[0] + "Option.some(".length);
    const some = f.call("Option.some(item)", f.property("Option", "some"), [someArg]);
    const none = f.call("Option.none()", f.property("Option", "none"), []);
    const optionConditional = f.conditional("keep ? Option.some(item) : Option.none()", keepCondition, some, none);
    const keepMapper = f.arrow("keep => keep ? Option.some(item) : Option.none()", [keepParam], optionConditional);
    const predicateMap = f.call("Effect.map(check(item, i), keep => keep ? Option.some(item) : Option.none())", f.property("Effect", "map", f.span("Effect.map(check")[0]), [predicateEffect, keepMapper]);
    const itemParam = f.parameter("item", f.span("(item, i) =>")[0] + 1);
    const iParam = f.parameter("i", f.span("(item, i) =>")[0] + "(item, ".length);
    const callback = f.arrow("(item, i) => Effect.map(check(item, i), keep => keep ? Option.some(item) : Option.none())", [itemParam, iParam], predicateMap);
    const forEach = f.call("Effect.forEach(items, (item, i) => Effect.map(check(item, i), keep => keep ? Option.some(item) : Option.none()))", f.property("Effect", "forEach"), [items, callback]);
    const optionsParam = f.parameter("options", f.span("options =>")[0]);
    const optionsArg = f.identifier("options", f.span("Array.getSomes(options)")[0] + "Array.getSomes(".length);
    const getSomes = f.call("Array.getSomes(options)", f.property("Array", "getSomes"), [optionsArg]);
    const collector = f.arrow("options => Array.getSomes(options)", [optionsParam], getSomes);
    const outer = f.call(source, f.property("Effect", "map"), [forEach, collector]);
    const result = runRule(filterFromForEachOptionsRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "forEach", node: forEach, symbol: "forEach", resultEffect: true },
        { id: "predicateMap", node: predicateMap, symbol: "map", resultEffect: true },
        { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
        { id: "getSomes", node: getSomes, symbol: "getSomes", module: "Array", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.filter(items, (item, i) => check(item, i))");
});
test("head rule converts flatMap + Option.fromIterable", () => {
    const source = "Effect.flatMap(input, values => Option.fromIterable(values))";
    const f = ast(source);
    const self = f.node(...f.span("input"));
    const valuesParam = f.parameter("values", f.span("values =>")[0]);
    const valueArg = f.identifier("values", f.span("Option.fromIterable(values)")[0] + "Option.fromIterable(".length);
    const fromIterable = f.call("Option.fromIterable(values)", f.property("Option", "fromIterable"), [valueArg]);
    const mapper = f.arrow("values => Option.fromIterable(values)", [valuesParam], fromIterable);
    const outer = f.call(source, f.property("Effect", "flatMap"), [self, mapper]);
    const result = runRule(headFromFlatMapOptionFromIterableRule, f, outer, [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "fromIterable", node: fromIterable, symbol: "fromIterable", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.head(input)");
});
test("reduce rule converts Effect v3 canonical Array.reduce lowering", () => {
    const source = "Array.fromIterable(items).reduce((acc, item, i) => Effect.flatMap(acc, state => step(state, item, i)), Effect.succeed(0))";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const fromIterable = f.call("Array.fromIterable(items)", f.property("Array", "fromIterable"), [items]);
    const reduceProperty = methodProperty(f, fromIterable, "Array.fromIterable(items).reduce", "reduce");
    const reducerStart = f.span("(acc, item, i) =>")[0];
    const acc = f.parameter("acc", reducerStart + 1);
    const item = f.parameter("item", reducerStart + 6);
    const index = f.parameter("i", reducerStart + 12);
    const step = f.node(...f.span("step(state, item, i)"));
    const stateParam = f.parameter("state", f.span("state =>")[0]);
    const mapper = f.arrow("state => step(state, item, i)", [stateParam], step);
    const flatAcc = f.identifier("acc", f.span("Effect.flatMap(acc")[0] + "Effect.flatMap(".length);
    const flatMap = f.call("Effect.flatMap(acc, state => step(state, item, i))", f.property("Effect", "flatMap"), [flatAcc, mapper]);
    const reducer = f.arrow("(acc, item, i) => Effect.flatMap(acc, state => step(state, item, i))", [acc, item, index], flatMap);
    const zero = f.node(...f.span("0", f.span("Effect.succeed(0)")[0]));
    const succeed = f.call("Effect.succeed(0)", f.property("Effect", "succeed"), [zero]);
    const outer = f.call(source, reduceProperty, [reducer, succeed]);
    const result = runRule(reduceFromArrayReduceRule, f, outer, [
        { id: "outer", node: outer, symbol: "reduce", module: "Array", resultEffect: true },
        { id: "fromIterable", node: fromIterable, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "flatMap", node: flatMap, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ], [nativeArrayMethodSymbol("reduce")]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.reduce(items, 0, (state, item, i) => step(state, item, i))");
});
test("reduce rule rejects a non-TypeScript reduce binding", () => {
    const source = "Array.fromIterable(items).reduce((acc, item) => Effect.flatMap(acc, state => step(state, item)), Effect.succeed(0))";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const fromIterable = f.call("Array.fromIterable(items)", f.property("Array", "fromIterable"), [items]);
    const reduceProperty = methodProperty(f, fromIterable, "Array.fromIterable(items).reduce", "reduce");
    const acc = f.parameter("acc", f.span("(acc, item)")[0] + 1);
    const item = f.parameter("item", f.span("(acc, item)")[0] + 6);
    const step = f.node(...f.span("step(state, item)"));
    const stateParam = f.parameter("state", f.span("state =>")[0]);
    const mapper = f.arrow("state => step(state, item)", [stateParam], step);
    const flatAcc = f.identifier("acc", f.span("Effect.flatMap(acc")[0] + "Effect.flatMap(".length);
    const flatMap = f.call("Effect.flatMap(acc, state => step(state, item))", f.property("Effect", "flatMap"), [flatAcc, mapper]);
    const reducer = f.arrow("(acc, item) => Effect.flatMap(acc, state => step(state, item))", [acc, item], flatMap);
    const zero = f.node(...f.span("0", f.span("Effect.succeed(0)")[0]));
    const succeed = f.call("Effect.succeed(0)", f.property("Effect", "succeed"), [zero]);
    const outer = f.call(source, reduceProperty, [reducer, succeed]);
    const result = runRule(reduceFromArrayReduceRule, f, outer, [
        { id: "outer", node: outer, symbol: "reduce", module: "Array", resultEffect: true },
        { id: "fromIterable", node: fromIterable, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "flatMap", node: flatMap, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("reduceRight rule converts Effect v3 canonical right fold", () => {
    const source = "Array.fromIterable(items).reduceRight((acc, item, i) => Effect.flatMap(acc, state => step(item, state, i)), Effect.succeed(0))";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const fromIterable = f.call("Array.fromIterable(items)", f.property("Array", "fromIterable"), [items]);
    const reduceProperty = methodProperty(f, fromIterable, "Array.fromIterable(items).reduceRight", "reduceRight");
    const reducerStart = f.span("(acc, item, i) =>")[0];
    const acc = f.parameter("acc", reducerStart + 1);
    const item = f.parameter("item", reducerStart + 6);
    const index = f.parameter("i", reducerStart + 12);
    const step = f.node(...f.span("step(item, state, i)"));
    const stateParam = f.parameter("state", f.span("state =>")[0]);
    const mapper = f.arrow("state => step(item, state, i)", [stateParam], step);
    const flatAcc = f.identifier("acc", f.span("Effect.flatMap(acc")[0] + "Effect.flatMap(".length);
    const flatMap = f.call("Effect.flatMap(acc, state => step(item, state, i))", f.property("Effect", "flatMap"), [flatAcc, mapper]);
    const reducer = f.arrow("(acc, item, i) => Effect.flatMap(acc, state => step(item, state, i))", [acc, item, index], flatMap);
    const zero = f.node(...f.span("0", f.span("Effect.succeed(0)")[0]));
    const succeed = f.call("Effect.succeed(0)", f.property("Effect", "succeed"), [zero]);
    const outer = f.call(source, reduceProperty, [reducer, succeed]);
    const result = runRule(reduceRightFromArrayReduceRightRule, f, outer, [
        { id: "outer", node: outer, symbol: "reduceRight", module: "Array", resultEffect: true },
        { id: "fromIterable", node: fromIterable, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "flatMap", node: flatMap, symbol: "flatMap", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ], [nativeArrayMethodSymbol("reduceRight")]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.reduceRight(items, 0, (item, state, i) => step(item, state, i))");
});
test("reduceEffect rule converts the default sequential zipWith reduction", () => {
    const source = "Array.fromIterable(effects).reduce((acc, effect, i) => Effect.zipWith(acc, effect, (state, value) => combine(state, value, i)), zero)";
    const f = ast(source);
    const effects = f.node(...f.span("effects"));
    const fromIterable = f.call("Array.fromIterable(effects)", f.property("Array", "fromIterable"), [effects]);
    const reduceProperty = methodProperty(f, fromIterable, "Array.fromIterable(effects).reduce", "reduce");
    const reducerStart = f.span("(acc, effect, i) =>")[0];
    const accParam = f.parameter("acc", reducerStart + 1);
    const effectParam = f.parameter("effect", reducerStart + 6);
    const indexParam = f.parameter("i", reducerStart + 14);
    const combine = f.node(...f.span("combine(state, value, i)"));
    const combinerStart = f.span("(state, value) =>")[0];
    const stateParam = f.parameter("state", combinerStart + 1);
    const valueParam = f.parameter("value", combinerStart + 8);
    const combiner = f.arrow("(state, value) => combine(state, value, i)", [stateParam, valueParam], combine);
    const zipStart = f.span("Effect.zipWith(acc, effect")[0];
    const accArg = f.identifier("acc", zipStart + "Effect.zipWith(".length);
    const effectArg = f.identifier("effect", zipStart + "Effect.zipWith(acc, ".length);
    const zipWith = f.call("Effect.zipWith(acc, effect, (state, value) => combine(state, value, i))", f.property("Effect", "zipWith"), [accArg, effectArg, combiner]);
    const reducer = f.arrow("(acc, effect, i) => Effect.zipWith(acc, effect, (state, value) => combine(state, value, i))", [accParam, effectParam, indexParam], zipWith);
    const zero = f.node(...f.span("zero", source.lastIndexOf("zero")));
    const outer = f.call(source, reduceProperty, [reducer, zero]);
    const result = runRule(reduceEffectFromArrayReduceZipWithRule, f, outer, [
        { id: "outer", node: outer, symbol: "reduce", module: "Array", resultEffect: true },
        { id: "fromIterable", node: fromIterable, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "zipWith", node: zipWith, symbol: "zipWith", resultEffect: true },
    ], [nativeArrayMethodSymbol("reduce")]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.reduceEffect(effects, zero, (state, value, i) => combine(state, value, i))");
});
test("findFirst rule converts an Option-state reduceWhile over a private Array copy", () => {
    const source = "Effect.reduceWhile(Array.fromIterable(items), Option.none(), { while: state => Option.isNone(state), body: (state, item, i) => Effect.map(check(item, i), matched => matched ? Option.some(item) : state) })";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const materialized = f.call("Array.fromIterable(items)", f.property("Array", "fromIterable"), [items]);
    const none = f.call("Option.none()", f.property("Option", "none"), []);
    const whileStart = f.span("state => Option.isNone(state)")[0];
    const whileParam = f.parameter("state", whileStart);
    const isNoneArg = f.identifier("state", f.span("Option.isNone(state)")[0] + "Option.isNone(".length);
    const isNone = f.call("Option.isNone(state)", f.property("Option", "isNone"), [isNoneArg]);
    const whileFn = f.arrow("state => Option.isNone(state)", [whileParam], isNone);
    const bodyStart = f.span("(state, item, i) =>")[0];
    const bodyState = f.parameter("state", bodyStart + 1);
    const bodyItem = f.parameter("item", bodyStart + 8);
    const bodyIndex = f.parameter("i", bodyStart + 14);
    const check = f.call("check(item, i)", f.identifier("check", f.span("check(item, i)")[0]), [
        f.identifier("item", f.span("check(item, i)")[0] + "check(".length),
        f.identifier("i", f.span("check(item, i)")[0] + "check(item, ".length),
    ]);
    const matchedStart = f.span("matched =>")[0];
    const matchedParam = f.parameter("matched", matchedStart);
    const matchedCond = f.identifier("matched", f.span("matched ?")[0]);
    const someStart = f.span("Option.some(item)")[0];
    const someItem = f.identifier("item", someStart + "Option.some(".length);
    const some = f.call("Option.some(item)", f.property("Option", "some"), [someItem]);
    const falseState = f.identifier("state", f.span(": state")[0] + 2);
    const conditional = f.conditional("matched ? Option.some(item) : state", matchedCond, some, falseState);
    const resultMapper = f.arrow("matched => matched ? Option.some(item) : state", [matchedParam], conditional);
    const mapped = f.call("Effect.map(check(item, i), matched => matched ? Option.some(item) : state)", f.property("Effect", "map"), [check, resultMapper]);
    const bodyFn = f.arrow("(state, item, i) => Effect.map(check(item, i), matched => matched ? Option.some(item) : state)", [bodyState, bodyItem, bodyIndex], mapped);
    const whileProp = f.propertyAssignment("while", whileFn, f.span("{ while:")[0] + 2);
    const bodyProp = f.propertyAssignment("body", bodyFn, f.span(", body:")[0] + 2);
    const options = f.object("{ while: state => Option.isNone(state), body: (state, item, i) => Effect.map(check(item, i), matched => matched ? Option.some(item) : state) }", [whileProp, bodyProp]);
    const outer = f.call(source, f.property("Effect", "reduceWhile"), [materialized, none, options]);
    const result = runRule(findFirstFromReduceWhileOptionRule, f, outer, [
        { id: "outer", node: outer, symbol: "reduceWhile", resultEffect: true },
        { id: "materialized", node: materialized, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
        { id: "isNone", node: isNone, symbol: "isNone", module: "Option", resultEffect: false },
        { id: "check", node: check, symbol: "check", module: "User", resultEffect: true },
        { id: "mapped", node: mapped, symbol: "map", resultEffect: true },
        { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.findFirst(Array.fromIterable(items), (item, i) => check(item, i))");
});
test("reduceWhile rule converts a private-array iterate state machine", () => {
    const source = "Effect.map(Effect.iterate({ values: Array.fromIterable(items), index: 0, state: zero }, { while: cursor => cursor.index < cursor.values.length && keep(cursor.state), body: cursor => Effect.map(step(cursor.state, cursor.values[cursor.index], cursor.index), next => ({ values: cursor.values, index: cursor.index + 1, state: next })) }), result => result.state)";
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const materialized = f.call("Array.fromIterable(items)", f.property("Array", "fromIterable"), [items]);
    const indexZero = f.node(...f.span("0", f.span("index: 0")[0]));
    const zero = f.node(...f.span("zero"));
    const initialValuesProp = f.propertyAssignment("values", materialized, f.span("{ values:")[0] + 2);
    const initialIndexProp = f.propertyAssignment("index", indexZero, f.span(", index: 0")[0] + 2);
    const initialStateProp = f.propertyAssignment("state", zero, f.span(", state: zero")[0] + 2);
    const initial = f.object("{ values: Array.fromIterable(items), index: 0, state: zero }", [initialValuesProp, initialIndexProp, initialStateProp]);
    const whileStart = f.span("cursor => cursor.index")[0];
    const whileParam = f.parameter("cursor", whileStart);
    const whileBody = f.node(...f.span("cursor.index < cursor.values.length && keep(cursor.state)"));
    const whileFn = f.arrow("cursor => cursor.index < cursor.values.length && keep(cursor.state)", [whileParam], whileBody);
    const bodyStart = f.span("cursor => Effect.map(step")[0];
    const bodyParam = f.parameter("cursor", bodyStart);
    const step = f.call("step(cursor.state, cursor.values[cursor.index], cursor.index)", f.identifier("step", f.span("step(cursor.state")[0]), [
        f.node(...f.span("cursor.state", f.span("step(cursor.state")[0])),
        f.node(...f.span("cursor.values[cursor.index]")),
        f.node(...f.span("cursor.index", f.span("cursor.values[cursor.index]")[1])),
    ]);
    const nextStart = f.span("next => ({")[0];
    const nextParam = f.parameter("next", nextStart);
    const nextValues = f.node(...f.span("cursor.values", f.span("next => ({")[0]));
    const nextIndex = f.node(...f.span("cursor.index + 1"));
    const nextState = f.identifier("next", f.span("state: next")[0] + "state: ".length);
    const nextValuesProp = f.propertyAssignment("values", nextValues, f.span("{ values: cursor.values", nextStart)[0] + 2);
    const nextIndexProp = f.propertyAssignment("index", nextIndex, f.span(", index: cursor.index + 1")[0] + 2);
    const nextStateProp = f.propertyAssignment("state", nextState, f.span(", state: next")[0] + 2);
    const nextObject = f.object("{ values: cursor.values, index: cursor.index + 1, state: next }", [nextValuesProp, nextIndexProp, nextStateProp], nextStart);
    const nextMapper = f.arrow("next => ({ values: cursor.values, index: cursor.index + 1, state: next })", [nextParam], nextObject);
    const bodyMap = f.call("Effect.map(step(cursor.state, cursor.values[cursor.index], cursor.index), next => ({ values: cursor.values, index: cursor.index + 1, state: next }))", f.property("Effect", "map", bodyStart), [step, nextMapper]);
    const bodyFn = f.arrow("cursor => Effect.map(step(cursor.state, cursor.values[cursor.index], cursor.index), next => ({ values: cursor.values, index: cursor.index + 1, state: next }))", [bodyParam], bodyMap);
    const whileProp = f.propertyAssignment("while", whileFn, f.span("{ while: cursor")[0] + 2);
    const bodyProp = f.propertyAssignment("body", bodyFn, f.span(", body: cursor")[0] + 2);
    const options = f.object("{ while: cursor => cursor.index < cursor.values.length && keep(cursor.state), body: cursor => Effect.map(step(cursor.state, cursor.values[cursor.index], cursor.index), next => ({ values: cursor.values, index: cursor.index + 1, state: next })) }", [whileProp, bodyProp]);
    const iterate = f.call(`Effect.iterate(${f.source.slice(initial.getStart(f.sourceFile), initial.getEnd())}, ${f.source.slice(options.getStart(f.sourceFile), options.getEnd())})`, f.property("Effect", "iterate"), [initial, options]);
    const projectionStart = f.span("result => result.state")[0];
    const projectionParam = f.parameter("result", projectionStart);
    const projectionBody = f.node(...f.span("result.state"));
    const projection = f.arrow("result => result.state", [projectionParam], projectionBody);
    const outer = f.call(source, f.property("Effect", "map"), [iterate, projection]);
    const result = runRule(reduceWhileFromIterateStateRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "iterate", node: iterate, symbol: "iterate", resultEffect: true },
        { id: "materialized", node: materialized, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "step", node: step, symbol: "step", module: "User", resultEffect: true },
        { id: "bodyMap", node: bodyMap, symbol: "map", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.reduceWhile(Array.fromIterable(items), zero, { while: (state) => keep(state), body: (state, element, index) => step(state,element,index) })");
});
for (const spec of [
    { target: "takeWhile", rule: takeWhileFromMapAccumRule, initial: true, predicateTrue: true, fallback: false, emitCondition: "next", someTrue: true },
    { target: "dropWhile", rule: dropWhileFromMapAccumRule, initial: true, predicateTrue: true, fallback: false, emitCondition: "next", someTrue: false },
    { target: "takeUntil", rule: takeUntilFromMapAccumRule, initial: false, predicateTrue: false, fallback: true, emitCondition: "state", someTrue: false },
    { target: "dropUntil", rule: dropUntilFromMapAccumRule, initial: false, predicateTrue: false, fallback: true, emitCondition: "state", someTrue: true },
]) {
    test(`${spec.target} rule converts boolean-state mapAccum + Option compaction`, () => {
        const built = buildTakeDropCase(spec);
        const result = runRule(spec.rule, built.factory, built.outer, built.calls);
        assert.equal(result.decision.kind, "convert");
        assert.equal(result.rewrite?.replacements[0]?.replacement, `Effect.${spec.target}(items, (item, i) => check(item, i))`);
    });
}
test("takeWhile rule rejects predicates that depend on the internal state flag", () => {
    const spec = { target: "takeWhile", rule: takeWhileFromMapAccumRule, initial: true, predicateTrue: true, fallback: false, emitCondition: "next", someTrue: true };
    const built = buildTakeDropCase(spec, "check(state, item, i)");
    const result = runRule(spec.rule, built.factory, built.outer, built.calls);
    assert.equal(result.decision.kind, "skip");
});
function nativeArrayMethodSymbol(name) {
    return {
        id: `Array.${name}`,
        name,
        qualifiedName: `Array.${name}`,
        kind: "method",
        flags: ["Method"],
        external: true,
        declarations: [{ filePath: "/project/node_modules/typescript/lib/lib.es5.d.ts", line: 1, column: 1 }],
    };
}
function methodProperty(f, receiver, fullText, name) {
    const [start, end] = f.span(fullText);
    const nameStart = end - name.length;
    return f.node(start, end, { expression: receiver, name: f.identifier(name, nameStart) });
}
function buildTakeDropCase(spec, predicateText = "check(item, i)") {
    const fallbackText = `Effect.succeed(${String(spec.fallback)})`;
    const stateEffectText = spec.predicateTrue
        ? `state ? ${predicateText} : ${fallbackText}`
        : `state ? ${fallbackText} : ${predicateText}`;
    const someText = "Option.some(item)";
    const noneText = "Option.none()";
    const emittedText = spec.someTrue
        ? `${spec.emitCondition} ? ${someText} : ${noneText}`
        : `${spec.emitCondition} ? ${noneText} : ${someText}`;
    const reducerText = `(state, item, i) => Effect.map(${stateEffectText}, next => [next, ${emittedText}])`;
    const mapAccumText = `Effect.mapAccum(items, ${String(spec.initial)}, ${reducerText})`;
    const source = `Effect.map(${mapAccumText}, result => Array.getSomes(result[1]))`;
    const f = ast(source);
    const items = f.node(...f.span("items"));
    const initial = f.node(...f.span(String(spec.initial), f.span("Effect.mapAccum")[0]));
    const reducerStart = f.span("(state, item, i) =>")[0];
    const stateParam = f.parameter("state", reducerStart + 1);
    const itemParam = f.parameter("item", reducerStart + 8);
    const indexParam = f.parameter("i", reducerStart + 14);
    const predicateStart = f.span(predicateText)[0];
    const predicateArgs = predicateText.includes("state")
        ? [
            f.identifier("state", predicateStart + "check(".length),
            f.identifier("item", predicateStart + "check(state, ".length),
            f.identifier("i", predicateStart + "check(state, item, ".length),
        ]
        : [
            f.identifier("item", predicateStart + "check(".length),
            f.identifier("i", predicateStart + "check(item, ".length),
        ];
    const predicate = f.call(predicateText, f.identifier("check", predicateStart), predicateArgs);
    const fallbackBoolStart = f.span(String(spec.fallback), f.span(fallbackText)[0])[0];
    const fallbackBool = f.node(fallbackBoolStart, fallbackBoolStart + String(spec.fallback).length);
    const fallback = f.call(fallbackText, f.property("Effect", "succeed", f.span(fallbackText)[0]), [fallbackBool]);
    const stateCondStart = f.span(stateEffectText)[0];
    const stateCondition = f.identifier("state", stateCondStart);
    const stateConditional = spec.predicateTrue
        ? f.conditional(stateEffectText, stateCondition, predicate, fallback)
        : f.conditional(stateEffectText, stateCondition, fallback, predicate);
    const nextStart = f.span("next =>")[0];
    const nextParam = f.parameter("next", nextStart);
    const emittedStart = f.span(emittedText)[0];
    const emittedCondition = f.identifier(spec.emitCondition, emittedStart);
    const someStart = f.span(someText)[0];
    const someItem = f.identifier("item", someStart + "Option.some(".length);
    const some = f.call(someText, f.property("Option", "some", someStart), [someItem]);
    const none = f.call(noneText, f.property("Option", "none", f.span(noneText)[0]), []);
    const emitted = spec.someTrue
        ? f.conditional(emittedText, emittedCondition, some, none)
        : f.conditional(emittedText, emittedCondition, none, some);
    const tupleStart = f.span(`[next, ${emittedText}]`)[0];
    const tupleNext = f.identifier("next", tupleStart + 1);
    const tuple = f.array(`[next, ${emittedText}]`, [tupleNext, emitted]);
    const tupleMapper = f.arrow(`next => [next, ${emittedText}]`, [nextParam], tuple);
    const mappedText = `Effect.map(${stateEffectText}, next => [next, ${emittedText}])`;
    const mapped = f.call(mappedText, f.property("Effect", "map", f.span(mappedText)[0]), [stateConditional, tupleMapper]);
    const reducer = f.arrow(reducerText, [stateParam, itemParam, indexParam], mapped);
    const mapAccum = f.call(mapAccumText, f.property("Effect", "mapAccum"), [items, initial, reducer]);
    const resultStart = f.span("result => Array.getSomes")[0];
    const resultParam = f.parameter("result", resultStart);
    const resultIndex = f.node(...f.span("result[1]"));
    const getSomes = f.call("Array.getSomes(result[1])", f.property("Array", "getSomes"), [resultIndex]);
    const compact = f.arrow("result => Array.getSomes(result[1])", [resultParam], getSomes);
    const outer = f.call(source, f.property("Effect", "map"), [mapAccum, compact]);
    const calls = [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "mapAccum", node: mapAccum, symbol: "mapAccum", resultEffect: true },
        { id: "mapped", node: mapped, symbol: "map", resultEffect: true },
        { id: "predicate", node: predicate, symbol: "check", module: "User", resultEffect: true },
        { id: "fallback", node: fallback, symbol: "succeed", resultEffect: true },
        { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
        { id: "getSomes", node: getSomes, symbol: "getSomes", module: "Array", resultEffect: false },
    ];
    return { factory: f, outer, calls };
}
test("replicateEffect rule converts all(replicate(...)) with compatible options", () => {
    const source = 'Effect.all(Effect.replicate(task, 3), { concurrency: 2, discard: true })';
    const f = ast(source);
    const task = f.node(...f.span("task"));
    const count = f.node(...f.span("3"));
    const replicate = f.call("Effect.replicate(task, 3)", f.property("Effect", "replicate"), [task, count]);
    const concurrency = f.node(...f.span("2"));
    const discard = f.node(...f.span("true"));
    const concurrencyProp = f.propertyAssignment("concurrency", concurrency, f.span("{ concurrency:")[0] + 2);
    const discardProp = f.propertyAssignment("discard", discard, f.span(", discard:")[0] + 2);
    const options = f.object("{ concurrency: 2, discard: true }", [concurrencyProp, discardProp]);
    const outer = f.call(source, f.property("Effect", "all"), [replicate, options]);
    const result = runRule(replicateEffectFromAllReplicateRule, f, outer, [
        { id: "outer", node: outer, symbol: "all", resultEffect: true },
        { id: "replicate", node: replicate, symbol: "replicate", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.replicateEffect(task, 3, { concurrency: 2, discard: true })");
});
test("replicateEffect rule rejects Effect.all mode options that replicateEffect cannot express", () => {
    const source = 'Effect.all(Effect.replicate(task, 3), { mode: "either" })';
    const f = ast(source);
    const task = f.node(...f.span("task"));
    const count = f.node(...f.span("3"));
    const replicate = f.call("Effect.replicate(task, 3)", f.property("Effect", "replicate"), [task, count]);
    const modeValue = f.node(...f.span('"either"'));
    const modeProp = f.propertyAssignment("mode", modeValue, f.span("{ mode:")[0] + 2);
    const options = f.object('{ mode: "either" }', [modeProp]);
    const outer = f.call(source, f.property("Effect", "all"), [replicate, options]);
    const result = runRule(replicateEffectFromAllReplicateRule, f, outer, [
        { id: "outer", node: outer, symbol: "all", resultEffect: true },
        { id: "replicate", node: replicate, symbol: "replicate", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("allWith rule converts a direct data-last Effect.all wrapper with static options", () => {
    const source = 'effects => Effect.all(effects, { concurrency: 2 })';
    const f = ast(source);
    const arrowStart = f.span("effects =>")[0];
    const parameter = f.parameter("effects", arrowStart);
    const input = f.identifier("effects", f.span("Effect.all(effects")[0] + "Effect.all(".length);
    const concurrency = f.node(...f.span("2"));
    const concurrencyProp = f.propertyAssignment("concurrency", concurrency, f.span("{ concurrency:")[0] + 2);
    const options = f.object("{ concurrency: 2 }", [concurrencyProp]);
    const all = f.call("Effect.all(effects, { concurrency: 2 })", f.property("Effect", "all"), [input, options]);
    const arrow = f.arrow(source, [parameter], all);
    const result = runArrowRule(allWithFromArrowAllRule, f, arrow, [
        { id: "all", node: all, symbol: "all", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.allWith({ concurrency: 2 })");
});
test("allWith rule rejects dynamic options because conversion changes evaluation timing", () => {
    const source = 'effects => Effect.all(effects, getOptions())';
    const f = ast(source);
    const arrowStart = f.span("effects =>")[0];
    const parameter = f.parameter("effects", arrowStart);
    const input = f.identifier("effects", f.span("Effect.all(effects")[0] + "Effect.all(".length);
    const dynamic = f.call("getOptions()", f.identifier("getOptions"), []);
    const all = f.call(source.slice(source.indexOf("Effect.all")), f.property("Effect", "all"), [input, dynamic]);
    const arrow = f.arrow(source, [parameter], all);
    const result = runArrowRule(allWithFromArrowAllRule, f, arrow, [
        { id: "all", node: all, symbol: "all", resultEffect: true },
        { id: "options", node: dynamic, symbol: "getOptions", module: "User", resultEffect: false },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("mergeAll rule converts the canonical sequential zipWith reduction seeded by Effect.succeed", () => {
    const source = "Array.fromIterable(effects).reduce((acc, effect, i) => Effect.zipWith(acc, effect, (state, value) => combine(state, value, i)), Effect.succeed(zero))";
    const f = ast(source);
    const effects = f.node(...f.span("effects"));
    const fromIterable = f.call("Array.fromIterable(effects)", f.property("Array", "fromIterable"), [effects]);
    const reduceProperty = methodProperty(f, fromIterable, "Array.fromIterable(effects).reduce", "reduce");
    const reducerStart = f.span("(acc, effect, i) =>")[0];
    const accParam = f.parameter("acc", reducerStart + 1);
    const effectParam = f.parameter("effect", reducerStart + 6);
    const indexParam = f.parameter("i", reducerStart + 14);
    const combine = f.node(...f.span("combine(state, value, i)"));
    const combinerStart = f.span("(state, value) =>")[0];
    const stateParam = f.parameter("state", combinerStart + 1);
    const valueParam = f.parameter("value", combinerStart + 8);
    const combiner = f.arrow("(state, value) => combine(state, value, i)", [stateParam, valueParam], combine);
    const zipStart = f.span("Effect.zipWith(acc, effect")[0];
    const accArg = f.identifier("acc", zipStart + "Effect.zipWith(".length);
    const effectArg = f.identifier("effect", zipStart + "Effect.zipWith(acc, ".length);
    const zipWith = f.call("Effect.zipWith(acc, effect, (state, value) => combine(state, value, i))", f.property("Effect", "zipWith"), [accArg, effectArg, combiner]);
    const reducer = f.arrow("(acc, effect, i) => Effect.zipWith(acc, effect, (state, value) => combine(state, value, i))", [accParam, effectParam, indexParam], zipWith);
    const zeroValue = f.node(...f.span("zero", source.lastIndexOf("zero")));
    const succeed = f.call("Effect.succeed(zero)", f.property("Effect", "succeed", source.lastIndexOf("Effect.succeed")), [zeroValue]);
    const outer = f.call(source, reduceProperty, [reducer, succeed]);
    const calls = [
        { id: "outer", node: outer, symbol: "reduce", module: "Array", resultEffect: true },
        { id: "fromIterable", node: fromIterable, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "zipWith", node: zipWith, symbol: "zipWith", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
    ];
    const result = runRule(mergeAllFromArrayReduceZipWithRule, f, outer, calls, [nativeArrayMethodSymbol("reduce")]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.mergeAll(effects, zero, (state, value, i) => combine(state, value, i))");
    const generic = runRule(reduceEffectFromArrayReduceZipWithRule, f, outer, calls, [nativeArrayMethodSymbol("reduce")]);
    assert.equal(generic.decision.kind, "skip");
});
test("allSuccesses rule converts the canonical Exit collection and success compaction", () => {
    const source = "Effect.map(Effect.all(Array.fromIterable(effects).map(effect => Effect.exit(effect)), { concurrency: 2 }), exits => Array.filterMap(exits, exit => Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none()))";
    const f = ast(source);
    const effects = f.node(...f.span("effects"));
    const materialized = f.call("Array.fromIterable(effects)", f.property("Array", "fromIterable"), [effects]);
    const mapProperty = methodProperty(f, materialized, "Array.fromIterable(effects).map", "map");
    const effectArrowStart = f.span("effect => Effect.exit(effect)")[0];
    const effectParam = f.parameter("effect", effectArrowStart);
    const exitArg = f.identifier("effect", f.span("Effect.exit(effect)")[0] + "Effect.exit(".length);
    const exit = f.call("Effect.exit(effect)", f.property("Effect", "exit"), [exitArg]);
    const exitMapper = f.arrow("effect => Effect.exit(effect)", [effectParam], exit);
    const mapped = f.call("Array.fromIterable(effects).map(effect => Effect.exit(effect))", mapProperty, [exitMapper]);
    const concurrency = f.node(...f.span("2"));
    const concurrencyProp = f.propertyAssignment("concurrency", concurrency, f.span("{ concurrency:")[0] + 2);
    const options = f.object("{ concurrency: 2 }", [concurrencyProp]);
    const allText = "Effect.all(Array.fromIterable(effects).map(effect => Effect.exit(effect)), { concurrency: 2 })";
    const all = f.call(allText, f.property("Effect", "all"), [mapped, options]);
    const exitsArrowStart = f.span("exits => Array.filterMap")[0];
    const exitsParam = f.parameter("exits", exitsArrowStart);
    const exitsArg = f.identifier("exits", f.span("Array.filterMap(exits")[0] + "Array.filterMap(".length);
    const successArrowStart = f.span("exit => Exit.isSuccess")[0];
    const successParam = f.parameter("exit", successArrowStart);
    const isSuccessArg = f.identifier("exit", f.span("Exit.isSuccess(exit)")[0] + "Exit.isSuccess(".length);
    const isSuccess = f.call("Exit.isSuccess(exit)", f.property("Exit", "isSuccess"), [isSuccessArg]);
    const valueStart = f.span("exit.value")[0];
    const exitValue = f.node(valueStart, valueStart + "exit.value".length, {
        expression: f.identifier("exit", valueStart),
        name: f.identifier("value", valueStart + "exit.".length),
    });
    const some = f.call("Option.some(exit.value)", f.property("Option", "some"), [exitValue]);
    const none = f.call("Option.none()", f.property("Option", "none"), []);
    const conditional = f.conditional("Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none()", isSuccess, some, none);
    const successMapper = f.arrow("exit => Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none()", [successParam], conditional);
    const filterMapText = "Array.filterMap(exits, exit => Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none())";
    const filterMap = f.call(filterMapText, f.property("Array", "filterMap", f.span(filterMapText)[0]), [exitsArg, successMapper]);
    const collectMapper = f.arrow(`exits => ${filterMapText}`, [exitsParam], filterMap);
    const outer = f.call(source, f.property("Effect", "map"), [all, collectMapper]);
    const result = runRule(allSuccessesFromAllExitsRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
        { id: "all", node: all, symbol: "all", resultEffect: true },
        { id: "materialized", node: materialized, symbol: "fromIterable", module: "Array", resultEffect: false },
        { id: "nativeMap", node: mapped, symbol: "map", module: "Array", resultEffect: false },
        { id: "exit", node: exit, symbol: "exit", resultEffect: true },
        { id: "filterMap", node: filterMap, symbol: "filterMap", module: "Array", resultEffect: false },
        { id: "isSuccess", node: isSuccess, symbol: "isSuccess", module: "Exit", resultEffect: false },
        { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
    ], [nativeArrayMethodSymbol("map")]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.allSuccesses(effects, { concurrency: 2 })");
});
function callAt(f, text, namespace, name, args, from = 0) {
    const start = f.span(text, from)[0];
    return f.call(text, f.property(namespace, name, start), args, start);
}
function buildSuspendedTask(f, from = 0) {
    const callText = "Effect.suspend(() => task())";
    const start = f.span(callText, from)[0];
    const taskStart = f.span("task()", start)[0];
    const task = f.node(taskStart, taskStart + "task()".length);
    const thunk = f.arrow("() => task()", [], task, f.span("() => task()", start)[0]);
    return callAt(f, callText, "Effect", "suspend", [thunk], start);
}
function buildSucceedNone(f, from = 0) {
    const succeedText = "Effect.succeed(Option.none())";
    const start = f.span(succeedText, from)[0];
    const none = callAt(f, "Option.none()", "Option", "none", [], start);
    return { succeed: callAt(f, succeedText, "Effect", "succeed", [none], start), none };
}
test("unless rule converts the canonical lazy suspended false gate", () => {
    const source = "Effect.suspend(() => condition() ? Effect.succeed(Option.none()) : Effect.asSome(Effect.suspend(() => task())))";
    const f = ast(source);
    const condition = f.node(...f.span("condition()"));
    const { succeed, none } = buildSucceedNone(f);
    const inner = buildSuspendedTask(f, f.span("Effect.asSome")[0]);
    const asSome = callAt(f, "Effect.asSome(Effect.suspend(() => task()))", "Effect", "asSome", [inner]);
    const conditionalText = "condition() ? Effect.succeed(Option.none()) : Effect.asSome(Effect.suspend(() => task()))";
    const conditional = f.conditional(conditionalText, condition, succeed, asSome);
    const thunk = f.arrow(`() => ${conditionalText}`, [], conditional);
    const outer = callAt(f, source, "Effect", "suspend", [thunk]);
    const result = runRule(unlessFromSuspendedConditionalRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
        { id: "asSome", node: asSome, symbol: "asSome", resultEffect: true },
        { id: "inner", node: inner, symbol: "suspend", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.unless(Effect.suspend(() => task()), () => condition())");
});
test("unless rule rejects moving an arbitrary effect expression across the lazy boundary", () => {
    const source = "Effect.suspend(() => condition() ? Effect.succeed(Option.none()) : Effect.asSome(task))";
    const f = ast(source);
    const condition = f.node(...f.span("condition()"));
    const { succeed, none } = buildSucceedNone(f);
    const task = f.identifier("task", f.span("Effect.asSome(task)")[0]);
    const asSome = callAt(f, "Effect.asSome(task)", "Effect", "asSome", [task]);
    const conditionalText = "condition() ? Effect.succeed(Option.none()) : Effect.asSome(task)";
    const conditional = f.conditional(conditionalText, condition, succeed, asSome);
    const thunk = f.arrow(`() => ${conditionalText}`, [], conditional);
    const outer = callAt(f, source, "Effect", "suspend", [thunk]);
    const result = runRule(unlessFromSuspendedConditionalRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
        { id: "asSome", node: asSome, symbol: "asSome", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
function buildEffectBooleanGate(source, trueIsSome) {
    const f = ast(source);
    const conditionEffect = f.identifier("conditionEffect");
    const callbackStart = f.span("b =>")[0];
    const flag = f.parameter("b", callbackStart);
    const condition = f.identifier("b", f.span("b ?", callbackStart)[0]);
    const { succeed, none } = buildSucceedNone(f);
    const inner = buildSuspendedTask(f);
    const asSome = callAt(f, "Effect.asSome(Effect.suspend(() => task()))", "Effect", "asSome", [inner]);
    const whenTrue = trueIsSome ? asSome : succeed;
    const whenFalse = trueIsSome ? succeed : asSome;
    const conditionalText = trueIsSome
        ? "b ? Effect.asSome(Effect.suspend(() => task())) : Effect.succeed(Option.none())"
        : "b ? Effect.succeed(Option.none()) : Effect.asSome(Effect.suspend(() => task()))";
    const conditional = f.conditional(conditionalText, condition, whenTrue, whenFalse, f.span(conditionalText)[0]);
    const mapper = f.arrow(`b => ${conditionalText}`, [flag], conditional, callbackStart);
    const outer = callAt(f, source, "Effect", "flatMap", [conditionEffect, mapper]);
    return { f, outer, calls: [
            { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
            { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
            { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
            { id: "asSome", node: asSome, symbol: "asSome", resultEffect: true },
            { id: "inner", node: inner, symbol: "suspend", resultEffect: true },
        ] };
}
test("unlessEffect rule converts the canonical effectful false gate", () => {
    const source = "Effect.flatMap(conditionEffect, b => b ? Effect.succeed(Option.none()) : Effect.asSome(Effect.suspend(() => task())))";
    const built = buildEffectBooleanGate(source, false);
    const result = runRule(unlessEffectFromFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.unlessEffect(Effect.suspend(() => task()), conditionEffect)");
});
test("whenEffect rule converts the canonical effectful true gate", () => {
    const source = "Effect.flatMap(conditionEffect, b => b ? Effect.asSome(Effect.suspend(() => task())) : Effect.succeed(Option.none()))";
    const built = buildEffectBooleanGate(source, true);
    const result = runRule(whenEffectFromFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.whenEffect(Effect.suspend(() => task()), conditionEffect)");
});
function buildReferenceGate(moduleName, preserveState = true) {
    const refName = moduleName === "Ref" ? "ref" : "flag";
    const source = `Effect.flatMap(${moduleName}.get(${refName}), s => predicate(s) ? Effect.map(Effect.suspend(() => task()), a => [${preserveState ? "s" : "other"}, Option.some(a)]) : Effect.succeed([s, Option.none()]))`;
    const f = ast(source);
    const reference = f.identifier(refName, f.span(`${moduleName}.get(`)[0] + `${moduleName}.get(`.length);
    const get = callAt(f, `${moduleName}.get(${refName})`, moduleName, "get", [reference]);
    const callbackStart = f.span("s =>")[0];
    const state = f.parameter("s", callbackStart);
    const predicateStart = f.span("predicate(s)")[0];
    const predicate = f.node(predicateStart, predicateStart + "predicate(s)".length);
    const inner = buildSuspendedTask(f);
    const mapStart = f.span("Effect.map(")[0];
    const valueParamStart = f.span("a =>", mapStart)[0];
    const valueParam = f.parameter("a", valueParamStart);
    const stateText = preserveState ? "s" : "other";
    const tupleStart = f.span(`[${stateText}, Option.some(a)]`)[0];
    const first = f.identifier(stateText, tupleStart + 1);
    const someArg = f.identifier("a", f.span("Option.some(a)")[0] + "Option.some(".length);
    const some = callAt(f, "Option.some(a)", "Option", "some", [someArg]);
    const successTuple = f.array(`[${stateText}, Option.some(a)]`, [first, some]);
    const valueMapper = f.arrow(`a => [${stateText}, Option.some(a)]`, [valueParam], successTuple, valueParamStart);
    const map = callAt(f, `Effect.map(Effect.suspend(() => task()), a => [${stateText}, Option.some(a)])`, "Effect", "map", [inner, valueMapper], mapStart);
    const noneStart = f.span("Option.none()", map.getEnd())[0];
    const none = callAt(f, "Option.none()", "Option", "none", [], noneStart);
    const falseState = f.identifier("s", f.span("[s, Option.none()]", map.getEnd())[0] + 1);
    const noneTuple = f.array("[s, Option.none()]", [falseState, none], map.getEnd());
    const succeed = callAt(f, "Effect.succeed([s, Option.none()])", "Effect", "succeed", [noneTuple], map.getEnd());
    const conditionalText = `predicate(s) ? Effect.map(Effect.suspend(() => task()), a => [${stateText}, Option.some(a)]) : Effect.succeed([s, Option.none()])`;
    const conditional = f.conditional(conditionalText, predicate, map, succeed);
    const mapper = f.arrow(`s => ${conditionalText}`, [state], conditional, callbackStart);
    const outer = callAt(f, source, "Effect", "flatMap", [get, mapper]);
    return { f, outer, calls: [
            { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
            { id: "get", node: get, symbol: "get", module: moduleName, resultEffect: true },
            { id: "map", node: map, symbol: "map", resultEffect: true },
            { id: "inner", node: inner, symbol: "suspend", resultEffect: true },
            { id: "some", node: some, symbol: "some", module: "Option", resultEffect: false },
            { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
            { id: "none", node: none, symbol: "none", module: "Option", resultEffect: false },
        ] };
}
test("whenRef rule converts Ref.get + conditional tuple lowering", () => {
    const built = buildReferenceGate("Ref");
    const result = runRule(whenRefFromGetFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.whenRef(Effect.suspend(() => task()), ref, s => predicate(s))");
});
test("whenFiberRef rule converts FiberRef.get + conditional tuple lowering", () => {
    const built = buildReferenceGate("FiberRef");
    const result = runRule(whenFiberRefFromGetFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.whenFiberRef(Effect.suspend(() => task()), flag, s => predicate(s))");
});
test("whenRef rule rejects a success tuple that does not preserve the read Ref value", () => {
    const built = buildReferenceGate("Ref", false);
    const result = runRule(whenRefFromGetFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "skip");
});
test("whenRef rule requires the getter binding to resolve specifically to effect/Ref.get", () => {
    const built = buildReferenceGate("Ref");
    const calls = built.calls.map((call) => call.id === "get" ? { ...call, module: "Fake" } : call);
    const result = runRule(whenRefFromGetFlatMapRule, built.f, built.outer, calls);
    assert.equal(result.decision.kind, "skip");
});
function buildEffectfulFilterCase(fallbackKind) {
    const fallbackText = fallbackKind === "fail" ? "Effect.fail(errorOf(a))" : "fallback(a)";
    const source = `Effect.flatMap(input, a => Effect.flatMap(check(a), pass => pass ? Effect.succeed(a) : ${fallbackText}))`;
    const f = ast(source);
    const input = f.node(...f.span("input"));
    const outerParamStart = f.span("a =>")[0];
    const outerParam = f.parameter("a", outerParamStart);
    const checkStart = f.span("check(a)")[0];
    const checkArg = f.identifier("a", checkStart + "check(".length);
    const check = f.call("check(a)", f.identifier("check", checkStart), [checkArg], checkStart);
    const passParamStart = f.span("pass =>")[0];
    const passParam = f.parameter("pass", passParamStart);
    const passCondition = f.identifier("pass", f.span("pass ?")[0]);
    const succeedStart = f.span("Effect.succeed(a)")[0];
    const succeedArg = f.identifier("a", succeedStart + "Effect.succeed(".length);
    const succeed = callAt(f, "Effect.succeed(a)", "Effect", "succeed", [succeedArg], succeedStart);
    let fallback;
    if (fallbackKind === "fail") {
        const errorOfStart = f.span("errorOf(a)")[0];
        const errorArg = f.identifier("a", errorOfStart + "errorOf(".length);
        const errorOf = f.call("errorOf(a)", f.identifier("errorOf", errorOfStart), [errorArg], errorOfStart);
        fallback = callAt(f, "Effect.fail(errorOf(a))", "Effect", "fail", [errorOf]);
    }
    else {
        const fallbackStart = f.span("fallback(a)")[0];
        const fallbackArg = f.identifier("a", fallbackStart + "fallback(".length);
        fallback = f.call("fallback(a)", f.identifier("fallback", fallbackStart), [fallbackArg], fallbackStart);
    }
    const conditionalText = `pass ? Effect.succeed(a) : ${fallbackText}`;
    const conditional = f.conditional(conditionalText, passCondition, succeed, fallback);
    const passMapper = f.arrow(`pass => ${conditionalText}`, [passParam], conditional, passParamStart);
    const innerText = `Effect.flatMap(check(a), pass => ${conditionalText})`;
    const inner = callAt(f, innerText, "Effect", "flatMap", [check, passMapper]);
    const outerMapper = f.arrow(`a => ${innerText}`, [outerParam], inner, outerParamStart);
    const outer = callAt(f, source, "Effect", "flatMap", [input, outerMapper]);
    const calls = [
        { id: "outer", node: outer, symbol: "flatMap", resultEffect: true },
        { id: "inner", node: inner, symbol: "flatMap", resultEffect: true },
        { id: "check", node: check, symbol: "check", module: "App", resultEffect: true },
        { id: "succeed", node: succeed, symbol: "succeed", resultEffect: true },
        { id: "fallback", node: fallback, symbol: fallbackKind === "fail" ? "fail" : "fallback", module: fallbackKind === "fail" ? "Effect" : "App", resultEffect: true },
    ];
    return { f, outer, calls };
}
test("filterEffectOrElse rule converts the canonical nested effectful predicate/fallback lowering", () => {
    const built = buildEffectfulFilterCase("fallback");
    const result = runRule(filterEffectOrElseFromNestedFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.filterEffectOrElse(input, { predicate: a => check(a), orElse: a => fallback(a) })");
});
test("filterEffectOrElse rule defers Effect.fail fallback to filterEffectOrFail", () => {
    const built = buildEffectfulFilterCase("fail");
    const result = runRule(filterEffectOrElseFromNestedFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "skip");
});
test("filterEffectOrFail rule converts the canonical nested Effect.fail specialization", () => {
    const built = buildEffectfulFilterCase("fail");
    const result = runRule(filterEffectOrFailFromNestedFlatMapRule, built.f, built.outer, built.calls);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.filterEffectOrFail(input, { predicate: a => check(a), orFailWith: a => errorOf(a) })");
});
test("filterEffectOrFail rule rejects an unproven effectful predicate call", () => {
    const built = buildEffectfulFilterCase("fail");
    const calls = built.calls.map((call) => call.id === "check" ? { ...call, resultEffect: false } : call);
    const result = runRule(filterEffectOrFailFromNestedFlatMapRule, built.f, built.outer, calls);
    assert.equal(result.decision.kind, "skip");
});
test("negate rule converts the exact Effect.map boolean-not lowering", () => {
    const source = "Effect.map(flag, b => !b)";
    const f = ast(source);
    const self = f.node(...f.span("flag"));
    const paramStart = f.span("b =>")[0];
    const param = f.parameter("b", paramStart);
    const body = f.node(...f.span("!b"));
    const mapper = f.arrow("b => !b", [param], body, paramStart);
    const outer = callAt(f, source, "Effect", "map", [self, mapper]);
    const result = runRule(negateFromMapBooleanNotRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.negate(flag)");
});
test("negate rule rejects a map callback that negates a different identifier", () => {
    const source = "Effect.map(flag, b => !other)";
    const f = ast(source);
    const self = f.node(...f.span("flag"));
    const paramStart = f.span("b =>")[0];
    const param = f.parameter("b", paramStart);
    const body = f.node(...f.span("!other"));
    const mapper = f.arrow("b => !other", [param], body, paramStart);
    const outer = callAt(f, source, "Effect", "map", [self, mapper]);
    const result = runRule(negateFromMapBooleanNotRule, f, outer, [
        { id: "outer", node: outer, symbol: "map", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
function parsedCall(source, exactText, occurrence = 0) {
    const sourceFile = ts.createSourceFile("/project/src/a.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const matches = [];
    const visit = (node) => {
        if (ts.isCallExpression(node) && node.getText(sourceFile) === exactText)
            matches.push(node);
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    const match = matches[occurrence];
    if (!match)
        throw new Error(`Missing parsed call: ${exactText} #${occurrence}`);
    return match;
}
test("flipWith rule converts exact nested flips", () => {
    const source = "Effect.flip(transform(Effect.flip(input)))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const transformed = parsedCall(source, "transform(Effect.flip(input))");
    const inner = parsedCall(source, "Effect.flip(input)");
    const result = runRule(flipWithFromNestedFlipRule, f, outer, [
        { id: "outer", node: outer, symbol: "flip", resultEffect: true },
        { id: "transform", node: transformed, symbol: "transform", resultEffect: true, module: "User" },
        { id: "inner", node: inner, symbol: "flip", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.flipWith(input, transform)");
});
test("flipWith rule rejects effectful transform-callee construction", () => {
    const source = "Effect.flip(getTransform()(Effect.flip(input)))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const transformed = parsedCall(source, "getTransform()(Effect.flip(input))");
    const inner = parsedCall(source, "Effect.flip(input)");
    const result = runRule(flipWithFromNestedFlipRule, f, outer, [
        { id: "outer", node: outer, symbol: "flip", resultEffect: true },
        { id: "transform", node: transformed, symbol: "transform", resultEffect: true, module: "User" },
        { id: "inner", node: inner, symbol: "flip", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("iterate rule collapses one exact suspended unrolling", () => {
    const source = "Effect.suspend(() => predicate(0) ? Effect.flatMap(body(0), next => Effect.iterate(next, { while: value => predicate(value), body: value => body(value) })) : Effect.succeed(0))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const flatMap = parsedCall(source, "Effect.flatMap(body(0), next => Effect.iterate(next, { while: value => predicate(value), body: value => body(value) }))");
    const body = parsedCall(source, "body(0)");
    const recursive = parsedCall(source, "Effect.iterate(next, { while: value => predicate(value), body: value => body(value) })");
    const fallback = parsedCall(source, "Effect.succeed(0)");
    const result = runRule(iterateFromSuspendedUnrollRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "flatMap", node: flatMap, symbol: "flatMap", resultEffect: true },
        { id: "body", node: body, symbol: "body", resultEffect: true, module: "User" },
        { id: "iterate", node: recursive, symbol: "iterate", resultEffect: true },
        { id: "succeed", node: fallback, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.suspend(() => Effect.iterate(0, { while: value => predicate(value), body: value => body(value) }))");
});
test("iterate rule rejects non-primitive initial expressions", () => {
    const source = "Effect.suspend(() => predicate(getInitial()) ? Effect.flatMap(body(getInitial()), next => Effect.iterate(next, { while: value => predicate(value), body: value => body(value) })) : Effect.succeed(getInitial()))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const result = runRule(iterateFromSuspendedUnrollRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("loop rule collapses one exact non-discard suspended unrolling", () => {
    const source = "Effect.suspend(() => predicate(0) ? Effect.flatMap(body(0), head => Effect.map(Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) }), rest => [head, ...rest])) : Effect.succeed([]))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const flatMap = parsedCall(source, "Effect.flatMap(body(0), head => Effect.map(Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) }), rest => [head, ...rest]))");
    const body = parsedCall(source, "body(0)");
    const map = parsedCall(source, "Effect.map(Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) }), rest => [head, ...rest])");
    const recursive = parsedCall(source, "Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) })");
    const fallback = parsedCall(source, "Effect.succeed([])");
    const result = runRule(loopFromSuspendedUnrollRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "flatMap", node: flatMap, symbol: "flatMap", resultEffect: true },
        { id: "body", node: body, symbol: "body", resultEffect: true, module: "User" },
        { id: "map", node: map, symbol: "map", resultEffect: true },
        { id: "loop", node: recursive, symbol: "loop", resultEffect: true },
        { id: "succeed", node: fallback, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.suspend(() => Effect.loop(0, { while: value => predicate(value), step: value => step(value), body: value => body(value) }))");
});
test("loop rule rejects collectors that do not prepend head unchanged", () => {
    const source = "Effect.suspend(() => predicate(0) ? Effect.flatMap(body(0), head => Effect.map(Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) }), rest => [...rest, head])) : Effect.succeed([]))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const flatMap = parsedCall(source, "Effect.flatMap(body(0), head => Effect.map(Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) }), rest => [...rest, head]))");
    const body = parsedCall(source, "body(0)");
    const map = parsedCall(source, "Effect.map(Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) }), rest => [...rest, head])");
    const recursive = parsedCall(source, "Effect.loop(step(0), { while: value => predicate(value), step: value => step(value), body: value => body(value) })");
    const fallback = parsedCall(source, "Effect.succeed([])");
    const result = runRule(loopFromSuspendedUnrollRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "flatMap", node: flatMap, symbol: "flatMap", resultEffect: true },
        { id: "body", node: body, symbol: "body", resultEffect: true, module: "User" },
        { id: "map", node: map, symbol: "map", resultEffect: true },
        { id: "loop", node: recursive, symbol: "loop", resultEffect: true },
        { id: "succeed", node: fallback, symbol: "succeed", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("mapAccum rule converts suspended immutable tuple reduce", () => {
    const source = "Effect.suspend(() => Effect.reduce(items, [initial, []], (acc, value, index) => Effect.map(step(acc[0], value, index), pair => [pair[0], [...acc[1], pair[1]]])))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const reduce = parsedCall(source, "Effect.reduce(items, [initial, []], (acc, value, index) => Effect.map(step(acc[0], value, index), pair => [pair[0], [...acc[1], pair[1]]]))");
    const map = parsedCall(source, "Effect.map(step(acc[0], value, index), pair => [pair[0], [...acc[1], pair[1]]])");
    const step = parsedCall(source, "step(acc[0], value, index)");
    const result = runRule(mapAccumFromSuspendedReduceRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "reduce", node: reduce, symbol: "reduce", resultEffect: true },
        { id: "map", node: map, symbol: "map", resultEffect: true },
        { id: "step", node: step, symbol: "step", resultEffect: true, module: "User" },
    ]);
    assert.equal(result.decision.kind, "convert");
    assert.equal(result.rewrite?.replacements[0]?.replacement, "Effect.suspend(() => Effect.mapAccum(items, initial, (state, value, index) => step(state, value, index)))");
});
test("mapAccum rule rejects mutating accumulator shapes", () => {
    const source = "Effect.suspend(() => Effect.reduce(items, [initial, []], (acc, value, index) => Effect.map(step(acc[0], value, index), pair => (acc[1].push(pair[1]), [pair[0], acc[1]]))))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const reduce = parsedCall(source, "Effect.reduce(items, [initial, []], (acc, value, index) => Effect.map(step(acc[0], value, index), pair => (acc[1].push(pair[1]), [pair[0], acc[1]])))");
    const map = parsedCall(source, "Effect.map(step(acc[0], value, index), pair => (acc[1].push(pair[1]), [pair[0], acc[1]]))");
    const step = parsedCall(source, "step(acc[0], value, index)");
    const result = runRule(mapAccumFromSuspendedReduceRule, f, outer, [
        { id: "outer", node: outer, symbol: "suspend", resultEffect: true },
        { id: "reduce", node: reduce, symbol: "reduce", resultEffect: true },
        { id: "map", node: map, symbol: "map", resultEffect: true },
        { id: "step", node: step, symbol: "step", resultEffect: true, module: "User" },
    ]);
    assert.equal(result.decision.kind, "skip");
});
test("flipWith rule rejects a self expression whose evaluation would move before transform lookup", () => {
    const source = "Effect.flip(transform(Effect.flip(makeInput())))";
    const f = ast(source);
    const outer = parsedCall(source, source);
    const transformed = parsedCall(source, "transform(Effect.flip(makeInput()))");
    const inner = parsedCall(source, "Effect.flip(makeInput())");
    const result = runRule(flipWithFromNestedFlipRule, f, outer, [
        { id: "outer", node: outer, symbol: "flip", resultEffect: true },
        { id: "transform", node: transformed, symbol: "transform", resultEffect: true, module: "User" },
        { id: "inner", node: inner, symbol: "flip", resultEffect: true },
    ]);
    assert.equal(result.decision.kind, "skip");
});
