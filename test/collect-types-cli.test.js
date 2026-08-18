"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  GENERATED_BANNER,
  parseArgs,
  run,
} = require("../bin/collect-types-cli");
const {
  collectAssociatedTypes,
} = require("../dist/collection/type-collector");
const {
  formatAssociatedTypes,
  saveAssociatedTypes,
} = require("../dist/collection/emit-collected");

test("collect-types parses roots, paths, and closure controls", () => {
  const options = parseArgs([
    "--name", "User",
    "--name", "BaseUser",
    "--source", "src/index.ts",
    "--tsconfig", "config/tsconfig.json",
    "--exclude-node-modules",
    "--include-typescript-libs",
    "--out", "generated/types.ts",
  ]);

  assert.deepEqual(options.names, ["User", "BaseUser"]);
  assert.equal(options.sourceFilePath, "src/index.ts");
  assert.equal(options.tsConfigFilePath, "config/tsconfig.json");
  assert.equal(options.includeNodeModules, false);
  assert.equal(options.includeTypeScriptLibs, true);
  assert.equal(options.outputFilePath, "generated/types.ts");
});

test("collect-types rejects missing, unknown, and malformed options", () => {
  assert.throws(
    () => parseArgs(["--source", "src/types.ts"]),
    /Missing required option: --name/,
  );
  assert.throws(
    () => parseArgs(["--name", "User"]),
    /Missing required option: --source/,
  );
  assert.throws(
    () => parseArgs(["--name", "--source", "src/types.ts"]),
    /Expected value after --name/,
  );
  assert.throws(
    () => parseArgs(["--name", "User", "--source", "src/types.ts", "extra"]),
    /Unknown argument: extra/,
  );
});

test("collect-types emits a dependency-first closure from a barrel", async () => {
  const fixture = createTypeFixture();
  const collectorOptions = {
    names: ["User", "BaseUser"],
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    sourceFilePath: path.join(fixture, "src", "index.ts"),
    includeNodeModules: true,
    includeTypeScriptLibs: false,
  };
  const result = collectAssociatedTypes(collectorOptions);
  const text = formatAssociatedTypes(result, { banner: GENERATED_BANNER });

  assert.match(text, /Generated associated type closure/);
  assert.match(text, /unique symbol/);
  assert.match(text, /interface External/);
  assert.match(text, /type UserId/);
  assert.match(text, /interface User/);
  assert.match(text, /abstract class BaseUser/);
  assert.equal(text.indexOf("interface External") < text.indexOf("type UserId"), true);
  assert.equal(text.indexOf("type UserId") < text.indexOf("interface User"), true);
  assert.equal(text.endsWith("\n"), true);

  const outputPath = path.join(fixture, "generated", "nested", "types.ts");
  await saveAssociatedTypes(result, outputPath, { banner: GENERATED_BANNER });
  assert.equal(fs.readFileSync(outputPath, "utf8"), text);

  const cliOutputPath = path.join(fixture, "cli", "types.ts");
  await run([
    "--name", "User",
    "--name", "BaseUser",
    "--source", path.join(fixture, "src", "index.ts"),
    "--tsconfig", path.join(fixture, "tsconfig.json"),
    "--out", cliOutputPath,
  ]);
  assert.equal(fs.readFileSync(cliOutputPath, "utf8"), text);

  const stdout = await captureStdout(() => run([
    "--name", "User",
    "--name", "BaseUser",
    "--source", path.join(fixture, "src", "index.ts"),
    "--tsconfig", path.join(fixture, "tsconfig.json"),
  ]));
  assert.equal(stdout, text);
});

test("collect-types controls node_modules and TypeScript library declarations", () => {
  const fixture = createTypeFixture();
  const baseOptions = {
    names: ["User"],
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    sourceFilePath: path.join(fixture, "src", "index.ts"),
  };

  const withoutDependencies = formatAssociatedTypes(
    collectAssociatedTypes({
      ...baseOptions,
      includeNodeModules: false,
      includeTypeScriptLibs: false,
    }),
  );
  assert.doesNotMatch(withoutDependencies, /interface External/);

  const withTypeScriptLibs = formatAssociatedTypes(
    collectAssociatedTypes({
      ...baseOptions,
      includeNodeModules: false,
      includeTypeScriptLibs: true,
    }),
  );
  assert.match(withTypeScriptLibs, /type PropertyKey/);
});

test("collect-types preserves collector validation errors", () => {
  const fixture = createTypeFixture();
  const options = {
    tsConfigFilePath: path.join(fixture, "tsconfig.json"),
    sourceFilePath: path.join(fixture, "src", "model.ts"),
  };

  assert.throws(
    () => collectAssociatedTypes({ ...options, names: ["ConcreteUser"] }),
    /concrete class/,
  );
  assert.throws(
    () => collectAssociatedTypes({ ...options, names: ["Missing"] }),
    /Could not find/,
  );
  assert.throws(
    () => collectAssociatedTypes({
      ...options,
      names: ["User"],
      sourceFilePath: path.join(fixture, "src", "missing.ts"),
    }),
    /Source file not found/,
  );
});

function createTypeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collect-types-fixture-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "external-types"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "external-types", "package.json"), JSON.stringify({
    name: "external-types",
    version: "1.0.0",
    types: "index.d.ts",
  }));
  fs.writeFileSync(path.join(root, "node_modules", "external-types", "index.d.ts"), `
export declare const externalTag: unique symbol;
export interface External { readonly [externalTag]: "external"; }
`);
  fs.writeFileSync(path.join(root, "src", "model.ts"), `
import type { External } from "external-types";
export type UserId = string & External;
export interface User { id: UserId; key: PropertyKey; }
export abstract class BaseUser { abstract value: User; }
export class ConcreteUser {}
`);
  fs.writeFileSync(path.join(root, "src", "index.ts"), `
export type { User, UserId } from "./model";
export { BaseUser } from "./model";
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

async function captureStdout(callback) {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    await callback();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
