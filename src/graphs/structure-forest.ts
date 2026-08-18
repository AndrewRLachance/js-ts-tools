import {
  Node,
  Project,
  SourceFile,
  SyntaxKind,
} from "ts-morph";

export interface BuildStructureTreeOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
}

export interface StructureTreeNode {
  id: string;
  kind: string;
  name?: string;
  text?: string;
  structure?: unknown;
  location: {
    filePath: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  children: StructureTreeNode[];
}

export interface StructureTreeFile {
  filePath: string;
  tree: StructureTreeNode;
}

const DEFAULT_EXCLUDE_PATH_INCLUDES = [
  "/node_modules/",
  "\\node_modules\\",
  "/js-ts-tools/",
  "\\js-ts-tools\\",
];

export function buildStructureTree(
  options: BuildStructureTreeOptions,
): StructureTreeFile[] {
  const project = new Project({
    tsConfigFilePath: options.tsConfigFilePath ?? "tsconfig.json",
  });

  const sourceFiles = project.addSourceFilesAtPaths(options.sourceGlob);

  const excludePathIncludes = [
    ...DEFAULT_EXCLUDE_PATH_INCLUDES,
    ...(options.excludePathIncludes ?? []),
  ];

  return sourceFiles
    .filter((sourceFile) => shouldTraverseSourceFile(sourceFile, excludePathIncludes))
    .map((sourceFile) => ({
      filePath: sourceFile.getFilePath(),
      tree: nodeToStructureTree(sourceFile),
    }));
}

function nodeToStructureTree(node: Node): StructureTreeNode {
  const location = getNodeLocation(node);
  const name = getNodeName(node);
  const structure = sanitizeStructure(getNodeStructure(node));

  return {
    id: getNodeStableId(node, name ?? node.getKindName()),
    kind: node.getKindName(),
    name,
    text: shouldIncludeText(node) ? node.getText() : undefined,
    structure,
    location,
    children: node.getChildren().map((child) => nodeToStructureTree(child)),
  };
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

function getNodeLocation(node: Node): StructureTreeNode["location"] {
  const sourceFile = node.getSourceFile();

  const start = sourceFile.getLineAndColumnAtPos(node.getStart());
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd());

  return {
    filePath: sourceFile.getFilePath(),
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function getNodeStableId(node: Node, fallbackName: string): string {
  const location = getNodeLocation(node);

  return [
    location.filePath,
    location.startLine,
    location.startColumn,
    fallbackName,
  ].join(":");
}

function getNodeName(node: Node): string | undefined {
  if (
    Node.isClassDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isVariableDeclaration(node) ||
    Node.isParameterDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isPropertyAssignment(node) ||
    Node.isEnumMember(node)
  ) {
    return node.getName();
  }

  if (Node.isConstructorDeclaration(node)) {
    const className = node
      .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
      ?.getName();

    return className ? `${className}.constructor` : "constructor";
  }

  if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    return node.getName();
  }

  return undefined;
}

function getNodeStructure(node: Node): unknown {
  const maybeStructuredNode = node as Node & {
    getStructure?: () => unknown;
  };

  if (typeof maybeStructuredNode.getStructure !== "function") {
    return undefined;
  }

  try {
    return maybeStructuredNode.getStructure();
  } catch {
    return undefined;
  }
}

function shouldIncludeText(node: Node): boolean {
  return (
    Node.isIdentifier(node) ||
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  );
}

function sanitizeStructure(structure: unknown): unknown {
  if (!structure || typeof structure !== "object") return structure;

  if (Array.isArray(structure)) {
    return structure.map(sanitizeStructure);
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(structure)) {
    if (key === "statements") continue;
    result[key] = sanitizeStructure(value);
  }

  return result;
}

export function structureTreeToJson(
  files: StructureTreeFile[],
): StructureTreeFile[] {
  return files;
}