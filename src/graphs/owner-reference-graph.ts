import {
  Identifier,
  Node,
  Project,
  SourceFile,
  SyntaxKind,
} from "ts-morph";
import { getStableNodeId } from "./stable-id";

export interface ReferenceInfo {
  id: string;
  name: string;
}

export interface ReferenceGraphNode {
  id: string;
  name: string;
  references: Map<string, ReferenceInfo>;
}

export interface SerializedReferenceGraphNode {
  id: string;
  name: string;
  references: ReferenceInfo[];
}

export type ReferenceGraph = Map<string, ReferenceGraphNode>;

export interface OwnerReferenceGraphOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];

  /**
   * If true, includes identifiers that come from import declarations.
   * Default: false
   */
  includeImports?: boolean;

  /**
   * If true, includes declaration-name identifiers themselves.
   * Usually noisy. Default: false
   */
  includeDeclarationNames?: boolean;
}

const DEFAULT_EXCLUDE_PATH_INCLUDES = [
  "/node_modules/",
  "\\node_modules\\",
  "/js-ts-tools/",
  "\\js-ts-tools\\",
];

export function buildOwnerReferenceGraph(
  options: OwnerReferenceGraphOptions,
): ReferenceGraph {
  const project = new Project({
    tsConfigFilePath: options.tsConfigFilePath ?? "tsconfig.json",
  });

  const sourceFiles = project.addSourceFilesAtPaths(options.sourceGlob);

  const excludePathIncludes = [
    ...DEFAULT_EXCLUDE_PATH_INCLUDES,
    ...(options.excludePathIncludes ?? []),
  ];

  return buildOwnerReferenceGraphFromSourceFiles(
    sourceFiles.filter((sourceFile) =>
      shouldTraverseSourceFile(sourceFile, excludePathIncludes),
    ),
    options,
  );
}

export function buildOwnerReferenceGraphFromSourceFiles(
  sourceFiles: readonly SourceFile[],
  options: Pick<
    OwnerReferenceGraphOptions,
    "includeImports" | "includeDeclarationNames"
  > = {},
): ReferenceGraph {
  const graph: ReferenceGraph = new Map();

  for (const sourceFile of sourceFiles) {
    for (const owner of getReferenceOwnerNodes(sourceFile)) {
      const ownerName = getReferenceOwnerName(owner);

      if (!ownerName) continue;

      const ownerId = getNodeStableId(owner, ownerName);

      if (!graph.has(ownerId)) {
        graph.set(ownerId, {
          id: ownerId,
          name: ownerName,
          references: new Map(),
        });
      }

      const graphNode = graph.get(ownerId)!;

      owner.forEachDescendant((node) => {
        if (!Node.isIdentifier(node)) return;

        if (!options.includeImports && isInsideImportDeclaration(node)) {
          return;
        }

        if (!options.includeDeclarationNames && isDeclarationName(node)) {
          return;
        }

        const reference = getReferenceInfo(node);

        if (!reference) return;

        graphNode.references.set(reference.id, reference);
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

function getReferenceOwnerNodes(sourceFile: SourceFile): Node[] {
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

function getReferenceOwnerName(node: Node): string | undefined {
  if (Node.isFunctionDeclaration(node)) {
    return node.getName();
  }

  if (Node.isMethodDeclaration(node)) {
    const className = node
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    return className ? `${className}.${node.getName()}` : node.getName();
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

    return className ? `${className}.${node.getName()}` : node.getName();
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

function getReferenceInfo(identifier: Identifier): ReferenceInfo | undefined {
  const displayName = getReferenceDisplayName(identifier);

  if (!displayName) return undefined;

  const symbol = identifier.getSymbol();
  const aliasedSymbol = symbol?.getAliasedSymbol();
  const resolvedSymbol = aliasedSymbol ?? symbol;

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

function getReferenceDisplayName(identifier: Identifier): string | undefined {
  const parent = identifier.getParent();

  /**
   * Prefer full property access:
   *
   * this.parser.document
   * BaseCharStreams.fromString
   * Buffer.isBuffer
   */
  if (Node.isPropertyAccessExpression(parent)) {
    if (parent.getNameNode() === identifier) {
      return parent.getText();
    }

    return undefined;
  }

  const symbol = identifier.getSymbol();

  if (symbol) {
    const aliasedSymbol = symbol.getAliasedSymbol();
    return aliasedSymbol?.getName() ?? symbol.getName();
  }

  return identifier.getText();
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

function getNameFromDeclaration(declaration: Node): string | undefined {
  if (Node.isFunctionDeclaration(declaration)) {
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

  if (Node.isClassDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isVariableDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isParameterDeclaration(declaration)) {
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

  if (Node.isInterfaceDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isTypeAliasDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isEnumDeclaration(declaration)) {
    return declaration.getName();
  }

  if (Node.isEnumMember(declaration)) {
    return declaration.getName();
  }

  return undefined;
}

function isInsideImportDeclaration(node: Node): boolean {
  return Boolean(node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration));
}

function isDeclarationName(identifier: Identifier): boolean {
  const parent = identifier.getParent();

  if (
    Node.isFunctionDeclaration(parent) ||
    Node.isMethodDeclaration(parent) ||
    Node.isVariableDeclaration(parent) ||
    Node.isParameterDeclaration(parent) ||
    Node.isClassDeclaration(parent) ||
    Node.isInterfaceDeclaration(parent) ||
    Node.isTypeAliasDeclaration(parent) ||
    Node.isPropertyDeclaration(parent) ||
    Node.isPropertyAssignment(parent) ||
    Node.isEnumDeclaration(parent) ||
    Node.isEnumMember(parent)
  ) {
    return parent.getNameNode() === identifier;
  }

  return false;
}

export function referenceGraphToJson(
  graph: ReferenceGraph,
): SerializedReferenceGraphNode[] {
  return [...graph.values()]
    .map((node) => ({
      id: node.id,
      name: node.name,
      references: [...node.references.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
