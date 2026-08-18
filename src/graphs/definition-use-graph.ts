import {
    BinaryExpression,
    Identifier,
    Node,
    Project,
    SourceFile,
    SyntaxKind,
} from "ts-morph";
import {
    getNearestOwnerNode,
    getOwnerName,
} from "./helpers";
import { getStableNodeId } from "./stable-id";

export interface BuildDefinitionUseGraphOptions {
    sourceGlob: string | string[];
    tsConfigFilePath?: string;
    excludePathIncludes?: string[];
}

export interface DefinitionUseAssignment {
    definedBy: string;
    dependsOn: string[];
    dependencyIds?: string[];
    location: {
        filePath: string;
        line: number;
        column: number;
    };
}

export interface DefinitionUseReadSite {
    text: string;
    filePath: string;
    line: number;
    column: number;
    ownerId?: string;
}

export interface DefinitionUseRecord {
    id: string;
    name: string;
    owner: string;
    ownerId?: string;
    kind: "variable" | "parameter" | "property";
    declaredAt?: {
        filePath: string;
        line: number;
        column: number;
    };
    initializer?: {
        definedBy: string;
        dependsOn: string[];
        dependencyIds?: string[];
    };
    assignments: DefinitionUseAssignment[];
    reads: string[];
    readSites?: DefinitionUseReadSite[];
}


export type DefinitionUseGraph = Map<string, DefinitionUseRecord>;

const DEFAULT_EXCLUDE_PATH_INCLUDES = [
    "/node_modules/",
    "\\node_modules\\",
    "/js-ts-tools/",
    "\\js-ts-tools\\",
];

export function buildDefinitionUseGraph(
    options: BuildDefinitionUseGraphOptions,
): DefinitionUseGraph {
    const project = new Project({
        tsConfigFilePath: options.tsConfigFilePath ?? "tsconfig.json",
    });

    const sourceFiles = project.addSourceFilesAtPaths(options.sourceGlob);

    const excludePathIncludes = [
        ...DEFAULT_EXCLUDE_PATH_INCLUDES,
        ...(options.excludePathIncludes ?? []),
    ];

    return buildDefinitionUseGraphFromSourceFiles(
        sourceFiles.filter((sourceFile) =>
            shouldTraverseSourceFile(sourceFile, excludePathIncludes),
        ),
    );
}

export function buildDefinitionUseGraphFromSourceFiles(
    sourceFiles: readonly SourceFile[],
): DefinitionUseGraph {
    const graph: DefinitionUseGraph = new Map();

    for (const sourceFile of sourceFiles) {
        collectDefinitions(sourceFile, graph);
    }

    for (const sourceFile of sourceFiles) {
        collectUses(sourceFile, graph);
    }

    return graph;
}

function collectDefinitions(
    sourceFile: SourceFile,
    graph: DefinitionUseGraph,
): void {
    sourceFile.forEachDescendant((node) => {
        if (Node.isVariableDeclaration(node)) {
            const nameNode = node.getNameNode();

            if (!Node.isIdentifier(nameNode)) return;

            const ownerInfo = getOwnerInfo(node);
            if (!ownerInfo) return;
            const { name: owner, id: ownerId } = ownerInfo;

            const initializer = node.getInitializer();

            addDefinition(graph, {
                id: getSymbolDefinitionKey(nameNode, nameNode.getText(), owner),
                name: nameNode.getText(),
                owner,
                ownerId,
                kind: "variable",
                declaredAt: getDefinedAt(nameNode),
                initializer: initializer
                    ? {
                        definedBy: initializer.getText(),
                        dependsOn: getReferencedNames(initializer),
                        dependencyIds: getReferencedDefinitionIds(initializer, owner),
                    }
                    : undefined,
            });

            return;
        }

        if (Node.isParameterDeclaration(node)) {
            const nameNode = node.getNameNode();

            if (!Node.isIdentifier(nameNode)) return;

            const ownerInfo = getOwnerInfo(node);
            if (!ownerInfo) return;
            const { name: owner, id: ownerId } = ownerInfo;

            addDefinition(graph, {
                id: getSymbolDefinitionKey(nameNode, nameNode.getText(), owner),
                name: nameNode.getText(),
                owner,
                ownerId,
                kind: "parameter",
                declaredAt: getDefinedAt(nameNode),
            });

            return;
        }

        if (Node.isPropertyDeclaration(node)) {
            const nameNode = node.getNameNode();
            const name = node.getName();

            const className = node
                .getFirstAncestorByKind(SyntaxKind.ClassDeclaration)
                ?.getName();

            if (!className) return;

            const initializer = node.getInitializer();
            const owner = className;
            const ownerNode = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
            const ownerId = ownerNode
                ? getStableNodeId(ownerNode, owner)
                : undefined;

            addDefinition(graph, {
                id: getSymbolDefinitionKey(nameNode, name, owner),
                name,
                owner,
                ownerId,
                kind: "property",
                declaredAt: getDefinedAt(nameNode),
                initializer: initializer
                    ? {
                        definedBy: initializer.getText(),
                        dependsOn: getReferencedNames(initializer),
                        dependencyIds: getReferencedDefinitionIds(initializer, owner),
                    }
                    : undefined,
            });

            return;
        }

        if (Node.isBinaryExpression(node) && isAssignmentExpression(node)) {
            const left = node.getLeft();
            const right = node.getRight();
            const ownerInfo = getOwnerInfo(node);
            if (!ownerInfo) return;
            const { name: owner, id: ownerId } = ownerInfo;

            const name = normalizeDefinitionTarget(left);
            if (!name) return;

            addAssignment(graph, {
                id: getSymbolDefinitionKey(left, name, owner),
                name,
                owner,
                ownerId,
                definedBy: right.getText(),
                dependsOn: getReferencedNames(right),
                dependencyIds: getReferencedDefinitionIds(right, owner),
                location: getDefinedAt(left)!,
            });

            return;
        }
    });
}

function addDefinition(
    graph: DefinitionUseGraph,
    input: {
        id: string;
        name: string;
        owner: string;
        ownerId?: string;
        kind: DefinitionUseRecord["kind"];
        declaredAt?: DefinitionUseRecord["declaredAt"];
        initializer?: {
            definedBy: string;
            dependsOn: string[];
            dependencyIds?: string[];
        };
    },
): void {
    if (!graph.has(input.id)) {
        graph.set(input.id, {
            id: input.id,
            name: input.name,
            owner: input.owner,
            ownerId: input.ownerId,
            kind: input.kind,
            declaredAt: input.declaredAt,
            initializer: input.initializer,
            assignments: [],
            reads: [],
            readSites: [],
        });

        return;
    }

    const existing = graph.get(input.id)!;

    existing.ownerId = input.ownerId ?? existing.ownerId;
    existing.initializer = input.initializer ?? existing.initializer;
}

function collectUses(
    sourceFile: SourceFile,
    graph: DefinitionUseGraph,
): void {
    sourceFile.forEachDescendant((node) => {
        if (!Node.isIdentifier(node)) return;

        if (isDeclarationName(node)) return;
        if (isAssignmentLeftSide(node)) return;
        if (isInsideImportDeclaration(node)) return;

        const ownerInfo = getOwnerInfo(node);
        if (!ownerInfo) return;
        const { name: owner, id: ownerId } = ownerInfo;

        const referenceText = getReferenceText(node);
        if (!referenceText) return;

        const symbolKey = getSymbolDefinitionKey(node, referenceText, owner);

        if (graph.has(symbolKey)) {
            addRead(graph.get(symbolKey)!, node, ownerId);
            return;
        }

        const fallbackKey = getDefinitionKey(owner, referenceText);

        if (graph.has(fallbackKey)) {
            addRead(graph.get(fallbackKey)!, node, ownerId);
            return;
        }
    });

    for (const record of graph.values()) {
        record.reads = [...new Set(record.reads)].sort();
        record.readSites = [...new Map(
            (record.readSites ?? []).map((site) => [
                `${site.filePath}:${site.line}:${site.column}:${site.text}`,
                site,
            ]),
        ).values()].sort((left, right) =>
            left.filePath.localeCompare(right.filePath) ||
            left.line - right.line ||
            left.column - right.column ||
            left.text.localeCompare(right.text),
        );
    }
}

function addRead(
    record: DefinitionUseRecord,
    identifier: Identifier,
    ownerId?: string,
): void {
    const text = getUseSiteText(identifier);
    const location = getDefinedAt(identifier)!;
    record.reads.push(text);
    record.readSites ??= [];
    record.readSites.push({
        text,
        filePath: location.filePath,
        line: location.line,
        column: location.column,
        ownerId,
    });
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

function getDefinitionKey(owner: string, name: string): string {
    return `${owner}::${name}`;
}

function getOwnerInfo(node: Node): { name: string; id: string } | undefined {
    const ownerNode = getNearestOwnerNode(node);
    if (!ownerNode) return undefined;
    const name = getOwnerName(ownerNode);
    if (!name) return undefined;
    return { name, id: getStableNodeId(ownerNode, name) };
}

function getSymbolDefinitionKey(
    node: Node,
    fallbackName: string,
    fallbackOwner: string,
): string {
    const symbol = node.getSymbol();
    const resolvedSymbol = symbol?.getAliasedSymbol() ?? symbol;
    const declaration = resolvedSymbol?.getDeclarations()[0];

    if (!declaration) {
        return getDefinitionKey(fallbackOwner, fallbackName);
    }

    const declarationName = getDeclarationName(declaration) ?? fallbackName;
    return getStableNodeId(declaration, declarationName);
}

function getDeclarationName(node: Node): string | undefined {
    if (
        Node.isVariableDeclaration(node) ||
        Node.isParameterDeclaration(node) ||
        Node.isPropertyDeclaration(node) ||
        Node.isFunctionDeclaration(node) ||
        Node.isMethodDeclaration(node) ||
        Node.isClassDeclaration(node)
    ) {
        return node.getName();
    }

    return undefined;
}

function getDefinedAt(node: Node): DefinitionUseRecord["declaredAt"] {
    const sourceFile = node.getSourceFile();
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());

    return {
        filePath: sourceFile.getFilePath(),
        line: start.line,
        column: start.column,
    };
}

function isAssignmentExpression(node: BinaryExpression): boolean {
    return node.getOperatorToken().getText() === "=";
}

function normalizeDefinitionTarget(node: Node): string | undefined {
    if (Node.isIdentifier(node)) {
        return node.getText();
    }

    if (Node.isPropertyAccessExpression(node)) {
        return node.getText();
    }

    return undefined;
}

function getReferenceText(identifier: Identifier): string | undefined {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent)) {
        if (parent.getNameNode() === identifier) {
            return parent.getText();
        }

        return undefined;
    }

    return identifier.getText();
}

function getUseSiteText(identifier: Identifier): string {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent)) {
        return parent.getText();
    }

    return identifier.getText();
}

function getReferencedNames(node: Node): string[] {
    const names = new Set<string>();

    forEachReferencedIdentifier(node, (identifier) => {
        const referenceText = getReferenceText(identifier);

        if (referenceText) {
            names.add(referenceText);
        }
    });

    return [...names].sort();
}

function getReferencedDefinitionIds(node: Node, owner: string): string[] {
    const ids = new Set<string>();
    forEachReferencedIdentifier(node, (identifier) => {
        const referenceText = getReferenceText(identifier);
        if (!referenceText) return;
        ids.add(getSymbolDefinitionKey(identifier, referenceText, owner));
    });
    return [...ids].sort();
}

function forEachReferencedIdentifier(
    node: Node,
    callback: (identifier: Identifier) => void,
): void {
    const visit = (candidate: Node): void => {
        if (!Node.isIdentifier(candidate)) return;
        if (isDeclarationName(candidate)) return;
        if (isInsideImportDeclaration(candidate)) return;
        callback(candidate);
    };

    visit(node);
    node.forEachDescendant(visit);
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

function isAssignmentLeftSide(identifier: Identifier): boolean {
  const assignment = identifier.getFirstAncestorByKind(
    SyntaxKind.BinaryExpression,
  );

  if (!assignment || !Node.isBinaryExpression(assignment)) {
    return false;
  }

  if (!isAssignmentExpression(assignment)) {
    return false;
  }

  const left = assignment.getLeft();

  return (
    identifier.getPos() >= left.getPos() &&
    identifier.getEnd() <= left.getEnd()
  );
}

function isInsideImportDeclaration(node: Node): boolean {
    return Boolean(node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration));
}

export type SerializedDefinitionUseGraphNode = DefinitionUseRecord;

export function definitionUseGraphToJson(
    graph: DefinitionUseGraph,
): SerializedDefinitionUseGraphNode[] {
    return [...graph.values()].sort((a, b) => {
        const ownerCompare = a.owner.localeCompare(b.owner);
        if (ownerCompare !== 0) return ownerCompare;

        return a.name.localeCompare(b.name);
    });
}

function addAssignment(
    graph: DefinitionUseGraph,
    input: {
        id: string;
        name: string;
        owner: string;
        ownerId?: string;
        definedBy: string;
        dependsOn: string[];
        dependencyIds?: string[];
        location: DefinitionUseAssignment["location"];
    },
): void {
    if (!graph.has(input.id)) {
        graph.set(input.id, {
            id: input.id,
            name: input.name,
            owner: input.owner,
            ownerId: input.ownerId,
            kind: "variable",
            assignments: [],
            reads: [],
            readSites: [],
        });
    }

    graph.get(input.id)!.assignments.push({
        definedBy: input.definedBy,
        dependsOn: [...new Set(input.dependsOn)].sort(),
        dependencyIds: [...new Set(input.dependencyIds ?? [])].sort(),
        location: input.location,
    });
}
