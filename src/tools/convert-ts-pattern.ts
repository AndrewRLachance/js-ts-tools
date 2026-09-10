import * as fs from "node:fs";
import * as path from "node:path";
import fg from "fast-glob";
import * as ts from "typescript";

export type TsPatternCandidateKind =
  | "switch"
  | "if-chain"
  | "scalar-if"
  | "discriminated-if"
  | "structural-if"
  | "guard-if"
  | "ternary";

export type TsPatternSkipReason =
  | "unsupported-condition"
  | "loose-equality"
  | "inconsistent-subject"
  | "inconsistent-discriminator"
  | "effectful-subject"
  | "unsupported-pattern"
  | "missing-fallback"
  | "switch-fallthrough"
  | "default-not-final"
  | "outer-control-flow"
  | "labeled-control-flow"
  | "yield"
  | "await"
  | "unsupported-branch-shape"
  | "scope-change"
  | "binding-collision"
  | "unsupported-discriminator"
  | "unsupported-guard"
  | "ambiguous-guard-subject"
  | "effectful-guard"
  | "continuation-too-large"
  | "overlapping-candidate"
  | "validation-failed";

export type TsPatternFallbackKind =
  | "explicit"
  | "implicit-noop"
  | "implicit-undefined"
  | "absorbed-continuation";

export const DEFAULT_MAX_CONTINUATION_BYTES = 16 * 1024;

export interface ConvertTsPatternOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  cwd?: string;
  write?: boolean;
  maxContinuationBytes?: number;
}

export interface TsPatternLocation {
  line: number;
  column: number;
}

export interface TsPatternValidationDiagnostic {
  code: number;
  category: string;
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
}

export interface TsPatternCandidateReport {
  filePath: string;
  start: TsPatternLocation;
  end: TsPatternLocation;
  kind: TsPatternCandidateKind;
  subject?: string;
  discriminator?: string;
  discriminators?: string[];
  branchCount: number;
  action: "converted" | "skipped";
  terminator?: "otherwise" | "exhaustive";
  fallbackKind?: TsPatternFallbackKind;
  reasonCode?: TsPatternSkipReason;
  reason?: string;
  diagnostics?: TsPatternValidationDiagnostic[];
}

export interface TsPatternFileReport {
  filePath: string;
  changed: boolean;
  candidates: TsPatternCandidateReport[];
}

export interface TsPatternConversionReport {
  query: {
    sourceGlob: string[];
    tsConfigFilePath: string;
    excludePathIncludes: string[];
    maxContinuationBytes: number;
    mode: "dry-run" | "write";
  };
  written: boolean;
  files: TsPatternFileReport[];
  summary: {
    candidates: number;
    converted: number;
    skipped: number;
    filesChanged: number;
  };
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

interface CandidateOutputRange {
  candidate: InternalCandidate;
  start: number;
  end: number;
  scopeStart?: number;
  scopeEnd?: number;
}

type PrimitivePatternFamily = "string" | "number" | "bigint" | "boolean" | "symbol";

type PatternNode =
  | { kind: "literal"; expression: ts.Expression }
  | { kind: "raw"; text: string }
  | { kind: "primitive"; family: PrimitivePatternFamily }
  | { kind: "instance-of"; constructor: ts.Expression }
  | {
    kind: "numeric";
    family: "number" | "bigint";
    operation: "between" | "lt" | "gt" | "lte" | "gte" | "int" | "finite";
    arguments: Array<ts.Expression | string>;
  }
  | {
    kind: "string";
    operation: "startsWith" | "endsWith" | "includes" | "length" | "minLength" | "maxLength" | "regex";
    argument: ts.Expression | string;
  }
  | { kind: "not"; pattern: PatternNode }
  | { kind: "intersection"; patterns: PatternNode[] }
  | { kind: "union"; patterns: PatternNode[] }
  | { kind: "nested"; path: string[]; pattern: PatternNode };

interface AtomicPattern {
  subject: ts.Identifier;
  subjectText: string;
  subjectSymbol?: ts.Symbol;
  path: string[];
  pattern: PatternNode;
  evidenceFamily?: PrimitivePatternFamily;
}

interface PatternAlternative {
  pattern: PatternNode;
  paths: string[][];
}

interface PatternCondition {
  kind: "scalar" | "discriminated" | "structural" | "guard";
  clause: "with" | "when";
  subject: ts.Expression;
  subjectText: string;
  subjectSymbol?: ts.Symbol;
  patterns: PatternAlternative[];
  guardText?: string;
}

interface MatchBranch {
  statement?: ts.Statement;
  statements?: readonly ts.Statement[];
  expression?: ts.Expression;
  stripFinalBreak?: boolean;
  leadingComments?: string[];
  condition?: PatternCondition;
  syntheticFallback?: "noop" | "undefined" | "continuation";
  preserveSubjectBinding?: boolean;
}

interface ContinuationPlan {
  statements: ts.Statement[];
  editEnd: number;
  additionalEdits: TextEdit[];
  duplicatedBytes: number;
}

interface CandidateProposal {
  replacement: string;
  terminator: "otherwise" | "exhaustive";
  requiresP: boolean;
  fallbackKind: TsPatternFallbackKind;
  editEnd?: number;
  additionalEdits?: TextEdit[];
  duplicatedContinuationBytes?: number;
}

interface InternalCandidate {
  sourceFile: ts.SourceFile;
  node: ts.SwitchStatement | ts.IfStatement | ts.ConditionalExpression;
  start: number;
  end: number;
  report: TsPatternCandidateReport;
  proposals?: CandidateProposal[];
  proposal?: CandidateProposal;
}

interface LoadedProject {
  cwd: string;
  configPath: string;
  parsed: ts.ParsedCommandLine;
  program: ts.Program;
  checker: ts.TypeChecker;
  selectedFiles: ts.SourceFile[];
}

interface ImportPlan {
  sourceFile: ts.SourceFile;
  matchName: string;
  pName: string;
  narrowedValueName: string;
  compatibleImport?: ts.ImportDeclaration;
  matchImported: boolean;
  pImported: boolean;
}

interface BranchAnalysis {
  mode: "return" | "imperative";
  kinds: Array<"return" | "throw" | "imperative">;
  error?: { code: TsPatternSkipReason; message: string };
}

interface CandidateValidationResult {
  diagnostics: TsPatternValidationDiagnostic[];
  attributedCandidates: InternalCandidate[][];
  diagnosticsByCandidate: Map<InternalCandidate, TsPatternValidationDiagnostic[]>;
}

interface DiagnosticValidator {
  collect(overlays: ReadonlyMap<string, string>, fullProject?: boolean): readonly ts.Diagnostic[];
}

const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });

export function convertTsPattern(options: ConvertTsPatternOptions): TsPatternConversionReport {
  const maxContinuationBytes = options.maxContinuationBytes ?? DEFAULT_MAX_CONTINUATION_BYTES;
  if (!Number.isSafeInteger(maxContinuationBytes) || maxContinuationBytes < 0) {
    throw new Error("maxContinuationBytes must be a non-negative integer");
  }
  const project = loadProject(options);
  const originals = new Map(
    project.selectedFiles.map((sourceFile) => [canonicalPath(sourceFile.fileName), sourceFile.text]),
  );
  const candidates = discoverCandidates(project);
  const importPlans = new Map<string, ImportPlan>();

  for (const sourceFile of project.selectedFiles) {
    importPlans.set(canonicalPath(sourceFile.fileName), planTsPatternImports(sourceFile));
  }
  for (const candidate of candidates) {
    analyzeCandidate(candidate, project.checker, importPlans.get(canonicalPath(candidate.sourceFile.fileName))!);
  }

  const baselineCounts = diagnosticCounts(ts.getPreEmitDiagnostics(project.program));
  const validator = createDiagnosticValidator(project.parsed);
  const accepted: InternalCandidate[] = [];
  const acceptedSet = new Set<InternalCandidate>();
  const duplicatedContinuationBytes = new Map<string, number>();
  // Validate non-overlapping candidates together. If a batch fails, diagnostics
  // identify candidates to retry with their safer proposal before binary isolation.
  while (true) {
    for (const candidate of candidates) {
      if (!candidate.proposals?.length || acceptedSet.has(candidate)) continue;
      if (accepted.some((other) => candidatesOverlap(other, candidate))) {
        skip(candidate, "overlapping-candidate", "candidate overlaps an earlier accepted conversion");
      }
    }
    const remaining = candidates.filter((candidate) => candidate.proposals?.length && !acceptedSet.has(candidate));
    const batch = budgetedNonOverlapping(
      remaining, duplicatedContinuationBytes, maxContinuationBytes,
    );
    if (batch.length === 0) {
      for (const candidate of remaining) {
        const duplicated = candidate.proposal?.duplicatedContinuationBytes ?? 0;
        const used = duplicatedContinuationBytes.get(canonicalPath(candidate.sourceFile.fileName)) ?? 0;
        if (duplicated > 0 && used + duplicated > maxContinuationBytes) {
          skip(
            candidate,
            "continuation-too-large",
            `duplicated continuation would use ${used + duplicated} bytes; limit is ${maxContinuationBytes}`,
          );
        }
      }
      break;
    }
    validateCandidateBatch(
      batch,
      accepted,
      acceptedSet,
      project,
      originals,
      importPlans,
      baselineCounts,
      validator,
      duplicatedContinuationBytes,
    );
  }

  const overlays = buildOverlays(project, originals, accepted, importPlans);
  if (overlays.size > 0) {
    const finalIntroduced = introducedDiagnostics(validator.collect(overlays, true), baselineCounts);
    if (finalIntroduced.length > 0) {
      throw new Error("internal validation failure: accepted conversion batch introduced diagnostics");
    }
  }
  if (options.write && overlays.size > 0) {
    preflightWrites(overlays, originals, project.cwd);
    for (const [fileName, text] of [...overlays].sort(([left], [right]) => left.localeCompare(right))) {
      fs.writeFileSync(fileName, text, "utf8");
    }
  }

  const files = buildFileReports(candidates, accepted);
  const converted = candidates.filter((candidate) => candidate.report.action === "converted").length;
  return {
    query: {
      sourceGlob: asArray(options.sourceGlob),
      tsConfigFilePath: project.configPath,
      excludePathIncludes: options.excludePathIncludes ?? [],
      maxContinuationBytes,
      mode: options.write ? "write" : "dry-run",
    },
    written: Boolean(options.write && overlays.size > 0),
    files,
    summary: {
      candidates: candidates.length,
      converted,
      skipped: candidates.length - converted,
      filesChanged: new Set(accepted.map((candidate) => canonicalPath(candidate.sourceFile.fileName))).size,
    },
  };
}

function validateCandidateBatch(
  batch: readonly InternalCandidate[],
  accepted: InternalCandidate[],
  acceptedSet: Set<InternalCandidate>,
  project: LoadedProject,
  originals: ReadonlyMap<string, string>,
  importPlans: ReadonlyMap<string, ImportPlan>,
  baselineCounts: ReadonlyMap<string, number>,
  validator: DiagnosticValidator,
  duplicatedContinuationBytes: Map<string, number>,
): void {
  const validation = validateCandidateSet(
    [...accepted, ...batch], project, originals, importPlans, baselineCounts, validator,
  );
  if (validation.diagnostics.length === 0) {
    for (const candidate of batch) {
      acceptCandidate(candidate, accepted, acceptedSet, duplicatedContinuationBytes);
    }
    return;
  }
  const batchSet = new Set(batch);
  const implicated = [...new Set(validation.attributedCandidates.flat())]
    .filter((candidate) => batchSet.has(candidate));
  if (implicated.length > 0 && validation.attributedCandidates.every((attributed) =>
    attributed.every((candidate) => batchSet.has(candidate)))) {
    const rejected = new Set<InternalCandidate>();
    for (const candidate of implicated) {
      const proposalIndex = candidate.proposals!.indexOf(candidate.proposal!);
      const nextProposal = candidate.proposals![proposalIndex + 1];
      if (nextProposal) {
        candidate.proposal = nextProposal;
      } else {
        skip(candidate, "validation-failed", "generated conversion introduced TypeScript diagnostics");
        candidate.report.diagnostics = validation.diagnosticsByCandidate.get(candidate)?.slice(0, 20);
        rejected.add(candidate);
      }
    }
    const retry = batch.filter((candidate) => !rejected.has(candidate));
    if (retry.length > 0) {
      validateCandidateBatch(
        retry, accepted, acceptedSet, project, originals, importPlans, baselineCounts,
        validator, duplicatedContinuationBytes,
      );
    }
    return;
  }
  if (batch.length > 1) {
    const middle = Math.floor(batch.length / 2);
    validateCandidateBatch(
      batch.slice(0, middle), accepted, acceptedSet, project, originals, importPlans, baselineCounts,
      validator, duplicatedContinuationBytes,
    );
    validateCandidateBatch(
      batch.slice(middle), accepted, acceptedSet, project, originals, importPlans, baselineCounts,
      validator, duplicatedContinuationBytes,
    );
    return;
  }

  const candidate = batch[0];
  let lastValidation = validation;
  for (const proposal of candidate.proposals!.slice(1)) {
    candidate.proposal = proposal;
    lastValidation = validateCandidateSet(
      [...accepted, candidate], project, originals, importPlans, baselineCounts, validator,
    );
    if (lastValidation.diagnostics.length === 0) {
      acceptCandidate(candidate, accepted, acceptedSet, duplicatedContinuationBytes);
      return;
    }
  }
  skip(candidate, "validation-failed", "generated conversion introduced TypeScript diagnostics");
  candidate.report.diagnostics = lastValidation.diagnostics;
}

function validateCandidateSet(
  candidates: readonly InternalCandidate[],
  project: LoadedProject,
  originals: ReadonlyMap<string, string>,
  importPlans: ReadonlyMap<string, ImportPlan>,
  baselineCounts: ReadonlyMap<string, number>,
  validator: DiagnosticValidator,
): CandidateValidationResult {
  const overlays = buildOverlays(project, originals, candidates, importPlans);
  const ranges = candidateOutputRanges(candidates, importPlans);
  const introduced = introducedDiagnostics(validator.collect(overlays), baselineCounts);
  const attributedCandidates: InternalCandidate[][] = [];
  const diagnosticsByCandidate = new Map<InternalCandidate, TsPatternValidationDiagnostic[]>();
  for (const diagnostic of introduced) {
    const formatted = formatDiagnostic(diagnostic, project.cwd);
    const fileRanges = diagnostic.file ? ranges.get(canonicalPath(diagnostic.file.fileName)) ?? [] : [];
    const exactCandidate = diagnostic.start !== undefined
      ? fileRanges.find((range) => diagnostic.start! >= range.start && diagnostic.start! < range.end)?.candidate
      : undefined;
    const attributed = exactCandidate ? [exactCandidate] : diagnostic.start !== undefined
      ? fileRanges.filter((range) => range.scopeStart !== undefined &&
        diagnostic.start! >= range.scopeStart && diagnostic.start! < range.scopeEnd!).map((range) => range.candidate)
      : [];
    attributedCandidates.push(attributed);
    for (const candidate of attributed) {
      const candidateDiagnostics = diagnosticsByCandidate.get(candidate) ?? [];
      candidateDiagnostics.push(formatted);
      diagnosticsByCandidate.set(candidate, candidateDiagnostics);
    }
  }
  return {
    diagnostics: introduced.slice(0, 20).map((diagnostic) => formatDiagnostic(diagnostic, project.cwd)),
    attributedCandidates,
    diagnosticsByCandidate,
  };
}

function acceptCandidate(
  candidate: InternalCandidate,
  accepted: InternalCandidate[],
  acceptedSet: Set<InternalCandidate>,
  duplicatedContinuationBytes: Map<string, number>,
): void {
  candidate.report.action = "converted";
  candidate.report.terminator = candidate.proposal!.terminator;
  candidate.report.fallbackKind = candidate.proposal!.fallbackKind;
  accepted.push(candidate);
  acceptedSet.add(candidate);
  const duplicated = candidate.proposal!.duplicatedContinuationBytes ?? 0;
  if (duplicated > 0) {
    const fileName = canonicalPath(candidate.sourceFile.fileName);
    duplicatedContinuationBytes.set(fileName, (duplicatedContinuationBytes.get(fileName) ?? 0) + duplicated);
  }
}

function loadProject(options: ConvertTsPatternOptions): LoadedProject {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const sourceGlobs = asArray(options.sourceGlob);
  if (sourceGlobs.length === 0) throw new Error("At least one source glob is required.");
  const configPath = path.resolve(cwd, options.tsConfigFilePath ?? "tsconfig.json");
  if (!fs.existsSync(configPath)) throw new Error(`tsconfig not found: ${options.tsConfigFilePath ?? "tsconfig.json"}`);
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(formatConfigDiagnostic(config.error));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map(formatConfigDiagnostic).join("\n"));
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });
  const matched = new Set(fg.sync(sourceGlobs, {
    cwd,
    absolute: true,
    onlyFiles: true,
    unique: true,
    followSymbolicLinks: true,
  }).map(canonicalPath));
  if (matched.size === 0) throw new Error(`No files matched source glob: ${sourceGlobs.join(", ")}`);
  const exclusions = options.excludePathIncludes ?? [];
  const selectedFiles = program.getSourceFiles().filter((sourceFile) => {
    const fileName = canonicalPath(sourceFile.fileName);
    const relative = normalizePath(path.relative(cwd, fileName));
    return matched.has(fileName) && !sourceFile.isDeclarationFile && isTypeScriptSource(fileName) &&
      !exclusions.some((part) => fileName.includes(part) || relative.includes(part));
  }).sort((left, right) => displayPath(left.fileName, cwd).localeCompare(displayPath(right.fileName, cwd)));
  if (selectedFiles.length === 0) throw new Error("No matched source files belong to the configured TypeScript project.");
  return { cwd, configPath, parsed, program, checker: program.getTypeChecker(), selectedFiles };
}

function discoverCandidates(project: LoadedProject): InternalCandidate[] {
  const candidates: InternalCandidate[] = [];
  for (const sourceFile of project.selectedFiles) {
    const visit = (node: ts.Node): void => {
      if (ts.isSwitchStatement(node) || ts.isConditionalExpression(node) ||
        (ts.isIfStatement(node) && !(ts.isIfStatement(node.parent) && node.parent.elseStatement === node))) {
        const start = node.getStart(sourceFile, false);
        const end = node.getEnd();
        const startPoint = sourceFile.getLineAndCharacterOfPosition(start);
        const endPoint = sourceFile.getLineAndCharacterOfPosition(end);
        candidates.push({
          sourceFile,
          node,
          start,
          end,
          report: {
            filePath: displayPath(sourceFile.fileName, project.cwd),
            start: { line: startPoint.line + 1, column: startPoint.character + 1 },
            end: { line: endPoint.line + 1, column: endPoint.character + 1 },
            kind: ts.isSwitchStatement(node) ? "switch" : ts.isConditionalExpression(node) ? "ternary" : "if-chain",
            branchCount: ts.isConditionalExpression(node) ? 2 : 0,
            action: "skipped",
          },
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return candidates.sort((left, right) =>
    left.report.filePath.localeCompare(right.report.filePath) || left.start - right.start || right.end - left.end);
}

function analyzeCandidate(candidate: InternalCandidate, checker: ts.TypeChecker, importPlan: ImportPlan): void {
  if (ts.isSwitchStatement(candidate.node)) analyzeSwitch(candidate, checker, importPlan);
  else if (ts.isIfStatement(candidate.node)) analyzeIf(candidate, checker, importPlan);
  else analyzeTernary(candidate, checker, importPlan);
}

function analyzeIf(candidate: InternalCandidate, checker: ts.TypeChecker, importPlan: ImportPlan): void {
  const node = candidate.node as ts.IfStatement;
  const expressions: ts.Expression[] = [];
  const statements: ts.Statement[] = [];
  let current: ts.IfStatement | undefined = node;
  let fallback: ts.Statement | undefined;
  while (current) {
    expressions.push(current.expression);
    statements.push(current.thenStatement);
    if (current.elseStatement && ts.isIfStatement(current.elseStatement)) current = current.elseStatement;
    else {
      fallback = current.elseStatement;
      current = undefined;
    }
  }
  candidate.report.branchCount = statements.length + (fallback ? 1 : 0);
  const explicit = expressions
    .map((expression) => analyzePatternFirstCondition(expression, checker))
    .filter((result): result is PatternCondition => result !== undefined && !("error" in result));
  const explicitSymbols = uniqueSymbols(explicit.map((condition) => condition.subjectSymbol));
  const preferredSubject = explicitSymbols.length === 1 ? explicitSymbols[0] : undefined;
  const conditions: PatternCondition[] = [];
  for (const expression of expressions) {
    const condition = analyzeCondition(expression, checker, preferredSubject);
    if ("error" in condition) {
      skip(candidate, condition.error.code, condition.error.message);
      return;
    }
    conditions.push(condition);
  }
  const consistency = consistentConditions(conditions);
  if (consistency) {
    skip(candidate, consistency.code, consistency.message);
    return;
  }
  const first = conditions[0];
  assignIfReportMetadata(candidate.report, conditions);
  const branches: MatchBranch[] = conditions.map((condition, index) => ({
    condition,
    statement: statements[index],
  }));
  if (fallback) branches.push({ statement: fallback });
  const branchAnalysis = analyzeBranches(branches, node);
  if (branchAnalysis.error) {
    skip(candidate, branchAnalysis.error.code, branchAnalysis.error.message);
    return;
  }
  const requiresP = conditions.some(conditionRequiresP);
  if (!fallback) {
    proposeImplicitFallback(
      candidate, node, first, branches, branchAnalysis, checker, importPlan, requiresP,
    );
    return;
  }
  const otherwise = renderStatementMatch(candidate.sourceFile, node, importPlan, first, branches, branchAnalysis, "otherwise");
  const proposals: CandidateProposal[] = [];
  if (!referencesSubject([fallback], first.subject, checker)) {
    proposals.push({
      replacement: renderStatementMatch(candidate.sourceFile, node, importPlan, first, branches, branchAnalysis, "exhaustive"),
      terminator: "exhaustive",
      requiresP,
      fallbackKind: "explicit",
    });
  }
  proposals.push({ replacement: otherwise, terminator: "otherwise", requiresP, fallbackKind: "explicit" });
  const fallbackNarrowing = conditions.length === 1 && branchAnalysis.mode === "return"
    && !writesSubject([fallback], first.subject, checker)
    ? negatedPrimitiveComplement(first)
    : undefined;
  if (fallbackNarrowing) {
    proposals.push({
      replacement: renderStatementMatch(
        candidate.sourceFile,
        node,
        importPlan,
        first,
        branches,
        branchAnalysis,
        "otherwise",
        fallbackNarrowing,
      ),
      terminator: "otherwise",
      requiresP,
      fallbackKind: "explicit",
    });
  }
  setProposals(candidate, proposals);
}

function analyzeTernary(candidate: InternalCandidate, checker: ts.TypeChecker, importPlan: ImportPlan): void {
  const node = candidate.node as ts.ConditionalExpression;
  if (containsComment(node.condition)) {
    skip(candidate, "unsupported-condition", "condition comments cannot be relocated safely");
    return;
  }
  const condition = analyzeCondition(node.condition, checker);
  if ("error" in condition) {
    skip(candidate, condition.error.code, condition.error.message);
    return;
  }
  candidate.report.subject = condition.subjectText;
  const paths = conditionDiscriminatorPaths([condition]);
  if (paths.length > 0) candidate.report.discriminators = paths;
  if (paths.length === 1) candidate.report.discriminator = paths[0];
  if (condition.clause === "when") candidate.report.kind = "guard-if";
  candidate.report.branchCount = 2;
  const forbidden = findForbiddenNode([node.whenTrue, node.whenFalse]);
  if (forbidden) {
    skip(candidate, forbidden.code, forbidden.message);
    return;
  }
  const indent = indentationAt(candidate.sourceFile.text, candidate.start);
  const trueHandler = renderExpressionHandler(node.whenTrue, condition.subject, checker);
  const falseHandler = renderExpressionHandler(node.whenFalse, condition.subject, checker);
  const clause = renderConditionClause(condition, importPlan, trueHandler);
  const otherwise = `${importPlan.matchName}(${condition.subjectText})\n${indent}  ${clause}\n${indent}  .otherwise(${falseHandler})`;
  const proposals: CandidateProposal[] = [];
  if (!referencesSubject([node.whenFalse], condition.subject, checker)) {
    proposals.push({
      replacement: `${importPlan.matchName}(${condition.subjectText})\n${indent}  ${clause}\n${indent}  .exhaustive(${falseHandler})`,
      terminator: "exhaustive",
      requiresP: conditionRequiresP(condition),
      fallbackKind: "explicit",
    });
  }
  proposals.push({
    replacement: otherwise,
    terminator: "otherwise",
    requiresP: conditionRequiresP(condition),
    fallbackKind: "explicit",
  });
  const fallbackNarrowing = !writesSubject([node.whenFalse], condition.subject, checker)
    ? negatedPrimitiveComplement(condition)
    : undefined;
  if (fallbackNarrowing) {
    proposals.push({
      replacement: `${importPlan.matchName}(${condition.subjectText})\n${indent}  ${clause}\n${indent}  .otherwise(${renderNarrowedExpressionHandler(node.whenFalse, condition.subject, fallbackNarrowing, importPlan)})`,
      terminator: "otherwise",
      requiresP: conditionRequiresP(condition),
      fallbackKind: "explicit",
    });
  }
  setProposals(candidate, proposals);
}

function analyzeSwitch(candidate: InternalCandidate, checker: ts.TypeChecker, importPlan: ImportPlan): void {
  const node = candidate.node as ts.SwitchStatement;
  if (containsComment(node.expression)) {
    skip(candidate, "unsupported-pattern", "switch subject comments cannot be relocated safely");
    return;
  }
  if (!isStableSubject(node.expression)) {
    skip(candidate, "effectful-subject", "switch subject is not a stable identifier or property path");
    return;
  }
  const clauses = node.caseBlock.clauses;
  const defaultIndex = clauses.findIndex(ts.isDefaultClause);
  const hasDefault = defaultIndex >= 0;
  if (hasDefault && defaultIndex !== clauses.length - 1) {
    candidate.report.branchCount = clauses.length;
    skip(candidate, "default-not-final", "switch default clause is not final");
    return;
  }
  const branches: MatchBranch[] = [];
  let pending: ts.Expression[] = [];
  let pendingComments: string[] = [];
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
    const clause = clauses[clauseIndex];
    pendingComments.push(...leadingComments(clause, candidate.sourceFile));
    if (ts.isCaseClause(clause)) {
      if (containsComment(clause.expression)) {
        candidate.report.branchCount = clauses.length;
        skip(candidate, "unsupported-pattern", "switch case comments cannot be relocated safely");
        return;
      }
      if (!isPatternExpression(clause.expression, checker)) {
        candidate.report.branchCount = clauses.length;
        skip(candidate, "unsupported-pattern", `unsupported switch case pattern: ${clause.expression.getText(candidate.sourceFile)}`);
        return;
      }
      pending.push(clause.expression);
      if (clause.statements.length === 0) continue;
      const terminal = switchClauseTerminal(clause.statements);
      const implicitFinalExit = !hasDefault && clauseIndex === clauses.length - 1;
      if (!terminal && !implicitFinalExit) {
        candidate.report.branchCount = clauses.length;
        skip(candidate, "switch-fallthrough", "non-empty switch case can fall through");
        return;
      }
      branches.push({
        condition: {
          kind: "scalar",
          clause: "with",
          subject: node.expression,
          subjectText: node.expression.getText(candidate.sourceFile),
          subjectSymbol: ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression) : undefined,
          patterns: pending.map((pattern) => ({
            pattern: literalPatternNode(pattern, checker),
            paths: [],
          })),
        },
        statements: clause.statements,
        stripFinalBreak: terminal === "break",
        leadingComments: pendingComments,
      });
      pending = [];
      pendingComments = [];
    } else {
      if (pending.length > 0) {
        candidate.report.branchCount = clauses.length;
        skip(candidate, "switch-fallthrough", "empty case labels fall through into default");
        return;
      }
      branches.push({
        statements: clause.statements,
        stripFinalBreak: switchClauseTerminal(clause.statements) === "break",
        leadingComments: pendingComments,
      });
      pendingComments = [];
    }
  }
  candidate.report.branchCount = clauses.length;
  candidate.report.subject = node.expression.getText(candidate.sourceFile);
  const branchAnalysis = analyzeBranches(branches, node);
  if (branchAnalysis.error) {
    skip(candidate, branchAnalysis.error.code, branchAnalysis.error.message);
    return;
  }
  const condition: PatternCondition = {
    kind: "scalar",
    clause: "with",
    subject: node.expression,
    subjectText: node.expression.getText(candidate.sourceFile),
    subjectSymbol: ts.isIdentifier(node.expression) ? checker.getSymbolAtLocation(node.expression) : undefined,
    patterns: [],
  };
  const requiresP = branches.some((branch) => branch.condition && conditionRequiresP(branch.condition));
  if (!hasDefault) {
    proposeImplicitFallback(
      candidate, node, condition, branches, branchAnalysis, checker, importPlan, requiresP,
      pendingComments,
    );
    return;
  }
  const fallback = branches.at(-1)!;
  const proposals: CandidateProposal[] = [];
  if (!referencesSubject(statementsForBranch(fallback), condition.subject, checker)) {
    proposals.push({
      replacement: renderStatementMatch(candidate.sourceFile, node, importPlan, condition, branches, branchAnalysis, "exhaustive"),
      terminator: "exhaustive",
      requiresP,
      fallbackKind: "explicit",
    });
  }
  proposals.push({
    replacement: renderStatementMatch(candidate.sourceFile, node, importPlan, condition, branches, branchAnalysis, "otherwise"),
    terminator: "otherwise",
    requiresP,
    fallbackKind: "explicit",
  });
  setProposals(candidate, proposals);
}

function proposeImplicitFallback(
  candidate: InternalCandidate,
  node: ts.IfStatement | ts.SwitchStatement,
  condition: PatternCondition,
  explicitBranches: MatchBranch[],
  branchAnalysis: BranchAnalysis,
  checker: ts.TypeChecker,
  importPlan: ImportPlan,
  requiresP: boolean,
  fallbackComments: string[] = [],
): void {
  if (branchAnalysis.mode === "imperative") {
    const branches = [...explicitBranches, {
      syntheticFallback: "noop" as const,
      leadingComments: fallbackComments,
    }];
    setProposals(candidate, [{
      replacement: renderStatementMatch(
        candidate.sourceFile, node, importPlan, condition, branches, branchAnalysis, "otherwise",
      ),
      terminator: "otherwise",
      requiresP,
      fallbackKind: "implicit-noop",
    }]);
    return;
  }

  const continuation = planUnmatchedContinuation(node, candidate.sourceFile, checker);
  if ("error" in continuation) {
    skip(candidate, continuation.error.code, continuation.error.message);
    return;
  }
  const hasContinuation = continuation.statements.length > 0;
  const fallback: MatchBranch = hasContinuation
    ? {
      statements: continuation.statements,
      syntheticFallback: "continuation",
      preserveSubjectBinding: writesSubject(continuation.statements, condition.subject, checker),
      leadingComments: fallbackComments,
    }
    : { syntheticFallback: "undefined", leadingComments: fallbackComments };
  const branches = [...explicitBranches, fallback];
  setProposals(candidate, [{
    replacement: renderStatementMatch(
      candidate.sourceFile, node, importPlan, condition, branches, branchAnalysis, "otherwise",
    ),
    terminator: "otherwise",
    requiresP,
    fallbackKind: hasContinuation ? "absorbed-continuation" : "implicit-undefined",
    editEnd: continuation.editEnd,
    additionalEdits: continuation.additionalEdits,
    duplicatedContinuationBytes: continuation.duplicatedBytes,
  }]);
}

function planUnmatchedContinuation(
  node: ts.IfStatement | ts.SwitchStatement,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): ContinuationPlan | { error: { code: TsPatternSkipReason; message: string } } {
  const owner = findFunctionLikeAncestor(node);
  if (!owner || !owner.body || !ts.isBlock(owner.body)) {
    return { error: {
      code: "unsupported-branch-shape",
      message: "returning no-fallback conversion requires a block-bodied function owner",
    } };
  }
  const statements: ts.Statement[] = [];
  const additionalEdits: TextEdit[] = [];
  let duplicatedBytes = 0;
  let editEnd = node.getEnd();
  let cursor: ts.Statement = node;
  let exclusive = true;

  while (true) {
    const parent = cursor.parent;
    if (ts.isBlock(parent)) {
      const index = parent.statements.indexOf(cursor);
      if (index < 0) {
        return { error: { code: "outer-control-flow", message: "continuation owner is not a block statement" } };
      }
      const following = [...parent.statements.slice(index + 1)];
      if (following.length > 0) {
        statements.push(...following);
        const first = following[0];
        const last = following.at(-1)!;
        if (exclusive) {
          if (cursor === node) editEnd = last.getEnd();
          else additionalEdits.push({ start: first.getFullStart(), end: last.getEnd(), replacement: "" });
        } else {
          duplicatedBytes += Buffer.byteLength(
            sourceFile.text.slice(first.getFullStart(), last.getEnd()), "utf8",
          );
        }
      }
      if (parent === owner.body) break;
      if (blockHasActiveUsingBefore(parent, index)) {
        return { error: {
          code: "scope-change",
          message: "continuation crosses a block with an active using declaration",
        } };
      }
      const container = parent.parent;
      if (ts.isIfStatement(container) &&
        (container.thenStatement === parent || container.elseStatement === parent)) {
        exclusive = false;
        cursor = container;
        continue;
      }
      if (ts.isBlock(container)) {
        cursor = parent;
        continue;
      }
      return { error: {
        code: continuationBoundaryCode(container),
        message: `unmatched continuation crosses unsupported ${ts.SyntaxKind[container.kind]} boundary`,
      } };
    }
    if (ts.isIfStatement(parent) &&
      (parent.thenStatement === cursor || parent.elseStatement === cursor)) {
      exclusive = false;
      cursor = parent;
      continue;
    }
    return { error: {
      code: continuationBoundaryCode(parent),
      message: `unmatched continuation crosses unsupported ${ts.SyntaxKind[parent.kind]} boundary`,
    } };
  }

  const forbidden = findContinuationForbidden(statements);
  if (forbidden) return { error: forbidden };
  const scopeError = continuationScopeError(statements, owner, checker);
  if (scopeError) return { error: scopeError };
  return { statements, editEnd, additionalEdits, duplicatedBytes };
}

function continuationBoundaryCode(node: ts.Node): TsPatternSkipReason {
  return ts.isBlock(node) ? "scope-change" : "outer-control-flow";
}

function blockHasActiveUsingBefore(block: ts.Block, index: number): boolean {
  return block.statements.slice(0, index + 1).some((statement) =>
    ts.isVariableStatement(statement) &&
    Boolean(statement.declarationList.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)));
}

function findContinuationForbidden(
  roots: readonly ts.Statement[],
): { code: TsPatternSkipReason; message: string } | undefined {
  let result: { code: TsPatternSkipReason; message: string } | undefined;
  const visit = (node: ts.Node): void => {
    if (result || isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) result = { code: "await", message: "absorbed continuation contains await" };
    else if (ts.isYieldExpression(node)) result = { code: "yield", message: "absorbed continuation contains yield" };
    else if (ts.isLabeledStatement(node)) {
      result = { code: "labeled-control-flow", message: "absorbed continuation contains a labeled statement" };
    } else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      const target = controlFlowTarget(node);
      if (node.label || !target || !roots.some((root) => isDescendantOf(target, root))) {
        result = { code: "outer-control-flow", message: "absorbed continuation targets outer control flow" };
      }
    } else if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node)) {
      result = { code: "scope-change", message: "absorbed continuation contains super or new.target" };
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      result = { code: "scope-change", message: "absorbed continuation contains direct eval" };
    }
    if (!result) ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  return result;
}

function continuationScopeError(
  roots: readonly ts.Statement[],
  owner: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): { code: TsPatternSkipReason; message: string } | undefined {
  if (containsDirectEval(owner)) {
    return { code: "scope-change", message: "function containing absorbed continuation uses direct eval" };
  }
  const movedSymbols = new Set<ts.Symbol>();
  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) collectBindingSymbols(node.name, checker, movedSymbols);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) ||
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) movedSymbols.add(symbol);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingSymbols(node.variableDeclaration.name, checker, movedSymbols);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  roots.forEach(collectDeclarations);
  if (movedSymbols.size === 0) return undefined;
  let escaped: ts.Identifier | undefined;
  const visitReferences = (node: ts.Node): void => {
    if (escaped) return;
    if (ts.isIdentifier(node) && movedSymbols.has(checker.getSymbolAtLocation(node)!) &&
      !roots.some((root) => isDescendantOf(node, root))) {
      escaped = node;
      return;
    }
    ts.forEachChild(node, visitReferences);
  };
  visitReferences(owner);
  return escaped ? {
    code: "scope-change",
    message: `moved declaration ${escaped.text} is referenced outside the absorbed continuation`,
  } : undefined;
}

function collectBindingSymbols(
  name: ts.BindingName,
  checker: ts.TypeChecker,
  target: Set<ts.Symbol>,
): void {
  if (ts.isIdentifier(name)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) target.add(symbol);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingSymbols(element.name, checker, target);
  }
}

function containsDirectEval(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval") {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function analyzeCondition(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  preferredSubject?: ts.Symbol,
): PatternCondition | { error: { code: TsPatternSkipReason; message: string } } {
  if (containsComment(expression)) {
    return { error: { code: "unsupported-condition", message: "condition comments cannot be relocated safely" } };
  }
  const patternFirst = analyzePatternFirstCondition(expression, checker);
  if (patternFirst) return patternFirst;
  const guardError = analyzeGuardSafety(expression);
  if (guardError) return { error: guardError };
  const roots = collectGuardRoots(expression, checker);
  const selected = preferredSubject
    ? roots.find((root) => root.symbol === preferredSubject)
    : roots.length === 1 ? roots[0] : undefined;
  if (!selected) {
    return {
      error: {
        code: "ambiguous-guard-subject",
        message: roots.length === 0 ? "guard has no stable match subject" : "guard references multiple possible match subjects",
      },
    };
  }
  return {
    kind: "guard",
    clause: "when",
    subject: selected.identifier,
    subjectText: selected.identifier.text,
    subjectSymbol: selected.symbol,
    patterns: [],
    guardText: expression.getText(),
  };
}

function analyzePatternFirstCondition(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): PatternCondition | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  const conjuncts = flattenAnd(expression);
  const disjuncts = flattenOr(conjuncts[0]);
  const alternatives: PatternAlternative[] = [];
  const allAtoms: AtomicPattern[] = [];
  let guardStart = 0;

  if (disjuncts.length > 1) {
    for (const disjunct of disjuncts) {
      const parsed = analyzePatternConjunction(flattenAnd(disjunct), checker, true);
      if (!parsed || "error" in parsed) return parsed;
      alternatives.push(buildPatternAlternative(parsed.atoms));
      allAtoms.push(...parsed.atoms);
    }
    guardStart = 1;
  } else {
    const parsed = analyzePatternConjunction(conjuncts, checker, false);
    if (!parsed || "error" in parsed) return parsed;
    alternatives.push(buildPatternAlternative(parsed.atoms));
    allAtoms.push(...parsed.atoms);
    guardStart = parsed.consumed;
  }

  const consistency = consistentAtomicSubjects(allAtoms);
  if (consistency) return { error: consistency };
  for (const conjunct of conjuncts.slice(guardStart)) {
    const error = analyzeGuardSafety(conjunct);
    if (error) return { error };
  }
  const first = allAtoms[0];
  const guardText = conjuncts.slice(guardStart).map((item) => item.getText()).join(" && ");
  return {
    kind: patternConditionKind(alternatives),
    clause: "with",
    subject: first.subject,
    subjectText: first.subjectText,
    subjectSymbol: first.subjectSymbol,
    patterns: alternatives,
    ...(guardText ? { guardText } : {}),
  };
}

function analyzePatternConjunction(
  conjuncts: readonly ts.Expression[],
  checker: ts.TypeChecker,
  requireComplete: boolean,
): { atoms: AtomicPattern[]; consumed: number } |
  { error: { code: TsPatternSkipReason; message: string } } | undefined {
  const atoms: AtomicPattern[] = [];
  for (let index = 0; index < conjuncts.length; index += 1) {
    const atom = analyzeAtomicPattern(conjuncts[index], checker, atoms);
    if (!atom) {
      if (requireComplete || atoms.length === 0 || requiresWholeGuard(conjuncts[index])) return undefined;
      return { atoms, consumed: index };
    }
    if ("error" in atom) return atom;
    atoms.push(atom);
  }
  return atoms.length > 0 ? { atoms, consumed: conjuncts.length } : undefined;
}

function analyzeAtomicPattern(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  prior: readonly AtomicPattern[],
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  expression = unwrapParentheses(expression);
  if (isPotentialTypeofComparison(expression)) return analyzeTypeofPattern(expression, checker);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
    return analyzeInstanceOfPattern(expression, checker);
  }
  if (isPotentialNumberPredicate(expression)) return analyzeNumberPredicate(expression as ts.CallExpression, checker);
  if (isPotentialStringPredicate(expression)) return analyzeStringPredicate(expression as ts.CallExpression, checker, prior);
  if (isPotentialStringLengthComparison(expression)) {
    return analyzeStringLengthPattern(expression as ts.BinaryExpression, checker, prior);
  }
  if (isPotentialNumericComparison(expression)) {
    return analyzeNumericPattern(expression as ts.BinaryExpression, checker, prior);
  }
  return analyzeStrictLiteralPattern(expression, checker);
}

function analyzeTypeofPattern(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  const operator = expression.operatorToken.kind;
  if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) {
    return { error: { code: "loose-equality", message: "loose equality is not supported" } };
  }
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    return undefined;
  }
  const leftTypeof = ts.isTypeOfExpression(unwrapParentheses(expression.left));
  const rightTypeof = ts.isTypeOfExpression(unwrapParentheses(expression.right));
  if (leftTypeof === rightTypeof) {
    return { error: { code: "unsupported-pattern", message: "typeof comparison must contain one string type tag" } };
  }
  const typeExpression = unwrapParentheses(leftTypeof ? expression.left : expression.right) as ts.TypeOfExpression;
  const tagExpression = unwrapParentheses(leftTypeof ? expression.right : expression.left);
  if (!ts.isStringLiteral(tagExpression)) {
    return { error: { code: "unsupported-pattern", message: "typeof comparison must use a string literal type tag" } };
  }
  const validTags = new Set(["string", "number", "bigint", "boolean", "symbol", "undefined", "object", "function"]);
  if (!validTags.has(tagExpression.text)) {
    return { error: { code: "unsupported-pattern", message: `unsupported typeof type tag: ${tagExpression.text}` } };
  }
  if (tagExpression.text === "object" || tagExpression.text === "function") return undefined;
  const decomposition = decomposeConditionSubject(typeExpression.expression, checker);
  if ("error" in decomposition) return { error: decomposition.error };
  const negated = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if ((tagExpression.text === "undefined" && decomposition.hasOptionalAccess) ||
    (negated && decomposition.path.length > 0 && decomposition.leafOptional)) return undefined;
  const family = tagExpression.text === "undefined" ? undefined : tagExpression.text as PrimitivePatternFamily;
  const base: PatternNode = family ? { kind: "primitive", family } : { kind: "raw", text: "void 0" };
  return atomicPattern(decomposition, checker, negated ? { kind: "not", pattern: base } : base,
    negated ? undefined : family);
}

function analyzeInstanceOfPattern(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  if (!isStableSubject(expression.right) || checker.getTypeAtLocation(expression.right).getConstructSignatures().length === 0) {
    return undefined;
  }
  const decomposition = decomposeConditionSubject(expression.left, checker);
  if ("error" in decomposition) return { error: decomposition.error };
  return atomicPattern(decomposition, checker, { kind: "instance-of", constructor: expression.right });
}

function analyzeNumberPredicate(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.arguments.length !== 1 ||
    !ts.isIdentifier(expression.expression.expression) ||
    !isGlobalNumberIdentifier(expression.expression.expression, checker)) return undefined;
  const operation = expression.expression.name.text === "isInteger" ? "int"
    : expression.expression.name.text === "isFinite" ? "finite" : undefined;
  if (!operation) return undefined;
  const decomposition = decomposeConditionSubject(expression.arguments[0], checker);
  if ("error" in decomposition) return { error: decomposition.error };
  return atomicPattern(decomposition, checker, {
    kind: "numeric",
    family: "number",
    operation,
    arguments: [],
  }, "number");
}

function analyzeNumericPattern(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
  prior: readonly AtomicPattern[],
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  const leftBound = numericLiteralInfo(expression.left);
  const rightBound = numericLiteralInfo(expression.right);
  if (Boolean(leftBound) === Boolean(rightBound)) return undefined;
  const subjectExpression = leftBound ? expression.right : expression.left;
  const bound = leftBound ?? rightBound!;
  const safetyError = analyzeGuardSafety(subjectExpression);
  if (safetyError) return { error: safetyError };
  const decomposition = decomposeConditionSubject(subjectExpression, checker);
  if ("error" in decomposition) return { error: decomposition.error };
  if (!hasTypeEvidence(prior, decomposition, bound.family)) return undefined;
  const operation = relationalOperation(expression.operatorToken.kind, !leftBound);
  if (!operation) return undefined;
  return atomicPattern(decomposition, checker, {
    kind: "numeric",
    family: bound.family,
    operation,
    arguments: [bound.expression],
  }, bound.family);
}

function analyzeStringPredicate(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  prior: readonly AtomicPattern[],
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  if (!ts.isPropertyAccessExpression(expression.expression)) return undefined;
  const method = expression.expression.name.text;
  if (method === "test" && ts.isRegularExpressionLiteral(expression.expression.expression) && expression.arguments.length === 1) {
    const flags = expression.expression.expression.text.slice(expression.expression.expression.text.lastIndexOf("/") + 1);
    if (flags.includes("g") || flags.includes("y")) return undefined;
    const decomposition = decomposeConditionSubject(expression.arguments[0], checker);
    if ("error" in decomposition) return { error: decomposition.error };
    if (!hasTypeEvidence(prior, decomposition, "string")) return undefined;
    return atomicPattern(decomposition, checker, {
      kind: "string",
      operation: "regex",
      argument: expression.expression.expression,
    }, "string");
  }
  if (method !== "startsWith" && method !== "endsWith" && method !== "includes") return undefined;
  if (expression.arguments.length !== 1 || !isStringConstant(expression.arguments[0])) return undefined;
  const decomposition = decomposeConditionSubject(expression.expression.expression, checker);
  if ("error" in decomposition) return { error: decomposition.error };
  if (!hasTypeEvidence(prior, decomposition, "string")) return undefined;
  return atomicPattern(decomposition, checker, {
    kind: "string",
    operation: method,
    argument: expression.arguments[0],
  }, "string");
}

function analyzeStringLengthPattern(
  expression: ts.BinaryExpression,
  checker: ts.TypeChecker,
  prior: readonly AtomicPattern[],
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  const leftLength = stringLengthSubject(expression.left);
  const rightLength = stringLengthSubject(expression.right);
  if (Boolean(leftLength) === Boolean(rightLength)) return undefined;
  const lengthExpression = leftLength ?? rightLength!;
  const boundExpression = leftLength ? expression.right : expression.left;
  const bound = numericLiteralInfo(boundExpression);
  if (!bound || bound.family !== "number" || bound.numberValue === undefined ||
    !Number.isSafeInteger(bound.numberValue) || bound.numberValue < 0) return undefined;
  const decomposition = decomposeConditionSubject(lengthExpression, checker);
  if ("error" in decomposition) return { error: decomposition.error };
  if (!hasTypeEvidence(prior, decomposition, "string")) return undefined;
  const operator = normalizedOperator(expression.operatorToken.kind, Boolean(leftLength));
  let pattern: PatternNode;
  if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    const exact: PatternNode = { kind: "string", operation: "length", argument: bound.expression };
    pattern = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ? { kind: "not", pattern: exact } : exact;
  } else if (operator === ts.SyntaxKind.GreaterThanEqualsToken) {
    pattern = { kind: "string", operation: "minLength", argument: bound.expression };
  } else if (operator === ts.SyntaxKind.GreaterThanToken) {
    pattern = { kind: "string", operation: "minLength", argument: String(bound.numberValue + 1) };
  } else if (operator === ts.SyntaxKind.LessThanEqualsToken) {
    pattern = { kind: "string", operation: "maxLength", argument: bound.expression };
  } else if (operator === ts.SyntaxKind.LessThanToken) {
    pattern = { kind: "string", operation: "maxLength", argument: String(bound.numberValue - 1) };
  } else if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) {
    return { error: { code: "loose-equality", message: "loose equality is not supported" } };
  } else return undefined;
  return atomicPattern(decomposition, checker, pattern, "string");
}

function analyzeStrictLiteralPattern(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): AtomicPattern | { error: { code: TsPatternSkipReason; message: string } } | undefined {
  if (!ts.isBinaryExpression(expression)) return undefined;
  const operator = expression.operatorToken.kind;
  if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken) {
    return { error: { code: "loose-equality", message: "loose equality is not supported" } };
  }
  if (operator !== ts.SyntaxKind.EqualsEqualsEqualsToken && operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
    return undefined;
  }
  const leftPattern = isPatternExpression(expression.left, checker);
  const rightPattern = isPatternExpression(expression.right, checker);
  if (leftPattern === rightPattern) {
    return { error: { code: "unsupported-pattern", message: "comparison must have exactly one literal or enum pattern" } };
  }
  const subject = leftPattern ? expression.right : expression.left;
  const literal = leftPattern ? expression.left : expression.right;
  const decomposition = decomposeConditionSubject(subject, checker);
  if ("error" in decomposition) return { error: decomposition.error };
  if (operator === ts.SyntaxKind.ExclamationEqualsEqualsToken && decomposition.path.length > 0 &&
    decomposition.leafOptional) return undefined;
  const base = literalPatternNode(literal, checker);
  return atomicPattern(decomposition, checker,
    operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ? { kind: "not", pattern: base } : base);
}

function consistentConditions(
  conditions: readonly PatternCondition[],
): { code: TsPatternSkipReason; message: string } | undefined {
  const first = conditions[0];
  if (conditions.some((condition) =>
    first.subjectSymbol && condition.subjectSymbol
      ? condition.subjectSymbol !== first.subjectSymbol
      : condition.subjectText !== first.subjectText)) {
    return { code: "inconsistent-subject", message: "branches compare different match subjects" };
  }
  return undefined;
}

function atomicPattern(
  decomposition: { root: ts.Identifier; path: string[] },
  checker: ts.TypeChecker,
  pattern: PatternNode,
  evidenceFamily?: PrimitivePatternFamily,
): AtomicPattern {
  return {
    subject: decomposition.root,
    subjectText: decomposition.root.text,
    subjectSymbol: checker.getSymbolAtLocation(decomposition.root),
    path: decomposition.path,
    pattern,
    ...(evidenceFamily ? { evidenceFamily } : {}),
  };
}

function consistentAtomicSubjects(
  atoms: readonly AtomicPattern[],
): { code: TsPatternSkipReason; message: string } | undefined {
  const first = atoms[0];
  if (atoms.some((atom) => first.subjectSymbol && atom.subjectSymbol
    ? atom.subjectSymbol !== first.subjectSymbol
    : atom.subjectText !== first.subjectText)) {
    return { code: "inconsistent-subject", message: "condition alternatives use different match subjects" };
  }
  return undefined;
}

function buildPatternAlternative(atoms: readonly AtomicPattern[]): PatternAlternative {
  const groups = new Map<string, { path: string[]; atoms: AtomicPattern[] }>();
  for (const atom of atoms) {
    const key = atom.path.join("\0");
    const group = groups.get(key) ?? { path: atom.path, atoms: [] };
    group.atoms.push(atom);
    groups.set(key, group);
  }
  const patterns = [...groups.values()].map((group) => {
    const leaf = combineLeafPatterns(group.atoms);
    return group.path.length > 0 ? { kind: "nested", path: group.path, pattern: leaf } as PatternNode : leaf;
  });
  return {
    pattern: patterns.length === 1 ? patterns[0] : { kind: "intersection", patterns },
    paths: [...groups.values()].map((group) => group.path),
  };
}

function combineLeafPatterns(atoms: readonly AtomicPattern[]): PatternNode {
  let patterns = atoms.map((atom) => atom.pattern);
  patterns = patterns.filter((pattern, index) => {
    if (pattern.kind !== "primitive") return true;
    return !patterns.some((other, otherIndex) =>
      otherIndex !== index && other.kind !== "primitive" && patternEnforcedFamily(other) === pattern.family);
  });
  if (patterns.length === 2 && patterns.every((pattern) => pattern.kind === "numeric")) {
    const numeric = patterns as Array<Extract<PatternNode, { kind: "numeric" }>>;
    if (numeric[0].family === numeric[1].family) {
      const lower = numeric.find((pattern) => pattern.operation === "gte");
      const upper = numeric.find((pattern) => pattern.operation === "lte");
      if (lower && upper) {
        return {
          kind: "numeric",
          family: lower.family,
          operation: "between",
          arguments: [lower.arguments[0], upper.arguments[0]],
        };
      }
    }
  }
  return patterns.length === 1 ? patterns[0] : { kind: "intersection", patterns };
}

function patternEnforcedFamily(pattern: PatternNode): PrimitivePatternFamily | undefined {
  if (pattern.kind === "primitive") return pattern.family;
  if (pattern.kind === "numeric") return pattern.family;
  if (pattern.kind === "string") return "string";
  return undefined;
}

function patternConditionKind(alternatives: readonly PatternAlternative[]): PatternCondition["kind"] {
  const paths = uniquePatternPaths(alternatives.flatMap((alternative) => alternative.paths));
  const nonRoot = paths.filter((path) => path.length > 0);
  if (nonRoot.length === 0) return "scalar";
  if (paths.some((path) => path.length === 0) || nonRoot.length > 1) return "structural";
  return "discriminated";
}

function uniquePatternPaths(paths: readonly string[][]): string[][] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = path.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function conditionDiscriminatorPaths(conditions: readonly PatternCondition[]): string[] {
  const paths = conditions.flatMap((condition) => condition.patterns.flatMap((pattern) => pattern.paths));
  return uniquePatternPaths(paths).filter((path) => path.length > 0).map((path) => path.join("."));
}

function assignIfReportMetadata(
  report: TsPatternCandidateReport,
  conditions: readonly PatternCondition[],
): void {
  const first = conditions[0];
  report.subject = first.subjectText;
  const paths = conditionDiscriminatorPaths(conditions);
  if (paths.length > 0) report.discriminators = paths;
  if (paths.length === 1) report.discriminator = paths[0];
  if (conditions.some((condition) => condition.clause === "when")) report.kind = "guard-if";
  else {
    const patternPaths = uniquePatternPaths(
      conditions.flatMap((condition) => condition.patterns.flatMap((pattern) => pattern.paths)),
    );
    const nonRoot = patternPaths.filter((patternPath) => patternPath.length > 0);
    report.kind = nonRoot.length === 0
      ? "scalar-if"
      : patternPaths.some((patternPath) => patternPath.length === 0) || nonRoot.length > 1
        ? "structural-if"
        : "discriminated-if";
  }
}

function hasTypeEvidence(
  prior: readonly AtomicPattern[],
  decomposition: { root: ts.Identifier; path: string[] },
  family: PrimitivePatternFamily,
): boolean {
  return prior.some((atom) => atom.evidenceFamily === family && atom.path.join("\0") === decomposition.path.join("\0") &&
    atom.subjectText === decomposition.root.text);
}

function isPotentialTypeofComparison(expression: ts.Expression): expression is ts.BinaryExpression {
  return ts.isBinaryExpression(expression) &&
    (ts.isTypeOfExpression(unwrapParentheses(expression.left)) || ts.isTypeOfExpression(unwrapParentheses(expression.right)));
}

function isPotentialNumberPredicate(expression: ts.Expression): expression is ts.CallExpression {
  return ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Number" &&
    (expression.expression.name.text === "isInteger" || expression.expression.name.text === "isFinite");
}

function isPotentialStringPredicate(expression: ts.Expression): expression is ts.CallExpression {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return false;
  const method = expression.expression.name.text;
  return method === "startsWith" || method === "endsWith" || method === "includes" ||
    (method === "test" && ts.isRegularExpressionLiteral(expression.expression.expression));
}

function isPotentialStringLengthComparison(expression: ts.Expression): expression is ts.BinaryExpression {
  if (!ts.isBinaryExpression(expression)) return false;
  const leftLength = stringLengthSubject(expression.left);
  const rightLength = stringLengthSubject(expression.right);
  if (Boolean(leftLength) === Boolean(rightLength)) return false;
  const bound = numericLiteralInfo(leftLength ? expression.right : expression.left);
  return bound?.family === "number";
}

function isPotentialNumericComparison(expression: ts.Expression): expression is ts.BinaryExpression {
  if (!ts.isBinaryExpression(expression) || !relationalOperation(expression.operatorToken.kind, true)) return false;
  return Boolean(numericLiteralInfo(expression.left)) !== Boolean(numericLiteralInfo(expression.right));
}

function requiresWholeGuard(expression: ts.Expression): boolean {
  expression = unwrapParentheses(expression);
  if (isPotentialStringPredicate(expression) || isPotentialStringLengthComparison(expression) ||
    isPotentialNumberPredicate(expression)) return true;
  if (!ts.isBinaryExpression(expression)) return false;
  return expression.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword ||
    Boolean(relationalOperation(expression.operatorToken.kind, true));
}

function stringLengthSubject(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrapParentheses(expression);
  return ts.isPropertyAccessExpression(expression) && !expression.questionDotToken && expression.name.text === "length"
    ? expression.expression
    : undefined;
}

interface NumericLiteralInfo {
  family: "number" | "bigint";
  expression: ts.Expression;
  numberValue?: number;
}

function numericLiteralInfo(expression: ts.Expression): NumericLiteralInfo | undefined {
  expression = unwrapParentheses(expression);
  if (ts.isNumericLiteral(expression)) {
    return { family: "number", expression, numberValue: Number(expression.text) };
  }
  if (ts.isBigIntLiteral(expression)) return { family: "bigint", expression };
  if (ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)) {
    if (ts.isNumericLiteral(expression.operand)) {
      const value = Number(expression.operand.text) * (expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
      return { family: "number", expression, numberValue: value };
    }
    if (ts.isBigIntLiteral(expression.operand)) return { family: "bigint", expression };
  }
  return undefined;
}

function relationalOperation(
  kind: ts.SyntaxKind,
  subjectOnLeft: boolean,
): "lt" | "gt" | "lte" | "gte" | undefined {
  kind = normalizedOperator(kind, subjectOnLeft);
  if (kind === ts.SyntaxKind.LessThanToken) return "lt";
  if (kind === ts.SyntaxKind.GreaterThanToken) return "gt";
  if (kind === ts.SyntaxKind.LessThanEqualsToken) return "lte";
  if (kind === ts.SyntaxKind.GreaterThanEqualsToken) return "gte";
  return undefined;
}

function normalizedOperator(kind: ts.SyntaxKind, subjectOnLeft: boolean): ts.SyntaxKind {
  if (subjectOnLeft) return kind;
  if (kind === ts.SyntaxKind.LessThanToken) return ts.SyntaxKind.GreaterThanToken;
  if (kind === ts.SyntaxKind.GreaterThanToken) return ts.SyntaxKind.LessThanToken;
  if (kind === ts.SyntaxKind.LessThanEqualsToken) return ts.SyntaxKind.GreaterThanEqualsToken;
  if (kind === ts.SyntaxKind.GreaterThanEqualsToken) return ts.SyntaxKind.LessThanEqualsToken;
  return kind;
}

function isStringConstant(expression: ts.Expression): boolean {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression);
}

function isGlobalNumberIdentifier(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return Boolean(symbol?.declarations?.some((declaration) => /^lib\..*\.d\.ts$/i.test(path.basename(declaration.getSourceFile().fileName))));
}

function literalPatternNode(expression: ts.Expression, checker: ts.TypeChecker): PatternNode {
  const numeric = numericLiteralInfo(expression);
  const enumValue = ts.isPropertyAccessExpression(expression) ? checker.getConstantValue(expression) : undefined;
  if ((numeric?.family === "number" && numeric.numberValue === 0) || enumValue === 0) {
    return { kind: "numeric", family: "number", operation: "between", arguments: [expression, expression] };
  }
  return { kind: "literal", expression };
}

interface GuardRoot {
  identifier: ts.Identifier;
  symbol: ts.Symbol;
}

interface SubjectDecomposition {
  root: ts.Identifier;
  path: string[];
  leafOptional: boolean;
  hasOptionalAccess: boolean;
}

function decomposeConditionSubject(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): SubjectDecomposition | { error: { code: TsPatternSkipReason; message: string } } {
  let current = unwrapParentheses(expression);
  const accesses: ts.PropertyAccessExpression[] = [];
  while (ts.isPropertyAccessExpression(current)) {
    if (ts.isPrivateIdentifier(current.name)) {
      return {
        error: {
          code: "unsupported-discriminator",
          message: "private discriminator properties are not supported",
        },
      };
    }
    accesses.unshift(current);
    current = unwrapParentheses(current.expression);
  }
  if (!ts.isIdentifier(current)) {
    return {
      error: {
        code: ts.isElementAccessExpression(current) || ts.isNonNullExpression(current)
          ? "unsupported-discriminator"
          : "effectful-subject",
        message: "comparison subject must be an identifier or identifier-only property path",
      },
    };
  }
  if (accesses.length === 0) return { root: current, path: [], leafOptional: false, hasOptionalAccess: false };
  let optionalStarted = false;
  for (const access of accesses) {
    const explicitlyOptional = Boolean(access.questionDotToken);
    if (explicitlyOptional) optionalStarted = true;
    else if (optionalStarted) {
      return {
        error: {
          code: "unsupported-discriminator",
          message: "every property after the first optional discriminator segment must also use ?.",
        },
      };
    } else if (typeMayBeNullish(checker.getTypeAtLocation(access.expression))) {
      return {
        error: {
          code: "unsupported-discriminator",
          message: `discriminator prefix may be nullish: ${access.expression.getText()}`,
        },
      };
    }
  }
  const leafSymbol = checker.getSymbolAtLocation(accesses.at(-1)!.name);
  return {
    root: current,
    path: accesses.map((access) => access.name.text),
    leafOptional: Boolean(leafSymbol && (leafSymbol.flags & ts.SymbolFlags.Optional)),
    hasOptionalAccess: accesses.some((access) => Boolean(access.questionDotToken)),
  };
}

function typeMayBeNullish(type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
  return type.isUnion() && type.types.some(typeMayBeNullish);
}

function analyzeGuardSafety(
  expression: ts.Expression,
): { code: TsPatternSkipReason; message: string } | undefined {
  let error: { code: TsPatternSkipReason; message: string } | undefined;
  const visit = (node: ts.Node): void => {
    if (error) return;
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isDeleteExpression(node) ||
      ts.isPostfixUnaryExpression(node) || ts.isNewExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.CommaToken || isAssignmentOperator(node.operatorToken.kind)))) {
      error = { code: "effectful-guard", message: "guard contains assignment, update, async, construction, deletion, or comma effects" };
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return error;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function collectGuardRoots(expression: ts.Expression, checker: ts.TypeChecker): GuardRoot[] {
  const roots = new Map<ts.Symbol, GuardRoot>();
  const addIdentifier = (identifier: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol || (symbol.flags & ts.SymbolFlags.Value) === 0) return;
    roots.set(symbol, { identifier, symbol });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (!ts.isIdentifier(node.expression)) visit(node.expression);
      node.arguments.forEach(visit);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) {
      addIdentifier(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return [...roots.values()];
}

function uniqueSymbols(symbols: readonly (ts.Symbol | undefined)[]): ts.Symbol[] {
  return [...new Set(symbols.filter((symbol): symbol is ts.Symbol => Boolean(symbol)))];
}

function referencesSubject(roots: readonly ts.Node[], subject: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(subject)) return roots.some((root) => root.getText().includes(subject.getText()));
  const symbol = checker.getSymbolAtLocation(subject);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === subject.text &&
      (!symbol || checker.getSymbolAtLocation(node) === symbol)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  return found;
}

function writesSubject(roots: readonly ts.Node[], subject: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(subject)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || isFunctionLike(node)) return;
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) &&
      referencesSubject([node.left], subject, checker)) found = true;
    else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      referencesSubject([node.operand], subject, checker)) found = true;
    if (!found) ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  return found;
}

function setProposals(candidate: InternalCandidate, proposals: CandidateProposal[]): void {
  candidate.proposals = proposals;
  candidate.proposal = proposals[0];
}

function analyzeBranches(branches: readonly MatchBranch[], owner: ts.Node): BranchAnalysis {
  const kinds: Array<"return" | "throw" | "imperative"> = [];
  for (const branch of branches) {
    const statements = statementsForBranch(branch);
    const forbidden = findForbiddenNode(statements, branch.stripFinalBreak ? statements.at(-1) : undefined);
    if (forbidden) return { mode: "imperative", kinds, error: forbidden };
    const effective = branch.stripFinalBreak ? statements.slice(0, -1) : statements;
    const returns = collectNodes(effective, ts.isReturnStatement);
    const final = effective.at(-1);
    if (returns.length > 0) {
      if (returns.length !== 1 || final !== returns[0] || !ts.isReturnStatement(final)) {
        return {
          mode: "imperative",
          kinds,
          error: { code: "unsupported-branch-shape", message: "return must be the direct final statement of its branch" },
        };
      }
      kinds.push("return");
    } else if (final && ts.isThrowStatement(final)) kinds.push("throw");
    else kinds.push("imperative");
  }
  const hasReturn = kinds.includes("return");
  if (hasReturn && kinds.some((kind) => kind === "imperative")) {
    return {
      mode: "imperative",
      kinds,
      error: { code: "unsupported-branch-shape", message: "returning and continuing branches cannot share one match replacement" },
    };
  }
  if (hasReturn && !findFunctionLikeAncestor(owner)) {
    return {
      mode: "imperative",
      kinds,
      error: { code: "unsupported-branch-shape", message: "returning conversion has no function-like owner" },
    };
  }
  return { mode: hasReturn ? "return" : "imperative", kinds };
}

function findForbiddenNode(
  roots: readonly ts.Node[],
  ignoredBreak?: ts.Node,
): { code: TsPatternSkipReason; message: string } | undefined {
  let result: { code: TsPatternSkipReason; message: string } | undefined;
  const visit = (node: ts.Node): void => {
    if (result || node === ignoredBreak) return;
    if (isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node) && roots.includes(node)) {
        result = { code: "scope-change", message: "branch declarations would change scope in a handler" };
      }
      return;
    }
    if (ts.isLabeledStatement(node)) result = { code: "labeled-control-flow", message: "labeled statements are not supported in moved branches" };
    else if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      if (node.label) result = { code: "labeled-control-flow", message: "labeled branch control flow is not supported" };
      else {
        const target = controlFlowTarget(node);
        if (!target || !roots.some((root) => target === root || isDescendantOf(target, root))) {
          result = { code: "outer-control-flow", message: "branch control flow targets a construct outside the generated handler" };
        }
      }
    }
    else if (ts.isYieldExpression(node)) result = { code: "yield", message: "yield is not supported in generated handlers" };
    else if (ts.isAwaitExpression(node)) result = { code: "await", message: "await is not supported in generated handlers" };
    else if (node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node)) result = { code: "scope-change", message: "contextual super/new.target semantics are not moved into handlers" };
    else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.BlockScoped) === 0) result = { code: "scope-change", message: "var declarations would change scope in a handler" };
    else if (ts.isClassDeclaration(node)) result = { code: "scope-change", message: "branch declarations would change scope in a handler" };
    if (!result) ts.forEachChild(node, visit);
  };
  for (const root of roots) visit(root);
  return result;
}

function renderStatementMatch(
  sourceFile: ts.SourceFile,
  node: ts.Statement,
  importPlan: ImportPlan,
  condition: PatternCondition,
  branches: readonly MatchBranch[],
  analysis: BranchAnalysis,
  terminator: "otherwise" | "exhaustive",
  fallbackNarrowing?: PrimitivePatternFamily,
): string {
  const indent = indentationAt(sourceFile.text, node.getStart(sourceFile));
  const lines = [`${analysis.mode === "return" ? "return " : ""}${importPlan.matchName}(${condition.subjectText})`];
  branches.forEach((branch, index) => {
    const isFallback = index === branches.length - 1 && !branch.condition;
    const handler = branch.syntheticFallback === "noop"
      ? "() => {}"
      : branch.syntheticFallback === "undefined"
        ? "() => undefined"
        : isFallback && fallbackNarrowing
      ? renderNarrowedStatementHandler(branch, condition.subject, sourceFile, indent, fallbackNarrowing, importPlan)
      : renderStatementHandler(branch, condition.subject, sourceFile, analysis.mode, indent);
    for (const comment of branch.leadingComments ?? []) {
      lines.push(...comment.split("\n").map((line) => `${indent}  ${line}`));
    }
    lines.push(isFallback
      ? `${indent}  .${terminator}(${handler});`
      : `${indent}  ${renderConditionClause(branch.condition!, importPlan, handler)}`);
  });
  return lines.join("\n");
}

function renderConditionClause(
  condition: PatternCondition,
  importPlan: ImportPlan,
  handler: string,
): string {
  if (condition.clause === "when") {
    return `.when(${renderGuardHandler(condition)}, ${handler})`;
  }
  const renderedPatterns = condition.patterns.map((alternative) => renderPattern(alternative.pattern, importPlan));
  if (condition.guardText) {
    const pattern = renderedPatterns.length > 1
      ? renderPattern({ kind: "union", patterns: condition.patterns.map((alternative) => alternative.pattern) }, importPlan)
      : renderedPatterns[0];
    return `.with(${pattern}, ${renderGuardHandler(condition)}, ${handler})`;
  }
  return `.with(${renderedPatterns.join(", ")}, ${handler})`;
}

function renderGuardHandler(condition: PatternCondition): string {
  const parameter = ts.isIdentifier(condition.subject) ? `(${condition.subject.text})` : "()";
  return `${parameter} => ${condition.guardText}`;
}

function renderPattern(pattern: PatternNode, importPlan: ImportPlan): string {
  if (pattern.kind === "literal") return pattern.expression.getText();
  if (pattern.kind === "raw") return pattern.text;
  if (pattern.kind === "primitive") return `${importPlan.pName}.${pattern.family}`;
  if (pattern.kind === "instance-of") return `${importPlan.pName}.instanceOf(${pattern.constructor.getText()})`;
  if (pattern.kind === "numeric") {
    const call = pattern.operation === "int" || pattern.operation === "finite"
      ? `${pattern.operation}()`
      : `${pattern.operation}(${pattern.arguments.map(renderPatternSource).join(", ")})`;
    return `${importPlan.pName}.${pattern.family}.${call}`;
  }
  if (pattern.kind === "string") {
    return `${importPlan.pName}.string.${pattern.operation}(${renderPatternSource(pattern.argument)})`;
  }
  if (pattern.kind === "not") return `${importPlan.pName}.not(${renderPattern(pattern.pattern, importPlan)})`;
  if (pattern.kind === "intersection") {
    return `${importPlan.pName}.intersection(${pattern.patterns.map((item) => renderPattern(item, importPlan)).join(", ")})`;
  }
  if (pattern.kind === "union") {
    return `${importPlan.pName}.union(${pattern.patterns.map((item) => renderPattern(item, importPlan)).join(", ")})`;
  }
  return [...pattern.path].reverse().reduce(
    (nested, property) => `{ ${property}: ${nested} }`,
    renderPattern(pattern.pattern, importPlan),
  );
}

function renderPatternSource(source: ts.Expression | string): string {
  return typeof source === "string" ? source : source.getText();
}

function patternRequiresP(pattern: PatternNode): boolean {
  if (pattern.kind === "literal" || pattern.kind === "raw") return false;
  if (pattern.kind === "nested") return patternRequiresP(pattern.pattern);
  return true;
}

function conditionRequiresP(condition: PatternCondition): boolean {
  return condition.patterns.some((alternative) => patternRequiresP(alternative.pattern)) ||
    Boolean(condition.guardText && condition.patterns.length > 1);
}

function negatedPrimitiveComplement(condition: PatternCondition): PrimitivePatternFamily | undefined {
  if (condition.patterns.length !== 1) return undefined;
  const alternative = condition.patterns[0];
  if (alternative.paths.length !== 1 || alternative.paths[0].length !== 0) return undefined;
  const pattern = alternative.pattern;
  return pattern.kind === "not" && pattern.pattern.kind === "primitive" ? pattern.pattern.family : undefined;
}

function renderStatementHandler(
  branch: MatchBranch,
  subject: ts.Expression,
  sourceFile: ts.SourceFile,
  mode: "return" | "imperative",
  baseIndent: string,
): string {
  const original = statementsForBranch(branch);
  const statements = branch.stripFinalBreak ? original.slice(0, -1) : original;
  const parameter = branch.preserveSubjectBinding ? "()" : handlerParameter(subject, statements);
  if (mode === "return" && statements.length === 1 && ts.isReturnStatement(statements[0]) &&
    statements[0].expression && !hasLeadingComment(statements[0], sourceFile)) {
    return `${parameter} => ${statements[0].expression.getText(sourceFile)}`;
  }
  const body = statements.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile));
  if (body.length === 0) return `${parameter} => {}`;
  return `${parameter} => {\n${indentText(body.join("\n"), `${baseIndent}    `)}\n${baseIndent}  }`;
}

function renderNarrowedStatementHandler(
  branch: MatchBranch,
  subject: ts.Expression,
  sourceFile: ts.SourceFile,
  baseIndent: string,
  family: PrimitivePatternFamily,
  importPlan: ImportPlan,
): string {
  if (!ts.isIdentifier(subject)) return renderStatementHandler(branch, subject, sourceFile, "return", baseIndent);
  const original = statementsForBranch(branch);
  const statements = branch.stripFinalBreak ? original.slice(0, -1) : original;
  const body = statements.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile));
  const lines = [`const ${subject.text} = ${importPlan.narrowedValueName} as ${family};`, ...body];
  return `(${importPlan.narrowedValueName}) => {\n${indentText(lines.join("\n"), `${baseIndent}    `)}\n${baseIndent}  }`;
}

function renderExpressionHandler(expression: ts.Expression, subject: ts.Expression, checker: ts.TypeChecker): string {
  const parameter = handlerParameter(subject, [expression], checker);
  return `${parameter} => ${expression.getText()}`;
}

function renderNarrowedExpressionHandler(
  expression: ts.Expression,
  subject: ts.Expression,
  family: PrimitivePatternFamily,
  importPlan: ImportPlan,
): string {
  if (!ts.isIdentifier(subject)) return `() => ${expression.getText()}`;
  return `(${importPlan.narrowedValueName}) => { const ${subject.text} = ${importPlan.narrowedValueName} as ${family}; return ${expression.getText()}; }`;
}

function handlerParameter(
  subject: ts.Expression,
  roots: readonly ts.Node[],
  checker?: ts.TypeChecker,
): string {
  if (!ts.isIdentifier(subject)) return "()";
  const subjectSymbol = checker?.getSymbolAtLocation(subject);
  let referenced = false;
  const visit = (node: ts.Node): void => {
    if (referenced || isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && node.text === subject.text &&
      (!checker || !subjectSymbol || checker.getSymbolAtLocation(node) === subjectSymbol)) referenced = true;
    if (!referenced) ts.forEachChild(node, visit);
  };
  for (const root of roots) visit(root);
  return referenced ? `(${subject.text})` : "()";
}

function statementsForBranch(branch: MatchBranch): readonly ts.Statement[] {
  if (branch.statements) {
    return branch.statements.length === 1 && ts.isBlock(branch.statements[0])
      ? branch.statements[0].statements
      : branch.statements;
  }
  if (!branch.statement) return [];
  return ts.isBlock(branch.statement) ? branch.statement.statements : [branch.statement];
}

function switchClauseTerminal(statements: readonly ts.Statement[]): "break" | "abrupt" | undefined {
  const final = statements.at(-1);
  if (!final) return undefined;
  if (ts.isBreakStatement(final) && !final.label) return "break";
  if (ts.isReturnStatement(final) || ts.isThrowStatement(final)) return "abrupt";
  if (ts.isBlock(final)) return switchClauseTerminal(final.statements);
  return undefined;
}

function flattenOr(expression: ts.Expression): ts.Expression[] {
  expression = unwrapParentheses(expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return [...flattenOr(expression.left), ...flattenOr(expression.right)];
  }
  return [expression];
}

function flattenAnd(expression: ts.Expression): ts.Expression[] {
  expression = unwrapParentheses(expression);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return [...flattenAnd(expression.left), ...flattenAnd(expression.right)];
  }
  return [expression];
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function isStableSubject(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return true;
  return ts.isPropertyAccessExpression(expression) && !expression.questionDotToken && isStableSubject(expression.expression);
}

function isPatternExpression(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || ts.isBigIntLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(expression) &&
    (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken) &&
    (ts.isNumericLiteral(expression.operand) || ts.isBigIntLiteral(expression.operand))) return true;
  if (ts.isPropertyAccessExpression(expression)) {
    const symbol = checker.getSymbolAtLocation(expression.name);
    return Boolean(symbol?.declarations?.some(ts.isEnumMember));
  }
  return false;
}

function planTsPatternImports(sourceFile: ts.SourceFile): ImportPlan {
  const bindingCounts = collectValueBindingNames(sourceFile);
  let compatible: ts.ImportDeclaration | undefined;
  let existingMatch: string | undefined;
  let existingP: string | undefined;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "ts-pattern") continue;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    if (!clause?.isTypeOnly && bindings && ts.isNamedImports(bindings)) {
      compatible ??= statement;
      for (const specifier of bindings.elements) {
        if (specifier.isTypeOnly) continue;
        const imported = specifier.propertyName?.text ?? specifier.name.text;
        if (imported === "match" && (bindingCounts.get(specifier.name.text) ?? 0) === 1) existingMatch ??= specifier.name.text;
        if (imported === "P" && (bindingCounts.get(specifier.name.text) ?? 0) === 1) existingP ??= specifier.name.text;
      }
    }
  }
  const used = new Set(bindingCounts.keys());
  const matchName = existingMatch ?? chooseImportName("match", "matchTsPattern", used);
  used.add(matchName);
  const pName = existingP ?? chooseImportName("P", "PTsPattern", used);
  used.add(pName);
  const narrowedValueName = chooseImportName("tsPatternValue", "tsPatternValue", used);
  return {
    sourceFile,
    matchName,
    pName,
    narrowedValueName,
    compatibleImport: compatible,
    matchImported: Boolean(existingMatch),
    pImported: Boolean(existingP),
  };
}

function chooseImportName(preferred: string, aliasBase: string, used: ReadonlySet<string>): string {
  if (!used.has(preferred)) return preferred;
  if (!used.has(aliasBase)) return aliasBase;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${aliasBase}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function collectValueBindingNames(sourceFile: ts.SourceFile): Map<string, number> {
  const counts = new Map<string, number>();
  const addName = (name: ts.BindingName | ts.Identifier | undefined): void => {
    if (!name) return;
    if (ts.isIdentifier(name)) counts.set(name.text, (counts.get(name.text) ?? 0) + 1);
    else name.elements.forEach((element) => { if (!ts.isOmittedExpression(element)) addName(element.name); });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportClause(node)) {
      if (!node.isTypeOnly) addName(node.name);
    } else if (ts.isImportSpecifier(node)) {
      if (!node.isTypeOnly && !node.parent.parent.isTypeOnly) addName(node.name);
    } else if (ts.isNamespaceImport(node)) addName(node.name);
    else if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) addName(node.name);
    else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) || ts.isEnumDeclaration(node) || ts.isImportEqualsDeclaration(node)) addName(node.name);
    else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) addName(node.name);
    else if (ts.isCatchClause(node)) addName(node.variableDeclaration?.name);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

function importEditFor(plan: ImportPlan, needsP: boolean): TextEdit | undefined {
  const specifiers: string[] = [];
  if (!plan.matchImported) specifiers.push(plan.matchName === "match" ? "match" : `match as ${plan.matchName}`);
  if (needsP && !plan.pImported) specifiers.push(plan.pName === "P" ? "P" : `P as ${plan.pName}`);
  if (specifiers.length === 0) return undefined;
  if (plan.compatibleImport) {
    const bindings = plan.compatibleImport.importClause!.namedBindings as ts.NamedImports;
    const closeBrace = bindings.getEnd() - 1;
    let insertionPoint = closeBrace;
    while (insertionPoint > bindings.getStart() && /\s/.test(plan.sourceFile.text[insertionPoint - 1])) insertionPoint -= 1;
    const insertion = bindings.elements.length === 0 ? `${specifiers.join(", ")} ` : `, ${specifiers.join(", ")}`;
    return { start: insertionPoint, end: insertionPoint, replacement: insertion };
  }
  const imports = plan.sourceFile.statements.filter(ts.isImportDeclaration);
  const importText = `import { ${specifiers.join(", ")} } from \"ts-pattern\";`;
  if (imports.length > 0) {
    const last = imports.at(-1)!;
    return { start: last.getEnd(), end: last.getEnd(), replacement: `\n${importText}` };
  }
  const first = plan.sourceFile.statements[0];
  const position = first ? first.getStart(plan.sourceFile, false) : plan.sourceFile.getEnd();
  return { start: position, end: position, replacement: `${importText}\n` };
}

function buildOverlays(
  project: LoadedProject,
  originals: ReadonlyMap<string, string>,
  accepted: readonly InternalCandidate[],
  importPlans: ReadonlyMap<string, ImportPlan>,
): Map<string, string> {
  const byFile = new Map<string, InternalCandidate[]>();
  for (const candidate of accepted) {
    const key = canonicalPath(candidate.sourceFile.fileName);
    const group = byFile.get(key) ?? [];
    group.push(candidate);
    byFile.set(key, group);
  }
  const overlays = new Map<string, string>();
  for (const [fileName, fileCandidates] of byFile) {
    const edits = fileCandidates.flatMap(proposalEdits);
    const importPlan = importPlans.get(fileName);
    const importEdit = importPlan
      ? importEditFor(importPlan, fileCandidates.some((candidate) => candidate.proposal?.requiresP))
      : undefined;
    if (importEdit) edits.push(importEdit);
    const original = originals.get(fileName);
    if (original === undefined) throw new Error(`missing original source for ${displayPath(fileName, project.cwd)}`);
    overlays.set(fileName, applyTextEdits(original, edits));
  }
  return overlays;
}

function candidateOutputRanges(
  candidates: readonly InternalCandidate[],
  importPlans: ReadonlyMap<string, ImportPlan>,
): Map<string, CandidateOutputRange[]> {
  const byFile = new Map<string, InternalCandidate[]>();
  for (const candidate of candidates) {
    const fileName = canonicalPath(candidate.sourceFile.fileName);
    const group = byFile.get(fileName) ?? [];
    group.push(candidate);
    byFile.set(fileName, group);
  }
  const result = new Map<string, CandidateOutputRange[]>();
  for (const [fileName, fileCandidates] of byFile) {
    const importPlan = importPlans.get(fileName);
    const importEdit = importPlan
      ? importEditFor(importPlan, fileCandidates.some((candidate) => candidate.proposal?.requiresP))
      : undefined;
    const ranges: CandidateOutputRange[] = [];
    const edits = fileCandidates.flatMap(proposalEdits);
    if (importEdit) edits.push(importEdit);
    const transformedPosition = (position: number): number => position + edits.reduce((shift, edit) =>
      edit.end <= position ? shift + edit.replacement.length - (edit.end - edit.start) : shift, 0);
    for (const candidate of fileCandidates) {
      const start = transformedPosition(candidate.start);
      const scope = findFunctionLikeAncestor(candidate.node);
      ranges.push({
        candidate,
        start,
        end: start + candidate.proposal!.replacement.length,
        ...(scope ? {
          scopeStart: transformedPosition(scope.getStart(candidate.sourceFile, false)),
          scopeEnd: transformedPosition(scope.getEnd()),
        } : {}),
      });
    }
    result.set(fileName, ranges);
  }
  return result;
}

function applyTextEdits(source: string, edits: readonly TextEdit[]): string {
  const sorted = [...edits].sort((left, right) => right.start - left.start || right.end - left.end);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1].start < sorted[index].end) throw new Error("overlapping conversion edits");
  }
  let output = source;
  for (const edit of sorted) output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
  return output;
}

function proposalEdits(candidate: InternalCandidate): TextEdit[] {
  const proposal = candidate.proposal!;
  return [{
    start: candidate.start,
    end: proposal.editEnd ?? candidate.end,
    replacement: proposal.replacement,
  }, ...(proposal.additionalEdits ?? [])];
}

function createDiagnosticValidator(parsed: ts.ParsedCommandLine): DiagnosticValidator {
  let normalized = new Map<string, string>();
  let oldProgram: ts.Program | undefined;
  const host = ts.createCompilerHost(parsed.options, true);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => normalized.get(canonicalPath(fileName)) ?? originalReadFile(fileName);
  const sourceFiles = new Map<string, ts.SourceFile>();
  host.getSourceFile = (fileName, languageVersion, onError) => {
    const text = host.readFile(fileName);
    if (text === undefined) {
      onError?.(`Could not read file ${fileName}`);
      return undefined;
    }
    const key = canonicalPath(fileName);
    const cached = sourceFiles.get(key);
    if (cached?.text === text) return cached;
    const sourceFile = ts.createSourceFile(fileName, text, languageVersion, true, scriptKindFor(fileName));
    sourceFiles.set(key, sourceFile);
    return sourceFile;
  };
  return {
    collect(overlays, fullProject = false) {
      normalized = new Map([...overlays].map(([fileName, text]) => [canonicalPath(fileName), text]));
      const program = ts.createProgram({
        rootNames: parsed.fileNames,
        options: parsed.options,
        projectReferences: parsed.projectReferences,
        host,
        oldProgram,
      });
      oldProgram = program;
      if (fullProject) return ts.getPreEmitDiagnostics(program);
      // Trial edits can only originate in overlay files. Reusing the program and
      // checking those files keeps candidate isolation cheap; the accepted batch
      // still receives a full-project check before reporting or writing.
      const diagnostics: ts.Diagnostic[] = [];
      for (const fileName of normalized.keys()) {
        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) continue;
        diagnostics.push(
          ...program.getSyntacticDiagnostics(sourceFile),
          ...program.getSemanticDiagnostics(sourceFile),
          ...program.getDeclarationDiagnostics(sourceFile),
        );
      }
      return diagnostics;
    },
  };
}

function diagnosticCounts(diagnostics: readonly ts.Diagnostic[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function introducedDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  baseline: ReadonlyMap<string, number>,
): ts.Diagnostic[] {
  const seen = new Map<string, number>();
  return diagnostics.filter((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > (baseline.get(key) ?? 0);
  });
}

function diagnosticKey(diagnostic: ts.Diagnostic): string {
  return [
    diagnostic.file ? canonicalPath(diagnostic.file.fileName) : "",
    diagnostic.category,
    diagnostic.code,
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  ].join("\0");
}

function formatDiagnostic(diagnostic: ts.Diagnostic, cwd: string): TsPatternValidationDiagnostic {
  const result: TsPatternValidationDiagnostic = {
    code: diagnostic.code,
    category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
  if (diagnostic.file) {
    result.filePath = displayPath(diagnostic.file.fileName, cwd);
    if (diagnostic.start !== undefined) {
      const point = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      result.line = point.line + 1;
      result.column = point.character + 1;
    }
  }
  return result;
}

function buildFileReports(
  candidates: readonly InternalCandidate[],
  accepted: readonly InternalCandidate[],
): TsPatternFileReport[] {
  const changed = new Set(accepted.map((candidate) => candidate.report.filePath));
  const groups = new Map<string, TsPatternCandidateReport[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.report.filePath) ?? [];
    group.push(candidate.report);
    groups.set(candidate.report.filePath, group);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([filePath, reports]) => ({
    filePath,
    changed: changed.has(filePath),
    candidates: reports,
  }));
}

function preflightWrites(
  overlays: ReadonlyMap<string, string>,
  originals: ReadonlyMap<string, string>,
  cwd: string,
): void {
  for (const fileName of overlays.keys()) {
    if (fs.readFileSync(fileName, "utf8") !== originals.get(fileName)) {
      throw new Error(`source changed while planning edits: ${displayPath(fileName, cwd)}`);
    }
  }
}

function skip(candidate: InternalCandidate, code: TsPatternSkipReason, reason: string): void {
  candidate.proposals = undefined;
  candidate.proposal = undefined;
  candidate.report.action = "skipped";
  delete candidate.report.terminator;
  delete candidate.report.fallbackKind;
  candidate.report.reasonCode = code;
  candidate.report.reason = reason;
}

function collectNodes<T extends ts.Node>(roots: readonly ts.Node[], predicate: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (predicate(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  roots.forEach(visit);
  return result;
}

function controlFlowTarget(node: ts.BreakStatement | ts.ContinueStatement): ts.Node | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isContinueStatement(node)) {
      if (ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current) ||
        ts.isWhileStatement(current) || ts.isDoStatement(current)) return current;
    } else if (ts.isSwitchStatement(current) || ts.isForStatement(current) || ts.isForInStatement(current) ||
      ts.isForOfStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)) return current;
    if (isFunctionLike(current)) return undefined;
  }
  return undefined;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function findFunctionLikeAncestor(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  for (let current = node.parent; current; current = current.parent) if (isFunctionLike(current)) return current;
  return undefined;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node);
}

function rangesOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function candidatesOverlap(left: InternalCandidate, right: InternalCandidate): boolean {
  if (left.sourceFile.fileName !== right.sourceFile.fileName) return false;
  return proposalEdits(left).some((leftEdit) => proposalEdits(right).some((rightEdit) =>
    rangesOverlap(leftEdit.start, leftEdit.end, rightEdit.start, rightEdit.end)));
}

function budgetedNonOverlapping(
  candidates: readonly InternalCandidate[],
  usedBytes: ReadonlyMap<string, number>,
  maxContinuationBytes: number,
): InternalCandidate[] {
  const accepted: InternalCandidate[] = [];
  const reserved = new Map(usedBytes);
  for (const candidate of candidates) {
    if (accepted.some((other) => candidatesOverlap(other, candidate))) continue;
    const fileName = canonicalPath(candidate.sourceFile.fileName);
    const duplicated = candidate.proposal?.duplicatedContinuationBytes ?? 0;
    const projected = (reserved.get(fileName) ?? 0) + duplicated;
    if (projected > maxContinuationBytes) continue;
    accepted.push(candidate);
    reserved.set(fileName, projected);
  }
  return accepted;
}

function hasLeadingComment(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  return ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart())?.length !== undefined;
}

function leadingComments(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  return (ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [])
    .map((range) => sourceFile.text.slice(range.pos, range.end));
}

function containsComment(node: ts.Node): boolean {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    node.getSourceFile().languageVariant,
    node.getText(node.getSourceFile()),
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) return true;
  }
  return false;
}

function indentationAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return text.slice(lineStart, offset).match(/^[\t ]*/)?.[0] ?? "";
}

function indentText(text: string, indent: string): string {
  return text.split("\n").map((line) => `${indent}${line}`).join("\n");
}

function asArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function isTypeScriptSource(fileName: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/i.test(fileName) && !/\.d\.(?:ts|mts|cts)$/i.test(fileName);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (/\.tsx$/i.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(fileName)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function formatConfigDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

function canonicalPath(fileName: string): string {
  const resolved = path.resolve(fileName);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function displayPath(fileName: string, cwd: string): string {
  const relative = path.relative(cwd, fileName);
  return !relative.startsWith("..") && !path.isAbsolute(relative)
    ? normalizePath(relative || path.basename(fileName))
    : normalizePath(path.resolve(fileName));
}
