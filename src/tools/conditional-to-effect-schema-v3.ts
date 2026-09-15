import * as path from "node:path"
import * as ts from "typescript"
import fg from "fast-glob"

/**
 * Convert synchronous throw-based validation code into Effect Schema v3 filters.
 *
 * Static mode is deliberately conservative. It follows TypeScript-resolved local
 * calls and only emits a filter when the rejection path can be represented as a
 * predicate over the root validator input. `auto` falls back to executing the
 * original validator inside Schema.filter when static conversion is not sound.
 */

export type ConversionMode = "static" | "runtime-wrapper" | "auto"

export interface ConvertConditionalToEffectSchemaV3Options {
  /** Simple or qualified validator name, e.g. "validateOrder" or "Order.validate". */
  readonly target: string
  /** Existing Effect v3 schema expression to refine, e.g. "OrderBase" or "Schema.Unknown". */
  readonly baseSchema: string
  /** Name for the generated schema constant. Defaults to <targetName>Schema. */
  readonly schemaName?: string
  readonly sourceGlob: string | readonly string[]
  readonly tsConfigFilePath?: string
  readonly excludePathIncludes?: readonly string[]
  readonly cwd?: string
  readonly mode?: ConversionMode
  readonly maxCallDepth?: number
  /**
   * Permit calls whose implementation is outside the selected project sources.
   * This is intentionally false by default because such a call may throw.
   */
  readonly allowOpaqueCalls?: boolean
}

export interface ThrowConstraint {
  /** Predicate that must be true for the filter to accept the input. */
  readonly successPredicate: string
  /** Predicate under which the original execution reaches this throw. */
  readonly failurePredicate: string
  readonly message: string
  readonly throwExpression: string
  readonly sourceFile: string
  readonly line: number
  readonly callPath: readonly string[]
}

export interface ConversionDiagnostic {
  readonly code:
    | "unsupported-target-arity"
    | "unsupported-destructured-parameter"
    | "unsupported-async"
    | "unsupported-generator"
    | "unresolved-call"
    | "opaque-call"
    | "recursive-call"
    | "max-call-depth"
    | "unsupported-control-flow"
    | "nonportable-expression"
    | "local-binding-in-guard"
    | "no-throws"
  readonly message: string
  readonly sourceFile?: string
  readonly line?: number
}

export interface ConvertConditionalToEffectSchemaV3Result {
  readonly mode: "static" | "runtime-wrapper"
  readonly target: string
  readonly schemaName: string
  readonly constraints: readonly ThrowConstraint[]
  readonly diagnostics: readonly ConversionDiagnostic[]
  readonly code: string
}

type SupportedFunction =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration

type Event =
  | { readonly kind: "call"; readonly node: ts.CallExpression }
  | { readonly kind: "throw"; readonly node: ts.ThrowStatement }
  | { readonly kind: "return"; readonly node: ts.ReturnStatement }

interface ParameterInfo {
  readonly name: string
  readonly node: ts.ParameterDeclaration
  readonly symbol: ts.Symbol
}

interface FunctionInfo {
  readonly node: SupportedFunction
  readonly key: string
  readonly name: string
  readonly qualifiedName: string
  readonly parameters: readonly ParameterInfo[]
  readonly sourceFile: ts.SourceFile
  readonly filePath: string
  readonly start: number
  readonly end: number
  readonly events: readonly Event[]
}

interface AstIndex {
  readonly checker: ts.TypeChecker
  readonly selectedFiles: ReadonlySet<string>
  readonly functions: readonly FunctionInfo[]
  readonly functionsByKey: ReadonlyMap<string, FunctionInfo>
}

interface PathGuard {
  readonly expression: ts.Expression
  readonly positive: boolean
}

interface WalkState {
  readonly fn: FunctionInfo
  readonly bindings: ReadonlyMap<ts.Symbol, string>
  readonly inheritedReachability: readonly string[]
  readonly callPath: readonly string[]
  readonly depth: number
}

interface RenderResult {
  readonly ok: boolean
  readonly text?: string
  readonly reason?: string
  readonly code?: "local-binding-in-guard" | "nonportable-expression"
}

interface PathResult {
  readonly ok: boolean
  readonly guards?: readonly PathGuard[]
  readonly reason?: string
}

const NODE_MODULES = /(?:^|[\\/])node_modules(?:[\\/]|$)/

function asArray(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return []
  return typeof value === "string" ? [value] : [...value]
}

function canonicalFile(filePath: string): string {
  return path.normalize(path.resolve(filePath))
}

function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile()
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function isSupportedFunction(node: ts.Node | undefined): node is SupportedFunction {
  return !!node && (
    ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  )
}

function hasBody(node: SupportedFunction): boolean {
  return node.body !== undefined
}

function nodeKey(node: ts.Node): string {
  const sf = node.getSourceFile()
  return `${canonicalFile(sf.fileName)}:${node.getStart(sf)}:${node.end}:${ts.SyntaxKind[node.kind]}`
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined, sf: ts.SourceFile): string | undefined {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return name.getText(sf)
}

function functionName(node: SupportedFunction): string {
  const sf = node.getSourceFile()
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>"
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return propertyNameText(node.name, sf) ?? "<anonymous>"
  }
  const parent = node.parent
  if (ts.isVariableDeclaration(parent)) return propertyNameText(parent.name, sf) ?? "<anonymous>"
  if (ts.isPropertyAssignment(parent)) return propertyNameText(parent.name, sf) ?? "<anonymous>"
  if (ts.isFunctionExpression(node) && node.name) return node.name.text
  return "<anonymous>"
}

function ownerPrefix(node: ts.Node): string[] {
  const parts: string[] = []
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      if (current.name) parts.unshift(current.name.text)
    } else if (ts.isModuleDeclaration(current)) {
      parts.unshift(current.name.getText(current.getSourceFile()).replace(/^['"]|['"]$/g, ""))
    } else if (ts.isObjectLiteralExpression(current)) {
      const p = current.parent
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) parts.unshift(p.name.text)
      else if (ts.isPropertyAssignment(p)) parts.unshift(propertyNameText(p.name, p.getSourceFile()) ?? "<object>")
    }
    current = current.parent
  }
  return parts
}

function qualifiedFunctionName(node: SupportedFunction, name: string): string {
  const prefix = ownerPrefix(node)
  return [...prefix, name].join(".")
}

function isNestedFunctionBoundary(node: ts.Node, root: SupportedFunction): boolean {
  return node !== root && isSupportedFunction(node)
}

/**
 * Collect execution-relevant nodes in a conservative evaluation order.
 * Post-order makes nested argument/condition calls appear before the outer call,
 * matching JavaScript evaluation order better than sorting by source start.
 */
function collectEvents(fn: SupportedFunction): Event[] {
  const events: Event[] = []
  if (!fn.body) return events

  const visit = (node: ts.Node): void => {
    if (isNestedFunctionBoundary(node, fn)) return
    if (ts.isThrowStatement(node)) {
      events.push({ kind: "throw", node })
      return
    }
    ts.forEachChild(node, visit)
    if (ts.isCallExpression(node)) events.push({ kind: "call", node })
    else if (ts.isReturnStatement(node)) events.push({ kind: "return", node })
  }

  visit(fn.body)
  return events
}

function readProgram(options: ConvertConditionalToEffectSchemaV3Options, selectedFiles: ReadonlySet<string>): ts.Program {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const requested = options.tsConfigFilePath ?? "tsconfig.json"
  const configPath = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested)
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath)
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"))
  }
  return ts.createProgram({
    rootNames: [...new Set([...parsed.fileNames, ...selectedFiles])],
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  })
}

function selectedSourceFiles(options: ConvertConditionalToEffectSchemaV3Options): ReadonlySet<string> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const files = fg.sync(asArray(options.sourceGlob), { cwd, absolute: true, onlyFiles: true, unique: true })
  return new Set(files.filter((file) => {
    const relative = path.relative(cwd, file).replace(/\\/g, "/")
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !NODE_MODULES.test(file)
      && !(options.excludePathIncludes ?? []).some((part) => file.includes(part) || relative.includes(part))
  }).map(canonicalFile))
}

function buildIndex(options: ConvertConditionalToEffectSchemaV3Options): AstIndex {
  const selectedFiles = selectedSourceFiles(options)
  const program = readProgram(options, selectedFiles)
  const checker = program.getTypeChecker()
  const functions: FunctionInfo[] = []
  const functionsByKey = new Map<string, FunctionInfo>()

  for (const sourceFile of program.getSourceFiles()) {
    if (!selectedFiles.has(canonicalFile(sourceFile.fileName))) continue

    const visit = (node: ts.Node): void => {
      if (isSupportedFunction(node) && hasBody(node)) {
        const name = functionName(node)
        const parameters: ParameterInfo[] = []
        for (const parameter of node.parameters) {
          if (!ts.isIdentifier(parameter.name)) continue
          const symbol = checker.getSymbolAtLocation(parameter.name)
          if (!symbol) continue
          parameters.push({ name: parameter.name.text, node: parameter, symbol })
        }
        const info: FunctionInfo = {
          node,
          key: nodeKey(node),
          name,
          qualifiedName: qualifiedFunctionName(node, name),
          parameters,
          sourceFile,
          filePath: canonicalFile(sourceFile.fileName),
          start: node.getStart(sourceFile),
          end: node.end,
          events: collectEvents(node),
        }
        functions.push(info)
        functionsByKey.set(info.key, info)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  return { checker, selectedFiles, functions, functionsByKey }
}

function resolveTarget(index: AstIndex, target: string): FunctionInfo {
  const exact = index.functions.filter((f) => f.qualifiedName === target)
  if (exact.length === 1) return exact[0]

  const simple = index.functions.filter((f) => f.name === target || f.qualifiedName.endsWith(`.${target}`))
  if (simple.length === 1) return simple[0]

  const candidates = [...new Set([...exact, ...simple].map((f) => `${f.qualifiedName} (${f.filePath}:${lineOf(f.node)})`))]
  if (candidates.length === 0) throw new Error(`Target function ${JSON.stringify(target)} was not found in the selected sources.`)
  throw new Error(`Target function ${JSON.stringify(target)} is ambiguous:\n${candidates.map((x) => `  - ${x}`).join("\n")}`)
}

function normalizeDeclaration(index: AstIndex, declaration: ts.Declaration | undefined): FunctionInfo | undefined {
  if (!declaration) return undefined
  if (isSupportedFunction(declaration)) return index.functionsByKey.get(nodeKey(declaration))
  if (ts.isVariableDeclaration(declaration) && declaration.initializer && isSupportedFunction(declaration.initializer)) {
    return index.functionsByKey.get(nodeKey(declaration.initializer))
  }
  if (ts.isPropertyAssignment(declaration) && isSupportedFunction(declaration.initializer)) {
    return index.functionsByKey.get(nodeKey(declaration.initializer))
  }
  return undefined
}

function deAlias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      return checker.getAliasedSymbol(symbol)
    } catch {
      return symbol
    }
  }
  return symbol
}

function calleeSymbol(index: AstIndex, call: ts.CallExpression): ts.Symbol | undefined {
  const checker = index.checker
  const expr = call.expression
  if (ts.isPropertyAccessExpression(expr)) {
    return deAlias(checker, checker.getSymbolAtLocation(expr.name) ?? checker.getSymbolAtLocation(expr))
  }
  return deAlias(checker, checker.getSymbolAtLocation(expr))
}

function resolveCallee(index: AstIndex, call: ts.CallExpression): FunctionInfo | undefined {
  const signature = index.checker.getResolvedSignature(call)
  const direct = normalizeDeclaration(index, signature?.declaration)
  if (direct) return direct

  const symbol = calleeSymbol(index, call)
  for (const declaration of symbol?.declarations ?? []) {
    const fn = normalizeDeclaration(index, declaration)
    if (fn) return fn
  }
  return undefined
}

function resolvedDeclarationFile(index: AstIndex, call: ts.CallExpression): string | undefined {
  const signature = index.checker.getResolvedSignature(call)
  const declaration = signature?.declaration ?? calleeSymbol(index, call)?.declarations?.[0]
  return declaration ? canonicalFile(declaration.getSourceFile().fileName) : undefined
}

function classifyUnresolvedCall(index: AstIndex, call: ts.CallExpression): "unresolved-call" | "opaque-call" {
  const file = resolvedDeclarationFile(index, call)
  return file && !index.selectedFiles.has(file) ? "opaque-call" : "unresolved-call"
}

function pathGuards(node: ts.Node, fn: FunctionInfo): PathResult {
  const guards: PathGuard[] = []
  let current: ts.Node = node

  while (current.parent && current.parent !== fn.node) {
    const parent = current.parent

    if (ts.isIfStatement(parent)) {
      if (current === parent.thenStatement) guards.unshift({ expression: parent.expression, positive: true })
      else if (current === parent.elseStatement) guards.unshift({ expression: parent.expression, positive: false })
    } else if (ts.isConditionalExpression(parent)) {
      if (current === parent.whenTrue) guards.unshift({ expression: parent.condition, positive: true })
      else if (current === parent.whenFalse) guards.unshift({ expression: parent.condition, positive: false })
    } else if (ts.isBinaryExpression(parent) && current === parent.right) {
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        guards.unshift({ expression: parent.left, positive: true })
      } else if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        guards.unshift({ expression: parent.left, positive: false })
      } else if (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        return { ok: false, reason: "nullish-coalescing reachability is not lifted statically" }
      }
    } else if (ts.isForStatement(parent)) {
      if (current !== parent.initializer) return { ok: false, reason: "for-loop reachability is not representable as a single refinement" }
    } else if (
      ts.isForInStatement(parent)
      || ts.isForOfStatement(parent)
      || ts.isWhileStatement(parent)
      || ts.isDoStatement(parent)
    ) {
      return { ok: false, reason: "loop reachability is not representable as a single refinement" }
    } else if (ts.isSwitchStatement(parent) || ts.isCaseBlock(parent) || ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
      return { ok: false, reason: "switch/case reachability is not lifted statically" }
    } else if (ts.isTryStatement(parent)) {
      if (current === parent.finallyBlock || current === parent.catchClause) {
        return { ok: false, reason: "catch/finally reachability depends on exceptional control flow" }
      }
      if (parent.finallyBlock && current === parent.tryBlock && ts.isReturnStatement(node)) {
        return { ok: false, reason: "return inside try/finally has non-local control-flow semantics" }
      }
    } else if (ts.isCatchClause(parent)) {
      return { ok: false, reason: "catch-clause reachability depends on exceptional control flow" }
    }

    current = parent
  }

  return { ok: true, guards }
}

function symbolDeclaredInside(symbol: ts.Symbol, fn: FunctionInfo): boolean {
  return (symbol.declarations ?? []).some((d) => {
    const sf = d.getSourceFile()
    if (canonicalFile(sf.fileName) !== fn.filePath) return false
    const start = d.getStart(sf)
    return start >= fn.start && d.end <= fn.end
  })
}

function declarationInsideExpression(symbol: ts.Symbol, expression: ts.Expression): boolean {
  const sf = expression.getSourceFile()
  const start = expression.getStart(sf)
  const end = expression.end
  return (symbol.declarations ?? []).some((d) => {
    if (d.getSourceFile() !== sf) return false
    const ds = d.getStart(sf)
    return ds >= start && d.end <= end
  })
}

function constInitializer(symbol: ts.Symbol, fn: FunctionInfo, before: number): ts.Expression | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (!ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isIdentifier(declaration.name)) continue
    if (canonicalFile(declaration.getSourceFile().fileName) !== fn.filePath) continue
    if (declaration.getStart(declaration.getSourceFile()) >= before) continue
    const list = declaration.parent
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) continue
    return declaration.initializer
  }
  return undefined
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment
}

function renderExpression(
  expression: ts.Expression,
  fn: FunctionInfo,
  bindings: ReadonlyMap<ts.Symbol, string>,
  checker: ts.TypeChecker,
  expansionStack: ReadonlySet<ts.Symbol> = new Set(),
): RenderResult {
  const sf = expression.getSourceFile()
  const rootStart = expression.getStart(sf)
  const source = expression.getText(sf)
  const edits: Array<{ start: number; end: number; text: string }> = []
  let failure: RenderResult | undefined

  const visit = (node: ts.Node): void => {
    if (failure) return

    if (ts.isPropertyAccessExpression(node)
      && checker.getSymbolAtLocation(node.name)?.declarations?.some(ts.isGetAccessorDeclaration)) {
      failure = { ok: false, code: "nonportable-expression", reason: "expression invokes a getter" }
      return
    }

    if (
      node.kind === ts.SyntaxKind.ThisKeyword
      || node.kind === ts.SyntaxKind.SuperKeyword
      || ts.isAwaitExpression(node)
      || ts.isYieldExpression(node)
      || ts.isDeleteExpression(node)
      || ts.isTaggedTemplateExpression(node)
      || ts.isCallExpression(node)
      || ts.isNewExpression(node)
      || ts.isFunctionLike(node)
      || ts.isClassExpression(node)
      || ts.isObjectLiteralExpression(node)
      || ts.isArrayLiteralExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
      || ts.isRegularExpressionLiteral(node)
    ) {
      failure = { ok: false, code: "nonportable-expression", reason: `expression contains ${ts.SyntaxKind[node.kind]}` }
      return
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      failure = { ok: false, code: "nonportable-expression", reason: "expression mutates state with an assignment" }
      return
    }
    if (ts.isPrefixUnaryExpression(node) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      failure = { ok: false, code: "nonportable-expression", reason: "expression mutates state with an update operator" }
      return
    }
    if (ts.isPostfixUnaryExpression(node)) {
      failure = { ok: false, code: "nonportable-expression", reason: "expression mutates state with an update operator" }
      return
    }

    if (ts.isIdentifier(node)) {
      if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return
      if (node.text === "arguments") {
        failure = { ok: false, code: "nonportable-expression", reason: "expression references arguments" }
        return
      }

      const symbol = checker.getSymbolAtLocation(node)
      if (!symbol) {
        failure = { ok: false, code: "nonportable-expression", reason: `unresolved identifier ${node.text}` }
        return
      }

      const binding = bindings.get(symbol)
      if (binding !== undefined) {
        if (ts.isShorthandPropertyAssignment(node.parent)) {
          failure = { ok: false, code: "nonportable-expression", reason: `cannot substitute ${node.text} inside an object shorthand` }
          return
        }
        edits.push({
          start: node.getStart(sf) - rootStart,
          end: node.end - rootStart,
          text: `(${binding})`,
        })
        return
      }

      if (symbolDeclaredInside(symbol, fn) && !declarationInsideExpression(symbol, expression)) {
        const initializer = constInitializer(symbol, fn, expression.getStart(sf))
        if (initializer && !expansionStack.has(symbol)) {
          const nextStack = new Set(expansionStack)
          nextStack.add(symbol)
          const rendered = renderExpression(initializer, fn, bindings, checker, nextStack)
          if (!rendered.ok) {
            failure = rendered
            return
          }
          edits.push({
            start: node.getStart(sf) - rootStart,
            end: node.end - rootStart,
            text: `(${rendered.text})`,
          })
          return
        }
        failure = {
          ok: false,
          code: "local-binding-in-guard",
          reason: `expression depends on local binding ${JSON.stringify(node.text)} that cannot be safely inlined`,
        }
        return
      }
      if (!["undefined", "NaN", "Infinity"].includes(node.text)
        || (symbol.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile)) {
        failure = { ok: false, code: "nonportable-expression", reason: `expression references external binding ${JSON.stringify(node.text)}` }
        return
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(expression)
  if (failure) return failure

  let text = source
  edits.sort((a, b) => b.start - a.start)
  for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return { ok: true, text }
}

function renderPathGuards(
  guards: readonly PathGuard[],
  fn: FunctionInfo,
  bindings: ReadonlyMap<ts.Symbol, string>,
  checker: ts.TypeChecker,
): RenderResult {
  const rendered: string[] = []
  for (const guard of guards) {
    const result = renderExpression(guard.expression, fn, bindings, checker)
    if (!result.ok) return result
    rendered.push(guard.positive ? `(${result.text})` : `!(${result.text})`)
  }
  return { ok: true, text: rendered.length === 0 ? "true" : rendered.join(" && ") }
}

function combineGuards(parts: readonly string[]): string {
  const usable = parts.filter((p) => p !== "true")
  if (usable.length === 0) return "true"
  return usable.map((p) => `(${p})`).join(" && ")
}

function throwMessage(node: ts.ThrowStatement): { expression: string; message: string } {
  const expression = node.expression
  if (!expression) return { expression: "throw", message: "Validation failed" }
  const sf = node.getSourceFile()
  const text = expression.getText(sf)

  if (ts.isStringLiteralLike(expression)) return { expression: text, message: expression.text }
  if (ts.isNewExpression(expression) || ts.isCallExpression(expression)) {
    const callee = expression.expression.getText(sf)
    const first = expression.arguments?.[0]
    if ((callee === "Error" || callee.endsWith("Error")) && first && ts.isStringLiteralLike(first)) {
      return { expression: text, message: first.text }
    }
  }
  return { expression: text, message: `Validation failed: throw ${text}` }
}

function isAsync(fn: SupportedFunction): boolean {
  return (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async) !== 0
}

function isGenerator(fn: SupportedFunction): boolean {
  return "asteriskToken" in fn && !!fn.asteriskToken
}

function returnsPromise(index: AstIndex, fn: SupportedFunction): boolean {
  const signature = index.checker.getSignatureFromDeclaration(fn)
  if (!signature) return false
  const returnType = index.checker.getReturnTypeOfSignature(signature)
  const types = returnType.isUnion() ? returnType.types : [returnType]
  return types.some((type) => index.checker.getPropertyOfType(type, "then") !== undefined)
}

/** Reject effects and control flow that the event walker does not model. */
function staticFunctionIssue(fn: FunctionInfo): string | undefined {
  if (fn.node.parameters.some((parameter) => parameter.initializer || parameter.dotDotDotToken)) {
    return "Default and rest parameters require runtime evaluation."
  }
  let issue: string | undefined
  const visit = (node: ts.Node): void => {
    if (issue || (isSupportedFunction(node) && node !== fn.node)) return
    // Evaluating a throw expression always rejects, even if its evaluation throws.
    if (ts.isThrowStatement(node)) return
    if (
      ts.isTryStatement(node) || ts.isIterationStatement(node, false)
      || ts.isSwitchStatement(node) || ts.isLabeledStatement(node)
      || ts.isWithStatement(node) || ts.isClassDeclaration(node)
      || ts.isClassExpression(node) || ts.isNewExpression(node)
      || ts.isTaggedTemplateExpression(node) || ts.isDeleteExpression(node)
      || ts.isAwaitExpression(node) || ts.isYieldExpression(node)
      || ts.isSpreadElement(node) || ts.isSpreadAssignment(node)
      || node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword
      || (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind))
      || ts.isPostfixUnaryExpression(node)
      || (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator))
      || (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) === 0)
      || (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name))
    ) {
      issue = `Static conversion cannot preserve ${ts.SyntaxKind[node.kind]} in ${fn.qualifiedName}.`
      return
    }
    if (ts.isCallExpression(node) && (
      node.questionDotToken || (node.flags & ts.NodeFlags.OptionalChain) !== 0
      || !(ts.isExpressionStatement(node.parent) || ts.isReturnStatement(node.parent))
    )) {
      issue = "Calls used as values or under expression-level control flow require runtime evaluation."
      return
    }
    ts.forEachChild(node, visit)
  }
  if (fn.node.body) visit(fn.node.body)
  return issue
}

function runtimeTargetIsCallable(fn: FunctionInfo): boolean {
  if (ts.isGetAccessorDeclaration(fn.node) || ts.isSetAccessorDeclaration(fn.node)) return false
  if (!fn.qualifiedName.split(".").every((part) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part))) return false
  let current: ts.Node = fn.node
  while (current.parent) {
    const parent = current.parent
    if (isSupportedFunction(parent)) return false
    if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
      && (!ts.isMethodDeclaration(current) || (ts.getCombinedModifierFlags(current) & ts.ModifierFlags.Static) === 0)) return false
    if (ts.isMethodDeclaration(current)
      && (ts.getCombinedModifierFlags(current) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) !== 0) return false
    current = parent
  }
  return true
}

function defaultSchemaName(target: string): string {
  const raw = `${target.split(".").at(-1) ?? "Generated"}Schema`
  return raw.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^[^A-Za-z_$]/, "_$&")
}

function validateSchemaName(name: string): void {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || name === "Schema" || ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, name).scan() !== ts.SyntaxKind.Identifier) throw new Error(`Invalid schemaName ${JSON.stringify(name)}.`)
}

function emitStaticCode(schemaName: string, baseSchema: string, constraints: readonly ThrowConstraint[]): string {
  const filters = constraints.map((constraint) => {
    const message = JSON.stringify(constraint.message)
    return `  Schema.filter((input) => (${constraint.successPredicate}) || ${message}),`
  })
  return [
    `import { Schema } from "effect"`,
    "",
    `export const ${schemaName} = (${baseSchema}).pipe(`,
    ...filters,
    ")",
    "",
  ].join("\n")
}

function emitRuntimeWrapperCode(schemaName: string, baseSchema: string, target: string): string {
  return [
    `import { Schema } from "effect"`,
    "",
    `export const ${schemaName} = (${baseSchema}).pipe(`,
    "  Schema.filter((input) => {",
    "    try {",
    `      ${target}(input)`,
    "      return true",
    "    } catch (error) {",
    "      return error instanceof Error ? error.message : String(error)",
    "    }",
    "  }),",
    ")",
    "",
  ].join("\n")
}

function blockingDiagnostics(diagnostics: readonly ConversionDiagnostic[]): boolean {
  return diagnostics.some((d) => d.code !== "no-throws")
}

function fatalAsyncDiagnostics(diagnostics: readonly ConversionDiagnostic[]): boolean {
  return diagnostics.some((d) => d.code === "unsupported-async" || d.code === "unsupported-generator")
}

function addDiagnostic(
  diagnostics: ConversionDiagnostic[],
  code: ConversionDiagnostic["code"],
  message: string,
  node?: ts.Node,
): void {
  diagnostics.push({
    code,
    message,
    sourceFile: node ? canonicalFile(node.getSourceFile().fileName) : undefined,
    line: node ? lineOf(node) : undefined,
  })
}

function dedupeConstraints(constraints: readonly ThrowConstraint[]): ThrowConstraint[] {
  const seen = new Set<string>()
  const out: ThrowConstraint[] = []
  for (const c of constraints) {
    const key = `${c.failurePredicate}\u0000${c.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

function functionArgumentPresent(index: AstIndex, call: ts.CallExpression): boolean {
  for (const arg of call.arguments) {
    const type = index.checker.getTypeAtLocation(arg)
    const alternatives = type.isUnion() ? type.types : [type]
    if (alternatives.some((alternative) => alternative.getCallSignatures().length > 0)) return true
  }
  return false
}

/**
 * Main conversion entry point.
 */
export function convertConditionalToEffectSchemaV3(
  options: ConvertConditionalToEffectSchemaV3Options,
): ConvertConditionalToEffectSchemaV3Result {
  const mode = options.mode ?? "static"
  if (!["static", "runtime-wrapper", "auto"].includes(mode)) throw new Error(`Invalid mode ${JSON.stringify(mode)}.`)
  if (!options.target.trim() || !options.baseSchema.trim()) throw new Error("target and baseSchema must not be empty.")
  if (asArray(options.sourceGlob).length === 0) throw new Error("sourceGlob must not be empty.")
  const maxCallDepth = options.maxCallDepth ?? 12
  if (!Number.isSafeInteger(maxCallDepth) || maxCallDepth < 0) throw new Error("maxCallDepth must be a non-negative integer.")

  const schemaName = options.schemaName ?? defaultSchemaName(options.target)
  validateSchemaName(schemaName)

  const diagnostics: ConversionDiagnostic[] = []
  const index = buildIndex(options)
  const target = resolveTarget(index, options.target)

  if (target.node.parameters.length !== 1) {
    addDiagnostic(diagnostics, "unsupported-target-arity", "Static and runtime-wrapper modes require a synchronous one-argument root validator.", target.node)
  }
  if (target.parameters.length !== target.node.parameters.length) {
    addDiagnostic(diagnostics, "unsupported-destructured-parameter", "Static conversion requires identifier parameters, not destructuring patterns.", target.node)
  }
  if (isAsync(target.node) || returnsPromise(index, target.node)) {
    addDiagnostic(diagnostics, "unsupported-async", "Async validators reject rather than synchronously throw; use an Effect-aware asynchronous schema such as v3 Schema.filterEffect instead.", target.node)
  }
  if (isGenerator(target.node)) {
    addDiagnostic(diagnostics, "unsupported-generator", "Generator validators execute on iteration rather than invocation and cannot be wrapped by a synchronous Schema.filter.", target.node)
  }

  if (fatalAsyncDiagnostics(diagnostics)) {
    throw new Error(diagnostics.map((d) => `[${d.code}] ${d.message}`).join("\n"))
  }

  const constraints: ThrowConstraint[] = []
  const activeCalls = new Set<string>()

  const walk = (state: WalkState): void => {
    if (state.depth > maxCallDepth) {
      addDiagnostic(diagnostics, "max-call-depth", `Maximum call depth ${maxCallDepth} reached at ${state.fn.qualifiedName}.`, state.fn.node)
      return
    }
    if (isAsync(state.fn.node) || returnsPromise(index, state.fn.node)) {
      addDiagnostic(diagnostics, "unsupported-async", `Reachable callee ${state.fn.qualifiedName} is async.`, state.fn.node)
      return
    }
    if (isGenerator(state.fn.node)) {
      addDiagnostic(diagnostics, "unsupported-generator", `Reachable callee ${state.fn.qualifiedName} is a generator.`, state.fn.node)
      return
    }

    const unsafe = staticFunctionIssue(state.fn)
    if (unsafe) {
      addDiagnostic(diagnostics, "unsupported-control-flow", unsafe, state.fn.node)
      return
    }

    const callIdentity = `${state.fn.key}|${[...state.bindings.entries()].map(([s, v]) => `${s.getName()}=${v}`).join(";")}`
    if (activeCalls.has(callIdentity)) {
      addDiagnostic(diagnostics, "recursive-call", `Recursive validation call detected along ${state.callPath.join(" -> ")}.`, state.fn.node)
      return
    }
    activeCalls.add(callIdentity)

    const continuation: string[] = []

    for (const event of state.fn.events) {
      const node = event.node
      const pathResult = pathGuards(node, state.fn)
      if (!pathResult.ok) {
        addDiagnostic(diagnostics, "unsupported-control-flow", `Cannot statically model ${event.kind} in ${state.fn.qualifiedName}: ${pathResult.reason}.`, node)
        continue
      }
      const renderedPath = renderPathGuards(pathResult.guards ?? [], state.fn, state.bindings, index.checker)
      if (!renderedPath.ok) {
        addDiagnostic(
          diagnostics,
          renderedPath.code ?? "nonportable-expression",
          `Cannot render reachability condition in ${state.fn.qualifiedName}: ${renderedPath.reason}.`,
          node,
        )
        continue
      }

      const eventReachability = combineGuards([
        ...state.inheritedReachability,
        ...continuation,
        renderedPath.text ?? "true",
      ])

      if (event.kind === "return") {
        // Within this function, normal execution continues only when the return's
        // local path guard is false. Inherited/cumulative guards are already in scope.
        continuation.push(`!(${renderedPath.text ?? "true"})`)
        continue
      }

      if (event.kind === "throw") {
        const throwNode = event.node
        const thrown = throwMessage(throwNode)
        const failurePredicate = eventReachability
        constraints.push({
          successPredicate: `!(${failurePredicate})`,
          failurePredicate,
          message: thrown.message,
          throwExpression: thrown.expression,
          sourceFile: state.fn.filePath,
          line: lineOf(throwNode),
          callPath: state.callPath,
        })
        // Chained Schema.filter refinements are sequential: a failed earlier
        // refinement prevents later refinements from being applied, matching throw.
        continue
      }

      const call = event.node

      const callee = resolveCallee(index, call)
      if (!callee) {
        const classification = classifyUnresolvedCall(index, call)
        if (classification === "unresolved-call" || !options.allowOpaqueCalls) {
          addDiagnostic(
            diagnostics,
            classification,
            `Cannot inspect possible throws from call ${call.expression.getText(call.getSourceFile())}. Widen sourceGlob or use mode: "auto"${classification === "opaque-call" ? ", or explicitly set allowOpaqueCalls: true" : ""}.`,
            call,
          )
        } else if (functionArgumentPresent(index, call)) {
          addDiagnostic(
            diagnostics,
            "unsupported-control-flow",
            `Opaque call ${call.expression.getText(call.getSourceFile())} receives a function value; callback invocation/reachability cannot be proven statically.`,
            call,
          )
        }
        continue
      }

      if (state.callPath.includes(callee.qualifiedName)) {
        addDiagnostic(diagnostics, "recursive-call", `Recursive call detected: ${[...state.callPath, callee.qualifiedName].join(" -> ")}.`, call)
        continue
      }

      if (callee.parameters.length !== callee.node.parameters.length) {
        addDiagnostic(diagnostics, "unsupported-destructured-parameter", `Callee ${callee.qualifiedName} uses a destructured parameter.`, callee.node)
        continue
      }

      const nextBindings = new Map<ts.Symbol, string>()
      let portable = true
      for (let i = 0; i < callee.parameters.length; i++) {
        const arg = call.arguments[i]
        const parameter = callee.parameters[i]
        if (!arg) {
          portable = false
          addDiagnostic(diagnostics, "nonportable-expression", `Call to ${callee.qualifiedName} omits argument ${parameter.name}; default/rest parameter semantics are not lifted statically.`, call)
          break
        }
        const rendered = renderExpression(arg, state.fn, state.bindings, index.checker)
        if (!rendered.ok) {
          portable = false
          addDiagnostic(diagnostics, rendered.code ?? "nonportable-expression", `Cannot substitute ${callee.qualifiedName}.${parameter.name}: ${rendered.reason}.`, call)
          break
        }
        nextBindings.set(parameter.symbol, rendered.text ?? arg.getText(arg.getSourceFile()))
      }
      if (!portable) continue

      walk({
        fn: callee,
        bindings: nextBindings,
        inheritedReachability: [eventReachability],
        callPath: [...state.callPath, callee.qualifiedName],
        depth: state.depth + 1,
      })
    }

    activeCalls.delete(callIdentity)
  }

  if (mode !== "runtime-wrapper" && !blockingDiagnostics(diagnostics)) {
    const rootBindings = new Map<ts.Symbol, string>()
    if (target.parameters[0]) rootBindings.set(target.parameters[0].symbol, "input")
    walk({
      fn: target,
      bindings: rootBindings,
      inheritedReachability: [],
      callPath: [target.qualifiedName],
      depth: 0,
    })
  }

  if (fatalAsyncDiagnostics(diagnostics)) {
    throw new Error(diagnostics.map((d) => `[${d.code}] ${d.message}`).join("\n"))
  }

  const uniqueConstraints = dedupeConstraints(constraints)
  if (mode !== "runtime-wrapper" && uniqueConstraints.length === 0 && !blockingDiagnostics(diagnostics)) {
    addDiagnostic(diagnostics, "no-throws", `No escaping synchronous throw statements were found from ${target.qualifiedName}.`, target.node)
  }

  const staticBlocked = blockingDiagnostics(diagnostics)
  const selectedMode: "static" | "runtime-wrapper" =
    mode === "runtime-wrapper" || (mode === "auto" && staticBlocked) ? "runtime-wrapper" : "static"

  if (selectedMode === "runtime-wrapper" && !runtimeTargetIsCallable(target)) {
    throw new Error("runtime-wrapper requires a named function or an accessible object/static method; instance methods and accessors need a one-argument adapter function.")
  }
  if (selectedMode === "runtime-wrapper" && target.node.parameters.length !== 1) {
    throw new Error("runtime-wrapper mode requires a one-argument root validator.")
  }

  if (selectedMode === "static" && staticBlocked) {
    throw new Error(
      `Static Effect Schema conversion is not semantics-preserving for ${options.target}.\n`
      + diagnostics.map((d) => `- [${d.code}] ${d.message}`).join("\n")
      + `\nUse mode: "auto" to fall back to a runtime wrapper, or widen/adjust the selected sources.`,
    )
  }

  return {
    mode: selectedMode,
    target: target.qualifiedName,
    schemaName,
    constraints: uniqueConstraints,
    diagnostics,
    code: selectedMode === "static"
      ? emitStaticCode(schemaName, options.baseSchema, uniqueConstraints)
      : emitRuntimeWrapperCode(schemaName, options.baseSchema, target.qualifiedName),
  }
}
