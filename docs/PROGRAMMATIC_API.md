# Programmatic API Reference

`js-ts-tools` exposes most CLI-backed behavior as Node/TypeScript APIs. This document is a companion to the [CLI API reference](CLI_API.md); it describes how to call the same tools directly from code instead of spawning the installed commands.

The package root, `js-ts-tools`, is the stable public API. Any section that uses a `dist/...` import is explicitly marked as implementation-dependent.

## Contents

- [Importing](#importing)
- [30-Second Quick Start](#30-second-quick-start)
- [Capability Matrix](#capability-matrix)
- [Conventions](#conventions)
- [Path Resolution](#path-resolution)
- [Shared Types](#shared-types)
- [Public API Reference](#public-api-reference)
- [`context-pack`](#context-pack)
- [`code-impact`](#code-impact)
- [`code-slice`](#code-slice)
- [`code-patterns`](#code-patterns)
- [`type-model`](#type-model)
- [`collect-types`](#collect-types)
- [`create-project`](#create-project)
- [`code-graph`](#code-graph)
- [`github-js-ts-search`](#github-js-ts-search)
- [`ast-xpath`](#ast-xpath)
- [`convert-ts-pattern`](#convert-ts-pattern)
- [`conditional-to-effect-schema-v3`](#conditional-to-effect-schema-v3)
- [`effect-v3-codemod`](#effect-v3-codemod)
- [CLI Compatibility APIs](#cli-compatibility-apis)
- [`tsquery`](#tsquery)
- [Implementation-Dependent Subpath APIs](#implementation-dependent-subpath-apis)
- [`json-jspath`](#json-jspath)

<a id="importing"></a>

## Importing

Use the package root for stable public APIs exported from `src/index.ts`:

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

<a id="30-second-quick-start"></a>

## 30-Second Quick Start

Analyze the impact of a symbol:

```ts
import { analyzeCodeImpact } from "js-ts-tools";

const impact = analyzeCodeImpact({
  sourceGlob: "src/**/*.ts",
  testSourceGlob: "test/**/*.ts",
  symbol: "OrderService.execute",
});

console.log(impact.impactedTests.map((node) => node.qualifiedName));
```

Extract a dependency-aware slice:

```ts
import { createCodeSlice, formatCodeSlice } from "js-ts-tools";

const slice = createCodeSlice({
  sourceGlob: "src/**/*.ts",
  at: { filePath: "src/orders.ts", line: 47 },
  direction: "outgoing",
});

console.log(formatCodeSlice(slice, { format: "markdown" }));
```

Build a context pack:

```ts
import { createContextPack, formatContextPack } from "js-ts-tools";

const pack = createContextPack({
  sourceGlob: "src/**/*.ts",
  testSourceGlob: "test/**/*.ts",
  task: "repair invoice total rounding",
  seeds: [{ kind: "symbol", symbol: "calculateInvoice" }],
  maxTokens: 8000,
});

console.log(formatContextPack(pack, { format: "markdown" }));
```

<a id="capability-matrix"></a>

## Capability Matrix

| CLI / capability | Programmatic API | Import | Purpose | Sync/Async | Reads files | Writes files | Network |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `context-pack` | `createContextPack`, `formatContextPack`, `estimateContextPackTokens` | `js-ts-tools` | Build task-focused code, docs, and config context | Sync | Yes | No | No |
| `code-impact` | `analyzeCodeImpact` | `js-ts-tools` | Find code and tests affected by a symbol or file | Sync | Yes | No | No |
| `code-slice` | `createCodeSlice`, `formatCodeSlice` | `js-ts-tools` | Extract declarations, imports, snippets, and dependency paths | Sync | Yes | No | No |
| `code-patterns` | `detectPatternsFromSources`, `patternKeys` | `js-ts-tools` | Detect architectural and design patterns | Sync | Yes | No | No |
| `type-model` | `extractTypeModel`, `generateTypeDeclarationsFromModel`, `saveTypeDeclarationsFromModel` | `js-ts-tools` | Extract semantic type models and generate declaration text | Sync extraction/generation, async save | Yes | Only `saveTypeDeclarationsFromModel` | No |
| `collect-types` | `collectAssociatedTypes`, `formatAssociatedTypes`, `saveAssociatedTypes` | `js-ts-tools` | Collect dependency-first declarations for named types | Sync collect/format, async save | Yes | Only `saveAssociatedTypes` | No |
| `create-project` | `createStructure`, `createFromJsonFile`, `extractStructure`, `readStructureFile`, `structureToJson`, `writeStructureFile` | `js-ts-tools` | Create or extract project skeletons | Sync | Yes for read/extract | Yes for create/write | No |
| `code-graph` | `buildGraphs` | `js-ts-tools` | Build structural, call, owner-reference, and definition-use graphs | Sync | Yes | No | No |
| Package import parser | `findPackageReferences`, `importsAnyPackage` | `js-ts-tools` | Parse already-loaded source text for npm imports | Sync | No | No | No |
| `github-js-ts-search` | `searchGitHubPackageImports` | `js-ts-tools` | Search GitHub code and save matching source blobs | Async | No local project reads | Yes | GitHub API |
| `ast-xpath` | `generateAstXPathPattern`, `matchAstXPathPattern`, `readAstXPathPattern`, `runAstXPath`, `serializeAstToXml` | `js-ts-tools` | Generate and match XPath 3.1 patterns over TypeScript AST XML | Sync | Yes | No | No |
| `effect-v3-codemod` | `runEffectCodemod`, `effectCodemod` | `js-ts-tools` | Convert proven idioms to Effect v3 operators | Sync | Yes | Only with `write: true` | No |
| `conditional-to-effect-schema-v3` | `convertConditionalToEffectSchemaV3` | `js-ts-tools` | Generate Effect v3 Schema refinements | Sync | Yes | No | No |
| `convert-ts-pattern` | `convertTsPattern`, `DEFAULT_MAX_CONTINUATION_BYTES` | `js-ts-tools` | Safely preview or apply `ts-pattern` conversions | Sync | Yes | Optional with `write: true` | No |
| `tsquery` query | `collectMatches` | `js-ts-tools` | Query a TypeScript project with TSQuery selectors | Sync | Yes | No | No |
| `tsquery` CLI compatibility | `parseArgs`, `run`, `main`, `applyTextEdits`, `coalesceDeleteEdits`, `globToRegExp` | `js-ts-tools` | Parse CLI-style options, emit formatted output, and optionally mutate files | Sync | Yes | Optional output/source writes | No |
| `json-jspath` | `applyJSPath`, `applyJSPathToFiles`, `applyJSPathToFilesStream`, `forEachJSPathInFiles`, `findJsonFiles`, `readJsonFile`, `streamJSPathFromFile` | `js-ts-tools/dist/tools/json-jspath` | Apply JSPath expressions to objects or JSON files | Sync for loaded objects, async for files | Yes for file helpers | No | No |

<a id="conventions"></a>

## Conventions

Programmatic APIs use JavaScript option objects rather than CLI flags. Most option names directly mirror CLI concepts:

| CLI concept | Programmatic option |
| --- | --- |
| `--source` | `sourceGlob`, `sourceGlobs`, or `sources` |
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
| Errors | Library-style APIs throw `Error`. `generateTypeDeclarationsFromModel` can throw `ExactDeclarationUnavailableError`. CLI compatibility entrypoints such as `main` catch and convert errors to exit statuses. |
| Results | Analysis functions return the same report objects the CLI serializes. Formatter helpers return strings, usually with one trailing newline. |
| Locations | Line and column values are 1-based. AST offsets in `tsquery` and `ast-xpath` reports are zero-based UTF-16 offsets, matching TypeScript compiler APIs. |
| Sync/async | Most TypeScript analysis APIs are synchronous. Save helpers, GitHub search, and JSON-file helpers are asynchronous where filesystem or network work requires it. |
| Mutations | APIs with `write: true` or explicit write helpers are the only APIs that intentionally modify files. Dry-run is the default for `convertTsPattern` and `tsquery.run` mutations. |

<a id="path-resolution"></a>

## Path Resolution

| Path kind | Behavior |
| --- | --- |
| `cwd` options | APIs that accept `cwd` resolve it to an absolute directory and default to `process.cwd()`. |
| `tsConfigFilePath` with `cwd` | `context-pack`, `code-impact`, `code-slice`, `type-model`, `convert-ts-pattern`, and `ast-xpath` resolve relative tsconfig paths from `cwd`. |
| `tsconfig` in `tsquery` | `collectMatches`, `run`, and `parseArgs` use the positional `cwd` parameter, defaulting to `process.cwd()`. |
| Source globs | `type-model`, `convert-ts-pattern`, `tsquery`, and `json-jspath` evaluate relative globs from `cwd`. `context-pack`, `code-impact`, `code-slice`, `code-patterns`, and `code-graph` pass source globs to the underlying `ts-morph` project as given; use absolute globs when calling from a different working directory. |
| Target paths | `code-impact`, `code-slice`, and `context-pack` resolve `filePath`, `at.filePath`, and seed file paths from `cwd`. |
| Documentation and config paths | `context-pack` resolves `docGlobs` and `configFilePaths` from `cwd`. `taskFilePath` is metadata only; read the task file yourself and pass its text as `task`. |
| `collect-types` source path | `sourceFilePath` resolves from the selected tsconfig directory when it is relative. |
| Write helpers without `cwd` | `saveAssociatedTypes`, `saveTypeDeclarationsFromModel`, `writeStructureFile`, and `createStructure` resolve output paths from `process.cwd()` through `path.resolve`. |
| Source locations | `line` and `column` are 1-based. `startOffset` and `endOffset` values are zero-based UTF-16 offsets. |

<a id="shared-types"></a>

## Shared Types

The signatures below use these recurring types. This is a compact reference; root-exported report types contain additional nested details.

```ts
type ImpactDirection = "incoming" | "outgoing" | "both";

type ContextPackSeed =
  | { kind: "symbol"; symbol: string; filePath?: string }
  | { kind: "file"; filePath: string }
  | { kind: "location"; location: CodeSliceLocation };

interface CodeSliceLocation {
  filePath: string;
  line: number;
  column?: number;
}

type PatternKey = (typeof patternKeys)[number];

interface PatternDetectorConfig {
  graphMaxDepth: number;
  graphMaxRecordsPerTraversal: number;
  graphScoreCapPerPattern: number;
  callGraphMaxDepth: number;
  callGraphMaxCallsPerTraversal: number;
  callGraphScoreCapPerPattern: number;
  includeTestFiles: boolean;
  includeDeclarationFiles: boolean;
  confidenceThresholds: { low: number; medium: number; high: number };
}

type AstXPathPattern = AstXPathPatternV1 | AstXPathPatternV2;

type AstXPathPatternV1 = Omit<
  AstXPathPatternV2,
  "schemaVersion" | "template" | "semantics" | "semanticPolicy"
> & {
  schemaVersion: 1;
  semanticPolicy: {
    automatic: true;
    mode: "binding-aware-exact";
    typeRelation: "mutually-assignable";
  };
};

interface AstXPathLocation {
  line: number;
  column: number;
}

interface AstXPathRange {
  startOffset: number;
  endOffset: number;
  start: AstXPathLocation;
  end: AstXPathLocation;
}

interface AstXPathIgnoredRange extends AstXPathRange {
  marker: "single" | "paired";
}

interface AstXPathDiagnostic {
  code:
    | "unresolved-symbol"
    | "unresolved-signature"
    | "unportable-type"
    | "unportable-symbol"
    | "unportable-signature";
  message: string;
  kind: string;
  range: AstXPathRange;
}

interface AstXPathPatternV2 {
  schemaVersion: 2;
  xmlSchemaVersion: 1;
  xpathVersion: "3.1";
  strictness: "exact" | "shape";
  project: {
    tsconfigPath: string;
    tsconfigSha256: string;
    compilerOptionsSha256: string;
    typescriptVersion: string;
  };
  example: {
    filePath: string;
    sourceSha256: string;
    root: AstXPathRange & { kind: string };
  };
  ignored: AstXPathIgnoredRange[];
  xpath: string;
  template: AstXPathTemplateNode;
  semantics: Record<string, AstXPathSemanticFact>;
  semanticPolicy: {
    automatic: true;
    mode: "portable-binding-aware";
    typeRelation: "mutually-assignable";
    unavailable: "structural";
  };
  diagnostics: AstXPathDiagnostic[];
}

interface AstXPathTemplateNode {
  kind: "node";
  id: string;
  syntaxKind: string;
  value?: string;
  fields: AstXPathTemplateField[];
}

interface AstXPathTemplateField {
  name: string;
  collection: boolean;
  unconstrained?: true;
  children: Array<AstXPathTemplateNode | { kind: "gap" }>;
}

interface AstXPathSemanticFact {
  binding?: unknown;
  typeText?: string;
  signature?: unknown;
}

type ProjectStructure = Record<string, ProjectStructureValue>;
type ProjectStructureValue = ProjectStructure | string | number | boolean | null;

type MutationAction =
  | { kind: "delete" }
  | { kind: "insert-before"; text: string }
  | { kind: "insert-after"; text: string };

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}
```

`PatternKey` values include the `pattern.` prefix, for example `"pattern.repository"`. Use the exported `patternKeys` value to enumerate the supported values at runtime.

`AstXPathPattern` is exported from the root package. Version 1 patterns are legacy and project-anchored; version 2 patterns are portable and use the shape shown above.

<a id="public-api-reference"></a>

## Public API Reference

The APIs in this section are imported from `js-ts-tools` and are the normal package API.

<a id="context-pack"></a>

### `context-pack`

Builds a bounded, task-focused context bundle.

**Use when:** assembling code, docs, config, and retrieval metadata for an LLM or review workflow.

> **Side effects:** Reads selected source files, tests, repository instruction files, docs, and config files.
> **Network:** None.

#### Signature

```ts
function createContextPack(options: CreateContextPackOptions): ContextPackReport;
function formatContextPack(
  report: ContextPackReport,
  options?: FormatContextPackOptions,
): string;
function estimateContextPackTokens(report: ContextPackReport): number;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `task` | `string` | Required | Non-empty task text used to rank automatic seeds and docs. |
| `taskFilePath` | `string` | `undefined` | Metadata copied into the report. The function does not read this file. |
| `sourceGlob` | `string \| string[]` | Required | Source files to analyze. |
| `testSourceGlob` | `string \| string[]` | `[]` | Additional test files to include and mark as tests. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude files whose paths contain any fragment. |
| `seeds` | `readonly ContextPackSeed[]` | `[]` | Explicit symbol, file, or location seeds. |
| `docGlobs` | `readonly string[]` | `[]` | Extra documentation globs. |
| `configFilePaths` | `readonly string[]` | `[]` | Extra config files to include. |
| `maxSeeds` | `number` | `5` | Maximum automatic seeds. |
| `direction` | `ImpactDirection` | `"both"` | Dependency traversal direction. |
| `maxDepth` | `number` | `2` | Maximum dependency depth. |
| `maxNodes` | `number` | `100` | Maximum traversed dependency nodes. |
| `maxTokens` | `number` | `12000` | Approximate output budget. |
| `cwd` | `string` | `process.cwd()` | Base directory for supported relative paths. |

`FormatContextPackOptions` has `format?: "markdown" | "json"` with default `"markdown"`, and `pretty?: boolean` with default `false`. `pretty` is valid only for JSON output.

#### Returns

`ContextPackReport`

| Field | Description |
| --- | --- |
| `query` | Normalized source, test, tsconfig, seed, traversal, and budget settings. |
| `task` | Task text used for retrieval. |
| `terms` | Search terms extracted from `task`. |
| `seeds` | Explicit and automatic ranked seeds. |
| `instructions` | Repository instruction chunks such as `AGENTS.md`, `CLAUDE.md`, and Copilot instructions. |
| `documentation` | Documentation chunks from default and explicit doc paths. |
| `configuration` | Config chunks, including tsconfig and package files. |
| `code` | Embedded `CodeSliceReport`. |
| `omitted` | Code or documentation omitted because of budget. |
| `summary` | Token estimate, counts, and truncation metadata. |

#### Errors

- Throws when `task` is empty or `sourceGlob` is missing.
- Throws when `direction`, bounds, seed shapes, or location values are invalid.
- Throws when source globs match no files, explicit doc globs match no docs, explicit config files are missing or excluded, target seeds cannot be resolved, or a symbol is ambiguous.
- Throws when mandatory context exceeds `maxTokens`.
- `formatContextPack` throws for invalid formats or `pretty` with Markdown.

#### Path Resolution

Relative `tsConfigFilePath`, seed paths, `docGlobs`, and `configFilePaths` resolve from `cwd`. `taskFilePath` is not read; pass the file contents as `task`.

<a id="code-impact"></a>

### `code-impact`

Finds the transitive impact radius of a symbol, a file, or a symbol narrowed to a file.

**Use when:** determining what code and tests may be affected by a change.

> **Side effects:** Filesystem reads only.
> **Network:** None.

#### Signature

```ts
function analyzeCodeImpact(options: AnalyzeCodeImpactOptions): ImpactReport;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceGlob` | `string \| string[]` | Required | Source files to analyze. |
| `testSourceGlob` | `string \| string[]` | `[]` | Additional test files to include and mark as tests. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude files whose paths contain any fragment. |
| `symbol` | `string` | `undefined` | Simple or qualified target symbol. Required unless `filePath` is supplied. |
| `filePath` | `string` | `undefined` | Target file. Required unless `symbol` is supplied. |
| `direction` | `ImpactDirection` | `"both"` | Dependency traversal direction. |
| `maxDepth` | `number` | `3` | Maximum dependency depth. |
| `maxNodes` | `number` | `200` | Maximum impacted nodes before truncation. |
| `cwd` | `string` | `process.cwd()` | Base directory for supported relative paths. |

#### Returns

`ImpactReport`

| Field | Description |
| --- | --- |
| `query` | Normalized source, target, traversal, and limit settings. |
| `targets` | Resolved target declarations as `ImpactNode[]`. |
| `impacted` | Impacted nodes with distances, directions, relations, and paths. |
| `impactedTests` | Subset of `impacted` marked as tests. |
| `summary` | Counts for targets, impacted nodes, impacted tests, external nodes, and truncation. |

#### Errors

- Throws when no source glob is supplied.
- Throws when neither `symbol` nor `filePath` is supplied.
- Throws when `direction`, `maxDepth`, or `maxNodes` is invalid.
- Throws when source globs match no files, the target file is outside selected sources, no declarations are found in a file target, a symbol cannot be found, or a symbol is ambiguous.
- Project loading can throw for nonexistent or invalid tsconfig files.

#### Path Resolution

Relative `tsConfigFilePath` and `filePath` resolve from `cwd`. The returned `query.filePath` is absolute when supplied.

<a id="code-slice"></a>

### `code-slice`

Extracts a compact dependency-aware slice around a symbol, file, or source location.

**Use when:** collecting the smallest useful code context around a target.

> **Side effects:** Filesystem reads only.
> **Network:** None.

#### Signature

```ts
function createCodeSlice(options: CreateCodeSliceOptions): CodeSliceReport;
function formatCodeSlice(
  report: CodeSliceReport,
  options?: FormatCodeSliceOptions,
): string;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceGlob` | `string \| string[]` | Required | Source files to analyze. |
| `testSourceGlob` | `string \| string[]` | `[]` | Additional test files to include and mark as tests. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude files whose paths contain any fragment. |
| `symbol` | `string` | `undefined` | Simple or qualified target symbol. Use with optional `filePath`; cannot be combined with `at`. |
| `filePath` | `string` | `undefined` | Target file. Use alone, with `symbol`, or not at all when `at` is supplied. |
| `at` | `CodeSliceLocation` | `undefined` | Source location target. Cannot be combined with `symbol` or `filePath`. |
| `direction` | `ImpactDirection` | `"both"` | Dependency traversal direction. |
| `maxDepth` | `number` | `2` | Maximum dependency depth. |
| `maxNodes` | `number` | `50` | Maximum selected dependency nodes before truncation. |
| `cwd` | `string` | `process.cwd()` | Base directory for supported relative paths. |

`FormatCodeSliceOptions` has `format?: "json" | "markdown"` with default `"json"`, and `pretty?: boolean` with default `false`. `pretty` is valid only for JSON output.

#### Returns

`CodeSliceReport`

| Field | Description |
| --- | --- |
| `query` | Normalized source, target, traversal, and limit settings. |
| `targets` | Resolved target declarations. |
| `selections` | Included declarations with roles, distances, relations, paths, and snippet IDs. |
| `files` | Imports and snippets grouped by file. |
| `boundaries` | External or truncated boundary nodes. |
| `impactedTests` | Selected test nodes affected by the slice target. |
| `summary` | Target, selection, file, snippet, test, external, and truncation counts. |

#### Errors

- Throws when no source glob is supplied.
- Throws when no target is supplied, or when `at` is combined with `symbol` or `filePath`.
- Throws when `direction`, bounds, or `at` location values are invalid.
- Throws when source globs match no files, target files are outside selected sources, a location is outside the file, no sliceable declaration exists at a location, a symbol cannot be found, or a symbol is ambiguous.
- `formatCodeSlice` throws for invalid formats or `pretty` with Markdown.

#### Path Resolution

Relative `tsConfigFilePath`, `filePath`, and `at.filePath` resolve from `cwd`. The returned target file paths are normalized to absolute paths where the implementation resolves them.

<a id="code-patterns"></a>

### `code-patterns`

Detects architectural and design patterns from selected source files.

**Use when:** identifying repositories, services, controllers, mappers, retry policies, and similar design or architecture roles.

> **Side effects:** Filesystem reads only.
> **Network:** None.

#### Signature

```ts
const patternKeys: readonly PatternKey[];
function detectPatternsFromSources(
  options: DetectPatternsFromSourcesOptions,
): PatternDetection[];
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceGlob` | `string \| string[]` | Required | Source files to analyze. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude files whose paths contain any fragment. |
| `patterns` | `PatternKey[]` | All patterns | Restrict detections. Programmatic keys include the `pattern.` prefix. |
| `minConfidence` | `"low" \| "medium" \| "high"` | `"low"` | Minimum returned confidence. |
| `config` | `Partial<PatternDetectorConfig>` | Detector defaults | Tune graph traversal, call-graph traversal, test inclusion, declaration inclusion, and confidence thresholds. |

Important `PatternDetectorConfig` defaults:

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `includeTestFiles` | `boolean` | `false` | Include tests and mocks in detection candidates. |
| `includeDeclarationFiles` | `boolean` | `false` | Include `.d.ts` files. |
| `graphMaxDepth` | `number` | `2` | Definition-use graph traversal depth. |
| `graphMaxRecordsPerTraversal` | `number` | `50` | Definition-use records per traversal. |
| `graphScoreCapPerPattern` | `number` | `5` | Maximum definition-use score contribution per pattern. |
| `callGraphMaxDepth` | `number` | `2` | Call graph traversal depth. |
| `callGraphMaxCallsPerTraversal` | `number` | `50` | Calls per call-graph traversal. |
| `callGraphScoreCapPerPattern` | `number` | `4` | Maximum call-graph score contribution per pattern. |
| `confidenceThresholds` | `{ low: number; medium: number; high: number }` | `{ low: 1, medium: 4, high: 7 }` | Score thresholds for confidence labels. |

#### Returns

`PatternDetection[]`

| Field | Description |
| --- | --- |
| `pattern` | Detected `PatternKey`. |
| `detected` | Whether the score met the low threshold. |
| `confidence` | `"low"`, `"medium"`, or `"high"`. |
| `mode` | `"primary"`, `"secondary"`, or `"supporting"`. |
| `score` | Numeric detector score. |
| `filePath`, `nodeKind`, `nodeName`, `startLine`, `endLine` | Source location and node identity. |
| `evidence`, `matchedRules` | Human-readable detector evidence. |
| `graphEvidence`, `callGraphEvidence` | Dependency and call-graph evidence. |
| `intersectingPatterns`, `intersectionEvidence` | Related pattern metadata. |

#### Errors

- Throws when no source files match the requested source globs.
- Project loading can throw for nonexistent or invalid tsconfig files.
- Graph builders used internally can throw TypeScript or filesystem errors from `ts-morph`.

#### Path Resolution

This API does not accept `cwd`. Relative `tsConfigFilePath` and `sourceGlob` values are passed to the underlying TypeScript project from the process working directory. Use absolute paths if the caller runs from a different directory.

<a id="type-model"></a>

### `type-model`

Extracts a normalized semantic TypeScript model and optionally generates declaration text.

**Use when:** exporting the TypeScript checker's resolved symbols, types, signatures, call sites, and declaration bundles.

> **Side effects:** `extractTypeModel` reads project files. `saveTypeDeclarationsFromModel` writes a declaration file and creates parent directories.
> **Network:** None.

#### Signature

```ts
function extractTypeModel(
  options: ExtractTypeModelOptions & { includeDeclarationBundles: true },
): TypeModelV3;
function extractTypeModel(
  options: ExtractTypeModelOptions & { includeDeclarationBundles?: false },
): TypeModelV2;
function extractTypeModel(options: ExtractTypeModelOptions): TypeModel;

function generateTypeDeclarationsFromModel(
  model: TypeModel,
  options?: GenerateTypeDeclarationsOptions,
): GeneratedTypeDeclarations;

function saveTypeDeclarationsFromModel(
  model: TypeModel,
  outputFilePath: string,
  options?: GenerateTypeDeclarationsOptions,
): Promise<SavedTypeDeclarations>;
```

#### Example

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

#### Options

`ExtractTypeModelOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceGlob` | `string \| string[]` | Required | Source files to model. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude files whose paths contain any fragment. |
| `scope` | `"exports" \| "all"` | `"exports"` | Root exported symbols only, or all top-level symbols. |
| `includeCallSites` | `boolean` | `false` | Include resolved call-like expressions. |
| `includeDeclarationBundles` | `boolean` | `false` | Include compiler-derived `.d.ts` bundles and return schema version `3`. |
| `sourceTextOverrides` | `ReadonlyMap<string, string>` | None | Analyze replacement text for existing project files without writing. Paths resolve against `cwd`; cannot be combined with declaration bundles. |
| `cwd` | `string` | `process.cwd()` | Base directory for relative tsconfig and source-glob resolution. |

`GenerateTypeDeclarationsOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `module` | `string` | Required for multi-module models | Exact module ID or modeled file path. |
| `banner` | `string \| false` | `"/* Generated from type-model. */"` | Banner prepended to generated declaration text. Use `false` to omit. |
| `structuralFallback` | `"allow"` | `undefined` | Permit lossy schema-v2 structural rendering when exact bundles are unavailable. |

#### Returns

`TypeModelV2`, `TypeModelV3`, `GeneratedTypeDeclarations`, or `SavedTypeDeclarations`

| Type | Fields |
| --- | --- |
| `TypeModel` | `schemaVersion`, `project`, `modules`, `roots`, `symbols`, `types`, `signatures`, `callSites`, and `diagnostics`. |
| `TypeModelV3` | Same as `TypeModelV2`, plus declaration bundles on modules when `includeDeclarationBundles: true`. |
| `GeneratedTypeDeclarations` | `text`, `moduleId`, `moduleFilePath`, `mode`, and `diagnostics`. |
| `SavedTypeDeclarations` | `GeneratedTypeDeclarations` plus `outputFilePath`. |

#### Errors

- `extractTypeModel` throws when `sourceGlob` is empty, `scope` is invalid, no source files match, or project loading fails.
- Declaration bundling failures are recorded as model diagnostics and failed bundles rather than thrown from `extractTypeModel`.
- `generateTypeDeclarationsFromModel` throws `ExactDeclarationUnavailableError` when exact bundle-backed declarations are unavailable and `structuralFallback` is not `"allow"`.
- `ExactDeclarationUnavailableError` includes `code: "exact-declaration-unavailable"`, `moduleId`, `schemaVersion`, and `bundleStatus`.
- `generateTypeDeclarationsFromModel` throws when a model contains multiple modules and no `module` is selected, when the selected module is ambiguous, or when the module cannot be found.
- `saveTypeDeclarationsFromModel` can reject for the same generation errors and for filesystem write failures.

#### Path Resolution

`extractTypeModel` resolves relative `tsConfigFilePath` and `sourceGlob` values from `cwd`. `saveTypeDeclarationsFromModel` resolves `outputFilePath` from `process.cwd()` and creates parent directories.

<a id="collect-types"></a>

### `collect-types`

Collects a dependency-first declaration closure for named type aliases, interfaces, and abstract classes.

**Use when:** emitting a self-contained type surface for a small set of exported types.

> **Side effects:** `collectAssociatedTypes` reads the TypeScript project. `saveAssociatedTypes` writes a file and creates parent directories.
> **Network:** None.

#### Signature

```ts
function collectAssociatedTypes(
  options: CollectAssociatedTypesOptions,
): CollectAssociatedTypesResult;

function formatAssociatedTypes(
  result: CollectAssociatedTypesResult,
  options?: SaveAssociatedTypesOptions,
): string;

function saveAssociatedTypes(
  result: CollectAssociatedTypesResult,
  outputFilePath: string,
  options?: SaveAssociatedTypesOptions,
): Promise<string>;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `names` | `readonly string[]` | Required | Root type aliases, interfaces, or abstract classes to collect. |
| `tsConfigFilePath` | `string` | Required | TypeScript project config. |
| `sourceFilePath` | `string` | Required | File that declares or exports the requested roots. |
| `includeNodeModules` | `boolean` | `true` | Include declarations from `node_modules`. |
| `includeTypeScriptLibs` | `boolean` | `false` | Include TypeScript standard library declarations. Usually keep this false. |

`SaveAssociatedTypesOptions` has `banner?: string` with default `undefined`.

#### Returns

| Function | Return |
| --- | --- |
| `collectAssociatedTypes` | `CollectAssociatedTypesResult` containing the `Project`, selected `SourceFile`, root declarations, and dependency-first `declarations`. |
| `formatAssociatedTypes` | TypeScript declaration text with an optional banner and trailing newline. |
| `saveAssociatedTypes` | A promise for the absolute output path string. |

#### Errors

- Throws when `names` is empty.
- Throws when the source file cannot be found.
- Throws when a requested root is missing, only available as a concrete class, or not a type alias, interface, or abstract class.
- Project loading can throw for nonexistent or invalid tsconfig files.
- `saveAssociatedTypes` can reject for filesystem write failures.

#### Path Resolution

`tsConfigFilePath` resolves from `process.cwd()`. Relative `sourceFilePath` resolves from the selected tsconfig directory. `saveAssociatedTypes` resolves `outputFilePath` from `process.cwd()`.

<a id="create-project"></a>

### `create-project`

Creates a blank project structure from JSON-like data or extracts a structure from an existing directory.

**Use when:** generating or snapshotting directory skeletons.

> **Side effects:** `createStructure`, `createFromJsonFile`, and `writeStructureFile` write files. `extractStructure` and `readStructureFile` read files.
> **Network:** None.

#### Signature

```ts
function extractStructure(
  projectDir: string,
  options?: ExtractStructureOptions,
): ProjectStructure;

function createStructure(
  structure: ProjectStructure,
  baseDir: string,
  options?: CreateStructureOptions,
): void;

function readStructureFile(jsonPath: string): ProjectStructure;

function createFromJsonFile(
  jsonPath: string,
  outputDir?: string,
  options?: CreateStructureOptions,
): CreateFromJsonFileResult;

function structureToJson(structure: ProjectStructure): string;

function writeStructureFile(
  projectDir: string,
  outputJsonPath: string,
  options?: ExtractStructureOptions,
): WriteStructureFileResult;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `ExtractStructureOptions.ignore` | `readonly string[] \| Set<string>` | `DEFAULT_IGNORE` | Directory or file names skipped while extracting. Default is `node_modules`, `.git`, and `.DS_Store`. |
| `CreateStructureOptions.overwriteFiles` | `boolean` | `false` | Replace existing files with blank files when creating. |
| `createFromJsonFile.outputDir` | `string` | `process.cwd()` | Directory to create. |

File values in `ProjectStructure` are markers only. Created files are blank regardless of marker value.

#### Returns

| Function | Return |
| --- | --- |
| `extractStructure` | `ProjectStructure`, with files represented as empty strings. |
| `createStructure` | `void`. |
| `readStructureFile` | Parsed `ProjectStructure`. |
| `createFromJsonFile` | `{ outputDir: string; structure: ProjectStructure }`. |
| `structureToJson` | Pretty JSON text with trailing newline. |
| `writeStructureFile` | `{ outputPath: string; structure: ProjectStructure; json: string }`. |

#### Errors

- Throws when a structure is not a JSON object.
- Throws for invalid names, `.` or `..`, NUL bytes, and paths that would escape the base directory.
- Throws when `extractStructure` receives a missing path or non-directory path.
- Throws when `ignore` is not an array or `Set`.
- `readStructureFile` can throw JSON parse and filesystem read errors.
- Writer functions can throw filesystem write errors.

#### Path Resolution

All paths are resolved with `path.resolve` from `process.cwd()` unless already absolute.

<a id="code-graph"></a>

### `code-graph`

Builds structural and semantic graphs from source files.

**Use when:** inspecting lower-level graph data behind impact, slice, and pattern analysis.

> **Side effects:** Filesystem reads only.
> **Network:** None.

#### Signature

```ts
function buildGraphs(
  sourceOptions: SourceOptions,
  options: TargetOptions,
): BuildGraphsResult;

type BuildGraphsResult =
  | {
      structureForest: false | StructureTreeFile[] | undefined;
      callGraph: false | SerializedCallGraphNode[] | undefined;
      ownerReferenceGraph: false | SerializedReferenceGraphNode[] | undefined;
      definitionUseGraph: false | DefinitionUseRecord[] | undefined;
    }
  | {
      structureForest: false | StructureTreeFile[] | undefined;
      callGraph: false | CallGraph | undefined;
      ownerReferenceGraph: false | ReferenceGraph | undefined;
      definitionUseGraph: false | DefinitionUseGraph | undefined;
    };
```

#### Example

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

#### Options

`SourceOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceGlob` | `string \| string[]` | Required | Source files to analyze. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | Built-in graph exclusions | Additional path fragments to exclude. Built-ins exclude `node_modules` and this analyzer project. |

`TargetOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `includeStructureForest` | `boolean` | `false` | Include AST structure forest. |
| `includeCallGraph` | `boolean` | `false` | Include call graph. |
| `includeOwnerReferenceGraph` | `boolean` | `false` | Include owner-reference graph. |
| `includeDefinitionUseGraph` | `boolean` | `false` | Include definition-use graph. |
| `toJson` | `boolean` | `false` | Return JSON-safe graph data instead of internal `Map`-based graphs. |

Deprecated aliases `structureForestHuh`, `callGraphHuh`, `ownerUseGraphHuh`, and `definitionUseGraphHuh` are still accepted but should not be used in new code.

#### Returns

`BuildGraphsResult`

| Field | Description |
| --- | --- |
| `structureForest` | `StructureTreeFile[]`, `false`, or `undefined` depending on inclusion. |
| `callGraph` | Serialized call graph when `toJson: true`, otherwise internal `CallGraph`. |
| `ownerReferenceGraph` | Serialized owner-reference graph when `toJson: true`, otherwise internal `ReferenceGraph`. |
| `definitionUseGraph` | Serialized definition-use records when `toJson: true`, otherwise internal `DefinitionUseGraph`. |

#### Errors

- Project loading can throw for nonexistent or invalid tsconfig files.
- TypeScript and `ts-morph` can throw while parsing or resolving selected source files.

#### Path Resolution

This API does not accept `cwd`. Relative `tsConfigFilePath` and `sourceGlob` values are passed to the underlying graph builders from the process working directory. Use absolute paths if the caller runs from a different directory.

<a id="github-js-ts-search"></a>

### `github-js-ts-search`

Parses local source text for package imports or searches GitHub and saves matching blobs.

**Use when:** distinguishing pure local import parsing from corpus collection through GitHub code search.

> **Side effects:** `findPackageReferences` and `importsAnyPackage` are pure. `searchGitHubPackageImports` writes downloaded source files and `manifest.json`.
> **Network:** `searchGitHubPackageImports` calls the GitHub API with the supplied token.

#### Signature

```ts
function findPackageReferences(
  source: string,
  packages: readonly string[],
  fileName?: string,
): PackageReference[];

function importsAnyPackage(
  source: string,
  packages: readonly string[],
  fileName?: string,
): boolean;

function searchGitHubPackageImports(
  options: SearchGitHubPackageImportsOptions,
): Promise<GitHubPackageImportSearchReport>;
```

#### Example

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

#### Options

`searchGitHubPackageImports`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `packages` | `readonly string[]` | Required | npm package names to search for. |
| `token` | `string` | Required | GitHub access token. |
| `outputDirectory` | `string` | `"downloads"` | Directory that receives `files/...` and `manifest.json`. |
| `signal` | `AbortSignal` | `undefined` | Abort in-flight API requests and sleeps. |
| `maxAttempts` | `number` | `5` | Maximum attempts per GitHub request. Values above `5` are rejected. |
| `requestTimeoutMs` | `number` | `30000` | Per-request timeout in milliseconds. |

`findPackageReferences` defaults `fileName` to `"source.ts"` and uses it only for parser mode selection and diagnostics.

#### Returns

| Type | Fields |
| --- | --- |
| `PackageReference` | `packageName`, `specifier`, and `kind`, where kind is `"import"`, `"import-type"`, `"import-equals"`, or `"require"`. |
| `GitHubPackageImportSearchReport` | `schemaVersion`, `githubApiVersion`, `completedAt`, `packages`, `outputDirectory`, `manifestPath`, `candidateCount`, `savedFileCount`, `hasIncompleteQueries`, `queries`, and `matches`. |
| `GitHubPackageImportMatch` | `repository`, `path`, `sha`, `outputPath`, and `references`. |

Recognized local references include static imports, type-only imports, `import = require`, and direct `require("pkg")` calls. Dynamic imports and re-exports are ignored.

#### Errors

- Throws for empty, non-string, or invalid npm package names.
- `searchGitHubPackageImports` throws when `token` is empty, `outputDirectory` is empty, retry options are invalid, GitHub returns malformed data, or GitHub requests fail after retries.
- `searchGitHubPackageImports` throws or rejects when aborted through `signal`.
- Filesystem writes can reject for permission, disk, or path errors.

#### Path Resolution

`searchGitHubPackageImports` resolves `outputDirectory` from `process.cwd()` and writes absolute `outputDirectory` and `manifestPath` values in the report.

<a id="ast-xpath"></a>

### `ast-xpath`

Generates portable XPath 3.1 patterns from a marked TypeScript example and matches them against a target project.

**Use when:** finding AST shapes with optional binding-aware semantic checks.

> **Side effects:** Filesystem reads only.
> **Network:** None.

#### Signature

```ts
import type { Node as MorphNode } from "ts-morph";

function serializeAstToXml(node: MorphNode): string;

function generateAstXPathPattern(
  options: GenerateAstXPathPatternOptions,
): GeneratedAstXPathPattern;

function matchAstXPathPattern(
  options: MatchAstXPathPatternOptions,
): AstXPathMatchReport;

function runAstXPath(
  options: RunAstXPathOptions,
): AstXPathMatchReport & { xml: string };

function readAstXPathPattern(filePath: string): AstXPathPattern;
```

#### Example

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

#### Options

`GenerateAstXPathPatternOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `exampleFilePath` | `string` | Required | Source file containing exactly one `/* ast-xpath-root */` marker. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config for the example. |
| `cwd` | `string` | `process.cwd()` | Base directory for relative paths. |
| `strictness` | `"exact" \| "shape"` | `"exact"` | Whether values and exact shape must match, or only broad shape. |

`MatchAstXPathPatternOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `pattern` | `AstXPathPattern` | Required | Pattern object to validate and match. |
| `cwd` | `string` | `process.cwd()` | Base directory for relative paths. |
| `targetTsConfigFilePath` | `string` | `"tsconfig.json"` for v2 patterns | TypeScript project config for matching. Version 1 patterns are anchored to their original config. |
| `semanticMode` | `"strict" \| "structural"` | `"strict"` behavior when omitted | `"structural"` skips strict binding/type equivalence checks. |
| `sourceGlobs` | `string[]` | `[]` | Restrict target project files. Empty means all project source files after built-in filtering. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude paths containing any fragment. |
| `includeDeclarations` | `boolean` | `false` | Include declaration files in matching. |

`RunAstXPathOptions` combines generate and match options. `runAstXPath` uses `targetTsConfigFilePath ?? tsConfigFilePath` for matching.

#### Returns

| Type | Fields |
| --- | --- |
| `GeneratedAstXPathPattern` | `{ pattern: AstXPathPatternV2; xml: string }`. |
| `AstXPathMatchReport` | `pattern`, `matches`, and `summary`. |
| `AstXPathMatch` | `filePath`, `kind`, `start`, `end`, `startOffset`, `endOffset`, and `text`. |
| `AstXPathMatchSummary` | `filesScanned`, `xpathCandidates`, `semanticRejected`, and `matches`. |
| `runAstXPath` return | `AstXPathMatchReport` plus generated `xml`. |

#### Errors

- `generateAstXPathPattern` throws when the tsconfig or example file is missing, the root marker count is not exactly one, markers are malformed, or the generated XPath fails to select the marked root.
- `matchAstXPathPattern` throws for invalid semantic modes, invalid pattern objects, unsupported pattern versions, TypeScript version drift, missing target tsconfig, hash mismatches for legacy patterns, malformed XPath, or invalid portable semantic facts.
- Version 1 patterns throw when matched against a different target tsconfig.
- `readAstXPathPattern` can throw JSON parse, filesystem read, and pattern validation errors.

#### Path Resolution

Relative example, pattern, source-glob, and tsconfig paths resolve from `cwd` where the option accepts `cwd`. `readAstXPathPattern` resolves its path from `process.cwd()`.

<a id="convert-ts-pattern"></a>

### `convert-ts-pattern`

Conservatively rewrites supported conditionals to `ts-pattern`. Dry-run is the default.

**Use when:** previewing or applying mechanically validated `ts-pattern` conversions.

> **Side effects:** Reads the TypeScript project. Writes selected source files only when `write: true` and at least one conversion is accepted.
> **Network:** None.

#### Signature

```ts
const DEFAULT_MAX_CONTINUATION_BYTES: number;
function convertTsPattern(
  options: ConvertTsPatternOptions,
): TsPatternConversionReport;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sourceGlob` | `string \| string[]` | Required | TypeScript source files to inspect. Declaration files are skipped. |
| `tsConfigFilePath` | `string` | `"tsconfig.json"` | TypeScript project config. |
| `excludePathIncludes` | `string[]` | `[]` | Exclude files whose absolute or relative paths contain any fragment. |
| `cwd` | `string` | `process.cwd()` | Base directory for relative paths and globs. |
| `write` | `boolean` | `false` | Apply accepted edits. Dry-run reports planned changes without writing. |
| `maxContinuationBytes` | `number` | `16384` | Per-file limit for duplicated continuation bytes. |

#### Returns

`TsPatternConversionReport`

| Field | Description |
| --- | --- |
| `query` | Normalized source globs, tsconfig path, exclusions, continuation limit, and mode. |
| `written` | Whether source files were written. |
| `files` | File reports containing candidate records and `changed` flags. |
| `summary` | Candidate, converted, skipped, and changed-file counts. |

Candidate records include locations, kind, subject/discriminator information, action, terminator/fallback details for conversions, and reason/diagnostics for skips.

#### Errors

- Throws when `sourceGlob` is missing, `maxContinuationBytes` is invalid, tsconfig is missing or invalid, no matched files belong to the configured project, or no files match the source glob.
- Throws if accepted conversions introduce new diagnostics or an internal validation invariant fails.
- Throws before writing if any source file bytes changed after edit planning.
- The target project must already resolve `ts-pattern`; accepted conversions must not introduce new TypeScript diagnostics.

#### Path Resolution

Relative `tsConfigFilePath` and `sourceGlob` values resolve from `cwd`. Report paths are displayed relative to `cwd` where possible.

<a id="cli-compatibility-apis"></a>

## CLI Compatibility APIs

The APIs in this section preserve CLI behavior. They may emit output, return numeric statuses, or expose lower-level helpers.

<a id="tsquery"></a>

### `tsquery`

Queries or mutates a TypeScript project with TSQuery selectors.

**Use when:** `collectMatches` fits a conventional library call, or `run` is needed for CLI-compatible formatting, output, exit statuses, and optional mutations.

> **Side effects:** `collectMatches`, `applyTextEdits`, and `coalesceDeleteEdits` do not write files. `run` writes to stdout unless `out` is set, writes `out` when provided, and can mutate source files when `write: true` with `mutation`.
> **Network:** None.

`run`, `main`, and `parseArgs` are CLI compatibility APIs. Prefer `collectMatches` for ordinary library usage.

#### Signature

```ts
import type * as ts from "typescript";

function parseArgs(argv: string[], cwd?: string): CliOptions | { help: true };
function collectMatches(
  options: CliOptions,
  cwd?: string,
): Array<{ sourceFile: ts.SourceFile; node: ts.Node; record: MatchRecord }>;
function run(options: CliOptions, cwd?: string): number;
function main(argv?: string[], cwd?: string): number;
function applyTextEdits(source: string, edits: TextEdit[]): string;
function coalesceDeleteEdits(edits: TextEdit[]): TextEdit[];
function globToRegExp(glob: string): RegExp;
```

#### Example

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

#### Options

`CliOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `selector` | `string` | Required | TSQuery selector. |
| `tsconfig` | `string` | Required in object form, `"tsconfig.json"` from `parseArgs` | TypeScript project config. |
| `sources` | `string[]` | Required in object form, `[]` from `parseArgs` | Restrict selected project files. Empty means all non-`node_modules` project source files. |
| `excludes` | `string[]` | Required in object form, `[]` from `parseArgs` | Exclude paths containing any fragment. |
| `includeDeclarations` | `boolean` | Required in object form, `false` from `parseArgs` | Include declaration files. |
| `format` | `"json" \| "text"` | Required in object form, `"json"` from `parseArgs` | Output format used by `run`. |
| `pretty` | `boolean` | Required in object form, `false` from `parseArgs` | Pretty-print JSON output. |
| `out` | `string` | `undefined` | Output file for `run`; stdout is used when omitted. |
| `failEmpty` | `boolean` | Required in object form, `false` from `parseArgs` | `run` returns `2` when there are no matches. |
| `write` | `boolean` | Required in object form, `false` from `parseArgs` | Apply `mutation` edits to source files. |
| `mutation` | `MutationAction` | `undefined` | Optional delete, insert-before, or insert-after mutation. |

#### Returns

| Function | Return |
| --- | --- |
| `parseArgs` | `CliOptions` or `{ help: true }`. |
| `collectMatches` | Array of internal matches containing the TypeScript `sourceFile`, matched `node`, and serializable `record`. |
| `run` | `0` for success, or `2` when no matches are found and `failEmpty` is true. It throws rather than returning `1`; `main` catches and returns `1`. |
| `main` | CLI-style numeric exit status. |
| `applyTextEdits` | Edited source text. |
| `coalesceDeleteEdits` | Sorted delete edits with overlaps merged. |
| `globToRegExp` | Regular expression used by the CLI compatibility selection logic. |

`MatchRecord` contains `filePath`, `kind`, `start`, `end`, `startOffset`, `endOffset`, and `text`.

#### Errors

- `parseArgs` throws for missing option values, unknown options, duplicate positional selectors, mutually exclusive mutations, invalid formats, empty snippet files, `--pretty` with non-JSON output, or `--write` without mutation.
- `collectMatches` throws for invalid selectors, missing tsconfig, or projects with no source files.
- `applyTextEdits` throws for invalid edit ranges.
- `run` throws if planned source bytes are stale before writing, or if `out` would overwrite a matched source file.
- `main` catches errors, writes to stderr, and returns `1`.

#### Path Resolution

The optional `cwd` parameter defaults to `process.cwd()`. `tsconfig`, source globs, snippet files from `parseArgs`, `out`, and displayed relative paths are resolved against that `cwd`.

<a id="implementation-dependent-subpath-apis"></a>

## Implementation-Dependent Subpath APIs

These APIs require build-layout imports and are not covered by the root package stability guarantee.

<a id="json-jspath"></a>

### `json-jspath`

Applies JSPath expressions to already-loaded JSON values or JSON files.

**Use when:** querying local JSON with accumulated results, streaming results, or per-match callbacks.

> **Stability:** Implementation-dependent import. These helpers are not re-exported from `js-ts-tools`, and there is no `package.json#exports` subpath for them. The `dist/...` path is not covered by normal package API stability guarantees.
> **Side effects:** File helpers read JSON files only.
> **Network:** None.

#### Import

```ts
import {
  applyJSPath,
  applyJSPathToFiles,
  applyJSPathToFilesStream,
  forEachJSPathInFiles,
} from "js-ts-tools/dist/tools/json-jspath";
```

#### Signature

```ts
function applyJSPath<T = unknown>(
  json: unknown,
  expression: string,
  options?: ApplyJSPathOptions,
): T[];

function readJsonFile(filePath: string): Promise<unknown>;

function findJsonFiles(
  patterns: string | string[],
  options?: FindJsonFilesOptions,
): Promise<string[]>;

function streamJSPathFromFile<T = unknown>(
  filePath: string,
  expression: string,
  options?: ApplyJSPathOptions,
): AsyncGenerator<T, void, void>;

function applyJSPathToFiles<T = unknown>(
  patterns: string | string[],
  expression: string,
  options?: ApplyJSPathToFilesOptions,
): Promise<ApplyJSPathToFilesResult<T>>;

function applyJSPathToFilesStream<T = unknown>(
  patterns: string | string[],
  expression: string,
  options?: ApplyJSPathToFilesStreamOptions,
): AsyncGenerator<T | FileResult<T>, void, void>;

function forEachJSPathInFiles<T = unknown>(
  patterns: string | string[],
  expression: string,
  onMatch: (match: T | FileResult<T>) => void | Promise<void>,
  options?: ForEachJSPathInFilesOptions,
): Promise<ForEachJSPathInFilesResult>;
```

#### Example

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

#### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `first` | `boolean` | `false` | Return or stream only the first match per input object or file. |
| `cwd` | `string` | `process.cwd()` | Base directory for file globs. |
| `absolute` | `boolean` | `false` | Return absolute file paths from `findJsonFiles` and use absolute `file` values in wrapped results. |
| `withFile` | `boolean` | `false` | Wrap each match as `{ file, value }`. |
| `continueOnError` | `boolean` | `false` | Continue after malformed or unreadable files. |
| `onError` | `(error: FileProcessingError) => void \| Promise<void>` | `undefined` | Streaming-only callback for file errors when continuing. |

#### Returns

| Type | Fields |
| --- | --- |
| `FileResult<T>` | `{ file: string; value: T }`. |
| `FileProcessingError` | `{ file: string; error: Error }`. |
| `ApplyJSPathToFilesResult<T>` | `{ results: Array<T \| FileResult<T>>; errors: FileProcessingError[] }`. |
| `ForEachJSPathInFilesResult` | `{ count: number; errors: FileProcessingError[] }`. |

Top-level JSON arrays are streamed item by item. The JSPath expression is applied independently to each array element. Other JSON documents are read and parsed as whole documents.

#### Errors

- `applyJSPath` can throw parser/runtime errors from the underlying `jspath` package.
- `readJsonFile` and `streamJSPathFromFile` throw `Invalid JSON in ...` for malformed JSON and can reject for filesystem read errors.
- `applyJSPathToFiles`, `applyJSPathToFilesStream`, and `forEachJSPathInFiles` throw on the first file error when `continueOnError` is false.
- With `continueOnError: true`, file errors are collected or reported through `onError` and processing continues.

#### Path Resolution

`findJsonFiles`, `applyJSPathToFiles`, `applyJSPathToFilesStream`, and `forEachJSPathInFiles` resolve relative globs from `cwd`. `readJsonFile` and `streamJSPathFromFile` use the path supplied by the caller.


<a id="conditional-to-effect-schema-v3"></a>

## `conditional-to-effect-schema-v3`

```ts
import { convertConditionalToEffectSchemaV3 } from "js-ts-tools";

const result = convertConditionalToEffectSchemaV3({
  cwd: "/path/to/project",
  sourceGlob: "src/**/*.ts",
  tsConfigFilePath: "tsconfig.json",
  target: "validateOrder",
  baseSchema: "OrderBase",
  mode: "auto",
});
console.log(result.code);
```

`ConvertConditionalToEffectSchemaV3Options` requires `target`, `baseSchema` and `sourceGlob` (a string or array). Optional fields are `schemaName`, `tsConfigFilePath`, `excludePathIncludes`, `cwd`, `mode` (default `static`), `maxCallDepth` (default `12`) and `allowOpaqueCalls` (default `false`). Paths resolve against `cwd` or the process working directory.

`ConvertConditionalToEffectSchemaV3Result` contains the chosen `mode`, resolved `target`, `schemaName`, generated `code`, `constraints` and `diagnostics`. Each `ThrowConstraint` contains success/failure predicates, a message, original throw expression, source file, line and call path. Each `ConversionDiagnostic` has a code, message and optional source location. These types and `ConversionMode` are exported from the package root.

See the [CLI semantics and limitations](CLI_API.md#conditional-to-effect-schema-v3) for supported static constructs, runtime fallback and the scope required by the generated snippet. Unsupported static conversions throw an error; use `mode: "auto"` to receive a wrapper and diagnostics instead where synchronous wrapping is possible.


<a id="effect-v3-codemod"></a>

## `effect-v3-codemod`

```ts
import { runEffectCodemod } from "js-ts-tools";
const report = runEffectCodemod({
  cwd: "/path/to/project",
  sources: ["src/**/*.ts"],
  targets: ["map", "asVoid"],
  write: false,
});
```

`EffectCodemodOptions` accepts `cwd`, `tsconfig`, `sources`, `excludes`, `targets`, `write`, `includeReview`, `maxPasses` (1–10, default 3) and `evidence` (`"compact"` by default, or `"full"`). The default target set covers all production rules. `EffectCodemodReport` contains candidate decisions, planned file replacements, summary counts, grouped skip reasons and validation diagnostics. Candidate records include source line and column, their input pass, reason codes and proof obligations. `passes` contains per-pass attempts; summary fields expose convergence and the stop reason. Failed validation returns `validation.ok: false` and prevents commit; argument and I/O errors throw.

Advanced consumers can use the `effectCodemod` namespace for the dependency-injected pipeline, registry, individual rules and adapters. See [Effect codemod](EFFECT_CODEMOD.md) for defaults, in-memory validation and supported transformations.

### Shared code analysis session

`createCodeAnalysisSession({ root, sources: [{ filePath, text }], compilerOptions? })`
creates one in-memory TypeScript project. Only supplied source files and bundled
TypeScript libraries resolve; callers control configuration and source inventory.
No candidate dependency installation, compiler plugins, or host filesystem reads
occur. `analysisTypeScript` exposes the compiler used by the session (which may
differ from the package's standalone TypeScript dependency).

Use `nodeAt({ filePath, start, end, sourceFile? })` with UTF-16 offsets and
`slice(range, { maxDepth: 2, maxNodes: 50 })` to select the enclosing declaration,
not the referenced callee. Source-file ranges select top-level declarations.
A range without a sliceable declaration returns no slice. Use selected/boundary
IDs with `graphs(ids)`, `patterns(ids)`, and `declaration(id)`; use `types(nodes)`
for targeted type extraction (`targetTypes` contains ordered type roots).
Graphs and pattern detections are cached within the session. `stats` exposes
project, graph construction, and pattern invocation counts for instrumentation.
Existing standalone APIs retain their behavior.

Reports and nodes may contain source and absolute paths. Consumers with metadata
retention requirements must normalize these before storage or transmission.

### Effect-schema refactor completion

The Effect-schema adapter previews the installed language-service plugin's
Structural Type to Schema refactor and validates the complete edited project
before applying it. Some plugin releases, including 0.87.2, emit schema classes
as insertions without deleting the selected interface/type alias or supplying
its runtime `Schema` import. The adapter completes those edits: a generated class
replaces its selected declaration, existing runtime import aliases are reused,
and missing/type-only/shadowed bindings receive a fresh runtime import. Generated
references alone are renamed; existing user code is preserved. Default exports,
leading comments, CRLF text, and original UTF-16 edit coordinates are retained.
The plugin remains responsible for schema generation, including reuse of existing
schemas. Apply checks project freshness and compiler validation before writing.
