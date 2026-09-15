import * as fs from "node:fs"
import * as path from "node:path"
import {
  convertConditionalToEffectSchemaV3,
  type ConversionMode,
  type ConvertConditionalToEffectSchemaV3Options,
} from "./conditional-to-effect-schema-v3"

export interface ConditionalToEffectSchemaV3CliOptions extends ConvertConditionalToEffectSchemaV3Options {
  readonly format: "code" | "json"
  readonly pretty: boolean
  readonly out?: string
}

export const CONDITIONAL_TO_EFFECT_SCHEMA_V3_HELP = `Usage:
  conditional-to-effect-schema-v3 --target <symbol> --base-schema <expr> --source <glob> [options]

Generate Effect v3 Schema refinements from a synchronous throw-based validator.
The generated snippet needs the base schema and, for wrappers, validator in scope.

Options:
  --target <symbol>              Simple or qualified validator name. Required.
  --base-schema <expression>     Schema expression to refine. Required.
  --source <glob>                Source glob. Repeatable. Required.
  --tsconfig <path>              Default: tsconfig.json.
  --exclude <substring>          Exclude matching paths. Repeatable.
  --schema-name <name>           Default: <targetName>Schema.
  --mode <static|auto|runtime-wrapper>  Default: static.
  --max-depth <integer>         Maximum local call depth. Default: 12.
  --allow-opaque-calls <true|false>  Trust uninspected calls. Default: false.
  --cwd <directory>              Resolve source/config/output paths here.
  --format <code|json>           Default: code. JSON includes diagnostics.
  --pretty                      Pretty-print JSON output.
  --out <path>                   Write output to a new file instead of stdout.
  -h, --help                     Show help.
`

export function parseConditionalToEffectSchemaV3Args(
  argv: readonly string[],
): ConditionalToEffectSchemaV3CliOptions | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true }
  const repeatable = new Set(["source", "exclude"])
  const accepted = new Set([
    ...repeatable, "target", "base-schema", "schema-name", "tsconfig", "mode",
    "max-depth", "allow-opaque-calls", "cwd", "format", "out",
  ])
  const values = new Map<string, string[]>()
  let pretty = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--pretty") { pretty = true; continue }
    const key = arg.slice(2)
    if (!arg.startsWith("--") || !accepted.has(key)) throw new Error(`Unknown option: ${arg}`)
    if (values.has(key) && !repeatable.has(key)) throw new Error(`${arg} may only be specified once`)
    const value = argv[++i]
    if (!value || value.startsWith("--") || value === "-h") throw new Error(`Missing value for ${arg}`)
    values.set(key, [...(values.get(key) ?? []), value])
  }
  const one = (key: string) => values.get(key)?.[0]
  for (const key of ["target", "base-schema", "source"]) {
    if (!one(key)) throw new Error(`Missing required option: --${key}`)
  }
  const mode = one("mode") ?? "static"
  if (!["static", "auto", "runtime-wrapper"].includes(mode)) throw new Error(`Invalid --mode: ${mode}`)
  const format = one("format") ?? "code"
  if (format !== "code" && format !== "json") throw new Error(`Invalid --format: ${format}`)
  if (pretty && format !== "json") throw new Error("--pretty requires --format json")
  const maxCallDepth = one("max-depth") === undefined ? 12 : Number(one("max-depth"))
  if (!Number.isSafeInteger(maxCallDepth) || maxCallDepth < 0) throw new Error("--max-depth requires a non-negative integer")
  const opaque = one("allow-opaque-calls") ?? "false"
  if (opaque !== "true" && opaque !== "false") throw new Error("--allow-opaque-calls requires true or false")
  return {
    target: one("target")!, baseSchema: one("base-schema")!, sourceGlob: values.get("source")!,
    schemaName: one("schema-name"), tsConfigFilePath: one("tsconfig"),
    excludePathIncludes: values.get("exclude"), cwd: one("cwd"), mode: mode as ConversionMode,
    maxCallDepth, allowOpaqueCalls: opaque === "true", format, pretty, out: one("out"),
  }
}

export function mainConditionalToEffectSchemaV3(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const options = parseConditionalToEffectSchemaV3Args(argv)
    if ("help" in options) {
      process.stdout.write(CONDITIONAL_TO_EFFECT_SCHEMA_V3_HELP)
      return 0
    }
    const resolvedCwd = path.resolve(cwd, options.cwd ?? ".")
    const result = convertConditionalToEffectSchemaV3({ ...options, cwd: resolvedCwd })
    const output = options.format === "json"
      ? `${JSON.stringify(result, null, options.pretty ? 2 : undefined)}\n`
      : result.code
    if (options.out) {
      const outputPath = path.resolve(resolvedCwd, options.out)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      // Never overwrite the validator (including through symlinks) or an existing artifact.
      fs.writeFileSync(outputPath, output, { encoding: "utf8", flag: "wx" })
    } else {
      process.stdout.write(output)
    }
    if (options.format === "code" && result.diagnostics.length > 0) {
      process.stderr.write(`${result.diagnostics.map((d) => `[${d.code}] ${d.message}`).join("\n")}\n`)
    }
    return 0
  } catch (error) {
    process.stderr.write(`conditional-to-effect-schema-v3: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
