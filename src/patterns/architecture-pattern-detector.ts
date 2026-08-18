import {
  ClassDeclaration,
  FunctionDeclaration,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Project,
  PropertyDeclaration,
  SourceFile,
  SyntaxKind,
  Type,
} from "ts-morph";

import {
  classifyDetectionMode,
  defaultPatternDetectorConfig,
  annotatePatternIntersections,
} from "./pattern-core";

import type {
  BasePatternKey as PatternKey,
  CallGraph,
  CallGraphNode,
  CallGraphEvidence,
  DefinitionUseGraph,
  DefinitionUseRecord,
  GraphEvidence,
  PatternConfidence,
  PatternDetection,
  PatternDetectorConfig,
  PatternDetectorContext,
  SerializedCallGraphNode,
} from "./pattern-core";

type ScoreBucket = {
  localAstScore: number;
  typeCheckerScore: number;
  graphScore: number;
  callGraphScore: number;
  ambiguityPenalty: number;
  evidence: string[];
  matchedRules: string[];
  graphEvidence: GraphEvidence[];
  callGraphEvidence: CallGraphEvidence[];
};

type DetectorFn = (node: Node, ctx: RequiredContext) => PatternDetection[];

type RequiredContext = Omit<PatternDetectorContext, "config"> & {
  config: PatternDetectorConfig;
  interfaceImplementations: Map<string, ClassDeclaration[]>;
};

type BehavioralArrayMethod =
  | "map"
  | "filter"
  | "reduce"
  | "some"
  | "every"
  | "flatMap"
  | "forEach";

const BEHAVIORAL_ARRAY_METHODS = new Set<BehavioralArrayMethod>([
  "map",
  "filter",
  "reduce",
  "some",
  "every",
  "flatMap",
  "forEach",
]);

const PRIMITIVE_TYPE_TEXT = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "void",
  "unknown",
  "any",
  "never",
]);

const PATTERNS: PatternKey[] = [
  "pattern.singleton",
  "pattern.dependency_injection",
  "pattern.factory",
  "pattern.observer",
  "pattern.interface_based",
  "pattern.repository",
  "pattern.service",
  "pattern.strategy",
  "pattern.builder",
  "pattern.adapter",
  "pattern.facade",
  "pattern.decorator",
  "pattern.proxy",
  "pattern.command",
  "pattern.middleware",
  "pattern.event_emitter",
  "pattern.registry",
  "pattern.plugin",
  "pattern.mapper",
  "pattern.module_boundary",
  "pattern.unit_of_work",
];

export const patternScoringRules: Record<PatternKey, string[]> = {
  "pattern.singleton": [
    "restricted constructor",
    "static instance property",
    "static same-class accessor",
    "bounded shared access",
  ],
  "pattern.dependency_injection": [
    "constructor non-primitive dependencies",
    "parameter properties or parameter-to-property assignment",
    "decorator hints",
    "method usage of injected dependency",
  ],
  "pattern.factory": [
    "returns constructed object",
    "abstract/interface return type",
    "branching concrete construction",
    "factory-style callers",
  ],
  "pattern.observer": [
    "subscription API",
    "listener collection",
    "callback invocation loop",
    "registration-before-notification flow",
  ],
  "pattern.interface_based": [
    "interface declaration",
    "implementing classes",
    "interface-typed parameters/returns",
    "concrete flow into abstraction",
  ],
  "pattern.repository": [
    "CRUD API",
    "database/client/model dependency",
    "service usage",
    "repository-to-database calls",
  ],
  "pattern.service": [
    "service-style class",
    "boundary injection",
    "repository/client dependencies",
    "orchestration calls",
  ],
  "pattern.strategy": [
    "shared interface with multiple implementations",
    "consumer accepts abstraction",
    "selection through factory/registry",
    "common method calls",
  ],
  "pattern.builder": [
    "chainable methods",
    "state accumulation",
    "terminal build/create method",
    "product construction",
  ],
  "pattern.adapter": [
    "wraps external object",
    "implements target interface",
    "translation or delegation",
    "local interface consumption",
  ],
  "pattern.facade": [
    "simple public API",
    "multiple subsystem dependencies",
    "internal delegation",
    "boundary use of facade",
  ],
  "pattern.decorator": [
    "same-interface wrapping",
    "delegation to wrapped object",
    "before/after behavior",
    "compatible abstraction flow",
  ],
  "pattern.proxy": [
    "same/similar interface",
    "target wrapping",
    "guard/cache/lazy/remote behavior",
    "conditional delegation",
  ],
  "pattern.command": [
    "execute method",
    "action payload/dependencies",
    "dispatch/bus/handler usage",
    "deferred invocation",
  ],
  "pattern.middleware": [
    "req/res/next or context/next shape",
    "calls next",
    "pipeline registration",
    "continuation call graph",
  ],
  "pattern.event_emitter": [
    "on/off/once/emit API",
    "event-key listener store",
    "emit dispatch",
    "external registration and emission",
  ],
  "pattern.registry": [
    "register/resolve/get API",
    "keyed Map/object store",
    "dynamic lookup",
    "resolved downstream call",
  ],
  "pattern.plugin": [
    "plugin interface/lifecycle",
    "host registration",
    "lifecycle invocation",
    "extension registry",
  ],
  "pattern.mapper": [
    "mapper naming",
    "different parameter/return types",
    "object transformation",
    "boundary crossing usage",
  ],
  "pattern.module_boundary": [
    "barrel/index file",
    "re-exports",
    "public API surface",
    "external module consumption",
  ],
  "pattern.unit_of_work": [
    "transaction lifecycle",
    "multiple repositories",
    "shared transaction context",
    "commit/rollback wrapping",
  ],
};

function createBucket(): ScoreBucket {
  return {
    localAstScore: 0,
    typeCheckerScore: 0,
    graphScore: 0,
    callGraphScore: 0,
    ambiguityPenalty: 0,
    evidence: [],
    matchedRules: [],
    graphEvidence: [],
    callGraphEvidence: [],
  };
}

function add(
  bucket: ScoreBucket,
  area: keyof Pick<
    ScoreBucket,
    | "localAstScore"
    | "typeCheckerScore"
    | "graphScore"
    | "callGraphScore"
    | "ambiguityPenalty"
  >,
  points: number,
  rule: string,
  evidence?: string,
) {
  bucket[area] += points;
  bucket.matchedRules.push(rule);
  if (evidence) bucket.evidence.push(evidence);
}

function finalizeDetection(
  pattern: PatternKey,
  node: Node,
  bucket: ScoreBucket,
  ctx: RequiredContext,
): PatternDetection {
  const graphScore = Math.min(
    bucket.graphScore,
    ctx.config.graphScoreCapPerPattern,
  );
  const callGraphScore = Math.min(
    bucket.callGraphScore,
    ctx.config.callGraphScoreCapPerPattern,
  );
  let score =
    bucket.localAstScore +
    bucket.typeCheckerScore +
    graphScore +
    callGraphScore -
    bucket.ambiguityPenalty;
  if (
    bucket.localAstScore + bucket.typeCheckerScore < 2 &&
    score >= ctx.config.confidenceThresholds.high
  ) {
    score = ctx.config.confidenceThresholds.medium; // graph-only evidence must not create high confidence
    bucket.evidence.push(
      "High confidence suppressed: graph evidence cannot be the sole basis for architecture detection.",
    );
  }
  if (isNamingOnly(bucket)) {
    score = Math.min(score, ctx.config.confidenceThresholds.medium - 0.25);
    bucket.evidence.push(
      "Confidence capped: naming-only evidence is intentionally weak.",
    );
  }
  score = round(score);
  const confidence = classifyConfidence(score, ctx.config);
  return {
    pattern,
    detected: score >= ctx.config.confidenceThresholds.low,
    confidence,
    mode: classifyDetectionMode(confidence),
    score,
    filePath: getFilePath(node),
    nodeKind: getNodeKindName(node),
    nodeName: getNodeName(node),
    startLine: getStartLine(node),
    endLine: getEndLine(node),
    evidence: unique(bucket.evidence),
    matchedRules: unique(bucket.matchedRules),
    graphEvidence: bucket.graphEvidence.slice(
      0,
      ctx.config.graphMaxRecordsPerTraversal,
    ),
    callGraphEvidence: bucket.callGraphEvidence.slice(
      0,
      ctx.config.callGraphMaxCallsPerTraversal,
    ),
    intersectingPatterns: [],
    intersectionEvidence: [],
  };
}

function isNamingOnly(bucket: ScoreBucket): boolean {
  const nonNameRules = bucket.matchedRules.filter(
    (r) => !/name|suffix|decorator/i.test(r),
  );
  return (
    bucket.localAstScore > 0 &&
    nonNameRules.length === 0 &&
    bucket.typeCheckerScore === 0 &&
    bucket.graphScore === 0 &&
    bucket.callGraphScore === 0
  );
}

export function classifyConfidence(
  score: number,
  config: PatternDetectorConfig = defaultPatternDetectorConfig,
): PatternConfidence {
  if (score >= config.confidenceThresholds.high) return "high";
  if (score >= config.confidenceThresholds.medium) return "medium";
  return "low";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}
function lc(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}
function includesAny(text: string | undefined, words: string[]): boolean {
  const t = lc(text);
  return words.some((w) => t.includes(w));
}
function matchesAny(text: string | undefined, patterns: RegExp[]): boolean {
  const t = text ?? "";
  return patterns.some((p) => p.test(t));
}

export function getNodeName(node: Node): string {
  const anyNode = node as any;
  if (typeof anyNode.getName === "function")
    return anyNode.getName() || "<anonymous>";
  if (Node.isVariableDeclaration(node)) return node.getName();
  if (Node.isSourceFile(node)) return node.getBaseName();
  return "<anonymous>";
}

export function getNodeKindName(node: Node): string {
  return SyntaxKind[node.getKind()] ?? String(node.getKind());
}
export function getFilePath(node: Node): string {
  return node.getSourceFile().getFilePath();
}
export function getStartLine(node: Node): number {
  return node.getStartLineNumber();
}
export function getEndLine(node: Node): number {
  return node.getEndLineNumber();
}

export function getDecorators(node: Node): string[] {
  const anyNode = node as any;
  if (typeof anyNode.getDecorators !== "function") return [];
  return anyNode
    .getDecorators()
    .map((d: any) => d.getName?.() ?? d.getText())
    .filter(Boolean);
}

export function getMethodNames(cls: ClassDeclaration): string[] {
  return cls.getMethods().map((m) => m.getName());
}
export function getConstructorParameters(
  cls: ClassDeclaration,
): ParameterDeclaration[] {
  return cls.getConstructors().flatMap((c) => c.getParameters());
}
export function getReturnTypeText(
  node: MethodDeclaration | FunctionDeclaration,
): string {
  return node.getReturnType().getText(node);
}
export function getImplementedInterfaces(cls: ClassDeclaration): string[] {
  return cls.getImplements().map((i) => i.getText());
}
export function getBaseClassName(cls: ClassDeclaration): string | undefined {
  return cls.getExtends()?.getExpression().getText();
}
export function hasDecorator(node: Node, names: string[]): boolean {
  return getDecorators(node).some((d) => names.some((n) => lc(d) === lc(n)));
}

function isNonPrimitiveParameter(p: ParameterDeclaration): boolean {
  const text = p.getType().getText(p);
  return (
    !PRIMITIVE_TYPE_TEXT.has(text) &&
    !/^Array<|^ReadonlyArray<|\[\]$/.test(text)
  );
}

function isInterfaceType(type: Type): boolean {
  const sym = type.getSymbol() ?? type.getAliasSymbol();
  const decls = sym?.getDeclarations() ?? [];
  return decls.some(Node.isInterfaceDeclaration);
}

function typeText(node: Node): string {
  try {
    return node.getType().getText(node);
  } catch {
    return "";
  }
}

function hasModifierText(node: Node, mod: string): boolean {
  return new RegExp(`\\b${mod}\\b`).test(node.getText().slice(0, 120));
}
function hasPrivateOrProtectedConstructor(cls: ClassDeclaration): boolean {
  return cls
    .getConstructors()
    .some(
      (c) => hasModifierText(c, "private") || hasModifierText(c, "protected"),
    );
}
function staticProperties(cls: ClassDeclaration): PropertyDeclaration[] {
  return cls.getProperties().filter((p) => p.isStatic());
}
function staticMethods(cls: ClassDeclaration): MethodDeclaration[] {
  return cls.getMethods().filter((m) => m.isStatic());
}

function callsIn(node: Node): Node[] {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression);
}
function newExpressionsIn(node: Node): Node[] {
  return node.getDescendantsOfKind(SyntaxKind.NewExpression);
}
function returnStatementsIn(node: Node): Node[] {
  return node.getDescendantsOfKind(SyntaxKind.ReturnStatement);
}
function objectLiteralsIn(node: Node): Node[] {
  return node.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression);
}

function callExpressionName(call: Node): string {
  if (!Node.isCallExpression(call)) return "";
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  return expr.getText();
}

function isBehavioralArrayCall(call: Node): boolean {
  if (!Node.isCallExpression(call)) return false;
  const expr = call.getExpression();
  return (
    Node.isPropertyAccessExpression(expr) &&
    BEHAVIORAL_ARRAY_METHODS.has(expr.getName() as BehavioralArrayMethod)
  );
}

function behavioralArrayCalls(node: Node): Node[] {
  return callsIn(node).filter(isBehavioralArrayCall);
}

function classPublicMethods(cls: ClassDeclaration): MethodDeclaration[] {
  return cls
    .getMethods()
    .filter(
      (m) => !hasModifierText(m, "private") && !hasModifierText(m, "protected"),
    );
}

function hasMethod(cls: ClassDeclaration, names: string[]): boolean {
  return getMethodNames(cls).some((m) => names.includes(m));
}
function methodsMatching(
  cls: ClassDeclaration,
  re: RegExp,
): MethodDeclaration[] {
  return cls.getMethods().filter((m) => re.test(m.getName()));
}
function className(cls: ClassDeclaration): string {
  return cls.getName() ?? "<anonymous>";
}

export function findDefinitionUseRecordsForNode(
  node: Node,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  const name = getNodeName(node);
  const filePath = getFilePath(node);
  const start = getStartLine(node);
  return [...graph.values()].filter((r) => {
    if (
      r.name === name &&
      r.declaredAt?.filePath === filePath &&
      Math.abs((r.declaredAt?.line ?? -999999) - start) <= 2
    )
      return true;
    if (r.name === name && r.owner === name) return true;
    return false;
  });
}

export function findRecordsOwnedBySymbolName(
  owner: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter((r) => r.owner === owner);
}

export function findRecordsByName(
  name: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter((r) => r.name === name);
}

export function getRecordsDependingOn(
  recordId: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter((r) => {
    if (
      (r.initializer?.dependencyIds ?? r.initializer?.dependsOn ?? []).includes(recordId) ||
      r.initializer?.definedBy === recordId
    )
      return true;
    return r.assignments.some(
      (a) =>
        a.definedBy === recordId ||
        (a.dependencyIds ?? a.dependsOn).includes(recordId),
    );
  });
}

export function getRecordsReadBy(
  recordId: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter((r) => r.reads.includes(recordId));
}

export function traverseDefinitionUseGraph(
  startRecordIds: string[],
  graph: DefinitionUseGraph,
  options: { maxDepth: number; maxRecords: number },
): GraphEvidence[] {
  const queue = startRecordIds.map((id) => ({ id, distance: 0 }));
  const visited = new Set<string>();
  const out: GraphEvidence[] = [];
  while (queue.length && out.length < options.maxRecords) {
    const { id, distance } = queue.shift()!;
    if (visited.has(id) || distance > options.maxDepth) continue;
    visited.add(id);
    const record = graph.get(id);
    if (!record) continue;
    const neighbors = [
      ...getRecordsDependingOn(id, graph).map((r) => ({
        r,
        relation: "depends_on" as const,
      })),
      ...getRecordsReadBy(id, graph).map((r) => ({
        r,
        relation: "read_by" as const,
      })),
    ];
    for (const n of neighbors) {
      out.push({
        recordId: n.r.id,
        recordName: n.r.name,
        relation: n.relation,
        distance: distance + 1,
        filePath: n.r.declaredAt?.filePath,
        line: n.r.declaredAt?.line,
        column: n.r.declaredAt?.column,
        description: formatGraphEvidence(record, n.r, n.relation, distance + 1),
      });
      if (!visited.has(n.r.id) && distance + 1 < options.maxDepth)
        queue.push({ id: n.r.id, distance: distance + 1 });
      if (out.length >= options.maxRecords) break;
    }
  }
  return out;
}

export function formatGraphEvidence(
  from: DefinitionUseRecord,
  to: DefinitionUseRecord,
  relation: GraphEvidence["relation"],
  distance: number,
): string {
  return `Definition/use ${relation} flow from ${from.name} to ${to.name} within distance ${distance}.`;
}

export function findCallGraphNodeForAstNode(
  node: Node,
  callGraph: CallGraph,
): CallGraphNode | undefined {
  const name = getNodeName(node);
  const file = getFilePath(node);
  return [...callGraph.values()].find(
    (n) =>
      n.name === name ||
      n.id.includes(`${file}#${name}`) ||
      n.id.endsWith(`#${name}`),
  );
}

export function findCallGraphNodesByName(
  name: string,
  callGraph: CallGraph,
): CallGraphNode[] {
  return [...callGraph.values()].filter(
    (n) =>
      n.name === name ||
      n.name.endsWith(`.${name}`) ||
      n.id.endsWith(`#${name}`),
  );
}

export function getDirectCallees(
  nodeId: string,
  callGraph: CallGraph,
): CallGraphNode[] {
  const node = callGraph.get(nodeId);
  if (!node) return [];
  return [...node.calls]
    .map((id) => callGraph.get(id))
    .filter(Boolean) as CallGraphNode[];
}

export function getDirectCallers(
  nodeId: string,
  callGraph: CallGraph,
): CallGraphNode[] {
  return [...callGraph.values()].filter((n) => n.calls.has(nodeId));
}

export function traverseCallGraph(
  startNodeIds: string[],
  callGraph: CallGraph,
  options: {
    maxDepth: number;
    maxCalls: number;
    direction: "outgoing" | "incoming" | "both";
  },
): CallGraphEvidence[] {
  const queue = startNodeIds.map((id) => ({ id, distance: 0 }));
  const visited = new Set<string>();
  const out: CallGraphEvidence[] = [];
  while (queue.length && out.length < options.maxCalls) {
    const { id, distance } = queue.shift()!;
    if (visited.has(id) || distance > options.maxDepth) continue;
    visited.add(id);
    const node = callGraph.get(id);
    if (!node) continue;
    const next: Array<{
      other: CallGraphNode;
      relation: CallGraphEvidence["relation"];
      caller: CallGraphNode;
      callee: CallGraphNode;
    }> = [];
    if (options.direction === "outgoing" || options.direction === "both") {
      for (const callee of getDirectCallees(id, callGraph))
        next.push({ other: callee, relation: "calls", caller: node, callee });
    }
    if (options.direction === "incoming" || options.direction === "both") {
      for (const caller of getDirectCallers(id, callGraph))
        next.push({
          other: caller,
          relation: "called_by",
          caller,
          callee: node,
        });
    }
    for (const edge of next) {
      out.push({
        callerId: edge.caller.id,
        callerName: edge.caller.name,
        calleeId: edge.callee.id,
        calleeName: edge.callee.name,
        relation: edge.relation,
        distance: distance + 1,
        description: formatCallGraphEvidence(
          edge.caller,
          edge.callee,
          edge.relation,
          distance + 1,
        ),
      });
      if (!visited.has(edge.other.id) && distance + 1 < options.maxDepth)
        queue.push({ id: edge.other.id, distance: distance + 1 });
      if (out.length >= options.maxCalls) break;
    }
  }
  return out;
}

export function formatCallGraphEvidence(
  caller: CallGraphNode,
  callee: CallGraphNode,
  relation: CallGraphEvidence["relation"],
  distance: number,
): string {
  return `Call graph ${relation}: ${caller.name} -> ${callee.name} within distance ${distance}.`;
}

function graphBoostForNode(
  node: Node,
  ctx: RequiredContext,
  bucket: ScoreBucket,
  recordPredicate?: (e: GraphEvidence) => boolean,
): void {
  const records = [
    ...findDefinitionUseRecordsForNode(node, ctx.definitionUseGraph),
    ...findRecordsOwnedBySymbolName(getNodeName(node), ctx.definitionUseGraph),
  ];
  const ev = traverseDefinitionUseGraph(
    records.map((r) => r.id),
    ctx.definitionUseGraph,
    {
      maxDepth: ctx.config.graphMaxDepth,
      maxRecords: ctx.config.graphMaxRecordsPerTraversal,
    },
  );
  const filtered = recordPredicate ? ev.filter(recordPredicate) : ev;
  if (filtered.length) {
    bucket.graphEvidence.push(...filtered);
    add(
      bucket,
      "graphScore",
      Math.min(filtered.length * 0.5, ctx.config.graphScoreCapPerPattern),
      "bounded definition/use graph support",
      `Definition/use graph contributes ${filtered.length} bounded flow evidence item(s).`,
    );
  }
}

function callGraphBoostForNode(
  node: Node,
  ctx: RequiredContext,
  bucket: ScoreBucket,
  direction: "incoming" | "outgoing" | "both" = "both",
  relation?: CallGraphEvidence["relation"],
): void {
  const cgNode =
    findCallGraphNodeForAstNode(node, ctx.callGraph) ??
    findCallGraphNodesByName(getNodeName(node), ctx.callGraph)[0];
  if (!cgNode) return;
  const ev = traverseCallGraph([cgNode.id], ctx.callGraph, {
    maxDepth: ctx.config.callGraphMaxDepth,
    maxCalls: ctx.config.callGraphMaxCallsPerTraversal,
    direction,
  }).map((e) =>
    relation
      ? {
        ...e,
        relation,
        description: e.description.replace(
          /Call graph \w+:/,
          `Call graph ${relation}:`,
        ),
      }
      : e,
  );
  if (ev.length) {
    bucket.callGraphEvidence.push(...ev);
    add(
      bucket,
      "callGraphScore",
      Math.min(ev.length * 0.4, ctx.config.callGraphScoreCapPerPattern),
      "bounded call graph support",
      `Call graph contributes ${ev.length} bounded behavioral evidence item(s).`,
    );
  }
}

function buildInterfaceImplementationIndex(
  project: Project,
  config: PatternDetectorConfig,
): Map<string, ClassDeclaration[]> {
  const map = new Map<string, ClassDeclaration[]>();
  for (const sf of eligibleSourceFiles(project, config)) {
    for (const cls of sf.getClasses()) {
      for (const impl of cls.getImplements()) {
        const name = impl.getExpression().getText();
        const arr = map.get(name) ?? [];
        arr.push(cls);
        map.set(name, arr);
      }
    }
  }
  return map;
}

function eligibleSourceFiles(
  project: Project,
  config: PatternDetectorConfig,
): SourceFile[] {
  return project
    .getSourceFiles()
    .filter((sf) => isEligibleSourceFile(sf, config));
}

function isEligibleSourceFile(
  sf: SourceFile,
  config: PatternDetectorConfig,
): boolean {
  const p = sf.getFilePath();
  if (!config.includeDeclarationFiles && p.endsWith(".d.ts")) return false;
  if (
    !config.includeTestFiles &&
    /(^|[\\/])(__tests__|test|tests|spec|mocks|mock)([\\/]|$)|\.(test|spec|mock)\.[cm]?tsx?$/.test(
      p,
    )
  )
    return false;
  return true;
}

function classHasNonPrimitiveDeps(cls: ClassDeclaration): boolean {
  return getConstructorParameters(cls).some(isNonPrimitiveParameter);
}
function classPropertiesNamed(
  cls: ClassDeclaration,
  re: RegExp,
): PropertyDeclaration[] {
  return cls.getProperties().filter((p) => re.test(p.getName()));
}
function dependencyProperties(cls: ClassDeclaration): PropertyDeclaration[] {
  return cls
    .getProperties()
    .filter(
      (p) => !p.isStatic() && isLikelyDependencyType(p.getType().getText(p)),
    );
}
function isLikelyDependencyType(text: string): boolean {
  return /Repository|Service|Client|Gateway|Api|Adapter|Emitter|Bus|Store|Model|Db|Database|Prisma|Knex|Sequelize|DataSource|Connection|Strategy|Mapper|Registry|Container/.test(
    text,
  );
}
function methodCallsDependency(
  method: MethodDeclaration,
  props: PropertyDeclaration[],
): boolean {
  const names = props.map((p) => p.getName());
  return callsIn(method).some((c) =>
    names.some((n) => c.getText().includes(`this.${n}.`)),
  );
}
function classCallsDependency(
  cls: ClassDeclaration,
  props: PropertyDeclaration[],
): boolean {
  return cls.getMethods().some((m) => methodCallsDependency(m, props));
}
function countDistinctDependencyCalls(node: Node): number {
  const texts = callsIn(node).map((c) => c.getText());
  return new Set(
    texts
      .map((t) => t.match(/this\.([A-Za-z_$][\w$]*)\./)?.[1] ?? "")
      .filter(Boolean),
  ).size;
}
function hasBranching(node: Node): boolean {
  return (
    node.getDescendantsOfKind(SyntaxKind.IfStatement).length +
    node.getDescendantsOfKind(SyntaxKind.SwitchStatement).length +
    node.getDescendantsOfKind(SyntaxKind.ConditionalExpression).length >
    0
  );
}
function returnNewExpressions(node: Node): Node[] {
  return returnStatementsIn(node).filter((r) =>
    /return\s+new\s+/.test(r.getText()),
  );
}
function returnedNewClassNames(node: Node): string[] {
  return returnNewExpressions(node)
    .map((r) => r.getText().match(/new\s+([A-Za-z_$][\w$]*)/)?.[1])
    .filter(Boolean) as string[];
}
function returnsThis(method: MethodDeclaration): boolean {
  return (
    method.getReturnType().getText(method).includes("this") ||
    /return\s+this\b/.test(method.getText())
  );
}
function methodHasTerminalBuildName(m: MethodDeclaration): boolean {
  return /^(build|create|to[A-Z].*)$/.test(m.getName());
}
function methodReturnsDifferentType(
  method: MethodDeclaration | FunctionDeclaration,
): boolean {
  const params = method.getParameters().map((p) => p.getType().getText(p));
  const rt = method.getReturnType().getText(method);
  return !!rt && params.length > 0 && params.every((p) => p !== rt);
}
function objectTransformationScore(node: Node): number {
  return objectLiteralsIn(node).some((o) => o.getText().includes(":")) ? 1 : 0;
}
function listenerCollectionProperties(
  cls: ClassDeclaration,
): PropertyDeclaration[] {
  return cls
    .getProperties()
    .filter(
      (p) =>
        /listeners|subscribers|observers|handlers|callbacks/i.test(
          p.getName(),
        ) || /Map|Set|Array|Record/.test(p.getType().getText(p)),
    );
}
function invokesCallbackInLoop(node: Node): boolean {
  return (
    behavioralArrayCalls(node).some(
      (c) =>
        /\.forEach\(|\.map\(|\.some\(|\.every\(|\.flatMap\(/.test(
          c.getText(),
        ) && /=>|function|\w+\(/.test(c.getText()),
    ) ||
    node
      .getDescendantsOfKind(SyntaxKind.ForOfStatement)
      .some((s) => /\w+\(/.test(s.getText()))
  );
}
function externalNewExpressionCount(cls: ClassDeclaration): number {
  return newExpressionsIn(cls).filter(
    (n) => !n.getText().includes(className(cls)),
  ).length;
}

function detectSingleton(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  const name = className(node);
  if (hasPrivateOrProtectedConstructor(node))
    add(
      bucket,
      "localAstScore",
      3,
      "restricted constructor",
      "Class has private/protected constructor.",
    );
  const instanceProps = staticProperties(node).filter(
    (p) =>
      includesAny(p.getName(), ["instance", "singleton"]) ||
      p.getType().getText(p).includes(name),
  );
  if (instanceProps.length)
    add(
      bucket,
      "localAstScore",
      2,
      "static instance property",
      "Class has static instance-like property.",
    );
  const accessors = staticMethods(node).filter(
    (m) =>
      /getInstance|instance|current/i.test(m.getName()) &&
      m.getReturnType().getText(m).includes(name),
  );
  if (accessors.length)
    add(
      bucket,
      "typeCheckerScore",
      2,
      "static same-class accessor",
      "Static accessor returns same class type.",
    );
  if (!hasPrivateOrProtectedConstructor(node) && instanceProps.length)
    add(
      bucket,
      "ambiguityPenalty",
      1.5,
      "public construction ambiguity",
      "Public construction weakens singleton inference.",
    );
  graphBoostForNode(node, ctx, bucket, (e) =>
    /read|depends|flow/.test(e.relation),
  );
  callGraphBoostForNode(accessors[0] ?? node, ctx, bucket, "incoming");
  return [finalizeDetection("pattern.singleton", node, bucket, ctx)];
}

function detectDependencyInjection(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  const params = getConstructorParameters(node).filter(isNonPrimitiveParameter);
  if (params.length)
    add(
      bucket,
      "typeCheckerScore",
      Math.min(2 + params.length * 0.5, 4),
      "constructor non-primitive dependencies",
      `Constructor has ${params.length} non-primitive dependency parameter(s).`,
    );
  if (
    params.some(
      (p) =>
        (p as any).isParameterProperty?.() ||
        /private|protected|public|readonly/.test(p.getText().slice(0, 80)),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "constructor parameter property",
      "Constructor uses parameter properties.",
    );
  if (
    hasDecorator(node, ["Injectable", "Service", "Inject"]) ||
    node
      .getConstructors()
      .some((c) => c.getParameters().some((p) => hasDecorator(p, ["Inject"])))
  )
    add(
      bucket,
      "localAstScore",
      2,
      "DI decorator",
      "Class/constructor parameter has DI-style decorator.",
    );
  const directNews = externalNewExpressionCount(node);
  if (directNews === 0 && params.length)
    add(
      bucket,
      "localAstScore",
      1,
      "few direct new expressions",
      "Class receives dependencies rather than constructing them.",
    );
  if (directNews > params.length)
    add(
      bucket,
      "ambiguityPenalty",
      1.5,
      "direct construction noise",
      "Class constructs several dependencies internally.",
    );
  const props = dependencyProperties(node);
  if (
    classCallsDependency(node, props) ||
    params.some((p) =>
      new RegExp(`this\\.\\w+\\s*=\\s*${p.getName()}\\b`).test(node.getText()),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "injected dependency usage",
      "Injected dependency is stored or called by class methods.",
    );
  graphBoostForNode(node, ctx, bucket, (e) =>
    /property|depends|read|flow/.test(e.relation),
  );
  callGraphBoostForNode(node, ctx, bucket, "outgoing");
  return [finalizeDetection("pattern.dependency_injection", node, bucket, ctx)];
}

function detectFactory(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (
    !(
      Node.isClassDeclaration(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node)
    )
  )
    return [];
  const bucket = createBucket();
  const name = getNodeName(node);
  if (/Factory$|^create|^make|factory/i.test(name))
    add(bucket, "localAstScore", 1.5, "factory name", "Factory-style name.");
  const constructionCount = newExpressionsIn(node).length;
  if (constructionCount)
    add(
      bucket,
      "localAstScore",
      Math.min(2 + constructionCount * 0.25, 3),
      "constructs objects",
      "Node constructs object(s).",
    );
  const returnedClasses = returnedNewClassNames(node);
  if (returnedClasses.length)
    add(
      bucket,
      "localAstScore",
      2,
      "returns constructed object",
      "Return statements construct concrete objects.",
    );
  if (hasBranching(node) && new Set(returnedClasses).size > 1)
    add(
      bucket,
      "localAstScore",
      2.5,
      "branching concrete construction",
      "Branches return different concrete classes.",
    );
  if (
    (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) &&
    isInterfaceType(node.getReturnType())
  )
    add(
      bucket,
      "typeCheckerScore",
      2,
      "abstract return type",
      "Declared return type is an interface or alias abstraction.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both", "factory_invocation");
  return [finalizeDetection("pattern.factory", node, bucket, ctx)];
}

function detectObserver(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (hasMethod(node, ["subscribe", "unsubscribe", "notify"]))
    add(
      bucket,
      "localAstScore",
      2.5,
      "observer API",
      "Class exposes subscribe/unsubscribe/notify API.",
    );
  if (listenerCollectionProperties(node).length)
    add(
      bucket,
      "localAstScore",
      2,
      "listener collection",
      "Class has listener/subscriber collection property.",
    );
  const notify = methodsMatching(node, /^(notify|publish|broadcast)$/i)[0];
  if (notify && invokesCallbackInLoop(notify))
    add(
      bucket,
      "localAstScore",
      3,
      "callback invocation loop",
      "Notification method invokes callbacks through loop/array behavior.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(notify ?? node, ctx, bucket, "both");
  return [finalizeDetection("pattern.observer", node, bucket, ctx)];
}

function detectInterfaceBased(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  const bucket = createBucket();
  if (Node.isInterfaceDeclaration(node)) {
    add(
      bucket,
      "localAstScore",
      1.5,
      "interface declaration",
      "Interface declaration defines an abstraction.",
    );
    const impls = ctx.interfaceImplementations.get(node.getName()) ?? [];
    if (impls.length)
      add(
        bucket,
        "typeCheckerScore",
        Math.min(2 + impls.length * 0.5, 4),
        "classes implement interface",
        `${impls.length} class(es) implement this interface.`,
      );
    graphBoostForNode(node, ctx, bucket);
    return [finalizeDetection("pattern.interface_based", node, bucket, ctx)];
  }
  if (Node.isClassDeclaration(node)) {
    const impls = getImplementedInterfaces(node);
    if (impls.length)
      add(
        bucket,
        "typeCheckerScore",
        2,
        "implements interface",
        "Class implements one or more interfaces.",
      );
    const interfaceTypedParams = getConstructorParameters(node).filter((p) =>
      isInterfaceType(p.getType()),
    ).length;
    if (interfaceTypedParams)
      add(
        bucket,
        "typeCheckerScore",
        2,
        "interface-typed dependencies",
        "Constructor accepts interface-typed dependency.",
      );
    graphBoostForNode(node, ctx, bucket);
    callGraphBoostForNode(node, ctx, bucket, "both");
    return [finalizeDetection("pattern.interface_based", node, bucket, ctx)];
  }
  return [];
}

function detectRepository(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Repository$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "repository name suffix",
      "Class name ends with Repository.",
    );
  const crud = methodsMatching(
    node,
    /^(find|get|list|save|create|update|delete|remove|insert|upsert|count|query)/i,
  );
  if (crud.length >= 2)
    add(
      bucket,
      "localAstScore",
      Math.min(1 + crud.length * 0.5, 3),
      "CRUD-like methods",
      `Class exposes ${crud.length} CRUD-like methods.`,
    );
  if (
    classPropertiesNamed(
      node,
      /db|database|client|model|prisma|knex|sequelize|dataSource|connection/i,
    ).length ||
    getConstructorParameters(node).some((p) =>
      /Db|Database|Client|Model|Prisma|Knex|DataSource|Connection/.test(
        p.getType().getText(p),
      ),
    )
  )
    add(
      bucket,
      "typeCheckerScore",
      2,
      "database dependency",
      "Repository depends on database/client/model abstraction.",
    );
  callGraphBoostForNode(node, ctx, bucket, "both");
  graphBoostForNode(node, ctx, bucket);
  return [finalizeDetection("pattern.repository", node, bucket, ctx)];
}

function detectService(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Service$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.25,
      "service name suffix",
      "Class name ends with Service.",
    );
  const deps = getConstructorParameters(node).filter((p) =>
    /Repository|Client|Gateway|Mapper|Bus|Service|UseCase/.test(
      p.getType().getText(p),
    ),
  );
  if (deps.length)
    add(
      bucket,
      "typeCheckerScore",
      Math.min(2 + deps.length * 0.5, 4),
      "service dependencies",
      `Service has ${deps.length} repository/client/gateway dependency parameter(s).`,
    );
  const orchestration = node
    .getMethods()
    .filter((m) => countDistinctDependencyCalls(m) >= 2);
  if (orchestration.length)
    add(
      bucket,
      "localAstScore",
      2.5,
      "orchestrates dependencies",
      "Methods coordinate multiple dependencies.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both", "orchestrates");
  return [finalizeDetection("pattern.service", node, bucket, ctx)];
}

function detectStrategy(node: Node, ctx: RequiredContext): PatternDetection[] {
  const bucket = createBucket();
  if (Node.isInterfaceDeclaration(node)) {
    const impls = ctx.interfaceImplementations.get(node.getName()) ?? [];
    if (impls.length >= 2)
      add(
        bucket,
        "typeCheckerScore",
        4,
        "multiple implementations",
        `${impls.length} interchangeable implementations share interface.`,
      );
    if (/Strategy|Policy|Algorithm|Rule/.test(node.getName()))
      add(
        bucket,
        "localAstScore",
        1,
        "strategy abstraction name",
        "Interface has strategy-like name.",
      );
    graphBoostForNode(node, ctx, bucket);
    callGraphBoostForNode(node, ctx, bucket, "both");
    return [finalizeDetection("pattern.strategy", node, bucket, ctx)];
  }
  if (Node.isClassDeclaration(node)) {
    const params = getConstructorParameters(node).filter(
      (p) =>
        /Strategy|Policy|Algorithm|Rule/.test(p.getType().getText(p)) ||
        isInterfaceType(p.getType()),
    );
    if (params.length)
      add(
        bucket,
        "typeCheckerScore",
        2.5,
        "consumer accepts abstraction",
        "Class consumes strategy-like abstraction.",
      );
    if (
      callsIn(node).some((c) =>
        /strategy|policy|rule|algorithm/i.test(c.getText()),
      )
    )
      add(
        bucket,
        "localAstScore",
        1.5,
        "strategy method call",
        "Consumer calls strategy-like dependency.",
      );
    graphBoostForNode(node, ctx, bucket);
    callGraphBoostForNode(node, ctx, bucket, "outgoing");
    return [finalizeDetection("pattern.strategy", node, bucket, ctx)];
  }
  return [];
}

function detectBuilder(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Builder$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "builder name suffix",
      "Class name ends with Builder.",
    );
  const chainable = node.getMethods().filter(returnsThis);
  if (chainable.length >= 2)
    add(
      bucket,
      "typeCheckerScore",
      Math.min(2 + chainable.length * 0.5, 4),
      "chainable methods",
      `${chainable.length} methods return this.`,
    );
  const terminal = node.getMethods().find(methodHasTerminalBuildName);
  if (terminal)
    add(
      bucket,
      "localAstScore",
      2,
      "terminal build method",
      "Class has build/create/toX terminal method.",
    );
  if (terminal && newExpressionsIn(terminal).length)
    add(
      bucket,
      "localAstScore",
      2,
      "product construction",
      "Terminal method constructs final product.",
    );
  if (node.getProperties().length >= 2)
    add(
      bucket,
      "localAstScore",
      1,
      "state accumulation",
      "Builder stores staged object state.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(terminal ?? node, ctx, bucket, "both");
  return [finalizeDetection("pattern.builder", node, bucket, ctx)];
}

function detectAdapter(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Adapter$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "adapter name suffix",
      "Class name ends with Adapter.",
    );
  if (getImplementedInterfaces(node).length)
    add(
      bucket,
      "typeCheckerScore",
      2,
      "implements target interface",
      "Adapter implements target interface.",
    );
  const deps = dependencyProperties(node).concat(
    node
      .getProperties()
      .filter((p) =>
        /client|adaptee|legacy|external|sdk|api/i.test(p.getName()),
      ),
  );
  if (deps.length)
    add(
      bucket,
      "localAstScore",
      2,
      "wrapped dependency",
      "Class wraps external/client dependency.",
    );
  if (
    callsIn(node).some((c) =>
      /this\.(client|adaptee|legacy|external|sdk|api)\./i.test(c.getText()),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "delegates to wrapped object",
      "Methods delegate to wrapped external object.",
    );
  if (
    behavioralArrayCalls(node).length ||
    node.getMethods().some(methodReturnsDifferentType)
  )
    add(
      bucket,
      "localAstScore",
      1.5,
      "translation behavior",
      "Adapter translates data shape or uses behavioral array transformation.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "outgoing", "delegates_to");
  return [finalizeDetection("pattern.adapter", node, bucket, ctx)];
}

function detectFacade(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Facade$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "facade name suffix",
      "Class name ends with Facade.",
    );
  const deps = dependencyProperties(node);
  if (
    deps.length >= 2 ||
    getConstructorParameters(node).filter(isNonPrimitiveParameter).length >= 2
  )
    add(
      bucket,
      "typeCheckerScore",
      2.5,
      "multiple subsystem dependencies",
      "Class coordinates multiple subsystem dependencies.",
    );
  const simplePublic = classPublicMethods(node).filter(
    (m) =>
      m.getStatements().length <= 8 && countDistinctDependencyCalls(m) >= 2,
  );
  if (simplePublic.length)
    add(
      bucket,
      "localAstScore",
      3,
      "simple orchestration entrypoint",
      "Public method delegates to multiple subsystem calls.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both", "orchestrates");
  return [finalizeDetection("pattern.facade", node, bucket, ctx)];
}

function detectDecorator(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  const impls = getImplementedInterfaces(node);
  const wrapped = getConstructorParameters(node).filter(
    (p) =>
      impls.some((i) => p.getType().getText(p).includes(i)) ||
      /inner|wrapped|delegate|next/.test(p.getName()),
  );
  if (impls.length && wrapped.length)
    add(
      bucket,
      "typeCheckerScore",
      4,
      "same-interface wrapping",
      "Class implements same/compatible interface as wrapped dependency.",
    );
  if (/Decorator$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.25,
      "decorator name suffix",
      "Class name ends with Decorator.",
    );
  if (
    callsIn(node).some((c) =>
      /this\.(inner|wrapped|delegate|next)\./.test(c.getText()),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "delegates to wrapped object",
      "Decorator delegates calls to wrapped object.",
    );
  if (
    node.getMethods().some((m) => {
      const t = m.getText();
      return (
        /before|after|log|metric|validate|authorize|cache/i.test(t) &&
        /this\.(inner|wrapped|delegate|next)\./.test(t)
      );
    })
  )
    add(
      bucket,
      "localAstScore",
      2,
      "before after behavior",
      "Decorator adds behavior around delegation.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "outgoing", "wraps_call");
  return [finalizeDetection("pattern.decorator", node, bucket, ctx)];
}

function detectProxy(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Proxy$/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "proxy name suffix",
      "Class name ends with Proxy.",
    );
  if (getImplementedInterfaces(node).length)
    add(
      bucket,
      "typeCheckerScore",
      1.5,
      "same or similar interface",
      "Proxy implements exposed abstraction.",
    );
  if (
    getConstructorParameters(node).some(isNonPrimitiveParameter) ||
    dependencyProperties(node).length
  )
    add(
      bucket,
      "localAstScore",
      1.5,
      "target wrapping",
      "Proxy wraps target dependency.",
    );
  if (
    includesAny(node.getText(), [
      "cache",
      "lazy",
      "authorize",
      "auth",
      "permission",
      "remote",
      "retry",
      "guard",
      "memo",
    ])
  )
    add(
      bucket,
      "localAstScore",
      2,
      "control behavior",
      "Proxy contains access/cache/lazy/remote control behavior.",
    );
  if (
    hasBranching(node) &&
    callsIn(node).some((c) => /this\./.test(c.getText()))
  )
    add(
      bucket,
      "localAstScore",
      1.5,
      "conditional delegation",
      "Proxy conditionally delegates to target.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "outgoing", "wraps_call");
  return [finalizeDetection("pattern.proxy", node, bucket, ctx)];
}

function detectCommand(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node) && !Node.isObjectLiteralExpression(node))
    return [];
  const bucket = createBucket();
  if (/Command$/.test(getNodeName(node)))
    add(
      bucket,
      "localAstScore",
      1.25,
      "command name suffix",
      "Node has command-style name.",
    );
  const hasExecute = Node.isClassDeclaration(node)
    ? hasMethod(node, ["execute"])
    : /execute\s*[:(]/.test(node.getText());
  if (hasExecute)
    add(
      bucket,
      "localAstScore",
      3,
      "execute method",
      "Command encapsulates executable action.",
    );
  if (/undo|redo|dispatch|handler|bus|queue/.test(node.getText()))
    add(
      bucket,
      "localAstScore",
      1.5,
      "dispatch or undo semantics",
      "Command participates in dispatch/undo/queue semantics.",
    );
  if (
    Node.isClassDeclaration(node) &&
    (node.getProperties().length || getConstructorParameters(node).length)
  )
    add(
      bucket,
      "typeCheckerScore",
      1.5,
      "payload or dependencies",
      "Command stores payload/dependencies for later execution.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "incoming");
  return [finalizeDetection("pattern.command", node, bucket, ctx)];
}

function detectMiddleware(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  if (
    !(
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isClassDeclaration(node)
    )
  )
    return [];
  const bucket = createBucket();
  const params = Node.isClassDeclaration(node)
    ? []
    : node.getParameters().map((p) => p.getName());
  const text = node.getText();
  if (
    (params.includes("req") &&
      params.includes("res") &&
      params.includes("next")) ||
    (params.includes("ctx") && params.includes("next"))
  )
    add(
      bucket,
      "localAstScore",
      3,
      "middleware signature",
      "Function/method uses middleware pipeline parameters.",
    );
  if (/\bnext\s*\(/.test(text))
    add(
      bucket,
      "localAstScore",
      2.5,
      "calls next continuation",
      "Middleware calls pipeline continuation.",
    );
  if (/Middleware$/.test(getNodeName(node)) || /use\s*\(/.test(text))
    add(
      bucket,
      "localAstScore",
      1,
      "middleware naming or registration hint",
      "Middleware naming or app.use-style text detected.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both", "pipeline_continuation");
  return [finalizeDetection("pattern.middleware", node, bucket, ctx)];
}

function detectEventEmitter(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (hasMethod(node, ["on", "off", "once", "emit"]))
    add(
      bucket,
      "localAstScore",
      2.5,
      "event emitter API",
      "Class exposes on/off/once/emit API.",
    );
  if (getBaseClassName(node)?.includes("EventEmitter"))
    add(
      bucket,
      "typeCheckerScore",
      3,
      "extends EventEmitter",
      "Class extends EventEmitter.",
    );
  if (
    listenerCollectionProperties(node).some((p) =>
      /Map|Record|Object|Array|Set/.test(p.getType().getText(p)),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "event-key listener store",
      "Class has map/record/set listener storage.",
    );
  const emit = methodsMatching(node, /^emit$/i)[0];
  if (emit && invokesCallbackInLoop(emit))
    add(
      bucket,
      "localAstScore",
      2.5,
      "emit dispatch",
      "emit method dispatches to callbacks through loop/array method.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(emit ?? node, ctx, bucket, "both");
  return [finalizeDetection("pattern.event_emitter", node, bucket, ctx)];
}

function detectRegistry(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (!Node.isClassDeclaration(node)) return [];
  const bucket = createBucket();
  if (/Registry|Container|Resolver/.test(className(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "registry/container name",
      "Class has registry/container/resolver name.",
    );
  if (hasMethod(node, ["register", "resolve", "get", "set", "has"]))
    add(
      bucket,
      "localAstScore",
      2,
      "register resolve API",
      "Class exposes register/resolve/get/set API.",
    );
  if (
    node
      .getProperties()
      .some(
        (p) =>
          /Map|Record|Object|WeakMap/.test(p.getType().getText(p)) ||
          /registry|items|handlers|providers|tokens/i.test(p.getName()),
      )
  )
    add(
      bucket,
      "typeCheckerScore",
      2,
      "keyed storage",
      "Class owns keyed storage for dynamic lookup.",
    );
  if (/\.set\(|\[.*\]\s*=|\.get\(|resolve\s*\(/.test(node.getText()))
    add(
      bucket,
      "localAstScore",
      2,
      "dynamic store and lookup",
      "Registry dynamically stores and reads values by key/token.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both");
  return [finalizeDetection("pattern.registry", node, bucket, ctx)];
}

function detectPlugin(node: Node, ctx: RequiredContext): PatternDetection[] {
  const bucket = createBucket();
  if (
    Node.isInterfaceDeclaration(node) &&
    /Plugin|Extension/.test(node.getName())
  )
    add(
      bucket,
      "localAstScore",
      2,
      "plugin interface",
      "Plugin/extension interface defines extension boundary.",
    );
  if (
    Node.isClassDeclaration(node) &&
    /Plugin|Extension|Host/.test(className(node))
  )
    add(
      bucket,
      "localAstScore",
      1.5,
      "plugin class name",
      "Class has plugin/extension/host name.",
    );
  if (
    /\b(install|register|activate|load|dispose|initialize)\b/.test(
      node.getText(),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "plugin lifecycle methods",
      "Node contains plugin lifecycle methods.",
    );
  if (
    /import\s*\(|require\s*\(|loadPlugin|plugins\s*[:=]|\.register\(/.test(
      node.getText(),
    )
  )
    add(
      bucket,
      "localAstScore",
      2,
      "extension registration or dynamic load",
      "Host registers or dynamically loads extensions.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both");
  return bucket.localAstScore || bucket.typeCheckerScore
    ? [finalizeDetection("pattern.plugin", node, bucket, ctx)]
    : [];
}

function detectMapper(node: Node, ctx: RequiredContext): PatternDetection[] {
  if (
    !(
      Node.isClassDeclaration(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node)
    )
  )
    return [];
  const bucket = createBucket();
  const name = getNodeName(node);
  if (/Mapper$|^(to|from|mapTo|mapFrom)[A-Z]|Dto|Entity|Domain/.test(name))
    add(
      bucket,
      "localAstScore",
      1.5,
      "mapper name",
      "Mapper/conversion-style name.",
    );
  if (
    (Node.isMethodDeclaration(node) || Node.isFunctionDeclaration(node)) &&
    methodReturnsDifferentType(node)
  )
    add(
      bucket,
      "typeCheckerScore",
      2,
      "different parameter and return types",
      "Mapper converts between distinct input and output types.",
    );
  if (objectTransformationScore(node))
    add(
      bucket,
      "localAstScore",
      2,
      "object literal transformation",
      "Mapper returns or creates object literal with explicit property transformation.",
    );
  if (
    behavioralArrayCalls(node).some((c) =>
      /\.map\(|\.flatMap\(|\.reduce\(/.test(c.getText()),
    )
  )
    add(
      bucket,
      "localAstScore",
      1.5,
      "array transformation behavior",
      "Array method is treated as a first-class transformation signal.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "both");
  return [finalizeDetection("pattern.mapper", node, bucket, ctx)];
}

function detectModuleBoundary(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  if (!Node.isSourceFile(node)) return [];
  const bucket = createBucket();
  const base = node.getBaseName();
  if (/^index\.[cm]?tsx?$/.test(base))
    add(
      bucket,
      "localAstScore",
      2,
      "barrel index file",
      "Source file is an index/barrel module.",
    );
  const exports = node.getExportDeclarations();
  if (exports.length)
    add(
      bucket,
      "localAstScore",
      Math.min(1 + exports.length * 0.5, 3),
      "re-export surface",
      `Source file has ${exports.length} export declaration(s).`,
    );
  if (exports.some((e) => !e.getNamedExports().length))
    add(
      bucket,
      "localAstScore",
      1.5,
      "export star",
      "Source file uses export * re-export pattern.",
    );
  try {
    const exported = node.getExportedDeclarations();
    if (exported.size >= 3)
      add(
        bucket,
        "typeCheckerScore",
        2,
        "public API surface",
        `Source file exposes ${exported.size} exported symbol name(s).`,
      );
  } catch {
    /* ignore incomplete program */
  }
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "incoming");
  return [finalizeDetection("pattern.module_boundary", node, bucket, ctx)];
}

function detectUnitOfWork(
  node: Node,
  ctx: RequiredContext,
): PatternDetection[] {
  if (
    !Node.isClassDeclaration(node) &&
    !Node.isFunctionDeclaration(node) &&
    !Node.isMethodDeclaration(node)
  )
    return [];
  const bucket = createBucket();
  if (/UnitOfWork|Transaction|Transactional/.test(getNodeName(node)))
    add(
      bucket,
      "localAstScore",
      1.5,
      "transactional name",
      "Node has unit-of-work/transactional name.",
    );
  if (
    /\b(begin|commit|rollback|transaction|tx|withTransaction)\b/i.test(
      node.getText(),
    )
  )
    add(
      bucket,
      "localAstScore",
      3,
      "transaction lifecycle",
      "Node contains transaction lifecycle terms.",
    );
  const repoRefs = (node.getText().match(/Repository/g) ?? []).length;
  if (repoRefs >= 2 || countDistinctDependencyCalls(node) >= 2)
    add(
      bucket,
      "typeCheckerScore",
      2.5,
      "multiple repository operations",
      "Node coordinates multiple repositories/dependencies.",
    );
  if (
    /commit[\s\S]*rollback|rollback[\s\S]*commit|try[\s\S]*commit[\s\S]*catch[\s\S]*rollback/i.test(
      node.getText(),
    )
  )
    add(
      bucket,
      "localAstScore",
      2.5,
      "commit rollback wrapping",
      "Operation wraps work with commit/rollback lifecycle.",
    );
  graphBoostForNode(node, ctx, bucket);
  callGraphBoostForNode(node, ctx, bucket, "outgoing", "transactional_call");
  return [finalizeDetection("pattern.unit_of_work", node, bucket, ctx)];
}

const detectors: DetectorFn[] = [
  detectSingleton,
  detectDependencyInjection,
  detectFactory,
  detectObserver,
  detectInterfaceBased,
  detectRepository,
  detectService,
  detectStrategy,
  detectBuilder,
  detectAdapter,
  detectFacade,
  detectDecorator,
  detectProxy,
  detectCommand,
  detectMiddleware,
  detectEventEmitter,
  detectRegistry,
  detectPlugin,
  detectMapper,
  detectModuleBoundary,
  detectUnitOfWork,
];

export function detectArchitecturePatterns(
  input: PatternDetectorContext,
): PatternDetection[] {
  const config: PatternDetectorConfig = {
    ...defaultPatternDetectorConfig,
    ...input.config,
    confidenceThresholds: {
      ...defaultPatternDetectorConfig.confidenceThresholds,
      ...(input.config?.confidenceThresholds ?? {}),
    },
  };
  const ctx: RequiredContext = {
    ...input,
    config,
    interfaceImplementations: buildInterfaceImplementationIndex(
      input.project,
      config,
    ),
  };
  const detections: PatternDetection[] = [];
  for (const sf of eligibleSourceFiles(ctx.project, ctx.config)) {
    detections.push(...detectModuleBoundary(sf, ctx));
    const candidates: Node[] = [
      ...sf.getClasses(),
      ...sf.getInterfaces(),
      ...sf.getFunctions(),
      ...sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression),
    ];
    for (const node of candidates) {
      for (const detector of detectors) {
        if (detector === detectModuleBoundary) continue;
        const out = detector(node, ctx);
        for (const d of out) if (d.detected) detections.push(d);
      }
    }
  }
  return annotatePatternIntersections(detections).sort(
    (a, b) => b.score - a.score || a.pattern.localeCompare(b.pattern),
  );
}

export function deserializeCallGraph(
  nodes: SerializedCallGraphNode[],
): CallGraph {
  return new Map(
    nodes.map((n) => [
      n.id,
      { id: n.id, name: n.name, calls: new Set(n.calls) },
    ]),
  );
}

export function serializeDetections(detections: PatternDetection[]): string {
  return JSON.stringify(detections, null, 2);
}

export function summarizeStrongWeakSignals(): Record<
  "strong" | "medium" | "weak",
  string[]
> {
  return {
    strong: [
      "restricted construction plus static same-class accessor for singleton",
      "constructor parameter-to-property dependency flow plus method calls for dependency injection",
      "branching concrete construction behind interface/base return type for factory",
      "registration API plus listener storage plus callback invocation loop for observer/event emitter",
      "multiple implementations of a common interface plus abstraction-typed consumer for strategy",
      "commit/rollback lifecycle wrapping multiple repository calls for unit of work",
    ],
    medium: [
      "implemented interfaces, inheritance, typed constructor parameters, return type abstraction",
      "bounded definition/use flows showing storage, reads, and shared dependency usage",
      "bounded call graph paths showing delegation, orchestration, continuation, or factory invocation",
      "behavioral array calls such as map/filter/reduce/some/every/flatMap/forEach when they transform, dispatch, or pipeline behavior",
    ],
    weak: [
      "class/function/interface names and suffixes",
      "decorators without usage flow",
      "single CRUD-like method without data dependency",
      "single interface declaration with no implementation or consumer",
    ],
  };
}

export const knownFalsePositivesAndNegatives = {
  falsePositives: [
    "Naming suffixes such as Service, Repository, Factory, or Adapter can reflect project convention rather than the pattern.",
    "Array methods can signal behavior but may be ordinary data manipulation unless tied to callback invocation, mapping, or pipeline flow.",
    "Facade, service, and unit-of-work can overlap when a class coordinates multiple dependencies.",
    "Event emitter and observer overlap when event names are not modeled precisely in the provided graphs.",
  ],
  falseNegatives: [
    "Dynamic JavaScript patterns hidden behind aliases or metaprogramming may not be visible in static AST signals.",
    "Incomplete definition/use or call graphs reduce confidence, especially for cross-file architectural usage.",
    "Framework conventions may obscure dependency injection, middleware, plugins, and module boundaries.",
    "Factory or strategy selection driven by configuration outside TypeScript may not be scored strongly.",
  ],
};

export const scoreTuningRecommendations = [
  "Raise high threshold above 7 for monorepos with many naming conventions and generated code.",
  "Lower graphScoreCapPerPattern when definition/use graph quality is uncertain.",
  "Lower callGraphScoreCapPerPattern when call graph nodes are name-only and not symbol-qualified.",
  "Increase graphMaxDepth or callGraphMaxDepth only after measuring runtime and false-positive rate; defaults intentionally bound traversal to depth 2.",
  "Add project-specific decorator names and framework boundary terms as local AST rules, but keep them below high-confidence weight unless paired with usage flow.",
];

// Sample CLI. Place in a separate file in production.
// import { Project } from "ts-morph";
// import { detectArchitecturePatterns, deserializeCallGraph } from "./pattern-detector";
// const project = new Project({ tsConfigFilePath: process.argv[2] ?? "tsconfig.json" });
// const checker = project.getTypeChecker();
// const definitionUseGraph: DefinitionUseGraph = new Map(); // load/build externally
// const callGraph: CallGraph = deserializeCallGraph([]); // load/build externally
// console.log(JSON.stringify(detectArchitecturePatterns({ project, checker, definitionUseGraph, callGraph }), null, 2));

export { PATTERNS, BEHAVIORAL_ARRAY_METHODS };
