import type { EffectTarget } from "../contracts/effect-target";
import * as ts from "typescript";
import type {
  ConversionMatch,
  EffectConversionRule,
  RuleContext,
  RuleDecision,
} from "../contracts/rule";
import type { SemanticFact } from "../contracts/semantics";
import type { SyntaxCandidate } from "../contracts/source";
import { requireSingleExactCallSite } from "../core/semantic-guards";
import {
  arrowWithBodyText,
  type CallExpressionLike,
  callCalleeIsTypeScriptLibFunction,
  callResultIsEffect,
  candidateCallExpression,
  effectCallMatches,
  effectModuleCallMatches,
  effectNamespaceText,
  expressionCall,
  isArrayLiteralExpression,
  isArrowFunction,
  isConditionalExpression,
  isFunctionExpression,
  isOmittedExpression,
  isPropertyAccessExpression,
  isSameIdentifier,
  nodeText,
  singleArrowParameterIdentifier,
  unwrapParentheses,
} from "../core/ts-syntax";

interface RewriteMetadata {
  readonly replacementText: string;
}

export interface ProvenOuterCall {
  readonly call: CallExpressionLike;
  readonly evidence: readonly SemanticFact[];
  readonly dataLast: boolean;
}

export const mapFromFlatMapSucceedRule: EffectConversionRule = {
  id: "effect.map.from-flatMap-succeed",
  target: "map",
  description: "Rewrite Effect.flatMap(self, a => Effect.succeed(f(a))) to Effect.map.",
  selectors: [{
    id: "effect.map.from-flatMap-succeed.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap", true);
    if (!outer.ok) return outer.decision;
    const { dataLast } = outer.value;
    if (outer.value.call.arguments.length !== (dataLast ? 1 : 2)) return skip("Effect.flatMap must have exactly two arguments.", outer.value.evidence);

    const self = dataLast ? undefined : outer.value.call.arguments[0];
    const mapper = outer.value.call.arguments[dataLast ? 0 : 1];
    if (!mapper || !isArrowFunction(mapper)) {
      return skip("Effect.flatMap requires an arrow callback.", outer.value.evidence);
    }
    const succeed = expressionCall(mapper.body, context.sourceText);
    if (!succeed || ((!context.analysis || context.analysis.operator(succeed as ts.CallExpression) === "succeed") && succeed.arguments.length !== 1)) {
      return skip("The flatMap callback must directly return Effect.succeed(value).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)) {
      if (context.analysis && context.analysis.effectResult(succeed as ts.CallExpression)) {
        const helper = context.analysis.helperResult(succeed as ts.CallExpression);
        if (helper.kind === "resolved" && helper.operator === "succeed") {
          const value = { ...succeed, renderedText: helper.value };
          return convert(this.id, this.target, candidate, [...outer.value.evidence, { kind: "custom", summary: `Resolved bounded helper chain: ${helper.helpers.join(" -> ")}` }], `__codemod_Effect__.map(${self ? `${nodeText(self, context.sourceText)}, ` : ""}${arrowWithBodyText(mapper, value, context.sourceText)})`, "Helper expansion preserves inert argument evaluation and the original success value.");
        }
        if (helper.kind !== "resolved") return skip(helper.reason, outer.value.evidence);
      }
      return skip("Nested callback result is not proven to be Effect.succeed.", outer.value.evidence);
    }

    const value = succeed.arguments[0];
    if (!value) return skip("Effect.succeed value is missing.", outer.value.evidence);
    const replacementText = `__codemod_Effect__.map(${self ? `${nodeText(self, context.sourceText)}, ` : ""}${arrowWithBodyText(mapper, value, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Proven flatMap+succeed equivalence.");
  },
  rewrite: rewriteWholeCandidate,
};

export const mapErrorFromCatchAllFailRule: EffectConversionRule = {
  id: "effect.mapError.from-catchAll-fail",
  target: "mapError",
  description: "Rewrite Effect.catchAll(self, e => Effect.fail(f(e))) to Effect.mapError.",
  selectors: [{
    id: "effect.mapError.from-catchAll-fail.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="catchAll"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "catchAll", true);
    if (!outer.ok) return outer.decision;
    const { dataLast } = outer.value;
    if (outer.value.call.arguments.length !== (dataLast ? 1 : 2)) return skip("Effect.catchAll must have exactly two arguments.", outer.value.evidence);

    const self = dataLast ? undefined : outer.value.call.arguments[0];
    const mapper = outer.value.call.arguments[dataLast ? 0 : 1];
    if (!mapper || !isArrowFunction(mapper)) {
      return skip("Effect.catchAll requires an arrow callback.", outer.value.evidence);
    }
    const fail = expressionCall(mapper.body, context.sourceText);
    if (!fail || ((!context.analysis || context.analysis.operator(fail as ts.CallExpression) === "fail") && fail.arguments.length !== 1)) {
      return skip("The catchAll callback must directly return Effect.fail(error).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, fail, "fail")
      || !callResultIsEffect(context.semantics, candidate.filePath, fail)) {
      if (context.analysis && context.analysis.effectResult(fail as ts.CallExpression)) {
        const helper = context.analysis.helperResult(fail as ts.CallExpression);
        if (helper.kind === "resolved" && helper.operator === "fail") {
          const value = { ...fail, renderedText: helper.value };
          return convert(this.id, this.target, candidate, [...outer.value.evidence, { kind: "custom", summary: `Resolved bounded helper chain: ${helper.helpers.join(" -> ")}` }], `__codemod_Effect__.mapError(${self ? `${nodeText(self, context.sourceText)}, ` : ""}${arrowWithBodyText(mapper, value, context.sourceText)})`, "Helper expansion preserves inert argument evaluation and the original failure value.");
        }
        if (helper.kind !== "resolved") return skip(helper.reason, outer.value.evidence);
      }
      return skip("Nested callback result is not proven to be Effect.fail.", outer.value.evidence);
    }

    const error = fail.arguments[0];
    if (!error) return skip("Effect.fail error expression is missing.", outer.value.evidence);
    const replacementText = `__codemod_Effect__.mapError(${self ? `${nodeText(self, context.sourceText)}, ` : ""}${arrowWithBodyText(mapper, error, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Proven catchAll+fail equivalence.");
  },
  rewrite: rewriteWholeCandidate,
};

export const filterOrFailFromFlatMapRule: EffectConversionRule = {
  id: "effect.filterOrFail.from-flatMap-conditional",
  target: "filterOrFail",
  description: "Rewrite flatMap success/fail conditional validation to Effect.filterOrFail.",
  selectors: [{
    id: "effect.filterOrFail.from-flatMap-conditional.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="flatMap"][arguments.length=2]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "flatMap");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) return skip("Effect.flatMap must have exactly two arguments.", outer.value.evidence);

    const [self, mapper] = outer.value.call.arguments;
    if (!self || !mapper || !isArrowFunction(mapper)) {
      return skip("Only data-first Effect.flatMap with an arrow callback is supported.", outer.value.evidence);
    }
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter) return skip("Validation callback must have one simple identifier parameter.", outer.value.evidence);

    const body = unwrapParentheses(mapper.body, context.sourceText);
    if (!isConditionalExpression(body)) {
      return skip("Validation callback body must be a conditional expression.", outer.value.evidence);
    }

    const succeed = expressionCall(body.whenTrue, context.sourceText);
    const fail = expressionCall(body.whenFalse, context.sourceText);
    if (!succeed || !fail || succeed.arguments.length !== 1 || fail.arguments.length !== 1) {
      return skip("Conditional branches must be Effect.succeed(value) and Effect.fail(error).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, succeed, "succeed")
      || !effectCallMatches(context.semantics, candidate.filePath, fail, "fail")
      || !callResultIsEffect(context.semantics, candidate.filePath, succeed)
      || !callResultIsEffect(context.semantics, candidate.filePath, fail)) {
      return skip("Conditional branches are not proven Effect.succeed / Effect.fail calls.", outer.value.evidence);
    }

    const successValue = succeed.arguments[0];
    const errorValue = fail.arguments[0];
    if (!successValue || !errorValue || !isSameIdentifier(successValue, parameter, context.sourceText)) {
      return skip("Success branch must preserve the callback parameter unchanged.", outer.value.evidence);
    }

    const predicate = arrowWithBodyText(mapper, body.condition, context.sourceText);
    const onFailure = arrowWithBodyText(mapper, errorValue, context.sourceText);
    const replacementText = `__codemod_Effect__.filterOrFail(${nodeText(self, context.sourceText)}, ${predicate}, ${onFailure})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Proven validation flatMap equivalence.");
  },
  rewrite: rewriteWholeCandidate,
};

export const allFromIdentityForEachRule: EffectConversionRule = {
  id: "effect.all.from-forEach-identity",
  target: "all",
  description: "Rewrite Effect.forEach(effects, effect => effect) to Effect.all(effects).",
  selectors: [{
    id: "effect.all.from-forEach-identity.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="forEach"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "forEach");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 2) {
      return skip("Only option-free Effect.forEach is equivalent to default Effect.all.", outer.value.evidence);
    }

    const [effects, mapper] = outer.value.call.arguments;
    if (!effects || !mapper || !isArrowFunction(mapper)) {
      return skip("Effect.forEach callback must be an identity arrow.", outer.value.evidence);
    }
    const parameter = singleArrowParameterIdentifier(mapper);
    if (!parameter || !isSameIdentifier(mapper.body, parameter, context.sourceText)) {
      return skip("Effect.forEach callback is not the identity function.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.all(${nodeText(effects, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Identity traversal is equivalent to collecting the effects.");
  },
  rewrite: rewriteWholeCandidate,
};

export const whenFromSuspendedConditionalRule: EffectConversionRule = {
  id: "effect.when.from-suspend-conditional",
  target: "when",
  description: "Rewrite a suspended Option conditional to Effect.when without changing evaluation timing.",
  selectors: [{
    id: "effect.when.from-suspend-conditional.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="suspend"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "suspend");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Effect.suspend must have one thunk argument.", outer.value.evidence);

    const thunk = outer.value.call.arguments[0];
    if (!thunk || !isArrowFunction(thunk) || thunk.parameters.length !== 0) {
      return skip("Effect.suspend thunk must be a zero-argument arrow.", outer.value.evidence);
    }
    const body = unwrapParentheses(thunk.body, context.sourceText);
    if (!isConditionalExpression(body)) return skip("Suspend thunk must contain a conditional expression.", outer.value.evidence);

    const asSome = expressionCall(body.whenTrue, context.sourceText);
    const falseSucceed = expressionCall(body.whenFalse, context.sourceText);
    if (!asSome || !falseSucceed || asSome.arguments.length !== 1 || falseSucceed.arguments.length !== 1) {
      return skip("Conditional must produce Effect.asSome(effect) or Effect.succeed(Option.none()).", outer.value.evidence);
    }
    if (!effectCallMatches(context.semantics, candidate.filePath, asSome, "asSome")
      || !effectCallMatches(context.semantics, candidate.filePath, falseSucceed, "succeed")) {
      return skip("Conditional branches are not proven Effect.asSome / Effect.succeed calls.", outer.value.evidence);
    }

    const deferredEffect = expressionCall(asSome.arguments[0]!, context.sourceText);
    if (!deferredEffect || !effectCallMatches(context.semantics, candidate.filePath, deferredEffect, "suspend")) {
      return skip("Effect.when rewrite requires the true branch effect itself to be Effect.suspend(...).", outer.value.evidence);
    }

    const none = expressionCall(falseSucceed.arguments[0]!, context.sourceText);
    if (!none || none.arguments.length !== 0
      || !effectModuleCallMatches(context.semantics, candidate.filePath, none, "Option", "none")) {
      return skip("False branch is not proven Option.none().", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.when(${nodeText(deferredEffect, context.sourceText)}, () => ${nodeText(body.condition, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Suspended conditional matches Effect.when runtime semantics.");
  },
  rewrite: rewriteWholeCandidate,
};

export const forEachFromDenseArrayAllRule: EffectConversionRule = {
  id: "effect.forEach.from-all-dense-array-map-suspend",
  target: "forEach",
  description: "Rewrite Effect.all(denseArray.map(a => Effect.suspend(...))) to Effect.forEach.",
  selectors: [{
    id: "effect.forEach.from-all-dense-array-map-suspend.call",
    tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="all"]',
  }],
  analyze(candidate, context) {
    const outer = proveOuterEffectCall(candidate, context, "all");
    if (!outer.ok) return outer.decision;
    if (outer.value.call.arguments.length !== 1) return skip("Effect.all must have exactly one argument.", outer.value.evidence);

    const mapped = expressionCall(outer.value.call.arguments[0]!, context.sourceText);
    if (!mapped || mapped.arguments.length !== 1 || !isPropertyAccessExpression(unwrapParentheses(mapped.expression, context.sourceText))) {
      return skip("Effect.all input must be a direct array .map(...) call.", outer.value.evidence);
    }
    if (!callCalleeIsTypeScriptLibFunction(context.semantics, candidate.filePath, mapped, "map")) {
      return skip("Inner .map call is not proven to be a TypeScript standard-library Array.map.", outer.value.evidence);
    }

    const property = unwrapParentheses(mapped.expression, context.sourceText);
    if (!isPropertyAccessExpression(property)) return skip("Inner map receiver is unsupported.", outer.value.evidence);
    const receiver = unwrapParentheses(property.expression, context.sourceText);
    if (!isArrayLiteralExpression(receiver) || receiver.elements.some((element) => isOmittedExpression(element, context.sourceText))) {
      return skip("Only dense array literals are eligible for automatic forEach conversion.", outer.value.evidence);
    }

    const mapper = mapped.arguments[0];
    if (!mapper || !isArrowFunction(mapper)) return skip("Array.map callback must be an arrow.", outer.value.evidence);
    if (mapper.parameters.length > 2 || mapper.parameters.some((parameter) => parameter.dotDotDotToken !== undefined)) {
      return skip("Array.map exposes a third array argument while Effect.forEach only preserves value and index; callbacks using a third/rest parameter are unsafe.", outer.value.evidence);
    }
    const suspended = expressionCall(mapper.body, context.sourceText);
    if (!suspended || suspended.arguments.length !== 1
      || !effectCallMatches(context.semantics, candidate.filePath, suspended, "suspend")) {
      return skip("Array.map callback must directly return Effect.suspend(thunk).", outer.value.evidence);
    }
    const suspendThunk = suspended.arguments[0];
    if (!suspendThunk || (!isArrowFunction(suspendThunk) && !isFunctionExpression(suspendThunk, context.sourceText))) {
      return skip("Effect.suspend argument must be a function literal so construction is side-effect free.", outer.value.evidence);
    }

    const replacementText = `__codemod_Effect__.forEach(${nodeText(receiver, context.sourceText)}, ${nodeText(mapper, context.sourceText)})`;
    return convert(this.id, this.target, candidate, outer.value.evidence, replacementText, "Dense Array.map only constructs suspended effects; traversal timing is preserved.");
  },
  rewrite: rewriteWholeCandidate,
};

export const FIRST_EFFECT_RULES: readonly EffectConversionRule[] = [
  mapFromFlatMapSucceedRule,
  mapErrorFromCatchAllFailRule,
  filterOrFailFromFlatMapRule,
  allFromIdentityForEachRule,
  whenFromSuspendedConditionalRule,
  forEachFromDenseArrayAllRule,
];

export function proveOuterEffectCall(
  candidate: SyntaxCandidate,
  context: RuleContext,
  expectedName: string,
  allowDataLast = false,
): { readonly ok: true; readonly value: ProvenOuterCall } | { readonly ok: false; readonly decision: RuleDecision } {
  const call = candidateCallExpression(candidate);
  if (!call) return { ok: false, decision: skip("Candidate is not a TypeScript CallExpression.") };
  if (context.analysis) {
    const normalized = context.analysis.normalize(candidate.nativeNode as ts.CallExpression);
    if (!normalized || normalized.operator !== expectedName) return { ok: false, decision: skip(`Callee is not proven Effect.${expectedName}.`) };
    if (!normalized.dataLast && !context.analysis.effectResult(normalized.original)) return { ok: false, decision: skip(`Effect.${expectedName} call result is not proven to be an Effect type.`) };
    let normalizedCall = normalized.call;
    let dataLast = normalized.dataLast;
    if (dataLast && !allowDataLast) {
      // Existing data-first recipes share operands with their curried overloads.
      // A deferred self is an explicit rendering operand, never a fabricated AST proof.
      const self = { renderedText: "__codemod_self__", getStart: () => call.getStart(), getEnd: () => call.getStart(), getSourceFile: () => call.getSourceFile() };
      normalizedCall = { ...normalized.call, arguments: [self, ...normalized.call.arguments], getStart: () => call.getStart(), getEnd: () => call.getEnd(), getSourceFile: () => call.getSourceFile() };
      dataLast = false;
    }
    if (normalized.call.arguments.some((argument) => hasAsyncHandler(argument as ts.Node))) return { ok: false, decision: skip("Async callback behavior cannot be erased by this conversion.") };
    return { ok: true, value: { call: normalizedCall, dataLast, evidence: [
      { kind: "binding", summary: `Compiler resolves the callee to Effect.${expectedName}.` },
      { kind: "type", summary: normalized.dataLast ? "The call returns an Effect transformer." : "The call returns an Effect." },
    ] } };
  }
  if (effectNamespaceText(call, context.sourceText) !== "Effect") {
    return { ok: false, decision: skip("Automatic rewrites currently require an explicit Effect.<function> namespace call.") };
  }

  const gate = requireSingleExactCallSite(candidate.id, context.semantics);
  if (!gate.ok) return { ok: false, decision: { kind: "skip", reason: gate.reason, evidence: gate.evidence } };
  const model = context.semantics.snapshot.model;
  if (!model) return { ok: false, decision: skip("Typed semantic model index is unavailable.", gate.evidence) };
  if (!model.callSiteCalleeIsEffectFunction(gate.value, expectedName)) {
    return { ok: false, decision: skip(`Callee is not proven Effect.${expectedName}.`, gate.evidence) };
  }
  const dataLast = call.arguments.length === 1 && (model.callSiteResultIsEffectTransformer?.(gate.value) ?? false);
  if (dataLast && !allowDataLast) {
    return { ok: false, decision: skip(`This rule currently supports data-first Effect.${expectedName}(self, ...); the curried call returns an Effect transformer.`, gate.evidence) };
  }
  if (!dataLast && !model.callSiteResultIsEffect(gate.value)) {
    return { ok: false, decision: skip(`Effect.${expectedName} call result is not proven to be an Effect type.`, gate.evidence) };
  }

  const evidence: SemanticFact[] = [
    ...gate.evidence,
    { kind: "binding", summary: `Resolved callee binding is Effect.${expectedName}.`, data: gate.value.calleeSymbolId },
    { kind: "type", summary: dataLast ? "Resolved call result is a function from Effect to Effect." : "Resolved call result is an Effect type.", data: gate.value.resultTypeId },
  ];
  return { ok: true, value: { call, evidence, dataLast } };
}

export function convert(
  ruleId: string,
  target: EffectTarget,
  candidate: SyntaxCandidate,
  evidence: readonly SemanticFact[],
  replacementText: string,
  summary: string,
): RuleDecision {
  const match: ConversionMatch = {
    ruleId,
    target,
    candidate,
    captures: {},
    confidence: "safe",
    evidence: [...evidence, { kind: "custom", summary }],
    metadata: { replacementText } satisfies RewriteMetadata,
  };
  if (/@ts-(?:ignore|expect-error)/.test(candidate.text)) return { kind: "review", match: { ...match, confidence: "review" }, reason: "Rewriting this candidate could move a TypeScript comment directive." };
  return { kind: "convert", match };
}

export function skip(reason: string, evidence: readonly SemanticFact[] = []): RuleDecision {
  return { kind: "skip", reason, evidence };
}

export function rewriteWholeCandidate(match: ConversionMatch, context?: RuleContext) {
  const metadata = match.metadata as RewriteMetadata | undefined;
  if (!metadata?.replacementText) throw new Error(`Rule ${match.ruleId} did not provide replacementText metadata.`);
  const reference = context?.analysis?.effectReference(match.candidate.nativeNode as ts.Node) ?? { text: "Effect", imports: [] };
  const text = metadata.replacementText;
  const sf = ts.createSourceFile("rewrite.ts", `(${text})`, ts.ScriptTarget.Latest, true);
  const edits: { start: number; end: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "__codemod_Effect__" && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) edits.push({ start: node.getStart(sf) - 1, end: node.end - 1 });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (edits.length && context?.sourceText.includes("__codemod_Effect__")) throw new Error("Source collides with an internal rewrite placeholder");
  let rendered = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) rendered = rendered.slice(0, edit.start) + reference.text + rendered.slice(edit.end);
  if (rendered.includes("__codemod_self__")) {
    if (context?.sourceText.includes("__codemod_self__")) throw new Error("Source collides with a deferred operand placeholder");
    const parsed = ts.createSourceFile("curried.ts", `(${rendered})`, ts.ScriptTarget.Latest, true);
    const statement = parsed.statements[0];
    const expression = statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression) ? statement.expression.expression : undefined;
    if (!expression || !ts.isCallExpression(expression) || expression.arguments[0]?.getText(parsed) !== "__codemod_self__" || rendered.split("__codemod_self__").length !== 2) throw new Error("Rule cannot render this deferred self without changing evaluation timing");
    rendered = expression.arguments.length === 1 ? expression.expression.getText(parsed) : `${expression.expression.getText(parsed)}(${expression.arguments.slice(1).map((argument) => argument.getText(parsed)).join(", ")})`;
  }
  const retained = commentTexts(rendered);
  const missing = commentTexts(match.candidate.text).filter((comment) => {
    const index = retained.indexOf(comment);
    if (index < 0) return true;
    retained.splice(index, 1);
    return false;
  });
  if (missing.length) rendered = missing.map((comment) => `${comment}\n`).join("") + rendered;
  return {
    replacements: [{
      filePath: match.candidate.filePath,
      start: match.candidate.startOffset,
      end: match.candidate.endOffset,
      replacement: rendered,
      reason: match.ruleId,
    }],
    imports: edits.length ? reference.imports : [],
  };
}

function commentTexts(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const comments: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) comments.push(scanner.getTokenText());
  }
  return comments;
}

function hasAsyncHandler(node: ts.Node): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword));
  if (ts.isObjectLiteralExpression(node)) return node.properties.some((property) => ts.isPropertyAssignment(property) && hasAsyncHandler(property.initializer));
  return false;
}
