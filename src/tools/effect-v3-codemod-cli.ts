import * as fs from "node:fs";
import * as path from "node:path";
import { runEffectCodemod, type EffectCodemodOptions } from "./effect-v3-codemod";
import { ALL_EFFECT_TARGETS, type EffectTarget } from "./effect-codemod/contracts/effect-target";

export interface EffectCodemodCliOptions extends EffectCodemodOptions {
  readonly pretty: boolean;
  readonly out?: string;
}

export const EFFECT_CODEMOD_HELP = `Usage:
  effect-v3-codemod --source <glob> [options]

Convert proven TypeScript idioms to Effect v3 operators. Default: dry run.
Validation checks proposed edits in memory without writing source files.

Options:
  --source <glob>          Source glob. Repeatable. Required.
  --tsconfig <path>        Default: tsconfig.json.
  --exclude <substring>    Exclude matching paths. Repeatable.
  --target <operator>      Restrict Effect targets (e.g. map, asVoid). Repeatable.
  --cwd <directory>        Resolve project and output paths here.
  --dry-run               Report validated changes without committing (default).
  --write                 Commit changes only when validation succeeds.
  --no-review             Omit review-only candidates from the report.
  --pretty                Pretty-print the JSON report.
  --evidence <compact|full>  Report evidence detail. Default: compact.
  --max-passes <1..10>     Maximum validated passes. Default: 3.
  --out <path>            Write the report to a new file instead of stdout.
  -h, --help              Show help.
`;

export function parseEffectCodemodArgs(argv: readonly string[]): EffectCodemodCliOptions | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const sources: string[] = [];
  const excludes: string[] = [];
  const targets: EffectTarget[] = [];
  const singles = new Map<string, string>();
  let write = false;
  let dryRun = false;
  let pretty = false;
  let includeReview = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write") { write = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--pretty") { pretty = true; continue; }
    if (arg === "--no-review") { includeReview = false; continue; }
    if (!["--source", "--exclude", "--target", "--tsconfig", "--cwd", "--out", "--evidence", "--max-passes"].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value`);
    if (arg === "--source") sources.push(value);
    else if (arg === "--exclude") excludes.push(value);
    else if (arg === "--target") {
      if (!ALL_EFFECT_TARGETS.includes(value as EffectTarget)) throw new Error(`Unknown Effect target: ${value}`);
      targets.push(value as EffectTarget);
    } else {
      if (singles.has(arg)) throw new Error(`${arg} may only be specified once`);
      singles.set(arg, value);
    }
  }
  if (!sources.length) throw new Error("Missing required option: --source <glob>");
  if (write && dryRun) throw new Error("--write and --dry-run are mutually exclusive");
  const evidence = singles.get("--evidence") ?? "compact";
  const maxPasses = Number(singles.get("--max-passes") ?? "3");
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 10) throw new Error("--max-passes must be an integer from 1 through 10");
  if (evidence !== "compact" && evidence !== "full") throw new Error("--evidence must be compact or full");
  return {
    sources, write, pretty, includeReview, evidence, maxPasses,
    ...(excludes.length ? { excludes } : {}),
    ...(targets.length ? { targets } : {}),
    ...(singles.has("--tsconfig") ? { tsconfig: singles.get("--tsconfig")! } : {}),
    ...(singles.has("--cwd") ? { cwd: singles.get("--cwd")! } : {}),
    ...(singles.has("--out") ? { out: singles.get("--out")! } : {}),
  };
}

export function mainEffectCodemod(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const options = parseEffectCodemodArgs(argv);
    if ("help" in options) {
      process.stdout.write(EFFECT_CODEMOD_HELP);
      return 0;
    }
    const resolvedCwd = path.resolve(cwd, options.cwd ?? ".");
    const outputPath = options.out ? path.resolve(resolvedCwd, options.out) : undefined;
    // Reserve output before any commit, so an invalid destination cannot fail after --write.
    let outputFd: number | undefined;
    let outputIdentity: fs.Stats | undefined;
    let outputComplete = false;
    try {
      if (outputPath) {
        if (/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(outputPath)) {
          throw new Error("--out must not be a JavaScript or TypeScript source file; use a JSON report path.");
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        outputFd = fs.openSync(outputPath, "wx");
        outputIdentity = fs.fstatSync(outputFd);
      }
      const report = runEffectCodemod({ ...options, cwd: resolvedCwd });
      const output = `${JSON.stringify(report, null, options.pretty ? 2 : undefined)}\n`;
      if (outputFd !== undefined) fs.writeFileSync(outputFd, output, "utf8");
      else process.stdout.write(output);
      outputComplete = true;
      return report.validation.ok ? 0 : 1;
    } finally {
      if (outputFd !== undefined) fs.closeSync(outputFd);
      if (!outputComplete && outputPath && outputIdentity) {
        // Remove only the file reserved by this run, never a concurrently replaced path.
        const current = fs.lstatSync(outputPath, { throwIfNoEntry: false });
        if (current?.dev === outputIdentity.dev && current.ino === outputIdentity.ino) fs.unlinkSync(outputPath);
      }
    }
  } catch (error) {
    process.stderr.write(`effect-v3-codemod: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
