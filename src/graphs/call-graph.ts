import {
  CallExpression,
  Node,
  Project,
  SourceFile,
  SyntaxKind,
  ts,
} from "ts-morph";
import { getStableNodeId } from "./stable-id";

export interface CallGraphNode {
  id: string;
  name: string;
  calls: Set<string>;
}

export interface SerializedCallGraphNode {
  id: string;
  name: string;
  calls: string[];
}

export type CallGraph = Map<string, CallGraphNode>;

export interface BuildCallGraphOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;

  /**
   * Files matching these path fragments will never be traversed as callers.
   *
   * Callees from these files can still appear in the graph when called by
   * included source files.
   */
  excludePathIncludes?: string[];
}

const DEFAULT_EXCLUDE_PATH_INCLUDES = [
  "/node_modules/",
  "\\node_modules\\",

  // Prevent this analyzer project from analyzing itself.
  "/js-ts-tools/",
  "\\js-ts-tools\\",
];

export function buildCallGraph(options: BuildCallGraphOptions): CallGraph {
  const project = new Project({
    tsConfigFilePath: options.tsConfigFilePath ?? "tsconfig.json",
  });

  const sourceFiles = project.addSourceFilesAtPaths(options.sourceGlob);

  const excludePathIncludes = [
    ...DEFAULT_EXCLUDE_PATH_INCLUDES,
    ...(options.excludePathIncludes ?? []),
  ];

  return buildCallGraphFromSourceFiles(
    project,
    sourceFiles.filter((sourceFile) =>
      shouldTraverseSourceFile(sourceFile, excludePathIncludes),
    ),
  );
}

export function buildCallGraphFromSourceFiles(
  project: Project,
  sourceFiles: readonly SourceFile[],
): CallGraph {
  const typeChecker = project.getTypeChecker().compilerObject;
  const graph: CallGraph = new Map();

  for (const sourceFile of sourceFiles) {
    for (const fn of getFunctionLikeNodes(sourceFile)) {
      const callerName = getFunctionLikeName(fn);
      if (!callerName) continue;

      const callerId = getNodeStableId(fn, callerName);

      if (!graph.has(callerId)) {
        graph.set(callerId, {
          id: callerId,
          name: callerName,
          calls: new Set(),
        });
      }

      fn.forEachDescendant((node) => {
        if (Node.isCallExpression(node)) {
          const callee = getCalleeInfo(node, typeChecker);

          if (callee) {
            graph.get(callerId)!.calls.add(callee.id);
          }

          return;
        }

        if (Node.isNewExpression(node)) {
          const callee = getNewExpressionInfo(node, typeChecker);

          if (callee) {
            graph.get(callerId)!.calls.add(callee.id);
          }

          return;
        }
      });
    }
  }

  return graph;
}

function shouldTraverseSourceFile(
  sourceFile: SourceFile,
  excludePathIncludes: string[],
): boolean {
  const filePath = sourceFile.getFilePath();

  return !excludePathIncludes.some((excludedPath) =>
    filePath.includes(excludedPath),
  );
}

function getFunctionLikeNodes(sourceFile: SourceFile): Node[] {
  const nodes: Node[] = [];

  sourceFile.forEachDescendant((node) => {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      nodes.push(node);
    }
  });

  return nodes;
}

function getFunctionLikeName(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node)) {
    return node.getName();
  }

  if (Node.isMethodDeclaration(node)) {
    const className = node
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    const methodName = node.getName();

    return className ? `${className}.${methodName}` : methodName;
  }

  if (Node.isConstructorDeclaration(node)) {
    const className = node
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    return className ? `${className}.constructor` : "constructor";
  }

  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    const className = node
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    const accessorName = node.getName();

    return className ? `${className}.${accessorName}` : accessorName;
  }

  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();

    if (Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }

    if (Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }

    if (Node.isBinaryExpression(parent)) {
      return parent.getLeft().getText();
    }
  }

  return undefined;
}


function getNameFromDeclaration(declaration: Node): string | undefined {
  if (Node.isFunctionDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isClassDeclaration(declaration)) {
  return declaration.getName();
}

  if (Node.isMethodDeclaration(declaration)) {
    const className = declaration
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    return className
      ? `${className}.${declaration.getName()}`
      : declaration.getName();
  }

  if (Node.isConstructorDeclaration(declaration)) {
    const className = declaration
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    return className ? `${className}.constructor` : "constructor";
  }

  if (Node.isVariableDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isPropertyDeclaration(declaration)) {
    const className = declaration
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    return className
      ? `${className}.${declaration.getName()}`
      : declaration.getName();
  }

  return undefined;
}

/**
 * Use this only when you want to remove external API calls.
 *
 * Do NOT use this if you want calls like Array.isArray, Parser.enterRule,
 * Node.isCallExpression, etc. to remain visible.
 */
export function pruneToInternalCalls(graph: CallGraph): CallGraph {
  const knownIds = new Set(graph.keys());
  const pruned: CallGraph = new Map();

  for (const [callerId, node] of graph) {
    pruned.set(callerId, {
      ...node,
      calls: new Set([...node.calls].filter((calleeId) => knownIds.has(calleeId))),
    });
  }

  return pruned;
}

interface CalleeInfo {
  id: string;
  name: string;
}

function getNodeStableId(node: Node, fallbackName: string): string {
  return getStableNodeId(node, fallbackName);
}

function getDeclarationStableId(
  declaration: Node,
  fallbackName: string,
): string {
  const name = getNameFromDeclaration(declaration) ?? fallbackName;
  return getStableNodeId(declaration, name);
}
function getCalleeInfo(
  call: CallExpression,
  typeChecker: ts.TypeChecker,
): CalleeInfo | undefined {
  const displayName = getCalleeDisplayName(call, typeChecker);

  if (!displayName) return undefined;

  const signatureDeclaration = getResolvedSignatureDeclaration(call, typeChecker);

  if (signatureDeclaration) {
    return {
      id: getCompilerDeclarationStableId(signatureDeclaration, displayName),
      name: displayName,
    };
  }

  const expression = call.getExpression();
  const symbol = expression.getSymbol();
  const resolvedSymbol = symbol?.getAliasedSymbol() ?? symbol;
  const declaration = resolvedSymbol?.getDeclarations()[0];

  if (declaration) {
    return {
      id: getDeclarationStableId(declaration, displayName),
      name: displayName,
    };
  }

  return {
    id: `external:${displayName}`,
    name: displayName,
  };
}

function getCalleeDisplayName(
  call: CallExpression,
  typeChecker: ts.TypeChecker,
): string | undefined {
  const signatureDeclaration = getResolvedSignatureDeclaration(call, typeChecker);

  if (signatureDeclaration) {
    const resolvedName = getNameFromCompilerDeclaration(signatureDeclaration);
    if (resolvedName) return resolvedName;
  }

  const expression = call.getExpression();
  const symbol = expression.getSymbol();
  const resolvedSymbol = symbol?.getAliasedSymbol() ?? symbol;

  if (resolvedSymbol) {
    const declaration = resolvedSymbol.getDeclarations()[0];

    if (declaration) {
      const resolvedName = getNameFromDeclaration(declaration);
      if (resolvedName) return resolvedName;
    }

    return resolvedSymbol.getName();
  }

  if (Node.isIdentifier(expression)) {
    return expression.getText();
  }

  if (Node.isPropertyAccessExpression(expression)) {
    return expression.getText();
  }

  return undefined;
}

function getNewExpressionInfo(
  node: Node,
  typeChecker: ts.TypeChecker,
): CalleeInfo | undefined {
  if (!Node.isNewExpression(node)) return undefined;

  const expression = node.getExpression();
  const displayName = `new ${expression.getText()}`;

  const signatureDeclaration = getResolvedSignatureDeclaration(node, typeChecker);

  if (signatureDeclaration) {
    return {
      id: getCompilerDeclarationStableId(
        signatureDeclaration,
        expression.getText(),
      ),
      name: displayName,
    };
  }

  const symbol = expression.getSymbol();
  const resolvedSymbol = symbol?.getAliasedSymbol() ?? symbol;
  const declaration = resolvedSymbol?.getDeclarations()[0];

  if (declaration) {
    return {
      id: getDeclarationStableId(declaration, expression.getText()),
      name: displayName,
    };
  }

  return {
    id: `external:${displayName}`,
    name: displayName,
  };
}

export function callGraphToJson(graph: CallGraph): SerializedCallGraphNode[] {
  return [...graph.values()]
    .map((node) => ({
      id: node.id,
      name: node.name,
      calls: [...node.calls].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getResolvedSignatureDeclaration(
  callLike: CallExpression | Node,
  typeChecker: ts.TypeChecker,
): ts.Declaration | undefined {
  if (!Node.isCallExpression(callLike) && !Node.isNewExpression(callLike)) {
    return undefined;
  }

  const signature = typeChecker.getResolvedSignature(
    callLike.compilerNode as ts.CallLikeExpression,
  );

  return signature?.declaration;
}

function getCompilerDeclarationStableId(
  declaration: ts.Declaration,
  fallbackName: string,
): string {
  const sourceFile = declaration.getSourceFile();
  const start = ts.getLineAndCharacterOfPosition(
    sourceFile,
    declaration.getStart(sourceFile),
  );

  const name = getNameFromCompilerDeclaration(declaration) ?? fallbackName;

  return [
    sourceFile.fileName,
    start.line + 1,
    start.character + 1,
    name,
  ].join(":");
}

function getNameFromCompilerDeclaration(
  declaration: ts.Declaration,
): string | undefined {
  if (ts.isFunctionDeclaration(declaration)) {
    return declaration.name?.getText();
  }

  if (ts.isClassDeclaration(declaration)) {
    return declaration.name?.getText();
  }

  if (ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration)) {
    const className = getCompilerClassName(declaration);
    const methodName = declaration.name.getText();

    return className ? `${className}.${methodName}` : methodName;
  }

  if (ts.isConstructorDeclaration(declaration)) {
    const className = getCompilerClassName(declaration);

    return className ? `${className}.constructor` : "constructor";
  }

  if (
    ts.isGetAccessorDeclaration(declaration) ||
    ts.isSetAccessorDeclaration(declaration)
  ) {
    const className = getCompilerClassName(declaration);
    const accessorName = declaration.name.getText();

    return className ? `${className}.${accessorName}` : accessorName;
  }

  if (ts.isVariableDeclaration(declaration)) {
    return declaration.name.getText();
  }

  if (
    ts.isPropertyDeclaration(declaration) ||
    ts.isPropertySignature(declaration)
  ) {
    const className = getCompilerClassName(declaration);
    const propertyName = declaration.name.getText();

    return className ? `${className}.${propertyName}` : propertyName;
  }

  return undefined;
}

function getCompilerClassName(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isClassDeclaration(current)) {
      return current.name?.getText();
    }

    current = current.parent;
  }

  return undefined;
}
