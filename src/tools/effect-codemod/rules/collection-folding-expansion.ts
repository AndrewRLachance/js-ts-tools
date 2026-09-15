import type { EffectConversionRule, RuleDecision } from "../contracts/rule";
import type { SemanticFact } from "../contracts/semantics";
import type { SyntaxCandidate } from "../contracts/source";
import {
  type ArrowFunctionLike,
  type CallExpressionLike,
  type IdentifierLike,
  type NodeLike,
  type ParameterLike,
  callCalleeIsTypeScriptLibFunction,
  callResultIsEffect,
  candidateCallExpression,
  effectCallMatches,
  effectModuleCallMatches,
  expressionCall,
  hasOnlyObjectProperties,
  hasSimpleArrowParameters,
  isArrayLiteralExpression,
  isArrowFunction,
  isBooleanLiteralExpression,
  isConditionalExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSameIdentifier,
  nodeText,
  objectPropertyInitializer,
  singleArrowParameterIdentifier,
  unwrapParentheses,
  uniqueCallSiteForNode,
} from "../core/ts-syntax";
import { convert, proveOuterEffectCall, rewriteWholeCandidate, skip } from "./effect-compositions";

export const headFromFlatMapOptionFromIterableRule: EffectConversionRule = {
  id: "effect.head.from-flatMap-option-fromIterable",
  target: "head",
  description: "Rewrite Effect.flatMap(self, values => Option.fromIterable(values)) to Effect.head.",
  selectors: [{ id: "effect.head.from-flatMap-option-fromIterable.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have exactly two arguments.", outer.value.evidence);
    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) return skip("Head source must use an arrow flatMap callback.", outer.value.evidence);
    const values = singleArrowParameterIdentifier(mapper);
    if (!values) return skip("Head callback must have one simple iterable parameter.", outer.value.evidence);
    const fromIterable = expressionCall(mapper.body, context.sourceText);
    if (!fromIterable || fromIterable.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, fromIterable, "Option", "fromIterable")) {
      return skip("Head callback must directly return Option.fromIterable(values).", outer.value.evidence);
    }
    const input = fromIterable.arguments[0];
    if (!input || !isSameIdentifier(input, values, context.sourceText)) {
      return skip("Option.fromIterable must consume the flatMap value unchanged.", outer.value.evidence);
    }
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.head(${nodeText(self, context.sourceText)})`,
      "Option.fromIterable is an Effect-compatible first-element lookup with the same empty-collection failure as Effect.head.");
  },
  rewrite: rewriteWholeCandidate,
};

export const reduceFromArrayReduceRule: EffectConversionRule = {
  id: "effect.reduce.from-array-reduce-flatMap",
  target: "reduce",
  description: "Rewrite the canonical sequential Array.reduce + Effect.flatMap lowering to Effect.reduce.",
  selectors: [{ id: "effect.reduce.from-array-reduce-flatMap.call", tsquery: 'CallExpression[expression.name.text="reduce"]' }],
  analyze(candidate, context) {
    const outer = proveNativeEffectReturningCall(candidate, context, "reduce");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Native reduce must have reducer and initial Effect arguments.", outer.value.evidence);
    const source = arrayFromIterableReceiver(outer.value.call, candidate.filePath, context);
    if (!source) return skip("Native reduce receiver must be proven Array.fromIterable(elements).", outer.value.evidence);
    const [reducer, initialEffect] = outer.value.call.arguments;
    if (!reducer || !initialEffect || !isArrowFunction(reducer) || !hasSimpleArrowParameters(reducer, 3)
      || reducer.parameters.length < 2) {
      return skip("Native reducer must be a simple (acc, element[, index]) arrow.", outer.value.evidence);
    }
    const acc = parameterIdentifier(reducer.parameters[0]);
    const element = parameterIdentifier(reducer.parameters[1]);
    if (!acc || !element) return skip("Native reducer accumulator and element must be identifiers.", outer.value.evidence);
    const flatMap = expressionCall(reducer.body, context.sourceText);
    if (!flatMap || flatMap.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, flatMap, "flatMap")
      || !callResultIsEffect(context.semantics, candidate.filePath, flatMap)) {
      return skip("Native reducer body must directly call Effect.flatMap(acc, ...).", outer.value.evidence);
    }
    const [flatSource, accumulatorMapper] = flatMap.arguments;
    if (!flatSource || !accumulatorMapper || !isSameIdentifier(flatSource, acc, context.sourceText)
      || !isArrowFunction(accumulatorMapper)) {
      return skip("Effect.flatMap must consume the native accumulator Effect.", outer.value.evidence);
    }
    const state = singleArrowParameterIdentifier(accumulatorMapper);
    if (!state) return skip("Accumulator flatMap callback must have one simple state parameter.", outer.value.evidence);
    if (textReferencesIdentifier(nodeText(accumulatorMapper.body, context.sourceText), acc.text)) {
      return skip("Reducer body still references the wrapped accumulator Effect.", outer.value.evidence);
    }
    const zero = unwrapSucceedInitial(initialEffect, candidate.filePath, context);
    if (!zero) return skip("Native reduce initial value must be proven Effect.succeed(zero).", outer.value.evidence);
    const effectReducer = renderArrow(
      [stateParameter(accumulatorMapper), reducer.parameters[1]!, ...(reducer.parameters[2] ? [reducer.parameters[2]] : [])],
      accumulatorMapper.body,
      context.sourceText,
    );
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.reduce(${nodeText(source, context.sourceText)}, ${zero}, ${effectReducer})`,
      "Matches Effect v3's sequential reduce lowering: Array.fromIterable(...).reduce(flatMap accumulator, Effect.succeed(zero)).");
  },
  rewrite: rewriteWholeCandidate,
};

export const reduceRightFromArrayReduceRightRule: EffectConversionRule = {
  id: "effect.reduceRight.from-array-reduceRight-flatMap",
  target: "reduceRight",
  description: "Rewrite the canonical sequential Array.reduceRight + Effect.flatMap lowering to Effect.reduceRight.",
  selectors: [{ id: "effect.reduceRight.from-array-reduceRight-flatMap.call", tsquery: 'CallExpression[expression.name.text="reduceRight"]' }],
  analyze(candidate, context) {
    const outer = proveNativeEffectReturningCall(candidate, context, "reduceRight");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Native reduceRight must have reducer and initial Effect arguments.", outer.value.evidence);
    const source = arrayFromIterableReceiver(outer.value.call, candidate.filePath, context);
    if (!source) return skip("Native reduceRight receiver must be proven Array.fromIterable(elements).", outer.value.evidence);
    const [reducer, initialEffect] = outer.value.call.arguments;
    if (!reducer || !initialEffect || !isArrowFunction(reducer) || !hasSimpleArrowParameters(reducer, 3)
      || reducer.parameters.length < 2) {
      return skip("Native reduceRight reducer must be a simple (acc, element[, index]) arrow.", outer.value.evidence);
    }
    const acc = parameterIdentifier(reducer.parameters[0]);
    const element = parameterIdentifier(reducer.parameters[1]);
    if (!acc || !element) return skip("Native reduceRight parameters must be identifiers.", outer.value.evidence);
    const flatMap = expressionCall(reducer.body, context.sourceText);
    if (!flatMap || flatMap.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, flatMap, "flatMap")
      || !callResultIsEffect(context.semantics, candidate.filePath, flatMap)) {
      return skip("Native reduceRight body must directly call Effect.flatMap(acc, ...).", outer.value.evidence);
    }
    const [flatSource, accumulatorMapper] = flatMap.arguments;
    if (!flatSource || !accumulatorMapper || !isSameIdentifier(flatSource, acc, context.sourceText)
      || !isArrowFunction(accumulatorMapper)) {
      return skip("Effect.flatMap must consume the native accumulator Effect.", outer.value.evidence);
    }
    const state = singleArrowParameterIdentifier(accumulatorMapper);
    if (!state || textReferencesIdentifier(nodeText(accumulatorMapper.body, context.sourceText), acc.text)) {
      return skip("Accumulator callback must use only the unwrapped state.", outer.value.evidence);
    }
    const zero = unwrapSucceedInitial(initialEffect, candidate.filePath, context);
    if (!zero) return skip("Native reduceRight initial value must be proven Effect.succeed(zero).", outer.value.evidence);
    const effectReducer = renderArrow(
      [reducer.parameters[1]!, stateParameter(accumulatorMapper), ...(reducer.parameters[2] ? [reducer.parameters[2]] : [])],
      accumulatorMapper.body,
      context.sourceText,
    );
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.reduceRight(${nodeText(source, context.sourceText)}, ${zero}, ${effectReducer})`,
      "Matches Effect v3's right-to-left reduce lowering.");
  },
  rewrite: rewriteWholeCandidate,
};

export const reduceEffectFromArrayReduceZipWithRule: EffectConversionRule = {
  id: "effect.reduceEffect.from-array-reduce-zipWith",
  target: "reduceEffect",
  description: "Rewrite the sequential Array.reduce + Effect.zipWith lowering to Effect.reduceEffect.",
  selectors: [{ id: "effect.reduceEffect.from-array-reduce-zipWith.call", tsquery: 'CallExpression[expression.name.text="reduce"]' }],
  analyze(candidate, context) {
    const outer = proveNativeEffectReturningCall(candidate, context, "reduce");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Native reduce must have reducer and initial Effect arguments.", outer.value.evidence);
    const source = arrayFromIterableReceiver(outer.value.call, candidate.filePath, context);
    if (!source) return skip("reduceEffect source must begin with proven Array.fromIterable(effects).", outer.value.evidence);
    const [reducer, zero] = outer.value.call.arguments;
    if (zero && unwrapSucceedInitial(zero, candidate.filePath, context) !== undefined) {
      return skip("Effect.succeed(zero) specialization is handled by the mergeAll rule.", outer.value.evidence);
    }
    if (!reducer || !zero || !isArrowFunction(reducer) || !hasSimpleArrowParameters(reducer, 3)
      || reducer.parameters.length < 2) {
      return skip("reduceEffect lowering requires a simple (acc, effect[, index]) reducer.", outer.value.evidence);
    }
    const acc = parameterIdentifier(reducer.parameters[0]);
    const effectValue = parameterIdentifier(reducer.parameters[1]);
    if (!acc || !effectValue) return skip("reduceEffect reducer parameters must be identifiers.", outer.value.evidence);
    const zipWith = expressionCall(reducer.body, context.sourceText);
    if (!zipWith || zipWith.arguments.length !== 3
      || !effectCallMatches(context.semantics, candidate.filePath, zipWith, "zipWith")
      || !callResultIsEffect(context.semantics, candidate.filePath, zipWith)) {
      return skip("Reducer body must directly call Effect.zipWith(acc, effect, combiner).", outer.value.evidence);
    }
    const [left, right, combiner] = zipWith.arguments;
    if (!left || !right || !combiner || !isSameIdentifier(left, acc, context.sourceText)
      || !isSameIdentifier(right, effectValue, context.sourceText) || !isArrowFunction(combiner)
      || !hasSimpleArrowParameters(combiner, 2) || combiner.parameters.length !== 2) {
      return skip("Effect.zipWith must combine the accumulator and current effect with a pure two-argument arrow.", outer.value.evidence);
    }
    const state = parameterIdentifier(combiner.parameters[0]);
    const value = parameterIdentifier(combiner.parameters[1]);
    if (!state || !value) return skip("zipWith combiner parameters must be identifiers.", outer.value.evidence);
    const bodyText = nodeText(combiner.body, context.sourceText);
    if (textReferencesIdentifier(bodyText, acc.text) || textReferencesIdentifier(bodyText, effectValue.text)) {
      return skip("Pure combiner must not reference wrapped Effect values.", outer.value.evidence);
    }
    const pureReducer = renderArrow(
      [combiner.parameters[0]!, combiner.parameters[1]!, ...(reducer.parameters[2] ? [reducer.parameters[2]] : [])],
      combiner.body,
      context.sourceText,
    );
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.reduceEffect(${nodeText(source, context.sourceText)}, ${nodeText(zero, context.sourceText)}, ${pureReducer})`,
      "Matches Effect v3's default sequential reduceEffect lowering via Array.fromIterable(...).reduce(Effect.zipWith, zero)."
    );
  },
  rewrite: rewriteWholeCandidate,
};

export const findFirstFromReduceWhileOptionRule: EffectConversionRule = {
  id: "effect.findFirst.from-reduceWhile-option",
  target: "findFirst",
  description: "Rewrite an Option-state reduceWhile search over a materialized Array to Effect.findFirst.",
  selectors: [{ id: "effect.findFirst.from-reduceWhile-option.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="reduceWhile"]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "reduceWhile");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 3) return skip("Effect.reduceWhile must have elements, zero and options.", outer.value.evidence);
    const [elementsNode, zeroNode, optionsNode] = outer.value.call.arguments;
    if (!elementsNode || !zeroNode || !optionsNode) return skip("reduceWhile arguments are incomplete.", outer.value.evidence);
    const materialized = expressionCall(elementsNode, context.sourceText);
    if (!materialized || materialized.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, materialized, "Array", "fromIterable")) {
      return skip("Safe findFirst conversion requires Array.fromIterable(elements) materialization.", outer.value.evidence);
    }
    const none = expressionCall(zeroNode, context.sourceText);
    if (!none || none.arguments.length !== 0
      || !effectModuleCallMatches(context.semantics, candidate.filePath, none, "Option", "none")) {
      return skip("reduceWhile zero must be Option.none().", outer.value.evidence);
    }
    const options = unwrapParentheses(optionsNode, context.sourceText);
    if (!isObjectLiteralExpression(options) || !hasOnlyObjectProperties(options, ["while", "body"], context.sourceText)) {
      return skip("reduceWhile options must contain only while and body.", outer.value.evidence);
    }
    const whileFn = objectPropertyInitializer(options, "while", context.sourceText);
    const body = objectPropertyInitializer(options, "body", context.sourceText);
    if (!whileFn || !body || !isArrowFunction(whileFn) || !isArrowFunction(body)
      || !hasSimpleArrowParameters(body, 3) || body.parameters.length < 2) {
      return skip("findFirst lowering requires simple while/body arrows.", outer.value.evidence);
    }
    const optionState = singleArrowParameterIdentifier(whileFn);
    if (!optionState) return skip("while callback must have one Option state parameter.", outer.value.evidence);
    const isNone = expressionCall(whileFn.body, context.sourceText);
    if (!isNone || isNone.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, isNone, "Option", "isNone")
      || !isSameIdentifier(isNone.arguments[0]!, optionState, context.sourceText)) {
      return skip("while callback must be Option.isNone(state).", outer.value.evidence);
    }
    const bodyState = parameterIdentifier(body.parameters[0]);
    const item = parameterIdentifier(body.parameters[1]);
    if (!bodyState || !item) return skip("body state/item parameters must be identifiers.", outer.value.evidence);
    const mappedPredicate = expressionCall(body.body, context.sourceText);
    if (!mappedPredicate || mappedPredicate.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, mappedPredicate, "map")
      || !callResultIsEffect(context.semantics, candidate.filePath, mappedPredicate)) {
      return skip("body must map an effectful predicate.", outer.value.evidence);
    }
    const [predicateEffect, resultMapper] = mappedPredicate.arguments;
    if (!predicateEffect || !resultMapper || !isArrowFunction(resultMapper)) return skip("Predicate mapping is incomplete.", outer.value.evidence);
    const matched = singleArrowParameterIdentifier(resultMapper);
    if (!matched) return skip("Predicate result mapper must have one boolean parameter.", outer.value.evidence);
    const conditional = unwrapParentheses(resultMapper.body, context.sourceText);
    if (!isConditionalExpression(conditional) || !isSameIdentifier(conditional.condition, matched, context.sourceText)) {
      return skip("Predicate result mapper must branch directly on the boolean result.", outer.value.evidence);
    }
    const some = expressionCall(conditional.whenTrue, context.sourceText);
    if (!some || some.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, some, "Option", "some")
      || !isSameIdentifier(some.arguments[0]!, item, context.sourceText)
      || !isSameIdentifier(conditional.whenFalse, bodyState, context.sourceText)) {
      return skip("Predicate result must be matched ? Option.some(item) : state.", outer.value.evidence);
    }
    if (textReferencesIdentifier(nodeText(predicateEffect, context.sourceText), bodyState.text)) {
      return skip("findFirst predicate must not depend on the internal Option accumulator.", outer.value.evidence);
    }
    const predicate = renderArrow(body.parameters.slice(1), predicateEffect, context.sourceText);
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.findFirst(${nodeText(materialized, context.sourceText)}, ${predicate})`,
      "Option-state reduceWhile over a pre-materialized Array preserves the same effectful first-match search; the extra post-match iterator step is unobservable on the private Array copy.");
  },
  rewrite: rewriteWholeCandidate,
};

export const reduceWhileFromIterateStateRule: EffectConversionRule = {
  id: "effect.reduceWhile.from-iterate-array-state",
  target: "reduceWhile",
  description: "Rewrite an iterate state machine over a materialized Array to Effect.reduceWhile.",
  selectors: [{ id: "effect.reduceWhile.from-iterate-array-state.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]' }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "map");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Outer Effect.map must have source and state projection.", outer.value.evidence);
    const [sourceNode, projectionNode] = outer.value.call.arguments;
    if (!sourceNode || !projectionNode || !isArrowFunction(projectionNode)) return skip("reduceWhile lowering requires an arrow state projection.", outer.value.evidence);
    const projected = singleArrowParameterIdentifier(projectionNode);
    if (!projected || normalize(nodeText(projectionNode.body, context.sourceText)) !== `${projected.text}.state`) {
      return skip("Outer mapper must project result.state exactly.", outer.value.evidence);
    }
    const iterate = expressionCall(sourceNode, context.sourceText);
    if (!iterate || iterate.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, iterate, "iterate")
      || !callResultIsEffect(context.semantics, candidate.filePath, iterate)) {
      return skip("Source must be Effect.iterate(initialState, options).", outer.value.evidence);
    }
    const [initialNode, optionsNode] = iterate.arguments;
    const initial = initialNode ? unwrapParentheses(initialNode, context.sourceText) : undefined;
    const options = optionsNode ? unwrapParentheses(optionsNode, context.sourceText) : undefined;
    if (!initial || !options || !isObjectLiteralExpression(initial) || !isObjectLiteralExpression(options)
      || !hasOnlyObjectProperties(initial, ["values", "index", "state"], context.sourceText)
      || !hasOnlyObjectProperties(options, ["while", "body"], context.sourceText)) {
      return skip("iterate lowering requires exact { values, index, state } and { while, body } objects.", outer.value.evidence);
    }
    const valuesNode = objectPropertyInitializer(initial, "values", context.sourceText);
    const indexNode = objectPropertyInitializer(initial, "index", context.sourceText);
    const zero = objectPropertyInitializer(initial, "state", context.sourceText);
    if (!valuesNode || !indexNode || !zero || normalize(nodeText(indexNode, context.sourceText)) !== "0") {
      return skip("iterate initial state must start at index 0.", outer.value.evidence);
    }
    const values = expressionCall(valuesNode, context.sourceText);
    if (!values || values.arguments.length !== 1
      || !effectModuleCallMatches(context.semantics, candidate.filePath, values, "Array", "fromIterable")) {
      return skip("iterate values must be a private Array.fromIterable(elements) copy.", outer.value.evidence);
    }
    const whileFn = objectPropertyInitializer(options, "while", context.sourceText);
    const bodyFn = objectPropertyInitializer(options, "body", context.sourceText);
    if (!whileFn || !bodyFn || !isArrowFunction(whileFn) || !isArrowFunction(bodyFn)) {
      return skip("iterate while/body must be arrows.", outer.value.evidence);
    }
    const cursor = singleArrowParameterIdentifier(whileFn);
    const bodyCursor = singleArrowParameterIdentifier(bodyFn);
    if (!cursor || !bodyCursor || cursor.text !== bodyCursor.text) {
      return skip("iterate while/body must use the same simple cursor name.", outer.value.evidence);
    }
    const whileText = normalize(nodeText(whileFn.body, context.sourceText));
    const prefix = `${cursor.text}.index<${cursor.text}.values.length&&`;
    if (!whileText.startsWith(prefix)) return skip("iterate while must guard index < values.length before the reduction predicate.", outer.value.evidence);
    const predicateText = whileText.slice(prefix.length);
    const rewrittenPredicate = rewriteCursorStateExpression(predicateText, cursor.text, "state");
    if (!rewrittenPredicate) return skip("Reduction while predicate may only depend on cursor.state.", outer.value.evidence);

    const bodyMap = expressionCall(bodyFn.body, context.sourceText);
    if (!bodyMap || bodyMap.arguments.length !== 2
      || !effectCallMatches(context.semantics, candidate.filePath, bodyMap, "map")
      || !callResultIsEffect(context.semantics, candidate.filePath, bodyMap)) {
      return skip("iterate body must map the reduction body Effect into the next cursor.", outer.value.evidence);
    }
    const [bodyEffect, nextMapper] = bodyMap.arguments;
    if (!bodyEffect || !nextMapper || !isArrowFunction(nextMapper)) return skip("iterate body map is incomplete.", outer.value.evidence);
    const nextState = singleArrowParameterIdentifier(nextMapper);
    if (!nextState) return skip("next cursor mapper must have one state parameter.", outer.value.evidence);
    const nextCursor = unwrapParentheses(nextMapper.body, context.sourceText);
    if (!isObjectLiteralExpression(nextCursor) || !hasOnlyObjectProperties(nextCursor, ["values", "index", "state"], context.sourceText)) {
      return skip("next cursor must preserve { values, index, state }.", outer.value.evidence);
    }
    const nextValues = objectPropertyInitializer(nextCursor, "values", context.sourceText);
    const nextIndex = objectPropertyInitializer(nextCursor, "index", context.sourceText);
    const nextStateValue = objectPropertyInitializer(nextCursor, "state", context.sourceText);
    if (!nextValues || !nextIndex || !nextStateValue
      || normalize(nodeText(nextValues, context.sourceText)) !== `${cursor.text}.values`
      || normalize(nodeText(nextIndex, context.sourceText)) !== `${cursor.text}.index+1`
      || !isSameIdentifier(nextStateValue, nextState, context.sourceText)) {
      return skip("next cursor must preserve values, increment index by one, and store mapped state.", outer.value.evidence);
    }
    const bodyText = normalize(nodeText(bodyEffect, context.sourceText));
    const rewrittenBody = rewriteReduceCursorBody(bodyText, cursor.text);
    if (!rewrittenBody) return skip("Reduction body may only reference cursor.state, cursor.values[cursor.index], and cursor.index.", outer.value.evidence);

    const targetWhile = `(state) => ${rewrittenPredicate}`;
    const targetBody = `(state, element, index) => ${rewrittenBody}`;
    return convert(this.id, this.target, candidate, outer.value.evidence,
      `__codemod_Effect__.reduceWhile(${nodeText(values, context.sourceText)}, ${nodeText(zero, context.sourceText)}, { while: ${targetWhile}, body: ${targetBody} })`,
      "The iterate state machine snapshots the iterable once, advances one index per successful body, and has the same recursive stop/body sequencing as Effect.reduceWhile.");
  },
  rewrite: rewriteWholeCandidate,
};

type TakeDropTarget = "takeWhile" | "dropWhile" | "takeUntil" | "dropUntil";
interface TakeDropShape {
  readonly target: TakeDropTarget;
  readonly initial: boolean;
  readonly predicateOnTrueBranch: boolean;
  readonly succeedFallback: boolean;
  readonly emitCondition: "next" | "state";
  readonly someWhenTrue: boolean;
}

const TAKE_DROP_SHAPES: Record<TakeDropTarget, TakeDropShape> = {
  takeWhile: { target: "takeWhile", initial: true, predicateOnTrueBranch: true, succeedFallback: false, emitCondition: "next", someWhenTrue: true },
  dropWhile: { target: "dropWhile", initial: true, predicateOnTrueBranch: true, succeedFallback: false, emitCondition: "next", someWhenTrue: false },
  takeUntil: { target: "takeUntil", initial: false, predicateOnTrueBranch: false, succeedFallback: true, emitCondition: "state", someWhenTrue: false },
  dropUntil: { target: "dropUntil", initial: false, predicateOnTrueBranch: false, succeedFallback: true, emitCondition: "state", someWhenTrue: true },
};

function takeDropRule(shape: TakeDropShape): EffectConversionRule {
  return {
    id: `effect.${shape.target}.from-mapAccum-options`,
    target: shape.target,
    description: `Rewrite a boolean-state Effect.mapAccum + Option compaction state machine to Effect.${shape.target}.`,
    selectors: [{ id: `effect.${shape.target}.from-mapAccum-options.call`, tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"][arguments.length=2]' }],
    analyze(candidate, context) {
      const outer = proveOuterEffectCall(candidate, context, "map");
      if (!outer.ok) return outer.decision;
      if (outer.value.call.arguments.length !== 2) return skip("Outer Effect.map must have mapAccum source and Option compaction mapper.", outer.value.evidence);
      const [sourceNode, compactNode] = outer.value.call.arguments;
      if (!sourceNode || !compactNode || !isArrowFunction(compactNode)) return skip("Option compaction must use an arrow mapper.", outer.value.evidence);
      const result = singleArrowParameterIdentifier(compactNode);
      if (!result) return skip("Option compaction mapper must have one tuple parameter.", outer.value.evidence);
      const getSomes = expressionCall(compactNode.body, context.sourceText);
      if (!getSomes || getSomes.arguments.length !== 1
        || !effectModuleCallMatches(context.semantics, candidate.filePath, getSomes, "Array", "getSomes")
        || normalize(nodeText(getSomes.arguments[0]!, context.sourceText)) !== `${result.text}[1]`) {
        return skip("Outer mapper must be result => Array.getSomes(result[1]).", outer.value.evidence);
      }
      const mapAccum = expressionCall(sourceNode, context.sourceText);
      if (!mapAccum || mapAccum.arguments.length !== 3
        || !effectCallMatches(context.semantics, candidate.filePath, mapAccum, "mapAccum")
        || !callResultIsEffect(context.semantics, candidate.filePath, mapAccum)) {
        return skip("Source must be Effect.mapAccum(elements, booleanState, reducer).", outer.value.evidence);
      }
      const [elements, initial, reducer] = mapAccum.arguments;
      if (!elements || !initial || !reducer || !isBooleanLiteralExpression(initial, shape.initial, context.sourceText)
        || !isArrowFunction(reducer) || !hasSimpleArrowParameters(reducer, 3) || reducer.parameters.length < 2) {
        return skip(`Effect.${shape.target} lowering requires initial ${shape.initial} and a simple state/item[/index] reducer.`, outer.value.evidence);
      }
      const state = parameterIdentifier(reducer.parameters[0]);
      const item = parameterIdentifier(reducer.parameters[1]);
      if (!state || !item) return skip("mapAccum state/item parameters must be identifiers.", outer.value.evidence);
      const mapped = expressionCall(reducer.body, context.sourceText);
      if (!mapped || mapped.arguments.length !== 2
        || !effectCallMatches(context.semantics, candidate.filePath, mapped, "map")
        || !callResultIsEffect(context.semantics, candidate.filePath, mapped)) {
        return skip("mapAccum reducer must directly Effect.map the next boolean state.", outer.value.evidence);
      }
      const [stateEffectNode, tupleMapper] = mapped.arguments;
      if (!stateEffectNode || !tupleMapper || !isArrowFunction(tupleMapper)) return skip("State Effect.map is incomplete.", outer.value.evidence);
      const stateConditional = unwrapParentheses(stateEffectNode, context.sourceText);
      if (!isConditionalExpression(stateConditional) || !isSameIdentifier(stateConditional.condition, state, context.sourceText)) {
        return skip("Boolean state effect must branch directly on the current state.", outer.value.evidence);
      }
      const predicateNode = shape.predicateOnTrueBranch ? stateConditional.whenTrue : stateConditional.whenFalse;
      const fallbackNode = shape.predicateOnTrueBranch ? stateConditional.whenFalse : stateConditional.whenTrue;
      const predicateEffect = expressionCall(predicateNode, context.sourceText);
      const fallback = expressionCall(fallbackNode, context.sourceText);
      if (!predicateEffect || !callResultIsEffect(context.semantics, candidate.filePath, predicateEffect)
        || !fallback || fallback.arguments.length !== 1
        || !effectCallMatches(context.semantics, candidate.filePath, fallback, "succeed")
        || !callResultIsEffect(context.semantics, candidate.filePath, fallback)
        || !isBooleanLiteralExpression(fallback.arguments[0]!, shape.succeedFallback, context.sourceText)) {
        return skip(`State branch must use an effectful predicate and Effect.succeed(${shape.succeedFallback}) fallback.`, outer.value.evidence);
      }
      if (textReferencesIdentifier(nodeText(predicateEffect, context.sourceText), state.text)) {
        return skip("Collection predicate must not depend on the internal boolean state.", outer.value.evidence);
      }
      const next = singleArrowParameterIdentifier(tupleMapper);
      if (!next) return skip("State mapper must have one next-state parameter.", outer.value.evidence);
      const tuple = unwrapParentheses(tupleMapper.body, context.sourceText);
      if (!isArrayLiteralExpression(tuple) || tuple.elements.length !== 2 || !isSameIdentifier(tuple.elements[0]!, next, context.sourceText)) {
        return skip("State mapper must return [nextState, emittedOption].", outer.value.evidence);
      }
      const emitted = unwrapParentheses(tuple.elements[1]!, context.sourceText);
      if (!isConditionalExpression(emitted)) return skip("Emitted Option must be a conditional expression.", outer.value.evidence);
      const expectedCondition = shape.emitCondition === "next" ? next : state;
      if (!isSameIdentifier(emitted.condition, expectedCondition, context.sourceText)) {
        return skip(`Emitted Option condition must be the ${shape.emitCondition} boolean state.`, outer.value.evidence);
      }
      const someBranch = shape.someWhenTrue ? emitted.whenTrue : emitted.whenFalse;
      const noneBranch = shape.someWhenTrue ? emitted.whenFalse : emitted.whenTrue;
      const some = expressionCall(someBranch, context.sourceText);
      const none = expressionCall(noneBranch, context.sourceText);
      if (!some || some.arguments.length !== 1 || !isSameIdentifier(some.arguments[0]!, item, context.sourceText)
        || !effectModuleCallMatches(context.semantics, candidate.filePath, some, "Option", "some")
        || !none || none.arguments.length !== 0
        || !effectModuleCallMatches(context.semantics, candidate.filePath, none, "Option", "none")) {
        return skip("Emitted branches must be the expected Option.some(item) / Option.none() pair.", outer.value.evidence);
      }
      const predicate = renderArrow(reducer.parameters.slice(1), predicateEffect, context.sourceText);
      return convert(this.id, this.target, candidate, outer.value.evidence,
        `__codemod_Effect__.${shape.target}(${nodeText(elements, context.sourceText)}, ${predicate})`,
        `Boolean-state mapAccum plus Option compaction has the same predicate gating and retained-prefix/suffix semantics as Effect.${shape.target}.`);
    },
    rewrite: rewriteWholeCandidate,
  };
}

export const takeWhileFromMapAccumRule = takeDropRule(TAKE_DROP_SHAPES.takeWhile);
export const dropWhileFromMapAccumRule = takeDropRule(TAKE_DROP_SHAPES.dropWhile);
export const takeUntilFromMapAccumRule = takeDropRule(TAKE_DROP_SHAPES.takeUntil);
export const dropUntilFromMapAccumRule = takeDropRule(TAKE_DROP_SHAPES.dropUntil);

export const COLLECTION_FOLDING_EXPANSION_RULES: readonly EffectConversionRule[] = [
  findFirstFromReduceWhileOptionRule,
  headFromFlatMapOptionFromIterableRule,
  reduceFromArrayReduceRule,
  reduceEffectFromArrayReduceZipWithRule,
  reduceRightFromArrayReduceRightRule,
  reduceWhileFromIterateStateRule,
  takeWhileFromMapAccumRule,
  dropWhileFromMapAccumRule,
  takeUntilFromMapAccumRule,
  dropUntilFromMapAccumRule,
];

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
  // A chained native call can share its TypeModel start location with its
  // receiver call. Select the call site by the AST callee name instead of
  // requiring the candidate location to contain only one call site.
  const callSite = uniqueCallSiteForNode(context.semantics, candidate.filePath, call);
  if (!callSite) {
    return { ok: false, decision: skip(`Native ${expectedName} call site is missing or ambiguous.`, evidenceBase) };
  }
  if (!callCalleeIsTypeScriptLibFunction(context.semantics, candidate.filePath, call, expectedName)) {
    return { ok: false, decision: skip(`Callee is not proven TypeScript lib ${expectedName}.`, evidenceBase) };
  }
  if (!model.callSiteResultIsEffect(callSite)) {
    return { ok: false, decision: skip(`Native ${expectedName} result is not proven to be an Effect.`, evidenceBase) };
  }
  const evidence: SemanticFact[] = [
    ...evidenceBase,
    { kind: "binding", summary: `Resolved callee is TypeScript lib ${expectedName}.`, data: callSite.calleeSymbolId },
    { kind: "type", summary: "Resolved native reduction result is an Effect type.", data: callSite.resultTypeId },
  ];
  return { ok: true, value: { call, evidence } };
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

function stateParameter(arrow: ArrowFunctionLike): ParameterLike {
  const parameter = arrow.parameters[0];
  if (!parameter) throw new Error("Expected state parameter.");
  return parameter;
}

function renderArrow(parameters: readonly ParameterLike[], body: NodeLike, sourceText: string): string {
  const params = parameters.map((parameter) => nodeText(parameter, sourceText)).join(", ");
  return `(${params}) => ${nodeText(body, sourceText)}`;
}

function textReferencesIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "u").test(text);
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, "");
}

function rewriteCursorStateExpression(text: string, cursor: string, replacement: string): string | undefined {
  const escaped = cursor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const rewritten = text.replace(new RegExp(`${escaped}\\.state`, "gu"), replacement);
  return textReferencesIdentifier(rewritten, cursor) ? undefined : rewritten;
}

function rewriteReduceCursorBody(text: string, cursor: string): string | undefined {
  const escaped = cursor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  let rewritten = text.replace(new RegExp(`${escaped}\\.values\\[${escaped}\\.index\\]`, "gu"), "element");
  rewritten = rewritten.replace(new RegExp(`${escaped}\\.state`, "gu"), "state");
  rewritten = rewritten.replace(new RegExp(`${escaped}\\.index`, "gu"), "index");
  return textReferencesIdentifier(rewritten, cursor) ? undefined : rewritten;
}
