import type { EffectConversionRule } from "../contracts/rule";
import type { NodeLike, CallExpressionLike, ArrowFunctionLike, IdentifierLike, ObjectLiteralExpressionLike } from "../core/ts-syntax";
import {
  callResultIsEffect,
  effectCallMatches,
  expressionCall,
  hasOnlyObjectProperties,
  hasSimpleArrowParameters,
  isArrayLiteralExpression,
  isArrowFunction,
  isConditionalExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPrimitiveLiteralExpression,
  isSameIdentifier,
  nodeText,
  objectPropertyInitializer,
  singleArrowParameterIdentifier,
  unwrapParentheses,
} from "../core/ts-syntax";
import { convert, proveOuterEffectCall, rewriteWholeCandidate, skip } from "./effect-compositions";

/** Effect v3 flipWith(self, f) is exactly flip(f(flip(self))). */
export const flipWithFromNestedFlipRule: EffectConversionRule = {
  id: "effect.flipWith.from-nested-flip",
  target: "flipWith",
  description: "Rewrite Effect.flip(f(Effect.flip(self))) to Effect.flipWith(self, f).",
  selectors: [{ id: "effect.flipWith.from-nested-flip.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flip"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flip");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Outer Effect.flip must have exactly one argument.", outer.value.evidence);

    const transformed = expressionCall(outer.value.call.arguments[0]!, context.sourceText);
    if (!transformed || transformed.arguments.length !== 1 || !callResultIsEffect(context.semantics, candidate.filePath, transformed)) {
      return skip("Outer flip argument must be a one-argument call proven to return Effect.", outer.value.evidence);
    }
    const transform = unwrapParentheses(transformed.expression, context.sourceText);
    if (!isIdentifier(transform)) {
      return skip("flipWith conversion requires a simple transform identifier to avoid changing callee evaluation order.", outer.value.evidence);
    }

    const inner = expressionCall(transformed.arguments[0]!, context.sourceText);
    if (!inner || inner.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, inner, "flip")
      || !callResultIsEffect(context.semantics, candidate.filePath, inner)) {
      return skip("Transform argument must be proven Effect.flip(self).", outer.value.evidence);
    }
    const self = inner.arguments[0];
    if (!self) return skip("Inner Effect.flip argument is missing.", outer.value.evidence);
    const stableSelf = unwrapParentheses(self, context.sourceText);
    if (!isIdentifier(stableSelf)) {
      return skip("flipWith conversion currently requires a simple self identifier so self/transform evaluation order cannot become observable.", outer.value.evidence);
    }

    return convert(
      this.id,
      this.target,
      candidate,
      outer.value.evidence,
      `__codemod_Effect__.flipWith(${nodeText(self, context.sourceText)}, ${transform.text})`,
      "Effect v3 flipWith is exactly flip(f(flip(self))); simple-identifier gating preserves call evaluation order.",
    );
  },
  rewrite: rewriteWholeCandidate,
};

/**
 * Recognizes one explicit unrolling of Effect v3 iterate. The recursive tail is
 * already expressed with Effect.iterate; collapsing the duplicated head step is
 * therefore mechanically exact. The outer suspend is retained so reads of the
 * initial expression and callback identifiers remain execution-time reads.
 */
export const iterateFromSuspendedUnrollRule: EffectConversionRule = {
  id: "effect.iterate.from-suspended-unroll",
  target: "iterate",
  description: "Collapse one suspended iterate unrolling to Effect.iterate.",
  selectors: [{ id: "effect.iterate.from-suspended-unroll.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="suspend"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "suspend");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Effect.suspend must have one thunk.", outer.value.evidence);
    const thunk = outer.value.call.arguments[0];
    if (!thunk || !isArrowFunction(thunk) || thunk.parameters.length !== 0) {
      return skip("iterate lowering requires a zero-argument suspend arrow.", outer.value.evidence);
    }
    const conditional = unwrapParentheses(thunk.body, context.sourceText);
    if (!isConditionalExpression(conditional)) return skip("iterate suspend body must be a conditional expression.", outer.value.evidence);

    const predicateCall = expressionCall(conditional.condition, context.sourceText);
    if (!predicateCall || predicateCall.arguments.length !== 1) return skip("iterate condition must be predicate(initial).", outer.value.evidence);
    const predicate = simpleCalleeIdentifier(predicateCall, context.sourceText);
    const initial = predicateCall.arguments[0];
    if (!predicate || !initial || !isPrimitiveLiteralExpression(initial, context.sourceText)) {
      return skip("iterate conversion currently requires a simple predicate and primitive initial value.", outer.value.evidence);
    }

    const head = expressionCall(conditional.whenTrue, context.sourceText);
    if (!head || head.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, head, "flatMap")
      || !callResultIsEffect(context.semantics, candidate.filePath, head)) {
      return skip("iterate true branch must be proven Effect.flatMap(body(initial), ...).", outer.value.evidence);
    }
    const bodyCall = expressionCall(head.arguments[0]!, context.sourceText);
    if (!bodyCall || bodyCall.arguments.length !== 1 || !sameText(bodyCall.arguments[0]!, initial, context.sourceText)
      || !callResultIsEffect(context.semantics, candidate.filePath, bodyCall)) {
      return skip("iterate body call must consume the same initial value and return Effect.", outer.value.evidence);
    }
    const body = simpleCalleeIdentifier(bodyCall, context.sourceText);
    if (!body) return skip("iterate body must be a simple function identifier.", outer.value.evidence);

    const nextMapper = head.arguments[1];
    if (!nextMapper || !isArrowFunction(nextMapper)) return skip("iterate flatMap callback must be an arrow.", outer.value.evidence);
    const next = singleArrowParameterIdentifier(nextMapper);
    if (!next) return skip("iterate flatMap callback must have one simple next-state parameter.", outer.value.evidence);
    const recursive = expressionCall(nextMapper.body, context.sourceText);
    if (!recursive || recursive.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, recursive, "iterate")
      || !callResultIsEffect(context.semantics, candidate.filePath, recursive)
      || !isSameIdentifier(recursive.arguments[0]!, next, context.sourceText)) {
      return skip("iterate tail must call Effect.iterate(next, options).", outer.value.evidence);
    }
    const options = unwrapParentheses(recursive.arguments[1]!, context.sourceText);
    if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["while", "body"], context.sourceText)) {
      return skip("Recursive iterate options must contain exactly while and body.", outer.value.evidence);
    }
    const whileWrapper = objectPropertyInitializer(options, "while", context.sourceText);
    const bodyWrapper = objectPropertyInitializer(options, "body", context.sourceText);
    if (!whileWrapper || !bodyWrapper
      || !wrapperCallsIdentifier(whileWrapper, predicate, context.sourceText)
      || !wrapperCallsIdentifier(bodyWrapper, body, context.sourceText)) {
      return skip("Recursive iterate options must defer the same predicate/body identifiers through one-argument wrappers.", outer.value.evidence);
    }

    const fallback = expressionCall(conditional.whenFalse, context.sourceText);
    if (!fallback || fallback.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, fallback, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, fallback)
      || !sameText(fallback.arguments[0]!, initial, context.sourceText)) {
      return skip("iterate false branch must be Effect.succeed(initial).", outer.value.evidence);
    }

    const replacement = `__codemod_Effect__.suspend(() => __codemod_Effect__.iterate(${nodeText(initial, context.sourceText)}, { while: ${nodeText(whileWrapper, context.sourceText)}, body: ${nodeText(bodyWrapper, context.sourceText)} }))`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacement,
      "Collapses one exact Effect v3 iterate unrolling while retaining the outer suspend and callback wrappers.");
  },
  rewrite: rewriteWholeCandidate,
};

/**
 * Recognizes the non-discard Effect.loop recursion one step at a time. The
 * recursive tail must already be Effect.loop and the collected head must be
 * prepended to the recursive array exactly.
 */
export const loopFromSuspendedUnrollRule: EffectConversionRule = {
  id: "effect.loop.from-suspended-unroll",
  target: "loop",
  description: "Collapse one suspended non-discard loop unrolling to Effect.loop.",
  selectors: [{ id: "effect.loop.from-suspended-unroll.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="suspend"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "suspend");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Effect.suspend must have one thunk.", outer.value.evidence);
    const thunk = outer.value.call.arguments[0];
    if (!thunk || !isArrowFunction(thunk) || thunk.parameters.length !== 0) return skip("loop lowering requires a zero-argument suspend arrow.", outer.value.evidence);
    const conditional = unwrapParentheses(thunk.body, context.sourceText);
    if (!isConditionalExpression(conditional)) return skip("loop suspend body must be a conditional expression.", outer.value.evidence);

    const predicateCall = expressionCall(conditional.condition, context.sourceText);
    if (!predicateCall || predicateCall.arguments.length !== 1) return skip("loop condition must be predicate(initial).", outer.value.evidence);
    const predicate = simpleCalleeIdentifier(predicateCall, context.sourceText);
    const initial = predicateCall.arguments[0];
    if (!predicate || !initial || !isPrimitiveLiteralExpression(initial, context.sourceText)) {
      return skip("loop conversion currently requires a simple predicate and primitive initial value.", outer.value.evidence);
    }

    const flatMap = expressionCall(conditional.whenTrue, context.sourceText);
    if (!flatMap || flatMap.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, flatMap, "flatMap")
      || !callResultIsEffect(context.semantics, candidate.filePath, flatMap)) {
      return skip("loop true branch must be proven Effect.flatMap(body(initial), ...).", outer.value.evidence);
    }
    const bodyCall = expressionCall(flatMap.arguments[0]!, context.sourceText);
    if (!bodyCall || bodyCall.arguments.length !== 1 || !sameText(bodyCall.arguments[0]!, initial, context.sourceText)
      || !callResultIsEffect(context.semantics, candidate.filePath, bodyCall)) {
      return skip("loop body must consume the same initial value and return Effect.", outer.value.evidence);
    }
    const body = simpleCalleeIdentifier(bodyCall, context.sourceText);
    if (!body) return skip("loop body must be a simple function identifier.", outer.value.evidence);

    const headMapper = flatMap.arguments[1];
    if (!headMapper || !isArrowFunction(headMapper)) return skip("loop flatMap callback must be an arrow.", outer.value.evidence);
    const headValue = singleArrowParameterIdentifier(headMapper);
    if (!headValue) return skip("loop flatMap callback must have one simple head-value parameter.", outer.value.evidence);
    const map = expressionCall(headMapper.body, context.sourceText);
    if (!map || map.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, map, "map")
      || !callResultIsEffect(context.semantics, candidate.filePath, map)) {
      return skip("loop head callback must map the recursive tail.", outer.value.evidence);
    }

    const recursive = expressionCall(map.arguments[0]!, context.sourceText);
    if (!recursive || recursive.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, recursive, "loop")
      || !callResultIsEffect(context.semantics, candidate.filePath, recursive)) {
      return skip("loop tail must be a proven Effect.loop(step(initial), options).", outer.value.evidence);
    }
    const stepCall = expressionCall(recursive.arguments[0]!, context.sourceText);
    if (!stepCall || stepCall.arguments.length !== 1 || !sameText(stepCall.arguments[0]!, initial, context.sourceText)) {
      return skip("Recursive loop must advance with step(initial).", outer.value.evidence);
    }
    const step = simpleCalleeIdentifier(stepCall, context.sourceText);
    if (!step) return skip("loop step must be a simple function identifier.", outer.value.evidence);

    const options = unwrapParentheses(recursive.arguments[1]!, context.sourceText);
    if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["while", "step", "body"], context.sourceText)) {
      return skip("Recursive loop options must contain exactly while, step, and body.", outer.value.evidence);
    }
    const whileWrapper = objectPropertyInitializer(options, "while", context.sourceText);
    const stepWrapper = objectPropertyInitializer(options, "step", context.sourceText);
    const bodyWrapper = objectPropertyInitializer(options, "body", context.sourceText);
    if (!whileWrapper || !stepWrapper || !bodyWrapper
      || !wrapperCallsIdentifier(whileWrapper, predicate, context.sourceText)
      || !wrapperCallsIdentifier(stepWrapper, step, context.sourceText)
      || !wrapperCallsIdentifier(bodyWrapper, body, context.sourceText)) {
      return skip("Recursive loop options must defer the same predicate/step/body identifiers through wrappers.", outer.value.evidence);
    }

    const tailMapper = map.arguments[1];
    if (!tailMapper || !isArrowFunction(tailMapper)) return skip("Recursive loop collector must be an arrow.", outer.value.evidence);
    const rest = singleArrowParameterIdentifier(tailMapper);
    if (!rest || !isExactHeadPrepend(tailMapper.body, headValue, rest, context.sourceText)) {
      return skip("Recursive loop collector must be exactly rest => [head, ...rest].", outer.value.evidence);
    }

    const fallback = expressionCall(conditional.whenFalse, context.sourceText);
    if (!fallback || fallback.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, fallback, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, fallback)
      || !isEmptyArray(fallback.arguments[0]!, context.sourceText)) {
      return skip("loop false branch must be Effect.succeed([]).", outer.value.evidence);
    }

    const replacement = `__codemod_Effect__.suspend(() => __codemod_Effect__.loop(${nodeText(initial, context.sourceText)}, { while: ${nodeText(whileWrapper, context.sourceText)}, step: ${nodeText(stepWrapper, context.sourceText)}, body: ${nodeText(bodyWrapper, context.sourceText)} }))`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacement,
      "Collapses one exact non-discard Effect v3 loop unrolling while retaining execution-time reads inside suspend.");
  },
  rewrite: rewriteWholeCandidate,
};

/**
 * Recognizes an immutable Effect.reduce state machine equivalent to mapAccum.
 * The entire lowering must be inside Effect.suspend so the accumulator builder
 * and captured input expressions are recreated/read at execution time.
 */
export const mapAccumFromSuspendedReduceRule: EffectConversionRule = {
  id: "effect.mapAccum.from-suspended-reduce",
  target: "mapAccum",
  description: "Rewrite a suspended immutable tuple-accumulator Effect.reduce to Effect.mapAccum.",
  selectors: [{ id: "effect.mapAccum.from-suspended-reduce.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="suspend"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "suspend");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Effect.suspend must have one thunk.", outer.value.evidence);
    const thunk = outer.value.call.arguments[0];
    if (!thunk || !isArrowFunction(thunk) || thunk.parameters.length !== 0) return skip("mapAccum lowering requires a zero-argument suspend arrow.", outer.value.evidence);

    const reduce = expressionCall(thunk.body, context.sourceText);
    if (!reduce || reduce.arguments.length !== 3
      || !effectCallMatches(context.semantics, candidate.filePath, reduce, "reduce")
      || !callResultIsEffect(context.semantics, candidate.filePath, reduce)) {
      return skip("Suspend body must directly call proven Effect.reduce(elements, zero, reducer).", outer.value.evidence);
    }
    const [elements, zeroNode, reducer] = reduce.arguments;
    if (!elements || !zeroNode || !reducer || !isArrowFunction(reducer)
      || !hasSimpleArrowParameters(reducer, 3) || reducer.parameters.length < 2) {
      return skip("mapAccum reduce callback must be a simple (acc, value[, index]) arrow.", outer.value.evidence);
    }

    const zero = unwrapParentheses(zeroNode, context.sourceText);
    if (!isArrayLiteralExpression(zero) || zero.elements.length !== 2 || !zero.elements[0] || !zero.elements[1]
      || !isEmptyArray(zero.elements[1], context.sourceText)) {
      return skip("mapAccum reduce zero must be exactly [initial, []].", outer.value.evidence);
    }
    const initial = zero.elements[0];
    const acc = parameterIdentifier(reducer.parameters[0]);
    const value = parameterIdentifier(reducer.parameters[1]);
    const index = parameterIdentifier(reducer.parameters[2]);
    if (!acc || !value || (reducer.parameters.length === 3 && !index)) {
      return skip("mapAccum reduce parameters must be simple identifiers.", outer.value.evidence);
    }

    const map = expressionCall(reducer.body, context.sourceText);
    if (!map || map.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, map, "map")
      || !callResultIsEffect(context.semantics, candidate.filePath, map)) {
      return skip("mapAccum reducer must directly return Effect.map(step(...), pair => ...).", outer.value.evidence);
    }
    const stepCall = expressionCall(map.arguments[0]!, context.sourceText);
    if (!stepCall || !callResultIsEffect(context.semantics, candidate.filePath, stepCall)) {
      return skip("mapAccum step must be a call proven to return Effect.", outer.value.evidence);
    }
    const step = simpleCalleeIdentifier(stepCall, context.sourceText);
    if (!step) return skip("mapAccum step must be a simple function identifier.", outer.value.evidence);
    const expectedArgs = [`${acc.text}[0]`, value.text, ...(index ? [index.text] : [])];
    if (!callArgumentsMatchText(stepCall, expectedArgs, context.sourceText)) {
      return skip("mapAccum step must receive acc[0], value, and the optional index unchanged.", outer.value.evidence);
    }

    const pairMapper = map.arguments[1];
    if (!pairMapper || !isArrowFunction(pairMapper)) return skip("mapAccum pair mapper must be an arrow.", outer.value.evidence);
    const pair = singleArrowParameterIdentifier(pairMapper);
    if (!pair || !isExactAccumTuple(pairMapper.body, acc, pair, context.sourceText)) {
      return skip("mapAccum pair mapper must be exactly pair => [pair[0], [...acc[1], pair[1]]].", outer.value.evidence);
    }

    const callbackParams = ["state", "value", ...(index ? ["index"] : [])];
    const callbackArgs = ["state", "value", ...(index ? ["index"] : [])];
    const replacement = `__codemod_Effect__.suspend(() => __codemod_Effect__.mapAccum(${nodeText(elements, context.sourceText)}, ${nodeText(initial, context.sourceText)}, (${callbackParams.join(", ")}) => ${step.text}(${callbackArgs.join(", ")})))`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacement,
      "Recognizes a fresh-per-run immutable tuple accumulator with the same sequential state/value/index threading as Effect.mapAccum.");
  },
  rewrite: rewriteWholeCandidate,
};

export const REMAINING_EXPANSION_RULES: readonly EffectConversionRule[] = [
  flipWithFromNestedFlipRule,
  iterateFromSuspendedUnrollRule,
  loopFromSuspendedUnrollRule,
  mapAccumFromSuspendedReduceRule,
];

function simpleCalleeIdentifier(call: CallExpressionLike, sourceText: string): IdentifierLike | undefined {
  const callee = unwrapParentheses(call.expression, sourceText);
  return isIdentifier(callee) ? callee : undefined;
}

function parameterIdentifier(parameter: { readonly name: NodeLike } | undefined): IdentifierLike | undefined {
  return parameter && isIdentifier(parameter.name) ? parameter.name : undefined;
}

function sameText(left: NodeLike, right: NodeLike, sourceText: string): boolean {
  return normalize(nodeText(left, sourceText)) === normalize(nodeText(right, sourceText));
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, "");
}

function wrapperCallsIdentifier(node: NodeLike, callee: IdentifierLike, sourceText: string): boolean {
  const arrow = unwrapParentheses(node, sourceText);
  if (!isArrowFunction(arrow)) return false;
  const parameter = singleArrowParameterIdentifier(arrow);
  if (!parameter) return false;
  const call = expressionCall(arrow.body, sourceText);
  if (!call || call.arguments.length !== 1) return false;
  const actualCallee = simpleCalleeIdentifier(call, sourceText);
  if (!actualCallee || actualCallee.text !== callee.text || !isSameIdentifier(call.arguments[0]!, parameter, sourceText)) return false;
  return true;
}

function isExactHeadPrepend(node: NodeLike, head: IdentifierLike, rest: IdentifierLike, sourceText: string): boolean {
  const text = normalize(nodeText(unwrapParentheses(node, sourceText), sourceText));
  const h = escapeRegExp(head.text);
  const r = escapeRegExp(rest.text);
  return new RegExp(`^\\[${h},\\.\\.\\.${r}\\]$`, "u").test(text);
}

function isEmptyArray(node: NodeLike, sourceText: string): boolean {
  const value = unwrapParentheses(node, sourceText);
  return isArrayLiteralExpression(value) && value.elements.length === 0;
}

function callArgumentsMatchText(call: CallExpressionLike, expected: readonly string[], sourceText: string): boolean {
  if (call.arguments.length !== expected.length) return false;
  return call.arguments.every((argument, index) => normalize(nodeText(argument, sourceText)) === normalize(expected[index] ?? ""));
}

function isExactAccumTuple(node: NodeLike, acc: IdentifierLike, pair: IdentifierLike, sourceText: string): boolean {
  const value = unwrapParentheses(node, sourceText);
  if (!isArrayLiteralExpression(value) || value.elements.length !== 2) return false;
  const first = value.elements[0];
  const second = value.elements[1];
  if (!first || !second) return false;
  if (normalize(nodeText(first, sourceText)) !== `${pair.text}[0]`) return false;
  const secondText = normalize(nodeText(second, sourceText));
  return secondText === `[...${acc.text}[1],${pair.text}[1]]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
