# Conditional-to-Effect Schema smoke test

From this checkout:

```bash
npm run build
node scripts/test-conditional-to-effect-schema-v3.js
```

The default source directory is the sibling project's
`alternate-templating/effect-native-constrained-synthesis-v0.1.1/src`.
The script calls `convertConditionalToEffectSchemaV3` through this package's
public API. It discovers named top-level, one-argument functions that contain
throws or have a validator-like name (`validate`, `assert`, `check`, `verify`,
or `require` followed by an uppercase letter or underscore). This is a heuristic;
some candidates are operations with side effects rather than pure validators.

Each run saves `report.json` and numbered schema previews (`.ts.txt`) in a new
temporary directory and prints its location. The report includes full API
results, constraints, source locations, fallback diagnostics, and per-target
errors. Conversion failures do not stop the batch, but produce exit status 1.
Ambiguous names are reported as failures by the API.

Select specific targets or require static conversion:

```bash
node scripts/test-conditional-to-effect-schema-v3.js \
  --target requireModelValue --base-schema Schema.Unknown --mode static

node scripts/test-conditional-to-effect-schema-v3.js \
  --target validateOperationalPolicyConfiguration \
  --target validateProjectAuthorityConfiguration \
  --out /tmp/synthesis-schema-review
```

`--out` must name a new directory. Use `--source-dir` and `--tsconfig` to test
another project; explicit paths resolve from the shell's working directory.
Run with `--help` for all options.

This tests code generation, without executing target functions, typechecking
generated snippets, or establishing behavioral equivalence. The default
`Schema.Unknown` is a preview placeholder: before using a snippet, supply a
base schema that enforces the validator's input type. Runtime wrappers also
need the original validator in scope and execute it, including its side effects,
whenever validation runs. The target source files are not modified.
