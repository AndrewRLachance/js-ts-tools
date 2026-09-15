import type { AstXPathPattern } from "../../ast-xpath";
import type { EffectTarget } from "./effect-target";
import type { ExtractedExpression, SyntaxCandidate } from "./source";
import type { ConversionConfidence, SemanticContext, SemanticFact } from "./semantics";
import type { RewritePlan } from "./rewrite";
import type { SyntaxAnalysis } from "./syntax-analysis";

export interface DiscoverySelector {
  readonly callbackShape?: "call" | "conditional" | "not" | "literal" | "void" | "identity";
  readonly callbackParameters?: number;
  readonly requiresSource?: boolean;
  readonly requiresSourceCall?: boolean;
  readonly generatorShape?: "guard" | "yield-return" | "dense-loop";
  readonly id: string;
  readonly tsquery: string;
}

export interface AstPatternRequirement {
  readonly id: string;
  readonly pattern: AstXPathPattern;
  readonly semanticMode?: "strict" | "structural";
}

export interface RuleContext {
  readonly analysis?: SyntaxAnalysis;
  readonly semantics: SemanticContext;
  readonly sourceText: string;
}

export interface ConversionMatch {
  readonly ruleId: string;
  readonly target: EffectTarget;
  readonly candidate: SyntaxCandidate;
  readonly captures: Readonly<Record<string, ExtractedExpression>>;
  readonly confidence: ConversionConfidence;
  readonly evidence: readonly SemanticFact[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type RuleDecision =
  | { readonly kind: "convert"; readonly match: ConversionMatch }
  | { readonly kind: "review"; readonly match: ConversionMatch; readonly reason: string }
  | { readonly kind: "skip"; readonly reason: string; readonly evidence?: readonly SemanticFact[] };

export interface EffectConversionRule {
  readonly id: string;
  readonly target: EffectTarget;
  readonly description: string;
  readonly selectors: readonly DiscoverySelector[];
  readonly astPatterns?: readonly AstPatternRequirement[];

  analyze(candidate: SyntaxCandidate, context: RuleContext): RuleDecision;
  rewrite(match: ConversionMatch, context: RuleContext): RewritePlan;
}
