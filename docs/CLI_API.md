# CLI API reference

`js-ts-tools` installs command-line tools for TypeScript analysis, context assembly, JSON querying, and project scaffolding. This document describes the command-line interface shipped in `bin/`.

## Contents

- [Installation](#installation)
- [Command index](#commands)
- [Choosing a command](#choosing-a-command)
- [Shared analysis concepts](#shared-analysis-concepts)
- [Command reference](#command-reference)
  - [`context-pack`](#context-pack)
  - [`code-impact`](#code-impact)
  - [`code-slice`](#code-slice)
  - [`code-patterns`](#code-patterns)
  - [`type-model`](#type-model)
  - [`collect-types`](#collect-types)
  - [`create-project`](#create-project)
  - [`code-graph`](#code-graph)
  - [`json-jspath`](#json-jspath)
  - [`github-js-ts-search`](#github-js-ts-search)
  - [`ast-xpath`](#ast-xpath)
  - [`tsquery`](#tsquery)
  - [`convert-ts-pattern`](#convert-ts-pattern)
  - [`conditional-to-effect-schema-v3`](#conditional-to-effect-schema-v3)
  - [`effect-v3-codemod`](#effect-v3-codemod)
- [Exit statuses](#exit-statuses)

<a id="installation"></a>

## Installation

Install the current checkout globally:

```bash
npm install -g .
```

For development, link the checkout instead:

```bash
npm run build
npm link
```

For path and glob rules used by the analysis commands, see [Source selection](#source-selection).

<a id="commands"></a>

## Command index

| Command | Purpose | Default output |
| --- | --- | --- |
| [`context-pack`](#context-pack) | Assemble task-focused code and documentation context | Markdown |
| [`code-impact`](#code-impact) | Find code and tests affected by a symbol or file | JSON |
| [`code-slice`](#code-slice) | Extract relevant declarations, imports, and dependency paths | JSON |
| [`code-patterns`](#code-patterns) | Detect architectural and design patterns | JSON |
| [`type-model`](#type-model) | Extract a normalized resolved TypeScript type graph | JSON |
| [`collect-types`](#collect-types) | Emit a self-contained declaration closure | TypeScript |
| [`create-project`](#create-project) | Create or extract a directory structure | Text or JSON |
| [`code-graph`](#code-graph) | Build structural and semantic code graphs | JSON |
| [`json-jspath`](#json-jspath) | Apply JSPath expressions to JSON files | JSON array |
| [`github-js-ts-search`](#github-js-ts-search) | Download GitHub files importing npm packages | Source snapshots and JSON manifest |
| [`ast-xpath`](#ast-xpath) | Generate and match XPath 3.1 patterns over TypeScript AST XML | JSON pattern or match report |
| [`tsquery`](#tsquery) | Query or mutate a TypeScript project with TSQuery selectors | JSON matches or mutation report |
| [`convert-ts-pattern`](#convert-ts-pattern) | Convert safe TypeScript conditionals to `ts-pattern` | JSON report |
| [`conditional-to-effect-schema-v3`](#conditional-to-effect-schema-v3) | Generate Effect v3 Schema filters from synchronous validators | TypeScript |
| [`effect-v3-codemod`](#effect-v3-codemod) | Convert proven TypeScript idioms to Effect v3 operators | JSON report |

<a id="choosing-a-command"></a>

## Choosing a command

| If you need to… | Use |
| --- | --- |
| Build a bounded context bundle for a task or LLM workflow | [`context-pack`](#context-pack) |
| Measure the transitive blast radius of a symbol or file | [`code-impact`](#code-impact) |
| Extract the smallest dependency-aware code slice around a target | [`code-slice`](#code-slice) |
| Detect architectural or design patterns | [`code-patterns`](#code-patterns) |
| Export the TypeScript checker's resolved semantic type model | [`type-model`](#type-model) |
| Emit a self-contained declaration closure for named types | [`collect-types`](#collect-types) |
| Create or extract a project directory skeleton | [`create-project`](#create-project) |
| Inspect structural, call, owner-reference, or definition-use graphs directly | [`code-graph`](#code-graph) |
| Query JSON files with JSPath | [`json-jspath`](#json-jspath) |
| Download GitHub source snapshots that import npm packages | [`github-js-ts-search`](#github-js-ts-search) |
| Generate a reusable AST pattern from an example and match it across projects | [`ast-xpath`](#ast-xpath) |
| Query or mutate AST nodes with selectors | [`tsquery`](#tsquery) |
| Preview or apply safe conversions to `ts-pattern` | [`convert-ts-pattern`](#convert-ts-pattern) |

<a id="shared-analysis-concepts"></a>

## Shared analysis concepts

Several analysis commands share the same source-selection, target, and traversal vocabulary. Command-specific options override these general rules where noted.

<a id="source-selection"></a>

### Source selection

Analysis commands accept one or more quoted source globs. All paths and globs are resolved from the current working directory unless a command says otherwise. Quote globs so the command, rather than the shell, expands them.

<a id="target-selection"></a>

### Symbols, files, and locations

A symbol can be a simple name such as `execute` or a qualified name such as `OrderService.execute`. When a name is ambiguous, commands that support both options can combine `--symbol` with a `--file` path.

Locations use 1-based lines and columns:

```text
path/to/file.ts:line[:column]
```

<a id="traversal-direction"></a>

### Traversal direction

- `incoming`: code that calls, references, or otherwise depends on the target.
- `outgoing`: code used by the target.
- `both`: traverse in both directions.

<a id="relationship-types"></a>

### Relationship types

The analysis tools recognize call, reference, initialization, assignment, and read relationships. Results can include external symbols and test declarations. For direct access to the underlying graph representations, see [`code-graph`](#code-graph).

For process exit behavior shared by multiple commands, see [Exit statuses](#exit-statuses).

<a id="command-reference"></a>

## Command reference

<a id="context-pack"></a>

### `context-pack`

Builds a bounded, task-focused bundle containing instructions, documentation, configuration, code snippets, dependency paths, supporting types, and affected tests. Explicit seeds are optional; without them, declarations are ranked from the task text.

**Related:** [`code-slice`](#code-slice) for a focused extract; [`code-impact`](#code-impact) for blast-radius analysis.

#### Syntax

```text
context-pack --source <glob> (--task <text> | --task-file <path>) [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required [source glob](#source-selection). Repeatable. |
| `--test-source <glob>` | Test source glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude paths containing the substring. Repeatable. |
| `--task <text>` | Inline task description. Mutually exclusive with `--task-file`. |
| `--task-file <path>` | Read the task from a non-empty UTF-8 text file. |
| `--symbol <name>` | Explicit [symbol](#target-selection) seed. Repeatable. |
| `--in <path>` | Disambiguate the immediately preceding `--symbol`. |
| `--file <path>` | Explicit [file](#target-selection) seed. Repeatable. |
| `--at <file:line[:column]>` | Explicit [location](#target-selection) seed. Repeatable. |
| `--doc <glob>` | Include additional documentation. Repeatable. |
| `--config <path>` | Include an additional configuration file. Repeatable. |
| `--max-seeds <integer>` | Maximum automatic seeds. Default: `5`; may be `0`. |
| `--direction <value>` | [`incoming`, `outgoing`, or `both`](#traversal-direction). Default: `both`. |
| `--max-depth <integer>` | Maximum traversal depth. Default: `2`; may be `0`. |
| `--max-nodes <integer>` | Maximum traversed nodes. Default: `100`; may be `0`. |
| `--max-tokens <integer>` | Estimated output budget. Default: `12000`; must be positive. |
| `--format <format>` | `markdown` or `json`. Default: `markdown`. |
| `--pretty` | Indent JSON output. Invalid with Markdown. |
| `--out <path>` | Write to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

#### Examples

`--in` must appear directly after its associated `--symbol`:

```bash
context-pack \
  --source "src/**/*.ts" \
  --task "repair invoice calculation" \
  --symbol calculateInvoice --in src/billing/invoice.ts \
  --doc "docs/**/*.md" \
  --max-tokens 8000 \
  --out context.md
```

Read the task from a file and emit a machine-readable report:

```bash
context-pack \
  --source "src/**/*.ts" \
  --task-file task.md \
  --symbol calculateInvoice \
  --format json \
  --pretty
```

JSON output is a `ContextPackReport` with these top-level fields:

```text
query, task, terms, seeds, instructions, documentation, configuration,
code, omitted, summary
```

The summary reports estimated tokens, seed and content counts, omissions, and whether graph traversal was truncated.

<a id="code-impact"></a>

### `code-impact`

Finds the transitive impact radius of a symbol, a file, or a symbol narrowed to a file. It reports separate affected-test results and evidence-bearing paths.

**Related:** [`code-slice`](#code-slice) for source snippets; [`code-graph`](#code-graph) for raw graph data.

#### Syntax

```text
code-impact --source <glob> (--symbol <name> [--file <path>] | --file <path>) [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required [source glob](#source-selection). Repeatable. |
| `--test-source <glob>` | Optional test glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--symbol <name>` | Simple or qualified [symbol name](#target-selection). May appear once. |
| `--file <path>` | [File target](#target-selection), or disambiguator when used with `--symbol`. |
| `--direction <value>` | [`incoming`, `outgoing`, or `both`](#traversal-direction). Default: `both`. |
| `--max-depth <integer>` | Maximum traversal depth. Default: `3`; may be `0`. |
| `--max-nodes <integer>` | Maximum traversed nodes. Default: `200`; may be `0`. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

#### Examples

```bash
code-impact \
  --source "src/**/*.ts" \
  --test-source "test/**/*.ts" \
  --symbol OrderService.execute \
  --direction incoming \
  --pretty
```

Target a whole file and write the report to a path:

```bash
code-impact \
  --source "src/**/*.ts" \
  --file src/orders.ts \
  --out impact/orders.json
```

The JSON result has this shape:

```ts
interface ImpactReport {
  query: object;
  targets: ImpactNode[];
  impacted: ImpactedNode[];
  impactedTests: ImpactedNode[];
  summary: {
    targetCount: number;
    impactedCount: number;
    impactedTestCount: number;
    externalCount: number;
    truncated: boolean;
  };
}
```

Each impacted node includes its minimum distance, directions, relationship types, and paths back to or from a target.

<a id="code-slice"></a>

### `code-slice`

Extracts a compact, dependency-aware slice around a target. In addition to graph selections, it returns source snippets, necessary imports, supporting types, boundary nodes omitted by limits, and affected tests.

**Related:** [`code-impact`](#code-impact) for impact-only analysis; [`context-pack`](#context-pack) for a task-oriented bundle.

#### Syntax

```text
code-slice --source <glob> \
  (--symbol <name> [--file <path>] | --file <path> | --at <file:line[:column]>) \
  [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required [source glob](#source-selection). Repeatable. |
| `--test-source <glob>` | Optional test glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--symbol <name>` | Simple or qualified [symbol name](#target-selection). |
| `--file <path>` | [File target](#target-selection), or disambiguator when used with `--symbol`. |
| `--at <file:line[:column]>` | Target a symbol or enclosing declaration by [location](#target-selection). |
| `--direction <value>` | [`incoming`, `outgoing`, or `both`](#traversal-direction). Default: `both`. |
| `--max-depth <integer>` | Maximum traversal depth. Default: `2`; may be `0`. |
| `--max-nodes <integer>` | Maximum traversed nodes. Default: `50`; may be `0`. |
| `--format <format>` | `json` or `markdown`. Default: `json`. |
| `--pretty` | Indent JSON output. Invalid with Markdown. |
| `--out <path>` | Write output to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

`--at` is mutually exclusive with `--symbol` and `--file`.

#### Examples

```bash
code-slice \
  --source "src/**/*.ts" \
  --at src/orders.ts:47 \
  --format markdown \
  --out order-slice.md
```

Slice around a qualified symbol with an explicit test source:

```bash
code-slice \
  --source "src/**/*.ts" \
  --test-source "test/**/*.ts" \
  --symbol OrderService.execute \
  --direction outgoing \
  --pretty
```

JSON output is a `CodeSliceReport` with these top-level fields:

```text
query, targets, selections, files, boundaries, impactedTests, summary
```

Each file contains required imports and source snippets. Each selection records its roles, distance, relationships, dependency paths, and associated snippets.

<a id="code-patterns"></a>

### `code-patterns`

Detects architectural and design patterns using AST evidence, [call graphs](#code-graph), and [definition-use graphs](#code-graph). Output is a JSON array sorted and filtered by the detector.

**Related:** [`code-graph`](#code-graph) exposes the graph structures used as evidence.

#### Syntax

```text
code-patterns --source <glob> [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required [source glob](#source-selection). Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--include-tests` | Include test and mock files. |
| `--include-declarations` | Include `.d.ts` files. |
| `--pattern <key>` | Restrict results to a pattern. Repeatable; `pattern.` is optional. |
| `--min-confidence <level>` | `low`, `medium`, or `high`. Default: `low`. |
| `--graph-max-depth <integer>` | [Definition-use](#code-graph) traversal depth. |
| `--graph-max-records <integer>` | [Definition-use](#code-graph) record limit per traversal. |
| `--graph-score-cap <number>` | Maximum [definition-use](#code-graph) score contribution per pattern. |
| `--call-max-depth <integer>` | [Call-graph](#code-graph) traversal depth. |
| `--call-max-calls <integer>` | [Call-graph](#code-graph) call limit per traversal. |
| `--call-score-cap <number>` | Maximum [call-graph](#code-graph) score contribution per pattern. |
| `--confidence-low <number>` | Low-confidence score threshold. |
| `--confidence-medium <number>` | Medium-confidence score threshold. |
| `--confidence-high <number>` | High-confidence score threshold. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

Numeric tuning values must be nonnegative. Confidence thresholds must satisfy `low <= medium <= high`. Supported pattern keys are:

```text
singleton, dependency_injection, factory, observer, interface_based,
repository, service, strategy, builder, adapter, facade, decorator, proxy,
command, middleware, event_emitter, registry, plugin, mapper, module_boundary,
unit_of_work, controller, route_handler, guard, interceptor, validator, dto,
entity, value_object, use_case, presenter, resolver, provider,
composition_root, cache, retry_policy, circuit_breaker, queue_consumer,
scheduler, feature_flag, specification
```

Each detection contains:

```text
pattern, detected, confidence, mode, score, filePath, nodeKind, nodeName,
startLine, endLine, evidence, matchedRules, graphEvidence, callGraphEvidence,
intersectingPatterns, intersectionEvidence
```

#### Examples

```bash
code-patterns \
  --source "src/**/*.ts" \
  --pattern repository \
  --pattern unit_of_work \
  --min-confidence medium \
  --pretty
```

Scan everything, including tests, and keep only high-confidence detections:

```bash
code-patterns \
  --source "src/**/*.ts" \
  --include-tests \
  --min-confidence high \
  --out patterns.json
```

<a id="type-model"></a>

### `type-model`

Extracts the TypeScript checker's resolved semantic model into deterministic, normalized JSON. The default schema version `2` includes symbols, advanced types, call and construct signatures, inferred parameter and return types, raw JSDoc, module exports, optional resolved call sites, and compiler diagnostics. Recursive and shared types use references instead of nested copies.

**Related:** [`collect-types`](#collect-types) emits declaration text rather than normalized semantic JSON.

#### Syntax

```text
type-model --source <glob> [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required root-selection [source glob](#source-selection). Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching files from root selection. Repeatable. |
| `--scope <scope>` | `exports` or `all`. Default: `exports`. |
| `--include-call-sites` | Include resolved call-like expressions from matched, non-excluded files. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

The complete tsconfig program remains available to the type checker. Source globs and exclusions only select modules whose declarations become roots. With `exports`, roots are the modules' direct and re-exported public symbols. With `all`, roots are all named top-level declarations in those modules.

Call-site extraction is opt-in and independent of root scope. When enabled it scans only the selected files, while the complete tsconfig program remains available for resolving callees and types.

#### Examples

```bash
type-model \
  --source "src/**/*.ts" \
  --scope exports \
  --include-call-sites \
  --pretty \
  --out type-model.json
```

Model every top-level declaration and exclude test files from root selection:

```bash
type-model \
  --source "src/**/*.ts" \
  --scope all \
  --exclude test \
  --out type-model-all.json
```

The top-level JSON fields are:

```text
schemaVersion, project, modules, roots, symbols, types, signatures, callSites, diagnostics
```

`symbols`, `types`, `signatures`, and `callSites` are ID-keyed tables. Project-local conditional, mapped, indexed-access, `keyof`, template-literal, string-mapping, and substitution types are expanded structurally. Types supplied by `node_modules` or TypeScript's standard libraries remain opaque `external` records whose type arguments are still represented.

Raw JSDoc entries preserve their exact source comment text and location on symbols, properties, and signatures. Object call/construct signature arrays are the callable overload sets; implementation-only overload signatures are not included.

Call sites cover calls, `new`, tagged templates, decorators, JSX, and `instanceof`. Resolved records link the selected declaration signature to a possibly distinct instantiated signature, and generic instantiations map type parameters to explicit or inferred resolved types. Unresolved calls and incomplete compiler inference maps add warnings without failing extraction.

Unsupported future compiler forms remain explicit `unsupported` records. TypeScript syntactic and semantic diagnostics are also returned without changing CLI exit status.

#### Programmatic declaration generation

The library API can opt into schema version `3`, which embeds a standalone declaration bundle for every selected module. This option is intentionally not exposed by the CLI because bundle payloads can substantially increase extraction time and JSON size.

```ts
import {
  extractTypeModel,
  generateTypeDeclarationsFromModel,
  saveTypeDeclarationsFromModel,
} from "js-ts-tools";
const model = extractTypeModel({
  sourceGlob: "src/index.ts",
  tsConfigFilePath: "tsconfig.json",
  includeDeclarationBundles: true,
});
const generated = generateTypeDeclarationsFromModel(model);
console.log(generated.text);
await saveTypeDeclarationsFromModel(
  JSON.parse(JSON.stringify(model)),
  "generated/index.d.ts",
);
```

When a model contains multiple selected modules, pass the exact module id or file path as `{ module: "src/index.ts" }`. Successful schema version `3` payloads are compiler-derived declaration bundles containing project-local dependencies and external package imports. Version 2.0 fails closed when the selected module has only a schema version `2` structural model or its bundle failed. Callers that deliberately accept lossy structural declarations must say so explicitly:

```ts
const approximate = generateTypeDeclarationsFromModel(schemaV2Model, {
  structuralFallback: "allow",
});
```

Structural output carries a fidelity warning when the modeled signatures had explicit source annotations. `ExactDeclarationUnavailableError` exposes the selected module, schema version, and absent or failed bundle status.

<a id="collect-types"></a>

### `collect-types`

Collects a dependency-first, de-duplicated closure for named type aliases, interfaces, and abstract classes. It preserves original declaration text and includes supporting unique-symbol declarations when necessary.

**Related:** [`type-model`](#type-model) exposes resolved semantic types and signatures.

#### Syntax

```text
collect-types --name <declaration> --source <file> [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--name <declaration>` | Required root declaration name. Repeatable. |
| `--source <file>` | Required file or barrel declaring/exporting the roots. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude-node-modules` | Do not copy declarations supplied by dependencies. |
| `--include-typescript-libs` | Include TypeScript `lib.*.d.ts` declarations. |
| `--out <path>` | Write TypeScript to a file and create parent directories. |
| `-h`, `--help` | Print help. |

By default, dependency declarations from `node_modules` are included while TypeScript standard-library declarations are not. A relative `--source` path is resolved from the directory containing the selected tsconfig. Output begins with:

```ts
/* Generated associated type closure. */
```

#### Examples

```bash
collect-types \
  --name User \
  --name UserId \
  --source src/types.ts \
  --out generated/user-types.ts
```

Collect from a barrel file, keeping `node_modules` types out of the closure:

```bash
collect-types \
  --name Order \
  --source src/api/barrel.ts \
  --exclude-node-modules \
  --out generated/order-closure.ts
```

<a id="create-project"></a>

### `create-project`

Creates a directory and blank-file structure from JSON, or extracts the shape of an existing directory into the same JSON representation.

#### Create mode

```text
create-project <structure.json> [output-directory]
```

`output-directory` defaults to the current working directory. Nested JSON objects represent directories; every other value represents a blank file. File values are structural markers—their JSON contents are not written into the created file. Existing files are preserved.

```json
{
  "src": {
    "index.ts": "",
    "services": {
      "orders.ts": null
    }
  },
  "package.json": ""
}
```

```bash
create-project structure.json ./my-project
```

On success, stdout identifies the absolute output directory.

#### Extract mode

```text
create-project --extract <project-directory> [output.json]
```

Without `output.json`, the structure is printed as pretty JSON. With an output path, the JSON is written there and stdout identifies the absolute path. Extraction ignores `node_modules`, `.git`, and `.DS_Store` by default and records files as empty strings.

```bash
create-project --extract ./my-project structure.json
```

#### Other options

| Option | Behavior |
| --- | --- |
| `-h`, `--help` | Print help. |

<a id="code-graph"></a>

### `code-graph`

Builds one or more JSON-safe structural and semantic graphs from TypeScript or JavaScript source files. These graphs underpin higher-level workflows such as [`code-impact`](#code-impact), [`code-slice`](#code-slice), and [`code-patterns`](#code-patterns).

**Related:** [`code-impact`](#code-impact), [`code-slice`](#code-slice), and [`code-patterns`](#code-patterns) provide higher-level graph-driven analyses.

#### Syntax

```text
code-graph --source <glob> <graph-target> [options]
```

At least one graph target is required.

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required [source glob](#source-selection). Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude paths containing the substring. Repeatable. |
| `--structure` | Include `structureForest`. |
| `--call` | Include `callGraph`. |
| `--owner-reference` | Include `ownerReferenceGraph`. |
| `--definition-use` | Include `definitionUseGraph`. |
| `--all` | Include all four graph types. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

For compatibility, `--owner-use` aliases `--owner-reference`, and `--json` is accepted but unnecessary because CLI output is always JSON.

#### Examples

```bash
code-graph \
  --source "src/**/*.ts" \
  --call \
  --owner-reference \
  --pretty \
  --out graphs.json
```

Build every graph type at once:

```bash
code-graph \
  --source "src/**/*.ts" \
  --all \
  --out graphs/all.json
```

Only requested graph keys are serialized. Their values have these shapes:

```ts
interface GraphOutput {
  structureForest?: Array<{
    filePath: string;
    tree: StructureTreeNode;
  }>;
  callGraph?: Array<{
    id: string;
    name: string;
    calls: string[];
  }>;
  ownerReferenceGraph?: Array<{
    id: string;
    name: string;
    references: Array<{ id: string; name: string }>;
  }>;
  definitionUseGraph?: DefinitionUseRecord[];
}
```

A structure node contains `id`, `kind`, optional `name`, `text`, and `structure`, a source `location`, and recursive `children`. Definition-use records contain declaration data, initializers, assignments, reads, and available read-site/dependency IDs. Internal symbol IDs normally use `<absolute-file>:<line>:<column>:<name>`; unresolved external symbols use an `external:` prefix. The graph builders exclude paths containing `node_modules` or `js-ts-tools` by default, in addition to values supplied with `--exclude`.

<a id="json-jspath"></a>

### `json-jspath`

Applies a [JSPath](https://github.com/dfilatov/jspath) expression to every JSON file matching a path or glob and streams matches to stdout.

#### Syntax

```text
json-jspath <file-pattern> <jspath-expression> [options]
```

Both positional arguments are required. Quote them to prevent shell expansion or interpretation.

#### Options

| Option | Behavior |
| --- | --- |
| `--pretty` | Indent the default JSON-array output. |
| `--ndjson` | Emit one compact JSON value per line instead of an array. |
| `--jsonl` | Alias for `--ndjson`. |
| `--json-lines` | Alias for `--ndjson`. |
| `--with-file` | Wrap each match as `{ "file": string, "value": unknown }`. |
| `--first` | Emit only the first match from each file. |
| `--fail-empty` | Exit with [status `2`](#exit-statuses) when no matches are found. |
| `--continue-on-error` | Report malformed/unreadable files and continue processing. |
| `-h`, `--help` | Print help. |

#### Examples

Default output is one JSON array containing matches from all selected files:

```bash
json-jspath "data/**/*.json" ".users{.active === true}" --pretty
```

For pipelines, use newline-delimited JSON:

```bash
json-jspath "data/**/*.json" ".name" --ndjson --with-file
```

Fail in a script when a key is absent:

```bash
json-jspath "config/*.json" ".database.host" --first --fail-empty
```

Top-level JSON arrays are streamed without loading the whole array into memory. For those files, the JSPath expression is applied independently to each array element. Other JSON documents are parsed as a whole. With `--continue-on-error`, errors are written to stderr, valid files continue to produce output, and the final exit status is still `1` if any file failed.

<a id="github-js-ts-search"></a>

### `github-js-ts-search`

Downloads exact Git blob snapshots for JavaScript and TypeScript files that statically import or directly `require` an npm package. Set `GITHUB_TOKEN` before running the command.

#### Syntax

```text
github-js-ts-search [--out <directory>] <package> [package ...]
```

`--out` overrides `OUT_DIR`; otherwise output defaults to `downloads`. Matching files are stored beneath `files/<owner>/<repo>/<blob-sha>/`, and a successful run writes `manifest.json`. Dynamic imports and re-exports are excluded. GitHub-wide code search is bounded by GitHub's indexing and result limits. Incomplete or truncated queries produce warnings and are recorded in the manifest without changing the successful exit status.

#### Examples

```bash
github-js-ts-search --out corpus lodash @tanstack/react-query
```

Use an authenticated token for higher search rate limits:

```bash
export GITHUB_TOKEN=...
github-js-ts-search --out corpus express
```

<a id="ast-xpath"></a>

### `ast-xpath`

Converts the TypeScript compiler AST to a versioned XML projection, generates XPath 3.1 from a marked example, and matches the portable pattern in the same or another configured project. XPath supplies structural candidates; portable TypeScript checker comparisons then verify bindings, types, and overloads.

**Related:** [`tsquery`](#tsquery) is better suited to ad hoc selector queries and direct source mutation.

#### Syntax

```text
ast-xpath generate --example <file> [options]
ast-xpath match --pattern <pattern.json> [options]
ast-xpath run --example <file> [options]
```

The example must contain exactly one root marker:

```ts
/* ast-xpath-root */ audit(/* ast-xpath-ignore */ value);
```

`/* ast-xpath-ignore */` makes the following subtree unconstrained. Paired `/* ast-xpath-ignore-start */` and `/* ast-xpath-ignore-end */` markers can surround one subtree or contiguous siblings in a collection. Collection spans match zero or more candidate nodes while retaining the order of the surrounding nodes. Markers must align with complete AST nodes.

#### Options

| Option | Value and behavior |
| --- | --- |
| `--example <file>` | Marked example file. Required by `generate` and `run`. |
| `--pattern <file>` | Generated pattern artifact. Required by `match`. |
| `--tsconfig <path>` | Example config for `generate`/`run`, or target config for `match`. Default: `tsconfig.json`. |
| `--target-tsconfig <path>` | Separate target config for `run`; defaults to its example config. |
| `--semantics <strict\|structural>` | Enforce portable semantic facts or skip the semantic pass. Default: `strict`. |
| `--strictness <exact\|shape>` | `exact` includes identifier and literal values; `shape` generalizes them. Default: `exact`. |
| `--source <glob>` | Restrict matched project files. Repeatable. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--include-declarations` | Include declaration files. |
| `--xml-out <path>` | Write the example AST XML from `generate` or `run`. |
| `--pattern-out <path>` | Write the generated pattern during `run`. |
| `--format <json\|text>` | Match report format. Default: `json`. |
| `--pretty` | Pretty-print JSON. |
| `--out <path>` | Write the primary pattern or match output. |
| `--fail-empty` | Exit with [status `2`](#exit-statuses) when matching finds nothing. |

The XML schema uses `<ast>/<file>/<node>/<field>/<node>`. Nodes contain stable IDs, syntax kinds, source offsets, and identifier/literal values. Fields retain their compiler property names, and collection children carry one-based indices. Comments, formatting trivia, parent links, compiler caches, symbols, and flow metadata are not serialized. Exact patterns constrain normalized AST shape, field roles, collection order and cardinality, identifier/literal values, operators, and modifiers. Shape patterns retain the same structure but omit identifier and literal value predicates. Both modes generate a retained AST template. Strict semantic mode also verifies internal binding topology, portable external symbol identities, mutually assignable types, and corresponding resolved overloads. Structural semantic mode performs only XPath selection and retained-template alignment. Version 2 patterns are self-contained. They retain example source and tsconfig hashes as provenance, but matching does not reopen the example project. Portable semantic facts are materialized in the target TypeScript project and checked by its checker. Facts that cannot be represented portably are recorded as diagnostics and remain structurally checked. Version 1 patterns remain project-anchored and must be regenerated before cross-project use. JSON matching output contains the pattern, root match records, and this summary:

```ts
interface AstXPathMatchSummary {
  filesScanned: number;
  xpathCandidates: number;
  semanticRejected: number;
  matches: number;
}
```

#### Examples

```bash
ast-xpath generate \
  --example patterns/audit-example.ts \
  --strictness shape \
  --out patterns/audit.json \
  --xml-out patterns/audit.xml
ast-xpath match \
  --pattern patterns/audit.json \
  --tsconfig tsconfig.json \
  --source "src/**/*.ts" \
  --semantics strict \
  --pretty
ast-xpath run \
  --example patterns/audit-example.ts \
  --target-tsconfig ../target-project/tsconfig.json \
  --source "src/**/*.ts" \
  --pattern-out patterns/audit.json
```

The artifact can be moved and the example project removed before matching:

```bash
cd /path/to/project-b
ast-xpath match \
  --pattern /path/to/audit.json \
  --tsconfig tsconfig.json \
  --source 'src/**/*.ts'
```

<a id="tsquery"></a>

### `tsquery`

Queries the TypeScript project AST with [TSQuery](https://github.com/phenomnomnominal/tsquery) selectors. Query mode reports matched source nodes. Mutation mode can delete matches or insert exact UTF-8 snippets immediately before or after them. Mutations are previews unless `--write` is supplied.

**Related:** [`ast-xpath`](#ast-xpath) generates portable example-derived patterns; [`convert-ts-pattern`](#convert-ts-pattern) is a specialized conditional refactoring.

#### Syntax

```text
tsquery <selector> [options]
```

The selector is required and should normally be quoted so the shell does not interpret selector punctuation.

#### Options

| Option | Value and behavior |
| --- | --- |
| `--tsconfig <path>` | TypeScript project configuration. Default: `tsconfig.json`. |
| `--source <glob>` | Restrict project source files. Repeatable. Without it, all non-declaration project source files are searched. |
| `--exclude <substring>` | Exclude paths containing the substring. Repeatable. |
| `--include-declarations` | Include declaration files such as `.d.ts`. |
| `--format <format>` | `json` or `text`. Default: `json`. |
| `--pretty` | Indent JSON output. Invalid with text output. |
| `--out <path>` | Write the query or mutation report to a file, creating parent directories. |
| `--fail-empty` | Exit with [status `2`](#exit-statuses) when no AST nodes match. |
| `--delete` | Plan deletion of every matched node. |
| `--insert-before <text>` | Plan insertion of exact text immediately before every matched node. |
| `--insert-after <text>` | Plan insertion of exact text immediately after every matched node. |
| `--insert-before-file <path>` | Read a UTF-8 snippet and insert it before every matched node. |
| `--insert-after-file <path>` | Read a UTF-8 snippet and insert it after every matched node. |
| `--write` | Apply a planned mutation to source files. Invalid without a mutation option. |
| `-h`, `--help` | Print help. |

The five mutation options are mutually exclusive. Without `--write`, source files are never changed; the command reports the edits it would apply. Snippet text is inserted exactly as provided, without automatic indentation or formatting.

Node deletion uses the selected node's source range excluding leading trivia, so leading comments and whitespace are preserved. Overlapping deletion ranges are coalesced before editing. All project edits are calculated and files are checked for concurrent changes before the first source file is written.

By default, declaration files and paths under `node_modules` are not queried. `--source` and `--exclude` only filter the source files loaded from the selected TypeScript project; they do not create a separate compiler program.

Query output is an array of records with this shape:

```ts
interface TsQueryMatch {
  filePath: string;
  kind: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
  startOffset: number;
  endOffset: number;
  text: string;
}
```

Lines and columns are 1-based. Offsets are zero-based UTF-16 source offsets, matching the TypeScript compiler API. Text output emits one match per line as `file:line:column<TAB>kind<TAB>text`, with embedded newlines escaped as `\n`. Mutation mode emits a report containing `selector`, `action`, `written`, `matchCount`, `editCount`, per-file counts, and the matched-node records. Nested or overlapping delete matches can therefore produce fewer edits than matches.

#### Examples

```bash
# Query calls to fetch.
tsquery 'CallExpression > Identifier[name="fetch"]' --pretty

# Preview removal of lodash imports from application sources.
tsquery 'ImportDeclaration:has(StringLiteral[text="lodash"])' \
  --source "src/**/*.ts" \
  --delete \
  --pretty

# Apply the deletion.
tsquery 'ImportDeclaration:has(StringLiteral[text="lodash"])' \
  --source "src/**/*.ts" \
  --delete \
  --write

# Insert a multi-line snippet before matching methods.
tsquery 'MethodDeclaration:has(Identifier[name="execute"])' \
  --source "src/**/*.ts" \
  --insert-before-file snippets/instrumentation.ts \
  --write
```

<a id="convert-ts-pattern"></a>

### `convert-ts-pattern`

Conservatively rewrites supported `switch` statements, `if` chains, and conditional expressions as `ts-pattern` match expressions. The command is a validated preview by default and changes source files only when `--write` is explicitly supplied.

**Related:** [`tsquery`](#tsquery) handles general selector-based AST mutations.

#### Syntax

```text
convert-ts-pattern --source <glob> [options]
```

#### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | [Source glob](#source-selection). Required and repeatable. |
| `--tsconfig <path>` | TypeScript project configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--max-continuation-bytes <n>` | Maximum cumulative duplicated continuation bytes per file. Default: `16384`; `0` disables conversions that require duplication. |
| `--dry-run` | Validate and report conversions without writing; this is the default. |
| `--write` | Write validated conversions. Mutually exclusive with `--dry-run`. |
| `--format <format>` | `json` or `text`. Default: `json`. |
| `--pretty` | Indent JSON output. Invalid with text output. |
| `--out <path>` | Write the report to a file, creating parent directories. In write mode it may not select a transformed source file. |
| `-h`, `--help` | Print help. |

#### Conversion behavior

The deterministic classifier supports stable identifier/property subjects, primitive and enum-member patterns, reversed strict equality, OR groups over one subject, heterogeneous identifier-property paths, mixed scalar/object unions, fully optional property paths, non-fallthrough switches, and safe return/throw or imperative branch shapes. Ordered pattern guards become `.with(pattern, guard, handler)`, guarded OR groups use `P.union(...)`, and unambiguous guard-only branches become `.when(predicate, handler)`.

Strict inequality becomes `P.not(...)`. Checker-confirmed `typeof` and `instanceof` conditions use native `P` patterns. Explicit runtime type checks can also be combined with numeric ranges, integer/finite checks, string prefix/suffix/inclusion and length predicates, and safe regular-expression literals. Coercive or potentially throwing forms remain verbatim guards so unexpected runtime inputs retain their original behavior.

Every original fallback is preserved. Safe conditionals without an explicit fallback use `.otherwise(() => {})`, `.otherwise(() => undefined)`, or an absorbed unmatched continuation. Nested continuations may cross plain blocks and conditional branches, but not loop, switch, label, resource-lifetime, or exception boundaries. Continuations containing `await` or `yield` remain unchanged. Runtime gaps always fall through rather than becoming exhaustive.

For explicit fallbacks, the converter prefers `.exhaustive(fallbackHandler)` when the fallback does not read the match subject and the installed `ts-pattern` types prove coverage; otherwise it retries with `.otherwise(fallbackHandler)`. It never emits a no-argument `.exhaustive()`. Imports reuse safe existing aliases or select deterministic file-wide aliases such as `matchTsPattern2` and `PTsPattern2` when bindings or nested shadows collide.

Loose equality, effectful or ambiguous guards, unsafe missing fallbacks, partially optional or computed discriminator paths, escaping control flow, async/generator semantics, and scope changes are reported and left unchanged. The target project must already make `ts-pattern` available to TypeScript module resolution. Existing diagnostics are tolerated, but generated edits may not introduce new diagnostics. Before write mode changes any file, all changed files are checked against the source bytes used to plan the edits.

Accepted outer candidates take priority over overlapping descendants. A descendant remains eligible when its outer candidate is rejected. Existing `match(...)` expressions are not candidates. Copied shared continuations may expose additional original conditionals on a later run, so repeated writes converge rather than requiring every nested continuation to change at once.

#### Report

JSON is the default format. The report has this shape:

```ts
interface TsPatternConversionReport {
  query: {
    sourceGlob: string[];
    tsConfigFilePath: string;
    excludePathIncludes: string[];
    maxContinuationBytes: number;
    mode: "dry-run" | "write";
  };
  written: boolean;
  files: Array<{
    filePath: string;
    changed: boolean;
    candidates: TsPatternCandidateReport[];
  }>;
  summary: {
    candidates: number;
    converted: number;
    skipped: number;
    filesChanged: number;
  };
}
```

Candidate records contain 1-based `start` and `end` locations, `kind`, subject, dotted `discriminator`, ordered `discriminators`, branch count, action, and an optional converted terminator (`otherwise` or `exhaustive`) and `fallbackKind` (`explicit`, `implicit-noop`, `implicit-undefined`, or `absorbed-continuation`). The singular field is retained when exactly one path is present. Skipped candidates include a stable `reasonCode`, `reason`, and any diagnostics produced during validation. Candidate kinds are `switch`, `if-chain`, `scalar-if`, `discriminated-if`, `structural-if`, `guard-if`, and `ternary`. Stable skip codes are:

```text
unsupported-condition, loose-equality, inconsistent-subject,
inconsistent-discriminator, effectful-subject, unsupported-pattern,
missing-fallback, switch-fallthrough, default-not-final, outer-control-flow,
labeled-control-flow, yield, await, unsupported-branch-shape, scope-change,
binding-collision, unsupported-discriminator, unsupported-guard,
ambiguous-guard-subject, effectful-guard, overlapping-candidate,
continuation-too-large, validation-failed
```

Text output prints each candidate as a location header followed by its subject, discriminator, branch count, action, terminator or skip reason, and then a final summary line.

#### Examples

```bash
# Validate and print a pretty JSON report without changing source files.
convert-ts-pattern --source "src/**/*.ts" --pretty

# Apply validated conversions from the configured project.
convert-ts-pattern --tsconfig tsconfig.json --source "src/**/*.ts" --write

# Readable per-candidate summary for a quick review.
convert-ts-pattern --source "src/**/*.ts" --format text
```

<a id="conditional-to-effect-schema-v3"></a>

## `conditional-to-effect-schema-v3`

Generate a schema snippet from a synchronous, one-argument validator that rejects by throwing. Source files are not modified. Run `npm run build` before invoking the checkout's `bin/conditional-to-effect-schema-v3-cli.js` directly.

```bash
conditional-to-effect-schema-v3 --source 'src/**/*.ts' \
  --target validateOrder --base-schema OrderBase --mode auto

conditional-to-effect-schema-v3 --source 'src/**/*.ts' \
  --target validateOrder --base-schema OrderBase --format json --pretty
```

| Option | Meaning |
| --- | --- |
| `--target <symbol>` | Required simple or qualified validator name; ambiguous names fail. |
| `--base-schema <expression>` | Required Effect v3 schema expression. |
| `--source <glob>` | Required source selection; repeatable. |
| `--tsconfig <path>` | TypeScript config; default `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching source paths; repeatable. |
| `--schema-name <name>` | Generated constant name; default `<targetName>Schema`. |
| `--mode <static\|auto\|runtime-wrapper>` | Default `static`; see semantics below. |
| `--max-depth <integer>` | Maximum local call depth; default `12`, with `0` inspecting only the root. |
| `--allow-opaque-calls <true\|false>` | Trust calls outside selected sources; default `false`. |
| `--cwd <directory>` | Resolve configuration, sources and output relative to this directory. |
| `--format <code\|json>` | Default `code`; JSON also contains constraints, provenance and diagnostics. |
| `--pretty` | Pretty-print JSON; requires `--format json`. |
| `--out <path>` | Write to a new file; existing files are never overwritten. |
| `-h`, `--help` | Print help and exit successfully. |

`static` extracts explicit throw conditions through branches, early returns, safely inlined local constants and resolved local validation calls. Mutations, default/rest parameters, loops, exceptional control flow, calls used as values, and nonportable bindings block static conversion. Static mode assumes pure validation over ordinary data and a base schema that enforces the validator's input type; it does not model arbitrary getters, proxies, coercion side effects or every possible implicit exception. Trusting opaque calls explicitly assumes they neither throw nor affect validation state; callbacks remain unsupported.

`auto` uses a runtime wrapper when static conversion is blocked. `runtime-wrapper` invokes the original validator in a synchronous `Schema.filter` and turns thrown errors into validation messages. It preserves the validator's side effects on every filter invocation. Async, Promise-returning and generator root validators are rejected. Instance methods and accessors need a named one-argument adapter for wrapping.

The output imports `Schema` from `effect`. Provide the base schema in the output's scope and, for wrappers, the original validator with its qualified name. The converter does not synthesize these imports or alter the source validator. A validator's return value is ignored; only thrown failures count as rejection.

Code output writes diagnostics to stderr; JSON includes them in the result. Exit status is `0` for successful conversion or help and `1` for invalid arguments, unsupported conversion or I/O failure.

<a id="effect-v3-codemod"></a>

## `effect-v3-codemod`

Run the integrated Phase 11 production rules. See [Effect codemod](EFFECT_CODEMOD.md) for supported shapes, the original 50 targets plus `flatMap` and review-only `orElseFail`, options and validation behavior.

```bash
effect-v3-codemod --source 'src/**/*.ts' --target map --pretty
effect-v3-codemod --source 'src/**/*.ts' --write
```

`--max-passes` accepts integers from 1 through 10 and defaults to 3. Runs stop when unchanged; a pass limit is reported with `converged: false`. Cycles and validation failures prevent all writes. Reports include per-pass attempts, reason codes and pass-relative source locations.

`--source` is required and repeatable. Use repeatable `--target` to select operator names, `--tsconfig`, `--cwd` and repeatable `--exclude` for project selection, `--pretty` for formatted JSON, and `--out` for a new report file. Existing output files are not overwritten, and JavaScript/TypeScript report paths are rejected. Failed runs clean up newly reserved report files. `--no-review` hides review-only candidates. `--evidence compact|full` controls evidence detail (default `compact`); reports include candidate locations and grouped `summary.skipReasons`. Default dry runs validate proposed edits in memory without writing source files; `--write` commits only when no new diagnostics are introduced. `--dry-run` cannot be combined with `--write`. Exit status is `1` when validation fails or arguments/I/O are invalid, and `0` on success or help.

<a id="exit-statuses"></a>

## Exit statuses

| Status | Meaning |
| --- | --- |
| `0` | Command completed successfully, including an empty result unless `--fail-empty` is active. |
| `1` | Invalid arguments, analysis failure, filesystem failure, invalid JSON, or another runtime error. |
| `2` | `json-jspath`, `tsquery`, or `ast-xpath` with `--fail-empty` found no matches. |

Diagnostics are written to stderr. Machine-readable results are written to stdout unless `--out` is supported and supplied. Commands that support `--fail-empty` use status `2` for an empty match set; see their individual option tables for availability.
