# Implementation Plan: GitHub Package + AST XPath Search

## Summary

Add a new `github-ast-search` workflow that finds GitHub files importing an npm package and filters them with a portable AST XPath pattern.

Implement it in three stages:

1. Same-file structural matching without cloning repositories.
2. Import-aware matching that connects matched identifiers to package imports.
3. Optional repository hydration for full checker-backed strict matching and repository-wide searches.

Keep `github-js-ts-search` and `ast-xpath` independently usable. The new command orchestrates their lower-level APIs and produces a combined, reproducible manifest.

## Target CLI

```bash
github-ast-search \
  effect \
  --pattern patterns/effect-gen.json \
  --scope file \
  --semantics import-aware \
  --out corpus \
  --fail-empty
```

Supported modes:

```text
--scope file|repository
--semantics structural|import-aware|strict
```

Rules:

- Default scope: `file`.
- Default semantics: `import-aware`.
- `repository` scope requires `--hydrate`.
- `strict` semantics requires `--hydrate`.
- Phase 1 exposes structural mode first; make the CLI stable and default to `import-aware` when Phase 2 lands.
- Exit `1` for errors and `2` for `--fail-empty`.

## Phase 1: Same-File Structural Filtering

### In-memory AST XPath API

Add a public API that matches one source blob without a tsconfig:

```ts
interface MatchAstXPathSourceOptions {
  pattern: AstXPathPatternV2;
  sourceText: string;
  fileName: string;
}

interface AstXPathSourceMatchReport {
  matches: AstXPathMatch[];
  summary: {
    filesScanned: 1;
    xpathCandidates: number;
    semanticRejected: 0;
    matches: number;
  };
}

function matchAstXPathSource(
  options: MatchAstXPathSourceOptions
): AstXPathSourceMatchReport;
```

Behavior:

- Accept self-contained v2 patterns only.
- Validate pattern, XML, XPath, and TypeScript versions.
- Infer TS/TSX/JS/JSX script kind from `fileName`.
- Build the AST XML in memory.
- Evaluate XPath and align candidates with the retained template.
- Skip checker-backed semantic facts.
- Return the same match locations and source text as project matching.
- Do not touch the filesystem.

Refactor the existing project matcher so source-level and project-level matching share:

- XML construction.
- XPath evaluation.
- Candidate deduplication.
- Retained-template alignment.
- Match-record construction.

### GitHub search streaming core

Refactor `searchGitHubPackageImports()` around an internal streaming scanner:

```ts
interface GitHubPackageImportSource {
  repository: string;
  path: string;
  sha: string;
  sourceText: string;
  references: PackageReference[];
}

async function scanGitHubPackageImportSources(
  options: SearchGitHubPackageImportsOptions,
  visitor: (
    candidate: GitHubPackageImportSource
  ) => Promise<void> | void
): Promise<GitHubPackageImportScanSummary>;
```

The scanner owns:

- GitHub queries and pagination.
- Retry/rate-limit behavior.
- Blob-SHA source caching.
- Static import verification.
- Abort handling.
- Query completeness/truncation status.

Preserve `searchGitHubPackageImports()` by implementing it as a consumer that writes every verified package-import file exactly as it does now.

Do not change its report schema or CLI behavior.

### New orchestration API

Add:

```ts
type GitHubAstSemanticMode =
  | "structural"
  | "import-aware"
  | "strict";

type GitHubAstSearchScope = "file" | "repository";

interface SearchGitHubAstXPathOptions {
  packages: readonly string[];
  token: string;
  pattern: AstXPathPatternV2;
  patternFilePath?: string;
  outputDirectory?: string;
  scope?: GitHubAstSearchScope;
  semanticMode?: GitHubAstSemanticMode;
  signal?: AbortSignal;
  failEmpty?: boolean;
}

async function searchGitHubAstXPath(
  options: SearchGitHubAstXPathOptions
): Promise<GitHubAstSearchReport>;
```

Phase 1 accepts only:

```text
scope=file
semanticMode=structural
```

For each verified package-import blob:

1. Match the AST pattern in memory.
2. Cache results by blob SHA, extension/script kind, pattern digest, and mode.
3. Write source only when at least one AST root is accepted.
4. Record its GitHub metadata, package references, and AST matches.
5. Preserve incomplete/truncated GitHub query information.

### Combined report

Introduce `GitHubAstSearchReport` schema version 1:

```ts
interface GitHubAstSearchReport {
  schemaVersion: 1;
  completedAt: string;
  githubApiVersion: string;

  request: {
    packages: string[];
    scope: "file" | "repository";
    semanticMode: "structural" | "import-aware" | "strict";
  };

  pattern: {
    filePath?: string;
    sha256: string;
    schemaVersion: number;
    xmlSchemaVersion: number;
    xpathVersion: string;
    strictness: "exact" | "shape";
  };

  summary: {
    githubCandidates: number;
    packageImportFiles: number;
    astFilesScanned: number;
    xpathCandidates: number;
    semanticRejected: number;
    matchedFiles: number;
    matchedRepositories: number;
    matches: number;
  };

  hasIncompleteQueries: boolean;
  queries: GitHubPackageImportQueryStatus[];
  files: GitHubAstFileMatch[];
  repositories: GitHubAstRepositoryStatus[];
}
```

Each file result contains:

- Repository and repository-relative path.
- Blob SHA and saved output path.
- Verified package references.
- AST match ranges, kinds, offsets, and source text.
- Semantic evidence counts and mode.
- Hydrated commit when applicable.

Write the report atomically as `<out>/manifest.json`.

Text output:

```text
owner/repo:path:line:column<TAB>kind<TAB>text
```

## Phase 2: Import-Aware Matching

### Purpose

Connect matched AST identifiers to static imports from the requested package without cloning or installing the repository.

This should handle aliases such as:

```ts
import { gen as generate } from "effect/Effect";
generate(...);
```

and:

```ts
import * as Effect from "effect/Effect";
Effect.gen(...);
```

### Isolated binder

Create an isolated TypeScript program for each source blob using:

```ts
{
  allowJs: true,
  checkJs: true,
  noLib: true,
  noResolve: true,
  skipLibCheck: true
}
```

Use it to distinguish actual import bindings from:

- Shadowed local variables.
- Unrelated same-named identifiers.
- Property names not rooted in imported namespaces.
- Unbound global `require`.

### Import provenance model

Normalize candidate bindings into:

```ts
interface StaticImportProvenance {
  packageName: string;
  moduleSpecifier: string;
  importKind:
    | "named"
    | "default"
    | "namespace"
    | "import-equals"
    | "require"
    | "require-destructure";
  importedName?: string;
  accessPath: string[];
}
```

Support:

- Named imports and aliases.
- Namespace imports and member chains.
- Default imports.
- `import = require`.
- Unshadowed static `require("package")`.
- Destructured static requires.

Explicitly exclude:

- Dynamic imports.
- Re-export traversal.
- Assignment-based alias chains.
- Path aliases.
- Workspace module resolution.
- Runtime-computed properties.

### Relating provenance to the pattern

Use aligned v2 semantic facts already stored in the pattern:

- Select expected external identities whose scope is `package`.
- Extract their package root and terminal declaration name.
- At the corresponding candidate nodes, require static import provenance from one of the requested packages.
- Compare the candidate’s imported/member access path with the expected terminal symbol identity.
- Require at least one successfully checked package identity per accepted root.

Only package-scoped facts associated with the requested packages are enforced. Other external facts remain structural in this mode.

Report:

```ts
interface GitHubAstImportEvidence {
  templateNodeId: string;
  packageName: string;
  moduleSpecifier: string;
  expectedSymbol: string;
  candidateAccessPath: string[];
}
```

If the pattern contains no applicable package facts, reject import-aware matching with a clear diagnostic recommending:

- Regenerating the pattern from an example with resolvable package imports, or
- Explicitly choosing `--semantics structural`.

### CLI stabilization

At the end of Phase 2:

- Make `import-aware` the default.
- Keep `structural` explicitly available.
- Document that import-aware is deterministic but not equivalent to full TypeScript resolution.

## Phase 3: Repository Hydration and Strict Matching

### Activation and limits

Enable:

```bash
github-ast-search \
  effect \
  --pattern patterns/effect-gen.json \
  --scope repository \
  --semantics strict \
  --hydrate \
  --max-repositories 25 \
  --out corpus
```

Defaults:

- Hydration is opt-in.
- Maximum repositories: 25.
- Repository processing concurrency: 1.
- Dependency installation: disabled.
- Submodules: disabled.
- All repository operations have configurable timeouts.
- Cache hydrated repositories by repository and commit SHA.

### Pinning repositories

For every repository surviving the package-import stage:

1. Query its default branch head commit through the GitHub API.
2. Record the commit SHA in the manifest.
3. Initialize a local Git repository without a shell.
4. Fetch only that commit with depth 1 and blob filtering where supported.
5. Check it out detached.
6. Verify each original package-import file’s Git blob SHA.
7. Report and skip repositories whose indexed blob no longer matches.

Never place tokens in Git remote URLs or process arguments.

### Dependency policy

Add:

```text
--install-dependencies none|safe
```

Default: `none`.

`safe`:

- Requires a recognized lockfile.
- Uses the matching npm, pnpm, or Yarn workflow.
- Requires frozen/immutable lockfile behavior.
- Disables lifecycle scripts.
- Disables npm audit/funding requests.
- Enforces a timeout.
- Records command, package manager, status, and diagnostics.
- Never retries using a less strict install mode.

A setup failure is repository-local and does not abort other repositories.

### Tsconfig discovery

For file-scope strict matching:

1. Starting at the package-import file’s directory, find candidate tsconfigs while ascending to the repository root.
2. Try closest configs first.
3. Select the first config whose loaded project contains that file.
4. Record all rejected config candidates and reasons.

For repository scope:

1. Discover non-generated tsconfigs outside `node_modules`, build output, and VCS directories.
2. Prefer root configs and project-reference configs.
3. Load at most 20 configs by default.
4. Match every loaded project and deduplicate results by absolute file and source range.
5. Report files not covered by any config.

### Strict AST matching

Use the existing portable project matcher:

```ts
matchAstXPathPattern({
  pattern,
  cwd: repositoryRoot,
  targetTsConfigFilePath,
  semanticMode: "strict"
});
```

This enforces:

- Internal binding topology.
- Canonical package and local declaration identities.
- Mutually assignable portable types.
- Corresponding overload selection.

For repository scope, the package may be imported in one file while the pattern occurs in another. Preserve both:

- The package evidence that selected the repository.
- The files containing accepted AST matches.

### Repository statuses

Record one of:

```text
matched
no-match
setup-failed
dependency-install-failed
no-tsconfig
not-covered-by-tsconfig
source-drift
timeout
skipped-limit
```

Failures should include structured diagnostics but not abort the complete search unless GitHub discovery itself fails.

## CLI Implementation

Add:

- `src/tools/github-ast-search.ts`
- `src/tools/github-ast-search-cli.ts`
- `bin/github-ast-search-cli.js`
- `"github-ast-search"` in `package.json`
- Public exports from `src/index.ts`
- Documentation in `CLI_API.md`

CLI options:

```text
github-ast-search [options] <package> [package ...]

--pattern <file>                 Required portable AST XPath pattern
--scope <file|repository>        Default: file
--semantics <structural|import-aware|strict>
--hydrate                        Permit repository checkout
--install-dependencies <none|safe>
--max-repositories <n>           Default: 25
--max-tsconfigs <n>              Default: 20
--repo-timeout-ms <n>
--out <directory>
--format <json|text>
--pretty
--fail-empty
-h, --help
```

Reject incompatible combinations before network access.

## Testing

### Phase 1

- In-memory TS, TSX, JS, and JSX matching.
- Exact and shape patterns.
- Malformed and legacy pattern rejection.
- Candidate deduplication and source locations.
- GitHub scanner refactor preserves all existing reports and retry behavior.
- Combined report maps saved paths back to repository metadata.
- Blob-SHA pattern-result cache.
- Empty matches and exit status `2`.
- Incomplete and truncated GitHub queries remain visible.

### Phase 2

- Named import aliases.
- Namespace imports and property chains.
- Default imports.
- Import-equals and static require.
- Destructured require.
- Package subpaths.
- Shadowed identifiers.
- Unrelated same-named imports.
- Dynamic import and re-export exclusions.
- Patterns with no usable package semantic facts.
- Multiple requested packages.
- Structural matches rejected by import-aware evidence.

### Phase 3

Use local fixture Git repositories and injected GitHub/process adapters; tests must not require live GitHub or package registries.

Cover:

- Commit pinning and blob-SHA verification.
- Hydration caching.
- Repository limits and timeout.
- Nearest containing tsconfig selection.
- Project references and multiple tsconfigs.
- File versus repository scope.
- Dependency installation disabled by default.
- Safe install command construction and script disabling.
- Setup failures isolated per repository.
- Strict symbol, type, and overload acceptance/rejection.
- Cross-file repository matches.
- Match deduplication across overlapping tsconfigs.

Run after every phase:

```bash
npm run typecheck
npm test
npm run test:package
```

## Acceptance Criteria

The final workflow must:

- Find same-file structural matches without writing rejected blobs.
- Prove package import provenance in import-aware mode without repository hydration.
- Delete or relocate the original AST example project without invalidating portable patterns.
- Strictly validate hydrated projects with the target project’s checker.
- Support repository-wide package/pattern intersections.
- Preserve GitHub truncation and incomplete-search warnings.
- Produce deterministic manifests for identical GitHub responses, pattern artifacts, and hydrated commits, except for the completion timestamp.
- Never execute repository lifecycle scripts.
- Preserve the existing `github-js-ts-search` and `ast-xpath` APIs and CLI behavior.

## Assumptions

- Initial search remains limited to public GitHub code-search results and its existing result cap.
- One AST XPath pattern is supported per invocation.
- Same-file import-aware matching is the primary low-cost workflow.
- Repository scope is inherently a hydration workflow.
- Import-aware matching is intentionally narrower than TypeScript resolution.
- Strict matching is only authoritative when repository setup and tsconfig loading succeed.
- Query-anchor optimization can be added later, but will not be used as an authoritative filter because it can introduce false negatives.