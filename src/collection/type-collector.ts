import path from 'node:path'
import {
  type ClassDeclaration,
  type InterfaceDeclaration,
  Node,
  Project,
  type SourceFile,
  type Symbol as MorphSymbol,
  SyntaxKind,
  type TypeAliasDeclaration,
  type VariableDeclaration,
  type VariableStatement
} from 'ts-morph'

/**
 * Declarations callers are allowed to request as roots.
 */
export type RootDeclaration =
  | TypeAliasDeclaration
  | InterfaceDeclaration
  | ClassDeclaration

/**
 * Supporting declarations that are not roots themselves, but may be required
 * for a collected type to remain valid when emitted into a standalone file.
 *
 * Example:
 *
 *   declare const taggedType: unique symbol
 *
 *   type Tagged<T> = {
 *     readonly [taggedType]: T
 *   }
 */
export type SupportingDeclaration = VariableStatement

export type CollectedDeclaration =
  | RootDeclaration
  | SupportingDeclaration

export interface CollectAssociatedTypesOptions {
  /**
   * Names of root type aliases, interfaces, or abstract classes.
   */
  names: readonly string[]

  /**
   * Path to the tsconfig used to resolve the project and all referenced types.
   */
  tsConfigFilePath: string

  /**
   * File that declares or exports the requested root names.
   *
   * A relative path is resolved relative to the tsconfig directory.
   */
  sourceFilePath: string

  /**
   * Whether declarations from node_modules should be included in the closure.
   *
   * This defaults to true because a self-contained type graph may depend on
   * library types such as type-fest's Tagged and its unique-symbol support.
   *
   * TypeScript's own lib.*.d.ts files are controlled separately.
   *
   * @default true
   */
  includeNodeModules?: boolean

  /**
   * Whether TypeScript's standard library declarations should be collected.
   *
   * Normally keep this false. You generally want Promise<T>, Array<T>,
   * PropertyKey, etc. to remain standard-library references instead of copying
   * lib.es*.d.ts into the generated file.
   *
   * @default false
   */
  includeTypeScriptLibs?: boolean
}

export interface CollectAssociatedTypesResult {
  project: Project
  sourceFile: SourceFile
  roots: readonly RootDeclaration[]

  /**
   * Dependency-first, de-duplicated closure containing:
   * - type aliases
   * - interfaces
   * - abstract classes
   * - supporting unique-symbol variable statements
   */
  declarations: readonly CollectedDeclaration[]
}

interface TraversalOptions {
  includeNodeModules: boolean
  includeTypeScriptLibs: boolean
}

export function collectAssociatedTypes(
  options: CollectAssociatedTypesOptions
): CollectAssociatedTypesResult {
  if (options.names.length === 0) {
    throw new Error('At least one declaration name is required.')
  }

  const tsConfigFilePath = path.resolve(options.tsConfigFilePath)
  const sourceFilePath = path.isAbsolute(options.sourceFilePath)
    ? options.sourceFilePath
    : path.resolve(path.dirname(tsConfigFilePath), options.sourceFilePath)

  const project = new Project({
    tsConfigFilePath
  })

  const sourceFile =
    project.getSourceFile(sourceFilePath) ??
    project.addSourceFileAtPathIfExists(sourceFilePath)

  if (!sourceFile) {
    throw new Error(`Source file not found: ${sourceFilePath}`)
  }

  const roots = findRoots(sourceFile, options.names)

  const declarations = collectDependencyClosure(roots, {
    includeNodeModules: options.includeNodeModules ?? true,
    includeTypeScriptLibs: options.includeTypeScriptLibs ?? false
  })

  return {
    project,
    sourceFile,
    roots,
    declarations
  }
}

/**
 * Builds a dependency closure without recursively walking Type#getProperties()
 * or TypeScript's semantic object graph.
 *
 * Instead, it resolves identifiers appearing in each declaration and queues
 * only declaration kinds that can contribute to the standalone type surface.
 *
 * The work queue and dependency ordering are iterative, so dependency depth
 * cannot cause "Maximum call stack size exceeded".
 */
function collectDependencyClosure(
  roots: readonly RootDeclaration[],
  options: TraversalOptions
): CollectedDeclaration[] {
  const nodesByKey = new Map<string, CollectedDeclaration>()
  const dependenciesByKey = new Map<string, Set<string>>()

  const queued = new Set<string>()
  const queue: CollectedDeclaration[] = []

  const enqueue = (declaration: CollectedDeclaration): void => {
    if (!shouldIncludeDeclaration(declaration, options)) {
      return
    }

    const key = declarationKey(declaration)

    if (queued.has(key)) {
      return
    }

    queued.add(key)
    nodesByKey.set(key, declaration)
    queue.push(declaration)
  }

  for (const root of roots) {
    enqueue(root)
  }

  let queueIndex = 0

  while (queueIndex < queue.length) {
    const declaration = queue[queueIndex++]
    const key = declarationKey(declaration)

    const directDependencies = findDirectDependencies(declaration, options)
    const dependencyKeys = dependenciesByKey.get(key) ?? new Set<string>()

    for (const dependency of directDependencies) {
      const dependencyKey = declarationKey(dependency)

      if (dependencyKey === key) {
        continue
      }

      dependencyKeys.add(dependencyKey)
      enqueue(dependency)
    }

    dependenciesByKey.set(key, dependencyKeys)
  }

  return orderDependencyFirst(roots, nodesByKey, dependenciesByKey)
}

/**
 * Finds directly referenced declarations by resolving identifier symbols.
 *
 * This catches normal type references:
 *
 *   Foo
 *   Promise<Foo>
 *   Foo | Bar
 *   SomeGeneric<Foo>
 *
 * and also supporting value symbols used by the type system:
 *
 *   declare const taggedType: unique symbol
 *
 *   type Tagged<T> = {
 *     readonly [taggedType]: T
 *   }
 */
function findDirectDependencies(
  declaration: CollectedDeclaration,
  options: TraversalOptions
): CollectedDeclaration[] {
  const result = new Map<string, CollectedDeclaration>()

  const addSymbol = (symbol: MorphSymbol | undefined): void => {
    if (!symbol) {
      return
    }

    const resolvedSymbol = resolveAliasedSymbol(symbol)

    for (const candidate of resolvedSymbol.getDeclarations()) {
      const collected = toCollectedDeclaration(candidate)

      if (!collected) {
        continue
      }

      if (!shouldIncludeDeclaration(collected, options)) {
        continue
      }

      result.set(declarationKey(collected), collected)
    }
  }

  /*
   * Identifier-level symbol resolution is intentionally the primary traversal.
   * It follows import aliases and catches computed-property unique symbols,
   * which are not TypeReference nodes.
   */
  for (const identifier of declaration.getDescendantsOfKind(SyntaxKind.Identifier)) {
    addSymbol(identifier.getSymbol())
  }

  /*
   * Some declaration names are represented by nodes whose semantic type carries
   * an alias more reliably than the identifier symbol. Keep a narrow fallback
   * for explicit TypeReference syntax without recursively expanding the type.
   */
  for (const reference of declaration.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const type = reference.getType()

    addSymbol(type.getAliasSymbol())
    addSymbol(type.getSymbol())
  }

  result.delete(declarationKey(declaration))

  return [...result.values()].sort(compareDeclarations)
}

function resolveAliasedSymbol(symbol: MorphSymbol): MorphSymbol {
  let current = symbol
  const seen = new Set<object>()

  while (true) {
    const compilerSymbol = current.compilerSymbol as object

    if (seen.has(compilerSymbol)) {
      return current
    }

    seen.add(compilerSymbol)

    const aliased = current.getAliasedSymbol()

    if (!aliased || aliased.compilerSymbol === current.compilerSymbol) {
      return current
    }

    current = aliased
  }
}

function findRoots(
  sourceFile: SourceFile,
  names: readonly string[]
): RootDeclaration[] {
  const result: RootDeclaration[] = []
  const seen = new Set<string>()
  const exportedDeclarations = sourceFile.getExportedDeclarations()

  for (const name of names) {
    const matches: RootDeclaration[] = []

    for (const declaration of sourceFile.getTypeAliases()) {
      if (declaration.getName() === name) {
        matches.push(declaration)
      }
    }

    for (const declaration of sourceFile.getInterfaces()) {
      if (declaration.getName() === name) {
        matches.push(declaration)
      }
    }

    for (const declaration of sourceFile.getClasses()) {
      if (declaration.getName() === name && declaration.isAbstract()) {
        matches.push(declaration)
      }
    }

    /*
     * Allows sourceFilePath to point at a barrel/re-export file.
     */
    if (matches.length === 0) {
      for (const declaration of exportedDeclarations.get(name) ?? []) {
        if (isRootDeclaration(declaration)) {
          matches.push(declaration)
        }
      }
    }

    if (matches.length === 0) {
      const concreteClass = sourceFile
        .getClasses()
        .find((declaration) => declaration.getName() === name)

      if (concreteClass && !concreteClass.isAbstract()) {
        throw new Error(
          `"${name}" is a concrete class. ` +
            'Only type aliases, interfaces, and abstract classes may be roots.'
        )
      }

      throw new Error(
        `Could not find type alias, interface, or abstract class "${name}" ` +
          `in or exported from ${sourceFile.getFilePath()}.`
      )
    }

    for (const match of matches) {
      const key = declarationKey(match)

      if (!seen.has(key)) {
        seen.add(key)
        result.push(match)
      }
    }
  }

  return result
}

function isRootDeclaration(node: Node): node is RootDeclaration {
  return (
    Node.isTypeAliasDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    (Node.isClassDeclaration(node) && node.isAbstract())
  )
}

/**
 * Converts a symbol declaration into a declaration we want to place in the
 * generated standalone type file.
 *
 * Normal roots/dependencies are type aliases, interfaces, and abstract classes.
 *
 * A VariableDeclaration is promoted to its enclosing VariableStatement only
 * when that statement contains a `unique symbol` declaration. This preserves:
 *
 *   declare const taggedType: unique symbol
 *
 * instead of emitting the invalid fragment:
 *
 *   taggedType: unique symbol
 */
function toCollectedDeclaration(node: Node): CollectedDeclaration | undefined {
  if (isRootDeclaration(node)) {
    return node
  }

  if (Node.isVariableStatement(node)) {
    return containsUniqueSymbol(node) ? node : undefined
  }

  if (Node.isVariableDeclaration(node) && isUniqueSymbol(node)) {
    const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement)

    if (statement && containsUniqueSymbol(statement)) {
      return statement
    }
  }

  return undefined
}

function containsUniqueSymbol(statement: VariableStatement): boolean {
  return statement.getDeclarations().some(isUniqueSymbol)
}

function isUniqueSymbol(declaration: VariableDeclaration): boolean {
  const typeNode = declaration.getTypeNode()

  if (!typeNode) {
    return false
  }

  return normalizeWhitespace(typeNode.getText()) === 'unique symbol'
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function shouldIncludeDeclaration(
  declaration: CollectedDeclaration,
  options: TraversalOptions
): boolean {
  const sourceFile = declaration.getSourceFile()

  // ts-morph exposes the in-memory TypeScript standard library beneath a
  // node_modules-like path. Treat it independently from third-party packages,
  // as promised by the two public options.
  if (isTypeScriptLib(sourceFile)) {
    return options.includeTypeScriptLibs
  }

  if (!options.includeNodeModules && sourceFile.isInNodeModules()) {
    return false
  }

  return true
}

function isTypeScriptLib(sourceFile: SourceFile): boolean {
  if (!sourceFile.isDeclarationFile()) {
    return false
  }

  const filePath = sourceFile.getFilePath().replaceAll('\\', '/')

  return /\/typescript\/lib\/lib\..+\.d\.ts$/i.test(filePath)
}

export function declarationKey(declaration: CollectedDeclaration): string {
  return [
    declaration.getSourceFile().getFilePath(),
    declaration.getStart(),
    declaration.getKind()
  ].join(':')
}

function compareDeclarations(
  left: CollectedDeclaration,
  right: CollectedDeclaration
): number {
  const sourceComparison = left
    .getSourceFile()
    .getFilePath()
    .localeCompare(right.getSourceFile().getFilePath())

  if (sourceComparison !== 0) {
    return sourceComparison
  }

  return left.getStart() - right.getStart()
}

/**
 * Produces dependency-first output using an explicit stack.
 *
 * Type graphs may contain cycles (for example mutually recursive interfaces),
 * so visiting a currently-active node simply closes that cycle. The resulting
 * order is still deterministic and places acyclic dependencies before users.
 */
function orderDependencyFirst(
  roots: readonly RootDeclaration[],
  nodesByKey: ReadonlyMap<string, CollectedDeclaration>,
  dependenciesByKey: ReadonlyMap<string, ReadonlySet<string>>
): CollectedDeclaration[] {
  type State = 1 | 2

  interface Frame {
    key: string
    expanded: boolean
  }

  const state = new Map<string, State>()
  const output: CollectedDeclaration[] = []

  const visit = (startKey: string): void => {
    if (state.get(startKey) === 2) {
      return
    }

    const stack: Frame[] = [{ key: startKey, expanded: false }]

    while (stack.length > 0) {
      const frame = stack.pop()!
      const currentState = state.get(frame.key)

      if (frame.expanded) {
        if (currentState !== 2) {
          state.set(frame.key, 2)

          const node = nodesByKey.get(frame.key)

          if (node) {
            output.push(node)
          }
        }

        continue
      }

      if (currentState === 2) {
        continue
      }

      /*
       * A visiting node means we found a cycle. Do not recurse into it again.
       */
      if (currentState === 1) {
        continue
      }

      state.set(frame.key, 1)
      stack.push({ key: frame.key, expanded: true })

      const dependencies = [...(dependenciesByKey.get(frame.key) ?? [])]
        .filter((dependencyKey) => nodesByKey.has(dependencyKey))
        .sort((leftKey, rightKey) => {
          const left = nodesByKey.get(leftKey)!
          const right = nodesByKey.get(rightKey)!
          return compareDeclarations(left, right)
        })

      for (let index = dependencies.length - 1; index >= 0; index -= 1) {
        const dependencyKey = dependencies[index]

        if (state.get(dependencyKey) !== 2) {
          stack.push({
            key: dependencyKey,
            expanded: false
          })
        }
      }
    }
  }

  for (const root of roots) {
    visit(declarationKey(root))
  }

  /*
   * Normally every node is reachable from a root. Keep this pass so the result
   * remains complete if the traversal implementation changes later.
   */
  for (const key of [...nodesByKey.keys()].sort()) {
    visit(key)
  }

  return output
}
