# Effect v3 codemod

This module is a conservative TypeScript codemod that discovers source idioms, proves their bindings and types with `js-ts-tools`, and rewrites only mechanically established equivalents to Effect v3 operators.

Phase 11 completes the original requested target set. **All 50 originally requested Effect operators have production rules, plus generator-to-`flatMap` conversion and a review-only `orElseFail` suggestion (52 targets total).** Automatic coverage recognizes deliberately narrow source idioms; it does **not** mean arbitrary programs with equivalent runtime behavior will be inferred or rewritten.

## Pipeline

```text
Selected source snapshot + compiler session
        ↓
Structural discovery + normalized calls + TypeModel proofs
        ↓
Rule analysis + bounded helper summaries
        ↓
Compatible edits + import reconciliation
        ↓
In-memory TypeScript validation
        ↓
Refresh and repeat (up to three passes by default)
        ↓
Source freshness check + dry-run report / guarded commit
```

The semantic layer resolves call sites through the typed `js-ts-tools` TypeModel tables and verifies concrete module ownership, signatures, result types, and TypeScript-library methods. TypeModel call sites are point locations, so call correlation uses canonical file + start location and, when needed, the AST callee name as a secondary discriminator. Normalized application views retain original operand locations and separate compiler-proven application facts. Custom adapters can still supply AST-XPath evidence through the legacy single-pass pipeline.

## Complete target coverage

### Collecting

`all`, `allSuccesses`, `allWith`, `dropUntil`, `dropWhile`, `findFirst`, `head`, `mergeAll`, `reduce`, `reduceEffect`, `reduceRight`, `reduceWhile`, `replicateEffect`, `takeUntil`, `takeWhile`

### Condition checking

`every`, `exists`, `isFailure`, `isSuccess`, `liftPredicate`

### Conditional operators

`unless`, `unlessEffect`, `when`, `whenEffect`, `whenFiberRef`, `whenRef`

### Filtering

`filter`, `filterEffectOrElse`, `filterEffectOrFail`, `filterMap`, `filterOrDie`, `filterOrDieMessage`, `filterOrElse`, `filterOrFail`

### Looping

`forEach`, `iterate`, `loop`

### Mapping / channel operators

`as`, `asSome`, `asSomeError`, `asVoid`, `flatMap`, `flip`, `flipWith`, `map`, `mapAccum`, `mapBoth`, `mapError`, `mapErrorCause`, `merge`, `negate`

The CLI consumes a single `PRODUCTION_RULES` registry assembled from every rule batch. A registry-completeness regression test compares that registry with `ALL_EFFECT_TARGETS`, preventing a requested target from being silently dropped later.

## Common pipeline improvements

Both data-first and curried forms are supported for these conversions:

```ts
Effect.flatMap(value => Effect.succeed(value + 1)) // → Effect.map(value => value + 1)
Effect.catchAll(error => Effect.fail(error.message)) // → Effect.mapError(error => error.message)
Effect.map(() => 123) // → Effect.as(123)
Effect.map(() => void 0) // → Effect.asVoid
```

Rules share normalized data-first, curried, and applied-curried operands. Supported `.pipe(...)` and imported `pipe(...)` sequences also expose their preceding operations to composition rules. For example, a curried validation can become `filterOrFail`, and a `findFirst` followed by an `Option.isSome` mapping can become `exists`. Pipeline operands must be inert before a rewrite can reorder their construction. Source-dependent recipes are considered only when their required source is available.

Async map callbacks remain unchanged: even a literal or empty body produces a Promise.

`Effect.mapError(() => makeError())` produces a **review-only** suggestion for `Effect.orElseFail(() => makeError())`. Both keep the error factory lazy, but their compound-cause and interruption behavior differs. In particular, a cause containing both a typed failure and a defect can invoke the mapper while `orElseFail` preserves defects. The codemod never applies this suggestion, including with `--write`. Callbacks taking the original error, or function expressions that could inspect `arguments`, are excluded. See the official [map](https://effect.website/docs/v3/api/effect/Effect#map), [flatMap](https://effect.website/docs/v3/api/effect/Effect#flatMap), and [orElseFail](https://effect.website/docs/v3/api/effect/Effect#orElseFail) APIs.

## Interpreting skips

Candidate counts describe rule decisions, not unique source expressions or missing conversions. Top-level candidates contain accepted conversion history and the last pass’s outstanding decisions; `passes` contains every pass’s attempts. Discovery matches the immediate callee of supported shapes; an `Effect.gen` block containing `Effect.map` is not itself a map candidate. Native database operations, transactions and arbitrary generator bodies are not automatically rewritten. Effect imports are resolved by symbol: renamed `Effect` imports, namespace imports from `effect/Effect`, and direct function imports are supported. Rendering reuses visible namespace bindings or inserts a collision-free named import. Shadowed names, computed calls and ambiguous bindings are rejected.

Reports include candidate line/column locations, `pass`, `reasonCode`, proof obligations, and `summary.skipReasons`, grouped by reason and sorted by frequency. Locations refer to the input of the reported pass, which can include earlier generated code. Reason codes distinguish unsupported shapes, missing proof, semantic differences, overlap deferral, analysis limits, validation failures and non-applicable patterns. Evidence defaults to `compact`: exact call identities and proof facts remain, while contained-call compiler records are omitted. Use `--evidence full` (or `evidence: "full"` in the API) when investigating semantic matching.

## Generator and helper analysis

An adjacent yielded `const` and failure guard can be rewritten inside its existing generator:

```ts
const row = yield* load();
if (row === undefined) return yield* Effect.fail(missing());
// becomes:
const row = yield* Effect.filterOrFail(load(), row => !(row === undefined), row => missing());
```

The failure branch must contain only `return yield* Effect.fail(error)`. Truthiness, nullish checks, primitive comparisons and boolean combinations are supported. Error construction stays lazy; references to the yielded value bind to the callback parameter. A separate compiler probe rejects lost type narrowing as a review suggestion. Extra failure statements, comment-bearing guard ranges, mutation and try/catch/finally boundaries remain unchanged. Captures created before the guard also prevent conversion because delaying initialization of the yielded binding can change temporal-dead-zone behavior.

Two-statement, receiver-free generators containing a yielded declaration and return can become suspended `map` or `flatMap` compositions. Source construction stays deferred. A generator loop over an inline dense array with exactly one delegated Effect yield can become `forEach` with `{ concurrency: 1, discard: true }`. Sparse/spread arrays, custom iterables and control transfers are excluded. Local guard and loop rewrites preserve a generator’s bound receiver.

Single-return callback blocks use the same rules as expression callbacks. Ordinary comments are retained; moving TypeScript comment directives requires review. Async callbacks stay unchanged.

Helper analysis follows synchronous single-return function declarations and immutable function constants, including imports between selected files. It can summarize `succeed`/`fail` and primitive `map`/`flatMap`/`mapError`/`catchAll` compositions. Inert primitive arguments and accessible immutable literal captures are required. Generated callbacks bind arguments once in their original order, including unused arguments, and retain reads of function constants and captured values. Compositions preserve intermediate evaluation even when a later callback ignores its input. Inaccessible function constants cannot be expanded because their initialization reads cannot be preserved. Helper declarations are never edited by tracing. Reassignment, dynamic dispatch, receiver dependence, default/rest parameters, recursion and unsupported captures prevent expansion. Limits are three helper edges and 200 visited AST nodes per candidate; results are memoized within each source version.

## Repeated passes and compatibility

The CLI and `runEffectCodemod` default to three passes. Set `--max-passes 1` or `maxPasses: 1` for a single pass; integers from 1 through 10 are accepted.

Each pass selects complete rule plans in ascending replacement-width order, breaking ties by rule ID and candidate ID. Overlapping plans are deferred. The full selected batch, including imports, is validated in memory before the next pass. One validation failure prevents all disk writes, including changes from earlier passes. Repeated source hashes identify a cycle and also prevent writes.

`summary.passes`, `summary.converged` and `summary.stopReason` distinguish an unchanged result, a pass limit, validation failure and a cycle. Reaching the limit may commit validated edits, but reports `converged: false`. Review suggestions are never applied by later passes or `--write`.

The low-level `EffectCodemod` retains a one-pass default for existing custom adapters. Multiple passes require its optional `analysisSession` capability; requesting them without it throws before mutation. The built-in session keeps selected source text and compiler views in memory and verifies the original selected files before committing. Intermediate source coordinates are never used as final disk edit offsets; final file edits are composed against the original snapshot.

## Phase 11 rules

### `flipWith`

Recognized source shape:

```ts
Effect.flip(transform(Effect.flip(self)))
```

Rewritten to:

```ts
Effect.flipWith(self, transform)
```

The rule requires both `flip` calls to resolve to Effect, the intermediate transform call to return an Effect, and both `transform` and `self` to be simple identifiers. The identifier restriction prevents the rewrite from changing observable JavaScript evaluation order between callee lookup and argument construction.

### `iterate`

Recognizes one explicit, suspended unrolling of the Effect v3 recursive state machine:

```ts
Effect.suspend(() =>
  predicate(initial)
    ? Effect.flatMap(body(initial), (next) =>
        Effect.iterate(next, {
          while: (value) => predicate(value),
          body: (value) => body(value)
        }))
    : Effect.succeed(initial)
)
```

The rewrite collapses the duplicated head step but deliberately **retains `Effect.suspend`**:

```ts
Effect.suspend(() =>
  Effect.iterate(initial, {
    while: (value) => predicate(value),
    body: (value) => body(value)
  })
)
```

Current automatic conversion requires a primitive-literal initial value plus simple predicate/body identifiers. This avoids turning execution-time property/getter/mutable reads into construction-time reads.

### `loop`

Recognizes the non-discard recursive lowering where the current body result is prepended to the recursively collected tail:

```ts
Effect.suspend(() =>
  predicate(initial)
    ? Effect.flatMap(body(initial), (head) =>
        Effect.map(
          Effect.loop(step(initial), {
            while: (value) => predicate(value),
            step: (value) => step(value),
            body: (value) => body(value)
          }),
          (rest) => [head, ...rest]
        ))
    : Effect.succeed([])
)
```

The rewrite produces a suspended `Effect.loop(initial, options)`. The collector must be exactly `[head, ...rest]`; reversed or mutated collectors are rejected because they change output order or state semantics.

### `mapAccum`

Recognizes a suspended immutable tuple accumulator built from `Effect.reduce`:

```ts
Effect.suspend(() =>
  Effect.reduce(
    items,
    [initial, []],
    (acc, value, index) =>
      Effect.map(step(acc[0], value, index), (pair) => [
        pair[0],
        [...acc[1], pair[1]]
      ])
  )
)
```

Rewritten to:

```ts
Effect.suspend(() =>
  Effect.mapAccum(
    items,
    initial,
    (state, value, index) => step(state, value, index)
  )
)
```

The state machine must be immutable and exact: the accumulator is `[state, outputs]`, the step returns an Effect, the next state is `pair[0]`, and the emitted value is appended as `pair[1]`. Mutation such as `acc[1].push(...)` is rejected.

## Safety model

The project remains dry-run first. Rules never convert from syntax names alone; automatic rewrites require the relevant semantic evidence. Import edits and expression edits are planned together, applied to an isolated in-memory TypeScript project, and rejected when they introduce diagnostics. Source bytes are checked before and after validation and again before commit. Failed commits attempt to restore every affected file, verify the restored bytes, and report any rollback failures together with the original error.

Rule specializations also explicitly defer overlapping shapes—for example `filterEffectOrElse` vs `filterEffectOrFail`, `filterOrElse` vs die/fail variants, and `reduceEffect` vs `mergeAll`—so one source range cannot be claimed by two production rules.

## Project layout

```text
src/tools/effect-codemod/
  adapters/       local analysis APIs and filesystem adapters
  contracts/      codemod contracts; TypeModel aliases use the shared types
  core/           pipeline, registry, transactions, semantic correlation
  rules/          production conversion rules and shared helpers
  index.ts        advanced API barrel
src/tools/effect-v3-codemod.ts       production API with default adapters
src/tools/effect-v3-codemod-cli.ts   argument parsing and CLI entry point
bin/effect-v3-codemod-cli.js         installed command wrapper
test/effect-codemod/                migrated rule and pipeline tests
test/effect-v3-codemod-cli.test.js   real-project adapter and CLI tests
```

The implementation uses the repository's CommonJS/Node16 build, TypeScript and Node declarations. It needs no separate package installation, peer dependency on itself, ambient shims or nested tsconfig. The root build emits it into `dist/tools/` with the other tools.

## Running

Build and test from the repository root:

```bash
npm run typecheck
npm test
```

Preview changes from the checkout:

```bash
node bin/effect-v3-codemod-cli.js --source 'src/**/*.ts' --pretty
```

After installing or linking `js-ts-tools`, use the installed command. Source selection is required; targets are optional and repeatable:

```bash
effect-v3-codemod --source 'src/**/*.ts' --target map --target asVoid --pretty
effect-v3-codemod --cwd /path/to/project --source 'src/**/*.ts' --write
```

Output is a JSON report. `--evidence compact|full` controls proof detail. `--out <path>` writes a new report file and refuses to overwrite existing files or create JavaScript/TypeScript source files. Reserved reports are removed if analysis fails. `--tsconfig` defaults to `tsconfig.json`; config, source and output paths resolve against `--cwd` or the working directory. `--exclude` accepts repeatable path fragments. `--no-review` omits review-only candidates. `--dry-run` and `--write` are mutually exclusive. Exit status is `0` for successful validation or help, and `1` for invalid options, failed validation or I/O errors.

Default validation never writes source files: it checks proposed edits through TypeModel source-text overrides in a fresh in-memory project. Previews preserve source bytes and timestamps. Only `--write` commits validated changes. The advanced `TransactionalValidationPort` remains available for custom semantic adapters without overlay support; that compatibility validator temporarily stages files on disk.

## Programmatic API

```ts
import { runEffectCodemod } from "js-ts-tools";

const report = runEffectCodemod({
  cwd: "/path/to/project",
  tsconfig: "tsconfig.json",
  sources: ["src/**/*.ts"],
  targets: ["map", "asVoid"],
  write: false,
});
console.log(report.summary);
```

`runEffectCodemod` returns `EffectCodemodReport` and accepts `EffectCodemodOptions`. Programmatic sources default to `src/**/*.ts` and `src/**/*.tsx`. `effectCodemod`, exported from the package root, exposes the advanced `EffectCodemod`, `RuleRegistry`, `PRODUCTION_RULES`, contracts and adapters for custom pipelines.

The original 95 rule/pipeline tests run alongside the repository tests. Integration tests exercise the real Effect declarations, nested configuration paths, read-only previews, committed edits, idempotence, exclusions and import reconciliation. Failure tests cover source changes during validation, partial commit failures, incomplete rollback and report cleanup.

## Persistence snapshot validation

The 2026-09-12 isolated snapshot dry run selected 23 persistence source files. The expanded codemod proposed 23 conversions across six files, compared with zero automatic conversions in the previous report. These were 22 adjacent guards converted to `filterOrFail` and one dense-array traversal converted to sequential `forEach`.

Of the snapshot's 36 adjacent yield/failure guards, 22 converted, five remained review-only because downstream narrowing could not be preserved, and nine used unsupported condition operations, including dynamic digest calls. The other 31 review decisions remained `orElseFail` suggestions. There were 141 outstanding skipped rule decisions across the broader discovery set; these counts describe attempts, not distinct expressions.

The run converged after two passes (23 accepted conversions in pass 1, none in pass 2), introduced no new diagnostics, and took 168.07 seconds wall time. This is one local measurement with other work running, not a controlled performance benchmark. All selected source bytes still matched the initial snapshot hash after the dry run. The live persistence project was not written to.

The full repository suite passed 272 tests. Reduced persistence regressions cover deadline checks, prepared-request digests, active-tree comparisons, lineage-state narrowing, and dynamic digest conditions. Runtime tests additionally cover values, failures, defects, interruption, event order, laziness, receivers, and initialization boundaries. These checks do not substitute for the live application's full runtime suite.

## Next development phase

There are no remaining requested target gaps. The next useful work is **precision and corpus hardening** rather than adding operator names: build representative real-world fixture corpora, generate/curate AST-XPath patterns for additional source variants, measure precision/recall per rule, and expand accepted idioms only when evaluation-order and type equivalence can still be proved.
