# Programmatic CLI API reference

`js-ts-tools` exposes most CLI-backed behavior as Node/TypeScript APIs. This document is a companion to `CLI_API_reference_improved.md`; it describes how to call the same tools directly from code instead of spawning the installed commands.

## Contents

- [Importing](#importing)
- [Conventions](#conventions)
- [API index](#api-index)
- [Command APIs](#command-apis)
- [Subpath-only APIs](#subpath-only-apis)

<a id="importing"></a>

## Importing

Use the package root for the public APIs exported from `src/index.ts`:

```ts
import {
  analyzeCodeImpact,
  createCodeSlice,
  formatCodeSlice,
  type CodeSliceReport,
} from "js-ts-tools";
```

CommonJS consumers can require the same root module:

```js
const { analyzeCodeImpact } = require("js-ts-tools");
```

When using the current checkout without publishing, build first so `dist/` and `bin/` are current:

```bash
npm run build
```

<a id="conventions"></a>

## Conventions

Programmatic APIs use JavaScript option objects rather than CLI flags. Most option names directly mirror the CLI concepts:

| CLI concept | Programmatic option |
| --- | --- |
| `--source` | `sourceGlob` or `sourceGlobs` |
| `--test-source` | `testSourceGlob` |
| `--tsconfig` | `tsConfigFilePath`, `tsconfig`, or `targetTsConfigFilePath` |
| `--exclude` | `excludePathIncludes` or `excludes` |
| `--file` | `filePath` |
| `--at file:line:column` | `at: { filePath, line, column }` |
| `--out` | Use a save/write helper or Node `fs` unless the API is explicitly CLI-oriented. |
| `--pretty` | Use the formatter helper or `JSON.stringify(value, null, 2)`. |

Other shared behavior:

| Topic | Behavior |
| --- | --- |
| Errors | Functions throw `Error` instead of returning CLI exit statuses. |
| Results | Analysis functions return the same report objects the CLI serializes. |
| Paths | APIs that accept `cwd` resolve relative paths from that directory. APIs without `cwd` use the current process working directory or the selected tsconfig directory as described below. |
| Globs | Pass glob strings directly, usually as arrays for repeatable CLI flags. |
| Locations | Line and column values are 1-based. Offsets in AST query reports are zero-based UTF-16 offsets, matching the TypeScript compiler API. |
| I/O | Most analysis APIs are synchronous. Save helpers and GitHub/JSON-file APIs are async where filesystem or network work requires it. |

<a id="api-index"></a>

## API index

| CLI command | Programmatic API | Import |
| --- | --- | --- |
| `context-pack` | `createContextPack`, `formatContextPack`, `estimateContextPackTokens` | `js-ts-tools` |
| `code-impact` | `analyzeCodeImpact` | `js-ts-tools` |
| `code-slice` | `createCodeSlice`, `formatCodeSlice` | `js-ts-tools` |
| `code-patterns` | `detectPatternsFromSources`, `patternKeys` | `js-ts-tools` |
| `type-model` | `extractTypeModel`, `generateTypeDeclarationsFromModel`, `saveTypeDeclarationsFromModel` | `js-ts-tools` |
| `collect-types` | `collectAssociatedTypes`, `formatAssociatedTypes`, `saveAssociatedTypes` | `js-ts-tools` |
| `create-project` | `createStructure`, `createFromJsonFile`, `extractStructure`, `readStructureFile`, `structureToJson`, `writeStructureFile` | `js-ts-tools` |
| `code-graph` | `buildGraphs` | `js-ts-tools` |
| `github-js-ts-search` | `findPackageReferences`, `importsAnyPackage`, `searchGitHubPackageImports` | `js-ts-tools` |
| `ast-xpath` | `generateAstXPathPattern`, `matchAstXPathPattern`, `readAstXPathPattern`, `runAstXPath`, `serializeAstToXml` | `js-ts-tools` |
| `tsquery` | `parseArgs`, `collectMatches`, `run`, `applyTextEdits`, `coalesceDeleteEdits` | `js-ts-tools` |
| `convert-ts-pattern` | `convertTsPattern`, `DEFAULT_MAX_CONTINUATION_BYTES` | `js-ts-tools` |
| `json-jspath` | `applyJSPath`, `applyJSPathToFiles`, `applyJSPathToFilesStream`, `forEachJSPathInFiles`, `findJsonFiles`, `readJsonFile`, `streamJSPathFromFile` | `js-ts-tools/dist/tools/json-jspath` |

<a id="command-apis"></a>

## Command APIs

<a id="context-pack"></a>

### `context-pack`

Builds a bounded, task-focused context bundle. Use `formatContextPack` when you want the same Markdown or JSON text that the CLI would emit.

```ts
import {
  createContextPack,
  estimateContextPackTokens,
  formatContextPack,
  type CreateContextPackOptions,
} from "js-ts-tools";

const options: CreateContextPackOptions = {
  sourceGlob: ["src/**/*.ts"],
  testSourceGlob: ["test/**/*.ts"],
  task: "repair invoice calculation",
  seeds: [
    { kind: "symbol", symbol: "calculateInvoice", filePath: "src/billing/invoice.ts" },
  ],
  docGlobs: ["docs/**/*.md"],
  direction: "both",
  maxTokens: 8000,
};

const report = createContextPack(options);
const markdown = formatContextPack(report, { format: "markdown" });
const tokens = estimateContextPackTokens(report);
```

Options:

```ts
interface CreateContextPackOptions {
  task: string;
  taskFilePath?: string;
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  seeds?: readonly ContextPackSeed[];
  docGlobs?: readonly string[];
  configFilePaths?: readonly string[];
  maxSeeds?: number;
  direction?: "incoming" | "outgoing" | "both";
  maxDepth?: number;
  maxNodes?: number;
  maxTokens?: number;
  cwd?: string;
}
```

`task` is required. `taskFilePath` is metadata for the returned report; the library function does not read the file for you. Read the task file yourself, then pass its text as `task`.

Defaults match the CLI: `tsConfigFilePath: "tsconfig.json"`, `maxSeeds: 5`, `direction: "both"`, `maxDepth: 2`, `maxNodes: 100`, and `maxTokens: 12000`.

Report top-level fields are `query`, `task`, `terms`, `seeds`, `instructions`, `documentation`, `configuration`, `code`, `omitted`, and `summary`.

<a id="code-impact"></a>

### `code-impact`

Finds the transitive impact radius of a symbol, a file, or a symbol narrowed to a file.

```ts
import { analyzeCodeImpact, type AnalyzeCodeImpactOptions } from "js-ts-tools";

const options: AnalyzeCodeImpactOptions = {
  sourceGlob: ["src/**/*.ts"],
  testSourceGlob: ["test/**/*.ts"],
  symbol: "OrderService.execute",
  direction: "incoming",
  maxDepth: 3,
};

const report = analyzeCodeImpact(options);
console.log(report.impactedTests.map((node) => node.qualifiedName));
```

Options:

```ts
interface AnalyzeCodeImpactOptions {
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  symbol?: string;
  filePath?: string;
  direction?: "incoming" | "outgoing" | "both";
  maxDepth?: number;
  maxNodes?: number;
  cwd?: string;
}
```

Pass `symbol`, `filePath`, or both. Defaults are `direction: "both"`, `maxDepth: 3`, and `maxNodes: 200`.

Report top-level fields are `query`, `targets`, `impacted`, `impactedTests`, and `summary`.

<a id="code-slice"></a>

### `code-slice`

Extracts a compact dependency-aware slice around a symbol, file, or source location. Use `formatCodeSlice` for CLI-equivalent JSON or Markdown text.

```ts
import {
  createCodeSlice,
  formatCodeSlice,
  type CreateCodeSliceOptions,
} from "js-ts-tools";

const options: CreateCodeSliceOptions = {
  sourceGlob: ["src/**/*.ts"],
  testSourceGlob: ["test/**/*.ts"],
  at: { filePath: "src/orders.ts", line: 47 },
  direction: "outgoing",
};

const report = createCodeSlice(options);
const json = formatCodeSlice(report, { format: "json", pretty: true });
```

Options:

```ts
interface CreateCodeSliceOptions {
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  symbol?: string;
  filePath?: string;
  at?: { filePath: string; line: number; column?: number };
  direction?: "incoming" | "outgoing" | "both";
  maxDepth?: number;
  maxNodes?: number;
  cwd?: string;
}
```

Use either `at` or the named target options. `at` cannot be combined with `symbol` or `filePath`. Defaults are `direction: "both"`, `maxDepth: 2`, and `maxNodes: 50`.

Report top-level fields are `query`, `targets`, `selections`, `files`, `boundaries`, `impactedTests`, and `summary`.

<a id="code-patterns"></a>

### `code-patterns`

Detects architectural and design patterns from selected source files.

```ts
import { detectPatternsFromSources, patternKeys } from "js-ts-tools";

const detections = detectPatternsFromSources({
  sourceGlob: ["src/**/*.ts"],
  patterns: ["pattern.repository", "pattern.unit_of_work"],
  minConfidence: "medium",
  config: {
    includeTestFiles: true,
    graphMaxDepth: 2,
  },
});

console.log(patternKeys);
console.log(detections.map((detection) => detection.pattern));
```

Options:

```ts
interface DetectPatternsFromSourcesOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  patterns?: PatternKey[];
  minConfidence?: "low" | "medium" | "high";
  config?: Partial<PatternDetectorConfig>;
}
```

Programmatic `PatternKey` values include the `pattern.` prefix, for example `"pattern.repository"`. The CLI accepts stripped names and adds the prefix internally.

Important `config` fields are `includeTestFiles`, `includeDeclarationFiles`, `graphMaxDepth`, `graphMaxRecordsPerTraversal`, `graphScoreCapPerPattern`, `callGraphMaxDepth`, `callGraphMaxCallsPerTraversal`, `callGraphScoreCapPerPattern`, and `confidenceThresholds`.

Each detection includes `pattern`, `detected`, `confidence`, `mode`, `score`, `filePath`, `nodeKind`, `nodeName`, `startLine`, `endLine`, `evidence`, `matchedRules`, `graphEvidence`, `callGraphEvidence`, `intersectingPatterns`, and `intersectionEvidence`.

<a id="type-model"></a>

### `type-model`

Extracts a normalized semantic TypeScript model. The CLI exposes schema version `2`; the programmatic API can also include schema version `3` declaration bundles.

```ts
import {
  extractTypeModel,
  generateTypeDeclarationsFromModel,
  saveTypeDeclarationsFromModel,
} from "js-ts-tools";

const model = extractTypeModel({
  sourceGlob: ["src/index.ts"],
  scope: "exports",
  includeCallSites: true,
  includeDeclarationBundles: true,
});

const generated = generateTypeDeclarationsFromModel(model, {
  module: "src/index.ts",
});

await saveTypeDeclarationsFromModel(model, "generated/index.d.ts", {
  module: "src/index.ts",
});

console.log(generated.mode, generated.diagnostics);
```

Options:

```ts
interface ExtractTypeModelOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  scope?: "exports" | "all";
  includeCallSites?: boolean;
  includeDeclarationBundles?: boolean;
  cwd?: string;
}

interface GenerateTypeDeclarationsOptions {
  module?: string;
  banner?: string | false;
  structuralFallback?: "allow";
}
```

Defaults are `tsConfigFilePath: "tsconfig.json"`, `scope: "exports"`, `includeCallSites: false`, and `includeDeclarationBundles: false`.

`includeDeclarationBundles: true` returns a schema version `3` model with a compiler-derived `.d.ts` bundle for each selected module. `generateTypeDeclarationsFromModel` uses those bundles by default and throws `ExactDeclarationUnavailableError` when exact declarations are unavailable. Pass `structuralFallback: "allow"` only when lossy structural declarations are acceptable.

Model top-level fields are `schemaVersion`, `project`, `modules`, `roots`, `symbols`, `types`, `signatures`, `callSites`, and `diagnostics`.

<a id="collect-types"></a>

### `collect-types`

Collects a dependency-first declaration closure for named type aliases, interfaces, and abstract classes.

```ts
import {
  collectAssociatedTypes,
  formatAssociatedTypes,
  saveAssociatedTypes,
} from "js-ts-tools";

const result = collectAssociatedTypes({
  names: ["User", "UserId"],
  sourceFilePath: "src/types.ts",
  tsConfigFilePath: "tsconfig.json",
  includeNodeModules: false,
});

const text = formatAssociatedTypes(result, {
  banner: "/* Generated associated type closure. */",
});

await saveAssociatedTypes(result, "generated/user-types.ts");
```

Options:

```ts
interface CollectAssociatedTypesOptions {
  names: readonly string[];
  tsConfigFilePath: string;
  sourceFilePath: string;
  includeNodeModules?: boolean;
  includeTypeScriptLibs?: boolean;
}
```

Defaults are `includeNodeModules: true` and `includeTypeScriptLibs: false`. A relative `sourceFilePath` is resolved from the selected tsconfig directory.

The result contains the `Project`, selected `SourceFile`, root declarations, and the dependency-first `declarations` array. Use `formatAssociatedTypes` for a string or `saveAssociatedTypes` to write it.

<a id="create-project"></a>

### `create-project`

Creates a blank project structure from JSON-like data or extracts a structure from an existing directory.

```ts
import {
  createFromJsonFile,
  createStructure,
  extractStructure,
  structureToJson,
  writeStructureFile,
  type ProjectStructure,
} from "js-ts-tools";

const structure: ProjectStructure = {
  src: {
    "index.ts": "",
    services: {
      "orders.ts": null,
    },
  },
  "package.json": "",
};

createStructure(structure, "./my-project");

const extracted = extractStructure("./my-project");
const json = structureToJson(extracted);
writeStructureFile("./my-project", "structure.json");

createFromJsonFile("structure.json", "./copy");
```

Options and helpers:

```ts
interface ExtractStructureOptions {
  ignore?: readonly string[] | Set<string>;
}

interface CreateStructureOptions {
  overwriteFiles?: boolean;
}

type ProjectStructure = Record<string, ProjectStructureValue>;
type ProjectStructureValue = ProjectStructure | string | number | boolean | null;
```

`extractStructure` ignores `node_modules`, `.git`, and `.DS_Store` by default. `createStructure` preserves existing files unless `overwriteFiles: true` is set. File values are markers; created files are blank regardless of marker value.

<a id="code-graph"></a>

### `code-graph`

Builds structural and semantic graphs from source files.

```ts
import { buildGraphs } from "js-ts-tools";

const graphs = buildGraphs(
  {
    sourceGlob: ["src/**/*.ts"],
    tsConfigFilePath: "tsconfig.json",
    excludePathIncludes: ["dist"],
  },
  {
    includeCallGraph: true,
    includeOwnerReferenceGraph: true,
    toJson: true,
  },
);

console.log(graphs.callGraph);
```

Options:

```ts
interface SourceOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
}

interface TargetOptions {
  includeStructureForest?: boolean;
  includeCallGraph?: boolean;
  includeOwnerReferenceGraph?: boolean;
  includeDefinitionUseGraph?: boolean;
  toJson?: boolean;
}
```

With `toJson: true`, the returned object contains JSON-safe `structureForest`, `callGraph`, `ownerReferenceGraph`, and/or `definitionUseGraph` properties. Without `toJson`, it returns the internal graph objects.

<a id="github-js-ts-search"></a>

### `github-js-ts-search`

Parses local source text for package imports or searches GitHub and saves matching blobs.

```ts
import {
  findPackageReferences,
  importsAnyPackage,
  searchGitHubPackageImports,
} from "js-ts-tools";

const source = 'import { uniq } from "lodash";';
const references = findPackageReferences(source, ["lodash"], "example.ts");
const hasLodash = importsAnyPackage(source, ["lodash"], "example.ts");

const report = await searchGitHubPackageImports({
  packages: ["lodash"],
  token: process.env.GITHUB_TOKEN ?? "",
  outputDirectory: "corpus",
});

console.log(references, hasLodash, report.savedFileCount);
```

Options:

```ts
interface SearchGitHubPackageImportsOptions {
  packages: readonly string[];
  token: string;
  outputDirectory?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  requestTimeoutMs?: number;
}
```

`findPackageReferences` and `importsAnyPackage` are pure local parsers. `searchGitHubPackageImports` requires a GitHub token, queries GitHub code search, downloads exact blobs, writes files under `outputDirectory/files/...`, writes `manifest.json`, and returns the manifest report.

Recognized local references include static imports, type-only imports, `import = require`, and direct `require("pkg")` calls. Dynamic imports and re-exports are ignored.

<a id="ast-xpath"></a>

### `ast-xpath`

Generates portable XPath 3.1 patterns from a marked TypeScript example and matches them against a target project.

```ts
import {
  generateAstXPathPattern,
  matchAstXPathPattern,
  readAstXPathPattern,
  runAstXPath,
} from "js-ts-tools";

const generated = generateAstXPathPattern({
  exampleFilePath: "patterns/audit-example.ts",
  tsConfigFilePath: "tsconfig.json",
  strictness: "shape",
});

const report = matchAstXPathPattern({
  pattern: generated.pattern,
  targetTsConfigFilePath: "tsconfig.json",
  sourceGlobs: ["src/**/*.ts"],
  semanticMode: "strict",
});

const savedPattern = readAstXPathPattern("patterns/audit.json");
const runReport = runAstXPath({
  exampleFilePath: "patterns/audit-example.ts",
  targetTsConfigFilePath: "../target-project/tsconfig.json",
  sourceGlobs: ["src/**/*.ts"],
});

console.log(report.summary, savedPattern.schemaVersion, runReport.xml);
```

Options:

```ts
interface GenerateAstXPathPatternOptions {
  exampleFilePath: string;
  tsConfigFilePath?: string;
  cwd?: string;
  strictness?: "exact" | "shape";
}

interface MatchAstXPathPatternOptions {
  pattern: AstXPathPattern;
  cwd?: string;
  targetTsConfigFilePath?: string;
  semanticMode?: "strict" | "structural";
  sourceGlobs?: string[];
  excludePathIncludes?: string[];
  includeDeclarations?: boolean;
}
```

`runAstXPath` combines generation and matching and returns the match report plus `xml`. The example file must contain exactly one `/* ast-xpath-root */` marker. Optional ignore markers behave the same as the CLI.

Match reports contain `pattern`, `matches`, and `summary`. The summary contains `filesScanned`, `xpathCandidates`, `semanticRejected`, and `matches`.

<a id="tsquery"></a>

### `tsquery`

The root package exports the CLI-oriented TSQuery helpers. `collectMatches` is useful for pure queries; `run` performs CLI-style formatting, output, mutation preview, and optional writes.

```ts
import { collectMatches, run, type CliOptions } from "js-ts-tools";

const options: CliOptions = {
  selector: 'CallExpression > Identifier[name="fetch"]',
  tsconfig: "tsconfig.json",
  sources: ["src/**/*.ts"],
  excludes: [],
  includeDeclarations: false,
  format: "json",
  pretty: true,
  failEmpty: false,
  write: false,
};

const matches = collectMatches(options).map((match) => match.record);

const exitStatus = run({
  ...options,
  selector: 'ImportDeclaration:has(StringLiteral[text="lodash"])',
  mutation: { kind: "delete" },
  write: false,
});
```

Options:

```ts
interface CliOptions {
  selector: string;
  tsconfig: string;
  sources: string[];
  excludes: string[];
  includeDeclarations: boolean;
  format: "json" | "text";
  pretty: boolean;
  out?: string;
  failEmpty: boolean;
  write: boolean;
  mutation?:
    | { kind: "delete" }
    | { kind: "insert-before"; text: string }
    | { kind: "insert-after"; text: string };
}
```

`collectMatches` returns objects containing the TypeScript `sourceFile`, matched `node`, and a serializable `record`. `run` returns `0` or `2`, writes to stdout unless `out` is set, and writes source files only when `write: true` and `mutation` is provided.

For lower-level text manipulation, `applyTextEdits(source, edits)` applies zero-based edit ranges and `coalesceDeleteEdits(edits)` merges overlapping delete ranges.

<a id="convert-ts-pattern"></a>

### `convert-ts-pattern`

Conservatively rewrites supported conditionals to `ts-pattern`. Dry-run is the default.

```ts
import { convertTsPattern, DEFAULT_MAX_CONTINUATION_BYTES } from "js-ts-tools";

const report = convertTsPattern({
  sourceGlob: ["src/**/*.ts"],
  tsConfigFilePath: "tsconfig.json",
  excludePathIncludes: ["dist"],
  write: false,
  maxContinuationBytes: DEFAULT_MAX_CONTINUATION_BYTES,
});

console.log(report.summary);
```

Options:

```ts
interface ConvertTsPatternOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  cwd?: string;
  write?: boolean;
  maxContinuationBytes?: number;
}
```

The target project must already resolve `ts-pattern`. Existing diagnostics are tolerated, but accepted conversions must not introduce new diagnostics. Before `write: true` changes files, the implementation checks that source files still match the bytes used to plan edits.

The report contains `query`, `written`, `files`, and `summary`. Candidate records include locations, kind, subject/discriminator information, action, terminator/fallback details for conversions, and reason/diagnostics for skips.

<a id="subpath-only-apis"></a>

## Subpath-only APIs

<a id="json-jspath"></a>

### `json-jspath`

The JSON JSPath helpers are implemented as a programmatic module, but they are not re-exported from the package root. Import them from the built subpath:

```ts
import {
  applyJSPath,
  applyJSPathToFiles,
  applyJSPathToFilesStream,
  forEachJSPathInFiles,
} from "js-ts-tools/dist/tools/json-jspath";
```

Use `applyJSPath` for already-loaded objects:

```ts
const names = applyJSPath<string>(
  { users: [{ name: "Ada", active: true }] },
  ".users{.active === true}.name",
);
```

Use `applyJSPathToFiles` when you want accumulated results:

```ts
const { results, errors } = await applyJSPathToFiles<string>(
  "data/**/*.json",
  ".name",
  {
    withFile: true,
    continueOnError: true,
  },
);
```

Use `applyJSPathToFilesStream` or `forEachJSPathInFiles` to avoid accumulating matches:

```ts
for await (const match of applyJSPathToFilesStream("data/**/*.json", ".name")) {
  console.log(match);
}

await forEachJSPathInFiles("data/**/*.json", ".name", async (match) => {
  console.log(match);
});
```

Options:

```ts
interface ApplyJSPathOptions {
  first?: boolean;
}

interface ApplyJSPathToFilesOptions {
  cwd?: string;
  absolute?: boolean;
  withFile?: boolean;
  first?: boolean;
  continueOnError?: boolean;
}
```

Top-level JSON arrays are streamed item by item. The JSPath expression is applied independently to each array element. Other JSON documents are read and parsed as whole documents.

`continueOnError: false` throws on the first malformed or unreadable file. `continueOnError: true` collects or reports file errors and continues.
