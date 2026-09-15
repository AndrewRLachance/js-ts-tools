import type { EffectConversionRule, RuleDecision } from "../contracts/rule";
import type { SemanticFact } from "../contracts/semantics";
import type { SyntaxCandidate } from "../contracts/source";
import {
  type ArrowFunctionLike,
  type CallExpressionLike,
  type IdentifierLike,
  type NodeLike,
  type ObjectLiteralExpressionLike,
  type ParameterLike,
  callCalleeIsTypeScriptLibFunction,
  callResultIsEffect,
  candidateCallExpression,
  effectCallMatches,
  effectModuleCallMatches,
  expressionCall,
  hasSimpleArrowParameters,
  isArrowFunction,
  isConditionalExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPrimitiveLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSameIdentifier,
  nodeText,
  singleArrowParameterIdentifier,
  unwrapParentheses,
  uniqueCallSiteForNode,
} from "../core/ts-syntax";
import { convert, proveOuterEffectCall, rewriteWholeCandidate, skip } from "./effect-compositions";

const ALL_SUCCESS_OPTIONS = ["concurrency", "batching", "concurrentFinalizers"] as const;
const REPLICATE_OPTIONS = ["concurrency", "batching", "discard", "concurrentFinalizers"] as const;
const ALL_OPTIONS = ["concurrency", "batching", "discard", "mode", "concurrentFinalizers"] as const;

/**
 * Effect v3 allWith is exactly the data-last wrapper `(arg) => all(arg, options)`.
 * To preserve evaluation timing of `options`, automatic conversion only accepts
 * no options or an object literal whose values are primitive literals.
 */
export const allWithFromArrowAllRule: EffectConversionRule = {
  id: "effect.allWith.from-arrow-all",
  target: "allWith",
  description: "Rewrite effects => Effect.all(effects[, staticOptions]) to Effect.allWith([staticOptions]).",
  selectors: [{ id: "effect.allWith.from-arrow-all.arrow", tsquery: 'ArrowFunction[body.expression.name.text="all"], ArrowFunction[body.expression.expression.name.text="all"]' }],
  analyze(candidate, context) {
    const arrow = candidateArrow(candidate);
    if (!arrow) return skip("Candidate is not an ArrowFunction.");
    const parameter = singleArrowParameterIdentifier(arrow);
    if (!parameter) return skip("allWith source must have exactly one simple arrow parameter.");
    const all = expressionCall(arrow.body, context.sourceText);
    if (!all || all.arguments.length < 1 || all.arguments.length > 2) {
      return skip("Arrow body must directly call Effect.all(arg[, options]).");
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, all, "all")
      || !callResultIsEffect(context.semantics, candidate.filePath, all)) {
      return skip("Arrow body is not proven Effect.all.");
    }
    const input = all.arguments[0];
    if (!input || !isSameIdentifier(input, parameter, context.sourceText)) {
      return skip("Effect.all must consume the arrow parameter unchanged.");
    }

    const options = all.arguments[1];
    if (options && !isStaticAllWithOptions(options, context.sourceText)) {
      return skip("allWith would move options evaluation out of the callback; only primitive-valued option literals are timing-safe.");
    }

    const callSite = uniqueCallSiteForNode(context.semantics, candidate.filePath, all);
    const evidence: SemanticFact[] = [
      ...context.semantics.factsFor(candidate.id),
      ...(callSite ? [{ kind: "binding" as const, summary: "Arrow body resolves to Effect.all.", data: callSite.calleeSymbolId }] : []),
    ];
    const replacement = options
      ? `__codemod_Effect__.allWith(${nodeText(options, context.sourceText)})`
      : "__codemod_Effect__.allWith()";
    return convert(this.id, this.target, candidate, evidence, replacement,
      "Effect v3 allWith(options) is the data-last function arg => Effect.all(arg, options), with options evaluation proven timing-insensitive here.");
  },
  rewrite: rewriteWholeCandidate,
};

/**
 * Recognizes the public equivalent of Effect v3's internal allSuccesses
 * implementation:
 *   Effect.map(
 *     Effect.all(Array.fromIterable(elements).map(effect => Effect.exit(effect)), options),
 *     exits => Array.filterMap(exits, exit => Exit.isSuccess(exit)
 *       ? Option.some(exit.value)
 *       : Option.none())
 *   )
 */
export const allSuccessesFromAllExitsRule: EffectConversionRule = {
  id: "effect.allSuccesses.from-all-exits-filterMap",
  target: "allSuccesses",
  description: "Rewrite the canonical collect-Exit-then-filter-successes lowering to Effect.allSuccesses.",
  selectors: [{ id: "effect.allSuccesses.from-all-exits-filterMap.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.map must have exactly two arguments.", outer.value.evidence);
    const [allNode, collectMapper] = outer.value.call.arguments;
    if (!allNode || !collectMapper || !isArrowFunction(collectMapper)) {
      return skip("allSuccesses lowering requires Effect.map(Effect.all(...), exits => ...).", outer.value.evidence);
    }

    const all = expressionCall(allNode, context.sourceText);
    if (!all || all.arguments.length < 1 || all.arguments.length > 2
      || !effectCallMatches(context.semantics, candidate.filePath, all, "all")
      || !callResultIsEffect(context.semantics, candidate.filePath, all)) {
      return skip("First Effect.map argument must be proven Effect.all(input[, options]).", outer.value.evidence);
    }
    const options = all.arguments[1];
    if (options && !isOptionsSubset(options, ALL_SUCCESS_OPTIONS, context.sourceText)) {
      return skip("Effect.all options must be a literal containing only allSuccesses-compatible keys.", outer.value.evidence);
    }

    const mapped = expressionCall(all.arguments[0]!, context.sourceText);
    if (!mapped || mapped.arguments.length !== 1
      || !callCalleeIsTypeScriptLibFunction(context.semantics, candidate.filePath, mapped, "map")) {
      return skip("Effect.all input must be Array.fromIterable(elements).map(...), with native Array.map proven.", outer.value.evidence);
    }
    const mappedExpression = unwrapParentheses(mapped.expression, context.sourceText);
    if (!isPropertyAccessExpression(mappedExpression)) return skip("Native map receiver is unsupported.", outer.value.evidence);
    const materialized = expressionCall(mappedExpression.expression, context.sourceText);
    if (!materialized || materialized.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, materialized, "Array", "fromIterable")) {
      return skip("Native map receiver must be proven Array.fromIterable(elements).", outer.value.evidence);
    }

    const exitMapper = mapped.arguments[0];
    if (!exitMapper || !isArrowFunction(exitMapper)) return skip("Array.map callback must be an arrow.", outer.value.evidence);
    const effectParam = singleArrowParameterIdentifier(exitMapper);
    if (!effectParam) return skip("Array.map callback must have one simple effect parameter.", outer.value.evidence);
    const exit = expressionCall(exitMapper.body, context.sourceText);
    if (!exit || exit.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, exit, "exit")
      || !callResultIsEffect(context.semantics, candidate.filePath, exit)
      || !isSameIdentifier(exit.arguments[0]!, effectParam, context.sourceText)) {
      return skip("Array.map callback must directly wrap each element with proven Effect.exit.", outer.value.evidence);
    }

    const exitsParam = singleArrowParameterIdentifier(collectMapper);
    if (!exitsParam) return skip("Outer map callback must have one simple exits parameter.", outer.value.evidence);
    const filterMap = expressionCall(collectMapper.body, context.sourceText);
    if (!filterMap || filterMap.arguments.length !== 2
      || !effectModuleCallMatches(context.semantics, candidate.filePath, filterMap, "Array", "filterMap")
      || !isSameIdentifier(filterMap.arguments[0]!, exitsParam, context.sourceText)) {
      return skip("Outer map callback must directly call Array.filterMap(exits, mapper).", outer.value.evidence);
    }

    const successMapper = filterMap.arguments[1];
    if (!successMapper || !isArrowFunction(successMapper)) return skip("Array.filterMap mapper must be an arrow.", outer.value.evidence);
    const exitParam = singleArrowParameterIdentifier(successMapper);
    if (!exitParam) return skip("Array.filterMap mapper must have one simple Exit parameter.", outer.value.evidence);
    const conditional = unwrapParentheses(successMapper.body, context.sourceText);
    if (!isConditionalExpression(conditional)) return skip("Success filter mapper must be a conditional expression.", outer.value.evidence);

    const isSuccess = expressionCall(conditional.condition, context.sourceText);
    const some = expressionCall(conditional.whenTrue, context.sourceText);
    const none = expressionCall(conditional.whenFalse, context.sourceText);
    if (!isSuccess || isSuccess.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, isSuccess, "Exit", "isSuccess")
      || !isSameIdentifier(isSuccess.arguments[0]!, exitParam, context.sourceText)) {
      return skip("Success condition must be proven Exit.isSuccess(exit).", outer.value.evidence);
    }
    if (!some || some.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, some, "Option", "some")
      || !isExitValue(some.arguments[0]!, exitParam, context.sourceText)) {
      return skip("Success branch must be Option.some(exit.value).", outer.value.evidence);
    }
    if (!none || none.arguments.length !== 0
      || !effectModuleCallMatches(context.semantics, candidate.filePath, none, "Option", "none")) {
      return skip("Failure branch must be Option.none().", outer.value.evidence);
    }

    const elements = materialized.arguments[0]!;
    const replacement = options
      ? `__codemod_Effect__.allSuccesses(${nodeText(elements, context.sourceText)}, ${nodeText(options, context.sourceText)})`
      : `__codemod_Effect__.allSuccesses(${nodeText(elements, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacement,
      "Matches Effect v3 allSuccesses: eagerly materialize the iterable, collect Effect.exit values with Effect.all, then retain only successes.");
  },
  rewrite: rewriteWholeCandidate,
};

/** Effect v3 replicateEffect is exactly Effect.all(Effect.replicate(self, n), options). */
export const replicateEffectFromAllReplicateRule: EffectConversionRule = {
  id: "effect.replicateEffect.from-all-replicate",
  target: "replicateEffect",
  description: "Rewrite Effect.all(Effect.replicate(self, n)[, options]) to Effect.replicateEffect.",
  selectors: [{ id: "effect.replicateEffect.from-all-replicate.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="all"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "all");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length < 1 || outer.value.call.arguments.length > 2) {
      return skip("Effect.all must have Effect.replicate input and optional options.", outer.value.evidence);
    }
    const replicate = expressionCall(outer.value.call.arguments[0]!, context.sourceText);
    if (!replicate || replicate.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, replicate, "replicate")) {
      return skip("Effect.all input must be proven Effect.replicate(self, n).", outer.value.evidence);
    }
    const [self, n] = replicate.arguments;
    if (!self || !n) return skip("Effect.replicate arguments are incomplete.", outer.value.evidence);
    const options = outer.value.call.arguments[1];
    if (options && !isOptionsSubset(options, REPLICATE_OPTIONS, context.sourceText)) {
      return skip("Effect.all options must be a literal containing only replicateEffect-compatible keys.", outer.value.evidence);
    }
    const replacement = options
      ? `__codemod_Effect__.replicateEffect(${nodeText(self, context.sourceText)}, ${nodeText(n, context.sourceText)}, ${nodeText(options, context.sourceText)})`
      : `__codemod_Effect__.replicateEffect(${nodeText(self, context.sourceText)}, ${nodeText(n, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacement,
      "Effect v3 replicateEffect delegates directly to Effect.all(Effect.replicate(self, n), options).");
  },
  rewrite: rewriteWholeCandidate,
};

/** Recognizes Effect v3's default sequential mergeAll implementation. */
export const mergeAllFromArrayReduceZipWithRule: EffectConversionRule = {
  id: "effect.mergeAll.from-array-reduce-zipWith-succeed",
  target: "mergeAll",
  description: "Rewrite the canonical sequential Array.reduce + Effect.zipWith + Effect.succeed(zero) lowering to Effect.mergeAll.",
  selectors: [{ id: "effect.mergeAll.from-array-reduce-zipWith-succeed.call", tsquery: 'CallExpression[expression.name.text="reduce"]' }],
  analyze(candidate, context) {
    const outer = proveNativeEffectReturningCall(candidate, context, "reduce");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Native reduce must have reducer and initial Effect arguments.", outer.value.evidence);
    const elements = arrayFromIterableReceiver(outer.value.call, candidate.filePath, context);
    if (!elements) return skip("mergeAll source must begin with proven Array.fromIterable(elements).", outer.value.evidence);
    const [reducer, initial] = outer.value.call.arguments;
    if (!reducer || !initial || !isArrowFunction(reducer) || !hasSimpleArrowParameters(reducer, 3) || reducer.parameters.length < 2) {
      return skip("mergeAll lowering requires a simple (acc, effect[, index]) reducer.", outer.value.evidence);
    }
    const acc = parameterIdentifier(reducer.parameters[0]);
    const effectValue = parameterIdentifier(reducer.parameters[1]);
    if (!acc || !effectValue) return skip("Reducer accumulator and effect parameters must be identifiers.", outer.value.evidence);

    const zero = unwrapSucceedInitial(initial, candidate.filePath, context);
    if (!zero) return skip("mergeAll initial accumulator must be proven Effect.succeed(zero).", outer.value.evidence);

    const zipWith = expressionCall(reducer.body, context.sourceText);
    if (!zipWith || zipWith.arguments.length !== 3
      || !effectCallMatches(context.semantics, candidate.filePath, zipWith, "zipWith")
      || !callResultIsEffect(context.semantics, candidate.filePath, zipWith)) {
      return skip("Reducer body must directly call Effect.zipWith(acc, effect, combiner).", outer.value.evidence);
    }
    const [left, right, combiner] = zipWith.arguments;
    if (!left || !right || !combiner || !isSameIdentifier(left, acc, context.sourceText)
      || !isSameIdentifier(right, effectValue, context.sourceText)
      || !isArrowFunction(combiner) || !hasSimpleArrowParameters(combiner, 2) || combiner.parameters.length !== 2) {
      return skip("Effect.zipWith must combine the wrapped accumulator and current effect using a pure two-argument arrow.", outer.value.evidence);
    }
    const state = parameterIdentifier(combiner.parameters[0]);
    const value = parameterIdentifier(combiner.parameters[1]);
    if (!state || !value) return skip("zipWith combiner parameters must be identifiers.", outer.value.evidence);
    const bodyText = nodeText(combiner.body, context.sourceText);
    if (textReferencesIdentifier(bodyText, acc.text) || textReferencesIdentifier(bodyText, effectValue.text)) {
      return skip("Combiner must not retain references to wrapped Effect values.", outer.value.evidence);
    }

    const merge = renderArrow(
      [combiner.parameters[0]!, combiner.parameters[1]!, ...(reducer.parameters[2] ? [reducer.parameters[2]] : [])],
      combiner.body,
      context.sourceText,
    );
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.mergeAll(${nodeText(elements, context.sourceText)}, ${zero}, ${merge})`,
      "Matches Effect v3's default sequential mergeAll lowering via Array.fromIterable(elements).reduce(Effect.zipWith, Effect.succeed(zero)).");
  },
  rewrite: rewriteWholeCandidate,
};

export const COLLECTING_EXPANSION_RULES: readonly EffectConversionRule[] = [
  allSuccessesFromAllExitsRule,
  allWithFromArrowAllRule,
  mergeAllFromArrayReduceZipWithRule,
  replicateEffectFromAllReplicateRule,
];

function candidateArrow(candidate: SyntaxCandidate): ArrowFunctionLike | undefined {
  return isArrowFunction(candidate.nativeNode) ? candidate.nativeNode : undefined;
}

function isOptionsSubset(
  node: NodeLike,
  allowed: readonly string[],
  sourceText: string,
): node is ObjectLiteralExpressionLike {
  const object = unwrapParentheses(node, sourceText);
  if (!isObjectLiteralExpression(object)) return false;
  const names = new Set(allowed);
  const seen = new Set<string>();
  for (const property of object.properties) {
    if (!isPropertyAssignment(property)) return false;
    const name = nodeText(property.name, sourceText).trim();
    if (!names.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

function isStaticAllWithOptions(node: NodeLike, sourceText: string): boolean {
  if (!isOptionsSubset(node, ALL_OPTIONS, sourceText)) return false;
  const object = unwrapParentheses(node, sourceText) as ObjectLiteralExpressionLike;
  return object.properties.every((property) =>
    isPropertyAssignment(property) && isPrimitiveLiteralExpression(property.initializer, sourceText)
  );
}

function isExitValue(node: NodeLike, exit: IdentifierLike, sourceText: string): boolean {
  const value = unwrapParentheses(node, sourceText);
  return isPropertyAccessExpression(value)
    && value.name.text === "value"
    && isSameIdentifier(value.expression, exit, sourceText);
}

interface ProvenNativeCall {
  readonly call: CallExpressionLike;
  readonly evidence: readonly SemanticFact[];
}

function proveNativeEffectReturningCall(
  candidate: SyntaxCandidate,
  context: Parameters<EffectConversionRule["analyze"]>[1],
  expectedName: string,
): { readonly ok: true; readonly value: ProvenNativeCall } | { readonly ok: false; readonly decision: RuleDecision } {
  const call = candidateCallExpression(candidate);
  if (!call) return { ok: false, decision: skip("Candidate is not a CallExpression.") };
  const evidenceBase = context.semantics.factsFor(candidate.id);
  const model = context.semantics.snapshot.model;
  if (!model) return { ok: false, decision: skip("Typed semantic model is unavailable.", evidenceBase) };
  const callSite = uniqueCallSiteForNode(context.semantics, candidate.filePath, call);
  if (!callSite) return { ok: false, decision: skip(`Native ${expectedName} call site is missing or ambiguous.`, evidenceBase) };
  if (!callCalleeIsTypeScriptLibFunction(context.semantics, candidate.filePath, call, expectedName)) {
    return { ok: false, decision: skip(`Callee is not proven TypeScript lib ${expectedName}.`, evidenceBase) };
  }
  if (!model.callSiteResultIsEffect(callSite)) {
    return { ok: false, decision: skip(`Native ${expectedName} result is not proven to be an Effect.`, evidenceBase) };
  }
  return {
    ok: true,
    value: {
      call,
      evidence: [
        ...evidenceBase,
        { kind: "binding", summary: `Resolved callee is TypeScript lib ${expectedName}.`, data: callSite.calleeSymbolId },
        { kind: "type", summary: "Resolved native fold result is an Effect type.", data: callSite.resultTypeId },
      ],
    },
  };
}

function arrayFromIterableReceiver(
  call: CallExpressionLike,
  filePath: string,
  context: Parameters<EffectConversionRule["analyze"]>[1],
): NodeLike | undefined {
  const expression = unwrapParentheses(call.expression, context.sourceText);
  if (!isPropertyAccessExpression(expression)) return undefined;
  const receiver = expressionCall(expression.expression, context.sourceText);
  if (!receiver || receiver.arguments.length !== 1
    || !effectModuleCallMatches(context.semantics, filePath, receiver, "Array", "fromIterable")) {
    return undefined;
  }
  return receiver.arguments[0];
}

function unwrapSucceedInitial(
  node: NodeLike,
  filePath: string,
  context: Parameters<EffectConversionRule["analyze"]>[1],
): string | undefined {
  const call = expressionCall(node, context.sourceText);
  if (!call || call.arguments.length !== 1
    || !effectCallMatches(context.semantics, filePath, call, "succeed")
    || !callResultIsEffect(context.semantics, filePath, call)) {
    return undefined;
  }
  return nodeText(call.arguments[0]!, context.sourceText);
}

function parameterIdentifier(parameter: ParameterLike | undefined): IdentifierLike | undefined {
  return parameter && parameter.dotDotDotToken === undefined && parameter.initializer === undefined && isIdentifier(parameter.name)
    ? parameter.name
    : undefined;
}

function renderArrow(parameters: readonly ParameterLike[], body: NodeLike, sourceText: string): string {
  const params = parameters.map((parameter) => nodeText(parameter, sourceText)).join(", ");
  return `(${params}) => ${nodeText(body, sourceText)}`;
}

function textReferencesIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "u").test(text);
}
