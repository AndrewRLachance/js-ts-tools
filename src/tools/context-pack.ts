import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import {
  compareNodes,
  createCodeAnalysisWorkspace,
  resolveAnalysisTargets,
  uniqueLogicalTargets,
  type CodeAnalysisWorkspace,
  type IndexedDeclaration,
} from "./code-analysis";
import type { ImpactDirection, ImpactNode } from "./code-impact";
import {
  createCodeSliceFromWorkspace,
  resolveCodeSliceLocationTargets,
  type CodeSliceLocation,
  type CodeSliceReport,
  type SliceFile,
} from "./code-slice";

export type ContextPackFormat = "markdown" | "json";
export type ContextSeedOrigin = "explicit" | "automatic";

export type ContextPackSeed =
  | { kind: "symbol"; symbol: string; filePath?: string }
  | { kind: "file"; filePath: string }
  | { kind: "location"; location: CodeSliceLocation };

export interface CreateContextPackOptions {
  task: string;
  taskFilePath?: string;
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  seeds?: readonly ContextPackSeed[];
  docGlobs?: readonly string[];
  configFilePaths?: readonly string[];
  maxSeeds?: number;
  direction?: ImpactDirection;
  maxDepth?: number;
  maxNodes?: number;
  maxTokens?: number;
  cwd?: string;
}

export interface RankedContextSeed {
  node: ImpactNode;
  origin: ContextSeedOrigin;
  score: number;
  reasons: string[];
}

export type ContextChunkKind = "instruction" | "documentation" | "configuration";

export interface ContextTextChunk {
  id: string;
  kind: ContextChunkKind;
  filePath: string;
  heading?: string;
  startLine: number;
  endLine: number;
  text: string;
  relevanceScore: number;
  estimatedTokens: number;
  mandatory: boolean;
  explicit: boolean;
}

export interface ContextOmission {
  kind: "code" | "documentation";
  id: string;
  estimatedTokens: number;
  reason: "budget";
}

export interface ContextPackReport {
  query: {
    sourceGlob: string[];
    testSourceGlob: string[];
    tsConfigFilePath: string;
    excludePathIncludes: string[];
    taskFilePath?: string;
    direction: ImpactDirection;
    maxSeeds: number;
    maxDepth: number;
    maxNodes: number;
    maxTokens: number;
    explicitSeeds: ContextPackSeed[];
    docGlobs: string[];
    configFilePaths: string[];
  };
  task: string;
  terms: string[];
  seeds: RankedContextSeed[];
  instructions: ContextTextChunk[];
  documentation: ContextTextChunk[];
  configuration: ContextTextChunk[];
  code: CodeSliceReport;
  omitted: ContextOmission[];
  summary: {
    estimatedTokens: number;
    maxTokens: number;
    explicitSeedCount: number;
    automaticSeedCount: number;
    instructionCount: number;
    documentationCount: number;
    configurationCount: number;
    codeSelectionCount: number;
    snippetCount: number;
    impactedTestCount: number;
    omittedCount: number;
    truncated: boolean;
  };
}

export interface FormatContextPackOptions {
  format?: ContextPackFormat;
  pretty?: boolean;
}

interface RankedEntry {
  entries: IndexedDeclaration[];
  representative: IndexedDeclaration;
  score: number;
  reasons: string[];
}

interface DiscoveredChunks {
  instructions: ContextTextChunk[];
  documentation: ContextTextChunk[];
  configuration: ContextTextChunk[];
}

interface OptionalItem {
  kind: "code" | "documentation";
  id: string;
  estimatedTokens: number;
  priority: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "create", "for", "from",
  "in", "into", "is", "it", "of", "on", "or", "our", "that", "the", "this",
  "to", "tool", "we", "with",
]);

const INSTRUCTION_NAMES = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/.env*",
  "**/*credential*",
  "**/*secret*",
];

export function createContextPack(
  options: CreateContextPackOptions,
): ContextPackReport {
  validateOptions(options);
  const maxSeeds = options.maxSeeds ?? 5;
  const direction = options.direction ?? "both";
  const maxDepth = options.maxDepth ?? 2;
  const maxNodes = options.maxNodes ?? 100;
  const maxTokens = options.maxTokens ?? 12_000;
  const workspace = createCodeAnalysisWorkspace(options);
  const task = options.task.trim();
  const terms = extractTerms(task);
  const explicitSeeds = [...(options.seeds ?? [])];

  const explicitGroups = resolveExplicitSeeds(workspace, explicitSeeds);
  const explicitLogicalKeys = new Set(explicitGroups.map((group) => group[0].logicalKey));
  const automatic = rankAutomaticSeeds(
    workspace,
    task,
    terms,
    explicitLogicalKeys,
    explicitGroups.flat(),
    maxSeeds,
  );
  if (explicitGroups.length === 0 && automatic.length === 0) {
    throw new Error(
      "The task did not match any source declarations. Add --symbol, --file, or --at to provide an explicit seed.",
    );
  }

  const targetGroups = [...explicitGroups, ...automatic.map((item) => item.entries)];
  const targetEntries = dedupeEntries(targetGroups.flat());
  const explicitNodes = explicitGroups.flatMap(uniqueLogicalTargets);
  const rankedSeeds: RankedContextSeed[] = [
    ...explicitGroups.flatMap((group) =>
      uniqueLogicalTargets(group).map((node) => ({
        node,
        origin: "explicit" as const,
        score: 0,
        reasons: ["explicit target"],
      }))),
    ...automatic.map((item) => ({
      node: item.representative.node,
      origin: "automatic" as const,
      score: item.score,
      reasons: item.reasons,
    })),
  ].sort(compareRankedSeeds);

  const fullCode = createCodeSliceFromWorkspace(workspace, targetEntries, {
    direction,
    maxDepth,
    maxNodes,
  });
  const discovered = discoverContextChunks(workspace, targetEntries, terms, options);
  const explicitNodeIds = new Set(explicitNodes.map((node) => node.id));
  const firstAutomaticId = automatic[0]?.representative.node.id;
  const mandatorySnippetIds = new Set<string>();
  for (const selection of fullCode.selections) {
    if (explicitNodeIds.has(selection.node.id) ||
      (explicitGroups.length === 0 && selection.node.id === firstAutomaticId)) {
      for (const snippetId of selection.snippetIds) mandatorySnippetIds.add(snippetId);
    }
  }

  const mandatoryDocuments = new Set<string>([
    ...discovered.instructions.map((chunk) => chunk.id),
    ...discovered.configuration.map((chunk) => chunk.id),
    ...discovered.documentation.filter((chunk) => chunk.explicit).map((chunk) => chunk.id),
  ]);
  const defaultDocumentation = discovered.documentation
    .filter((chunk) => !chunk.explicit)
    .sort(compareChunks)[0];
  if (defaultDocumentation) {
    defaultDocumentation.mandatory = true;
    mandatoryDocuments.add(defaultDocumentation.id);
  }

  const optionalItems = buildOptionalItems(
    fullCode,
    mandatorySnippetIds,
    discovered.documentation,
    mandatoryDocuments,
    automatic,
  );
  const includedSnippetIds = new Set(mandatorySnippetIds);
  const includedDocumentIds = new Set(mandatoryDocuments);
  const base = buildReport({
    workspace,
    options,
    task,
    terms,
    rankedSeeds,
    discovered,
    fullCode,
    includedSnippetIds,
    includedDocumentIds,
    omittedItems: [],
    maxSeeds,
    direction,
    maxDepth,
    maxNodes,
    maxTokens,
    explicitSeeds,
  });
  const requiredTokens = estimateContextPackTokens(base);
  if (requiredTokens > maxTokens) {
    throw new Error(
      `Mandatory context requires approximately ${requiredTokens} tokens, exceeding --max-tokens ${maxTokens}.`,
    );
  }

  const includedOptional: OptionalItem[] = [];
  for (const item of optionalItems) {
    includeOptional(item, includedSnippetIds, includedDocumentIds);
    const candidate = buildReport({
      workspace,
      options,
      task,
      terms,
      rankedSeeds,
      discovered,
      fullCode,
      includedSnippetIds,
      includedDocumentIds,
      omittedItems: [],
      maxSeeds,
      direction,
      maxDepth,
      maxNodes,
      maxTokens,
      explicitSeeds,
    });
    if (estimateContextPackTokens(candidate) <= maxTokens) includedOptional.push(item);
    else excludeOptional(item, includedSnippetIds, includedDocumentIds);
  }

  let omittedItems = optionalItems.filter((item) => !includedOptional.includes(item));
  let report = buildReport({
    workspace,
    options,
    task,
    terms,
    rankedSeeds,
    discovered,
    fullCode,
    includedSnippetIds,
    includedDocumentIds,
    omittedItems,
    maxSeeds,
    direction,
    maxDepth,
    maxNodes,
    maxTokens,
    explicitSeeds,
  });
  while (estimateContextPackTokens(report) > maxTokens && includedOptional.length > 0) {
    const removed = includedOptional.pop()!;
    excludeOptional(removed, includedSnippetIds, includedDocumentIds);
    omittedItems = optionalItems.filter((item) => !includedOptional.includes(item));
    report = buildReport({
      workspace,
      options,
      task,
      terms,
      rankedSeeds,
      discovered,
      fullCode,
      includedSnippetIds,
      includedDocumentIds,
      omittedItems,
      maxSeeds,
      direction,
      maxDepth,
      maxNodes,
      maxTokens,
      explicitSeeds,
    });
  }
  const estimatedTokens = estimateContextPackTokens(report);
  if (estimatedTokens > maxTokens) {
    throw new Error(
      `Mandatory context and omission metadata require approximately ${estimatedTokens} tokens, exceeding --max-tokens ${maxTokens}.`,
    );
  }
  report.summary.estimatedTokens = estimatedTokens;
  return report;
}

export function formatContextPack(
  report: ContextPackReport,
  options: FormatContextPackOptions = {},
): string {
  const format = options.format ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error(`Invalid context pack format: ${format}`);
  }
  if (format === "markdown" && options.pretty) {
    throw new Error("pretty is only supported with JSON output.");
  }
  const text = format === "json"
    ? JSON.stringify(report, null, options.pretty ? 2 : 0)
    : formatMarkdown(report);
  return `${text.replace(/\n+$/u, "")}\n`;
}

function validateOptions(options: CreateContextPackOptions): void {
  if (!options.task || options.task.trim().length === 0) {
    throw new Error("A non-empty task is required.");
  }
  if (Array.isArray(options.sourceGlob)
    ? options.sourceGlob.length === 0
    : !options.sourceGlob) {
    throw new Error("At least one source glob is required.");
  }
  if (options.direction && !["incoming", "outgoing", "both"].includes(options.direction)) {
    throw new Error(`Invalid context direction: ${options.direction}`);
  }
  validateBound("maxSeeds", options.maxSeeds);
  validateBound("maxDepth", options.maxDepth);
  validateBound("maxNodes", options.maxNodes);
  validateBound("maxTokens", options.maxTokens);
  if (options.maxTokens === 0) throw new Error("maxTokens must be greater than zero.");
  for (const seed of options.seeds ?? []) {
    if (seed.kind === "symbol" && !seed.symbol) throw new Error("Symbol seeds require a name.");
    if (seed.kind === "file" && !seed.filePath) throw new Error("File seeds require a path.");
    if (seed.kind === "location") validateLocation(seed.location);
  }
}

function validateBound(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
}

function validateLocation(location: CodeSliceLocation): void {
  if (!location.filePath || !Number.isInteger(location.line) || location.line < 1 ||
    (location.column !== undefined &&
      (!Number.isInteger(location.column) || location.column < 1))) {
    throw new Error("Location seeds require a path and positive line/column values.");
  }
}

function resolveExplicitSeeds(
  workspace: CodeAnalysisWorkspace,
  seeds: readonly ContextPackSeed[],
): IndexedDeclaration[][] {
  const groups: IndexedDeclaration[][] = [];
  for (const seed of seeds) {
    let resolved: IndexedDeclaration[];
    if (seed.kind === "symbol") {
      resolved = resolveAnalysisTargets(workspace, seed.symbol, seed.filePath);
    } else if (seed.kind === "file") {
      resolved = resolveAnalysisTargets(workspace, undefined, seed.filePath);
    } else {
      resolved = resolveCodeSliceLocationTargets(workspace, {
        ...seed.location,
        filePath: path.resolve(workspace.cwd, seed.location.filePath),
      });
    }
    const byLogicalKey = new Map<string, IndexedDeclaration[]>();
    for (const entry of resolved) {
      const group = byLogicalKey.get(entry.logicalKey) ?? [];
      group.push(entry);
      byLogicalKey.set(entry.logicalKey, group);
    }
    groups.push(...byLogicalKey.values());
  }
  return dedupeGroups(groups);
}

function rankAutomaticSeeds(
  workspace: CodeAnalysisWorkspace,
  task: string,
  terms: string[],
  excludedLogicalKeys: Set<string>,
  explicitEntries: IndexedDeclaration[],
  maxSeeds: number,
): RankedEntry[] {
  if (maxSeeds === 0 || terms.length === 0) return [];
  const groups = new Map<string, IndexedDeclaration[]>();
  for (const entry of workspace.index) {
    if (entry.node.test || excludedLogicalKeys.has(entry.logicalKey)) continue;
    const group = groups.get(entry.logicalKey) ?? [];
    group.push(entry);
    groups.set(entry.logicalKey, group);
  }
  const ranked = [...groups.values()].map((entries) => {
    const scored = entries.map((entry) => scoreEntry(entry, task, terms))
      .sort((left, right) => right.score - left.score || compareNodes(left.entry.node, right.entry.node));
    return {
      entries,
      representative: scored[0].entry,
      score: scored[0].score,
      reasons: scored[0].reasons,
    };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score ||
      compareNodes(left.representative.node, right.representative.node));

  const accepted: RankedEntry[] = [];
  const occupied = [...explicitEntries];
  for (const candidate of ranked) {
    if (overlapsAny(candidate.representative, occupied)) continue;
    accepted.push(candidate);
    occupied.push(...candidate.entries);
    if (accepted.length === maxSeeds) break;
  }
  return accepted;
}

function scoreEntry(
  entry: IndexedDeclaration,
  task: string,
  terms: string[],
): { entry: IndexedDeclaration; score: number; reasons: string[] } {
  const simple = normalizeSearchText(entry.simpleName);
  const qualified = normalizeSearchText(entry.qualifiedName);
  const taskText = normalizeSearchText(task);
  const filePath = normalizeSearchText(entry.node.filePath ?? "");
  const declarationText = normalizeSearchText(entry.declaration.getText());
  const source = entry.declaration.getSourceFile();
  const leadingText = source.getFullText().slice(entry.declaration.getFullStart(), entry.declaration.getStart());
  const comments = normalizeSearchText(leadingText.slice(-1_000));
  const simpleTokens = simple.split(" ");
  const qualifiedTokens = qualified.split(" ");
  const fileTokens = filePath.split(" ");
  const commentTokens = comments.split(" ");
  const declarationTokens = declarationText.split(" ");
  let score = 0;
  const reasons = new Set<string>();
  if (taskText === simple || taskText === qualified) {
    score += 100;
    reasons.add("exact symbol match");
  }
  let bodyMatches = 0;
  for (const term of terms) {
    if (hasLexicalTerm(simpleTokens, term) || hasLexicalTerm(qualifiedTokens, term)) {
      score += 20;
      reasons.add(`symbol term: ${term}`);
    }
    if (hasLexicalTerm(fileTokens, term)) {
      score += 8;
      reasons.add(`path term: ${term}`);
    }
    if (hasLexicalTerm(commentTokens, term)) {
      score += 4;
      reasons.add(`comment term: ${term}`);
    }
    if (bodyMatches < 10 && hasLexicalTerm(declarationTokens, term)) {
      score += 1;
      bodyMatches += 1;
    }
  }
  if (bodyMatches > 0) reasons.add(`body terms: ${bodyMatches}`);
  return { entry, score, reasons: [...reasons].sort() };
}

function hasLexicalTerm(tokens: string[], term: string): boolean {
  return tokens.some((token) => {
    if (token === term) return true;
    const limit = Math.min(token.length, term.length);
    let sharedLength = 0;
    while (sharedLength < limit && token[sharedLength] === term[sharedLength]) sharedLength += 1;
    return sharedLength >= 5;
  });
}

function extractTerms(text: string): string[] {
  return [...new Set(normalizeSearchText(text).split(" ")
    .filter((term) => term.length > 1 && !STOP_WORDS.has(term)))].sort();
}

function normalizeSearchText(text: string): string {
  return text
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
}

function overlapsAny(entry: IndexedDeclaration, others: IndexedDeclaration[]): boolean {
  return others.some((other) => {
    if (entry.node.filePath !== other.node.filePath) return false;
    const leftStart = entry.declaration.getStart();
    const leftEnd = entry.declaration.getEnd();
    const rightStart = other.declaration.getStart();
    const rightEnd = other.declaration.getEnd();
    return (leftStart <= rightStart && rightEnd <= leftEnd) ||
      (rightStart <= leftStart && leftEnd <= rightEnd);
  });
}

function dedupeGroups(groups: IndexedDeclaration[][]): IndexedDeclaration[][] {
  const result = new Map<string, IndexedDeclaration[]>();
  for (const group of groups) {
    if (group[0] && !result.has(group[0].logicalKey)) result.set(group[0].logicalKey, group);
  }
  return [...result.values()];
}

function dedupeEntries(entries: IndexedDeclaration[]): IndexedDeclaration[] {
  return [...new Map(entries.map((entry) => [entry.node.id, entry])).values()]
    .sort((left, right) => compareNodes(left.node, right.node));
}

function compareRankedSeeds(left: RankedContextSeed, right: RankedContextSeed): number {
  if (left.origin !== right.origin) return left.origin === "explicit" ? -1 : 1;
  return right.score - left.score || compareNodes(left.node, right.node);
}

function discoverContextChunks(
  workspace: CodeAnalysisWorkspace,
  targets: IndexedDeclaration[],
  terms: string[],
  options: CreateContextPackOptions,
): DiscoveredChunks {
  const exclusions = workspace.exclusions;
  const instructionPaths = discoverInstructionPaths(workspace, targets)
    .filter((filePath) => isAllowedPath(filePath, exclusions));
  const automaticDocPaths = fg.sync(["README*", "CONTRIBUTING*", "docs/**/*.md"], {
    cwd: workspace.cwd,
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: true,
    ignore: DEFAULT_IGNORES,
  }).map((filePath) => path.resolve(filePath)).filter((filePath) =>
    isAllowedPath(filePath, exclusions) && !instructionPaths.includes(filePath));
  const explicitDocPaths: string[] = [];
  for (const glob of options.docGlobs ?? []) {
    const matches = fg.sync(glob, {
      cwd: workspace.cwd,
      absolute: true,
      onlyFiles: true,
      unique: true,
      dot: true,
    }).map((filePath) => path.resolve(filePath)).filter((filePath) =>
      !isUserExcluded(filePath, exclusions));
    if (matches.length === 0) throw new Error(`No documentation files matched glob: ${glob}`);
    explicitDocPaths.push(...matches);
  }
  const explicitDocSet = new Set(explicitDocPaths);

  const instructions = uniquePaths(instructionPaths).map((filePath) =>
    singleChunk(filePath, "instruction", terms, true, false));
  const documentation = uniquePaths([...automaticDocPaths, ...explicitDocPaths])
    .flatMap((filePath) => splitDocument(
      filePath,
      terms,
      explicitDocSet.has(filePath),
    )).sort(compareChunks);

  const automaticConfigs = discoverConfigPaths(workspace, targets);
  const explicitConfigs = (options.configFilePaths ?? []).map((filePath) => {
    const resolved = path.resolve(workspace.cwd, filePath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`Configuration file not found: ${resolved}`);
    }
    if (isUserExcluded(resolved, exclusions)) {
      throw new Error(`Configuration file is excluded: ${resolved}`);
    }
    return resolved;
  });
  const explicitConfigSet = new Set(explicitConfigs);
  const configuration = uniquePaths([...automaticConfigs, ...explicitConfigs]).map((filePath) =>
    singleChunk(filePath, "configuration", terms, true, explicitConfigSet.has(filePath)));
  return { instructions, documentation, configuration };
}

function discoverInstructionPaths(
  workspace: CodeAnalysisWorkspace,
  targets: IndexedDeclaration[],
): string[] {
  const result: string[] = [];
  const directories = new Set([workspace.cwd]);
  for (const target of targets) {
    if (!target.node.filePath) continue;
    let directory = path.dirname(target.node.filePath);
    while (isWithin(directory, workspace.cwd)) {
      directories.add(directory);
      if (directory === workspace.cwd) break;
      directory = path.dirname(directory);
    }
  }
  for (const directory of directories) {
    for (const name of INSTRUCTION_NAMES) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) result.push(candidate);
    }
    const copilot = path.join(directory, ".github", "copilot-instructions.md");
    if (fs.existsSync(copilot) && fs.statSync(copilot).isFile()) result.push(copilot);
  }
  return result;
}

function discoverConfigPaths(
  workspace: CodeAnalysisWorkspace,
  targets: IndexedDeclaration[],
): string[] {
  const result = [workspace.tsConfigFilePath];
  const rootPackage = path.join(workspace.cwd, "package.json");
  if (fs.existsSync(rootPackage)) result.push(rootPackage);
  for (const target of targets) {
    if (!target.node.filePath) continue;
    let directory = path.dirname(target.node.filePath);
    while (isWithin(directory, workspace.cwd)) {
      const candidate = path.join(directory, "package.json");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        result.push(candidate);
        break;
      }
      if (directory === workspace.cwd) break;
      directory = path.dirname(directory);
    }
  }
  return uniquePaths(result);
}

function splitDocument(
  filePath: string,
  terms: string[],
  explicit: boolean,
): ContextTextChunk[] {
  const text = readTextFile(filePath);
  if (!/\.md$/i.test(filePath)) {
    return [makeChunk(filePath, "documentation", text, 1, lineCount(text), undefined, terms, explicit, explicit)];
  }
  const lines = text.split(/\r?\n/u);
  const chunks: ContextTextChunk[] = [];
  let start = 0;
  let heading: string | undefined;
  let fence: "```" | "~~~" | undefined;
  const flush = (end: number): void => {
    const content = lines.slice(start, end).join("\n").trim();
    if (content) chunks.push(makeChunk(
      filePath,
      "documentation",
      content,
      start + 1,
      end,
      heading,
      terms,
      explicit,
      explicit,
    ));
  };
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.startsWith("```") ? "```" : "~~~";
      fence = fence === marker ? undefined : fence ?? marker;
      continue;
    }
    const match = !fence ? lines[index].match(/^#{1,6}\s+(.+)$/u) : undefined;
    if (match) {
      flush(index);
      start = index;
      heading = match[1].trim();
    }
  }
  flush(lines.length);
  return chunks;
}

function singleChunk(
  filePath: string,
  kind: ContextChunkKind,
  terms: string[],
  mandatory: boolean,
  explicit: boolean,
): ContextTextChunk {
  const text = readTextFile(filePath);
  return makeChunk(
    filePath,
    kind,
    text,
    1,
    lineCount(text),
    undefined,
    terms,
    mandatory,
    explicit,
  );
}

function makeChunk(
  filePath: string,
  kind: ContextChunkKind,
  text: string,
  startLine: number,
  endLine: number,
  heading: string | undefined,
  terms: string[],
  mandatory: boolean,
  explicit: boolean,
): ContextTextChunk {
  const search = normalizeSearchText(`${filePath} ${heading ?? ""} ${text}`);
  const searchTokens = search.split(" ");
  const relevanceScore = terms.reduce((score, term) =>
    score + (hasLexicalTerm(searchTokens, term) ? 1 : 0), 0);
  return {
    id: `${kind}:${filePath}:${startLine}-${endLine}`,
    kind,
    filePath,
    heading,
    startLine,
    endLine,
    text,
    relevanceScore,
    estimatedTokens: estimateTextTokens(text),
    mandatory,
    explicit,
  };
}

function readTextFile(filePath: string): string {
  let contents: Buffer;
  try {
    contents = fs.readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read context file ${filePath}: ${message}`);
  }
  if (contents.includes(0)) throw new Error(`Context file is binary: ${filePath}`);
  return contents.toString("utf8").replace(/\r\n/g, "\n").replace(/\n+$/u, "");
}

function isAllowedPath(filePath: string, exclusions: string[]): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLocaleLowerCase("en-US");
  if (DEFAULT_IGNORES.some((pattern) => {
    const token = pattern.replace(/^\*\*\//u, "").replace(/\/\*\*$/u, "").replace(/\*/g, "");
    return token && normalized.includes(token.toLocaleLowerCase("en-US"));
  })) return false;
  return !isUserExcluded(filePath, exclusions);
}

function isUserExcluded(filePath: string, exclusions: string[]): boolean {
  return exclusions.some((fragment) => filePath.includes(fragment));
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((filePath) => path.resolve(filePath)))].sort();
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

function compareChunks(left: ContextTextChunk, right: ContextTextChunk): number {
  return right.relevanceScore - left.relevanceScore ||
    left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine;
}

function buildOptionalItems(
  code: CodeSliceReport,
  mandatorySnippetIds: Set<string>,
  documentation: ContextTextChunk[],
  mandatoryDocumentIds: Set<string>,
  automatic: RankedEntry[],
): OptionalItem[] {
  const autoScores = new Map(automatic.map((item) => [item.representative.node.id, item.score]));
  const selectionsBySnippet = new Map<string, typeof code.selections>();
  for (const selection of code.selections) {
    for (const snippetId of selection.snippetIds) {
      const group = selectionsBySnippet.get(snippetId) ?? [];
      group.push(selection);
      selectionsBySnippet.set(snippetId, group);
    }
  }
  const items: OptionalItem[] = [];
  for (const file of code.files) {
    for (const snippet of file.snippets) {
      if (mandatorySnippetIds.has(snippet.id)) continue;
      const selections = selectionsBySnippet.get(snippet.id) ?? [];
      const automaticScore = Math.max(0, ...selections.map((selection) =>
        autoScores.get(selection.node.id) ?? 0));
      const test = selections.some((selection) => selection.node.test);
      const target = selections.some((selection) => selection.roles.includes("target"));
      const minDistance = Math.min(10, ...selections.map((selection) => selection.distance));
      const priority = target ? 4_000 + automaticScore
        : test ? 3_000 - minDistance
        : 2_000 - minDistance;
      items.push({
        kind: "code",
        id: snippet.id,
        estimatedTokens: estimateTextTokens(snippet.text),
        priority,
      });
    }
  }
  for (const chunk of documentation) {
    if (mandatoryDocumentIds.has(chunk.id)) continue;
    items.push({
      kind: "documentation",
      id: chunk.id,
      estimatedTokens: chunk.estimatedTokens,
      priority: 1_000 + chunk.relevanceScore,
    });
  }
  return items.sort((left, right) =>
    right.priority - left.priority || left.id.localeCompare(right.id));
}

function includeOptional(
  item: OptionalItem,
  snippets: Set<string>,
  documents: Set<string>,
): void {
  (item.kind === "code" ? snippets : documents).add(item.id);
}

function excludeOptional(
  item: OptionalItem,
  snippets: Set<string>,
  documents: Set<string>,
): void {
  (item.kind === "code" ? snippets : documents).delete(item.id);
}

interface BuildReportInput {
  workspace: CodeAnalysisWorkspace;
  options: CreateContextPackOptions;
  task: string;
  terms: string[];
  rankedSeeds: RankedContextSeed[];
  discovered: DiscoveredChunks;
  fullCode: CodeSliceReport;
  includedSnippetIds: Set<string>;
  includedDocumentIds: Set<string>;
  omittedItems: OptionalItem[];
  maxSeeds: number;
  direction: ImpactDirection;
  maxDepth: number;
  maxNodes: number;
  maxTokens: number;
  explicitSeeds: ContextPackSeed[];
}

function buildReport(input: BuildReportInput): ContextPackReport {
  const code = pruneCodeSlice(input.fullCode, input.includedSnippetIds);
  const documentation = input.discovered.documentation
    .filter((chunk) => input.includedDocumentIds.has(chunk.id))
    .sort(compareChunks);
  const omitted: ContextOmission[] = input.omittedItems.map((item) => ({
    kind: item.kind,
    id: item.id,
    estimatedTokens: item.estimatedTokens,
    reason: "budget" as const,
  })).sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  return {
    query: {
      sourceGlob: input.workspace.sourceGlobs,
      testSourceGlob: input.workspace.testGlobs,
      tsConfigFilePath: input.workspace.tsConfigFilePath,
      excludePathIncludes: input.workspace.exclusions,
      taskFilePath: input.options.taskFilePath
        ? path.resolve(input.workspace.cwd, input.options.taskFilePath)
        : undefined,
      direction: input.direction,
      maxSeeds: input.maxSeeds,
      maxDepth: input.maxDepth,
      maxNodes: input.maxNodes,
      maxTokens: input.maxTokens,
      explicitSeeds: input.explicitSeeds.map((seed) => normalizeSeed(input.workspace.cwd, seed)),
      docGlobs: [...(input.options.docGlobs ?? [])],
      configFilePaths: [...(input.options.configFilePaths ?? [])]
        .map((item) => path.resolve(input.workspace.cwd, item)),
    },
    task: input.task,
    terms: input.terms,
    seeds: input.rankedSeeds,
    instructions: input.discovered.instructions,
    documentation,
    configuration: input.discovered.configuration,
    code,
    omitted,
    summary: {
      estimatedTokens: 0,
      maxTokens: input.maxTokens,
      explicitSeedCount: input.rankedSeeds.filter((seed) => seed.origin === "explicit").length,
      automaticSeedCount: input.rankedSeeds.filter((seed) => seed.origin === "automatic").length,
      instructionCount: input.discovered.instructions.length,
      documentationCount: documentation.length,
      configurationCount: input.discovered.configuration.length,
      codeSelectionCount: code.selections.length,
      snippetCount: code.files.reduce((count, file) => count + file.snippets.length, 0),
      impactedTestCount: code.impactedTests.length,
      omittedCount: omitted.length,
      truncated: code.summary.truncated || omitted.length > 0,
    },
  };
}

function normalizeSeed(cwd: string, seed: ContextPackSeed): ContextPackSeed {
  if (seed.kind === "symbol") return {
    ...seed,
    filePath: seed.filePath ? path.resolve(cwd, seed.filePath) : undefined,
  };
  if (seed.kind === "file") return { ...seed, filePath: path.resolve(cwd, seed.filePath) };
  return {
    kind: "location",
    location: { ...seed.location, filePath: path.resolve(cwd, seed.location.filePath) },
  };
}

function pruneCodeSlice(
  report: CodeSliceReport,
  includedSnippetIds: Set<string>,
): CodeSliceReport {
  const files: SliceFile[] = report.files.map((file) => {
    const snippets = file.snippets
      .filter((snippet) => includedSnippetIds.has(snippet.id))
      .map((snippet) => ({ ...snippet, selectionIds: [...snippet.selectionIds] }));
    const snippetIds = new Set(snippets.map((snippet) => snippet.id));
    const imports = file.imports.map((item) => ({
      ...item,
      referencedBySnippetIds: item.referencedBySnippetIds.filter((id) => snippetIds.has(id)),
    })).filter((item) => item.referencedBySnippetIds.length > 0);
    return { ...file, imports, snippets };
  }).filter((file) => file.snippets.length > 0);
  const retainedSnippetIds = new Set(files.flatMap((file) => file.snippets.map((snippet) => snippet.id)));
  const selections = report.selections.map((selection) => ({
    ...selection,
    snippetIds: selection.snippetIds.filter((id) => retainedSnippetIds.has(id)),
  })).filter((selection) => selection.snippetIds.length > 0);
  const selectionIds = new Set(selections.map((selection) => selection.node.id));
  for (const file of files) {
    for (const snippet of file.snippets) {
      snippet.selectionIds = snippet.selectionIds.filter((id) => selectionIds.has(id));
    }
  }
  const targets = report.targets.filter((target) => selectionIds.has(target.id));
  const impactedTests = selections.filter((selection) =>
    selection.node.test && !selection.roles.includes("target"));
  const boundaries = report.boundaries.filter((boundary) => boundary.paths.some((slicePath) =>
    slicePath.steps.some((step) => selectionIds.has(step.fromId) || selectionIds.has(step.toId))));
  return {
    ...report,
    targets,
    selections,
    files,
    boundaries,
    impactedTests,
    summary: {
      targetCount: targets.length,
      selectionCount: selections.length,
      fileCount: files.length,
      snippetCount: files.reduce((count, file) => count + file.snippets.length, 0),
      impactedTestCount: impactedTests.length,
      externalCount: boundaries.length,
      truncated: report.summary.truncated || selections.length < report.selections.length,
    },
  };
}

export function estimateContextPackTokens(report: ContextPackReport): number {
  const canonical = {
    ...report,
    summary: { ...report.summary, estimatedTokens: 0 },
  };
  return estimateTextTokens(JSON.stringify(canonical));
}

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function formatMarkdown(report: ContextPackReport): string {
  const lines: string[] = ["# Context Pack", "", "## Task", "", report.task, ""];
  lines.push(
    "## Summary",
    "",
    `- Estimated tokens: ${report.summary.estimatedTokens} / ${report.summary.maxTokens}`,
    `- Seeds: ${report.summary.explicitSeedCount} explicit, ${report.summary.automaticSeedCount} automatic`,
    `- Code snippets: ${report.summary.snippetCount}`,
    `- Impacted tests: ${report.summary.impactedTestCount}`,
    `- Omitted chunks: ${report.summary.omittedCount}`,
    "",
    "## Retrieval",
    "",
  );
  for (const seed of report.seeds) {
    lines.push(`- \`${seed.node.qualifiedName}\` — ${seed.origin}, score ${seed.score}; ${seed.reasons.join(", ")}`);
  }
  appendChunks(lines, "Repository Instructions", report.instructions);
  appendChunks(lines, "Project Configuration", report.configuration);
  appendChunks(lines, "Documentation", report.documentation);
  lines.push("", "## Code Context", "");
  for (const selection of report.code.selections) {
    lines.push(`- \`${selection.node.qualifiedName}\` (${selection.roles.join(", ")})`);
    for (const slicePath of selection.paths) {
      const evidence = slicePath.steps.map((step) =>
        step.evidence ?? `${step.fromId} ${step.relation} ${step.toId}`).join(" → ");
      lines.push(`  - ${slicePath.kind}, distance ${slicePath.distance}: ${evidence}`);
    }
  }
  for (const file of report.code.files) {
    lines.push("", `### ${file.filePath}`, "");
    if (file.imports.length > 0) {
      lines.push(codeFence(file.imports.map((item) => item.text).join("\n"), file.filePath), "");
    }
    for (const snippet of file.snippets) {
      const label = snippet.selectionIds.some((id) =>
        report.code.impactedTests.some((test) => test.node.id === id)) ? "Test" : "Source";
      lines.push(`${label} lines ${snippet.startLine}–${snippet.endLine}`, "", codeFence(snippet.text, file.filePath), "");
    }
  }
  if (report.code.boundaries.length > 0) {
    lines.push("## External Boundaries", "");
    for (const boundary of report.code.boundaries) {
      lines.push(`- \`${boundary.node.qualifiedName}\` (${boundary.relations.join(", ") || "external"})`);
    }
    lines.push("");
  }
  if (report.omitted.length > 0) {
    lines.push("## Omitted for Budget", "");
    for (const item of report.omitted) {
      lines.push(`- ${item.kind}: \`${item.id}\` (~${item.estimatedTokens} tokens)`);
    }
  }
  return lines.join("\n");
}

function appendChunks(
  lines: string[],
  title: string,
  chunks: ContextTextChunk[],
): void {
  if (chunks.length === 0) return;
  lines.push("", `## ${title}`, "");
  for (const chunk of chunks) {
    lines.push(`### ${chunk.heading ?? chunk.filePath}`, "", codeFence(chunk.text, chunk.filePath), "");
  }
}

function codeFence(text: string, filePath: string): string {
  const fence = text.includes("```") ? "````" : "```";
  const extension = path.extname(filePath).toLocaleLowerCase("en-US");
  const language = [".ts", ".tsx"].includes(extension) ? "ts"
    : [".js", ".jsx", ".json"].includes(extension) ? extension.slice(1)
    : extension === ".md" ? "markdown" : "";
  return `${fence}${language}\n${text}\n${fence}`;
}
