import { resolve } from "node:path";
import type { AstPatternMatch, ProjectRequest } from "../contracts/services";
import type {
  CandidateSemantics,
  CorrelatedAstPattern,
  CorrelatedCallSite,
  SemanticCallSite,
  SemanticContext,
  SemanticFact,
  SemanticSnapshot,
} from "../contracts/semantics";
import type { SourcePosition, SyntaxCandidate } from "../contracts/source";

export class BasicSemanticContext implements SemanticContext {
  readonly snapshot: SemanticSnapshot;
  readonly #entries: ReadonlyMap<string, CandidateSemantics>;

  constructor(snapshot: SemanticSnapshot, entries: ReadonlyMap<string, CandidateSemantics> = new Map()) {
    this.snapshot = snapshot;
    this.#entries = entries;
  }

  factsFor(candidateId: string): readonly SemanticFact[] {
    return this.#entries.get(candidateId)?.facts ?? [];
  }

  callSitesFor(candidateId: string): readonly CorrelatedCallSite[] {
    return this.#entries.get(candidateId)?.callSites ?? [];
  }

  astPatternsFor(candidateId: string): readonly CorrelatedAstPattern[] {
    return this.#entries.get(candidateId)?.astPatterns ?? [];
  }

  exactCallSiteFor(candidateId: string) {
    const exact = this.callSitesFor(candidateId).filter((item) => item.strength === "exact");
    return exact.length === 1 ? exact[0]?.callSite : undefined;
  }

  hasExactAstPattern(candidateId: string, requirementId: string): boolean {
    return this.astPatternsFor(candidateId).some(
      (item) => item.strength === "exact" && item.requirementId === requirementId,
    );
  }
}

export interface CorrelateSemanticContextInput {
  readonly request: ProjectRequest;
  readonly candidates: readonly SyntaxCandidate[];
  readonly snapshot: SemanticSnapshot;
  readonly astPatternMatches?: readonly AstPatternMatch[];
}

/**
 * Correlates TypeModel point locations and AST-XPath ranges back to syntax
 * candidates. TypeModel does not expose end offsets for call sites, therefore
 * an exact call-site correlation means same canonical file, same start
 * line/column, and a compatible call-site/syntax kind. AST-XPath retains true
 * exact-range correlation.
 */
export function correlateSemanticContext(input: CorrelateSemanticContextInput): BasicSemanticContext {
  const callSites = input.snapshot.callSites ?? [];
  const astMatches = input.astPatternMatches ?? [];
  const entries = new Map<string, CandidateSemantics>();

  for (const candidate of input.candidates) {
    const candidatePath = canonicalPath(input.request.cwd, candidate.filePath);

    const correlatedCalls = callSites
      .filter((callSite) => canonicalPath(input.request.cwd, callSite.location.filePath) === candidatePath)
      .map((callSite): CorrelatedCallSite | undefined => {
        const strength = callSiteRelation(candidate, callSite);
        return strength ? { strength, callSite } : undefined;
      })
      .filter(isDefined)
      .sort(compareCallSites);

    const correlatedPatterns = astMatches
      .filter((match) => canonicalPath(input.request.cwd, match.filePath) === candidatePath)
      .map((match): CorrelatedAstPattern | undefined => {
        const strength = rangeRelation(candidate.startOffset, candidate.endOffset, match.startOffset, match.endOffset);
        return strength ? { strength, ...match } : undefined;
      })
      .filter(isDefined)
      .sort(compareAstPatterns);

    const facts: SemanticFact[] = [
      ...correlatedCalls.map((item): SemanticFact => ({
        kind: "call-site",
        summary: item.strength === "exact"
          ? "TypeModel call site starts at the candidate location with a compatible syntax kind."
          : "TypeModel call site starts inside the candidate; review only.",
        data: item,
      })),
      ...correlatedPatterns.map((item): SemanticFact => ({
        kind: "ast-pattern",
        summary: item.strength === "exact"
          ? `AST-XPath pattern ${item.requirementId} exactly matches candidate range.`
          : `AST-XPath pattern ${item.requirementId} is range-contained with candidate; review only.`,
        data: item,
      })),
    ];

    entries.set(candidate.id, {
      facts,
      callSites: correlatedCalls,
      astPatterns: correlatedPatterns,
    });
  }

  return new BasicSemanticContext(input.snapshot, entries);
}

function canonicalPath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath).replaceAll("\\", "/");
}

function callSiteRelation(
  candidate: SyntaxCandidate,
  callSite: SemanticCallSite,
): "exact" | "contained" | undefined {
  const callPosition = { line: callSite.location.line, column: callSite.location.column };
  if (samePosition(candidate.start, callPosition) && syntaxKindCompatible(candidate.kind, callSite.kind)) {
    return "exact";
  }
  return positionWithin(callPosition, candidate.start, candidate.end) ? "contained" : undefined;
}

function syntaxKindCompatible(candidateKind: string, callSiteKind: SemanticCallSite["kind"]): boolean {
  switch (callSiteKind) {
    case "call":
      return candidateKind === "CallExpression";
    case "new":
      return candidateKind === "NewExpression";
    case "taggedTemplate":
      return candidateKind === "TaggedTemplateExpression";
    case "decorator":
      return candidateKind === "Decorator";
    case "jsx":
      return candidateKind.startsWith("Jsx") || candidateKind.startsWith("JSX");
    case "instanceof":
      return candidateKind === "BinaryExpression";
  }
}

function samePosition(left: SourcePosition, right: SourcePosition): boolean {
  return left.line === right.line && left.column === right.column;
}

function positionWithin(position: SourcePosition, start: SourcePosition, end: SourcePosition): boolean {
  return comparePosition(start, position) <= 0 && comparePosition(position, end) <= 0;
}

function comparePosition(left: SourcePosition, right: SourcePosition): number {
  return left.line - right.line || left.column - right.column;
}

function rangeRelation(
  candidateStart: number,
  candidateEnd: number,
  semanticStart: number,
  semanticEnd: number,
): "exact" | "contained" | undefined {
  if (candidateStart === semanticStart && candidateEnd === semanticEnd) return "exact";
  const semanticInsideCandidate = candidateStart <= semanticStart && semanticEnd <= candidateEnd;
  const candidateInsideSemantic = semanticStart <= candidateStart && candidateEnd <= semanticEnd;
  return semanticInsideCandidate || candidateInsideSemantic ? "contained" : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function compareCallSites(left: CorrelatedCallSite, right: CorrelatedCallSite): number {
  if (left.strength !== right.strength) return left.strength === "exact" ? -1 : 1;
  return left.callSite.location.line - right.callSite.location.line
    || left.callSite.location.column - right.callSite.location.column
    || left.callSite.id.localeCompare(right.callSite.id);
}

function compareAstPatterns(left: CorrelatedAstPattern, right: CorrelatedAstPattern): number {
  if (left.strength !== right.strength) return left.strength === "exact" ? -1 : 1;
  const leftWidth = left.endOffset - left.startOffset;
  const rightWidth = right.endOffset - right.startOffset;
  return leftWidth - rightWidth || left.startOffset - right.startOffset;
}
