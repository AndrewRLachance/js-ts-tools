import type { EffectTarget } from "./effect-target";
import type { PlannedFile } from "./rewrite";
import type { SemanticFact } from "./semantics";

export interface CandidateReport {
  readonly reasonCode?: "not-applicable" | "unsupported-shape" | "missing-proof" | "semantic-difference" | "overlap-deferred" | "analysis-limit" | "validation-failed";
  readonly proofObligations?: readonly string[];
  /** Locations refer to the input source of this pass. */
  readonly pass?: number;
  readonly candidateId: string;
  readonly filePath: string;
  readonly ruleId: string;
  readonly target: EffectTarget;
  readonly status: "converted" | "review" | "skipped";
  readonly reason?: string;
  readonly line?: number;
  readonly column?: number;
  readonly evidence: readonly SemanticFact[];
}

export interface CodemodSummary {
  readonly passes?: number;
  readonly converged?: boolean;
  readonly stopReason?: "unchanged" | "pass-limit" | "validation-failed" | "cycle";
  readonly candidates: number;
  readonly converted: number;
  readonly review: number;
  readonly skipped: number;
  readonly changedFiles: number;
  readonly written: boolean;
  readonly valid: boolean;
  readonly skipReasons: readonly { readonly reason: string; readonly count: number }[];
}

export interface CodemodReport {
  readonly passes?: readonly { readonly pass: number; readonly sourceHash: string; readonly candidates: readonly CandidateReport[]; readonly summary: CodemodSummary }[];
  readonly candidates: readonly CandidateReport[];
  readonly files: readonly PlannedFile[];
  readonly summary: CodemodSummary;
  readonly validation: {
    readonly ok: boolean;
    readonly newDiagnostics: readonly unknown[];
  };
}
