import type { EffectTarget } from "./effect-target";

export interface CodemodOptions {
  /** Maximum validated passes, 1..10. The default facade uses three. */
  readonly maxPasses?: number;
  readonly cwd?: string;
  readonly tsconfig?: string;
  readonly sources?: readonly string[];
  readonly excludes?: readonly string[];
  readonly targets?: readonly EffectTarget[];
  readonly write?: boolean;
  /** Include review-level matches in the report; they are never written. */
  readonly includeReview?: boolean;
  /** Compact reports omit contained-call details and duplicate compiler records. */
  readonly evidence?: "compact" | "full";
}
