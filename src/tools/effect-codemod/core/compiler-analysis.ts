import * as ts from "typescript";
import type { HelperResult, NormalizedCall, SyntaxAnalysis } from "../contracts/syntax-analysis";
import type { CallExpressionLike } from "./ts-syntax";
import { recordApplication } from "./normalized-operands";
import type { NodeLike } from "./ts-syntax";

export function unwrap<T extends ts.Node>(node: T): ts.Node {
  let current: ts.Node = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function effectDeclaration(symbol: ts.Symbol | undefined, name?: string): boolean {
  return Boolean(symbol && (!name || symbol.name === name) && symbol.declarations?.some((declaration) =>
    /\/effect\/(?:dist\/dts\/|src\/)?Effect\.(?:d\.)?[cm]?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/"))));
}

export class CompilerSyntaxAnalysis implements SyntaxAnalysis {
  private readonly helperCache = new WeakMap<ts.CallExpression, HelperResult>();
  private readonly references = new WeakMap<ts.SourceFile, string>();
  private readonly normalizedCalls = new WeakMap<ts.CallExpression, NormalizedCall | null>();
  constructor(readonly checker: ts.TypeChecker, readonly selectedFiles: ReadonlySet<string>, readonly checkRewrite?: SyntaxAnalysis["checkRewrite"]) {}

  symbol(node: ts.Node): ts.Symbol | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    const seen = new Set<ts.Symbol>();
    while (symbol && (symbol.flags & ts.SymbolFlags.Alias) && !seen.has(symbol)) { seen.add(symbol); symbol = this.checker.getAliasedSymbol(symbol); }
    return symbol;
  }

  operator(node: ts.Node): string | undefined {
    node = unwrap(node);
    if (ts.isCallExpression(node)) {
      if (node.questionDotToken) return undefined;
      node = unwrap(node.expression);
    }
    if (!(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) || (ts.isPropertyAccessExpression(node) && node.questionDotToken)) return undefined;
    const symbol = this.symbol(node);
    return effectDeclaration(symbol) ? symbol!.name : undefined;
  }

  effectType(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type) || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    seen.add(type);
    if (effectDeclaration(type.aliasSymbol, "Effect") || effectDeclaration(type.getSymbol(), "Effect")) return true;
    if (type.isUnion()) return type.types.every((part) => this.effectType(part, new Set(seen)));
    if (type.isIntersection()) return type.types.some((part) => this.effectType(part, new Set(seen)));
    const constraint = this.checker.getBaseConstraintOfType(type);
    return Boolean(constraint && constraint !== type && this.effectType(constraint, seen));
  }

  effectResult(node: ts.Expression): boolean { return this.effectType(this.checker.getTypeAtLocation(node)); }

  normalize(node: ts.CallExpression): NormalizedCall | undefined {
    if (this.normalizedCalls.has(node)) return this.normalizedCalls.get(node) ?? undefined;
    const result = this.computeNormalized(node);
    this.normalizedCalls.set(node, result ?? null);
    return result;
  }

  private computeNormalized(node: ts.CallExpression): NormalizedCall | undefined {
    const direct = this.operator(node);
    if (direct) {
      const type = this.checker.getTypeAtLocation(node);
      const signatures = type.getCallSignatures();
      const dataLast = !this.effectType(type) && signatures.length > 0 && signatures.every((signature) => {
        const parameter = signature.parameters[0];
        return signature.parameters.length === 1 && parameter && this.effectType(signature.getReturnType());
      });
      const call: CallExpressionLike = { kind: node.kind, expression: unwrap(node.expression), arguments: node.arguments.map(unwrap), getStart: () => node.getStart(), getEnd: () => node.end, getSourceFile: () => node.getSourceFile() };
      return { original: node, call, operator: direct, dataLast };
    }
    const callee = unwrap(node.expression);
    const pipe = this.symbol(callee);
    const standardPipe = pipe?.name === "pipe" && pipe.declarations?.some((declaration) => /\/effect\/(?:dist\/dts\/|src\/)?(?:Function|Pipeable)\.(?:d\.)?[cm]?ts$/.test(declaration.getSourceFile().fileName.replaceAll("\\", "/")));
    if (standardPipe && !node.questionDotToken && this.effectResult(node)) {
      const method = ts.isPropertyAccessExpression(callee);
      const input = method ? callee.expression : node.arguments[0];
      const operators = method ? node.arguments : node.arguments.slice(1);
      if (input && operators.length) {
        let self: NodeLike = input;
        let result: NormalizedCall | undefined;
        for (let index = 0; index < operators.length; index++) {
          const operation = unwrap(operators[index]!);
          if (!ts.isCallExpression(operation)) return undefined;
          const normalized = this.normalize(operation);
          if (!normalized?.dataLast || !operation.arguments.every(inert)) return undefined;
          const prefix = operators.slice(0, index + 1).map((argument) => argument.getText()).join(", ");
          const renderedText = method ? `${input.getText()}.pipe(${prefix})` : `${callee.getText()}(${input.getText()}, ${prefix})`;
          const view: CallExpressionLike & { renderedText: string } = { kind: ts.SyntaxKind.CallExpression, expression: normalized.call.expression, arguments: [self, ...normalized.call.arguments], renderedText, getStart: () => operation.getStart(), getEnd: () => operation.end, getSourceFile: () => operation.getSourceFile() };
          self = recordApplication(view, normalized.operator);
          result = { original: node, call: view, operator: normalized.operator, dataLast: false };
        }
        return result;
      }
    }
    if (ts.isCallExpression(callee) && node.arguments.length === 1 && !node.questionDotToken) {
      const inner = this.normalize(callee);
      // Moving callback construction past self is allowed only for inert operands.
      if (inner?.dataLast && callee.arguments.every(inert) && this.effectResult(node)) {
        const call: CallExpressionLike = {
          kind: node.kind, expression: callee.expression, arguments: [node.arguments[0]!, ...callee.arguments],
          getStart: () => node.getStart(), getEnd: () => node.end, getSourceFile: () => node.getSourceFile(),
        };
        return { original: node, call, operator: inner.operator, dataLast: false };
      }
    }
    return undefined;
  }

  effectReference(node: ts.Node): { text: string; imports: readonly { moduleSpecifier: string; importedName: string; localName: string }[] } {
    const sf = node.getSourceFile();
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
      const module = statement.moduleSpecifier.text, bindings = statement.importClause?.namedBindings;
      if (!bindings) continue;
      const names = ts.isNamespaceImport(bindings) && module === "effect/Effect" ? [bindings.name]
        : ts.isNamedImports(bindings) && module === "effect" ? bindings.elements.filter((entry) => !entry.isTypeOnly && (entry.propertyName ?? entry.name).text === "Effect").map((entry) => entry.name) : [];
      for (const name of names) {
        const visible = this.checker.getSymbolsInScope(node, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).find((symbol) => symbol.name === name.text);
        if (visible === this.checker.getSymbolAtLocation(name)) return { text: name.text, imports: [] };
      }
    }
    let name = this.references.get(sf);
    if (!name) {
      const identifiers = new Set<string>();
      const visit = (current: ts.Node) => { if (ts.isIdentifier(current)) identifiers.add(current.text); ts.forEachChild(current, visit); };
      visit(sf);
      name = "Effect";
      for (let suffix = 1; identifiers.has(name); suffix++) name = `EffectCodemod${suffix}`;
      this.references.set(sf, name);
    }
    return { text: name, imports: [{ moduleSpecifier: "effect", importedName: "Effect", localName: name }] };
  }

  helperResult(node: ts.CallExpression): HelperResult {
    const cached = this.helperCache.get(node);
    if (cached) return cached;
    let remaining = 200;
    const helpers: string[] = [];
    const active = new Set<ts.Symbol>();
    const tick = () => { if (--remaining < 0) throw new AnalysisFailure("analysis-limit", "Helper analysis exceeded 200 AST nodes"); };
    const scope = node;
    const render = (expression: ts.Expression, bindings: ReadonlyMap<ts.Symbol, string>): string => {
      tick();
      expression = unwrap(expression) as ts.Expression;
      if (ts.isIdentifier(expression)) {
        const symbol = this.symbol(expression);
        if (symbol && bindings.has(symbol)) return `(${bindings.get(symbol)!})`;
        if (expression.text === "undefined" && !symbol?.valueDeclaration) return "undefined";
        const local = this.checker.getSymbolsInScope(scope, ts.SymbolFlags.Value | ts.SymbolFlags.Alias).find((item) => item.name === expression.text);
        if (symbol && local && (local === symbol || ((local.flags & ts.SymbolFlags.Alias) && this.checker.getAliasedSymbol(local) === symbol))) {
          const declaration = symbol.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer && literal(declaration.initializer)) return expression.getText();
        }
        throw new AnalysisFailure("unproven", "Helper capture is not an accessible immutable literal");
      }
      if (literal(expression)) return expression.getText();
      if (ts.isPrefixUnaryExpression(expression) && [ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(expression.operator)) return `(${ts.tokenToString(expression.operator)}${render(expression.operand, bindings)})`;
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind < ts.SyntaxKind.FirstAssignment && expression.operatorToken.kind !== ts.SyntaxKind.CommaToken) return `(${render(expression.left, bindings)} ${expression.operatorToken.getText()} ${render(expression.right, bindings)})`;
      if (ts.isConditionalExpression(expression)) return `(${render(expression.condition, bindings)} ? ${render(expression.whenTrue, bindings)} : ${render(expression.whenFalse, bindings)})`;
      throw new AnalysisFailure("unproven", "Helper value requires mutation, dynamic dispatch, allocation, or an unproven operation");
    };
    const walk = (call: ts.CallExpression, bindings: ReadonlyMap<ts.Symbol, string>, depth: number): { operator: "succeed" | "fail"; value: string } => {
      tick();
      const operator = this.operator(call);
      if ((operator === "succeed" || operator === "fail") && call.arguments.length === 1) return { operator, value: render(call.arguments[0]!, bindings) };
      if (operator && ["map", "flatMap", "mapError", "catchAll"].includes(operator) && call.arguments.length === 2) {
        const source = unwrap(call.arguments[0]!), callback = unwrap(call.arguments[1]!);
        if (!ts.isCallExpression(source) || !ts.isArrowFunction(callback) || callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || callback.parameters.length !== 1 || !ts.isIdentifier(callback.parameters[0]!.name) || callback.parameters[0]!.initializer || callback.parameters[0]!.dotDotDotToken) throw new AnalysisFailure("unproven", "Helper composition requires a simple synchronous callback");
        const left = walk(source, bindings, depth);
        const handlesFailure = operator === "mapError" || operator === "catchAll";
        if ((left.operator === "fail") !== handlesFailure) return left;
        let body: ts.Node = callback.body;
        if (ts.isBlock(body)) {
          if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0]!) || !body.statements[0]!.expression) throw new AnalysisFailure("unproven", "Helper composition callback must contain one return");
          body = body.statements[0]!.expression!;
        }
        body = unwrap(body);
        const parameter = callback.parameters[0]!;
        let type = this.checker.getTypeAtLocation(parameter.name);
        type = this.checker.getBaseConstraintOfType(type) ?? type;
        if (!primitiveType(type, this.checker)) throw new AnalysisFailure("unproven", "Helper composition requires a primitive callback input");
        const occupied = scope.getSourceFile().text + call.getSourceFile().text + [...bindings.values()].join(" ");
        let name = "__effectValue";
        while (occupied.includes(name)) name += "_";
        const nested = new Map(bindings);
        nested.set(this.checker.getSymbolAtLocation(parameter.name)!, name);
        const right = operator === "flatMap" || operator === "catchAll"
          ? ts.isCallExpression(body) ? walk(body, nested, depth) : undefined
          : { operator: left.operator, value: render(body as ts.Expression, nested) };
        if (!right) throw new AnalysisFailure("unproven", "Helper composition callback must return a supported Effect");
        return { operator: right.operator, value: `((${name}: ${this.checker.typeToString(type)}) => (${right.value}))(${left.value})` };
      }
      if (depth >= 3) throw new AnalysisFailure("analysis-limit", "Helper analysis exceeded three helper edges");
      if (!ts.isIdentifier(call.expression)) throw new AnalysisFailure("unproven", "Helper call requires a statically resolved function identifier");
      const symbol = this.symbol(call.expression);
      if (!symbol || active.has(symbol)) throw new AnalysisFailure(active.has(symbol!) ? "analysis-limit" : "unproven", "Helper is recursive or unresolved");
      const declaration = symbol.valueDeclaration;
      if (!declaration || !this.selectedFiles.has(declaration.getSourceFile().fileName)) throw new AnalysisFailure("unproven", "Helper declaration is outside the selected source files");
      if (ts.isFunctionDeclaration(declaration)) {
        let assigned = false;
        const inspect = (current: ts.Node) => {
          if (ts.isBinaryExpression(current) && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment && this.symbol(current.left) === symbol) assigned = true;
          ts.forEachChild(current, inspect);
        };
        inspect(declaration.getSourceFile());
        if (assigned) throw new AnalysisFailure("unproven", "Helper function binding is reassigned");
      }
      const fn = ts.isFunctionDeclaration(declaration) ? declaration
        : ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent) && declaration.parent.flags & ts.NodeFlags.Const && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) ? declaration.initializer : undefined;
      if (!fn?.body || fn.asteriskToken || fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || fn.parameters.length !== call.arguments.length || fn.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)) throw new AnalysisFailure("unproven", "Helper signature is not a simple synchronous function");
      let body: ts.Node = fn.body;
      if (ts.isBlock(body)) {
        if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0]!) || !body.statements[0]!.expression) throw new AnalysisFailure("unproven", "Helper must contain exactly one return statement");
        body = body.statements[0]!.expression!;
      }
      body = unwrap(body);
      if (!ts.isCallExpression(body)) throw new AnalysisFailure("unproven", "Helper must return an Effect constructor or another simple helper");
      const next = new Map<ts.Symbol, string>();
      const argumentsText: string[] = [];
      const parametersText: string[] = [];
      let occupied = scope.getSourceFile().text + call.getSourceFile().text + [...bindings.values()].join(" ");
      if (ts.isVariableDeclaration(declaration)) {
        const visible = this.checker.getSymbolsInScope(scope, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)
          .find((item) => (item.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(item) : item) === symbol);
        if (!visible) throw new AnalysisFailure("unproven", "Helper function constant is an inaccessible capture; its initialization cannot be preserved");
        let name = "__effectHelper";
        while (occupied.includes(name)) name += "_";
        occupied += " " + name;
        argumentsText.push(visible.name);
        parametersText.push(`${name}: unknown`);
      }
      fn.parameters.forEach((parameter, index) => {
        const argument = call.arguments[index]!;
        // Bind each argument exactly once, in source order, even when unused.
        // Primitive reads can still throw when a binding is uninitialized.
        if (!ts.isIdentifier(argument) && !literal(argument)) throw new AnalysisFailure("unproven", "Helper arguments cannot change evaluation count or order");
        if (!primitiveType(this.checker.getTypeAtLocation(argument), this.checker)) throw new AnalysisFailure("unproven", "Helper argument coercion is not proven primitive and timing-safe");
        const argumentSymbol = ts.isIdentifier(argument) ? this.symbol(argument) : undefined;
        const value = argumentSymbol && bindings.has(argumentSymbol) ? bindings.get(argumentSymbol)! : depth === 0 ? argument.getText() : render(argument, bindings);
        let name = `__effectArgument${index}`;
        while (occupied.includes(name)) name += "_";
        occupied += " " + name;
        argumentsText.push(value);
        parametersText.push(`${name}: ${this.checker.typeToString(this.checker.getTypeAtLocation(argument))}`);
        next.set(this.checker.getSymbolAtLocation(parameter.name)!, name);
      });
      active.add(symbol); helpers.push(symbol.name);
      const result = walk(body, next, depth + 1);
      active.delete(symbol);
      return argumentsText.length ? { ...result, value: `((${parametersText.join(", ")}) => (${result.value}))(${argumentsText.join(", ")})` } : result;
    };
    let result: HelperResult;
    try { result = { kind: "resolved", ...walk(node, new Map(), 0), helpers }; }
    catch (error) { if (!(error instanceof AnalysisFailure)) throw error; result = { kind: error.kind, reason: error.message }; }
    this.helperCache.set(node, result);
    return result;
  }
}

class AnalysisFailure extends Error { constructor(readonly kind: "unproven" | "analysis-limit", message: string) { super(message); } }
function literal(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind);
}
function inert(node: ts.Expression): boolean { return ts.isIdentifier(node) || literal(node) || (ts.isArrowFunction(node) && !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)); }

function primitiveType(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnion()) return type.types.every((part) => primitiveType(part, checker));
  if (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)) return true;
  const constraint = checker.getBaseConstraintOfType(type);
  return Boolean(constraint && constraint !== type && primitiveType(constraint, checker));
}
