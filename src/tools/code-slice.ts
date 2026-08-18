import path from "node:path";
import {
  Node,
  SyntaxKind,
  type ImportDeclaration,
} from "ts-morph";
import { getStableNodeId } from "../graphs/stable-id";
import {
  asArray,
  compareNodes,
  createCodeAnalysisWorkspace,
  findIndexEntryForDeclaration,
  resolveAnalysisTargets,
  targetIdsFor,
  traverseCodeAnalysis,
  uniqueLogicalTargets,
  type CodeAnalysisWorkspace,
  type IndexedDeclaration,
} from "./code-analysis";
import type {
  ImpactDirection,
  ImpactNode,
  ImpactPathStep,
  ImpactRelation,
  ImpactedNode,
} from "./code-impact";

export type CodeSliceFormat = "json" | "markdown";
export type SliceRelation = ImpactRelation | "type_reference";
export type SlicePathKind = "incoming" | "outgoing" | "supporting";
export type SliceRole = "target" | "incoming" | "outgoing" | "supporting-type";

export interface CodeSliceLocation {
  filePath: string;
  line: number;
  column?: number;
}

export interface CreateCodeSliceOptions {
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  symbol?: string;
  filePath?: string;
  at?: CodeSliceLocation;
  direction?: ImpactDirection;
  maxDepth?: number;
  maxNodes?: number;
  cwd?: string;
}

export interface SlicePathStep {
  fromId: string;
  toId: string;
  relation: SliceRelation;
  direction: SlicePathKind;
  evidence?: string;
  location?: {
    filePath: string;
    line: number;
    column: number;
  };
}

export interface SlicePath {
  kind: SlicePathKind;
  distance: number;
  steps: SlicePathStep[];
}

export interface SliceSelection {
  node: ImpactNode;
  roles: SliceRole[];
  distance: number;
  directions: SlicePathKind[];
  relations: SliceRelation[];
  paths: SlicePath[];
  snippetIds: string[];
}

export interface SliceImport {
  text: string;
  moduleSpecifier: string;
  external: boolean;
  line: number;
  column: number;
  referencedBySnippetIds: string[];
}

export interface SliceSnippet {
  id: string;
  filePath: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
  selectionIds: string[];
}

export interface SliceFile {
  filePath: string;
  imports: SliceImport[];
  snippets: SliceSnippet[];
}

export interface SliceBoundary {
  node: ImpactNode;
  roles: SliceRole[];
  distance: number;
  directions: SlicePathKind[];
  relations: SliceRelation[];
  paths: SlicePath[];
}

export interface CodeSliceReport {
  query: {
    sourceGlob: string[];
    testSourceGlob: string[];
    tsConfigFilePath: string;
    excludePathIncludes: string[];
    symbol?: string;
    filePath?: string;
    at?: CodeSliceLocation;
    direction: ImpactDirection;
    maxDepth: number;
    maxNodes: number;
  };
  targets: ImpactNode[];
  selections: SliceSelection[];
  files: SliceFile[];
  boundaries: SliceBoundary[];
  impactedTests: SliceSelection[];
  summary: {
    targetCount: number;
    selectionCount: number;
    fileCount: number;
    snippetCount: number;
    impactedTestCount: number;
    externalCount: number;
    truncated: boolean;
  };
}

export interface FormatCodeSliceOptions {
  format?: CodeSliceFormat;
  pretty?: boolean;
}

export interface CreateCodeSliceFromWorkspaceOptions {
  symbol?: string;
  filePath?: string;
  at?: CodeSliceLocation;
  direction?: ImpactDirection;
  maxDepth?: number;
  maxNodes?: number;
}

interface MutableSelection {
  node: ImpactNode;
  entry?: IndexedDeclaration;
  roles: Set<SliceRole>;
  paths: Map<SlicePathKind, SlicePath>;
  relations: Set<SliceRelation>;
}

interface TypeDependency {
  node: ImpactNode;
  entry?: IndexedDeclaration;
}

export function createCodeSlice(options: CreateCodeSliceOptions): CodeSliceReport {
  validateOptions(options);
  const workspace = createCodeAnalysisWorkspace(options);
  const normalizedAt = options.at ? {
    filePath: path.resolve(workspace.cwd, options.at.filePath),
    line: options.at.line,
    column: options.at.column,
  } : undefined;
  const targets = normalizedAt
    ? resolveCodeSliceLocationTargets(workspace, normalizedAt)
    : resolveAnalysisTargets(workspace, options.symbol, options.filePath);
  return createCodeSliceFromWorkspace(workspace, targets, {
    symbol: options.symbol,
    filePath: options.filePath
      ? path.resolve(workspace.cwd, options.filePath)
      : undefined,
    at: normalizedAt,
    direction: options.direction,
    maxDepth: options.maxDepth,
    maxNodes: options.maxNodes,
  });
}

export function createCodeSliceFromWorkspace(
  workspace: CodeAnalysisWorkspace,
  targets: readonly IndexedDeclaration[],
  options: CreateCodeSliceFromWorkspaceOptions = {},
): CodeSliceReport {
  if (targets.length === 0) throw new Error("At least one code slice target is required.");
  const direction = options.direction ?? "both";
  const maxDepth = options.maxDepth ?? 2;
  const maxNodes = options.maxNodes ?? 50;
  const targetIds = targetIdsFor(workspace, targets);
  const targetNodes = uniqueLogicalTargets(targets);
  const traversal = traverseCodeAnalysis(workspace, {
    targetIds,
    direction,
    maxDepth,
    maxNodes,
  });

  const entryById = buildEntryMap(workspace);
  const selected = new Map<string, MutableSelection>();
  const boundaries = new Map<string, MutableSelection>();
  const logicalTargetIds = new Set(targetNodes.map((node) => node.id));
  for (const target of targetNodes) {
    const entry = entryById.get(target.id);
    selected.set(target.id, {
      node: target,
      entry,
      roles: new Set(["target"]),
      paths: new Map(),
      relations: new Set(),
    });
  }

  let remaining = maxNodes;
  let truncated = traversal.truncated;
  const supportQueue: Array<{
    source: MutableSelection;
    entry: IndexedDeclaration;
    steps: SlicePathStep[];
  }> = [];
  for (const target of selected.values()) {
    for (const entry of logicalEntriesFor(workspace, target.entry)) {
      supportQueue.push({ source: target, entry, steps: [] });
    }
  }
  const visitedSupportEdges = new Set<string>();

  const drainSupportingTypes = (): void => {
    while (supportQueue.length > 0) {
      const current = supportQueue.shift()!;
      for (const dependency of findTypeDependencies(workspace, current.entry)) {
        if (dependency.node.id === current.source.node.id) continue;
        const edgeKey = `${current.source.node.id}\0${dependency.node.id}`;
        if (visitedSupportEdges.has(edgeKey)) continue;
        visitedSupportEdges.add(edgeKey);
        const step: SlicePathStep = {
          fromId: current.source.node.id,
          toId: dependency.node.id,
          relation: "type_reference",
          direction: "supporting",
          evidence: `${current.source.node.qualifiedName} references type ${dependency.node.qualifiedName}`,
        };
        const steps = [...current.steps, step];
        const destination = dependency.node.external ? boundaries : selected;
        let selection = destination.get(dependency.node.id);
        if (!selection) {
          if (remaining === 0) {
            truncated = true;
            continue;
          }
          remaining -= 1;
          selection = {
            node: dependency.node,
            entry: dependency.entry,
            roles: new Set(["supporting-type"]),
            paths: new Map(),
            relations: new Set(),
          };
          destination.set(dependency.node.id, selection);
        } else {
          selection.roles.add("supporting-type");
        }
        selection.relations.add("type_reference");
        const existingPath = selection.paths.get("supporting");
        if (!existingPath || steps.length < existingPath.distance) {
          selection.paths.set("supporting", {
            kind: "supporting",
            distance: steps.length,
            steps,
          });
        }
        if (dependency.entry && !dependency.node.external) {
          supportQueue.push({ source: selection, entry: dependency.entry, steps });
        }
      }
    }
  };

  drainSupportingTypes();
  for (const impact of traversal.impacted) {
    if (logicalTargetIds.has(impact.id)) continue;
    const destination = impact.external ? boundaries : selected;
    let selection = destination.get(impact.id);
    if (!selection) {
      if (remaining === 0) {
        truncated = true;
        continue;
      }
      remaining -= 1;
      selection = {
        node: impact,
        entry: entryById.get(impact.id),
        roles: new Set(),
        paths: new Map(),
        relations: new Set(),
      };
      destination.set(impact.id, selection);
    }
    mergeImpact(selection, impact);
    if (selection.entry && !selection.node.external) {
      for (const entry of logicalEntriesFor(workspace, selection.entry)) {
        supportQueue.push({ source: selection, entry, steps: [] });
      }
      drainSupportingTypes();
    }
  }

  const internalSelections = [...selected.values()];
  const { files, snippetIdsBySelectionId } = buildFiles(workspace, internalSelections);
  const selections = internalSelections
    .map((selection) => serializeSelection(
      selection,
      snippetIdsBySelectionId.get(selection.node.id) ?? [],
    ))
    .sort(compareSelections);
  const serializedBoundaries = [...boundaries.values()]
    .map(serializeBoundary)
    .sort(compareBoundaries);
  const impactedTests = selections.filter((selection) =>
    selection.node.test && !selection.roles.includes("target"));

  return {
    query: {
      sourceGlob: workspace.sourceGlobs,
      testSourceGlob: workspace.testGlobs,
      tsConfigFilePath: workspace.tsConfigFilePath,
      excludePathIncludes: workspace.exclusions,
      symbol: options.symbol,
      filePath: options.filePath,
      at: options.at,
      direction,
      maxDepth,
      maxNodes,
    },
    targets: targetNodes,
    selections,
    files,
    boundaries: serializedBoundaries,
    impactedTests,
    summary: {
      targetCount: targetNodes.length,
      selectionCount: selections.length,
      fileCount: files.length,
      snippetCount: files.reduce((count, file) => count + file.snippets.length, 0),
      impactedTestCount: impactedTests.length,
      externalCount: serializedBoundaries.length,
      truncated,
    },
  };
}

export function formatCodeSlice(
  report: CodeSliceReport,
  options: FormatCodeSliceOptions = {},
): string {
  const format = options.format ?? "json";
  if (format !== "json" && format !== "markdown") {
    throw new Error(`Invalid code slice format: ${format}`);
  }
  if (format === "markdown" && options.pretty) {
    throw new Error("pretty is only supported with JSON output.");
  }
  const text = format === "json"
    ? JSON.stringify(report, null, options.pretty ? 2 : 0)
    : formatMarkdown(report);
  return `${text.replace(/\n+$/u, "")}\n`;
}

function validateOptions(options: CreateCodeSliceOptions): void {
  if (asArray(options.sourceGlob).length === 0) {
    throw new Error("At least one source glob is required.");
  }
  const hasNamedTarget = Boolean(options.symbol || options.filePath);
  if (!hasNamedTarget && !options.at) {
    throw new Error("Specify --symbol, --file, or --at.");
  }
  if (options.at && hasNamedTarget) {
    throw new Error("--at cannot be combined with --symbol or --file.");
  }
  if (options.direction && !["incoming", "outgoing", "both"].includes(options.direction)) {
    throw new Error(`Invalid slice direction: ${options.direction}`);
  }
  validateBound("maxDepth", options.maxDepth);
  validateBound("maxNodes", options.maxNodes);
  if (options.at) {
    if (!options.at.filePath) throw new Error("at.filePath is required.");
    if (!Number.isInteger(options.at.line) || options.at.line < 1) {
      throw new Error("at.line must be a positive integer.");
    }
    if (options.at.column !== undefined &&
      (!Number.isInteger(options.at.column) || options.at.column < 1)) {
      throw new Error("at.column must be a positive integer.");
    }
  }
}

function validateBound(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
}

export function resolveCodeSliceLocationTargets(
  workspace: CodeAnalysisWorkspace,
  location: CodeSliceLocation,
): IndexedDeclaration[] {
  if (!workspace.selectedPaths.has(location.filePath)) {
    throw new Error(`Target file is not part of the selected sources: ${location.filePath}`);
  }
  const sourceFile = workspace.project.getSourceFile(location.filePath);
  if (!sourceFile) throw new Error(`Target source file was not loaded: ${location.filePath}`);
  const lineStarts = sourceFile.compilerNode.getLineStarts();
  if (location.line > lineStarts.length) {
    throw new Error(`Target line is outside the source file: ${location.filePath}:${location.line}`);
  }
  const lineStart = lineStarts[location.line - 1];
  const nextLineStart = lineStarts[location.line] ?? sourceFile.getFullText().length;
  let position = lineStart;
  if (location.column !== undefined) {
    position = lineStart + location.column - 1;
    if (position >= nextLineStart || position > sourceFile.getFullText().length) {
      throw new Error(
        `Target column is outside the source line: ${location.filePath}:${location.line}:${location.column}`,
      );
    }
    let current = sourceFile.getDescendantAtPos(position);
    while (current) {
      const symbol = current.getSymbol();
      const resolved = symbol?.getAliasedSymbol() ?? symbol;
      if (resolved) {
        const matches = resolved.getDeclarations()
          .map((declaration) => findIndexEntryForDeclaration(workspace, declaration))
          .filter((entry): entry is IndexedDeclaration => Boolean(entry));
        if (matches.length > 0) {
          const logicalKey = matches[0].logicalKey;
          return workspace.index.filter((entry) => entry.logicalKey === logicalKey);
        }
      }
      current = current.getParent();
    }
  }
  const candidates = workspace.index.filter((entry) => {
    if (entry.node.filePath !== location.filePath) return false;
    const declaration = entry.declaration;
    if (location.column !== undefined) {
      return declaration.getStart() <= position && position < declaration.getEnd();
    }
    const start = sourceFile.getLineAndColumnAtPos(declaration.getStart()).line;
    const end = sourceFile.getLineAndColumnAtPos(declaration.getEnd()).line;
    return start <= location.line && location.line <= end;
  }).sort((left, right) => {
    const leftWidth = left.declaration.getEnd() - left.declaration.getStart();
    const rightWidth = right.declaration.getEnd() - right.declaration.getStart();
    return leftWidth - rightWidth || compareNodes(left.node, right.node);
  });
  if (candidates.length === 0) {
    throw new Error(
      `No sliceable declaration found at ${location.filePath}:${location.line}` +
      (location.column === undefined ? "." : `:${location.column}.`),
    );
  }
  return workspace.index.filter((entry) => entry.logicalKey === candidates[0].logicalKey);
}

function buildEntryMap(workspace: CodeAnalysisWorkspace): Map<string, IndexedDeclaration> {
  const result = new Map<string, IndexedDeclaration>();
  for (const entry of workspace.index) {
    result.set(entry.node.id, entry);
    for (const alias of entry.aliases) result.set(workspace.normalizeId(alias), entry);
  }
  return result;
}

function logicalEntriesFor(
  workspace: CodeAnalysisWorkspace,
  entry: IndexedDeclaration | undefined,
): IndexedDeclaration[] {
  if (!entry) return [];
  return workspace.index.filter((candidate) => candidate.logicalKey === entry.logicalKey);
}

function mergeImpact(selection: MutableSelection, impact: ImpactedNode): void {
  for (const direction of impact.directions) selection.roles.add(direction);
  for (const relation of impact.relations) selection.relations.add(relation);
  for (const impactPath of impact.paths) {
    const steps: SlicePathStep[] = impactPath.steps.map((step: ImpactPathStep) => ({
      ...step,
      direction: step.direction,
    }));
    selection.paths.set(impactPath.direction, {
      kind: impactPath.direction,
      distance: impactPath.distance,
      steps,
    });
  }
}

function findTypeDependencies(
  workspace: CodeAnalysisWorkspace,
  entry: IndexedDeclaration,
): TypeDependency[] {
  const dependencies = new Map<string, TypeDependency>();
  const declaration = entry.declaration;
  declaration.forEachDescendant((node) => {
    if (!Node.isIdentifier(node) || !isInTypeContext(node, declaration)) return;
    if (isDeclarationName(node)) return;
    const symbol = node.getSymbol();
    const resolved = symbol?.getAliasedSymbol() ?? symbol;
    const dependencyDeclaration = resolved?.getDeclarations()[0];
    if (!dependencyDeclaration) {
      const id = `external:${node.getText()}`;
      dependencies.set(id, {
        node: externalNode(id, node.getText()),
      });
      return;
    }
    if (dependencyDeclaration === declaration ||
      (declaration.getStart() <= dependencyDeclaration.getStart() &&
        dependencyDeclaration.getEnd() <= declaration.getEnd() &&
        dependencyDeclaration.getSourceFile() === declaration.getSourceFile())) return;
    const dependencyEntry = findIndexEntryForDeclaration(workspace, dependencyDeclaration);
    if (dependencyEntry) {
      dependencies.set(dependencyEntry.node.id, {
        node: dependencyEntry.node,
        entry: dependencyEntry,
      });
      return;
    }
    const name = resolved?.getName() ?? node.getText();
    const filePath = dependencyDeclaration.getSourceFile().getFilePath();
    const location = dependencyDeclaration.getSourceFile()
      .getLineAndColumnAtPos(dependencyDeclaration.getStart());
    const id = getStableNodeId(dependencyDeclaration, name);
    dependencies.set(id, {
      node: {
        id,
        name,
        qualifiedName: name,
        kind: dependencyDeclaration.getKindName(),
        filePath,
        line: location.line,
        column: location.column,
        external: true,
        test: false,
      },
    });
  });
  return [...dependencies.values()].sort((left, right) => compareNodes(left.node, right.node));
}

function isInTypeContext(node: Node, root: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current && current !== root) {
    if (Node.isTypeNode(current) ||
      current.getKind() === SyntaxKind.HeritageClause ||
      current.getKind() === SyntaxKind.ExpressionWithTypeArguments) return true;
    current = current.getParent();
  }
  return Node.isInterfaceDeclaration(root) || Node.isTypeAliasDeclaration(root);
}

function isDeclarationName(node: Node): boolean {
  const parent = node.getParent();
  const named = parent as Node & { getNameNode?: () => Node | undefined };
  return typeof named.getNameNode === "function" && named.getNameNode() === node;
}

function externalNode(id: string, name: string): ImpactNode {
  return {
    id,
    name,
    qualifiedName: name,
    kind: "External",
    external: true,
    test: false,
  };
}

function buildFiles(
  workspace: CodeAnalysisWorkspace,
  selections: MutableSelection[],
): { files: SliceFile[]; snippetIdsBySelectionId: Map<string, string[]> } {
  const promoted = selections.flatMap((selection) => {
    const entries = logicalEntriesFor(workspace, selection.entry);
    const nodes = entries.length > 0
      ? entries.map((entry) => promoteSnippetNode(entry.declaration))
      : [promoteSelectionNode(workspace, selection)];
    return nodes.filter((node): node is Node => Boolean(node)).map((node) => ({ selection, node }));
  });
  const candidateNodes = [...new Map(promoted.map(({ node }) => [
    `${node.getSourceFile().getFilePath()}:${node.getStart()}:${node.getEnd()}`,
    node,
  ])).values()];
  const roots = candidateNodes.filter((candidate) =>
    !candidateNodes.some((other) => other !== candidate &&
      other.getSourceFile() === candidate.getSourceFile() &&
      other.getStart() <= candidate.getStart() && candidate.getEnd() <= other.getEnd()));
  const snippetIdsBySelectionId = new Map<string, string[]>();
  const snippetNodes = roots.map((node) => {
    const sourceFile = node.getSourceFile();
    const start = sourceFile.getLineAndColumnAtPos(node.getStart());
    const end = sourceFile.getLineAndColumnAtPos(node.getEnd());
    const id = `${sourceFile.getFilePath()}:${start.line}:${start.column}-${end.line}:${end.column}`;
    const selectionIds = promoted
      .filter((item) => item.node.getSourceFile() === sourceFile &&
        node.getStart() <= item.node.getStart() && item.node.getEnd() <= node.getEnd())
      .map((item) => item.selection.node.id)
      .sort();
    for (const selectionId of selectionIds) {
      const ids = snippetIdsBySelectionId.get(selectionId) ?? [];
      ids.push(id);
      snippetIdsBySelectionId.set(selectionId, ids);
    }
    return {
      node,
      snippet: {
        id,
        filePath: sourceFile.getFilePath(),
        startLine: start.line,
        startColumn: start.column,
        endLine: end.line,
        endColumn: end.column,
        text: node.getText(),
        selectionIds,
      } satisfies SliceSnippet,
    };
  }).sort((left, right) =>
    left.snippet.filePath.localeCompare(right.snippet.filePath) ||
    left.snippet.startLine - right.snippet.startLine ||
    left.snippet.startColumn - right.snippet.startColumn);

  const byFile = new Map<string, typeof snippetNodes>();
  for (const snippet of snippetNodes) {
    const group = byFile.get(snippet.snippet.filePath) ?? [];
    group.push(snippet);
    byFile.set(snippet.snippet.filePath, group);
  }
  const files: SliceFile[] = [];
  for (const [filePath, items] of [...byFile].sort(([left], [right]) => left.localeCompare(right))) {
    const importReferences = new Map<string, { declaration: ImportDeclaration; snippetIds: Set<string> }>();
    for (const { node, snippet } of items) {
      node.forEachDescendant((descendant) => {
        if (!Node.isIdentifier(descendant)) return;
        for (const declaration of descendant.getSymbol()?.getDeclarations() ?? []) {
          const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
          if (!importDeclaration) continue;
          const key = `${importDeclaration.getStart()}:${importDeclaration.getEnd()}`;
          const reference = importReferences.get(key) ?? {
            declaration: importDeclaration,
            snippetIds: new Set(),
          };
          reference.snippetIds.add(snippet.id);
          importReferences.set(key, reference);
        }
      });
    }
    const imports = [...importReferences.values()].map(({ declaration, snippetIds }) => {
      const location = declaration.getSourceFile().getLineAndColumnAtPos(declaration.getStart());
      const moduleSpecifier = declaration.getModuleSpecifierValue();
      return {
        text: declaration.getText(),
        moduleSpecifier,
        external: !moduleSpecifier.startsWith(".") && !path.isAbsolute(moduleSpecifier),
        line: location.line,
        column: location.column,
        referencedBySnippetIds: [...snippetIds].sort(),
      };
    }).sort((left, right) => left.line - right.line || left.column - right.column);
    files.push({ filePath, imports, snippets: items.map((item) => item.snippet) });
  }
  for (const ids of snippetIdsBySelectionId.values()) ids.sort();
  return { files, snippetIdsBySelectionId };
}

function promoteSelectionNode(
  workspace: CodeAnalysisWorkspace,
  selection: MutableSelection,
): Node | undefined {
  if (selection.entry) return promoteSnippetNode(selection.entry.declaration);
  const filePath = selection.node.filePath;
  if (!filePath || selection.node.line === undefined) return undefined;
  const sourceFile = workspace.project.getSourceFile(filePath);
  if (!sourceFile) return undefined;
  const candidates = workspace.index.filter((entry) => {
    if (entry.node.filePath !== filePath) return false;
    const start = sourceFile.getLineAndColumnAtPos(entry.declaration.getStart());
    const end = sourceFile.getLineAndColumnAtPos(entry.declaration.getEnd());
    if (selection.node.line! < start.line || selection.node.line! > end.line) return false;
    if (selection.node.line === start.line && selection.node.column !== undefined &&
      selection.node.column < start.column) return false;
    return true;
  }).sort((left, right) =>
    (left.declaration.getEnd() - left.declaration.getStart()) -
      (right.declaration.getEnd() - right.declaration.getStart()) ||
    compareNodes(left.node, right.node));
  return candidates[0] ? promoteSnippetNode(candidates[0].declaration) : undefined;
}

function promoteSnippetNode(node: Node): Node {
  if (Node.isParameterDeclaration(node)) {
    return node.getFirstAncestor((ancestor) =>
      Node.isFunctionDeclaration(ancestor) || Node.isMethodDeclaration(ancestor) ||
      Node.isConstructorDeclaration(ancestor) || Node.isGetAccessorDeclaration(ancestor) ||
      Node.isSetAccessorDeclaration(ancestor) || Node.isArrowFunction(ancestor) ||
      Node.isFunctionExpression(ancestor)) ?? node;
  }
  if (Node.isVariableDeclaration(node)) {
    return node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const variableStatement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (variableStatement) return variableStatement;
    const property = node.getFirstAncestor((ancestor) =>
      Node.isPropertyDeclaration(ancestor) || Node.isPropertyAssignment(ancestor));
    if (property) return property;
  }
  return node;
}

function serializeSelection(
  selection: MutableSelection,
  snippetIds: string[],
): SliceSelection {
  const paths = [...selection.paths.values()].sort(comparePaths);
  return {
    node: selection.node,
    roles: [...selection.roles].sort(compareRoles),
    distance: paths.length === 0 ? 0 : Math.min(...paths.map((item) => item.distance)),
    directions: paths.map((item) => item.kind),
    relations: [...selection.relations].sort(),
    paths,
    snippetIds,
  };
}

function serializeBoundary(selection: MutableSelection): SliceBoundary {
  const paths = [...selection.paths.values()].sort(comparePaths);
  return {
    node: selection.node,
    roles: [...selection.roles].sort(compareRoles),
    distance: paths.length === 0 ? 0 : Math.min(...paths.map((item) => item.distance)),
    directions: paths.map((item) => item.kind),
    relations: [...selection.relations].sort(),
    paths,
  };
}

function compareRoles(left: SliceRole, right: SliceRole): number {
  const order: SliceRole[] = ["target", "incoming", "outgoing", "supporting-type"];
  return order.indexOf(left) - order.indexOf(right);
}

function comparePaths(left: SlicePath, right: SlicePath): number {
  const order: SlicePathKind[] = ["incoming", "outgoing", "supporting"];
  return order.indexOf(left.kind) - order.indexOf(right.kind) || left.distance - right.distance;
}

function compareSelections(left: SliceSelection, right: SliceSelection): number {
  return left.distance - right.distance || compareNodes(left.node, right.node);
}

function compareBoundaries(left: SliceBoundary, right: SliceBoundary): number {
  return left.distance - right.distance || compareNodes(left.node, right.node);
}

function formatMarkdown(report: CodeSliceReport): string {
  const lines: string[] = ["# Code Slice", ""];
  lines.push("## Summary", "");
  lines.push(
    `- Targets: ${report.summary.targetCount}`,
    `- Selected declarations: ${report.summary.selectionCount}`,
    `- Files: ${report.summary.fileCount}`,
    `- External boundaries: ${report.summary.externalCount}`,
    `- Truncated: ${report.summary.truncated ? "yes" : "no"}`,
    "",
    "## Targets",
    "",
  );
  for (const target of report.targets) {
    lines.push(`- \`${target.qualifiedName}\` — ${formatLocation(target)}`);
  }
  lines.push("", "## Selection paths", "");
  for (const selection of report.selections) {
    lines.push(`- \`${selection.node.qualifiedName}\` (${selection.roles.join(", ")})`);
    for (const selectionPath of selection.paths) {
      const evidence = selectionPath.steps.map((step) =>
        step.evidence ?? `${step.fromId} ${step.relation} ${step.toId}`).join(" → ");
      lines.push(`  - ${selectionPath.kind}, distance ${selectionPath.distance}: ${evidence}`);
    }
  }
  for (const file of report.files) {
    lines.push("", `## ${file.filePath}`, "");
    if (file.imports.length > 0) {
      lines.push(codeFence(file.imports.map((item) => item.text).join("\n"), file.filePath), "");
    }
    for (const snippet of file.snippets) {
      lines.push(`Lines ${snippet.startLine}–${snippet.endLine}`, "", codeFence(snippet.text, file.filePath), "");
    }
  }
  if (report.boundaries.length > 0) {
    lines.push("## External boundaries", "");
    for (const boundary of report.boundaries) {
      lines.push(`- \`${boundary.node.qualifiedName}\` (${boundary.relations.join(", ") || "external"})`);
    }
  }
  return lines.join("\n");
}

function codeFence(text: string, filePath: string): string {
  const fence = text.includes("```") ? "````" : "```";
  const language = /\.tsx?$/i.test(filePath) ? "ts" : /\.jsx?$/i.test(filePath) ? "js" : "";
  return `${fence}${language}\n${text}\n${fence}`;
}

function formatLocation(node: ImpactNode): string {
  if (!node.filePath) return "external";
  return `${node.filePath}:${node.line ?? 1}:${node.column ?? 1}`;
}
