export interface SemanticFact {
  readonly kind:
    | "binding"
    | "type"
    | "signature"
    | "call-site"
    | "ast-pattern"
    | "diagnostic"
    | "custom";
  readonly summary: string;
  readonly data?: unknown;
}

export interface SemanticLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
}

export interface SemanticSymbol {
  readonly id: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly flags: readonly string[];
  readonly external: boolean;
  readonly declarations: readonly SemanticLocation[];
  readonly aliasTargetId?: string;
  readonly declaredTypeId?: string;
  readonly valueTypeId?: string;
  readonly raw: unknown;
}

export interface SemanticType {
  readonly id: string;
  readonly kind: string;
  readonly displayText: string;
  readonly flags: readonly string[];
  readonly aliasSymbolId?: string;
  readonly raw: unknown;
}

export interface SemanticParameter {
  readonly name: string;
  readonly typeId: string;
  readonly optional: boolean;
  readonly rest: boolean;
  readonly annotation: "explicit" | "inferred";
}

export interface SemanticSignature {
  readonly id: string;
  readonly kind: "call" | "construct";
  readonly parameters: readonly SemanticParameter[];
  readonly returnTypeId: string;
  readonly returnAnnotation: "explicit" | "inferred";
  readonly raw: unknown;
}

export interface SemanticGenericBinding {
  readonly parameterName: string;
  readonly parameterTypeId: string;
  readonly typeId: string;
  readonly source: "explicit" | "inferred";
}

export interface SemanticGenericInstantiation {
  readonly complete: boolean;
  readonly bindings: readonly SemanticGenericBinding[];
}

/**
 * Stable call-site view derived from js-ts-tools TypeModelCallSite.
 * TypeModel locations are point locations, not source ranges.
 */
export interface SemanticCallSite {
  readonly id: string;
  readonly kind: "call" | "new" | "taggedTemplate" | "decorator" | "jsx" | "instanceof";
  readonly location: SemanticLocation;
  readonly resolution: "resolved" | "unresolved";
  readonly resultTypeId: string;
  readonly calleeSymbolId?: string;
  readonly declarationSignatureId?: string;
  readonly resolvedSignatureId?: string;
  readonly genericInstantiation?: SemanticGenericInstantiation;
  readonly raw: unknown;
}

/**
 * Read-only semantic index used by rules. The implementation may retain richer
 * js-ts-tools records internally, but rules only depend on this stable surface.
 */
export interface SemanticModelIndex {
  symbol(id: string): SemanticSymbol | undefined;
  type(id: string): SemanticType | undefined;
  signature(id: string): SemanticSignature | undefined;
  callSite(id: string): SemanticCallSite | undefined;
  callSitesAt(location: SemanticLocation, kind?: SemanticCallSite["kind"]): readonly SemanticCallSite[];
  resolveAliasSymbol(id: string): SemanticSymbol | undefined;
  isEffectPackageSymbol(id: string, expectedName?: string): boolean;
  isEffectModuleSymbol(id: string, moduleName: string, expectedName?: string): boolean;
  isTypeScriptLibSymbol(id: string, expectedName?: string): boolean;
  isEffectType(typeId: string): boolean;
  callSiteCalleeIsEffectFunction(callSite: SemanticCallSite, expectedName: string): boolean;
  callSiteResultIsEffect(callSite: SemanticCallSite): boolean;
  callSiteResultIsEffectTransformer?(callSite: SemanticCallSite): boolean;
}

export interface SemanticSnapshot {
  readonly rawTypeModel: unknown;
  readonly diagnostics: readonly unknown[];
  readonly callSites?: readonly SemanticCallSite[];
  readonly model?: SemanticModelIndex;
}

export type SemanticCorrelationStrength = "exact" | "contained";

export interface CorrelatedCallSite {
  readonly strength: SemanticCorrelationStrength;
  readonly callSite: SemanticCallSite;
}

export interface CorrelatedAstPattern {
  readonly strength: SemanticCorrelationStrength;
  readonly requirementId: string;
  readonly filePath: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly text: string;
}

export interface CandidateSemantics {
  readonly facts: readonly SemanticFact[];
  readonly callSites: readonly CorrelatedCallSite[];
  readonly astPatterns: readonly CorrelatedAstPattern[];
}

export interface SemanticContext {
  readonly snapshot: SemanticSnapshot;
  factsFor(candidateId: string): readonly SemanticFact[];
  callSitesFor(candidateId: string): readonly CorrelatedCallSite[];
  astPatternsFor(candidateId: string): readonly CorrelatedAstPattern[];
  exactCallSiteFor(candidateId: string): SemanticCallSite | undefined;
  hasExactAstPattern(candidateId: string, requirementId: string): boolean;
}

export type ConversionConfidence = "safe" | "review";
