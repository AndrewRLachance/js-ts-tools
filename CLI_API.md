# CLI API reference

`js-ts-tools` installs command-line tools for TypeScript analysis, context
assembly, JSON querying, and project scaffolding. This document describes the
command-line interface shipped in `bin/`.

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

All paths and globs are resolved from the current working directory unless a
command says otherwise. Quote globs so the command, rather than the shell,
expands them.

## Commands

| Command | Purpose | Default output |
| --- | --- | --- |
| `context-pack` | Assemble task-focused code and documentation context | Markdown |
| `code-impact` | Find code and tests affected by a symbol or file | JSON |
| `code-slice` | Extract relevant declarations, imports, and dependency paths | JSON |
| `code-patterns` | Detect architectural and design patterns | JSON |
| `type-model` | Extract a normalized resolved TypeScript type graph | JSON |
| `collect-types` | Emit a self-contained declaration closure | TypeScript |
| `create-project` | Create or extract a directory structure | Text or JSON |
| `code-graph` | Build structural and semantic code graphs | JSON |
| `json-jspath` | Apply JSPath expressions to JSON files | JSON array |
| `github-js-ts-search` | Download GitHub files importing npm packages | Source snapshots and JSON manifest |

## Shared analysis concepts

The analysis commands accept one or more quoted source globs. A symbol can be a
simple name such as `execute` or a qualified name such as
`OrderService.execute`. When a name is ambiguous, combine `--symbol` with a
`--file` path. Locations use 1-based lines and columns:

```text
path/to/file.ts:line[:column]
```

Traversal direction has the following meaning:

- `incoming`: code that calls, references, or otherwise depends on the target.
- `outgoing`: code used by the target.
- `both`: traverse in both directions.

The analysis tools recognize call, reference, initialization, assignment, and
read relationships. Results can include external symbols and test declarations.

## `context-pack`

Builds a bounded, task-focused bundle containing instructions, documentation,
configuration, code snippets, dependency paths, supporting types, and affected
tests. Explicit seeds are optional; without them, declarations are ranked from
the task text.

### Syntax

```text
context-pack --source <glob> (--task <text> | --task-file <path>) [options]
```

### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required source glob. Repeatable. |
| `--test-source <glob>` | Test source glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude paths containing the substring. Repeatable. |
| `--task <text>` | Inline task description. Mutually exclusive with `--task-file`. |
| `--task-file <path>` | Read the task from a non-empty UTF-8 text file. |
| `--symbol <name>` | Explicit symbol seed. Repeatable. |
| `--in <path>` | Disambiguate the immediately preceding `--symbol`. |
| `--file <path>` | Explicit file-wide seed. Repeatable. |
| `--at <file:line[:column]>` | Explicit location seed. Repeatable. |
| `--doc <glob>` | Include additional documentation. Repeatable. |
| `--config <path>` | Include an additional configuration file. Repeatable. |
| `--max-seeds <integer>` | Maximum automatic seeds. Default: `5`; may be `0`. |
| `--direction <value>` | `incoming`, `outgoing`, or `both`. Default: `both`. |
| `--max-depth <integer>` | Maximum traversal depth. Default: `2`; may be `0`. |
| `--max-nodes <integer>` | Maximum traversed nodes. Default: `100`; may be `0`. |
| `--max-tokens <integer>` | Estimated output budget. Default: `12000`; must be positive. |
| `--format <format>` | `markdown` or `json`. Default: `markdown`. |
| `--pretty` | Indent JSON output. Invalid with Markdown. |
| `--out <path>` | Write to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

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

JSON output is a `ContextPackReport` with these top-level fields:

```text
query, task, terms, seeds, instructions, documentation, configuration,
code, omitted, summary
```

The summary reports estimated tokens, seed and content counts, omissions, and
whether graph traversal was truncated.

## `code-impact`

Finds the transitive impact radius of a symbol, a file, or a symbol narrowed to
a file. It reports separate affected-test results and evidence-bearing paths.

### Syntax

```text
code-impact --source <glob> (--symbol <name> [--file <path>] | --file <path>) [options]
```

### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required source glob. Repeatable. |
| `--test-source <glob>` | Optional test glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--symbol <name>` | Simple or qualified symbol name. May appear once. |
| `--file <path>` | File target, or disambiguator when used with `--symbol`. |
| `--direction <value>` | `incoming`, `outgoing`, or `both`. Default: `both`. |
| `--max-depth <integer>` | Maximum traversal depth. Default: `3`; may be `0`. |
| `--max-nodes <integer>` | Maximum traversed nodes. Default: `200`; may be `0`. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

Example:

```bash
code-impact \
  --source "src/**/*.ts" \
  --test-source "test/**/*.ts" \
  --symbol OrderService.execute \
  --direction incoming \
  --pretty
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

Each impacted node includes its minimum distance, directions, relationship
types, and paths back to or from a target.

## `code-slice`

Extracts a compact, dependency-aware slice around a target. In addition to
graph selections, it returns source snippets, necessary imports, supporting
types, boundary nodes omitted by limits, and affected tests.

### Syntax

```text
code-slice --source <glob> \
  (--symbol <name> [--file <path>] | --file <path> | --at <file:line[:column]>) \
  [options]
```

### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required source glob. Repeatable. |
| `--test-source <glob>` | Optional test glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--symbol <name>` | Simple or qualified symbol name. |
| `--file <path>` | File target, or disambiguator when used with `--symbol`. |
| `--at <file:line[:column]>` | Target a symbol or enclosing declaration by location. |
| `--direction <value>` | `incoming`, `outgoing`, or `both`. Default: `both`. |
| `--max-depth <integer>` | Maximum traversal depth. Default: `2`; may be `0`. |
| `--max-nodes <integer>` | Maximum traversed nodes. Default: `50`; may be `0`. |
| `--format <format>` | `json` or `markdown`. Default: `json`. |
| `--pretty` | Indent JSON output. Invalid with Markdown. |
| `--out <path>` | Write output to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

`--at` is mutually exclusive with `--symbol` and `--file`.

```bash
code-slice \
  --source "src/**/*.ts" \
  --at src/orders.ts:47 \
  --format markdown \
  --out order-slice.md
```

JSON output is a `CodeSliceReport` with these top-level fields:

```text
query, targets, selections, files, boundaries, impactedTests, summary
```

Each file contains required imports and source snippets. Each selection records
its roles, distance, relationships, dependency paths, and associated snippets.

## `code-patterns`

Detects architectural and design patterns using AST evidence, call graphs, and
definition-use graphs. Output is a JSON array sorted and filtered by the
detector.

### Syntax

```text
code-patterns --source <glob> [options]
```

### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required source glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching paths. Repeatable. |
| `--include-tests` | Include test and mock files. |
| `--include-declarations` | Include `.d.ts` files. |
| `--pattern <key>` | Restrict results to a pattern. Repeatable; `pattern.` is optional. |
| `--min-confidence <level>` | `low`, `medium`, or `high`. Default: `low`. |
| `--graph-max-depth <integer>` | Definition-use traversal depth. |
| `--graph-max-records <integer>` | Definition-use record limit per traversal. |
| `--graph-score-cap <number>` | Maximum definition-use score contribution per pattern. |
| `--call-max-depth <integer>` | Call-graph traversal depth. |
| `--call-max-calls <integer>` | Call limit per traversal. |
| `--call-score-cap <number>` | Maximum call-graph score contribution per pattern. |
| `--confidence-low <number>` | Low-confidence score threshold. |
| `--confidence-medium <number>` | Medium-confidence score threshold. |
| `--confidence-high <number>` | High-confidence score threshold. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

Numeric tuning values must be nonnegative. Confidence thresholds must satisfy
`low <= medium <= high`.

Supported pattern keys are:

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

Example:

```bash
code-patterns \
  --source "src/**/*.ts" \
  --pattern repository \
  --pattern unit_of_work \
  --min-confidence medium \
  --pretty
```

## `type-model`

Extracts the TypeScript checker's resolved semantic model into deterministic,
normalized JSON. The default schema version `2` includes symbols, advanced types, call and
construct signatures, inferred parameter and return types, raw JSDoc, module
exports, optional resolved call sites, and compiler diagnostics. Recursive and
shared types use references instead of nested copies.

### Syntax

```text
type-model --source <glob> [options]
```

### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required root-selection glob. Repeatable. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude <substring>` | Exclude matching files from root selection. Repeatable. |
| `--scope <scope>` | `exports` or `all`. Default: `exports`. |
| `--include-call-sites` | Include resolved call-like expressions from matched, non-excluded files. |
| `--pretty` | Indent JSON output. |
| `--out <path>` | Write JSON to a file, creating parent directories. |
| `-h`, `--help` | Print help. |

The complete tsconfig program remains available to the type checker. Source
globs and exclusions only select modules whose declarations become roots.
With `exports`, roots are the modules' direct and re-exported public symbols.
With `all`, roots are all named top-level declarations in those modules.
Call-site extraction is opt-in and independent of root scope. When enabled it
scans only the selected files, while the complete tsconfig program remains
available for resolving callees and types.

```bash
type-model \
  --source "src/**/*.ts" \
  --scope exports \
  --include-call-sites \
  --pretty \
  --out type-model.json
```

The top-level JSON fields are:

```text
schemaVersion, project, modules, roots, symbols, types, signatures, callSites, diagnostics
```

`symbols`, `types`, `signatures`, and `callSites` are ID-keyed tables.
Project-local conditional, mapped, indexed-access, `keyof`, template-literal,
string-mapping, and substitution types are expanded structurally. Types supplied
by `node_modules` or TypeScript's standard libraries remain opaque `external`
records whose type arguments are still represented.

Raw JSDoc entries preserve their exact source comment text and location on
symbols, properties, and signatures. Object call/construct signature arrays are
the callable overload sets; implementation-only overload signatures are not
included.

Call sites cover calls, `new`, tagged templates, decorators, JSX, and
`instanceof`. Resolved records link the selected declaration signature to a
possibly distinct instantiated signature, and generic instantiations map type
parameters to explicit or inferred resolved types. Unresolved calls and
incomplete compiler inference maps add warnings without failing extraction.
Unsupported future compiler forms remain explicit `unsupported` records.
TypeScript syntactic and semantic diagnostics are also returned without changing
CLI exit status.

### Programmatic declaration generation

The library API can opt into schema version `3`, which embeds a standalone
declaration bundle for every selected module. This option is intentionally not
exposed by the CLI because bundle payloads can substantially increase extraction
time and JSON size.

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

When a model contains multiple selected modules, pass the exact module id or
file path as `{ module: "src/index.ts" }`. Successful schema version `3`
payloads are compiler-derived declaration bundles containing project-local
dependencies and external package imports. Schema version `2` models and failed
bundle payloads use a structural fallback and return warnings alongside the
generated text.

## `collect-types`

Collects a dependency-first, de-duplicated closure for named type aliases,
interfaces, and abstract classes. It preserves original declaration text and
includes supporting unique-symbol declarations when necessary.

### Syntax

```text
collect-types --name <declaration> --source <file> [options]
```

### Options

| Option | Value and behavior |
| --- | --- |
| `--name <declaration>` | Required root declaration name. Repeatable. |
| `--source <file>` | Required file or barrel declaring/exporting the roots. |
| `--tsconfig <path>` | TypeScript configuration. Default: `tsconfig.json`. |
| `--exclude-node-modules` | Do not copy declarations supplied by dependencies. |
| `--include-typescript-libs` | Include TypeScript `lib.*.d.ts` declarations. |
| `--out <path>` | Write TypeScript to a file and create parent directories. |
| `-h`, `--help` | Print help. |

By default, dependency declarations from `node_modules` are included while
TypeScript standard-library declarations are not. A relative `--source` path is
resolved from the directory containing the selected tsconfig. Output begins
with:

```ts
/* Generated associated type closure. */
```

Example:

```bash
collect-types \
  --name User \
  --name UserId \
  --source src/types.ts \
  --out generated/user-types.ts
```

## `create-project`

Creates a directory and blank-file structure from JSON, or extracts the shape
of an existing directory into the same JSON representation.

### Create mode

```text
create-project <structure.json> [output-directory]
```

`output-directory` defaults to the current working directory. Nested JSON
objects represent directories; every other value represents a blank file. File
values are structural markers—their JSON contents are not written into the
created file. Existing files are preserved.

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

### Extract mode

```text
create-project --extract <project-directory> [output.json]
```

Without `output.json`, the structure is printed as pretty JSON. With an output
path, the JSON is written there and stdout identifies the absolute path.
Extraction ignores `node_modules`, `.git`, and `.DS_Store` by default and
records files as empty strings.

```bash
create-project --extract ./my-project structure.json
```

### Other options

| Option | Behavior |
| --- | --- |
| `-h`, `--help` | Print help. |

## `code-graph`

Builds one or more JSON-safe structural and semantic graphs from TypeScript or
JavaScript source files.

### Syntax

```text
code-graph --source <glob> <graph-target> [options]
```

At least one graph target is required.

### Options

| Option | Value and behavior |
| --- | --- |
| `--source <glob>` | Required source glob. Repeatable. |
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

For compatibility, `--owner-use` aliases `--owner-reference`, and `--json` is
accepted but unnecessary because CLI output is always JSON.

```bash
code-graph \
  --source "src/**/*.ts" \
  --call \
  --owner-reference \
  --pretty \
  --out graphs.json
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

A structure node contains `id`, `kind`, optional `name`, `text`, and
`structure`, a source `location`, and recursive `children`. Definition-use
records contain declaration data, initializers, assignments, reads, and
available read-site/dependency IDs.

Internal symbol IDs normally use
`<absolute-file>:<line>:<column>:<name>`; unresolved external symbols use an
`external:` prefix.

The graph builders exclude paths containing `node_modules` or `js-ts-tools` by
default, in addition to values supplied with `--exclude`.

## `json-jspath`

Applies a [JSPath](https://github.com/dfilatov/jspath) expression to every JSON
file matching a path or glob and streams matches to stdout.

### Syntax

```text
json-jspath <file-pattern> <jspath-expression> [options]
```

Both positional arguments are required. Quote them to prevent shell expansion
or interpretation.

### Options

| Option | Behavior |
| --- | --- |
| `--pretty` | Indent the default JSON-array output. |
| `--ndjson` | Emit one compact JSON value per line instead of an array. |
| `--jsonl` | Alias for `--ndjson`. |
| `--json-lines` | Alias for `--ndjson`. |
| `--with-file` | Wrap each match as `{ "file": string, "value": unknown }`. |
| `--first` | Emit only the first match from each file. |
| `--fail-empty` | Exit with status `2` when no matches are found. |
| `--continue-on-error` | Report malformed/unreadable files and continue processing. |
| `-h`, `--help` | Print help. |

Default output is one JSON array containing matches from all selected files:

```bash
json-jspath "data/**/*.json" ".users{.active === true}" --pretty
```

For pipelines, use newline-delimited JSON:

```bash
json-jspath "data/**/*.json" ".name" --ndjson --with-file
```

Top-level JSON arrays are streamed without loading the whole array into memory.
For those files, the JSPath expression is applied independently to each array
element. Other JSON documents are parsed as a whole.

With `--continue-on-error`, errors are written to stderr, valid files continue
to produce output, and the final exit status is still `1` if any file failed.

## `github-js-ts-search`

Downloads exact Git blob snapshots for JavaScript and TypeScript files that
statically import or directly `require` an npm package. Set `GITHUB_TOKEN`
before running the command.

### Syntax

```text
github-js-ts-search [--out <directory>] <package> [package ...]
```

`--out` overrides `OUT_DIR`; otherwise output defaults to `downloads`. Matching
files are stored beneath `files/<owner>/<repo>/<blob-sha>/`, and a successful
run writes `manifest.json`. Dynamic imports and re-exports are excluded.

GitHub-wide code search is bounded by GitHub's indexing and result limits.
Incomplete or truncated queries produce warnings and are recorded in the
manifest without changing the successful exit status.

## Exit statuses

| Status | Meaning |
| --- | --- |
| `0` | Command completed successfully, including an empty result unless `--fail-empty` is active. |
| `1` | Invalid arguments, analysis failure, filesystem failure, invalid JSON, or another runtime error. |
| `2` | `json-jspath --fail-empty` found no matches. |

Diagnostics are written to stderr. Machine-readable results are written to
stdout unless `--out` is supported and supplied.
