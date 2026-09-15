import { SyntaxKind } from "typescript";
import * as ts from "typescript";
import { applicationProof } from "./normalized-operands";
import type { SemanticCallSite, SemanticContext, SemanticLocation } from "../contracts/semantics";
import type { SyntaxCandidate } from "../contracts/source";

export interface SourceFileLike {
  getLineAndCharacterOfPosition(position: number): { line: number; character: number };
}

export interface NodeLike {
  /** Explicit normalized operand text; this is never used as semantic proof. */
  readonly renderedText?: string;
  readonly kind?: number;
  getStart(sourceFile?: SourceFileLike): number;
  getEnd(): number;
  getSourceFile(): SourceFileLike;
  getText?(sourceFile?: SourceFileLike): string;
}

export interface IdentifierLike extends NodeLike {
  readonly text: string;
}

export interface ParameterLike extends NodeLike {
  readonly name: NodeLike;
  readonly dotDotDotToken?: unknown;
  readonly initializer?: NodeLike;
}

export interface CallExpressionLike extends NodeLike {
  readonly expression: NodeLike;
  readonly arguments: readonly NodeLike[];
}

export interface ArrowFunctionLike extends NodeLike {
  readonly modifiers?: readonly { readonly kind: number }[];
  readonly parameters: readonly ParameterLike[];
  readonly body: NodeLike;
  readonly equalsGreaterThanToken: unknown;
}

export function isAsyncArrow(arrow: ArrowFunctionLike): boolean {
  return arrow.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) ?? false;
}

export interface FunctionExpressionLike extends NodeLike {
  readonly parameters: readonly ParameterLike[];
  readonly body: NodeLike;
}

export interface PropertyAccessExpressionLike extends NodeLike {
  readonly expression: NodeLike;
  readonly name: IdentifierLike;
}

export interface ConditionalExpressionLike extends NodeLike {
  readonly condition: NodeLike;
  readonly whenTrue: NodeLike;
  readonly whenFalse: NodeLike;
  readonly questionToken: unknown;
  readonly colonToken: unknown;
}

export interface ArrayLiteralExpressionLike extends NodeLike {
  readonly elements: readonly NodeLike[];
}

export interface ObjectLiteralExpressionLike extends NodeLike {
  readonly properties: readonly NodeLike[];
}

export interface PropertyAssignmentLike extends NodeLike {
  readonly name: NodeLike;
  readonly initializer: NodeLike;
}

export function candidateCallExpression(candidate: SyntaxCandidate): CallExpressionLike | undefined {
  return candidate.kind === "CallExpression" && isCallExpression(candidate.nativeNode)
    ? candidate.nativeNode
    : undefined;
}

export function nodeText(node: NodeLike, sourceText: string): string {
  if (node.renderedText !== undefined) return node.renderedText;
  const sourceFile = node.getSourceFile();
  return sourceText.slice(node.getStart(sourceFile), node.getEnd());
}

export function nodeLocation(filePath: string, node: NodeLike): SemanticLocation {
  const sourceFile = node.getSourceFile();
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { filePath, line: position.line + 1, column: position.character + 1 };
}

export function uniqueCallSiteForNode(
  semantics: SemanticContext,
  filePath: string,
  node: NodeLike,
): SemanticCallSite | undefined {
  const model = semantics.snapshot.model;
  if (!model) return undefined;
  const matches = model.callSitesAt(nodeLocation(filePath, node), "call");
  if (matches.length === 1) return matches[0];
  if (matches.length === 0 || !isCallExpression(node)) return undefined;

  // TypeModel call sites are point locations. Nested chained calls such as
  // Array.fromIterable(xs).reduce(...) legitimately share the same start
  // location, so use the syntactic callee name as a deterministic secondary
  // discriminator. We still require a single semantic match after filtering.
  const calleeName = callExpressionCalleeName(node);
  if (!calleeName) return undefined;
  const named = matches.filter((callSite) => {
    if (!callSite.calleeSymbolId) return false;
    const direct = model.symbol(callSite.calleeSymbolId);
    const resolved = model.resolveAliasSymbol(callSite.calleeSymbolId);
    return direct?.name === calleeName || resolved?.name === calleeName;
  });
  return named.length === 1 ? named[0] : undefined;
}

function callExpressionCalleeName(call: CallExpressionLike): string | undefined {
  const expression = call.expression;
  if (isPropertyAccessExpression(expression)) return expression.name.text;
  if (isIdentifier(expression)) return expression.text;
  return undefined;
}

export function effectNamespaceText(call: CallExpressionLike, sourceText: string): string | undefined {
  const expression = unwrapParentheses(call.expression, sourceText);
  if (!isPropertyAccessExpression(expression)) return undefined;
  return nodeText(expression.expression, sourceText);
}

export function arrowWithBodyText(
  arrow: ArrowFunctionLike,
  body: NodeLike,
  sourceText: string,
): string {
  const sourceFile = arrow.getSourceFile();
  const prefix = sourceText.slice(arrow.getStart(sourceFile), arrow.body.getStart(sourceFile));
  const original = arrow.body as ts.Node;
  if (original.kind === SyntaxKind.Block && ts.isBlock(original) && original.statements.length === 1 && ts.isReturnStatement(original.statements[0]!) && original.statements[0]!.expression) {
    const expression = original.statements[0]!.expression!;
    return `${prefix}${sourceText.slice(original.getStart(), expression.getStart())}${nodeText(body, sourceText)}${sourceText.slice(expression.end, original.end)}`;
  }
  return `${prefix}${nodeText(body, sourceText)}`;
}

export function singleArrowParameterIdentifier(arrow: ArrowFunctionLike): IdentifierLike | undefined {
  if (arrow.parameters.length !== 1) return undefined;
  const parameter = arrow.parameters[0];
  if (!parameter || parameter.dotDotDotToken !== undefined || parameter.initializer !== undefined || !isIdentifier(parameter.name)) {
    return undefined;
  }
  return parameter.name;
}

export function isSameIdentifier(expression: NodeLike, identifier: IdentifierLike, sourceText?: string): boolean {
  const unwrapped = sourceText === undefined ? expression : unwrapParentheses(expression, sourceText);
  return isIdentifier(unwrapped) && unwrapped.text === identifier.text;
}

export function unwrapParentheses<T extends NodeLike>(node: T, sourceText: string): NodeLike {
  let current: NodeLike = node;
  if (current.kind === SyntaxKind.Block) {
    const block = current as ts.Block;
    if (block.statements.length === 1 && ts.isReturnStatement(block.statements[0]!) && block.statements[0]!.expression) current = block.statements[0]!.expression!;
  }
  while (isParenthesizedExpression(current, sourceText)) {
    current = (current as { expression: NodeLike }).expression;
  }
  return current;
}

export function expressionCall(node: NodeLike, sourceText?: string): CallExpressionLike | undefined {
  const unwrapped = sourceText === undefined ? node : unwrapParentheses(node, sourceText);
  return isCallExpression(unwrapped) ? unwrapped : undefined;
}

export function effectCallMatches(
  semantics: SemanticContext,
  filePath: string,
  call: CallExpressionLike,
  expectedName: string,
): boolean {
  const application = applicationProof(call);
  if (application) return application.operator === expectedName;
  const model = semantics.snapshot.model;
  if (!model) return false;
  const callSite = uniqueCallSiteForNode(semantics, filePath, call);
  return callSite !== undefined && model.callSiteCalleeIsEffectFunction(callSite, expectedName);
}

export function effectModuleCallMatches(
  semantics: SemanticContext,
  filePath: string,
  call: CallExpressionLike,
  moduleName: string,
  expectedName: string,
): boolean {
  const model = semantics.snapshot.model;
  const callSite = uniqueCallSiteForNode(semantics, filePath, call);
  return model !== undefined
    && callSite?.resolution === "resolved"
    && callSite.calleeSymbolId !== undefined
    && model.isEffectModuleSymbol(callSite.calleeSymbolId, moduleName, expectedName);
}

export function callResultIsEffect(
  semantics: SemanticContext,
  filePath: string,
  call: CallExpressionLike,
): boolean {
  if (applicationProof(call)?.resultIsEffect) return true;
  const model = semantics.snapshot.model;
  if (!model) return false;
  const callSite = uniqueCallSiteForNode(semantics, filePath, call);
  return callSite !== undefined && model.callSiteResultIsEffect(callSite);
}

export function callCalleeIsTypeScriptLibFunction(
  semantics: SemanticContext,
  filePath: string,
  call: CallExpressionLike,
  expectedName: string,
): boolean {
  const model = semantics.snapshot.model;
  const callSite = uniqueCallSiteForNode(semantics, filePath, call);
  return model !== undefined
    && callSite?.calleeSymbolId !== undefined
    && model.isTypeScriptLibSymbol(callSite.calleeSymbolId, expectedName);
}

export function isCallExpression(value: unknown): value is CallExpressionLike {
  return isNode(value) && "expression" in value && Array.isArray((value as { arguments?: unknown }).arguments);
}

export function isArrowFunction(value: unknown): value is ArrowFunctionLike {
  return isNode(value)
    && Array.isArray((value as { parameters?: unknown }).parameters)
    && "body" in value
    && "equalsGreaterThanToken" in value;
}

export function isFunctionExpression(value: unknown, sourceText: string): value is FunctionExpressionLike {
  return isNode(value)
    && Array.isArray((value as { parameters?: unknown }).parameters)
    && "body" in value
    && !("equalsGreaterThanToken" in value)
    && nodeText(value, sourceText).trimStart().startsWith("function");
}

export function isIdentifier(value: unknown): value is IdentifierLike {
  return isNode(value)
    && typeof (value as { text?: unknown }).text === "string"
    && !("expression" in value)
    && !("elements" in value);
}

export function isPropertyAccessExpression(value: unknown): value is PropertyAccessExpressionLike {
  return isNode(value)
    && "expression" in value
    && "name" in value
    && isIdentifier((value as { name?: unknown }).name)
    && !Array.isArray((value as { arguments?: unknown }).arguments);
}

export function isConditionalExpression(value: unknown): value is ConditionalExpressionLike {
  return isNode(value)
    && "condition" in value
    && "whenTrue" in value
    && "whenFalse" in value
    && "questionToken" in value
    && "colonToken" in value;
}

export function isArrayLiteralExpression(value: unknown): value is ArrayLiteralExpressionLike {
  return isNode(value) && Array.isArray((value as { elements?: unknown }).elements);
}

export function isObjectLiteralExpression(value: unknown): value is ObjectLiteralExpressionLike {
  return isNode(value) && Array.isArray((value as { properties?: unknown }).properties);
}

export function isPropertyAssignment(value: unknown): value is PropertyAssignmentLike {
  return isNode(value) && "name" in value && "initializer" in value;
}

export function objectPropertyInitializer(
  object: ObjectLiteralExpressionLike,
  propertyName: string,
  sourceText: string,
): NodeLike | undefined {
  const matches = object.properties.filter((property) =>
    isPropertyAssignment(property) && nodeText(property.name, sourceText).trim() === propertyName
  ) as PropertyAssignmentLike[];
  return matches.length === 1 ? matches[0]?.initializer : undefined;
}

export function hasOnlyObjectProperties(
  object: ObjectLiteralExpressionLike,
  propertyNames: readonly string[],
  sourceText: string,
): boolean {
  if (object.properties.length !== propertyNames.length) return false;
  const expected = new Set(propertyNames);
  for (const property of object.properties) {
    if (!isPropertyAssignment(property)) return false;
    const name = nodeText(property.name, sourceText).trim();
    if (!expected.delete(name)) return false;
  }
  return expected.size === 0;
}

export function hasSimpleArrowParameters(arrow: ArrowFunctionLike, maxParameters = 1): boolean {
  if (arrow.parameters.length > maxParameters) return false;
  return arrow.parameters.every((parameter) =>
    parameter.dotDotDotToken === undefined
      && parameter.initializer === undefined
      && isIdentifier(parameter.name)
  );
}


export function isBooleanLiteralExpression(node: NodeLike, expected: boolean, sourceText: string): boolean {
  return nodeText(unwrapParentheses(node, sourceText), sourceText).trim() === String(expected);
}

export function isStringLiteralExpression(node: NodeLike, sourceText: string): boolean {
  const text = nodeText(unwrapParentheses(node, sourceText), sourceText).trim();
  return /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u.test(text);
}

export function isNegationOfIdentifier(node: NodeLike, identifier: IdentifierLike, sourceText: string): boolean {
  const text = nodeText(unwrapParentheses(node, sourceText), sourceText).trim();
  const escaped = identifier.text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^!\\s*(?:\\(\\s*)?${escaped}(?:\\s*\\))?$`, "u").test(text);
}

export function isVoidProducingArrowBody(body: NodeLike, sourceText: string): boolean {
  const text = nodeText(body, sourceText).trim();
  return text === "{}" || /^void\s+(?:0|\(0\))$/u.test(text);
}

export function isPrimitiveLiteralExpression(node: NodeLike, sourceText: string): boolean {
  const text = nodeText(unwrapParentheses(node, sourceText), sourceText).trim();
  if (text === "null" || text === "true" || text === "false") return true;
  if (/^[+-]?(?:\d+(?:_?\d)*(?:\.(?:\d+(?:_?\d)*)?)?|\.\d+(?:_?\d)*)(?:[eE][+-]?\d+(?:_?\d)*)?n?$/u.test(text)) return true;
  if (/^0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?$/u.test(text)) return true;
  if (/^0[bB][01](?:_?[01])*n?$/u.test(text)) return true;
  if (/^0[oO][0-7](?:_?[0-7])*n?$/u.test(text)) return true;
  return /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/u.test(text);
}

export function isOmittedExpression(value: NodeLike, sourceText: string): boolean {
  return nodeText(value, sourceText).trim().length === 0;
}

function isParenthesizedExpression(value: NodeLike, sourceText: string): value is NodeLike & { expression: NodeLike } {
  if (!("expression" in value) || "name" in value || "arguments" in value) return false;
  const text = nodeText(value, sourceText).trim();
  return text.startsWith("(") && text.endsWith(")");
}

function isNode(value: unknown): value is NodeLike {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<NodeLike>;
  return typeof record.getStart === "function"
    && typeof record.getEnd === "function"
    && typeof record.getSourceFile === "function";
}
