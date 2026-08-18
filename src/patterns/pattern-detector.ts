import {
  ArrowFunction,
  CallExpression,
  ClassDeclaration,
  Decorator,
  FunctionDeclaration,
  FunctionExpression,
  InterfaceDeclaration,
  MethodDeclaration,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
  SyntaxKind,
} from "ts-morph";

import {
  annotatePatternIntersections,
  classifyDetectionMode,
  defaultPatternDetectorConfig,
} from "./pattern-core";
import { detectArchitecturePatterns } from "./architecture-pattern-detector";
import type {
  AdditionalPatternKey,
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
  PatternKey,
  SerializedCallGraphNode,
} from "./pattern-core";

type DetectorCandidate =
  | ClassDeclaration
  | InterfaceDeclaration
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration
  | ObjectLiteralExpression
  | CallExpression;

type DetectorResult = {
  pattern: AdditionalPatternKey;
  node: Node;
  localAstScore: number;
  typeCheckerScore: number;
  graphScore: number;
  callGraphScore: number;
  ambiguityPenalty: number;
  evidence: string[];
  matchedRules: string[];
  graphEvidence: GraphEvidence[];
  callGraphEvidence: CallGraphEvidence[];
  localStrongSignalCount: number;
  typeStrongSignalCount: number;
};

type Detector = (
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
) => DetectorResult[];

type RequiredPatternDetectorContext = Omit<PatternDetectorContext, "config"> & {
  config: PatternDetectorConfig;
};

const HTTP_METHOD_DECORATORS = new Set([
  "Get",
  "Post",
  "Put",
  "Patch",
  "Delete",
  "Head",
  "Options",
  "All",
]);
const CONTROLLER_DECORATORS = new Set(["Controller", "RestController"]);
const GRAPHQL_DECORATORS = new Set([
  "Resolver",
  "Query",
  "Mutation",
  "FieldResolver",
  "ResolveField",
  "Subscription",
]);
const VALIDATION_DECORATORS = new Set([
  "IsString",
  "IsEmail",
  "IsOptional",
  "IsNotEmpty",
  "IsUUID",
  "IsNumber",
  "IsBoolean",
  "ValidateNested",
  "Length",
  "Min",
  "Max",
  "Matches",
]);
const ORM_DECORATORS = new Set([
  "Entity",
  "Column",
  "PrimaryColumn",
  "PrimaryGeneratedColumn",
  "ManyToOne",
  "OneToMany",
  "ManyToMany",
  "OneToOne",
  "JoinColumn",
  "CreateDateColumn",
  "UpdateDateColumn",
]);
const SCHEDULER_DECORATORS = new Set([
  "Cron",
  "Interval",
  "Timeout",
  "Scheduled",
]);
const QUEUE_DECORATORS = new Set([
  "Processor",
  "Process",
  "OnQueueActive",
  "OnQueueCompleted",
  "OnQueueFailed",
  "MessagePattern",
  "EventPattern",
]);

const ARRAY_BEHAVIOR_METHODS = new Set([
  "map",
  "filter",
  "reduce",
  "some",
  "every",
  "flatMap",
  "forEach",
]);
const TRANSFORMATION_ARRAY_METHODS = new Set(["map", "flatMap", "reduce"]);
const PREDICATE_ARRAY_METHODS = new Set(["filter", "some", "every"]);
const SIDE_EFFECT_ARRAY_METHODS = new Set(["forEach"]);
const ROUTE_REGISTRATION_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
  "route",
]);
const RESPONSE_TERMINATORS = new Set([
  "json",
  "send",
  "status",
  "end",
  "redirect",
  "render",
]);
const CACHE_METHODS = new Set([
  "get",
  "set",
  "has",
  "delete",
  "clear",
  "invalidate",
  "del",
  "mget",
  "mset",
]);
const FLAG_METHODS = new Set([
  "isEnabled",
  "variation",
  "getFlag",
  "checkFlag",
  "enabled",
  "getVariation",
  "boolVariation",
]);
const VALIDATION_METHODS = new Set([
  "parse",
  "safeParse",
  "validate",
  "validateSync",
  "assert",
  "isValid",
  "schema",
]);
const PROVIDER_KEYS = new Set([
  "provide",
  "useClass",
  "useValue",
  "useFactory",
  "useExisting",
  "inject",
]);
const QUEUE_METHODS = new Set([
  "process",
  "consume",
  "subscribe",
  "on",
  "addEventListener",
  "eachMessage",
  "handleMessage",
]);
const ACK_METHODS = new Set([
  "ack",
  "nack",
  "commit",
  "commitMessage",
  "resolveOffset",
  "reject",
  "deleteMessage",
]);
const SCHEDULER_METHODS = new Set([
  "schedule",
  "setInterval",
  "setTimeout",
  "cron",
  "job",
  "recurrenceRule",
]);
const CONTAINER_METHODS = new Set([
  "register",
  "bind",
  "provide",
  "singleton",
  "factory",
  "instance",
  "asClass",
  "asValue",
  "asFunction",
]);

const TEST_FILE_RE =
  /(?:^|[\\/])(?:__tests__|__mocks__|test|tests|spec|mocks)(?:[\\/]|$)|(?:\.|-)(?:test|spec|mock|fixture)\.tsx?$/i;
const DECL_FILE_RE = /\.d\.ts$/i;

function mergeConfig(
  config?: Partial<PatternDetectorConfig>,
): PatternDetectorConfig {
  return {
    ...defaultPatternDetectorConfig,
    ...config,
    confidenceThresholds: {
      ...defaultPatternDetectorConfig.confidenceThresholds,
      ...(config?.confidenceThresholds ?? {}),
    },
  };
}

export function detectAdditionalPatterns(
  context: PatternDetectorContext,
): PatternDetection[] {
  const ctx: RequiredPatternDetectorContext = {
    ...context,
    config: mergeConfig(context.config),
  };
  const detections: PatternDetection[] = [];

  for (const sf of ctx.project.getSourceFiles()) {
    if (!shouldAnalyzeSourceFile(sf, ctx.config)) continue;
    for (const candidate of collectCandidates(sf)) {
      for (const detector of DETECTORS) {
        for (const raw of detector(candidate, ctx)) {
          const detection = finalizeDetection(raw, ctx.config);
          if (detection.detected) detections.push(detection);
        }
      }
    }
  }

  return annotatePatternIntersections(dedupeDetections(detections)).sort(
    (a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath),
  );
}

export function detectPatterns(
  context: PatternDetectorContext,
): PatternDetection<PatternKey>[] {
  return annotatePatternIntersections([
    ...detectArchitecturePatterns(context),
    ...detectAdditionalPatterns(context),
  ]).sort(
    (a, b) =>
      b.score - a.score ||
      a.pattern.localeCompare(b.pattern) ||
      a.filePath.localeCompare(b.filePath),
  );
}

export function serializeCallGraph(
  callGraph: CallGraph,
): SerializedCallGraphNode[] {
  return [...callGraph.values()].map((node) => ({
    id: node.id,
    name: node.name,
    calls: [...node.calls],
  }));
}

export function deserializeCallGraph(
  nodes: SerializedCallGraphNode[],
): CallGraph {
  return new Map(
    nodes.map((node) => [node.id, { ...node, calls: new Set(node.calls) }]),
  );
}

function shouldAnalyzeSourceFile(
  sf: SourceFile,
  config: PatternDetectorConfig,
): boolean {
  const filePath = normalizePath(sf.getFilePath());
  if (!config.includeDeclarationFiles && DECL_FILE_RE.test(filePath))
    return false;
  if (!config.includeTestFiles && TEST_FILE_RE.test(filePath)) return false;
  return true;
}

function collectCandidates(sf: SourceFile): DetectorCandidate[] {
  const candidates: DetectorCandidate[] = [];
  sf.forEachDescendant((node) => {
    if (
      Node.isClassDeclaration(node) ||
      Node.isInterfaceDeclaration(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isArrowFunction(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isObjectLiteralExpression(node) ||
      Node.isCallExpression(node)
    ) {
      candidates.push(node);
    }
  });
  return candidates;
}

function finalizeDetection(
  raw: DetectorResult,
  config: PatternDetectorConfig,
): PatternDetection {
  const cappedGraphScore = Math.min(
    raw.graphScore,
    config.graphScoreCapPerPattern,
  );
  const cappedCallGraphScore = Math.min(
    raw.callGraphScore,
    config.callGraphScoreCapPerPattern,
  );
  let score =
    raw.localAstScore +
    raw.typeCheckerScore +
    cappedGraphScore +
    cappedCallGraphScore -
    raw.ambiguityPenalty;

  const hasStrongNonGraphSignal =
    raw.localStrongSignalCount + raw.typeStrongSignalCount > 0;
  const graphOnly =
    raw.localAstScore + raw.typeCheckerScore <= 0 &&
    (cappedGraphScore > 0 || cappedCallGraphScore > 0);
  const namingOnly =
    raw.matchedRules.length > 0 &&
    raw.matchedRules.every((rule) => rule.includes("name"));

  if (graphOnly)
    score = Math.min(score, config.confidenceThresholds.medium - 0.1);
  if (namingOnly)
    score = Math.min(score, config.confidenceThresholds.medium - 0.1);
  if (!hasStrongNonGraphSignal && score >= config.confidenceThresholds.high)
    score = config.confidenceThresholds.high - 0.1;

  score = roundScore(Math.max(0, score));
  const confidence = classifyConfidence(score, config);
  const loc = getSourceLocation(raw.node);

  return {
    pattern: raw.pattern,
    detected: score >= config.confidenceThresholds.low,
    confidence,
    mode: classifyDetectionMode(confidence),
    score,
    filePath: loc.filePath,
    nodeKind: raw.node.getKindName(),
    nodeName: getNodeName(raw.node),
    startLine: loc.startLine,
    endLine: loc.endLine,
    evidence: unique(raw.evidence),
    matchedRules: unique(raw.matchedRules),
    graphEvidence: raw.graphEvidence.slice(0, 20),
    callGraphEvidence: raw.callGraphEvidence.slice(0, 20),
    intersectingPatterns: [],
    intersectionEvidence: [],
  };
}

function classifyConfidence(
  score: number,
  config: PatternDetectorConfig,
): PatternConfidence {
  if (score >= config.confidenceThresholds.high) return "high";
  if (score >= config.confidenceThresholds.medium) return "medium";
  return "low";
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function dedupeDetections(detections: PatternDetection[]): PatternDetection[] {
  const byKey = new Map<string, PatternDetection>();
  for (const d of detections) {
    const key = [
      d.pattern,
      d.filePath,
      d.nodeKind,
      d.nodeName,
      d.startLine,
      d.endLine,
    ].join("::");
    const existing = byKey.get(key);
    if (!existing || d.score > existing.score) byKey.set(key, d);
  }
  return [...byKey.values()];
}

function createResult(
  pattern: AdditionalPatternKey,
  node: Node,
): DetectorResult {
  return {
    pattern,
    node,
    localAstScore: 0,
    typeCheckerScore: 0,
    graphScore: 0,
    callGraphScore: 0,
    ambiguityPenalty: 0,
    evidence: [],
    matchedRules: [],
    graphEvidence: [],
    callGraphEvidence: [],
    localStrongSignalCount: 0,
    typeStrongSignalCount: 0,
  };
}

function addSignal(
  result: DetectorResult,
  score: number,
  rule: string,
  evidence: string,
  strength: "weak" | "medium" | "strong" = "medium",
  category: "ast" | "type" = "ast",
): void {
  if (category === "ast") result.localAstScore += score;
  else result.typeCheckerScore += score;
  result.matchedRules.push(rule);
  result.evidence.push(evidence);
  if (strength === "strong") {
    if (category === "ast") result.localStrongSignalCount += 1;
    else result.typeStrongSignalCount += 1;
  }
}

function addGraphSignals(
  result: DetectorResult,
  evidence: GraphEvidence[],
  scorePerEvidence = 0.8,
): void {
  result.graphEvidence.push(...evidence);
  result.graphScore += Math.min(
    evidence.length * scorePerEvidence,
    evidence.length === 0 ? 0 : Infinity,
  );
}

function addCallGraphSignals(
  result: DetectorResult,
  evidence: CallGraphEvidence[],
  scorePerEvidence = 0.8,
): void {
  result.callGraphEvidence.push(...evidence);
  result.callGraphScore += Math.min(
    evidence.length * scorePerEvidence,
    evidence.length === 0 ? 0 : Infinity,
  );
}

function finalizePotential(result: DetectorResult): DetectorResult[] {
  const totalPreCap =
    result.localAstScore +
    result.typeCheckerScore +
    result.graphScore +
    result.callGraphScore -
    result.ambiguityPenalty;
  return totalPreCap > 0 ? [result] : [];
}

// -------------------------------------------------------------------------------------------------
// Reusable AST helpers
// -------------------------------------------------------------------------------------------------

export function getNodeName(node: Node): string {
  if (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node)
  ) {
    return node.getName() ?? "<anonymous>";
  }
  if (Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
    const parent = node.getParent();
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyAssignment(parent)) return propertyNameText(parent);
    if (Node.isCallExpression(parent))
      return `${getCallExpressionText(parent)} callback`;
  }
  if (Node.isObjectLiteralExpression(node)) {
    const parent = node.getParent();
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyAssignment(parent)) return propertyNameText(parent);
  }
  if (Node.isCallExpression(node)) return getCallExpressionText(node);
  return node.getKindName();
}

export function getDecorators(node: Node): Decorator[] {
  if (
    Node.isClassDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isParameterDeclaration(node)
  ) {
    return node.getDecorators();
  }
  return [];
}

export function getDecoratorNames(node: Node): string[] {
  return getDecorators(node)
    .map((d) => d.getName())
    .filter(Boolean);
}

export function hasDecorator(
  node: Node,
  names: Set<string> | string[],
): boolean {
  const set = Array.isArray(names) ? new Set(names) : names;
  return getDecoratorNames(node).some((name) => set.has(name));
}

export function getImports(sourceFile: SourceFile): string[] {
  return sourceFile.getImportDeclarations().flatMap((imp) => {
    const moduleName = imp.getModuleSpecifierValue();
    const named = imp.getNamedImports().map((n) => n.getName());
    const namespace = imp.getNamespaceImport()?.getText();
    const def = imp.getDefaultImport()?.getText();
    return [moduleName, ...named, namespace, def].filter((v): v is string =>
      Boolean(v),
    );
  });
}

export function hasImportMatching(
  sourceFile: SourceFile,
  patterns: RegExp[],
): boolean {
  const imports = getImports(sourceFile);
  return imports.some((item) => patterns.some((re) => re.test(item)));
}

export function getCallExpressions(node: Node): CallExpression[] {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression);
}

export function getCallExpressionText(call: CallExpression): string {
  return compactText(call.getExpression().getText());
}

export function getCalledMethodName(call: CallExpression): string {
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  if (Node.isIdentifier(expr)) return expr.getText();
  return compactText(expr.getText());
}

export function hasCallNamed(
  node: Node,
  names: Set<string> | string[],
): boolean {
  const set = Array.isArray(names) ? new Set(names) : names;
  return getCallExpressions(node).some((call) =>
    set.has(getCalledMethodName(call)),
  );
}

export function getRouteRegistrationCalls(node: Node): CallExpression[] {
  return getCallExpressions(node).filter(isRouteRegistrationCall);
}

export function isRouteRegistrationCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  const method = expr.getName();
  const receiver = expr.getExpression().getText().toLowerCase();
  const isRouteMethod = ROUTE_REGISTRATION_METHODS.has(method.toLowerCase());
  const isReceiver =
    /(?:^|\.)(app|router|route|server|fastify|koa|routes)$/i.test(receiver) ||
    /(router|route|server|fastify|express|koa)/i.test(receiver);
  const hasPathString = call
    .getArguments()
    .some(
      (arg) => Node.isStringLiteral(arg) && /^\//.test(arg.getLiteralText()),
    );
  return isRouteMethod && (isReceiver || hasPathString);
}

export function getMethodNames(node: Node): string[] {
  if (!Node.isClassDeclaration(node)) return [];
  return node.getMethods().map((m) => m.getName());
}

export function getConstructorParameters(cls: ClassDeclaration): string[] {
  return cls
    .getConstructors()
    .flatMap((ctor) => ctor.getParameters().map((p) => p.getName()));
}

export function getConstructorParameterTypes(cls: ClassDeclaration): string[] {
  return cls
    .getConstructors()
    .flatMap((ctor) => ctor.getParameters().map((p) => safeTypeText(p)));
}

export function getReturnTypes(node: Node): string[] {
  if (Node.isClassDeclaration(node))
    return node.getMethods().map((m) => safeReturnTypeText(m));
  if (
    Node.isMethodDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node)
  )
    return [safeReturnTypeText(node)];
  return [];
}

export function getImplementedInterfaces(cls: ClassDeclaration): string[] {
  return cls.getImplements().map((impl) => impl.getText());
}

export function getExtendsText(
  cls: ClassDeclaration | InterfaceDeclaration,
): string[] {
  if (Node.isClassDeclaration(cls))
    return cls.getExtends() ? [cls.getExtends()!.getText()] : [];
  return cls.getExtends().map((e) => e.getText());
}

export function getSourceLocation(node: Node): {
  filePath: string;
  startLine: number;
  endLine: number;
  column: number;
} {
  const sf = node.getSourceFile();
  const start = sf.getLineAndColumnAtPos(node.getStart());
  const end = sf.getLineAndColumnAtPos(node.getEnd());
  return {
    filePath: normalizePath(sf.getFilePath()),
    startLine: start.line,
    endLine: end.line,
    column: start.column,
  };
}

function getClassMembersText(cls: ClassDeclaration): string {
  return cls
    .getMembers()
    .map((m) => m.getText())
    .join("\n");
}

function getAllIdentifiersText(node: Node): string[] {
  return node
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .map((id) => id.getText());
}

function hasIdentifierMatching(node: Node, re: RegExp): boolean {
  return getAllIdentifiersText(node).some((text) => re.test(text));
}

function getProperties(cls: ClassDeclaration): string[] {
  return cls.getProperties().map((p) => p.getName());
}

function getPublicMethods(cls: ClassDeclaration): MethodDeclaration[] {
  return cls
    .getMethods()
    .filter(
      (m) =>
        !m.hasModifier(SyntaxKind.PrivateKeyword) &&
        !m.hasModifier(SyntaxKind.ProtectedKeyword),
    );
}

function safeReturnTypeText(
  node:
    | MethodDeclaration
    | FunctionDeclaration
    | FunctionExpression
    | ArrowFunction,
): string {
  try {
    return node.getReturnType().getText(node);
  } catch {
    return "unknown";
  }
}

function safeTypeText(node: Node): string {
  try {
    return node.getType().getText(node);
  } catch {
    return "unknown";
  }
}

function propertyNameText(prop: PropertyAssignment): string {
  return compactText(
    prop
      .getNameNode()
      .getText()
      .replace(/^['\"]|['\"]$/g, ""),
  );
}

function objectLiteralHasProviderKeys(obj: ObjectLiteralExpression): boolean {
  const keys = obj
    .getProperties()
    .filter(Node.isPropertyAssignment)
    .map(propertyNameText);
  return (
    keys.some((k) => PROVIDER_KEYS.has(k)) &&
    keys.some((k) => k === "provide" || k === "useFactory" || k === "useClass")
  );
}

function propertyAssignmentByName(
  obj: ObjectLiteralExpression,
  name: string,
): PropertyAssignment | undefined {
  return obj
    .getProperties()
    .filter(Node.isPropertyAssignment)
    .find((prop) => propertyNameText(prop) === name);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function compactText(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? compact.slice(0, max - 1) + "…" : compact;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function nameMatches(node: Node, re: RegExp): boolean {
  return re.test(getNodeName(node));
}

function countMatches(items: string[], re: RegExp): number {
  return items.filter((item) => re.test(item)).length;
}

function containsText(node: Node, re: RegExp): boolean {
  return re.test(node.getText());
}

function classHasMostlyDataShape(
  cls: ClassDeclaration | InterfaceDeclaration,
): boolean {
  if (Node.isInterfaceDeclaration(cls)) {
    const members = cls.getMembers();
    const behavioral = members.filter(Node.isMethodSignature).length;
    const properties = members.filter(Node.isPropertySignature).length;
    return properties >= 2 && behavioral <= 1;
  }
  const properties = cls.getProperties().length;
  const methods = cls
    .getMethods()
    .filter((m) => !["constructor"].includes(m.getName())).length;
  return properties >= 2 && methods <= 1;
}

function getArrayBehaviorCalls(node: Node): CallExpression[] {
  return getCallExpressions(node).filter((call) =>
    ARRAY_BEHAVIOR_METHODS.has(getCalledMethodName(call)),
  );
}

function getTransformationCalls(node: Node): CallExpression[] {
  return getCallExpressions(node).filter((call) =>
    TRANSFORMATION_ARRAY_METHODS.has(getCalledMethodName(call)),
  );
}

function getPredicateArrayCalls(node: Node): CallExpression[] {
  return getCallExpressions(node).filter((call) =>
    PREDICATE_ARRAY_METHODS.has(getCalledMethodName(call)),
  );
}

function hasTryCatch(node: Node): boolean {
  return node.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0;
}

function hasLoop(node: Node): boolean {
  return node
    .getDescendants()
    .some(
      (d) =>
        Node.isForStatement(d) ||
        Node.isForOfStatement(d) ||
        Node.isForInStatement(d) ||
        Node.isWhileStatement(d) ||
        Node.isDoStatement(d),
    );
}

function countThrowStatements(node: Node): number {
  return node.getDescendantsOfKind(SyntaxKind.ThrowStatement).length;
}

function returnTypeLooksBoolean(node: Node): boolean {
  return getReturnTypes(node).some((t) =>
    /\bboolean\b|Promise<boolean>/.test(t),
  );
}

function methodNamed(
  cls: ClassDeclaration,
  names: string[],
): MethodDeclaration | undefined {
  return cls.getMethods().find((m) => names.includes(m.getName()));
}

function hasConstructorInjection(cls: ClassDeclaration): boolean {
  return cls
    .getConstructors()
    .some((ctor) =>
      ctor
        .getParameters()
        .some(
          (p) =>
            p.hasModifier(SyntaxKind.PrivateKeyword) ||
            p.hasModifier(SyntaxKind.ProtectedKeyword) ||
            p.hasModifier(SyntaxKind.PublicKeyword) ||
            /Service|UseCase|Repository|Gateway|Client|Presenter|Validator/i.test(
              safeTypeText(p) + p.getName(),
            ),
        ),
    );
}

function hasBoundaryParams(
  method:
    | MethodDeclaration
    | FunctionDeclaration
    | FunctionExpression
    | ArrowFunction,
): boolean {
  const parameters = method.getParameters();
  return parameters.some(
    (p) =>
      /^(req|res|next|request|response|reply|ctx|context|body|params|query|input|payload|args)$/i.test(
        p.getName(),
      ) ||
      /Request|Response|Context|Args|Body|Query|Param|Payload|Dto|Input/i.test(
        safeTypeText(p),
      ),
  );
}

function hasResponseTerminator(node: Node): boolean {
  return getCallExpressions(node).some(
    (call) =>
      RESPONSE_TERMINATORS.has(getCalledMethodName(call)) ||
      /ctx\.body\s*=/.test(call.getParent()?.getText() ?? ""),
  );
}

function getStrongGraphEvidenceForNode(
  node: Node,
  ctx: RequiredPatternDetectorContext,
  filter: (ev: GraphEvidence) => boolean = () => true,
): GraphEvidence[] {
  const records = findDefinitionUseRecordsForNode(node, ctx.definitionUseGraph);
  const ownerRecords = findRecordsOwnedBySymbolName(
    getNodeName(node),
    ctx.definitionUseGraph,
  );
  const starts = unique([...records, ...ownerRecords].map((r) => r.id));
  if (starts.length === 0) return [];
  return traverseDefinitionUseGraph(starts, ctx.definitionUseGraph, {
    maxDepth: ctx.config.graphMaxDepth,
    maxRecords: ctx.config.graphMaxRecordsPerTraversal,
  }).filter(filter);
}

function getStrongCallGraphEvidenceForNode(
  node: Node,
  ctx: RequiredPatternDetectorContext,
  direction: "incoming" | "outgoing" | "both" = "both",
  filter: (ev: CallGraphEvidence) => boolean = () => true,
): CallGraphEvidence[] {
  const cgNode = findCallGraphNodeForAstNode(node, ctx.callGraph);
  const nameNodes = findCallGraphNodesByName(getNodeName(node), ctx.callGraph);
  const starts = unique(
    [cgNode?.id, ...nameNodes.map((n) => n.id)].filter((id): id is string =>
      Boolean(id),
    ),
  );
  if (starts.length === 0) return [];
  return traverseCallGraph(starts, ctx.callGraph, {
    maxDepth: ctx.config.callGraphMaxDepth,
    maxCalls: ctx.config.callGraphMaxCallsPerTraversal,
    direction,
  }).filter(filter);
}

// -------------------------------------------------------------------------------------------------
// Definition/use graph helpers
// -------------------------------------------------------------------------------------------------

export function findDefinitionUseRecordsForNode(
  node: Node,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  const name = getNodeName(node);
  const loc = getSourceLocation(node);
  const symbolName = getSymbolNameSafely(node);
  return [...graph.values()].filter((record) => {
    const declared = record.declaredAt;
    const locMatch =
      declared &&
      normalizePath(declared.filePath) === loc.filePath &&
      declared.line >= loc.startLine &&
      declared.line <= loc.endLine;
    const nameMatch =
      record.name === name ||
      Boolean(symbolName && record.name === symbolName) ||
      record.owner === name ||
      Boolean(symbolName && record.owner === symbolName);
    return Boolean(locMatch || nameMatch);
  });
}

export function findRecordsOwnedBySymbolName(
  owner: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter(
    (record) =>
      record.owner === owner ||
      record.owner.endsWith(`.${owner}`) ||
      owner.endsWith(`.${record.owner}`),
  );
}

export function findRecordsByName(
  name: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter(
    (record) => record.name === name || record.name.endsWith(`.${name}`),
  );
}

export function getRecordsDependingOn(
  recordId: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter((record) => {
    const deps = [
      record.initializer?.definedBy,
      ...(record.initializer?.dependencyIds ?? record.initializer?.dependsOn ?? []),
      ...record.assignments.flatMap((a) => [
        a.definedBy,
        ...(a.dependencyIds ?? a.dependsOn),
      ]),
    ].filter(Boolean);
    return deps.includes(recordId);
  });
}

export function getRecordsReadBy(
  recordId: string,
  graph: DefinitionUseGraph,
): DefinitionUseRecord[] {
  return [...graph.values()].filter((record) =>
    record.reads.includes(recordId),
  );
}

export function traverseDefinitionUseGraph(
  startRecordIds: string[],
  graph: DefinitionUseGraph,
  options: { maxDepth: number; maxRecords: number },
): GraphEvidence[] {
  const evidence: GraphEvidence[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = unique(
    startRecordIds,
  ).map((id) => ({ id, depth: 0 }));

  while (queue.length > 0 && visited.size < options.maxRecords) {
    const current = queue.shift()!;
    if (visited.has(current.id) || current.depth > options.maxDepth) continue;
    visited.add(current.id);
    const record = graph.get(current.id);
    if (!record) continue;

    for (const depId of unique(
      [
        record.initializer?.definedBy,
        ...(record.initializer?.dependencyIds ?? record.initializer?.dependsOn ?? []),
      ].filter((id): id is string => Boolean(id)),
    )) {
      const dep = graph.get(depId);
      if (dep) {
        evidence.push(
          formatGraphEvidence(
            dep,
            record,
            "depends_on",
            current.depth + 1,
            `${record.name} depends on ${dep.name}`,
          ),
        );
        if (!visited.has(dep.id))
          queue.push({ id: dep.id, depth: current.depth + 1 });
      }
    }

    for (const assignment of record.assignments ?? []) {
      const sourceIds = unique(
        [
          assignment.definedBy,
          ...(assignment.dependencyIds ?? assignment.dependsOn ?? []),
        ].filter(Boolean),
      );
      for (const sourceId of sourceIds) {
        const source = graph.get(sourceId);
        if (source) {
          evidence.push(
            formatGraphEvidence(
              source,
              record,
              "assigned_from",
              current.depth + 1,
              `${record.name} is assigned from ${source.name}`,
              assignment.location,
            ),
          );
          if (!visited.has(source.id))
            queue.push({ id: source.id, depth: current.depth + 1 });
        }
      }
    }

    for (const reader of getRecordsReadBy(record.id, graph)) {
      evidence.push(
        formatGraphEvidence(
          reader,
          record,
          "read_by",
          current.depth + 1,
          `${record.name} is read by ${reader.name}`,
        ),
      );
      if (!visited.has(reader.id))
        queue.push({ id: reader.id, depth: current.depth + 1 });
    }

    for (const dependent of getRecordsDependingOn(record.id, graph)) {
      evidence.push(
        formatGraphEvidence(
          dependent,
          record,
          "used_by_owner",
          current.depth + 1,
          `${record.name} contributes to ${dependent.name}`,
        ),
      );
      if (!visited.has(dependent.id))
        queue.push({ id: dependent.id, depth: current.depth + 1 });
    }
  }

  return evidence.slice(0, options.maxRecords);
}

export function formatGraphEvidence(
  record: DefinitionUseRecord,
  via: DefinitionUseRecord | undefined,
  relation: GraphEvidence["relation"],
  distance: number,
  description: string,
  location?: { filePath: string; line: number; column: number },
): GraphEvidence {
  const loc = location ?? record.declaredAt;
  return {
    recordId: record.id,
    recordName: record.name,
    relation,
    distance,
    filePath: loc?.filePath ? normalizePath(loc.filePath) : undefined,
    line: loc?.line,
    column: loc?.column,
    description: via ? `${description} via ${via.name}` : description,
  };
}

function getSymbolNameSafely(node: Node): string | undefined {
  try {
    const symbol = node.getSymbol() ?? node.getType().getSymbol();
    return symbol?.getName();
  } catch {
    return undefined;
  }
}

// -------------------------------------------------------------------------------------------------
// Call graph helpers
// -------------------------------------------------------------------------------------------------

export function findCallGraphNodeForAstNode(
  node: Node,
  callGraph: CallGraph,
): CallGraphNode | undefined {
  const name = getNodeName(node);
  const loc = getSourceLocation(node);
  const candidates = findCallGraphNodesByName(name, callGraph);
  return (
    candidates.find(
      (candidate) =>
        candidate.id.includes(loc.filePath) ||
        candidate.id.includes(`${loc.startLine}`),
    ) ?? candidates[0]
  );
}

export function findCallGraphNodesByName(
  name: string,
  callGraph: CallGraph,
): CallGraphNode[] {
  const normalized = name.toLowerCase();
  return [...callGraph.values()].filter(
    (node) =>
      node.name === name ||
      node.name.toLowerCase().endsWith(`.${normalized}`) ||
      node.name.toLowerCase().includes(normalized),
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
    .filter((n): n is CallGraphNode => Boolean(n));
}

export function getDirectCallers(
  nodeId: string,
  callGraph: CallGraph,
): CallGraphNode[] {
  return [...callGraph.values()].filter((node) => node.calls.has(nodeId));
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
  const evidence: CallGraphEvidence[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = unique(startNodeIds).map(
    (id) => ({ id, depth: 0 }),
  );

  while (queue.length > 0 && visited.size < options.maxCalls) {
    const current = queue.shift()!;
    if (visited.has(current.id) || current.depth > options.maxDepth) continue;
    visited.add(current.id);
    const node = callGraph.get(current.id);
    if (!node) continue;

    if (options.direction === "outgoing" || options.direction === "both") {
      for (const callee of getDirectCallees(node.id, callGraph)) {
        evidence.push(
          formatCallGraphEvidence(
            node,
            callee,
            "calls",
            current.depth + 1,
            `${node.name} calls ${callee.name}`,
          ),
        );
        if (!visited.has(callee.id))
          queue.push({ id: callee.id, depth: current.depth + 1 });
      }
    }

    if (options.direction === "incoming" || options.direction === "both") {
      for (const caller of getDirectCallers(node.id, callGraph)) {
        evidence.push(
          formatCallGraphEvidence(
            caller,
            node,
            "called_by",
            current.depth + 1,
            `${node.name} is called by ${caller.name}`,
          ),
        );
        if (!visited.has(caller.id))
          queue.push({ id: caller.id, depth: current.depth + 1 });
      }
    }
  }

  return evidence.slice(0, options.maxCalls);
}

export function formatCallGraphEvidence(
  caller: CallGraphNode,
  callee: CallGraphNode,
  relation: CallGraphEvidence["relation"],
  distance: number,
  description: string,
): CallGraphEvidence {
  return {
    callerId: caller.id,
    callerName: caller.name,
    calleeId: callee.id,
    calleeName: callee.name,
    relation,
    distance,
    description,
  };
}

// -------------------------------------------------------------------------------------------------
// Scoring helpers and evidence refiners
// -------------------------------------------------------------------------------------------------

function addBoundedGraphEvidence(
  result: DetectorResult,
  node: Node,
  ctx: RequiredPatternDetectorContext,
  filter: (ev: GraphEvidence) => boolean,
  relationOverride?: GraphEvidence["relation"],
  scorePerEvidence = 0.8,
): void {
  const ev = getStrongGraphEvidenceForNode(node, ctx, filter).slice(
    0,
    ctx.config.graphMaxRecordsPerTraversal,
  );
  const mapped = relationOverride
    ? ev.map((e) => ({ ...e, relation: relationOverride }))
    : ev;
  addGraphSignals(result, mapped, scorePerEvidence);
}

function addBoundedCallGraphEvidence(
  result: DetectorResult,
  node: Node,
  ctx: RequiredPatternDetectorContext,
  direction: "incoming" | "outgoing" | "both",
  filter: (ev: CallGraphEvidence) => boolean,
  relationOverride?: CallGraphEvidence["relation"],
  scorePerEvidence = 0.8,
): void {
  const ev = getStrongCallGraphEvidenceForNode(
    node,
    ctx,
    direction,
    filter,
  ).slice(0, ctx.config.callGraphMaxCallsPerTraversal);
  const mapped = relationOverride
    ? ev.map((e) => ({ ...e, relation: relationOverride }))
    : ev;
  addCallGraphSignals(result, mapped, scorePerEvidence);
}

function graphNameMatches(ev: GraphEvidence, re: RegExp): boolean {
  return re.test(`${ev.recordName} ${ev.description}`);
}

function callGraphNameMatches(ev: CallGraphEvidence, re: RegExp): boolean {
  return re.test(`${ev.callerName} ${ev.calleeName} ${ev.description}`);
}

function ambiguityForGenericName(node: Node, re: RegExp, amount = 1): number {
  const name = getNodeName(node);
  return re.test(name) ? amount : 0;
}

// -------------------------------------------------------------------------------------------------
// Detectors
// -------------------------------------------------------------------------------------------------

const DETECTORS: Detector[] = [
  detectController,
  detectRouteHandler,
  detectGuard,
  detectInterceptor,
  detectValidator,
  detectDto,
  detectEntity,
  detectValueObject,
  detectUseCase,
  detectPresenter,
  detectResolver,
  detectProvider,
  detectCompositionRoot,
  detectCache,
  detectRetryPolicy,
  detectCircuitBreaker,
  detectQueueConsumer,
  detectScheduler,
  detectFeatureFlag,
  detectSpecification,
];

function detectController(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.controller", candidate);
  const name = getNodeName(candidate);
  const methodDecorators = candidate.getMethods().flatMap(getDecoratorNames);
  const httpDecorators = methodDecorators.filter((d) =>
    HTTP_METHOD_DECORATORS.has(d),
  );

  if (/Controller$/.test(name))
    addSignal(
      result,
      1.5,
      "controller.name_suffix",
      `${name} ends with Controller`,
      "weak",
    );
  if (hasDecorator(candidate, CONTROLLER_DECORATORS))
    addSignal(
      result,
      3,
      "controller.class_decorator",
      `${name} has controller decorator`,
      "strong",
    );
  if (httpDecorators.length > 0)
    addSignal(
      result,
      2.5,
      "controller.http_method_decorators",
      `${name} has HTTP method decorators: ${unique(httpDecorators).join(", ")}`,
      "strong",
    );
  if (hasConstructorInjection(candidate))
    addSignal(
      result,
      1.5,
      "controller.constructor_injection",
      `${name} receives injected dependencies`,
      "medium",
    );
  if (candidate.getMethods().some(hasBoundaryParams))
    addSignal(
      result,
      1.2,
      "controller.boundary_params",
      `${name} methods accept request/body/params/query-like inputs`,
      "medium",
    );
  if (candidate.getMethods().some(hasResponseTerminator))
    addSignal(
      result,
      1.2,
      "controller.response_termination",
      `${name} emits route responses`,
      "medium",
    );

  const types = getConstructorParameterTypes(candidate).join(" ");
  if (/Service|UseCase|Interactor|Application|Repository/.test(types))
    addSignal(
      result,
      1,
      "controller.type_dependency",
      `${name} injects application/service-like types`,
      "medium",
      "type",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /Service|UseCase|Dto|Request|Response|Presenter|Controller/i,
      ),
    "boundary_flow",
    0.7,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /Service|UseCase|Presenter|route|router|handler|Controller/i,
      ),
    "boundary_entry_call",
    0.7,
  );

  if (
    !hasDecorator(candidate, CONTROLLER_DECORATORS) &&
    httpDecorators.length === 0
  )
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectRouteHandler(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const results: DetectorResult[] = [];

  if (Node.isCallExpression(candidate) && isRouteRegistrationCall(candidate)) {
    const result = createResult("pattern.route_handler", candidate);
    addSignal(
      result,
      3,
      "route_handler.registration_call",
      `Route registration call ${getCallExpressionText(candidate)}`,
      "strong",
    );
    const callbacks = candidate
      .getArguments()
      .filter(
        (arg) =>
          Node.isArrowFunction(arg) ||
          Node.isFunctionExpression(arg) ||
          Node.isIdentifier(arg),
      );
    if (callbacks.length > 0)
      addSignal(
        result,
        1.5,
        "route_handler.callback_argument",
        "Route registration includes handler callback/reference",
        "strong",
      );
    if (
      callbacks.some(
        (cb) =>
          !Node.isIdentifier(cb) &&
          hasBoundaryParams(cb as ArrowFunction | FunctionExpression),
      )
    )
      addSignal(
        result,
        1,
        "route_handler.request_response_params",
        "Inline handler accepts request/response parameters",
        "medium",
      );
    if (
      callbacks.some(
        (cb) => !Node.isIdentifier(cb) && hasResponseTerminator(cb),
      )
    )
      addSignal(
        result,
        1.5,
        "route_handler.response_call",
        "Inline handler terminates response",
        "strong",
      );
    addBoundedCallGraphEvidence(
      result,
      candidate,
      ctx,
      "outgoing",
      (ev) =>
        callGraphNameMatches(
          ev,
          /handler|controller|service|usecase|validator|json|send/i,
        ),
      "registered_callback",
      0.8,
    );
    results.push(...finalizePotential(result));
  }

  if (
    Node.isFunctionDeclaration(candidate) ||
    Node.isFunctionExpression(candidate) ||
    Node.isArrowFunction(candidate) ||
    Node.isMethodDeclaration(candidate)
  ) {
    const result = createResult("pattern.route_handler", candidate);
    if (hasBoundaryParams(candidate))
      addSignal(
        result,
        1.5,
        "route_handler.boundary_params",
        `${getNodeName(candidate)} has req/res/next/request/reply/ctx-like params`,
        "medium",
      );
    if (hasResponseTerminator(candidate))
      addSignal(
        result,
        2,
        "route_handler.response_terminator",
        `${getNodeName(candidate)} calls response terminator`,
        "strong",
      );
    if (
      Node.isArrowFunction(candidate) &&
      candidate.getParentIfKind(SyntaxKind.CallExpression) &&
      isRouteRegistrationCall(
        candidate.getParentIfKindOrThrow(SyntaxKind.CallExpression),
      )
    )
      addSignal(
        result,
        2,
        "route_handler.inline_route_callback",
        "Async/function callback is passed directly to a route registration",
        "strong",
      );
    if (/Handler$|Route$/.test(getNodeName(candidate)))
      addSignal(
        result,
        0.8,
        "route_handler.name_suffix",
        `${getNodeName(candidate)} is handler/route-named`,
        "weak",
      );
    addBoundedGraphEvidence(
      result,
      candidate,
      ctx,
      (ev) =>
        graphNameMatches(
          ev,
          /req|request|res|response|validator|service|usecase|dto/i,
        ),
      "boundary_flow",
      0.6,
    );
    addBoundedCallGraphEvidence(
      result,
      candidate,
      ctx,
      "both",
      (ev) =>
        callGraphNameMatches(
          ev,
          /router|route|app|service|usecase|validator|json|send/i,
        ),
      "boundary_entry_call",
      0.7,
    );
    if (!hasResponseTerminator(candidate) && !hasBoundaryParams(candidate))
      result.ambiguityPenalty += 1;
    results.push(...finalizePotential(result));
  }

  return results;
}

function detectGuard(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.guard", candidate);
  const name = getNodeName(candidate);
  const methods = getMethodNames(candidate);
  const text = candidate.getText();

  if (/Guard$/.test(name))
    addSignal(
      result,
      1.5,
      "guard.name_suffix",
      `${name} ends with Guard`,
      "weak",
    );
  if (
    getImplementedInterfaces(candidate).some((i) =>
      /CanActivate|Guard/i.test(i),
    )
  )
    addSignal(
      result,
      2,
      "guard.interface",
      `${name} implements guard-like interface`,
      "strong",
      "type",
    );
  if (
    methods.some((m) =>
      /^(canActivate|authorize|isAllowed|hasPermission)$/.test(m),
    )
  )
    addSignal(
      result,
      2,
      "guard.authorization_method",
      `${name} exposes guard/authorization method`,
      "strong",
    );
  if (/user|session|role|permission|token|auth|jwt/i.test(text))
    addSignal(
      result,
      1.5,
      "guard.auth_terms",
      `${name} checks auth/session/permission/token terms`,
      "medium",
    );
  if (candidate.getMethods().some(returnTypeLooksBoolean))
    addSignal(
      result,
      1,
      "guard.boolean_return",
      `${name} returns boolean-like authorization result`,
      "medium",
      "type",
    );
  if (
    /Unauthorized|Forbidden|401|403|AccessDenied/i.test(text) ||
    countThrowStatements(candidate) > 0
  )
    addSignal(
      result,
      1,
      "guard.auth_error",
      `${name} throws or references unauthorized/forbidden errors`,
      "medium",
    );
  if (/UseGuards/.test(text) || hasDecorator(candidate, ["Injectable"]))
    addSignal(
      result,
      0.8,
      "guard.pipeline_or_injectable",
      `${name} has pipeline/injectable context`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /auth|permission|role|token|session|controller|route|guard/i,
      ),
    "registered_in_pipeline",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /auth|permission|role|session|handler|controller|route/i,
      ),
    "guarded_call",
    0.8,
  );

  if (
    !methods.some((m) =>
      /canActivate|authorize|isAllowed|hasPermission/.test(m),
    ) &&
    !getImplementedInterfaces(candidate).some((i) => /CanActivate/.test(i))
  )
    result.ambiguityPenalty += 1.2;
  return finalizePotential(result);
}

function detectInterceptor(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.interceptor", candidate);
  const name = getNodeName(candidate);
  const intercept = methodNamed(candidate, ["intercept"]);

  if (/Interceptor$/.test(name))
    addSignal(
      result,
      1.5,
      "interceptor.name_suffix",
      `${name} ends with Interceptor`,
      "weak",
    );
  if (
    getImplementedInterfaces(candidate).some((i) =>
      /NestInterceptor|Interceptor/i.test(i),
    )
  )
    addSignal(
      result,
      2,
      "interceptor.interface",
      `${name} implements interceptor interface`,
      "strong",
      "type",
    );
  if (intercept)
    addSignal(
      result,
      2,
      "interceptor.intercept_method",
      `${name} has intercept method`,
      "strong",
    );
  if (intercept && /next\.handle\s*\(/.test(intercept.getText()))
    addSignal(
      result,
      2,
      "interceptor.next_handle",
      `${name}.intercept delegates to next.handle()`,
      "strong",
    );
  if (
    hasCallNamed(candidate, [
      "pipe",
      "map",
      "catchError",
      "tap",
      "finally",
      "finalize",
    ])
  )
    addSignal(
      result,
      1.2,
      "interceptor.rxjs_or_pipeline",
      `${name} uses pipeline/RxJS operators`,
      "medium",
    );
  if (/UseInterceptors|APP_INTERCEPTOR/.test(candidate.getText()))
    addSignal(
      result,
      1,
      "interceptor.pipeline_registration",
      `${name} appears in interceptor pipeline metadata`,
      "strong",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /next|handler|response|error|log|metric|interceptor|pipeline/i,
      ),
    "registered_in_pipeline",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /next\.handle|handle|log|metric|error|pipe|controller|handler/i,
      ),
    "pipeline_continuation",
    0.8,
  );

  if (!intercept || !/next\.handle/.test(candidate.getText()))
    result.ambiguityPenalty += 1;
  return finalizePotential(result);
}

function detectValidator(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.validator", candidate);
  const name = getNodeName(candidate);
  const sf = candidate.getSourceFile();

  if (/Validator$|Schema$|Validation$/.test(name))
    addSignal(
      result,
      1.2,
      "validator.name_suffix",
      `${name} has validator/schema/validation name`,
      "weak",
    );
  if (
    hasImportMatching(sf, [/zod|yup|joi|class-validator|superstruct|valibot/i])
  )
    addSignal(
      result,
      2,
      "validator.library_import",
      `${name} uses validation library import`,
      "strong",
    );
  if (hasCallNamed(candidate, VALIDATION_METHODS))
    addSignal(
      result,
      2,
      "validator.validation_api_call",
      `${name} calls parse/safeParse/validate-like API`,
      "strong",
    );
  if (
    hasDecorator(candidate, VALIDATION_DECORATORS) ||
    candidate
      .getDescendants()
      .some((d) => hasDecorator(d, VALIDATION_DECORATORS))
  )
    addSignal(
      result,
      2,
      "validator.validation_decorators",
      `${name} uses validation decorators`,
      "strong",
    );
  if (
    /ValidationError|BadRequest|Invalid|throw/.test(candidate.getText()) &&
    countThrowStatements(candidate) > 0
  )
    addSignal(
      result,
      1,
      "validator.throws_validation_error",
      `${name} throws validation-style errors`,
      "medium",
    );
  if (
    /safeParse|parse|validate/.test(candidate.getText()) &&
    /success|error|errors/.test(candidate.getText())
  )
    addSignal(
      result,
      1,
      "validator.validation_result_branch",
      `${name} branches on validation result`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /dto|input|request|body|controller|handler|usecase|validated|schema/i,
      ),
    "boundary_flow",
    0.7,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /parse|validate|controller|handler|usecase|service/i,
      ),
    "bounded_call_path",
    0.7,
  );

  if (
    !hasCallNamed(candidate, VALIDATION_METHODS) &&
    !hasDecorator(candidate, VALIDATION_DECORATORS) &&
    !hasImportMatching(sf, [/zod|yup|joi|class-validator|superstruct|valibot/i])
  )
    result.ambiguityPenalty += 1.2;
  return finalizePotential(result);
}

function detectDto(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (
    !Node.isClassDeclaration(candidate) &&
    !Node.isInterfaceDeclaration(candidate)
  )
    return [];
  const result = createResult("pattern.dto", candidate);
  const name = getNodeName(candidate);

  if (
    /Dto$|DTO$|Request$|Response$|Payload$|Input$|Output$|Command$|Query$/.test(
      name,
    )
  )
    addSignal(
      result,
      1.5,
      "dto.boundary_name",
      `${name} has DTO/boundary data name`,
      "weak",
    );
  if (classHasMostlyDataShape(candidate))
    addSignal(
      result,
      2,
      "dto.data_shape",
      `${name} is mostly property declarations/signatures`,
      "strong",
    );
  if (
    Node.isClassDeclaration(candidate) &&
    candidate.getMethods().length === 0 &&
    candidate.getProperties().length >= 2
  )
    addSignal(
      result,
      1,
      "dto.no_behavior",
      `${name} has no behavioral methods`,
      "medium",
    );
  if (
    candidate
      .getDescendants()
      .some((d) => hasDecorator(d, VALIDATION_DECORATORS))
  )
    addSignal(
      result,
      1.5,
      "dto.validation_serialization_decorators",
      `${name} fields use validation/serialization decorators`,
      "medium",
    );
  if (/readonly|Partial<|Pick<|Omit<|Record</.test(candidate.getText()))
    addSignal(
      result,
      0.8,
      "dto_type_composition",
      `${name} uses type composition or readonly fields`,
      "medium",
      "type",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /controller|resolver|handler|presenter|mapper|response|request|entity|domain|usecase/i,
      ),
    "boundary_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /controller|resolver|handler|presenter|mapper|response/i,
      ),
    "bounded_call_path",
    0.5,
  );

  if (!classHasMostlyDataShape(candidate)) result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectEntity(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.entity", candidate);
  const name = getNodeName(candidate);
  const decorators = [
    getDecoratorNames(candidate),
    ...candidate.getProperties().map(getDecoratorNames),
  ].flat();

  if (/Entity$/.test(name))
    addSignal(
      result,
      1.2,
      "entity.name_suffix",
      `${name} ends with Entity`,
      "weak",
    );
  if (hasDecorator(candidate, ["Entity"]))
    addSignal(
      result,
      3,
      "entity.orm_class_decorator",
      `${name} has @Entity decorator`,
      "strong",
    );
  const ormDecoratorHits = decorators.filter((d) => ORM_DECORATORS.has(d));
  if (ormDecoratorHits.length >= 2)
    addSignal(
      result,
      2,
      "entity.orm_property_decorators",
      `${name} uses ORM decorators: ${unique(ormDecoratorHits).join(", ")}`,
      "strong",
    );
  if (
    getProperties(candidate).some((p) =>
      /^(id|uuid|createdAt|updatedAt|deletedAt)$/.test(p),
    )
  )
    addSignal(
      result,
      1,
      "entity.persistence_fields",
      `${name} has persistence identity/timestamp fields`,
      "medium",
    );
  if (
    /Repository|EntityManager|save\(|findOne\(|findMany\(|prisma|typeorm|sequelize|mongoose/i.test(
      candidate.getSourceFile().getText(),
    )
  )
    addSignal(
      result,
      0.8,
      "entity.persistence_context",
      `${name} appears in persistence context`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /repository|mapper|entity|orm|model|persist|save|find/i,
      ),
    "bounded_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(ev, /repository|mapper|save|persist|find|entity/i),
    "bounded_call_path",
    0.7,
  );

  if (
    !hasDecorator(candidate, ["Entity"]) &&
    ormDecoratorHits.length < 2 &&
    !/Repository/.test(candidate.getSourceFile().getText())
  )
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectValueObject(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.value_object", candidate);
  const name = getNodeName(candidate);
  const properties = candidate.getProperties();
  const text = candidate.getText();

  if (
    /ValueObject$|VO$/.test(name) ||
    /Email|Money|Amount|Quantity|Address|Name|Range|Period|Slug|Identifier/.test(
      name,
    )
  )
    addSignal(
      result,
      1.1,
      "value_object.name_semantics",
      `${name} has value-object-like name`,
      "weak",
    );
  if (
    properties.length > 0 &&
    properties.every(
      (p) =>
        p.hasModifier(SyntaxKind.ReadonlyKeyword) ||
        p.hasModifier(SyntaxKind.PrivateKeyword),
    )
  )
    addSignal(
      result,
      1.5,
      "value_object.immutable_fields",
      `${name} uses private/readonly fields`,
      "strong",
    );
  if (
    methodNamed(candidate, ["equals"]) ||
    methodNamed(candidate, ["valueOf"]) ||
    methodNamed(candidate, ["toString"])
  )
    addSignal(
      result,
      1.5,
      "value_object_value_semantics",
      `${name} has equals/valueOf/toString semantics`,
      "strong",
    );
  if (
    candidate
      .getConstructors()
      .some((ctor) =>
        /throw|Invalid|assert|validate|if\s*\(/.test(ctor.getText()),
      )
  )
    addSignal(
      result,
      1.3,
      "value_object_constructor_invariants",
      `${name} constructor validates invariants`,
      "strong",
    );
  if (!getProperties(candidate).some((p) => /^id$|Id$|uuid$/i.test(p)))
    addSignal(
      result,
      0.8,
      "value_object_no_identity",
      `${name} has no obvious identity field`,
      "medium",
    );
  if (/Object\.freeze|Readonly<|private readonly/.test(text))
    addSignal(
      result,
      0.8,
      "value_object_immutability_type",
      `${name} uses immutability constructs`,
      "medium",
      "type",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /entity|domain|usecase|equals|valueOf|toString|specification|rule/i,
      ),
    "bounded_flow",
    0.7,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /entity|domain|usecase|equals|valueOf|toString|rule/i,
      ),
    "bounded_call_path",
    0.6,
  );

  if (getProperties(candidate).some((p) => /^id$|Id$|uuid$/i.test(p)))
    result.ambiguityPenalty += 1.5;
  if (hasDecorator(candidate, ORM_DECORATORS)) result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectUseCase(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.use_case", candidate);
  const name = getNodeName(candidate);
  const exec = methodNamed(candidate, ["execute", "handle", "run"]);

  if (/UseCase$|Interactor$|Action$|CommandHandler$|QueryHandler$/.test(name))
    addSignal(
      result,
      1.5,
      "use_case.name_suffix",
      `${name} has use-case/interactor/action name`,
      "weak",
    );
  if (exec)
    addSignal(
      result,
      2,
      "use_case.execution_method",
      `${name} has execute/handle/run method`,
      "strong",
    );
  if (hasConstructorInjection(candidate))
    addSignal(
      result,
      1.2,
      "use_case.constructor_dependencies",
      `${name} injects dependencies`,
      "medium",
    );
  if (
    getConstructorParameterTypes(candidate).some((t) =>
      /Repository|Gateway|Service|Client|UnitOfWork|Bus|Presenter/i.test(t),
    )
  )
    addSignal(
      result,
      1.2,
      "use_case_application_dependencies",
      `${name} depends on repositories/services/gateways`,
      "medium",
      "type",
    );
  if (exec && hasBoundaryParams(exec))
    addSignal(
      result,
      0.8,
      "use_case_input_dto",
      `${name}.${exec.getName()} accepts DTO/input-like parameter`,
      "medium",
    );
  if (exec && getCallExpressions(exec).length >= 2)
    addSignal(
      result,
      1,
      "use_case_orchestration_calls",
      `${name}.${exec.getName()} orchestrates multiple calls`,
      "strong",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /controller|resolver|handler|repository|service|gateway|dto|presenter|response|domain/i,
      ),
    "boundary_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /controller|resolver|handler|repository|service|gateway|domain|presenter/i,
      ),
    "orchestrates",
    0.8,
  );

  if (!exec) result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectPresenter(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (
    !Node.isClassDeclaration(candidate) &&
    !Node.isFunctionDeclaration(candidate) &&
    !Node.isArrowFunction(candidate)
  )
    return [];
  const result = createResult("pattern.presenter", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();

  if (/Presenter$|ViewModel$|Mapper$/.test(name))
    addSignal(
      result,
      1.2,
      "presenter.name_suffix",
      `${name} has presenter/view-model/mapper name`,
      "weak",
    );
  if (
    Node.isClassDeclaration(candidate) &&
    candidate
      .getMethods()
      .some((m) =>
        /^(present|format|toViewModel|toResponse|serialize|map)$/.test(
          m.getName(),
        ),
      )
  )
    addSignal(
      result,
      2,
      "presenter.transform_method",
      `${name} has presentation transform method`,
      "strong",
    );
  if (/toResponse|toViewModel|present|format|serialize/.test(text))
    addSignal(
      result,
      1.2,
      "presenter.transform_terms",
      `${name} uses response/view-model transform terms`,
      "medium",
    );
  if (getTransformationCalls(candidate).length > 0)
    addSignal(
      result,
      1,
      "presenter.array_transform",
      `${name} uses array transformation methods as behavioral signals`,
      "medium",
    );
  if (/return\s*{/.test(text) || /\.map\s*\(/.test(text))
    addSignal(
      result,
      0.8,
      "presenter_constructs_output",
      `${name} constructs transformed output`,
      "medium",
    );

  if (Node.isClassDeclaration(candidate)) {
    const methodTypes = candidate
      .getMethods()
      .map(
        (m) =>
          `${m.getParameters().map(safeTypeText).join(" ")} -> ${safeReturnTypeText(m)}`,
      );
    if (
      methodTypes.some(
        (t) =>
          /Entity|Domain|Result|UseCase/i.test(t) &&
          /Dto|Response|ViewModel|Payload|Output/i.test(t),
      )
    )
      addSignal(
        result,
        1.5,
        "presenter_type_boundary_conversion",
        `${name} converts domain/result types to response-like types`,
        "strong",
        "type",
      );
  }

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /entity|domain|result|usecase|controller|response|viewmodel|dto|mapper/i,
      ),
    "boundary_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /controller|resolver|handler|mapper|format|serialize|response/i,
      ),
    "bounded_call_path",
    0.7,
  );

  if (!/present|format|toViewModel|toResponse|serialize|map/.test(text))
    result.ambiguityPenalty += 1.2;
  return finalizePotential(result);
}

function detectResolver(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (!Node.isClassDeclaration(candidate)) return [];
  const result = createResult("pattern.resolver", candidate);
  const name = getNodeName(candidate);
  const sf = candidate.getSourceFile();
  const methodDecorators = candidate.getMethods().flatMap(getDecoratorNames);
  const gqlMethodDecorators = methodDecorators.filter((d) =>
    GRAPHQL_DECORATORS.has(d),
  );

  if (/Resolver$/.test(name))
    addSignal(
      result,
      1.5,
      "resolver.name_suffix",
      `${name} ends with Resolver`,
      "weak",
    );
  if (hasDecorator(candidate, ["Resolver"]))
    addSignal(
      result,
      3,
      "resolver.class_decorator",
      `${name} has @Resolver decorator`,
      "strong",
    );
  if (gqlMethodDecorators.length > 0)
    addSignal(
      result,
      2,
      "resolver.graphql_method_decorators",
      `${name} has GraphQL method decorators: ${unique(gqlMethodDecorators).join(", ")}`,
      "strong",
    );
  if (hasImportMatching(sf, [/graphql|@nestjs\/graphql|type-graphql/i]))
    addSignal(
      result,
      1.5,
      "resolver.graphql_import",
      `${name} imports GraphQL APIs`,
      "strong",
    );
  if (
    candidate
      .getMethods()
      .some((m) =>
        m
          .getParameters()
          .some((p) => hasDecorator(p, ["Args", "Context", "Parent", "Info"])),
      )
  )
    addSignal(
      result,
      1.2,
      "resolver.graphql_args_context",
      `${name} uses GraphQL args/context/parent params`,
      "strong",
    );
  if (hasConstructorInjection(candidate))
    addSignal(
      result,
      1,
      "resolver.injected_dependencies",
      `${name} injects dependencies`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /service|usecase|args|context|graphql|resolver|provider|module/i,
      ),
    "boundary_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /graphql|service|usecase|resolver|query|mutation/i,
      ),
    "boundary_entry_call",
    0.8,
  );

  if (
    !hasDecorator(candidate, ["Resolver"]) &&
    gqlMethodDecorators.length === 0 &&
    !hasImportMatching(sf, [/graphql|@nestjs\/graphql|type-graphql/i])
  )
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectProvider(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const results: DetectorResult[] = [];

  if (Node.isObjectLiteralExpression(candidate)) {
    const result = createResult("pattern.provider", candidate);
    if (objectLiteralHasProviderKeys(candidate))
      addSignal(
        result,
        3,
        "provider.object_keys",
        `Object literal has provider keys`,
        "strong",
      );
    const factory = propertyAssignmentByName(candidate, "useFactory");
    if (factory)
      addSignal(
        result,
        1.5,
        "provider.factory",
        "Provider uses useFactory",
        "strong",
      );
    if (propertyAssignmentByName(candidate, "inject"))
      addSignal(
        result,
        1,
        "provider.inject",
        "Provider declares injected dependency tokens",
        "medium",
      );
    addBoundedGraphEvidence(
      result,
      candidate,
      ctx,
      (ev) =>
        graphNameMatches(
          ev,
          /provider|container|module|factory|inject|token|service|repository/i,
        ),
      "registered_in_container",
      0.9,
    );
    addBoundedCallGraphEvidence(
      result,
      candidate,
      ctx,
      "both",
      (ev) =>
        callGraphNameMatches(
          ev,
          /factory|constructor|container|module|provider|create|register/i,
        ),
      "registered_callback",
      0.8,
    );
    results.push(...finalizePotential(result));
  }

  if (Node.isCallExpression(candidate)) {
    const result = createResult("pattern.provider", candidate);
    const method = getCalledMethodName(candidate);
    if (CONTAINER_METHODS.has(method))
      addSignal(
        result,
        2.5,
        "provider.container_registration_call",
        `Container registration call ${getCallExpressionText(candidate)}`,
        "strong",
      );
    if (
      candidate
        .getArguments()
        .some((a) => /useClass|useValue|useFactory|provide/.test(a.getText()))
    )
      addSignal(
        result,
        1.2,
        "provider.registration_provider_shape",
        "Registration arguments include provider-shaped values",
        "medium",
      );
    addBoundedCallGraphEvidence(
      result,
      candidate,
      ctx,
      "outgoing",
      (ev) =>
        callGraphNameMatches(
          ev,
          /constructor|factory|provider|container|module/i,
        ),
      "registered_callback",
      0.8,
    );
    results.push(...finalizePotential(result));
  }

  if (
    Node.isClassDeclaration(candidate) &&
    hasDecorator(candidate, ["Injectable"])
  ) {
    const result = createResult("pattern.provider", candidate);
    addSignal(
      result,
      1.5,
      "provider.injectable_decorator",
      `${getNodeName(candidate)} is injectable provider candidate`,
      "medium",
    );
    if (hasConstructorInjection(candidate))
      addSignal(
        result,
        1,
        "provider.constructor_dependencies",
        `${getNodeName(candidate)} has DI constructor`,
        "medium",
      );
    addBoundedGraphEvidence(
      result,
      candidate,
      ctx,
      (ev) =>
        graphNameMatches(
          ev,
          /provider|container|module|inject|service|repository/i,
        ),
      "registered_in_container",
      0.7,
    );
    results.push(...finalizePotential(result));
  }

  return results;
}

function detectCompositionRoot(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const sf = candidate.getSourceFile();
  const filePath = normalizePath(sf.getFilePath());
  const result = createResult("pattern.composition_root", candidate);
  const fileNameSignal =
    /(?:^|\/)(main|bootstrap|app\.module|container|composition-root|compositionRoot)\.tsx?$/.test(
      filePath,
    );
  const text = candidate.getText();

  if (fileNameSignal)
    addSignal(
      result,
      1.8,
      "composition_root.file_name",
      `${filePath} is a conventional composition-root file`,
      "weak",
    );
  if (
    /NestFactory\.create|createApp\(|express\(|fastify\(|new\s+Hono|new\s+Koa|listen\s*\(/.test(
      text,
    )
  )
    addSignal(
      result,
      2.5,
      "composition_root.bootstrap_startup_call",
      `${getNodeName(candidate)} performs app/server bootstrap`,
      "strong",
    );
  if (
    /container\.|\.register\(|\.bind\(|providers\s*:|imports\s*:|modules\s*:/.test(
      text,
    )
  )
    addSignal(
      result,
      2,
      "composition_root_di_wiring",
      `${getNodeName(candidate)} performs DI/container/module wiring`,
      "strong",
    );
  if ((text.match(/new\s+[A-Z]\w+/g) ?? []).length >= 3)
    addSignal(
      result,
      1.2,
      "composition_root_concentrated_construction",
      `${getNodeName(candidate)} constructs several objects`,
      "medium",
    );
  if (/process\.env|ConfigService|dotenv|env\./.test(text))
    addSignal(
      result,
      0.8,
      "composition_root_config_env",
      `${getNodeName(candidate)} reads configuration/environment`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /config|env|provider|container|module|controller|service|repository|app|server/i,
      ),
    "registered_in_container",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "outgoing",
    (ev) =>
      callGraphNameMatches(
        ev,
        /create|listen|register|bind|bootstrap|module|provider|server|app|container/i,
      ),
    "orchestrates",
    0.8,
  );

  if (
    !fileNameSignal &&
    !/listen\s*\(|NestFactory\.create|container\.|providers\s*:/.test(text)
  )
    result.ambiguityPenalty += 1.8;
  return finalizePotential(result);
}

function detectCache(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.cache", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();
  const sf = candidate.getSourceFile();

  if (/Cache|Cached|Memoized|Memo/i.test(name))
    addSignal(
      result,
      1.2,
      "cache.name_semantics",
      `${name} has cache/memoized name`,
      "weak",
    );
  if (
    /new\s+(Map|WeakMap)\s*\(|Redis|cache-manager|lru-cache|NodeCache/i.test(
      text,
    ) ||
    hasImportMatching(sf, [/redis|cache-manager|lru-cache|node-cache|ioredis/i])
  )
    addSignal(
      result,
      2,
      "cache.storage_or_library",
      `${name} uses cache storage or cache library`,
      "strong",
    );
  if (hasCallNamed(candidate, CACHE_METHODS))
    addSignal(
      result,
      1.5,
      "cache.cache_api_methods",
      `${name} calls cache get/set/has/delete/invalidate-like methods`,
      "strong",
    );
  if (/ttl|expires|expiration|Date\.now\(|maxAge|stale/i.test(text))
    addSignal(
      result,
      1,
      "cache_ttl_expiration",
      `${name} contains TTL/expiration logic`,
      "medium",
    );
  if (/if\s*\(.+\.has\(|if\s*\(.+\.get\(|return\s+.+\.get\(/s.test(text))
    addSignal(
      result,
      1,
      "cache_hit_branch",
      `${name} has cache-hit read-before-compute behavior`,
      "strong",
    );
  if (/\.set\s*\(.+\)|\.delete\s*\(|invalidate/i.test(text))
    addSignal(
      result,
      1,
      "cache_write_invalidate",
      `${name} writes or invalidates cached values`,
      "strong",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /cache|key|ttl|result|invalidate|redis|map|client|service/i,
      ),
    "bounded_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /cache|get|set|invalidate|client|fetch|service|repository/i,
      ),
    "wraps_call",
    0.8,
  );

  if (!/Map|Cache|Redis|cache|memo/i.test(text + name))
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectRetryPolicy(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.retry_policy", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();
  const sf = candidate.getSourceFile();

  if (/Retry|Backoff|RetryPolicy/i.test(name))
    addSignal(
      result,
      1.2,
      "retry.name_semantics",
      `${name} has retry/backoff name`,
      "weak",
    );
  if (hasImportMatching(sf, [/p-retry|async-retry|axios-retry|\bretry\b/i]))
    addSignal(
      result,
      2,
      "retry.library_import",
      `${name} imports retry library`,
      "strong",
    );
  if (hasLoop(candidate) && hasTryCatch(candidate))
    addSignal(
      result,
      2,
      "retry.loop_try_catch",
      `${name} wraps work in loop plus try/catch`,
      "strong",
    );
  if (/attempt|attempts|retries|maxRetries|maxAttempts|retryCount/i.test(text))
    addSignal(
      result,
      1.2,
      "retry_attempt_counter",
      `${name} tracks retry attempts`,
      "medium",
    );
  if (/delay|sleep|backoff|setTimeout|exponential|jitter/i.test(text))
    addSignal(
      result,
      1.2,
      "retry_backoff_delay",
      `${name} contains delay/backoff behavior`,
      "medium",
    );
  if (
    /catch\s*\(|catch\s*\{|Transient|ECONNRESET|ETIMEDOUT|rate.?limit/i.test(
      text,
    )
  )
    addSignal(
      result,
      0.8,
      "retry_transient_error",
      `${name} handles transient errors`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /attempt|retry|error|delay|backoff|client|service|call/i,
      ),
    "bounded_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "outgoing",
    (ev) =>
      callGraphNameMatches(
        ev,
        /delay|sleep|backoff|client|request|fetch|service|callback/i,
      ),
    "retry_wrapped_call",
    0.8,
  );

  if (
    !(hasLoop(candidate) && hasTryCatch(candidate)) &&
    !hasImportMatching(sf, [/p-retry|async-retry|axios-retry|\bretry\b/i])
  )
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectCircuitBreaker(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.circuit_breaker", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();
  const sf = candidate.getSourceFile();

  if (/CircuitBreaker|Breaker/i.test(name))
    addSignal(
      result,
      1.4,
      "breaker.name_semantics",
      `${name} has circuit breaker name`,
      "weak",
    );
  if (hasImportMatching(sf, [/opossum|cockatiel|circuit-breaker/i]))
    addSignal(
      result,
      2,
      "breaker.library_import",
      `${name} imports circuit breaker library`,
      "strong",
    );
  if (/closed|open|halfOpen|half_open|HALF_OPEN|CLOSED|OPEN/.test(text))
    addSignal(
      result,
      2,
      "breaker_state_terms",
      `${name} tracks closed/open/half-open state`,
      "strong",
    );
  if (/failure|failures|failureCount|threshold|maxFailures/i.test(text))
    addSignal(
      result,
      1.3,
      "breaker_failure_threshold",
      `${name} tracks failures/thresholds`,
      "medium",
    );
  if (/reset|timeout|cooldown|window|nextAttempt|Date\.now\(/i.test(text))
    addSignal(
      result,
      1,
      "breaker_reset_window",
      `${name} has reset/timeout window logic`,
      "medium",
    );
  if (/if\s*\(.+open.+\)\s*{[^}]*throw|short.?circuit|CircuitOpen/i.test(text))
    addSignal(
      result,
      1.5,
      "breaker_short_circuit",
      `${name} short-circuits protected calls`,
      "strong",
    );
  if (hasTryCatch(candidate) && /failure|open|threshold/i.test(text))
    addSignal(
      result,
      1,
      "breaker_error_transition",
      `${name} updates breaker state on errors`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /open|closed|half|failure|threshold|timeout|client|service|protected/i,
      ),
    "bounded_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "outgoing",
    (ev) =>
      callGraphNameMatches(ev, /client|request|service|call|fallback|timeout/i),
    "breaker_protected_call",
    0.8,
  );

  if (!/open|halfOpen|closed|threshold|opossum/i.test(text))
    result.ambiguityPenalty += 1.8;
  return finalizePotential(result);
}

function detectQueueConsumer(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.queue_consumer", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();
  const sf = candidate.getSourceFile();

  if (/Consumer$|Worker$|Processor$|Handler$/i.test(name))
    addSignal(
      result,
      1,
      "queue_consumer.name_suffix",
      `${name} has consumer/worker/processor/handler name`,
      "weak",
    );
  if (
    hasImportMatching(sf, [
      /bull|bullmq|amqplib|rabbit|kafkajs|sqs|sns|pubsub|nats|@nestjs\/microservices/i,
    ])
  )
    addSignal(
      result,
      2,
      "queue_consumer.queue_import",
      `${name} imports queue/messaging APIs`,
      "strong",
    );
  if (
    hasDecorator(candidate, QUEUE_DECORATORS) ||
    candidate.getDescendants().some((d) => hasDecorator(d, QUEUE_DECORATORS))
  )
    addSignal(
      result,
      2.2,
      "queue_consumer.decorators",
      `${name} uses queue/message processor decorators`,
      "strong",
    );
  if (hasCallNamed(candidate, QUEUE_METHODS))
    addSignal(
      result,
      2,
      "queue_consumer.registration_call",
      `${name} registers queue/message consumer`,
      "strong",
    );
  if (
    /job|message|event|payload|record|topic|partition|subscription/i.test(text)
  )
    addSignal(
      result,
      1,
      "queue_consumer_payload_terms",
      `${name} receives job/message/event payloads`,
      "medium",
    );
  if (hasCallNamed(candidate, ACK_METHODS))
    addSignal(
      result,
      1.2,
      "queue_consumer_ack",
      `${name} acknowledges/commits/rejects messages`,
      "strong",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /job|message|payload|queue|topic|subscription|ack|nack|commit|service|usecase/i,
      ),
    "registered_in_pipeline",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /queue|worker|consume|message|job|ack|commit|service|usecase/i,
      ),
    "queue_handler_call",
    0.8,
  );

  if (
    !hasCallNamed(candidate, QUEUE_METHODS) &&
    !hasDecorator(candidate, QUEUE_DECORATORS) &&
    !hasImportMatching(sf, [
      /bull|bullmq|amqplib|rabbit|kafkajs|sqs|sns|pubsub|nats/i,
    ])
  )
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectScheduler(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.scheduler", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();
  const sf = candidate.getSourceFile();

  if (/Scheduler$|Job$|Task$/i.test(name))
    addSignal(
      result,
      1,
      "scheduler.name_suffix",
      `${name} has scheduler/job/task name`,
      "weak",
    );
  if (
    hasDecorator(candidate, SCHEDULER_DECORATORS) ||
    candidate
      .getDescendants()
      .some((d) => hasDecorator(d, SCHEDULER_DECORATORS))
  )
    addSignal(
      result,
      2.5,
      "scheduler.decorators",
      `${name} uses Cron/Interval/Timeout decorators`,
      "strong",
    );
  if (hasCallNamed(candidate, SCHEDULER_METHODS))
    addSignal(
      result,
      2,
      "scheduler.api_call",
      `${name} calls scheduling API`,
      "strong",
    );
  if (
    hasImportMatching(sf, [
      /node-cron|cron|agenda|bree|schedule|@nestjs\/schedule/i,
    ])
  )
    addSignal(
      result,
      1.5,
      "scheduler.library_import",
      `${name} imports scheduling library`,
      "strong",
    );
  if (
    /\* \* \*|cron|every|interval|timeout|recurrence|Date\(|setInterval|setTimeout/i.test(
      text,
    )
  )
    addSignal(
      result,
      1,
      "scheduler_schedule_expression",
      `${name} contains schedule/timing expression`,
      "medium",
    );
  if (Node.isClassDeclaration(candidate) && hasConstructorInjection(candidate))
    addSignal(
      result,
      0.8,
      "scheduler_service_dependency",
      `${name} invokes injected work dependencies`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /schedule|cron|interval|timeout|job|task|service|usecase|logger|monitor/i,
      ),
    "scheduled_execution",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /schedule|cron|interval|timeout|job|service|usecase|callback/i,
      ),
    "scheduled_callback",
    0.8,
  );

  if (
    !hasCallNamed(candidate, SCHEDULER_METHODS) &&
    !hasDecorator(candidate, SCHEDULER_DECORATORS) &&
    !hasImportMatching(sf, [/node-cron|cron|agenda|bree|schedule/i])
  )
    result.ambiguityPenalty += 1.5;
  return finalizePotential(result);
}

function detectFeatureFlag(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  const result = createResult("pattern.feature_flag", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();
  const sf = candidate.getSourceFile();

  if (/FeatureFlag|Flag|Experiment|Toggle/i.test(name))
    addSignal(
      result,
      1,
      "feature_flag.name_semantics",
      `${name} has feature-flag/experiment/toggle name`,
      "weak",
    );
  if (
    hasImportMatching(sf, [
      /launchdarkly|unleash|configcat|splitio|growthbook|feature-flag/i,
    ])
  )
    addSignal(
      result,
      2,
      "feature_flag.library_import",
      `${name} imports feature flag provider`,
      "strong",
    );
  if (hasCallNamed(candidate, FLAG_METHODS))
    addSignal(
      result,
      2,
      "feature_flag.api_call",
      `${name} calls feature flag API`,
      "strong",
    );
  if (
    /if\s*\(.+(flag|toggle|experiment|variation|isEnabled|getFlag)/i.test(text)
  )
    addSignal(
      result,
      1.5,
      "feature_flag_conditional_branch",
      `${name} branches on flag-like value`,
      "strong",
    );
  if (
    /['\"][a-z0-9_.:-]+(?:flag|experiment|toggle|variant|feature)[a-z0-9_.:-]*['\"]/i.test(
      text,
    )
  )
    addSignal(
      result,
      0.8,
      "feature_flag_key_literal",
      `${name} contains flag-key-like literals`,
      "medium",
    );
  if (
    /else|\?\s*.+:/.test(text) &&
    /flag|variation|experiment|toggle/i.test(text)
  )
    addSignal(
      result,
      0.8,
      "feature_flag_divergent_paths",
      `${name} has alternate paths based on flag terms`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /flag|toggle|experiment|variation|variant|feature|config|branch/i,
      ),
    "bounded_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "outgoing",
    (ev) =>
      callGraphNameMatches(
        ev,
        /flag|variation|enabled|service|legacy|new|experiment|toggle/i,
      ),
    "guarded_call",
    0.8,
  );

  if (
    !hasCallNamed(candidate, FLAG_METHODS) &&
    !hasImportMatching(sf, [
      /launchdarkly|unleash|configcat|splitio|growthbook/i,
    ])
  )
    result.ambiguityPenalty += 1.2;
  return finalizePotential(result);
}

function detectSpecification(
  candidate: DetectorCandidate,
  ctx: RequiredPatternDetectorContext,
): DetectorResult[] {
  if (
    !Node.isClassDeclaration(candidate) &&
    !Node.isFunctionDeclaration(candidate) &&
    !Node.isArrowFunction(candidate)
  )
    return [];
  const result = createResult("pattern.specification", candidate);
  const name = getNodeName(candidate);
  const text = candidate.getText();

  if (/Specification$|Spec$|Rule$|Predicate$/i.test(name))
    addSignal(
      result,
      1.2,
      "specification.name_suffix",
      `${name} has specification/spec/rule/predicate name`,
      "weak",
    );
  if (
    Node.isClassDeclaration(candidate) &&
    methodNamed(candidate, ["isSatisfiedBy"])
  )
    addSignal(
      result,
      2,
      "specification.is_satisfied_by",
      `${name} has isSatisfiedBy predicate`,
      "strong",
    );
  if (
    Node.isClassDeclaration(candidate) &&
    candidate.getMethods().some((m) => /^(and|or|not)$/.test(m.getName()))
  )
    addSignal(
      result,
      1.5,
      "specification_composition_methods",
      `${name} has and/or/not composition methods`,
      "strong",
    );
  if (returnTypeLooksBoolean(candidate))
    addSignal(
      result,
      1,
      "specification_boolean_return",
      `${name} has boolean predicate return`,
      "medium",
      "type",
    );
  if (getPredicateArrayCalls(candidate).length > 0)
    addSignal(
      result,
      1.2,
      "specification_array_predicate_usage",
      `${name} uses filter/some/every as first-class predicate signals`,
      "medium",
    );
  if (
    /=>\s*.+[=!<>]=|return\s+.+[=!<>]=|&&|\|\|/.test(text) &&
    /domain|entity|item|candidate|value|rule|policy/i.test(text)
  )
    addSignal(
      result,
      0.8,
      "specification_business_predicate",
      `${name} contains business predicate logic`,
      "medium",
    );

  addBoundedGraphEvidence(
    result,
    candidate,
    ctx,
    (ev) =>
      graphNameMatches(
        ev,
        /filter|query|select|entity|domain|rule|specification|predicate|isSatisfied/i,
      ),
    "bounded_flow",
    0.8,
  );
  addBoundedCallGraphEvidence(
    result,
    candidate,
    ctx,
    "both",
    (ev) =>
      callGraphNameMatches(
        ev,
        /filter|query|select|isSatisfied|and|or|not|rule|domain/i,
      ),
    "bounded_call_path",
    0.8,
  );

  if (!/isSatisfiedBy|filter|some|every|and\(|or\(|not\(/.test(text))
    result.ambiguityPenalty += 1.2;
  return finalizePotential(result);
}

// -------------------------------------------------------------------------------------------------
// Pattern scoring documentation exported for downstream tools/UIs.
// -------------------------------------------------------------------------------------------------

export const additionalPatternKeys: AdditionalPatternKey[] = [
  "pattern.controller",
  "pattern.route_handler",
  "pattern.guard",
  "pattern.interceptor",
  "pattern.validator",
  "pattern.dto",
  "pattern.entity",
  "pattern.value_object",
  "pattern.use_case",
  "pattern.presenter",
  "pattern.resolver",
  "pattern.provider",
  "pattern.composition_root",
  "pattern.cache",
  "pattern.retry_policy",
  "pattern.circuit_breaker",
  "pattern.queue_consumer",
  "pattern.scheduler",
  "pattern.feature_flag",
  "pattern.specification",
];

export const patternScoringNotes: Record<AdditionalPatternKey, string[]> = {
  "pattern.controller": [
    "Strong: controller/HTTP decorators and boundary methods",
    "Medium: injected services/use-cases and request/response params",
    "Weak: Controller suffix only",
  ],
  "pattern.route_handler": [
    "Strong: route registration calls and response termination",
    "Medium: req/res/next-like params",
    "Weak: Handler suffix only",
  ],
  "pattern.guard": [
    "Strong: CanActivate/canActivate/authz methods",
    "Medium: boolean returns and auth/session/permission data",
    "Weak: Guard suffix only",
  ],
  "pattern.interceptor": [
    "Strong: intercept + next.handle + interceptor interface",
    "Medium: RxJS/pipeline operators",
    "Weak: Interceptor suffix only",
  ],
  "pattern.validator": [
    "Strong: validation libraries/decorators/parse APIs",
    "Medium: validation-result branches",
    "Weak: Validator/Schema suffix only",
  ],
  "pattern.dto": [
    "Strong: mostly-data shape at API boundary",
    "Medium: validation/serialization decorators",
    "Weak: Dto/Input/Output suffix only",
  ],
  "pattern.entity": [
    "Strong: ORM decorators or repository persistence use",
    "Medium: id/timestamp/relationship fields",
    "Weak: Entity suffix only",
  ],
  "pattern.value_object": [
    "Strong: immutability + equality/value semantics/invariants",
    "Medium: no identity field",
    "Weak: domain value-like name only",
  ],
  "pattern.use_case": [
    "Strong: execute/handle/run plus orchestration",
    "Medium: repository/service/gateway dependencies",
    "Weak: UseCase suffix only",
  ],
  "pattern.presenter": [
    "Strong: transform methods and domain-to-response type conversion",
    "Medium: map/flatMap/reduce transformation behavior",
    "Weak: Presenter/Mapper suffix only",
  ],
  "pattern.resolver": [
    "Strong: GraphQL decorators/imports and args/context",
    "Medium: injected services/use-cases",
    "Weak: Resolver suffix only",
  ],
  "pattern.provider": [
    "Strong: provider object keys/container registration",
    "Medium: useFactory/inject metadata",
    "Weak: Injectable decorator only",
  ],
  "pattern.composition_root": [
    "Strong: bootstrap/listen/container wiring",
    "Medium: concentrated construction/env config",
    "Weak: conventional filename only",
  ],
  "pattern.cache": [
    "Strong: cache storage plus get/set/invalidation",
    "Medium: TTL/key logic",
    "Weak: cache-ish name only",
  ],
  "pattern.retry_policy": [
    "Strong: retry library or loop+try/catch",
    "Medium: attempts/backoff/transient error handling",
    "Weak: Retry suffix only",
  ],
  "pattern.circuit_breaker": [
    "Strong: open/closed/half-open state plus short-circuit",
    "Medium: failure threshold/reset window",
    "Weak: Breaker suffix only",
  ],
  "pattern.queue_consumer": [
    "Strong: queue imports/decorators/registration",
    "Medium: job/message payload and ack/nack",
    "Weak: Worker/Consumer suffix only",
  ],
  "pattern.scheduler": [
    "Strong: cron/interval/timeout decorators or scheduling API",
    "Medium: schedule expression plus dependency call",
    "Weak: Job/Task suffix only",
  ],
  "pattern.feature_flag": [
    "Strong: provider APIs or conditionals driven by flag lookup",
    "Medium: flag keys and divergent paths",
    "Weak: Flag/Toggle name only",
  ],
  "pattern.specification": [
    "Strong: isSatisfiedBy and/or/not composition",
    "Medium: filter/some/every predicate use",
    "Weak: Spec/Rule suffix only",
  ],
};

export const boundedTraversalNotes = {
  definitionUseGraph:
    "Definition/use graph traversal is breadth-first, starts from records matching the candidate symbol/name/location, and stops at graphMaxDepth or graphMaxRecordsPerTraversal. Its score contribution is capped by graphScoreCapPerPattern and cannot by itself produce high confidence.",
  callGraph:
    "Call graph traversal is breadth-first, supports incoming/outgoing/both directions, and stops at callGraphMaxDepth or callGraphMaxCallsPerTraversal. Its score contribution is capped by callGraphScoreCapPerPattern and cannot by itself produce high confidence.",
};

export const exampleCliUsage = String.raw`
import { Project } from "ts-morph";
import { detectPatterns, deserializeCallGraph } from "./pattern-detector";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
const checker = project.getTypeChecker();
const definitionUseGraph = new Map(); // build or load your DefinitionUseGraph
const callGraph = deserializeCallGraph(JSON.parse(await fs.promises.readFile("call-graph.json", "utf8")));

const detections = detectPatterns({
  project,
  checker,
  definitionUseGraph,
  callGraph,
  config: { includeTestFiles: false },
});

console.log(JSON.stringify(detections, null, 2));
`;

export const exampleJsonOutput = {
  pattern: "pattern.use_case",
  detected: true,
  confidence: "high",
  score: 8.1,
  filePath: "src/application/CreateOrderUseCase.ts",
  nodeKind: "ClassDeclaration",
  nodeName: "CreateOrderUseCase",
  startLine: 8,
  endLine: 74,
  evidence: [
    "CreateOrderUseCase has use-case/interactor/action name",
    "CreateOrderUseCase has execute/handle/run method",
    "CreateOrderUseCase depends on repositories/services/gateways",
  ],
  matchedRules: [
    "use_case.name_suffix",
    "use_case.execution_method",
    "use_case_application_dependencies",
  ],
  graphEvidence: [
    {
      recordId: "src/controllers/OrderController.ts:orderUseCase",
      recordName: "orderUseCase",
      relation: "boundary_flow",
      distance: 1,
      filePath: "src/controllers/OrderController.ts",
      line: 12,
      column: 5,
      description:
        "CreateOrderUseCase is read by OrderController.create via orderUseCase",
    },
  ],
  callGraphEvidence: [
    {
      callerId: "OrderController.create",
      callerName: "OrderController.create",
      calleeId: "CreateOrderUseCase.execute",
      calleeName: "CreateOrderUseCase.execute",
      relation: "orchestrates",
      distance: 1,
      description: "OrderController.create calls CreateOrderUseCase.execute",
    },
  ],
};

export const falsePositiveFalseNegativeNotes = {
  falsePositives: [
    "Framework-neutral classes with names like Controller, Handler, or Worker can be over-scored if they also have broad service calls.",
    "DTO/entity/value-object boundaries can blur in Active Record or anemic-domain codebases.",
    "Array methods are treated as behavioral signals: map/flatMap/reduce strengthen presenter/transformation evidence; filter/some/every strengthen specification/predicate evidence; forEach strengthens side-effect/consumer signals only when paired with contextual evidence.",
  ],
  falseNegatives: [
    "Highly dynamic registration, reflection, metadata generated outside TypeScript, or decorator factories hidden behind aliases may be missed.",
    "Incomplete definition/use or call graphs reduce flow evidence but should not suppress strong local AST detections.",
    "Minified/generated code and anonymous callbacks can degrade naming and symbol matching.",
  ],
  scoreTuning: [
    "Raise high threshold when the codebase has many conventionally named but framework-neutral classes.",
    "Lower medium threshold if your provided graphs are known to be sparse or only partially built.",
    "Keep graphScoreCapPerPattern and callGraphScoreCapPerPattern low enough that graph evidence refines local detections rather than replacing them.",
    "Add project-specific decorator, route, queue, scheduler, or DI method names to the constant sets near the top of this file.",
  ],
};
