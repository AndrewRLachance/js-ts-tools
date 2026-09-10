import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import {
  DEFAULT_MAX_CONTINUATION_BYTES,
  convertTsPattern,
  type ConvertTsPatternOptions,
  type TsPatternCandidateReport,
  type TsPatternConversionReport,
} from "./convert-ts-pattern";

export type ConvertTsPatternOutputFormat = "json" | "text";

export interface ConvertTsPatternCliOptions extends ConvertTsPatternOptions {
  format: ConvertTsPatternOutputFormat;
  pretty: boolean;
  out?: string;
}

export const CONVERT_TS_PATTERN_HELP = `Usage:
  convert-ts-pattern --source <glob> [options]

Convert deterministic TypeScript conditionals to ts-pattern match expressions.
Source files are never modified unless --write is supplied.

Options:
  --source <glob>                Source glob. Repeatable. Required.
  --tsconfig <path>              TypeScript config. Default: tsconfig.json.
  --exclude <substring>          Exclude matching paths. Repeatable.
  --max-continuation-bytes <n>   Maximum duplicated continuation bytes per file. Default: 16384.
  --dry-run                      Preview validated conversions (default).
  --write                        Apply validated conversions.
  --format <json|text>           Report format. Default: json.
  --pretty                       Pretty-print JSON output.
  --out <path>                   Write the report to a file.
  -h, --help                     Show this help message.

Examples:
  convert-ts-pattern --source "src/**/*.ts" --pretty
  convert-ts-pattern --tsconfig tsconfig.json --source "src/**/*.ts" --write
`;

export function parseConvertTsPatternArgs(
  argv: string[],
): ConvertTsPatternCliOptions | { help: true } {
  if (argv.includes("-h") || argv.includes("--help")) return { help: true };
  const sources: string[] = [];
  const excludes: string[] = [];
  let tsConfigFilePath: string | undefined;
  let write = false;
  let explicitDryRun = false;
  let format: ConvertTsPatternOutputFormat = "json";
  let pretty = false;
  let out: string | undefined;
  let maxContinuationBytes = DEFAULT_MAX_CONTINUATION_BYTES;
  let explicitMaxContinuationBytes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--source":
        sources.push(requireValue(argv, ++index, arg));
        break;
      case "--tsconfig":
        if (tsConfigFilePath !== undefined) throw new Error("--tsconfig may only be specified once");
        tsConfigFilePath = requireValue(argv, ++index, arg);
        break;
      case "--exclude":
        excludes.push(requireValue(argv, ++index, arg));
        break;
      case "--max-continuation-bytes": {
        if (explicitMaxContinuationBytes) throw new Error("--max-continuation-bytes may only be specified once");
        const value = argv[++index];
        if (value === undefined) throw new Error(`${arg} requires a value`);
        maxContinuationBytes = parseNonNegativeInteger(value, arg);
        explicitMaxContinuationBytes = true;
        break;
      }
      case "--dry-run":
        if (explicitDryRun) throw new Error("--dry-run may only be specified once");
        explicitDryRun = true;
        break;
      case "--write":
        if (write) throw new Error("--write may only be specified once");
        write = true;
        break;
      case "--format": {
        const value = requireValue(argv, ++index, arg);
        if (value !== "json" && value !== "text") throw new Error(`invalid --format: ${value}`);
        format = value;
        break;
      }
      case "--pretty":
        pretty = true;
        break;
      case "--out":
        if (out !== undefined) throw new Error("--out may only be specified once");
        out = requireValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (sources.length === 0) throw new Error("missing required option: --source <glob>");
  if (write && explicitDryRun) throw new Error("--dry-run and --write are mutually exclusive");
  if (pretty && format !== "json") throw new Error("--pretty is only valid with --format json");
  return {
    sourceGlob: sources.length === 1 ? sources[0] : sources,
    ...(tsConfigFilePath ? { tsConfigFilePath } : {}),
    ...(excludes.length > 0 ? { excludePathIncludes: excludes } : {}),
    write,
    maxContinuationBytes,
    format,
    pretty,
    ...(out ? { out } : {}),
  };
}

export function runConvertTsPattern(
  options: ConvertTsPatternCliOptions,
  cwd = process.cwd(),
  converter = convertTsPattern,
): number {
  if (options.write && options.out) assertReportDoesNotOverwriteSource(options, cwd);
  const { format, pretty, out, ...conversionOptions } = options;
  const report = converter({ ...conversionOptions, cwd });
  emit(formatConvertTsPatternReport(report, format, pretty), out, cwd);
  return 0;
}

export function formatConvertTsPatternReport(
  report: TsPatternConversionReport,
  format: ConvertTsPatternOutputFormat,
  pretty = false,
): string {
  if (format === "json") return `${JSON.stringify(report, null, pretty ? 2 : undefined)}\n`;
  const lines: string[] = [];
  for (const file of report.files) {
    for (const candidate of file.candidates) lines.push(...formatCandidate(candidate));
  }
  lines.push(
    `${report.query.mode}: ${report.summary.candidates} candidate(s), ${report.summary.converted} converted, ` +
    `${report.summary.skipped} skipped, ${report.summary.filesChanged} file(s) changed`,
  );
  return `${lines.join("\n")}\n`;
}

export function mainConvertTsPattern(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const options = parseConvertTsPatternArgs(argv);
    if ("help" in options) {
      process.stdout.write(CONVERT_TS_PATTERN_HELP);
      return 0;
    }
    return runConvertTsPattern(options, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`convert-ts-pattern: ${message}\n`);
    return 1;
  }
}

function formatCandidate(candidate: TsPatternCandidateReport): string[] {
  const lines = [`${candidate.filePath}:${candidate.start.line}:${candidate.start.column}  ${candidate.kind}`];
  if (candidate.subject) lines.push(`  subject: ${candidate.subject}`);
  if (candidate.discriminator) lines.push(`  discriminator: ${candidate.discriminator}`);
  if (candidate.discriminators && candidate.discriminators.length > 1) {
    lines.push(`  discriminators: ${candidate.discriminators.join(", ")}`);
  }
  lines.push(`  branches: ${candidate.branchCount}`, `  action: ${candidate.action}`);
  if (candidate.terminator) lines.push(`  terminator: ${candidate.terminator}`);
  if (candidate.fallbackKind) lines.push(`  fallback-kind: ${candidate.fallbackKind}`);
  if (candidate.reasonCode) lines.push(`  reason-code: ${candidate.reasonCode}`);
  if (candidate.reason) lines.push(`  reason: ${candidate.reason}`);
  return [...lines, ""];
}

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} requires a non-negative integer`);
  }
  return parsed;
}

function emit(output: string, out: string | undefined, cwd: string): void {
  if (!out) {
    process.stdout.write(output);
    return;
  }
  const outputPath = path.resolve(cwd, out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, "utf8");
}

function assertReportDoesNotOverwriteSource(options: ConvertTsPatternCliOptions, cwd: string): void {
  const outputPath = canonicalPath(path.resolve(cwd, options.out!));
  const outputRealPath = fs.existsSync(path.resolve(cwd, options.out!))
    ? canonicalPath(fs.realpathSync(path.resolve(cwd, options.out!)))
    : undefined;
  const sourcePatterns = Array.isArray(options.sourceGlob) ? options.sourceGlob : [options.sourceGlob];
  const exclusions = options.excludePathIncludes ?? [];
  const sourceFiles = fg.sync(sourcePatterns, { cwd, absolute: true, onlyFiles: true, unique: true });
  for (const sourceFile of sourceFiles) {
    const absolute = canonicalPath(sourceFile);
    const relative = path.relative(cwd, sourceFile).replace(/\\/g, "/");
    if (exclusions.some((part) => absolute.includes(part) || relative.includes(part))) continue;
    const sourceRealPath = fs.existsSync(sourceFile) ? canonicalPath(fs.realpathSync(sourceFile)) : undefined;
    if (absolute === outputPath || (outputRealPath && sourceRealPath === outputRealPath)) {
      throw new Error("--out cannot overwrite a selected source file");
    }
  }
}

function canonicalPath(fileName: string): string {
  const resolved = path.resolve(fileName);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
