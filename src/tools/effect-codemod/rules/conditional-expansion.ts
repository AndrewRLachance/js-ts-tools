import type { SemanticFact } from "../contracts/semantics";
import type { EffectConversionRule, RuleContext, RuleDecision } from "../contracts/rule";
import type { SyntaxCandidate } from "../contracts/source";
import {
  arrowWithBodyText,
  type ArrowFunctionLike,
  type CallExpressionLike,
  type IdentifierLike,
  type NodeLike,
  callResultIsEffect,
  effectCallMatches,
  effectModuleCallMatches,
  expressionCall,
  isArrayLiteralExpression,
  isArrowFunction,
  isConditionalExpression,
  isFunctionExpression,
  isSameIdentifier,
  nodeText,
  singleArrowParameterIdentifier,
  unwrapParentheses,
} from "../core/ts-syntax";
import { convert, proveOuterEffectCall, rewriteWholeCandidate, skip } from "./effect-compositions";

interface SuspendedOptionValue {
  readonly effect: CallExpressionLike;
}

/** Effect v3 unless is suspend(() => condition() ? succeed(None) : asSome(self)). */
export const unlessFromSuspendedConditionalRule: EffectConversionRule = {
  id: "effect.unless.from-suspend-conditional",
  target: "unless",
  description: "Rewrite the canonical suspended false-condition Option gate to Effect.unless.",
  selectors: [{ id: "effect.unless.from-suspend-conditional.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="suspend"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "suspend");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Effect.suspend must have one thunk argument.", outer.value.evidence);
    const thunk = outer.value.call.arguments[0];
    if (!thunk || !isArrowFunction(thunk) || thunk.parameters.length !== 0) {
      return skip("Effect.suspend thunk must be a zero-argument arrow.", outer.value.evidence);
    }
    const conditional = unwrapParentheses(thunk.body, context.sourceText);
    if (!isConditionalExpression(conditional)) return skip("Suspend thunk must directly return a conditional expression.", outer.value.evidence);

    if (!isSucceedNone(conditional.whenTrue, candidate.filePath, context)) {
      return skip("True branch must be Effect.succeed(Option.none()).", outer.value.evidence);
    }
    const falseValue = asSomeSuspendedEffect(conditional.whenFalse, candidate.filePath, context);
    if (!falseValue) {
      return skip("False branch must be Effect.asSome(Effect.suspend(functionLiteral)).", outer.value.evidence);
    }

    return convert(
      this.id,
      this.target,
      candidate,
      outer.value.evidence,
      `__codemod_Effect__.unless(${nodeText(falseValue.effect, context.sourceText)}, () => ${nodeText(conditional.condition, context.sourceText)})`,
      "Matches Effect v3 unless while only moving construction of an inert Effect.suspend value across the branch boundary.",
    );
  },
  rewrite: rewriteWholeCandidate,
};

export const unlessEffectFromFlatMapRule = effectBooleanGateRule({
  id: "effect.unlessEffect.from-flatMap-conditional",
  target: "unlessEffect",
  trueIsSome: false,
});

export const whenEffectFromFlatMapRule = effectBooleanGateRule({
  id: "effect.whenEffect.from-flatMap-conditional",
  target: "whenEffect",
  trueIsSome: true,
});

export const whenFiberRefFromGetFlatMapRule = referenceConditionalRule({
  id: "effect.whenFiberRef.from-fiberRef-get-flatMap",
  target: "whenFiberRef",
  moduleName: "FiberRef",
});

export const whenRefFromGetFlatMapRule = referenceConditionalRule({
  id: "effect.whenRef.from-ref-get-flatMap",
  target: "whenRef",
  moduleName: "Ref",
});

export const CONDITIONAL_EXPANSION_RULES: readonly EffectConversionRule[] = [
  unlessFromSuspendedConditionalRule,
  unlessEffectFromFlatMapRule,
  whenEffectFromFlatMapRule,
  whenFiberRefFromGetFlatMapRule,
  whenRefFromGetFlatMapRule,
];

function effectBooleanGateRule(options: {
  readonly id: string;
  readonly target: "unlessEffect" | "whenEffect";
  readonly trueIsSome: boolean;
}): EffectConversionRule {
  return {
    id: options.id,
    target: options.target,
    description: `Rewrite the canonical Effect.flatMap boolean gate to Effect.${options.target}.`,
    selectors: [{ id: `${options.id}.call`, tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]' }],
    analyze(candidate, context) {
      const outer = proveOuterEffectCall(candidate, context, "flatMap");
      if (!outer.ok) return outer.decision;
      if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have condition and callback arguments.", outer.value.evidence);
      const [conditionEffect, mapper] = outer.value.call.arguments;
      if (!conditionEffect || !mapper || !isArrowFunction(mapper)) {
        return skip("Only data-first Effect.flatMap with an arrow callback is supported.", outer.value.evidence);
      }
      const flag = singleArrowParameterIdentifier(mapper);
      if (!flag) return skip("Boolean gate callback must have one simple identifier parameter.", outer.value.evidence);
      const conditional = unwrapParentheses(mapper.body, context.sourceText);
      if (!isConditionalExpression(conditional) || !isSameIdentifier(conditional.condition, flag, context.sourceText)) {
        return skip("Boolean gate callback must directly branch on its callback parameter.", outer.value.evidence);
      }

      const someBranch = options.trueIsSome ? conditional.whenTrue : conditional.whenFalse;
      const noneBranch = options.trueIsSome ? conditional.whenFalse : conditional.whenTrue;
      const some = asSomeSuspendedEffect(someBranch, candidate.filePath, context);
      if (!some) return skip("Executed branch must be Effect.asSome(Effect.suspend(functionLiteral)).", outer.value.evidence);
      if (!isSucceedNone(noneBranch, candidate.filePath, context)) {
        return skip("Skipped branch must be Effect.succeed(Option.none()).", outer.value.evidence);
      }

      return convert(
        this.id,
        this.target,
        candidate,
        outer.value.evidence,
        `__codemod_Effect__.${options.target}(${nodeText(some.effect, context.sourceText)}, ${nodeText(conditionEffect, context.sourceText)})`,
        `Matches Effect v3 ${options.target}; moving construction of the nested Effect.suspend is side-effect free.`,
      );
    },
    rewrite: rewriteWholeCandidate,
  };
}

function referenceConditionalRule(options: {
  readonly id: string;
  readonly target: "whenFiberRef" | "whenRef";
  readonly moduleName: "FiberRef" | "Ref";
}): EffectConversionRule {
  return {
    id: options.id,
    target: options.target,
    description: `Rewrite the canonical ${options.moduleName}.get + conditional Option tuple lowering to Effect.${options.target}.`,
    selectors: [{ id: `${options.id}.call`, tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]' }],
    analyze(candidate, context) {
      const outer = proveOuterEffectCall(candidate, context, "flatMap");
      if (!outer.ok) return outer.decision;
      if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have reference-read and callback arguments.", outer.value.evidence);
      const [readNode, mapper] = outer.value.call.arguments;
      if (!readNode || !mapper || !isArrowFunction(mapper)) return skip("Reference lowering must use an arrow callback.", outer.value.evidence);

      const read = expressionCall(readNode, context.sourceText);
      if (!read || read.arguments.length !== 1
        || !effectModuleCallMatches(context.semantics, candidate.filePath, read, options.moduleName, "get")
        || !callResultIsEffect(context.semantics, candidate.filePath, read)) {
        return skip(`First argument must be proven ${options.moduleName}.get(reference).`, outer.value.evidence);
      }
      const reference = read.arguments[0];
      if (!reference) return skip("Reference argument is missing.", outer.value.evidence);
      const state = singleArrowParameterIdentifier(mapper);
      if (!state) return skip("Reference callback must have one simple state parameter.", outer.value.evidence);
      const conditional = unwrapParentheses(mapper.body, context.sourceText);
      if (!isConditionalExpression(conditional)) return skip("Reference callback must directly return a conditional expression.", outer.value.evidence);

      const successful = parseReferenceSuccess(conditional.whenTrue, state, candidate.filePath, context);
      if (!successful) return skip("True branch must be Effect.map(Effect.suspend(...), a => [state, Option.some(a)]).", outer.value.evidence);
      if (!isReferenceNone(conditional.whenFalse, state, candidate.filePath, context)) {
        return skip("False branch must be Effect.succeed([state, Option.none()]).", outer.value.evidence);
      }

      const predicate = arrowWithBodyText(mapper, conditional.condition, context.sourceText);
      return convert(
        this.id,
        this.target,
        candidate,
        outer.value.evidence,
        `__codemod_Effect__.${options.target}(${nodeText(successful.effect, context.sourceText)}, ${nodeText(reference, context.sourceText)}, ${predicate})`,
        `Matches Effect v3 ${options.target}: read the current ${options.moduleName} value once, test it, preserve it in the tuple, and conditionally execute the effect.`,
      );
    },
    rewrite: rewriteWholeCandidate,
  };
}

function asSomeSuspendedEffect(node: NodeLike, filePath: string, context: RuleContext): SuspendedOptionValue | undefined {
  const asSome = expressionCall(node, context.sourceText);
  if (!asSome || asSome.arguments.length !== 1
    || !effectCallMatches(context.semantics, filePath, asSome, "asSome")
    || !callResultIsEffect(context.semantics, filePath, asSome)) return undefined;
  const effect = suspendedEffect(asSome.arguments[0]!, filePath, context);
  return effect ? { effect } : undefined;
}

function suspendedEffect(node: NodeLike, filePath: string, context: RuleContext): CallExpressionLike | undefined {
  const call = expressionCall(node, context.sourceText);
  if (!call || call.arguments.length !== 1
    || !effectCallMatches(context.semantics, filePath, call, "suspend")
    || !callResultIsEffect(context.semantics, filePath, call)) return undefined;
  const thunk = call.arguments[0];
  if (!thunk || (!isArrowFunction(thunk) && !isFunctionExpression(thunk, context.sourceText))) return undefined;
  return call;
}

function isSucceedNone(node: NodeLike, filePath: string, context: RuleContext): boolean {
  const succeed = expressionCall(node, context.sourceText);
  if (!succeed || succeed.arguments.length !== 1
    || !effectCallMatches(context.semantics, filePath, succeed, "succeed")
    || !callResultIsEffect(context.semantics, filePath, succeed)) return false;
  const none = expressionCall(succeed.arguments[0]!, context.sourceText);
  return none !== undefined
    && none.arguments.length === 0
    && effectModuleCallMatches(context.semantics, filePath, none, "Option", "none");
}

function parseReferenceSuccess(
  node: NodeLike,
  state: IdentifierLike,
  filePath: string,
  context: RuleContext,
): { readonly effect: CallExpressionLike } | undefined {
  const map = expressionCall(node, context.sourceText);
  if (!map || map.arguments.length !== 2
    || !effectCallMatches(context.semantics, filePath, map, "map")
    || !callResultIsEffect(context.semantics, filePath, map)) return undefined;
  const effect = suspendedEffect(map.arguments[0]!, filePath, context);
  const mapper = map.arguments[1];
  if (!effect || !mapper || !isArrowFunction(mapper)) return undefined;
  const value = singleArrowParameterIdentifier(mapper);
  if (!value) return undefined;
  const tuple = unwrapParentheses(mapper.body, context.sourceText);
  if (!isArrayLiteralExpression(tuple) || tuple.elements.length !== 2
    || !isSameIdentifier(tuple.elements[0]!, state, context.sourceText)) return undefined;
  const some = expressionCall(tuple.elements[1]!, context.sourceText);
  if (!some || some.arguments.length !== 1
    || !effectModuleCallMatches(context.semantics, filePath, some, "Option", "some")
    || !isSameIdentifier(some.arguments[0]!, value, context.sourceText)) return undefined;
  return { effect };
}

function isReferenceNone(node: NodeLike, state: IdentifierLike, filePath: string, context: RuleContext): boolean {
  const succeed = expressionCall(node, context.sourceText);
  if (!succeed || succeed.arguments.length !== 1
    || !effectCallMatches(context.semantics, filePath, succeed, "succeed")
    || !callResultIsEffect(context.semantics, filePath, succeed)) return false;
  const tuple = unwrapParentheses(succeed.arguments[0]!, context.sourceText);
  if (!isArrayLiteralExpression(tuple) || tuple.elements.length !== 2
    || !isSameIdentifier(tuple.elements[0]!, state, context.sourceText)) return false;
  const none = expressionCall(tuple.elements[1]!, context.sourceText);
  return none !== undefined
    && none.arguments.length === 0
    && effectModuleCallMatches(context.semantics, filePath, none, "Option", "none");
}
