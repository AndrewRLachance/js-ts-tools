import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createEffectSchemaSession, type EffectSchemaCandidate, type EffectSchemaPreview, type EffectSchemaSession, type EffectSchemaSessionOptions } from "./effect-schema";

export interface EffectSchemaCliOptions extends EffectSchemaSessionOptions {
  file?: string;
  symbol?: string;
  at?: { file: string; line: number; column: number };
  json: boolean;
}

export const EFFECT_SCHEMA_HELP = `Usage:
  effect-schema [--cwd <directory>] [--tsconfig <path>]
  effect-schema --file <path> --symbol <name>
  effect-schema --at <file:line:column>
  effect-schema --json [--file <path> --symbol <name> | --at <file:line:column>]

Interactively select a TypeScript declaration, preview Effect's Structural Type
to Schema refactor, and apply it. Requires the target project's TypeScript 5/6
and @effect/language-service. Uses one tsconfig without project references.

Options:
  --cwd <directory>       Base for paths. Default: current directory.
  --tsconfig <path>       Default: tsconfig.json, relative to cwd.
  --file <path>           Restrict selection to one source file.
  --symbol <name>         Select an exact name or qualified name.
  --at <file:line:column> Select the containing declaration (1-based).
  --json                 No prompts or writes. List candidates, or preview a target.
  --timeout-ms <number>   Per-server-request timeout. Default: 30000.
  -h, --help             Show this help.

Interactive commands: enter a number to select, /text to filter, n/p for pages,
b to return from a preview, a to apply a validated preview, q to quit.
JSON exit statuses: 0 success; 1 failure; 2 unavailable or validation blocked.
`;

export function parseEffectSchemaArgs(argv: readonly string[]): EffectSchemaCliOptions | { help: true } {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { if (json) throw new Error("--json may only be specified once"); json = true; continue; }
    if (!["--cwd", "--tsconfig", "--file", "--symbol", "--at", "--timeout-ms"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    if (values.has(arg)) throw new Error(`${arg} may only be specified once`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  const at = values.get("--at");
  if (at && (values.has("--file") || values.has("--symbol"))) throw new Error("--at cannot be combined with --file or --symbol");
  const match = at ? /^(.*):(\d+):(\d+)$/.exec(at) : undefined;
  if (at && (!match || !match[1] || Number(match[2]) < 1 || Number(match[3]) < 1 || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3])))) {
    throw new Error("--at must be file:line:column with positive 1-based coordinates");
  }
  const timeoutMs = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)) throw new Error("--timeout-ms must be a positive 32-bit integer");
  return {
    json, cwd: values.get("--cwd"), tsconfig: values.get("--tsconfig"), file: values.get("--file"), symbol: values.get("--symbol"), timeoutMs,
    ...(match ? { at: { file: match[1], line: Number(match[2]), column: Number(match[3]) } } : {}),
  };
}

export interface EffectSchemaCliIO {
  input: Readable;
  output: Writable;
  error: Writable;
  isTTY: boolean;
}

/** Line queue preserves pasted input and handles EOF/SIGINT while waiting or computing. */
class Terminal {
  private readonly reader: readline.Interface;
  private readonly lines: string[] = [];
  private waiting?: (value: string | undefined) => void;
  private ended = false;
  constructor(private readonly io: EffectSchemaCliIO, cancel: () => void) {
    this.reader = readline.createInterface({ input: io.input, output: io.output, terminal: io.isTTY });
    this.reader.on("line", (line) => {
      if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve(line); }
      else this.lines.push(line);
    });
    this.reader.on("close", () => {
      this.ended = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
    });
    this.reader.on("SIGINT", () => { this.lines.length = 0; this.close(); cancel(); });
  }
  async ask(prompt: string): Promise<string | undefined> {
    this.io.output.write(prompt);
    if (this.lines.length) return this.lines.shift();
    if (this.ended) return undefined;
    return new Promise((resolve) => { this.waiting = resolve; });
  }
  close(): void { this.reader.close(); }
}

function selectTarget(candidates: EffectSchemaCandidate[], options: EffectSchemaCliOptions): EffectSchemaCandidate | undefined {
  if (!options.symbol && !options.at) return undefined;
  let matches = candidates;
  if (options.symbol) matches = matches.filter((c) => c.name === options.symbol || c.qualifiedName === options.symbol);
  if (options.at) {
    const at = options.at;
    const before = (left: { line: number; column: number }, right: { line: number; column: number }) => left.line < right.line || (left.line === right.line && left.column < right.column);
    matches = matches.filter((c) => !before(at, c.range.start) && before(at, c.range.end));
  }
  if (matches.length !== 1) throw new Error(matches.length ? "Target is ambiguous. Specify --file and a qualified --symbol, or use --at." : "No interface or type alias matches the target.");
  return matches[0];
}

function displayPreview(preview: EffectSchemaPreview, io: EffectSchemaCliIO): void {
  if (!preview.available) { io.output.write(`${preview.reason}\n`); return; }
  io.output.write(`${preview.diff}\n`);
  const validation = preview.validation!;
  io.output.write(`Validation: ${validation.ok ? "passed" : "blocked"}; ${validation.baselineDiagnostics.filter((d) => d.category === "error").length} existing compiler error(s), ${validation.newErrors.length} new error(s).\n`);
  const diagnostics = validation.ok ? validation.resultingDiagnostics.filter((d) => d.category === "error") : validation.newErrors;
  for (const diagnostic of diagnostics) io.output.write(`${diagnostic.filePath ?? "Project"}${diagnostic.line ? `:${diagnostic.line}:${diagnostic.column}` : ""} TS${diagnostic.code}: ${diagnostic.message}\n`);
}

export async function mainEffectSchema(
  argv: readonly string[] = process.argv.slice(2),
  io: EffectSchemaCliIO = { input: process.stdin, output: process.stdout, error: process.stderr, isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY },
): Promise<number> {
  let session: EffectSchemaSession | undefined;
  let terminal: Terminal | undefined;
  let cancelled = false;
  let json = argv.includes("--json");
  const cancel = () => { cancelled = true; terminal?.close(); void session?.close(); };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const options = parseEffectSchemaArgs(argv);
    if ("help" in options) { io.output.write(EFFECT_SCHEMA_HELP); return 0; }
    json = options.json;
    if (!json && !io.isTTY) throw new Error("Interactive mode requires a terminal. Use --json for read-only discovery or preview.");
    if (!json) { terminal = new Terminal(io, cancel); io.output.write("Loading project and Effect refactor…\n"); }
    session = await createEffectSchemaSession(options);
    if (cancelled) return 130;
    const query = { filePath: options.at?.file ?? options.file };
    let candidates = await session.listCandidates(query);
    let selected = selectTarget(candidates, options);
    if (json) {
      if (!selected) { io.output.write(`${JSON.stringify({ project: session.project, candidates }, null, 2)}\n`); return 0; }
      const preview = await session.preview(selected.id);
      io.output.write(`${JSON.stringify({ project: session.project, preview }, null, 2)}\n`);
      return preview.available && preview.validation?.ok ? 0 : 2;
    }
    io.output.write(`Project: ${session.project.tsconfig}\n`);
    let filter = "";
    let page = 0;
    while (!cancelled) {
      if (selected) {
        try {
          const preview = await session.preview(selected.id);
          if (cancelled) break;
          displayPreview(preview, io);
          while (!cancelled) {
            const canApply = preview.available && preview.validation?.ok;
            const answer = (await terminal!.ask(canApply ? "[a] Apply, [b] Back, [q] Quit: " : "[b] Back, [q] Quit: "))?.trim().toLowerCase();
            if (answer === undefined || answer === "q") return 0;
            if (answer === "b" || answer === "") break;
            if (answer === "a" && canApply) {
              const result = await session.apply(preview.id);
              io.output.write(`Applied changes to ${result.filePaths.length} file(s).\n`);
              break;
            }
            io.output.write("Choose one of the displayed actions.\n");
          }
        } catch (error) {
          if (cancelled) break;
          io.error.write(`effect-schema: ${error instanceof Error ? error.message : error}\n`);
        }
        selected = undefined;
      }
      if (cancelled) break;
      candidates = await session.listCandidates(query);
      const filtered = candidates.filter((c) => `${c.qualifiedName} ${c.filePath}`.toLowerCase().includes(filter.toLowerCase()));
      const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
      page = Math.min(page, pageCount - 1);
      io.output.write(`\nDeclarations (${filtered.length}), page ${page + 1}/${pageCount}${filter ? `, filter: ${filter}` : ""}\n`);
      filtered.slice(page * 20, page * 20 + 20).forEach((candidate, i) => {
        io.output.write(`${page * 20 + i + 1}. ${candidate.qualifiedName}${candidate.generic ? " <generic>" : ""} — ${path.relative(session!.project.cwd, candidate.filePath)}:${candidate.line}:${candidate.column}\n`);
      });
      const answer = (await terminal!.ask("Number, /filter (/ clears), n/p, or q: "))?.trim();
      if (answer === undefined || answer.toLowerCase() === "q") return 0;
      if (answer.startsWith("/")) { filter = answer.slice(1); page = 0; continue; }
      if (answer.toLowerCase() === "n") { page = Math.min(page + 1, pageCount - 1); continue; }
      if (answer.toLowerCase() === "p") { page = Math.max(page - 1, 0); continue; }
      const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1;
      selected = filtered[index];
      if (!selected) io.output.write("Enter a declaration number or a displayed command.\n");
    }
    return 130;
  } catch (error) {
    if (cancelled) return 130;
    const message = error instanceof Error ? error.message : String(error);
    if (json) io.output.write(`${JSON.stringify({ error: message })}\n`);
    else io.error.write(`effect-schema: ${message}\n`);
    return 1;
  } finally {
    terminal?.close();
    await session?.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
