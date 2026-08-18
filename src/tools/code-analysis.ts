import path from "node:path";
import {
  Node,
  Project,
  type SourceFile,
} from "ts-morph";
import { buildCallGraphFromSourceFiles } from "../graphs/call-graph";
import {
  buildDefinitionUseGraphFromSourceFiles,
  type DefinitionUseRecord,
} from "../graphs/definition-use-graph";
import { getNearestOwnerName, getOwnerName } from "../graphs/helpers";
import { buildOwnerReferenceGraphFromSourceFiles } from "../graphs/owner-reference-graph";
import { getStableNodeId, parseStableNodeId } from "../graphs/stable-id";
import type {
  ImpactDirection,
  ImpactNode,
  ImpactPath,
  ImpactPathStep,
  ImpactRelation,
  ImpactedNode,
} from "./code-impact";

export interface AnalysisSourceOptions {
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  cwd?: string;
}

export interface IndexedDeclaration {
  node: ImpactNode;
  declaration: Node;
  simpleName: string;
  qualifiedName: string;
  logicalKey: string;
  aliases: string[];
}

export interface AnalysisEdge {
  fromId: string;
  toId: string;
  relation: ImpactRelation;
  evidence?: string;
  location?: {
    filePath: string;
    line: number;
    column: number;
  };
}

export interface CodeAnalysisWorkspace {
  project: Project;
  cwd: string;
  tsConfigFilePath: string;
  sourceGlobs: string[];
  testGlobs: string[];
  exclusions: string[];
  sourceFiles: SourceFile[];
  selectedPaths: Set<string>;
  explicitTestPaths: Set<string>;
  index: IndexedDeclaration[];
  nodes: Map<string, ImpactNode>;
  edges: AnalysisEdge[];
  outgoing: Map<string, AnalysisEdge[]>;
  incoming: Map<string, AnalysisEdge[]>;
  normalizeId(id: string): string;
}

interface MutableImpact {
  node: ImpactNode;
  paths: Map<Exclude<ImpactDirection, "both">, ImpactPath>;
  relations: Set<ImpactRelation>;
}

export interface AnalysisTraversalOptions {
  targetIds: Iterable<string>;
  direction: ImpactDirection;
  maxDepth: number;
  maxNodes: number;
}

export interface AnalysisTraversalResult {
  impacted: ImpactedNode[];
  truncated: boolean;
}

const TEST_FILE_RE =
  /(?:^|[\\/])(?:__tests__|__mocks__|test|tests|spec|mocks)(?:[\\/]|$)|(?:\.|-)(?:test|spec|mock|fixture)\.[cm]?[jt]sx?$/i;

export function createCodeAnalysisWorkspace(
  options: AnalysisSourceOptions,
): CodeAnalysisWorkspace {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const tsConfigFilePath = path.resolve(cwd, options.tsConfigFilePath ?? "tsconfig.json");
  const sourceGlobs = asArray(options.sourceGlob);
  const testGlobs = asArray(options.testSourceGlob);
  const exclusions = options.excludePathIncludes ?? [];
  const project = new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: true });
  const primaryFiles = addRequiredGlobs(project, sourceGlobs, exclusions, "source");
  const explicitTestFiles = addRequiredGlobs(project, testGlobs, exclusions, "test source");
  const sourceFiles = uniqueSourceFiles([...primaryFiles, ...explicitTestFiles]);
  const selectedPaths = new Set<string>(sourceFiles.map((sourceFile) => sourceFile.getFilePath()));
  const explicitTestPaths = new Set<string>(explicitTestFiles.map((sourceFile) => sourceFile.getFilePath()));

  for (const sourceFile of project.getSourceFiles()) {
    if (!selectedPaths.has(sourceFile.getFilePath())) project.removeSourceFile(sourceFile);
  }

  const index = buildDeclarationIndex(sourceFiles, explicitTestPaths);
  const aliasToCanonical = new Map<string, string>();
  const nodes = new Map<string, ImpactNode>();
  for (const entry of index) {
    nodes.set(entry.node.id, entry.node);
    for (const alias of entry.aliases) aliasToCanonical.set(alias, entry.node.id);
  }
  const normalizeId = (id: string): string => aliasToCanonical.get(id) ?? id;
  const ensureNode = (rawId: string, fallback: Partial<ImpactNode> = {}): ImpactNode => {
    const id = normalizeId(rawId);
    const existing = nodes.get(id);
    if (existing) return existing;
    const parsed = parseStableNodeId(rawId);
    const filePath = fallback.filePath ?? parsed?.filePath;
    const external = rawId.startsWith("external:") ||
      Boolean(filePath && !selectedPaths.has(filePath));
    const name = fallback.name ?? parsed?.name ?? rawId.replace(/^external:/, "");
    const created: ImpactNode = {
      id,
      name,
      qualifiedName: fallback.qualifiedName ?? name,
      kind: fallback.kind ?? (external ? "External" : "Unknown"),
      filePath,
      line: fallback.line ?? parsed?.line,
      column: fallback.column ?? parsed?.column,
      external,
      test: Boolean(filePath && isTestFile(filePath, explicitTestPaths)),
    };
    nodes.set(id, created);
    aliasToCanonical.set(rawId, id);
    return created;
  };

  const edges: AnalysisEdge[] = [];
  const addEdge = (edge: AnalysisEdge): void => {
    const from = ensureNode(edge.fromId);
    const to = ensureNode(edge.toId);
    if (from.id !== to.id) edges.push({ ...edge, fromId: from.id, toId: to.id });
  };

  const callGraph = buildCallGraphFromSourceFiles(project, sourceFiles);
  for (const caller of callGraph.values()) {
    ensureNode(caller.id, { name: caller.name, qualifiedName: caller.name, kind: "Function" });
    for (const calleeId of caller.calls) {
      addEdge({
        fromId: caller.id,
        toId: calleeId,
        relation: "calls",
        evidence: `${caller.name} calls ${parseStableNodeId(calleeId)?.name ?? calleeId.replace(/^external:/, "")}`,
      });
    }
  }

  const referenceGraph = buildOwnerReferenceGraphFromSourceFiles(sourceFiles);
  for (const owner of referenceGraph.values()) {
    ensureNode(owner.id, { name: owner.name, qualifiedName: owner.name, kind: "Function" });
    for (const reference of owner.references.values()) {
      ensureNode(reference.id, { name: reference.name, qualifiedName: reference.name });
      addEdge({
        fromId: owner.id,
        toId: reference.id,
        relation: "references",
        evidence: `${owner.name} references ${reference.name}`,
      });
    }
  }

  const definitionUseGraph = buildDefinitionUseGraphFromSourceFiles(sourceFiles);
  for (const record of definitionUseGraph.values()) {
    ensureDefinitionNode(record, ensureNode);
    addDefinitionEdges(record, addEdge);
  }

  const uniqueEdges = dedupeAndSortEdges(edges);
  return {
    project,
    cwd,
    tsConfigFilePath,
    sourceGlobs,
    testGlobs,
    exclusions,
    sourceFiles,
    selectedPaths,
    explicitTestPaths,
    index,
    nodes,
    edges: uniqueEdges,
    outgoing: groupEdges(uniqueEdges, "fromId"),
    incoming: groupEdges(uniqueEdges, "toId"),
    normalizeId,
  };
}

export function resolveAnalysisTargets(
  workspace: CodeAnalysisWorkspace,
  symbol: string | undefined,
  filePath: string | undefined,
): IndexedDeclaration[] {
  const resolvedFilePath = filePath ? path.resolve(workspace.cwd, filePath) : undefined;
  if (resolvedFilePath && !workspace.selectedPaths.has(resolvedFilePath)) {
    throw new Error(`Target file is not part of the selected sources: ${resolvedFilePath}`);
  }
  const inFile = resolvedFilePath
    ? workspace.index.filter((entry) => entry.node.filePath === resolvedFilePath)
    : workspace.index;
  if (!symbol) {
    if (inFile.length === 0) {
      throw new Error(`No declarations found in target file: ${resolvedFilePath}`);
    }
    return inFile;
  }
  const matches = inFile.filter(
    (entry) => entry.simpleName === symbol || entry.qualifiedName === symbol,
  );
  if (matches.length === 0) {
    throw new Error(
      `Could not find symbol "${symbol}"${resolvedFilePath ? ` in ${resolvedFilePath}` : ""}.`,
    );
  }
  const groups = new Map<string, IndexedDeclaration[]>();
  for (const match of matches) {
    const group = groups.get(match.logicalKey) ?? [];
    group.push(match);
    groups.set(match.logicalKey, group);
  }
  if (groups.size > 1) {
    const candidates = [...groups.values()]
      .map((group) => group[0])
      .sort((left, right) => compareNodes(left.node, right.node))
      .map((entry) =>
        `${entry.qualifiedName} (${entry.node.filePath}:${entry.node.line}:${entry.node.column})`,
      );
    throw new Error(
      `Symbol "${symbol}" is ambiguous. Use --file or a qualified name. Candidates: ${candidates.join(", ")}`,
    );
  }
  return [...groups.values()][0];
}

export function uniqueLogicalTargets(
  targets: readonly IndexedDeclaration[],
): ImpactNode[] {
  return [...new Map(targets.map((target) => [target.logicalKey, target.node])).values()]
    .sort(compareNodes);
}

export function targetIdsFor(
  workspace: CodeAnalysisWorkspace,
  targets: readonly IndexedDeclaration[],
): Set<string> {
  return new Set(targets.flatMap((target) => target.aliases.map(workspace.normalizeId)));
}

export function traverseCodeAnalysis(
  workspace: CodeAnalysisWorkspace,
  options: AnalysisTraversalOptions,
): AnalysisTraversalResult {
  const targetIds = new Set([...options.targetIds].map(workspace.normalizeId));
  const impacts = new Map<string, MutableImpact>();
  let truncated = false;
  const traverse = (direction: Exclude<ImpactDirection, "both">): void => {
    const queue: Array<{ id: string; distance: number; steps: ImpactPathStep[] }> =
      [...targetIds].sort().map((id) => ({ id, distance: 0, steps: [] }));
    const visited = new Set(targetIds);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.distance >= options.maxDepth) continue;
      const candidates = direction === "outgoing"
        ? workspace.outgoing.get(current.id) ?? []
        : workspace.incoming.get(current.id) ?? [];
      for (const edge of candidates) {
        const nextId = direction === "outgoing" ? edge.toId : edge.fromId;
        if (visited.has(nextId)) continue;
        const nextNode = workspace.nodes.get(nextId);
        if (!nextNode) continue;
        if (!impacts.has(nextId) && impacts.size >= options.maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(nextId);
        const step: ImpactPathStep = {
          fromId: edge.fromId,
          toId: edge.toId,
          relation: edge.relation,
          direction,
          evidence: edge.evidence,
          location: edge.location,
        };
        const steps = [...current.steps, step];
        const impact = impacts.get(nextId) ?? {
          node: nextNode,
          paths: new Map(),
          relations: new Set(),
        };
        impact.paths.set(direction, { direction, distance: current.distance + 1, steps });
        impact.relations.add(edge.relation);
        impacts.set(nextId, impact);
        if (!nextNode.external) queue.push({ id: nextId, distance: current.distance + 1, steps });
      }
    }
  };
  if (options.direction === "incoming" || options.direction === "both") traverse("incoming");
  if (options.direction === "outgoing" || options.direction === "both") traverse("outgoing");
  for (const targetId of targetIds) impacts.delete(targetId);
  return {
    impacted: [...impacts.values()].map(toImpactedNode).sort(compareImpacts),
    truncated,
  };
}

export function findIndexEntryForDeclaration(
  workspace: CodeAnalysisWorkspace,
  declaration: Node,
): IndexedDeclaration | undefined {
  return workspace.index.find((entry) =>
    entry.declaration === declaration ||
    ((Node.isArrowFunction(entry.declaration) || Node.isFunctionExpression(entry.declaration)) &&
      entry.declaration.getParent() === declaration),
  );
}

export function compareNodes(left: ImpactNode, right: ImpactNode): number {
  return left.qualifiedName.localeCompare(right.qualifiedName) ||
    (left.filePath ?? "").localeCompare(right.filePath ?? "") ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.id.localeCompare(right.id);
}

export function isTestFile(filePath: string, explicitTestPaths: Set<string>): boolean {
  return explicitTestPaths.has(filePath) || TEST_FILE_RE.test(filePath);
}

export function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function addRequiredGlobs(
  project: Project,
  globs: string[],
  exclusions: string[],
  label: string,
): SourceFile[] {
  const result: SourceFile[] = [];
  for (const glob of globs) {
    const matches = project.addSourceFilesAtPaths(glob).filter((sourceFile) =>
      !exclusions.some((fragment) => sourceFile.getFilePath().includes(fragment)),
    );
    if (matches.length === 0) throw new Error(`No files matched ${label} glob: ${glob}`);
    result.push(...matches);
  }
  return uniqueSourceFiles(result);
}

function uniqueSourceFiles(files: SourceFile[]): SourceFile[] {
  return [...new Map(files.map((file) => [file.getFilePath(), file])).values()]
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
}

function buildDeclarationIndex(
  sourceFiles: readonly SourceFile[],
  explicitTestPaths: Set<string>,
): IndexedDeclaration[] {
  const symbolKeys = new WeakMap<object, string>();
  let nextSymbolKey = 0;
  const result: IndexedDeclaration[] = [];
  const add = (node: Node): void => {
    const names = getDeclarationNames(node);
    if (!names) return;
    const { simpleName, qualifiedName } = names;
    const canonicalId = getStableNodeId(node, qualifiedName);
    const aliases = [...new Set([canonicalId, getStableNodeId(node, simpleName)])];
    const sourceFile = node.getSourceFile();
    const location = sourceFile.getLineAndColumnAtPos(node.getStart());
    const symbolNode = (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) &&
      Node.isVariableDeclaration(node.getParent()) ? node.getParent()! : node;
    const symbolObject = symbolNode.getSymbol()?.compilerSymbol as object | undefined;
    let logicalKey = canonicalId;
    if (symbolObject) {
      const existing = symbolKeys.get(symbolObject);
      if (existing) logicalKey = existing;
      else {
        logicalKey = `symbol:${nextSymbolKey++}`;
        symbolKeys.set(symbolObject, logicalKey);
      }
    }
    result.push({
      simpleName,
      qualifiedName,
      logicalKey,
      aliases,
      declaration: node,
      node: {
        id: canonicalId,
        name: simpleName,
        qualifiedName,
        kind: node.getKindName(),
        filePath: sourceFile.getFilePath(),
        line: location.line,
        column: location.column,
        external: false,
        test: isTestFile(sourceFile.getFilePath(), explicitTestPaths),
      },
    });
  };
  for (const sourceFile of sourceFiles) {
    sourceFile.forEachDescendant((node) => {
      if (isIndexableDeclaration(node)) add(node);
    });
  }
  return result.sort((left, right) => compareNodes(left.node, right.node));
}

function isIndexableDeclaration(node: Node): boolean {
  return Node.isFunctionDeclaration(node) || Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) || Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) || Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node) ||
    Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) || Node.isEnumDeclaration(node) ||
    Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node) ||
    Node.isPropertyDeclaration(node) || Node.isPropertySignature(node);
}

function getDeclarationNames(
  node: Node,
): { simpleName: string; qualifiedName: string } | undefined {
  let simpleName: string | undefined;
  if (Node.isConstructorDeclaration(node)) simpleName = "constructor";
  else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) simpleName = getOwnerName(node);
  else if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) || Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) || Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) || Node.isVariableDeclaration(node) ||
    Node.isParameterDeclaration(node) || Node.isPropertyDeclaration(node) ||
    Node.isPropertySignature(node)) simpleName = node.getName();
  if (!simpleName) return undefined;
  if (simpleName.includes(".")) {
    return { simpleName: simpleName.split(".").at(-1)!, qualifiedName: simpleName };
  }
  const ownerName = (Node.isVariableDeclaration(node) || Node.isParameterDeclaration(node))
    ? getNearestOwnerName(node) : undefined;
  if (ownerName) return { simpleName, qualifiedName: `${ownerName}.${simpleName}` };
  const container = node.getFirstAncestor((ancestor) =>
    Node.isClassDeclaration(ancestor) || Node.isInterfaceDeclaration(ancestor));
  const containerName = container &&
    (Node.isClassDeclaration(container) || Node.isInterfaceDeclaration(container))
    ? container.getName() : undefined;
  return containerName
    ? { simpleName, qualifiedName: `${containerName}.${simpleName}` }
    : { simpleName, qualifiedName: simpleName };
}

function ensureDefinitionNode(
  record: DefinitionUseRecord,
  ensureNode: (id: string, fallback?: Partial<ImpactNode>) => ImpactNode,
): void {
  ensureNode(record.id, {
    name: record.name,
    qualifiedName: `${record.owner}.${record.name}`,
    kind: record.kind,
    filePath: record.declaredAt?.filePath,
    line: record.declaredAt?.line,
    column: record.declaredAt?.column,
  });
  if (record.ownerId) ensureNode(record.ownerId, {
    name: record.owner,
    qualifiedName: record.owner,
    kind: "Function",
  });
}

function addDefinitionEdges(
  record: DefinitionUseRecord,
  addEdge: (edge: AnalysisEdge) => void,
): void {
  for (const dependencyId of record.initializer?.dependencyIds ?? []) addEdge({
    fromId: record.id,
    toId: dependencyId,
    relation: "initializes_from",
    evidence: `${record.name} is initialized from ${record.initializer?.definedBy}`,
    location: record.declaredAt,
  });
  for (const assignment of record.assignments) {
    for (const dependencyId of assignment.dependencyIds ?? []) addEdge({
      fromId: record.id,
      toId: dependencyId,
      relation: "assigned_from",
      evidence: `${record.name} is assigned from ${assignment.definedBy}`,
      location: assignment.location,
    });
  }
  for (const readSite of record.readSites ?? []) {
    const ownerId = readSite.ownerId ?? record.ownerId;
    if (!ownerId) continue;
    addEdge({
      fromId: ownerId,
      toId: record.id,
      relation: "reads",
      evidence: `${record.owner} reads ${readSite.text}`,
      location: {
        filePath: readSite.filePath,
        line: readSite.line,
        column: readSite.column,
      },
    });
  }
}

function dedupeAndSortEdges(edges: AnalysisEdge[]): AnalysisEdge[] {
  return [...new Map(edges.map((edge) => [
    `${edge.fromId}\0${edge.toId}\0${edge.relation}`,
    edge,
  ])).values()].sort((left, right) =>
    left.fromId.localeCompare(right.fromId) ||
    left.toId.localeCompare(right.toId) ||
    left.relation.localeCompare(right.relation));
}

function groupEdges(
  edges: AnalysisEdge[],
  key: "fromId" | "toId",
): Map<string, AnalysisEdge[]> {
  const result = new Map<string, AnalysisEdge[]>();
  for (const edge of edges) {
    const group = result.get(edge[key]) ?? [];
    group.push(edge);
    result.set(edge[key], group);
  }
  return result;
}

function toImpactedNode(impact: MutableImpact): ImpactedNode {
  const paths = [...impact.paths.values()].sort((left, right) =>
    left.direction.localeCompare(right.direction));
  return {
    ...impact.node,
    distance: Math.min(...paths.map((item) => item.distance)),
    directions: paths.map((item) => item.direction),
    relations: [...impact.relations].sort(),
    paths,
  };
}

function compareImpacts(left: ImpactedNode, right: ImpactedNode): number {
  return left.distance - right.distance || compareNodes(left, right);
}
