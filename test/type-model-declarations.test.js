"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const {
  extractTypeModel,
  generateTypeDeclarationsFromModel,
  saveTypeDeclarationsFromModel,
} = require("../dist");

test("type-model opt-in stores and generates a standalone declaration bundle", () => {
  const fixture = createBundleFixture();
  const model = extractTypeModel({
    sourceGlob: path.join(fixture, "src/index.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    includeDeclarationBundles: true,
  });

  assert.equal(model.schemaVersion, "3");
  assert.equal(model.project.includeDeclarationBundles, true);
  assert.equal(model.modules[0].declarationBundle.status, "generated");
  assert.doesNotMatch(model.modules[0].declarationBundle.text, /from ["']\.\/model["']/);
  assert.match(model.modules[0].declarationBundle.text, /from ["']external-box["']/);
  assert.doesNotMatch(model.modules[0].declarationBundle.text, new RegExp(escapeRegExp(fixture)));

  const generated = generateTypeDeclarationsFromModel(JSON.parse(JSON.stringify(model)));
  const repeated = generateTypeDeclarationsFromModel(JSON.parse(JSON.stringify(model)));
  assert.equal(generated.mode, "bundled");
  assert.equal(repeated.text, generated.text);
  assert.deepEqual(generated.diagnostics, []);
  assert.match(generated.text, /^\/\* Generated from type-model\. \*\//);
  assert.match(generated.text, /export (?:declare )?function makeUser/);
  assert.match(generated.text, /export (?:declare )?class User/);
  assert.doesNotMatch(generated.text, /export (?:declare )?(?:interface|type) Internal/);
  assertTypeChecks(fixture, generated.text);
});

test("default extraction remains schema v2 without declaration payloads", () => {
  const fixture = createBundleFixture();
  const model = extractTypeModel({
    sourceGlob: path.join(fixture, "src/index.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
  });
  const explicitV2 = extractTypeModel({
    sourceGlob: path.join(fixture, "src/index.ts"),
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    includeDeclarationBundles: false,
  });

  assert.equal(model.schemaVersion, "2");
  assert.equal(JSON.stringify(explicitV2), JSON.stringify(model));
  assert.equal("includeDeclarationBundles" in model.project, false);
  assert.equal("declarationBundle" in model.modules[0], false);

  const generated = generateTypeDeclarationsFromModel(model, { banner: false });
  assert.equal(generated.mode, "structural-fallback");
  assertTypeChecks(fixture, generated.text);
});

test("opt-in extraction records a module-local bundle failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-bundle-failure-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "script.ts"), "const localOnly = 1;\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022" },
    include: ["src/**/*.ts"],
  }));

  const model = extractTypeModel({
    sourceGlob: path.join(root, "src/script.ts"),
    tsConfigFilePath: path.join(root, "tsconfig.json"),
    includeDeclarationBundles: true,
  });
  assert.equal(model.schemaVersion, "3");
  assert.equal(model.modules[0].declarationBundle.status, "failed");
  const diagnostic = model.diagnostics.find((item) => item.code === "declaration-bundle-failed");
  assert.ok(diagnostic);
  assert.doesNotMatch(diagnostic.message, new RegExp(escapeRegExp(root)));
});

test("schema v2 structurally renders self references, values, aliases, and external imports", () => {
  const model = structuralModel();
  const generated = generateTypeDeclarationsFromModel(model, { banner: false });

  assert.equal(generated.mode, "structural-fallback");
  assert.match(generated.text, /import type \{ ExternalBox \} from "external-box";/);
  assert.match(generated.text, /export type Node = \{/);
  assert.doesNotMatch(generated.text, /type Node = Node;/);
  assert.match(generated.text, /next\?: Node;/);
  assert.match(generated.text, /export declare const makeNode: \{\n  \(value: string\): Node;/);
  assert.match(generated.text, /export type \{ Node as NodeAlias \};/);
  assert.match(generated.text, /external: ExternalBox<string>;/);
});

test("generation selects modules, reports failed bundles, and saves output", async () => {
  const model = structuralModel();
  model.modules.push({
    id: "module:src/other.ts",
    filePath: "src/other.ts",
    roots: [],
    exports: [],
    callSites: [],
  });
  assert.throws(() => generateTypeDeclarationsFromModel(model), /select one by id or file path/);
  assert.throws(() => generateTypeDeclarationsFromModel(model, { module: "missing.ts" }), /Module not found/);

  const selected = generateTypeDeclarationsFromModel(model, { module: "module:src/model.ts" });
  assert.equal(selected.moduleFilePath, "src/model.ts");
  assert.equal(
    generateTypeDeclarationsFromModel(model, { module: "src/model.ts" }).moduleId,
    "module:src/model.ts",
  );

  const failed = {
    ...structuralModel(),
    schemaVersion: "3",
    project: {
      ...structuralModel().project,
      includeDeclarationBundles: true,
    },
  };
  failed.modules[0] = {
    ...failed.modules[0],
    declarationBundle: {
      format: "d.ts",
      status: "failed",
      diagnosticCode: "declaration-bundle-failed",
    },
  };
  failed.diagnostics.push({
    source: "type-model",
    category: "warning",
    code: "declaration-bundle-failed",
    message: "fixture bundle failed",
    location: { filePath: "src/model.ts", line: 1, column: 1 },
  });
  const fallback = generateTypeDeclarationsFromModel(failed);
  assert.equal(fallback.mode, "structural-fallback");
  assert.equal(fallback.diagnostics[0].code, "declaration-bundle-failed");
  assert.equal(fallback.diagnostics[0].message, "fixture bundle failed");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-save-"));
  const outputPath = path.join(root, "nested", "types.d.ts");
  const saved = await saveTypeDeclarationsFromModel(structuralModel(), outputPath, {
    banner: "/* Custom. */",
  });
  assert.equal(saved.outputFilePath, outputPath);
  assert.equal(fs.readFileSync(outputPath, "utf8"), saved.text);
  assert.match(saved.text, /^\/\* Custom\. \*\//);
});

test("schema v2 falls back to displayText and replaces unprintable sentinels", () => {
  const model = structuralModel();
  model.symbols["symbol:unsupported"] = {
    id: "symbol:unsupported",
    name: "Unsupported",
    qualifiedName: "Unsupported",
    kind: "typeAlias",
    flags: ["TypeAlias"],
    external: false,
    declarations: [],
    declaredType: "type:unsupported",
  };
  model.symbols["symbol:unresolved"] = {
    ...model.symbols["symbol:unsupported"],
    id: "symbol:unresolved",
    name: "Unresolved",
    qualifiedName: "Unresolved",
    declaredType: "type:unresolved",
  };
  model.types["type:unsupported"] = {
    id: "type:unsupported",
    kind: "unsupported",
    displayText: "string | number",
    flags: [],
    reason: "fixture",
  };
  model.types["type:unresolved"] = {
    id: "type:unresolved",
    kind: "unsupported",
    displayText: "<unresolved>",
    flags: [],
    reason: "fixture",
  };
  model.modules[0].exports.push(
    { name: "Unsupported", symbolId: "symbol:unsupported", targetSymbolId: "symbol:unsupported" },
    { name: "Unresolved", symbolId: "symbol:unresolved", targetSymbolId: "symbol:unresolved" },
  );

  const generated = generateTypeDeclarationsFromModel(model, { banner: false });
  assert.match(generated.text, /export type Unsupported = string \| number;/);
  assert.match(generated.text, /export type Unresolved = unknown;/);
  assert.equal(generated.diagnostics.filter((item) => item.code === "display-text-fallback").length, 2);
});

function createBundleFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "type-model-bundle-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "external-box"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "external-box", "package.json"), JSON.stringify({
    name: "external-box",
    version: "1.0.0",
    types: "index.d.ts",
  }));
  fs.writeFileSync(path.join(root, "node_modules", "external-box", "index.d.ts"), `
export interface ExternalBox<T> { external: T; }
`);
  fs.writeFileSync(path.join(root, "src", "model.ts"), `
import type { ExternalBox } from "external-box";
interface Internal { hidden: true; }
export enum Role { User = "user", Admin = "admin" }
export type Conditional<T> = T extends string ? \`value-\${T}\` : readonly [value: T, optional?: T];
export type InferValue<T> = T extends { value: infer U } ? U : never;
export type Remapped<T> = { -readonly [K in keyof T as \`get\${Capitalize<string & K>}\`]-?: T[K] };
export class User<T extends string = string> {
  static version = 1;
  constructor(readonly id: T, readonly box: ExternalBox<T>) {}
  get internal(): Internal { return { hidden: true }; }
}
export function makeUser(id: string): User { return new User(id, { external: id }); }
`);
  fs.writeFileSync(path.join(root, "src", "index.ts"), `
export { User, Role, makeUser } from "./model";
export type { Conditional, InferValue, Remapped } from "./model";
export { User as default } from "./model";
`);
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "Node16",
      moduleResolution: "Node16",
      declaration: true,
      skipLibCheck: true,
    },
    include: ["src/**/*.ts"],
  }));
  return root;
}

function structuralModel() {
  return {
    schemaVersion: "2",
    project: {
      typescriptVersion: ts.version,
      tsconfigPath: "tsconfig.json",
      scope: "exports",
      includeCallSites: false,
      sourceGlobs: ["src/model.ts"],
      selectedFiles: ["src/model.ts"],
    },
    modules: [{
      id: "module:src/model.ts",
      filePath: "src/model.ts",
      roots: ["symbol:node", "symbol:makeNode"],
      exports: [
        { name: "Node", symbolId: "symbol:node", targetSymbolId: "symbol:node" },
        { name: "NodeAlias", symbolId: "symbol:nodeAlias", targetSymbolId: "symbol:node" },
        { name: "makeNode", symbolId: "symbol:makeNode", targetSymbolId: "symbol:makeNode" },
      ],
      callSites: [],
    }],
    roots: ["symbol:node", "symbol:makeNode"],
    symbols: {
      "symbol:node": localSymbol("symbol:node", "Node", "type:node-ref"),
      "symbol:nodeAlias": {
        ...localSymbol("symbol:nodeAlias", "NodeAlias"),
        kind: "alias",
        flags: ["Alias"],
        aliasTarget: "symbol:node",
      },
      "symbol:makeNode": {
        ...localSymbol("symbol:makeNode", "makeNode"),
        kind: "function",
        flags: ["Function"],
        valueType: "type:make-node",
      },
      "external:package:external-box:index.d.ts:ExternalBox": {
        id: "external:package:external-box:index.d.ts:ExternalBox",
        name: "ExternalBox",
        qualifiedName: "ExternalBox",
        kind: "interface",
        flags: ["Interface"],
        external: true,
        declarations: [],
      },
    },
    types: {
      "type:string": { id: "type:string", kind: "intrinsic", name: "string", displayText: "string", flags: [] },
      "type:undefined": { id: "type:undefined", kind: "intrinsic", name: "undefined", displayText: "undefined", flags: [] },
      "type:node-ref": {
        id: "type:node-ref",
        kind: "reference",
        symbolId: "symbol:node",
        typeArguments: [],
        target: "type:node-shape",
        displayText: "Node",
        flags: ["Object"],
      },
      "type:node-optional": {
        id: "type:node-optional",
        kind: "union",
        types: ["type:node-ref", "type:undefined"],
        displayText: "Node | undefined",
        flags: ["Union"],
      },
      "type:external": {
        id: "type:external",
        kind: "external",
        symbolId: "external:package:external-box:index.d.ts:ExternalBox",
        typeArguments: ["type:string"],
        displayText: "ExternalBox<string>",
        flags: ["Object"],
      },
      "type:node-shape": {
        id: "type:node-shape",
        kind: "object",
        symbolId: "symbol:node",
        properties: [
          { name: "value", type: "type:string", optional: false, readonly: false, declarations: [] },
          { name: "next", type: "type:node-ref", optional: true, readonly: false, declarations: [] },
          { name: "external", type: "type:external", optional: false, readonly: false, declarations: [] },
        ],
        callSignatures: [],
        constructSignatures: [],
        displayText: "Node",
        flags: ["Object"],
      },
      "type:make-node": {
        id: "type:make-node",
        kind: "object",
        symbolId: "symbol:makeNode",
        properties: [],
        callSignatures: ["signature:make-node"],
        constructSignatures: [],
        displayText: "(value: string) => Node",
        flags: ["Object"],
      },
    },
    signatures: {
      "signature:make-node": {
        id: "signature:make-node",
        kind: "call",
        typeParameters: [],
        parameters: [{ name: "value", type: "type:string", optional: false, rest: false, annotation: "explicit" }],
        returnType: "type:node-ref",
        returnAnnotation: "explicit",
      },
    },
    callSites: {},
    diagnostics: [],
  };
}

function localSymbol(id, name, declaredType) {
  return {
    id,
    name,
    qualifiedName: name,
    kind: "typeAlias",
    flags: ["TypeAlias"],
    external: false,
    declarations: [],
    ...(declaredType ? { declaredType } : {}),
  };
}

function assertTypeChecks(root, text) {
  const filePath = path.join(root, "generated.d.ts");
  fs.writeFileSync(filePath, text);
  const program = ts.createProgram([filePath], {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    skipLibCheck: false,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    [],
    text,
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
