import * as ts from "typescript";
import type { EffectConversionRule, RuleContext, RuleDecision } from "../contracts/rule";
import type { SyntaxCandidate } from "../contracts/source";
import { skip } from "./effect-compositions";
import { unwrap } from "../core/compiler-analysis";

function containingGenerator(node: ts.Node, context: RuleContext): ts.FunctionExpression | undefined {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTryStatement(current)) return undefined;
    if (ts.isFunctionLike(current)) {
      return ts.isFunctionExpression(current) && current.asteriskToken && ts.isCallExpression(current.parent) && context.analysis?.operator(current.parent) === "gen" ? current : undefined;
    }
  }
  return undefined;
}

function forbidden(node: ts.Node, receiver = false): boolean {
  if (ts.isYieldExpression(node) || ts.isAwaitExpression(node) || (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) || ts.isDeleteExpression(node)
    || node.kind === ts.SyntaxKind.SuperKeyword || ts.isMetaProperty(node)
    || (receiver && node.kind === ts.SyntaxKind.ThisKeyword)
    || (ts.isIdentifier(node) && node.text === "arguments")
    || (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    || ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))) return true;
  return Boolean(ts.forEachChild(node, (child) => forbidden(child, receiver) || undefined));
}

function conditionSupported(node: ts.Node): boolean {
  node = unwrap(node);
  if (ts.isIdentifier(node) || ts.isLiteralExpression(node) || [ts.SyntaxKind.NullKeyword, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.ThisKeyword].includes(node.kind)) return true;
  if (ts.isPropertyAccessExpression(node)) return conditionSupported(node.expression);
  if (ts.isTypeOfExpression(node)) return conditionSupported(node.expression);
  if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken && conditionSupported(node.operand);
  if (ts.isBinaryExpression(node)) return [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind) && conditionSupported(node.left) && conditionSupported(node.right);
  return false;
}

function statementDecision(rule: EffectConversionRule, candidate: SyntaxCandidate, context: RuleContext, start: number, end: number, text: string, summary: string): RuleDecision {
  const reference = context.analysis!.effectReference(candidate.nativeNode as ts.Node);
  const errors = context.analysis!.checkRewrite?.(candidate.filePath, start, end, text, reference.imports) ?? [];
  if (errors.length) return { kind: "review", reason: "The proposed generator conversion cannot preserve type refinement: " + errors.join("; "), match: {
    ruleId: rule.id, target: rule.target, candidate, captures: {}, confidence: "review", evidence: [{ kind: "diagnostic", summary: "Generator refinement proof failed", data: errors }, { kind: "custom", summary: "Suggested rewrite requires review", data: { replacementText: text } }],
  } };
  return { kind: "convert", match: { ruleId: rule.id, target: rule.target, candidate, captures: {}, confidence: "safe", evidence: [
    { kind: "binding", summary: "Source operations resolve to Effect v3 through the compiler." },
    { kind: "custom", summary },
  ], metadata: { start, end, replacementText: text, imports: reference.imports } } };
}

const rewrite: EffectConversionRule["rewrite"] = (match) => {
  const metadata = match.metadata as { start: number; end: number; replacementText: string; imports: readonly import("../contracts/rewrite").ImportRequirement[] };
  return { replacements: [{ filePath: match.candidate.filePath, start: metadata.start, end: metadata.end, replacement: metadata.replacementText, reason: match.ruleId }], imports: metadata.imports };
};

export const generatorGuardRule: EffectConversionRule = {
  id: "effect.filterOrFail.from-generator-guard", target: "filterOrFail",
  description: "Combine an adjacent yielded const and failure guard without leaving the generator.",
  selectors: [{ id: "effect.filterOrFail.from-generator-guard.if", tsquery: "IfStatement" }],
  analyze(candidate, context) {
    if (!context.analysis) return skip("Generator analysis requires a compiler session.");
    const guard = candidate.nativeNode as ts.Node;
    if (!ts.isIfStatement(guard) || guard.elseStatement || !ts.isBlock(guard.parent) || !containingGenerator(guard, context)) return skip("Guard must be inside an Effect generator without a try boundary or else branch.");
    const statements = guard.parent.statements;
    const previous = statements[statements.indexOf(guard) - 1];
    if (!previous || !ts.isVariableStatement(previous) || !(previous.declarationList.flags & ts.NodeFlags.Const) || previous.declarationList.declarations.length !== 1) return skip("Guard must immediately follow a single const declaration.");
    const declaration = previous.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isYieldExpression(declaration.initializer) || !declaration.initializer.asteriskToken || !declaration.initializer.expression) return skip("Guard must follow a delegated Effect yield assigned to an identifier.");
    const source = declaration.initializer.expression;
    if (!context.analysis.effectResult(source)) return skip("Yielded source is not proven to be an Effect.");
    let failure: ts.Statement = guard.thenStatement;
    if (ts.isBlock(failure)) {
      if (failure.statements.length !== 1) return skip("Failure block must contain only its return statement.");
      failure = failure.statements[0]!;
    }
    if (!ts.isReturnStatement(failure) || !failure.expression || !ts.isYieldExpression(failure.expression) || !failure.expression.asteriskToken || !failure.expression.expression) return skip("Guard failure must return yield* Effect.fail(error).");
    const call = unwrap(failure.expression.expression);
    if (!ts.isCallExpression(call) || context.analysis.operator(call) !== "fail" || call.arguments.length !== 1 || !context.analysis.effectResult(call)) return skip("Guard failure is not proven Effect.fail(error).");
    const error = call.arguments[0]!;
    if (!conditionSupported(guard.expression) || forbidden(guard.expression) || forbidden(error)) return skip("Guard expressions require unsupported syntax or mutation.");
    const symbol = context.analysis.checker.getSymbolAtLocation(declaration.name);
    let usesValue = false;
    const inspect = (node: ts.Node) => { if (ts.isIdentifier(node) && context.analysis!.checker.getSymbolAtLocation(node) === symbol) usesValue = true; ts.forEachChild(node, inspect); };
    inspect(guard.expression);
    if (!usesValue) return skip("Guard must test the immediately yielded value.");
    const owner = containingGenerator(guard, context)!;
    let capturedBeforeGuard = false;
    const captures = (node: ts.Node) => {
      if (ts.isIdentifier(node) && context.analysis!.checker.getSymbolAtLocation(node) === symbol) {
        for (let current = node.parent; current && current !== owner; current = current.parent) {
          if (ts.isFunctionLike(current) && (ts.isFunctionDeclaration(current) || current.getStart() < guard.getStart())) capturedBeforeGuard = true;
        }
      }
      ts.forEachChild(node, captures);
    };
    captures(owner.body);
    if (capturedBeforeGuard) return skip("The yielded binding is captured before the guard; combining its initialization could change temporal-dead-zone behavior.");
    // Moving comment directives could affect checker behavior. Keep such guards intact.
    const section = context.sourceText.slice(previous.getStart(), guard.end);
    if (/\/\/|\/\*/.test(section)) return skip("Generator guard comments must be preserved; this shape requires review.");
    const name = declaration.name.text;
    const reference = context.analysis.effectReference(guard).text;
    const predicate = `${name} => !(${guard.expression.getText()})`;
    const expression = `${reference}.filterOrFail(${source.getText()}, ${predicate}, ${name} => (${error.getText()}))`;
    const text = context.sourceText.slice(previous.getStart(), source.getStart()) + expression + context.sourceText.slice(source.end, previous.end);
    return statementDecision(this, candidate, context, previous.getStart(), guard.end, text, "The failure factory runs only when the original guard fails; both callbacks bind the yielded value and remain inside the original generator scope.");
  }, rewrite,
};

function generatorBody(candidate: SyntaxCandidate, context: RuleContext): ts.FunctionExpression | undefined {
  if (!context.analysis) return undefined;
  const node = candidate.nativeNode as ts.Node;
  if (!ts.isCallExpression(node) || context.analysis.operator(node) !== "gen" || node.arguments.length !== 1) return undefined;
  const fn = node.arguments[0];
  return fn && ts.isFunctionExpression(fn) && fn.asteriskToken && !fn.name && !fn.typeParameters?.length && !fn.parameters.length && fn.body.statements.length === 2 ? fn : undefined;
}

function analyzeYieldReturn(rule: EffectConversionRule, candidate: SyntaxCandidate, context: RuleContext, effectful: boolean): RuleDecision {
  const fn = generatorBody(candidate, context);
  if (!fn) return skip("Yield-return conversion requires a two-statement receiver-free Effect generator.");
  const [first, last] = fn.body.statements;
  if (!first || !ts.isVariableStatement(first) || !(first.declarationList.flags & ts.NodeFlags.Const) || first.declarationList.declarations.length !== 1 || !last || !ts.isReturnStatement(last) || !last.expression) return skip("Generator must contain a yielded const followed by a return.");
  const declaration = first.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isYieldExpression(declaration.initializer) || !declaration.initializer.asteriskToken || !declaration.initializer.expression) return skip("Generator declaration must delegate to an Effect.");
  const source = declaration.initializer.expression;
  const symbol = context.analysis!.checker.getSymbolAtLocation(declaration.name);
  let selfReference = false;
  const references = (node: ts.Node) => { if (ts.isIdentifier(node) && context.analysis!.checker.getSymbolAtLocation(node) === symbol) selfReference = true; ts.forEachChild(node, references); };
  references(source);
  if (selfReference) return skip("Yielded source captures its own uninitialized binding; moving it would change temporal-dead-zone behavior.");
  const result = effectful && ts.isYieldExpression(last.expression) && last.expression.asteriskToken ? last.expression.expression : !effectful && !ts.isYieldExpression(last.expression) ? last.expression : undefined;
  if (!result || !context.analysis!.effectResult(source) || (effectful && !context.analysis!.effectResult(result))) return skip("Generator return does not match the requested Effect composition.");
  if (forbidden(source, true) || forbidden(result, true)) return skip("Generator receiver, mutation, nested functions, or yield behavior cannot be moved into callbacks.");
  if (/\/\/|\/\*/.test(candidate.text)) return skip("Generator comments require a shape-preserving rewrite.");
  const reference = context.analysis!.effectReference(fn).text;
  const annotation = declaration.type ? `: ${declaration.type.getText()}` : "";
  const text = `${reference}.suspend(() => ${reference}.${effectful ? "flatMap" : "map"}(${source.getText()}, (${declaration.name.text}${annotation}) => (${result.getText()})))`;
  return statementDecision(rule, candidate, context, candidate.startOffset, candidate.endOffset, text, "Source construction remains deferred; the yielded value is passed once to the original return expression.");
}

export const generatorMapRule: EffectConversionRule = {
  id: "effect.map.from-generator-yield-return", target: "map", description: "Simplify a yielded value followed by a pure return expression.",
  selectors: [{ id: "effect.map.from-generator-yield-return.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="gen"]' }],
  analyze(candidate, context) { return analyzeYieldReturn(this, candidate, context, false); }, rewrite,
};
export const generatorFlatMapRule: EffectConversionRule = {
  id: "effect.flatMap.from-generator-yield-return", target: "flatMap", description: "Simplify two sequential delegated effects in a generator.",
  selectors: [{ id: "effect.flatMap.from-generator-yield-return.call", tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="gen"]' }],
  analyze(candidate, context) { return analyzeYieldReturn(this, candidate, context, true); }, rewrite,
};

export const generatorForEachRule: EffectConversionRule = {
  id: "effect.forEach.from-generator-dense-loop", target: "forEach", description: "Traverse an inline dense array sequentially inside its generator.",
  selectors: [{ id: "effect.forEach.from-generator-dense-loop.for", tsquery: "ForOfStatement:has(ArrayLiteralExpression)" }],
  analyze(candidate, context) {
    if (!context.analysis) return skip("Generator analysis requires a compiler session.");
    const loop = candidate.nativeNode as ts.Node;
    if (!ts.isForOfStatement(loop) || loop.awaitModifier || !containingGenerator(loop, context) || !ts.isArrayLiteralExpression(loop.expression) || loop.expression.elements.some((element) => ts.isSpreadElement(element) || ts.isOmittedExpression(element))) return skip("Traversal requires an inline dense array in an Effect generator.");
    if (!ts.isVariableDeclarationList(loop.initializer) || !(loop.initializer.flags & ts.NodeFlags.Const) || loop.initializer.declarations.length !== 1 || !ts.isIdentifier(loop.initializer.declarations[0]!.name)) return skip("Traversal requires a single const loop identifier.");
    let body: ts.Statement = loop.statement;
    if (ts.isBlock(body)) { if (body.statements.length !== 1) return skip("Traversal body must contain exactly one yield."); body = body.statements[0]!; }
    if (!ts.isExpressionStatement(body) || !ts.isYieldExpression(body.expression) || !body.expression.asteriskToken || !body.expression.expression || !context.analysis.effectResult(body.expression.expression) || forbidden(body.expression.expression)) return skip("Traversal body must delegate once to a proven Effect without control transfers or mutation.");
    if (/\/\/|\/\*/.test(candidate.text)) return skip("Traversal comments require a shape-preserving rewrite.");
    const reference = context.analysis.effectReference(loop).text;
    const name = loop.initializer.declarations[0]!.name.getText();
    const text = `yield* ${reference}.forEach(${loop.expression.getText()}, ${name} => ${body.expression.expression.getText()}, { concurrency: 1, discard: true });`;
    return statementDecision(this, candidate, context, candidate.startOffset, candidate.endOffset, text, "The inline array is traversed sequentially, constructing one effect per element and discarding results.");
  }, rewrite,
};

export const GENERATOR_RULES = [generatorGuardRule, generatorMapRule, generatorFlatMapRule, generatorForEachRule] as const;
