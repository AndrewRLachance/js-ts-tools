import type { AstPatternRequirement, DiscoverySelector } from "./rule";
import type { ImportRequirement, PlannedFile, TextReplacement } from "./rewrite";
import type { SemanticSnapshot } from "./semantics";
import type { SyntaxCandidate } from "./source";

export interface ProjectRequest {
  readonly cwd: string;
  readonly tsconfig: string;
  readonly sources: readonly string[];
  readonly excludes: readonly string[];
}

export interface DiscoveryPort {
  discover(request: ProjectRequest, selectors: readonly DiscoverySelector[]): readonly SyntaxCandidate[];
}

export interface SemanticPort {
  snapshot(request: ProjectRequest): SemanticSnapshot;
}

/** Explicit capability: implementations must analyze the supplied text without writing it. */
export interface OverlaySemanticPort extends SemanticPort {
  snapshotWithOverrides(request: ProjectRequest, overrides: ReadonlyMap<string, string>): SemanticSnapshot;
}

export interface AstPatternMatch {
  readonly requirementId: string;
  readonly filePath: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export interface AstPatternPort {
  match(request: ProjectRequest, requirements: readonly AstPatternRequirement[]): readonly AstPatternMatch[];
}

export interface SourcePort {
  read(filePath: string): string;
  write(filePath: string, text: string): void;
}

export interface EditPort {
  apply(sourceText: string, replacements: readonly TextReplacement[]): string;
}

/**
 * Resolves declarative import requirements into source edits against the
 * unmodified file. Implementations must be deterministic and idempotent.
 */
export interface ImportPort {
  plan(
    request: ProjectRequest,
    filePath: string,
    sourceText: string,
    requirements: readonly ImportRequirement[],
  ): readonly TextReplacement[];
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly baselineDiagnostics: readonly unknown[];
  readonly resultingDiagnostics: readonly unknown[];
  readonly newDiagnostics: readonly unknown[];
}

export interface ValidationPort {
  validate(request: ProjectRequest, files: readonly PlannedFile[], baseline: SemanticSnapshot): ValidationResult;
}
