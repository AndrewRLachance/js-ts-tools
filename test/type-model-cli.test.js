"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseArgs,
  run,
  stringifyResult,
} = require("../bin/type-model-cli");
const { extractTypeModel } = require("../dist/tools/type-model");

test("type-model parses source selection, scope, and output options", () => {
  const options = parseArgs([
    "--source", "src/**/*.ts",
    "--source", "packages/**/*.ts",
    "--tsconfig", "config/tsconfig.json",
    "--exclude", ".generated.ts",
    "--scope", "all",
    "--include-call-sites",
    "--pretty",
    "--out", "generated/type-model.json",
  ]);

  assert.deepEqual(options.sourceGlob, ["src/**/*.ts", "packages/**/*.ts"]);
  assert.deepEqual(options.excludePathIncludes, [".generated.ts"]);
  assert.equal(options.tsConfigFilePath, "config/tsconfig.json");
  assert.equal(options.scope, "all");
  assert.equal(options.includeCallSites, true);
  assert.equal(options.pretty, true);
  assert.equal(options.outputFilePath, "generated/type-model.json");
});

test("type-model rejects missing, malformed, and unknown options", () => {
  assert.throws(() => parseArgs([]), /Missing required option: --source/);
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--scope", "public"]),
    /Invalid scope/,
  );
  assert.throws(
    () => parseArgs(["--source", "--pretty"]),
    /Expected value after --source/,
  );
  assert.throws(
    () => parseArgs(["--source", "src/**/*.ts", "--unknown"]),
    /Unknown argument/,
  );
});

test("type-model CLI emits compact JSON and writes pretty JSON", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-cli-output-"));
  const outputPath = path.join(root, "nested", "model.json");
  const result = minimalModel();
  let receivedOptions;

  run([
    "--source", "src/**/*.ts",
    "--scope", "exports",
    "--pretty",
    "--out", outputPath,
  ], (options) => {
    receivedOptions = options;
    return result;
  });

  const output = fs.readFileSync(outputPath, "utf8");
  assert.equal(receivedOptions.sourceGlob, "src/**/*.ts");
  assert.equal(receivedOptions.scope, "exports");
  assert.deepEqual(JSON.parse(output), result);
  assert.match(output, /\n  "schemaVersion"/);
  assert.equal(output.endsWith("\n"), true);
  assert.equal(stringifyResult(result, false), `${JSON.stringify(result)}\n`);

  const stdout = captureStdout(() => run([
    "--source", "src/**/*.ts",
  ], () => result));
  assert.equal(stdout, `${JSON.stringify(result)}\n`);
});

test("type-model extracts inferred signatures, core types, aliases, and recursion", () => {
  const fixture = createTypeModelFixture();
  const options = fixtureOptions(fixture, "exports", path.join(fixture, "src/**/*.ts"));
  const model = extractTypeModel(options);

  assert.equal(model.schemaVersion, "2");
  assert.equal(model.project.scope, "exports");
  assert.equal(model.project.includeCallSites, false);
  assert.deepEqual(model.callSites, {});
  assert.equal(model.modules.every((module) => module.callSites.length === 0), true);
  assert.equal(model.project.selectedFiles.every((file) => !path.isAbsolute(file)), true);
  assert.equal(model.roots.some((id) => model.symbols[id]?.name === "internalOnly"), false);

  const inferred = findSymbol(model, "infer", false);
  const inferredValue = dereferenceType(model, inferred.valueType);
  assert.equal(inferredValue.kind, "object");
  assert.equal(inferredValue.callSignatures.length, 1);
  const inferredSignature = model.signatures[inferredValue.callSignatures[0]];
  assert.equal(inferredSignature.parameters[0].name, "input");
  assert.equal(inferredSignature.parameters[0].annotation, "explicit");
  assert.equal(inferredSignature.returnAnnotation, "inferred");
  const inferredReturn = dereferenceType(model, inferredSignature.returnType);
  assert.equal(inferredReturn.kind, "object");
  assert.deepEqual(
    inferredReturn.properties.map((property) => property.name),
    ["createdAt", "input", "ok"],
  );

  const arrow = findSymbol(model, "inferArrow", false);
  const arrowValue = dereferenceType(model, arrow.valueType);
  const arrowSignature = model.signatures[arrowValue.callSignatures[0]];
  assert.equal(arrowSignature.typeParameters.length, 1);
  assert.equal(arrowSignature.typeParameters[0].name, "T");
  assert.ok(arrowSignature.typeParameters[0].constraint);
  assert.ok(arrowSignature.typeParameters[0].default);
  const arrowReturn = dereferenceType(model, arrowSignature.returnType);
  assert.equal(arrowReturn.kind, "tuple");
  assert.equal(arrowReturn.readonly, true);

  const choice = dereferenceType(model, findSymbol(model, "Choice", false).declaredType);
  assert.equal(choice.kind, "union");
  assert.deepEqual(
    choice.types.map((id) => dereferenceType(model, id).kind),
    ["literal", "literal", "literal"],
  );
  const combined = dereferenceType(model, findSymbol(model, "Combined", false).declaredType);
  assert.equal(combined.kind, "intersection");
  const stringList = dereferenceType(model, findSymbol(model, "StringList", false).declaredType);
  assert.equal(stringList.kind, "array");

  const callable = dereferenceType(model, findSymbol(model, "Callable", false).declaredType);
  assert.equal(callable.kind, "object");
  assert.equal(callable.callSignatures.length, 1);
  assert.ok(callable.stringIndexType);
  const callableKey = callable.properties.find((property) => property.name === "key");
  assert.equal(callableKey.optional, true);
  assert.equal(callableKey.readonly, true);

  const factory = dereferenceType(model, findSymbol(model, "Factory", false).declaredType);
  assert.equal(factory.constructSignatures.length, 1);
  const basic = findSymbol(model, "Basic", false);
  assert.ok(basic.declaredType);
  assert.ok(basic.valueType);
  assert.notEqual(basic.declaredType, basic.valueType);

  const recursive = findSymbol(model, "Recursive", false);
  const recursiveShape = dereferenceType(model, recursive.declaredType);
  assert.equal(recursiveShape.kind, "object");
  assert.deepEqual(recursiveShape.properties.map((property) => property.name), ["next", "tags", "value"]);
  const tags = dereferenceType(model, recursiveShape.properties.find((property) => property.name === "tags").type);
  const tuple = tags.kind === "union"
    ? tags.types.map((id) => dereferenceType(model, id)).find((type) => type.kind === "tuple")
    : tags;
  assert.equal(tuple.kind, "tuple");
  assert.equal(tuple.readonly, true);
  assert.deepEqual(tuple.elements.map((element) => ({
    label: element.label,
    optional: element.optional,
    rest: element.rest,
  })), [
    { label: "name", optional: false, rest: false },
    { label: "count", optional: true, rest: false },
    { label: "flags", optional: false, rest: true },
  ]);

  const indexModule = model.modules.find((module) => module.filePath === "src/index.ts");
  const nodeAlias = indexModule.exports.find((entry) => entry.name === "NodeAlias");
  assert.notEqual(nodeAlias.symbolId, nodeAlias.targetSymbolId);
  assert.equal(model.symbols[nodeAlias.symbolId].aliasTarget, nodeAlias.targetSymbolId);
  assert.equal(indexModule.exports.some((entry) => entry.name === "default"), true);

  assertGraphIntegrity(model);
});

test("type-model all scope includes internal roots and keeps dependencies opaque", () => {
  const fixture = createTypeModelFixture();
  const all = extractTypeModel(
    fixtureOptions(fixture, "all", path.join(fixture, "src/model.ts")),
  );
  assert.equal(all.roots.some((id) => all.symbols[id]?.name === "internalOnly"), true);
  assert.equal(all.roots.some((id) => all.symbols[id]?.name === "renamedInternal"), true);

  const exported = extractTypeModel(
    fixtureOptions(fixture, "exports", path.join(fixture, "src/model.ts")),
  );
  assert.equal(exported.roots.some((id) => exported.symbols[id]?.name === "internalOnly"), false);

  const externalTypes = Object.values(exported.types).filter((type) =>
    type.kind === "external" && exported.symbols[type.symbolId]?.name === "ExternalBox"
  );
  assert.ok(externalTypes.length > 0);
  assert.ok(externalTypes.some((type) => type.typeArguments.length === 1));
  const externalSymbol = findSymbol(exported, "ExternalBox", true);
  assert.equal(externalSymbol.declaredType, undefined);
  assert.equal(externalSymbol.valueType, undefined);
  assertGraphIntegrity(exported);
});

test("type-model expands formerly unsupported forms and returns compiler diagnostics", () => {
  const fixture = createTypeModelFixture();
  const model = extractTypeModel(
    fixtureOptions(fixture, "exports", path.join(fixture, "src/index.ts")),
  );

  const deferred = dereferenceType(model, findSymbol(model, "Deferred", false).declaredType);
  assert.equal(deferred.kind, "conditional");
  assert.equal(dereferenceType(model, deferred.trueType).kind, "object");
  assert.equal(
    model.diagnostics.some((diagnostic) =>
      diagnostic.source === "typescript" && diagnostic.code === 2322
    ),
    true,
  );

  const outputPath = path.join(fixture, "output", "type-model.json");
  run([
    "--source", path.join(fixture, "src/index.ts"),
    "--tsconfig", path.join(fixture, "tsconfig.json"),
    "--out", outputPath,
  ]);
  assert.equal(JSON.parse(fs.readFileSync(outputPath, "utf8")).schemaVersion, "2");
});

test("type-model output is deterministic and contains no fixture absolute paths", () => {
  const fixture = createTypeModelFixture();
  const options = fixtureOptions(fixture, "exports", path.join(fixture, "src/**/*.ts"));
  const first = JSON.stringify(extractTypeModel(options));
  const second = JSON.stringify(extractTypeModel(options));

  assert.equal(first, second);
  assert.equal(first.includes(fixture.replace(/\\/g, "/")), false);
});

test("type-model v2 expands advanced types, overloads, class sides, and raw JSDoc", () => {
  const fixture = createPhaseTwoThreeFixture();
  const model = extractTypeModel({
    sourceGlob: path.join(fixture, "src/advanced.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
  });

  assert.equal(model.schemaVersion, "2");
  const conditional = dereferenceType(model, findSymbol(model, "Conditional", false).declaredType);
  assert.equal(conditional.kind, "conditional");
  assert.equal(conditional.distributive, true);
  assert.equal(dereferenceType(model, conditional.trueType).kind, "templateLiteral");

  const inferred = dereferenceType(model, findSymbol(model, "InferValue", false).declaredType);
  assert.equal(inferred.kind, "conditional");
  assert.equal(inferred.inferTypeParameters.length, 1);
  const narrowed = dereferenceType(model, findSymbol(model, "Narrow", false).declaredType);
  assert.equal(narrowed.kind, "conditional");
  assert.equal(dereferenceType(model, narrowed.trueType).kind, "substitution");

  const remapped = dereferenceType(model, findSymbol(model, "Remapped", false).declaredType);
  assert.equal(remapped.kind, "mapped");
  assert.equal(remapped.readonlyModifier, "remove");
  assert.equal(remapped.optionalModifier, "remove");
  assert.ok(remapped.nameType);
  assert.equal(dereferenceType(model, remapped.nameType).kind, "templateLiteral");

  assert.equal(dereferenceType(model, findSymbol(model, "Keys", false).declaredType).kind, "keyof");
  assert.equal(dereferenceType(model, findSymbol(model, "Indexed", false).declaredType).kind, "indexedAccess");
  assert.equal(dereferenceType(model, findSymbol(model, "Template", false).declaredType).kind, "templateLiteral");
  assert.equal(dereferenceType(model, findSymbol(model, "MappedString", false).declaredType).kind, "stringMapping");

  const holder = dereferenceType(model, findSymbol(model, "ExternalHolder", false).declaredType);
  const externalValue = dereferenceType(model, holder.properties.find((property) => property.name === "value").type);
  assert.equal(externalValue.kind, "external");
  assert.equal(model.symbols[externalValue.symbolId].name, "ExternalConditional");

  const documented = findSymbol(model, "Documented", false);
  assert.deepEqual(documented.jsDoc.map((entry) => entry.text), [
    "/**\n * Documented exactly.\n *\n * @remarks  Keep two spaces.\n */",
  ]);
  const documentedShape = dereferenceType(model, documented.declaredType);
  assert.deepEqual(documentedShape.properties.find((property) => property.name === "name").jsDoc.map((entry) => entry.text), [
    "/** Property docs. */",
  ]);

  const overloaded = dereferenceType(model, findSymbol(model, "overloaded", false).valueType);
  assert.equal(overloaded.callSignatures.length, 2);
  assert.deepEqual(overloaded.callSignatures.map((id) => model.signatures[id].jsDoc[0].text), [
    "/** String overload. */",
    "/** Number overload. */",
  ]);

  const box = findSymbol(model, "Box", false);
  const instanceSide = dereferenceType(model, box.declaredType);
  const staticSide = dereferenceType(model, box.valueType);
  assert.equal(instanceSide.properties.some((property) => property.name === "value"), true);
  assert.equal(instanceSide.properties.some((property) => property.name === "base"), true);
  assert.equal(staticSide.properties.some((property) => property.name === "version"), true);
  assert.equal(staticSide.constructSignatures.length, 1);
  assertGraphIntegrity(model);
});

test("type-model v2 collects all call-like forms and resolved generic instantiations", () => {
  const fixture = createPhaseTwoThreeFixture();
  const source = path.join(fixture, "src/calls.tsx");
  const disabled = extractTypeModel({
    sourceGlob: source,
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
  });
  assert.deepEqual(disabled.callSites, {});

  const model = extractTypeModel({
    sourceGlob: source,
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    includeCallSites: true,
  });
  assert.equal(model.project.includeCallSites, true);
  assert.deepEqual(
    [...new Set(Object.values(model.callSites).map((callSite) => callSite.kind))].sort(),
    ["call", "decorator", "instanceof", "jsx", "new", "taggedTemplate"],
  );
  assert.equal(Object.values(model.callSites).every((callSite) => callSite.location.filePath === "src/calls.tsx"), true);
  assert.deepEqual(model.modules[0].callSites.sort(), Object.keys(model.callSites).sort());

  const instantiations = Object.values(model.callSites)
    .map((callSite) => callSite.genericInstantiation)
    .filter(Boolean);
  assert.equal(instantiations.some((item) => item.complete && item.bindings.some((binding) => binding.source === "explicit")), true);
  assert.equal(instantiations.some((item) => item.complete && item.bindings.some((binding) => binding.source === "inferred")), true);
  assert.equal(instantiations.some((item) => item.bindings.some((binding) =>
    dereferenceType(model, binding.type).displayText === "string"
  )), true);

  const instantiatedSites = Object.values(model.callSites).filter((callSite) =>
    callSite.genericInstantiation?.complete && callSite.declarationSignatureId !== callSite.resolvedSignatureId
  );
  assert.ok(instantiatedSites.length > 0);
  assert.equal(Object.values(model.callSites).some((callSite) =>
    callSite.calleeSymbolId && model.symbols[callSite.calleeSymbolId]?.name === "helper"
  ), true);
  assert.equal(Object.values(model.callSites).some((callSite) =>
    callSite.calleeSymbolId && model.symbols[callSite.calleeSymbolId]?.name === "alias"
  ), true);
  assert.equal(Object.values(model.callSites).some((callSite) =>
    callSite.calleeSymbolId && model.symbols[callSite.calleeSymbolId]?.external
  ), true);
  assert.equal(Object.values(model.callSites).some((callSite) => callSite.resolution === "unresolved"), true);
  assert.equal(model.diagnostics.some((diagnostic) => diagnostic.code === "unresolved-call-site"), true);

  const withExclusion = extractTypeModel({
    sourceGlob: path.join(fixture, "src/**/*.{ts,tsx}"),
    excludePathIncludes: ["excluded.ts"],
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    includeCallSites: true,
  });
  assert.equal(Object.values(withExclusion.callSites).some((callSite) =>
    callSite.location.filePath.endsWith("excluded.ts")
  ), false);
  const repeated = JSON.stringify(extractTypeModel({
    sourceGlob: source,
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    includeCallSites: true,
  }));
  assert.equal(JSON.stringify(model), repeated);
  assert.equal(repeated.includes(fixture.replace(/\\/g, "/")), false);
  assertGraphIntegrity(model);
});

test("type-model rejects source globs without selected matches", () => {
  const fixture = createTypeModelFixture();
  assert.throws(
    () => extractTypeModel(fixtureOptions(
      fixture,
      "exports",
      path.join(fixture, "missing/**/*.ts"),
    )),
    /No source files matched/,
  );
});

function createTypeModelFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-fixture-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "external-box"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "external-box", "package.json"), JSON.stringify({
    name: "external-box",
    version: "1.0.0",
    types: "index.d.ts",
  }));
  fs.writeFileSync(path.join(root, "node_modules", "external-box", "index.d.ts"), `
export interface ExternalBox<T> { externalValue: T; }
`);
  fs.writeFileSync(path.join(root, "src", "model.ts"), `
import type { ExternalBox } from "external-box";

export interface Recursive {
  value: string;
  next?: Recursive;
  tags?: readonly [name: string, count?: number, ...flags: boolean[]];
}
export type Shared = { id: string };
export type Choice = "a" | 2 | true;
export type Combined = Shared & { flag: boolean };
export type StringList = string[];
export type Deferred<T> = T extends string ? { stringValue: T } : { otherValue: T };
export type UsesExternal = ExternalBox<Shared>;
export interface Callable {
  (input: string): number;
  readonly key?: Shared;
  [key: string]: unknown;
}
export interface Factory { new(input: string): Shared; }
export class Basic {
  static create(item: Shared) { return new Basic(item); }
  constructor(readonly item: Shared) {}
}
export function infer(input: string) {
  return { input, ok: true as const, createdAt: new Date() };
}
export const inferArrow = <T extends Shared = Shared>(value: T) => [value] as const;
const internalOnly = (value = 1) => ({ value });
const { nested: renamedInternal } = { nested: "ok" };
void internalOnly;
void renamedInternal;
`);
  fs.writeFileSync(path.join(root, "src", "default.ts"), `
export default function makeDefault(value = 1) { return { value }; }
`);
  fs.writeFileSync(path.join(root, "src", "index.ts"), `
export type {
  Recursive as NodeAlias,
  Shared,
  Choice,
  Combined,
  StringList,
  Deferred,
  UsesExternal,
  Callable,
  Factory,
} from "./model";
export { Basic, infer, infer as renamedInfer, inferArrow } from "./model";
export type { ExternalBox } from "external-box";
export { default } from "./default";
`);
  fs.writeFileSync(path.join(root, "src", "broken.ts"), `
export const broken: string = 123;
`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
    },
    include: ["src/**/*.ts"],
  }));
  return root;
}

function createPhaseTwoThreeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-phase-two-three-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "advanced-dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "advanced-dep", "package.json"), JSON.stringify({
    name: "advanced-dep",
    version: "1.0.0",
    types: "index.d.ts",
  }));
  fs.writeFileSync(path.join(root, "node_modules", "advanced-dep", "index.d.ts"), `
export type ExternalConditional<T> = T extends string ? T : never;
`);
  fs.writeFileSync(path.join(root, "src", "advanced.ts"), `
import type { ExternalConditional } from "advanced-dep";

/**
 * Documented exactly.
 *
 * @remarks  Keep two spaces.
 */
export interface Documented {
  /** Property docs. */
  readonly name?: string;
}
export type Conditional<T> = T extends string ? \`item-\${Uppercase<T>}\` : T;
export type InferValue<T> = T extends Promise<infer U> ? U : never;
export type Narrow<T> = T extends string ? T : never;
export type Keys<T> = keyof T;
export type Indexed<T, K extends keyof T> = T[K];
export type Remapped<T> = { -readonly [K in keyof T as \`get\${Capitalize<string & K>}\`]-?: T[K] };
export type Template<T extends string> = \`prefix-\${T}\`;
export type MappedString<T extends string> = Uppercase<T>;
export interface ExternalHolder<T> { value: ExternalConditional<T>; }

/** String overload. */
export function overloaded(value: string): "string";
/** Number overload. */
export function overloaded(value: number): "number";
export function overloaded(value: string | number) { return typeof value === "string" ? "string" : "number"; }

export class Base { base = true; }
export class Box<T> extends Base {
  static version = 1;
  constructor(readonly value: T) { super(); }
}
`);
  fs.writeFileSync(path.join(root, "src", "helper.ts"), `
export function helper(value: number) { return Math.abs(value); }
`);
  fs.writeFileSync(path.join(root, "src", "excluded.ts"), `
export const excludedCall = Promise.resolve("excluded");
`);
  fs.writeFileSync(path.join(root, "src", "calls.tsx"), `
import { helper } from "./helper";

function identity<T extends { id: number }>(value: T): T { return value; }
function defaulted<T = string>(value?: T): T { return value as T; }
function overloaded(value: string): "string";
function overloaded(value: number): "number";
function overloaded(value: string | number) { return typeof value === "string" ? "string" : "number"; }
function genericOverload<T>(value: T[]): T[];
function genericOverload<T>(value: T): T;
function genericOverload(value: unknown) { return value; }
function tag(parts: TemplateStringsArray, value: number) { return parts[0] + value; }
function decorate<T extends Function>(target: T): T { return target; }
function decoratorFactory() { return decorate; }

@decoratorFactory()
export class Decorated {}
class Local { constructor(readonly value: string) {} }
class Methods { method<U>(value: U): U { return value; } }
function Component(props: { value: string }) { return props.value as unknown as JSX.Element; }

export function exercise(maybe?: (value: number) => number) {
  const inferred = identity({ id: 1, extra: true });
  const explicit = identity<{ id: number }>({ id: 2 });
  const withDefault = defaulted();
  const selected = overloaded("x");
  const genericSelected = genericOverload({ id: 4 });
  const constructed = new Local("x");
  const method = new Methods().method({ id: 5 });
  const tagged = tag\`value \${1}\`;
  const jsx = <Component value="x" />;
  const checked = {} instanceof Local;
  const external = Promise.resolve("x");
  const fromHelper = helper(1);
  const alias = identity;
  const aliased = alias({ id: 3 });
  const optional = maybe?.(1);
  const unresolved = missingCall();
  const notCallable = 1;
  const unresolvedNonCallable = notCallable();
  return { inferred, explicit, withDefault, selected, genericSelected, constructed, method, tagged, jsx, checked, external, fromHelper, aliased, optional, unresolved, unresolvedNonCallable };
}

declare namespace JSX {
  interface Element {}
  interface IntrinsicElements { widget: { value: string }; }
}
`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      jsx: "preserve",
      experimentalDecorators: true,
    },
    include: ["src/**/*"],
  }));
  return root;
}

function fixtureOptions(fixture, scope, sourceGlob) {
  return {
    sourceGlob,
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    scope,
  };
}

function findSymbol(model, name, external) {
  const symbol = Object.values(model.symbols)
    .filter((candidate) => candidate.name === name && candidate.external === external)
    .sort((left, right) => Number(left.kind === "alias") - Number(right.kind === "alias"))[0];
  assert.ok(symbol, `Expected ${external ? "external" : "internal"} symbol ${name}`);
  return symbol;
}

function dereferenceType(model, id) {
  assert.ok(id, "Expected a type reference");
  let current = model.types[id];
  const visited = new Set();
  while (current?.kind === "reference") {
    assert.equal(visited.has(current.id), false, `Reference cycle at ${current.id}`);
    visited.add(current.id);
    current = model.types[current.target];
  }
  assert.ok(current, `Missing type ${id}`);
  return current;
}

function assertGraphIntegrity(model) {
  const requireSymbol = (id) => assert.ok(model.symbols[id], `Missing symbol ${id}`);
  const requireType = (id) => assert.ok(model.types[id], `Missing type ${id}`);
  const requireSignature = (id) => assert.ok(model.signatures[id], `Missing signature ${id}`);

  for (const root of model.roots) requireSymbol(root);
  for (const module of model.modules) {
    for (const root of module.roots) requireSymbol(root);
    for (const entry of module.exports) {
      requireSymbol(entry.symbolId);
      requireSymbol(entry.targetSymbolId);
    }
    for (const callSite of module.callSites) assert.ok(model.callSites[callSite], `Missing call site ${callSite}`);
  }
  for (const symbol of Object.values(model.symbols)) {
    if (symbol.aliasTarget) requireSymbol(symbol.aliasTarget);
    if (symbol.declaredType) requireType(symbol.declaredType);
    if (symbol.valueType) requireType(symbol.valueType);
  }
  for (const type of Object.values(model.types)) {
    if (type.aliasSymbolId) requireSymbol(type.aliasSymbolId);
    for (const argument of type.aliasTypeArguments || []) requireType(argument);
    if (type.kind === "union" || type.kind === "intersection") {
      for (const member of type.types) requireType(member);
    } else if (type.kind === "typeParameter") {
      if (type.constraint) requireType(type.constraint);
      if (type.default) requireType(type.default);
    } else if (type.kind === "array") {
      requireType(type.elementType);
    } else if (type.kind === "tuple") {
      for (const element of type.elements) requireType(element.type);
    } else if (type.kind === "reference") {
      requireSymbol(type.symbolId);
      requireType(type.target);
      for (const argument of type.typeArguments) requireType(argument);
    } else if (type.kind === "external") {
      requireSymbol(type.symbolId);
      for (const argument of type.typeArguments) requireType(argument);
    } else if (type.kind === "conditional") {
      requireType(type.checkType);
      requireType(type.extendsType);
      requireType(type.trueType);
      requireType(type.falseType);
      for (const parameter of type.inferTypeParameters) requireType(parameter);
    } else if (type.kind === "mapped") {
      requireType(type.typeParameter.type);
      if (type.typeParameter.constraint) requireType(type.typeParameter.constraint);
      if (type.typeParameter.default) requireType(type.typeParameter.default);
      requireType(type.constraint);
      if (type.nameType) requireType(type.nameType);
      requireType(type.valueType);
    } else if (type.kind === "indexedAccess") {
      requireType(type.objectType);
      requireType(type.indexType);
    } else if (type.kind === "keyof" || type.kind === "stringMapping") {
      requireType(type.type);
    } else if (type.kind === "templateLiteral") {
      for (const member of type.types) requireType(member);
    } else if (type.kind === "substitution") {
      requireType(type.baseType);
      requireType(type.constraint);
    } else if (type.kind === "object") {
      if (type.symbolId) requireSymbol(type.symbolId);
      for (const property of type.properties) requireType(property.type);
      for (const signature of type.callSignatures) requireSignature(signature);
      for (const signature of type.constructSignatures) requireSignature(signature);
      if (type.stringIndexType) requireType(type.stringIndexType);
      if (type.numberIndexType) requireType(type.numberIndexType);
    }
  }
  for (const signature of Object.values(model.signatures)) {
    requireType(signature.returnType);
    if (signature.thisParameter) requireType(signature.thisParameter.type);
    for (const parameter of signature.parameters) requireType(parameter.type);
    for (const typeParameter of signature.typeParameters) {
      requireType(typeParameter.type);
      if (typeParameter.constraint) requireType(typeParameter.constraint);
      if (typeParameter.default) requireType(typeParameter.default);
    }
  }
  for (const callSite of Object.values(model.callSites)) {
    requireType(callSite.resultType);
    if (callSite.calleeSymbolId) requireSymbol(callSite.calleeSymbolId);
    if (callSite.declarationSignatureId) requireSignature(callSite.declarationSignatureId);
    if (callSite.resolvedSignatureId) requireSignature(callSite.resolvedSignatureId);
    for (const binding of callSite.genericInstantiation?.bindings || []) {
      requireType(binding.parameterType);
      requireType(binding.type);
    }
  }
}

function minimalModel() {
  return {
    schemaVersion: "2",
    project: {
      typescriptVersion: "test",
      tsconfigPath: "tsconfig.json",
      scope: "exports",
      includeCallSites: false,
      sourceGlobs: ["src/**/*.ts"],
      selectedFiles: [],
    },
    modules: [],
    roots: [],
    symbols: {},
    types: {},
    signatures: {},
    callSites: {},
    diagnostics: [],
  };
}

function captureStdout(callback) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    callback();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
