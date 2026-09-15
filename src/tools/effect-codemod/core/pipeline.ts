import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { SyntaxAnalysis } from "../contracts/syntax-analysis";
import type { PlannedFile, RewritePlan } from "../contracts/rewrite";
import type { CodemodOptions } from "../contracts/config";
import type { CodemodReport, CandidateReport } from "../contracts/report";
import type { EffectConversionRule } from "../contracts/rule";
import type {
  AstPatternPort,
  DiscoveryPort,
  EditPort,
  ImportPort,
  ProjectRequest,
  SemanticPort,
  SourcePort,
  ValidationPort,
} from "../contracts/services";
import type { ImportRequirement, TextReplacement } from "../contracts/rewrite";
import { planFiles } from "./edit-planner";
import { RuleRegistry } from "./registry";
import { correlateSemanticContext } from "./semantic-context";
import { commitPlannedFiles } from "./transaction";
import { compactEvidence, classifyReason } from "./report";

export interface AnalysisSession {
  readonly dependencies: CodemodDependencies;
  readonly originals: ReadonlyMap<string, string>;
  readonly texts: ReadonlyMap<string, string>;
  advance(files: readonly PlannedFile[]): void;
  assertFresh(): void;
}

export interface CodemodDependencies {
  readonly analysis?: SyntaxAnalysis;
  readonly analysisSession?: (request: ProjectRequest) => AnalysisSession;
  readonly discovery: DiscoveryPort;
  readonly semantics: SemanticPort;
  readonly astPatterns: AstPatternPort;
  readonly source: SourcePort;
  readonly edits: EditPort;
  readonly imports: ImportPort;
  readonly validation: ValidationPort;
}

export class EffectCodemod {
  readonly #registry: RuleRegistry;
  readonly #deps: CodemodDependencies;

  constructor(registry: RuleRegistry, deps: CodemodDependencies) {
    this.#registry = registry;
    this.#deps = deps;
  }

  run(options: CodemodOptions = {}): CodemodReport {
    const request: ProjectRequest = {
      cwd: resolve(options.cwd ?? process.cwd()),
      tsconfig: options.tsconfig ?? "tsconfig.json",
      sources: options.sources ?? ["src/**/*.ts", "src/**/*.tsx"],
      excludes: options.excludes ?? ["node_modules", "dist"],
    };

    const maxPasses = options.maxPasses ?? 1;
    if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 10) throw new Error("maxPasses must be an integer from 1 through 10");
    if (this.#deps.analysisSession) return this.runRepeated(request, options, maxPasses);
    if (maxPasses > 1) throw new Error("Multiple passes require an analysis-session capability");

    const rules = this.#registry.forTargets(options.targets);
    const selectorOwners = collectSelectorOwners(rules);
    const candidates = this.#deps.discovery.discover(
      request,
      [...selectorOwners.values()].map((entry) => entry.selector),
    );
    const baseline = this.#deps.semantics.snapshot(request);

    const patternRequirements = rules.flatMap((rule) => rule.astPatterns ?? []);
    const astPatternMatches = patternRequirements.length
      ? this.#deps.astPatterns.match(request, patternRequirements)
      : [];
    const semantics = correlateSemanticContext({
      request,
      candidates,
      snapshot: baseline,
      astPatternMatches,
    });

    const reports: CandidateReport[] = [];
    const replacements: TextReplacement[] = [];
    const pending: { reportIndex: number; plan: RewritePlan }[] = [];
    const importsByFile = new Map<string, ImportRequirement[]>();

    for (const candidate of candidates) {
      const owner = selectorOwners.get(candidate.selectorId);
      if (!owner) continue;
      const sourceText = this.#deps.source.read(candidate.filePath);
      const context = { semantics, sourceText, analysis: this.#deps.analysis };
      const decision = owner.rule.analyze(candidate, context);

      if (decision.kind === "skip") {
        reports.push({
          candidateId: candidate.id,
          filePath: candidate.filePath,
          ruleId: owner.rule.id,
          target: owner.rule.target,
          status: "skipped",
          reason: decision.reason,
          evidence: decision.evidence ?? [],
        });
        continue;
      }

      if (decision.kind === "review") {
        if (options.includeReview ?? true) {
          reports.push({
            candidateId: candidate.id,
            filePath: candidate.filePath,
            ruleId: owner.rule.id,
            target: owner.rule.target,
            status: "review",
            reason: decision.reason,
            evidence: decision.match.evidence,
          });
        }
        continue;
      }

      const rewrite = owner.rule.rewrite(decision.match, context);
      pending.push({ reportIndex: reports.length, plan: rewrite });
      reports.push({
        candidateId: candidate.id,
        filePath: candidate.filePath,
        ruleId: owner.rule.id,
        target: owner.rule.target,
        status: "converted",
        evidence: decision.match.evidence,
      });
    }

    pending.sort((a, b) => planWidth(a.plan) - planWidth(b.plan)
      || reports[a.reportIndex]!.ruleId.localeCompare(reports[b.reportIndex]!.ruleId)
      || reports[a.reportIndex]!.candidateId.localeCompare(reports[b.reportIndex]!.candidateId));
    for (const item of pending) {
      const report = reports[item.reportIndex]!;
      if (item.plan.replacements.some((edit) => replacements.some((accepted) => overlaps(edit, accepted)))) {
        reports[item.reportIndex] = { ...report, status: "skipped", reasonCode: "overlap-deferred", reason: "A narrower or higher-priority edit overlaps this candidate; reconsider on the next pass." };
        continue;
      }
      replacements.push(...item.plan.replacements);
      const bucket = importsByFile.get(report.filePath) ?? [];
      bucket.push(...item.plan.imports);
      importsByFile.set(report.filePath, bucket);
    }

    for (const [filePath, requirements] of importsByFile) {
      const sourceText = this.#deps.source.read(filePath);
      replacements.push(...this.#deps.imports.plan(request, filePath, sourceText, requirements));
    }

    const files = planFiles(replacements, this.#deps.source, this.#deps.edits);
    const validation = this.#deps.validation.validate(request, files, baseline);
    const write = options.write ?? false;
    const written = write && validation.ok ? commitPlannedFiles(files, this.#deps.source) : false;

    const locations = new Map(candidates.map((candidate) => [candidate.id, candidate.start]));
    const skipReasons = new Map<string, number>();
    for (const report of reports) {
      if (report.status === "skipped") {
        const reason = report.reason ?? "Unspecified";
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      }
    }
    return {
      candidates: reports.map((report) => ({
        ...report,
        reasonCode: report.reasonCode ?? (report.reason ? classifyReason(report.reason) : undefined),
        proofObligations: report.status === "converted" ? ["binding-identity", "result-type", "evaluation-timing", "variable-use", "failure-behavior"] : undefined,
        line: locations.get(report.candidateId)?.line,
        column: locations.get(report.candidateId)?.column,
        evidence: options.evidence === "full" ? report.evidence : compactEvidence(report.evidence),
      })),
      files,
      validation: { ok: validation.ok, newDiagnostics: validation.newDiagnostics },
      summary: {
        candidates: reports.length,
        converted: reports.filter((r) => r.status === "converted").length,
        review: reports.filter((r) => r.status === "review").length,
        skipped: reports.filter((r) => r.status === "skipped").length,
        changedFiles: files.filter((f) => f.originalText !== f.editedText).length,
        written,
        valid: validation.ok,
        skipReasons: [...skipReasons].map(([reason, count]) => ({ reason, count }))
          .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      },
    };
  }
  private runRepeated(request: ProjectRequest, options: CodemodOptions, maxPasses: number): CodemodReport {
    const session = this.#deps.analysisSession!(request);
    const history: CandidateReport[] = [];
    const passes: NonNullable<CodemodReport["passes"]>[number][] = [];
    const seen = new Set<string>();
    let last: CodemodReport | undefined;
    let stopReason: NonNullable<CodemodReport["summary"]["stopReason"]> = "pass-limit";
    for (let pass = 1; pass <= maxPasses; pass++) {
      session.assertFresh();
      const sourceHash = hashTexts(session.texts);
      seen.add(sourceHash);
      const report = new EffectCodemod(this.#registry, session.dependencies).run({ ...options, maxPasses: 1, write: false });
      const candidates = report.candidates.map((candidate) => ({ ...candidate, pass }));
      last = { ...report, candidates };
      passes.push({ pass, sourceHash, candidates, summary: report.summary });
      if (!report.validation.ok) { stopReason = "validation-failed"; break; }
      if (!report.summary.changedFiles) { stopReason = "unchanged"; break; }
      history.push(...candidates.filter((candidate) => candidate.status === "converted"));
      session.advance(report.files);
      if (seen.has(hashTexts(session.texts))) { stopReason = "cycle"; break; }
    }
    session.assertFresh();
    const files = [...session.texts].filter(([filePath, text]) => text !== session.originals.get(filePath)).map(([filePath, editedText]) => {
      const originalText = session.originals.get(filePath)!;
      return { filePath, originalText, editedText, replacements: [{ filePath, start: 0, end: originalText.length, replacement: editedText, reason: "validated-pass-composition" }] };
    });
    const ok = stopReason !== "cycle" && stopReason !== "validation-failed";
    const terminal = last!.candidates.flatMap((candidate): CandidateReport[] => candidate.status !== "converted" ? [candidate]
      : stopReason === "validation-failed" ? [{ ...candidate, status: "review", reasonCode: "validation-failed", reason: "The proposed pass introduced diagnostics; no edits from this run were committed." }] : []);
    const candidates = [...history, ...terminal];
    const skipReasons = new Map<string, number>();
    for (const candidate of terminal) if (candidate.status === "skipped") skipReasons.set(candidate.reason ?? "Unspecified", (skipReasons.get(candidate.reason ?? "Unspecified") ?? 0) + 1);
    const written = Boolean(options.write && ok && commitPlannedFiles(files, this.#deps.source));
    return {
      candidates, files, passes,
      validation: { ok, newDiagnostics: stopReason === "cycle" ? [{ message: "Repeated source hash detected; no files were written." }] : last!.validation.newDiagnostics },
      summary: {
        candidates: candidates.length, converted: history.length,
        review: terminal.filter((candidate) => candidate.status === "review").length,
        skipped: terminal.filter((candidate) => candidate.status === "skipped").length,
        changedFiles: files.length, written, valid: ok, passes: passes.length,
        converged: stopReason === "unchanged", stopReason,
        skipReasons: [...skipReasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      },
    };
  }

}

function collectSelectorOwners(rules: readonly EffectConversionRule[]) {
  const result = new Map<string, { selector: EffectConversionRule["selectors"][number]; rule: EffectConversionRule }>();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      if (result.has(selector.id)) throw new Error(`Duplicate selector id: ${selector.id}`);
      result.set(selector.id, { selector, rule });
    }
  }
  return result;
}

function planWidth(plan: RewritePlan): number {
  return plan.replacements.reduce((total, edit) => total + edit.end - edit.start, 0);
}
function overlaps(a: TextReplacement, b: TextReplacement): boolean {
  return a.filePath === b.filePath && (a.start === a.end && b.start === b.end ? a.start === b.start : a.start < b.end && b.start < a.end);
}
function hashTexts(texts: ReadonlyMap<string, string>): string {
  return createHash("sha256").update(JSON.stringify([...texts].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
}
