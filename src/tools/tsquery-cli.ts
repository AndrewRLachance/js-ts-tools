import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { match, parse, project } from '@phenomnomnominal/tsquery';

export type OutputFormat = 'json' | 'text';

export type MutationAction =
  | { kind: 'delete' }
  | { kind: 'insert-before'; text: string }
  | { kind: 'insert-after'; text: string };

export interface CliOptions {
  selector: string;
  tsconfig: string;
  sources: string[];
  excludes: string[];
  includeDeclarations: boolean;
  format: OutputFormat;
  pretty: boolean;
  out?: string;
  failEmpty: boolean;
  write: boolean;
  mutation?: MutationAction;
}

export interface MatchLocation {
  line: number;
  column: number;
}

export interface MatchRecord {
  filePath: string;
  kind: string;
  start: MatchLocation;
  end: MatchLocation;
  startOffset: number;
  endOffset: number;
  text: string;
}

interface InternalMatch {
  sourceFile: ts.SourceFile;
  node: ts.Node;
  record: MatchRecord;
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

export interface MutationFileReport {
  filePath: string;
  matchCount: number;
  editCount: number;
}

export interface MutationReport {
  selector: string;
  action: MutationAction['kind'];
  written: boolean;
  matchCount: number;
  editCount: number;
  files: MutationFileReport[];
  matches: MatchRecord[];
}

export const HELP = `Usage:
  tsquery <selector> [options]

Query a TypeScript project's AST with @phenomnomnominal/tsquery.

Options:
  --tsconfig <path>              TypeScript config. Default: tsconfig.json.
  --source <glob>                Restrict project files by glob. Repeatable.
  --exclude <substring>          Exclude paths containing the substring. Repeatable.
  --include-declarations         Include .d.ts/.d.mts/.d.cts files.
  --format <json|text>           Output format. Default: json.
  --pretty                       Pretty-print JSON output.
  --out <path>                   Write command output to a file.
  --fail-empty                   Exit with status 2 when no AST nodes match.

Mutations (mutually exclusive):
  --delete                       Delete every matched node.
  --insert-before <text>         Insert text immediately before every match.
  --insert-after <text>          Insert text immediately after every match.
  --insert-before-file <path>    Insert UTF-8 file contents before every match.
  --insert-after-file <path>     Insert UTF-8 file contents after every match.
  --write                        Apply the mutation to source files. Without this,
                                 mutation commands only report the planned edits.

Other:
  -h, --help                     Print help.

Examples:
  tsquery 'CallExpression > Identifier[name="fetch"]' --pretty
  tsquery 'ImportDeclaration:has(StringLiteral[text="lodash"])' --delete --source 'src/**/*.ts'
  tsquery 'ImportDeclaration:has(StringLiteral[text="lodash"])' --delete --source 'src/**/*.ts' --write
  tsquery 'MethodDeclaration:has(Identifier[name="execute"])' --insert-before-file snippets/decorator.ts --write
`;

function requireValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value == null) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function setMutation(current: MutationAction | undefined, next: MutationAction): MutationAction {
  if (current) {
    throw new Error('mutation options are mutually exclusive');
  }
  return next;
}

function readSnippetFile(filePath: string, cwd: string): string {
  const resolved = path.resolve(cwd, filePath);
  const text = fs.readFileSync(resolved, 'utf8');
  if (text.length === 0) {
    throw new Error(`snippet file is empty: ${filePath}`);
  }
  return text;
}

export function parseArgs(argv: string[], cwd = process.cwd()): CliOptions | { help: true } {
  if (argv.includes('-h') || argv.includes('--help')) {
    return { help: true };
  }

  let selector: string | undefined;
  let tsconfig = 'tsconfig.json';
  const sources: string[] = [];
  const excludes: string[] = [];
  let includeDeclarations = false;
  let format: OutputFormat = 'json';
  let pretty = false;
  let out: string | undefined;
  let failEmpty = false;
  let write = false;
  let mutation: MutationAction | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith('-')) {
      if (selector !== undefined) {
        throw new Error(`unexpected positional argument: ${arg}`);
      }
      selector = arg;
      continue;
    }

    switch (arg) {
      case '--tsconfig': {
        tsconfig = requireValue(argv, i, arg);
        i += 1;
        break;
      }
      case '--source': {
        sources.push(requireValue(argv, i, arg));
        i += 1;
        break;
      }
      case '--exclude': {
        excludes.push(requireValue(argv, i, arg));
        i += 1;
        break;
      }
      case '--include-declarations':
        includeDeclarations = true;
        break;
      case '--format': {
        const value = requireValue(argv, i, arg);
        if (value !== 'json' && value !== 'text') {
          throw new Error(`invalid --format: ${value}`);
        }
        format = value;
        i += 1;
        break;
      }
      case '--pretty':
        pretty = true;
        break;
      case '--out': {
        out = requireValue(argv, i, arg);
        i += 1;
        break;
      }
      case '--fail-empty':
        failEmpty = true;
        break;
      case '--write':
        write = true;
        break;
      case '--delete':
        mutation = setMutation(mutation, { kind: 'delete' });
        break;
      case '--insert-before': {
        const text = requireValue(argv, i, arg);
        if (text.length === 0) {
          throw new Error('--insert-before requires non-empty text');
        }
        mutation = setMutation(mutation, { kind: 'insert-before', text });
        i += 1;
        break;
      }
      case '--insert-after': {
        const text = requireValue(argv, i, arg);
        if (text.length === 0) {
          throw new Error('--insert-after requires non-empty text');
        }
        mutation = setMutation(mutation, { kind: 'insert-after', text });
        i += 1;
        break;
      }
      case '--insert-before-file': {
        const filePath = requireValue(argv, i, arg);
        mutation = setMutation(mutation, {
          kind: 'insert-before',
          text: readSnippetFile(filePath, cwd),
        });
        i += 1;
        break;
      }
      case '--insert-after-file': {
        const filePath = requireValue(argv, i, arg);
        mutation = setMutation(mutation, {
          kind: 'insert-after',
          text: readSnippetFile(filePath, cwd),
        });
        i += 1;
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!selector) {
    throw new Error('missing TSQuery selector');
  }
  if (pretty && format !== 'json') {
    throw new Error('--pretty is only valid with --format json');
  }
  if (write && !mutation) {
    throw new Error('--write requires a mutation option');
  }

  return {
    selector,
    tsconfig,
    sources,
    excludes,
    includeDeclarations,
    format,
    pretty,
    out,
    failEmpty,
    write,
    mutation,
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isRegexMeta(char: string): boolean {
  return '.+^$()[]{}|\\'.includes(char);
}

export function globToRegExp(glob: string): RegExp {
  const normalized = normalizePath(glob).replace(/^\.\//, '');
  let pattern = '^';

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];

    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += isRegexMeta(char) ? `\\${char}` : char;
  }

  pattern += '$';
  return new RegExp(pattern);
}

function sourceMatchesGlobs(fileName: string, globs: string[], cwd: string): boolean {
  if (globs.length === 0) {
    return true;
  }

  const absolute = normalizePath(path.resolve(fileName));
  const relative = normalizePath(path.relative(cwd, fileName)).replace(/^\.\//, '');

  return globs.some((glob) => {
    const normalizedGlob = normalizePath(glob);
    const target = path.isAbsolute(glob) ? absolute : relative;
    return globToRegExp(normalizedGlob).test(target);
  });
}

function isDeclarationFilePath(fileName: string): boolean {
  return /\.d\.(?:ts|mts|cts)$/i.test(fileName);
}

function isQueryableSourceFile(fileName: string): boolean {
  return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i.test(fileName);
}

function sourceSelected(sourceFile: ts.SourceFile, options: CliOptions, cwd: string): boolean {
  const absolute = normalizePath(path.resolve(sourceFile.fileName));
  const relative = normalizePath(path.relative(cwd, sourceFile.fileName));

  if (absolute.includes('/node_modules/')) {
    return false;
  }
  if (!isQueryableSourceFile(sourceFile.fileName)) {
    return false;
  }
  if (!options.includeDeclarations && (sourceFile.isDeclarationFile || isDeclarationFilePath(sourceFile.fileName))) {
    return false;
  }
  if (options.excludes.some((part) => absolute.includes(part) || relative.includes(part))) {
    return false;
  }
  return sourceMatchesGlobs(sourceFile.fileName, options.sources, cwd);
}

function displayPath(fileName: string, cwd: string): string {
  const relative = path.relative(cwd, fileName);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return normalizePath(relative || path.basename(fileName));
  }
  return normalizePath(path.resolve(fileName));
}

function location(sourceFile: ts.SourceFile, offset: number): MatchLocation {
  const point = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: point.line + 1, column: point.character + 1 };
}

function syntaxKindName(kind: ts.SyntaxKind): string {
  const debug = (ts as typeof ts & { Debug?: { formatSyntaxKind?: (kind: ts.SyntaxKind) => string } }).Debug;
  return debug?.formatSyntaxKind?.(kind) ?? ts.SyntaxKind[kind] ?? String(kind);
}

function toRecord(sourceFile: ts.SourceFile, node: ts.Node, cwd: string): MatchRecord {
  const startOffset = node.getStart(sourceFile, false);
  const endOffset = node.getEnd();
  return {
    filePath: displayPath(sourceFile.fileName, cwd),
    kind: syntaxKindName(node.kind),
    start: location(sourceFile, startOffset),
    end: location(sourceFile, endOffset),
    startOffset,
    endOffset,
    text: sourceFile.text.slice(startOffset, endOffset),
  };
}

export function collectMatches(options: CliOptions, cwd = process.cwd()): InternalMatch[] {
  // Parse once so selector errors fail before any mutation planning.
  parse(options.selector);

  const configPath = path.resolve(cwd, options.tsconfig);
  if (!fs.existsSync(configPath)) {
    throw new Error(`tsconfig not found: ${options.tsconfig}`);
  }

  const sourceFiles = project(configPath);
  if (sourceFiles.length === 0) {
    throw new Error(`no project source files found for: ${options.tsconfig}`);
  }

  const results: InternalMatch[] = [];
  for (const sourceFile of sourceFiles) {
    if (!sourceSelected(sourceFile, options, cwd)) {
      continue;
    }
    for (const node of match(sourceFile, options.selector)) {
      results.push({ sourceFile, node, record: toRecord(sourceFile, node, cwd) });
    }
  }

  results.sort((a, b) => {
    const file = a.record.filePath.localeCompare(b.record.filePath);
    if (file !== 0) return file;
    return a.record.startOffset - b.record.startOffset || a.record.endOffset - b.record.endOffset;
  });

  return results;
}

export function coalesceDeleteEdits(edits: TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: TextEdit[] = [];

  for (const edit of sorted) {
    const previous = result[result.length - 1];
    if (previous && edit.start <= previous.end) {
      previous.end = Math.max(previous.end, edit.end);
      continue;
    }
    result.push({ ...edit });
  }
  return result;
}

export function applyTextEdits(source: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let result = source;

  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
      throw new Error(`invalid text edit range: ${edit.start}..${edit.end}`);
    }
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  return result;
}

function editsForMatches(matches: InternalMatch[], mutation: MutationAction): TextEdit[] {
  const edits = matches.map(({ record }) => {
    switch (mutation.kind) {
      case 'delete':
        return { start: record.startOffset, end: record.endOffset, replacement: '' };
      case 'insert-before':
        return { start: record.startOffset, end: record.startOffset, replacement: mutation.text };
      case 'insert-after':
        return { start: record.endOffset, end: record.endOffset, replacement: mutation.text };
    }
  });

  return mutation.kind === 'delete' ? coalesceDeleteEdits(edits) : edits;
}

function buildMutationPlan(matches: InternalMatch[], mutation: MutationAction, cwd: string) {
  const byFile = new Map<string, InternalMatch[]>();
  for (const item of matches) {
    const key = path.resolve(item.sourceFile.fileName);
    const list = byFile.get(key) ?? [];
    list.push(item);
    byFile.set(key, list);
  }

  const plans = [...byFile.entries()].map(([fileName, fileMatches]) => {
    const edits = editsForMatches(fileMatches, mutation);
    const source = fileMatches[0].sourceFile.text;
    return {
      fileName,
      filePath: displayPath(fileName, cwd),
      source,
      edits,
      output: applyTextEdits(source, edits),
      matchCount: fileMatches.length,
    };
  });

  plans.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return plans;
}

function writeMutationPlan(plans: ReturnType<typeof buildMutationPlan>): void {
  // Preflight every file before writing any of them. This prevents writing from a
  // stale AST if a file changed after project creation.
  for (const plan of plans) {
    const current = fs.readFileSync(plan.fileName, 'utf8');
    if (current !== plan.source) {
      throw new Error(`source changed while planning edits: ${plan.filePath}`);
    }
  }

  for (const plan of plans) {
    fs.writeFileSync(plan.fileName, plan.output, 'utf8');
  }
}

function comparablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsReferToSameFile(left: string, right: string): boolean {
  if (comparablePath(left) === comparablePath(right)) {
    return true;
  }

  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function assertOutputDoesNotOverwriteSource(
  plans: ReturnType<typeof buildMutationPlan>,
  out: string | undefined,
  cwd: string,
): void {
  if (!out) return;

  const outputPath = path.resolve(cwd, out);
  const collision = plans.find((plan) => pathsReferToSameFile(outputPath, plan.fileName));
  if (collision) {
    throw new Error(`--out cannot overwrite a matched source file: ${collision.filePath}`);
  }
}

function formatMatchText(record: MatchRecord): string {
  const oneLine = record.text.replace(/\r?\n/g, '\\n');
  return `${record.filePath}:${record.start.line}:${record.start.column}\t${record.kind}\t${oneLine}`;
}

function formatOutput(value: MatchRecord[] | MutationReport, options: CliOptions): string {
  if (options.format === 'text') {
    if (Array.isArray(value)) {
      return value.map(formatMatchText).join('\n') + (value.length ? '\n' : '');
    }
    const heading = `${value.written ? 'applied' : 'planned'} ${value.action}: ${value.matchCount} match(es), ${value.editCount} edit(s)`;
    const lines = value.matches.map(formatMatchText);
    return [heading, ...lines].join('\n') + '\n';
  }

  return JSON.stringify(value, null, options.pretty ? 2 : undefined) + '\n';
}

function emit(output: string, out: string | undefined, cwd: string): void {
  if (!out) {
    process.stdout.write(output);
    return;
  }
  const outputPath = path.resolve(cwd, out);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
}

export function run(options: CliOptions, cwd = process.cwd()): number {
  const matches = collectMatches(options, cwd);
  const records = matches.map((item) => item.record);

  if (records.length === 0 && options.failEmpty) {
    emit(formatOutput(options.mutation ? {
      selector: options.selector,
      action: options.mutation.kind,
      written: false,
      matchCount: 0,
      editCount: 0,
      files: [],
      matches: [],
    } : [], options), options.out, cwd);
    return 2;
  }

  if (!options.mutation) {
    emit(formatOutput(records, options), options.out, cwd);
    return 0;
  }

  const plans = buildMutationPlan(matches, options.mutation, cwd);
  const report: MutationReport = {
    selector: options.selector,
    action: options.mutation.kind,
    written: options.write,
    matchCount: records.length,
    editCount: plans.reduce((sum, plan) => sum + plan.edits.length, 0),
    files: plans.map((plan) => ({
      filePath: plan.filePath,
      matchCount: plan.matchCount,
      editCount: plan.edits.length,
    })),
    matches: records,
  };

  if (options.write && plans.length > 0) {
    assertOutputDoesNotOverwriteSource(plans, options.out, cwd);
    writeMutationPlan(plans);
  }

  emit(formatOutput(report, options), options.out, cwd);
  return 0;
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()): number {
  try {
    const parsed = parseArgs(argv, cwd);
    if ('help' in parsed) {
      process.stdout.write(HELP);
      return 0;
    }
    return run(parsed, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tsquery: ${message}\n`);
    return 1;
  }
}
