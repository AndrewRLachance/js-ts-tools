import type { Project, TypeChecker } from "ts-morph";

export type BasePatternKey =
  | "pattern.singleton"
  | "pattern.dependency_injection"
  | "pattern.factory"
  | "pattern.observer"
  | "pattern.interface_based"
  | "pattern.repository"
  | "pattern.service"
  | "pattern.strategy"
  | "pattern.builder"
  | "pattern.adapter"
  | "pattern.facade"
  | "pattern.decorator"
  | "pattern.proxy"
  | "pattern.command"
  | "pattern.middleware"
  | "pattern.event_emitter"
  | "pattern.registry"
  | "pattern.plugin"
  | "pattern.mapper"
  | "pattern.module_boundary"
  | "pattern.unit_of_work";

export type AdditionalPatternKey =
  | "pattern.controller"
  | "pattern.route_handler"
  | "pattern.guard"
  | "pattern.interceptor"
  | "pattern.validator"
  | "pattern.dto"
  | "pattern.entity"
  | "pattern.value_object"
  | "pattern.use_case"
  | "pattern.presenter"
  | "pattern.resolver"
  | "pattern.provider"
  | "pattern.composition_root"
  | "pattern.cache"
  | "pattern.retry_policy"
  | "pattern.circuit_breaker"
  | "pattern.queue_consumer"
  | "pattern.scheduler"
  | "pattern.feature_flag"
  | "pattern.specification";

export type PatternKey = BasePatternKey | AdditionalPatternKey;
export type PatternConfidence = "low" | "medium" | "high";
export type DetectionMode = "primary" | "secondary" | "supporting";

export type PatternLabel<K extends PatternKey = PatternKey> = {
  pattern: K;
  mode: DetectionMode;
};

export type PatternIntersectionRule<K extends PatternKey = PatternKey> = {
  pattern: K;
  intersectsWith: K[];
  guidance?: string;
};

export const commonPatternIntersections: Readonly<
  Record<PatternKey, readonly PatternKey[]>
> = {
  "pattern.singleton": [],
  "pattern.dependency_injection": [
    "pattern.controller",
    "pattern.service",
    "pattern.repository",
    "pattern.factory",
    "pattern.strategy",
    "pattern.adapter",
    "pattern.registry",
    "pattern.provider",
    "pattern.composition_root",
  ],
  "pattern.factory": [
    "pattern.strategy",
    "pattern.registry",
    "pattern.plugin",
    "pattern.provider",
    "pattern.interface_based",
    "pattern.dependency_injection",
    "pattern.feature_flag",
  ],
  "pattern.observer": [
    "pattern.event_emitter",
    "pattern.plugin",
    "pattern.middleware",
  ],
  "pattern.interface_based": [
    "pattern.repository",
    "pattern.factory",
    "pattern.strategy",
    "pattern.adapter",
    "pattern.decorator",
    "pattern.provider",
    "pattern.module_boundary",
  ],
  "pattern.repository": [
    "pattern.dependency_injection",
    "pattern.interface_based",
    "pattern.unit_of_work",
    "pattern.adapter",
    "pattern.mapper",
    "pattern.entity",
  ],
  "pattern.service": [
    "pattern.dependency_injection",
    "pattern.repository",
    "pattern.facade",
    "pattern.unit_of_work",
    "pattern.cache",
    "pattern.retry_policy",
    "pattern.use_case",
  ],
  "pattern.strategy": [
    "pattern.interface_based",
    "pattern.factory",
    "pattern.registry",
    "pattern.dependency_injection",
    "pattern.feature_flag",
  ],
  "pattern.builder": [],
  "pattern.adapter": [
    "pattern.interface_based",
    "pattern.dependency_injection",
    "pattern.proxy",
    "pattern.decorator",
    "pattern.retry_policy",
    "pattern.circuit_breaker",
    "pattern.mapper",
    "pattern.repository",
  ],
  "pattern.facade": ["pattern.service"],
  "pattern.decorator": [
    "pattern.proxy",
    "pattern.interface_based",
    "pattern.cache",
    "pattern.retry_policy",
    "pattern.circuit_breaker",
    "pattern.adapter",
    "pattern.interceptor",
  ],
  "pattern.proxy": [
    "pattern.decorator",
    "pattern.cache",
    "pattern.retry_policy",
    "pattern.circuit_breaker",
    "pattern.adapter",
    "pattern.interceptor",
  ],
  "pattern.command": [
    "pattern.use_case",
    "pattern.queue_consumer",
    "pattern.scheduler",
  ],
  "pattern.middleware": [
    "pattern.route_handler",
    "pattern.guard",
    "pattern.interceptor",
    "pattern.observer",
  ],
  "pattern.event_emitter": [
    "pattern.observer",
    "pattern.plugin",
    "pattern.queue_consumer",
  ],
  "pattern.registry": [
    "pattern.factory",
    "pattern.plugin",
    "pattern.strategy",
    "pattern.provider",
    "pattern.dependency_injection",
  ],
  "pattern.plugin": [
    "pattern.factory",
    "pattern.registry",
    "pattern.observer",
    "pattern.event_emitter",
  ],
  "pattern.mapper": [
    "pattern.dto",
    "pattern.entity",
    "pattern.presenter",
    "pattern.adapter",
    "pattern.repository",
    "pattern.route_handler",
    "pattern.use_case",
  ],
  "pattern.module_boundary": [
    "pattern.composition_root",
    "pattern.provider",
    "pattern.interface_based",
  ],
  "pattern.unit_of_work": [
    "pattern.service",
    "pattern.repository",
    "pattern.use_case",
  ],
  "pattern.controller": [
    "pattern.route_handler",
    "pattern.dependency_injection",
    "pattern.dto",
    "pattern.validator",
    "pattern.service",
    "pattern.use_case",
    "pattern.guard",
    "pattern.interceptor",
  ],
  "pattern.route_handler": [
    "pattern.middleware",
    "pattern.validator",
    "pattern.dto",
    "pattern.service",
    "pattern.use_case",
    "pattern.mapper",
    "pattern.controller",
  ],
  "pattern.guard": [
    "pattern.middleware",
    "pattern.interceptor",
    "pattern.specification",
    "pattern.dependency_injection",
    "pattern.validator",
    "pattern.feature_flag",
  ],
  "pattern.interceptor": [
    "pattern.middleware",
    "pattern.decorator",
    "pattern.proxy",
    "pattern.retry_policy",
    "pattern.cache",
    "pattern.guard",
    "pattern.controller",
  ],
  "pattern.validator": [
    "pattern.dto",
    "pattern.controller",
    "pattern.route_handler",
    "pattern.guard",
    "pattern.specification",
  ],
  "pattern.dto": [
    "pattern.controller",
    "pattern.route_handler",
    "pattern.validator",
    "pattern.use_case",
    "pattern.mapper",
  ],
  "pattern.entity": [
    "pattern.repository",
    "pattern.mapper",
    "pattern.specification",
  ],
  "pattern.value_object": [
    "pattern.entity",
    "pattern.dto",
    "pattern.validator",
  ],
  "pattern.use_case": [
    "pattern.command",
    "pattern.service",
    "pattern.repository",
    "pattern.dto",
    "pattern.mapper",
    "pattern.presenter",
    "pattern.unit_of_work",
    "pattern.queue_consumer",
    "pattern.scheduler",
  ],
  "pattern.presenter": ["pattern.use_case", "pattern.mapper", "pattern.dto"],
  "pattern.resolver": [
    "pattern.controller",
    "pattern.route_handler",
    "pattern.service",
    "pattern.use_case",
    "pattern.dto",
  ],
  "pattern.provider": [
    "pattern.factory",
    "pattern.dependency_injection",
    "pattern.composition_root",
    "pattern.registry",
    "pattern.module_boundary",
  ],
  "pattern.composition_root": [
    "pattern.provider",
    "pattern.factory",
    "pattern.dependency_injection",
    "pattern.module_boundary",
    "pattern.feature_flag",
  ],
  "pattern.cache": [
    "pattern.proxy",
    "pattern.decorator",
    "pattern.service",
    "pattern.repository",
    "pattern.adapter",
    "pattern.interceptor",
  ],
  "pattern.retry_policy": [
    "pattern.proxy",
    "pattern.decorator",
    "pattern.adapter",
    "pattern.service",
    "pattern.queue_consumer",
    "pattern.interceptor",
    "pattern.circuit_breaker",
  ],
  "pattern.circuit_breaker": [
    "pattern.proxy",
    "pattern.decorator",
    "pattern.adapter",
    "pattern.retry_policy",
  ],
  "pattern.queue_consumer": [
    "pattern.command",
    "pattern.use_case",
    "pattern.service",
    "pattern.dto",
    "pattern.retry_policy",
    "pattern.event_emitter",
    "pattern.scheduler",
  ],
  "pattern.scheduler": [
    "pattern.command",
    "pattern.use_case",
    "pattern.service",
    "pattern.queue_consumer",
  ],
  "pattern.feature_flag": [
    "pattern.strategy",
    "pattern.factory",
    "pattern.guard",
    "pattern.service",
    "pattern.composition_root",
  ],
  "pattern.specification": [
    "pattern.validator",
    "pattern.guard",
    "pattern.repository",
    "pattern.entity",
    "pattern.use_case",
  ],
};

export const patternOverlapGuidance = {
  proxyDecoratorAdapter:
    "Adapter changes interface/shape; decorator preserves interface and adds behavior; proxy preserves interface and controls access, lifecycle, remote interaction, or cache behavior.",
  factoryProviderRegistry:
    "Factory creates; provider declares how something is supplied; registry stores or resolves by key/token.",
  observerEventEmitter:
    "An event emitter is a concrete observer variant; event_emitter usually implies observer, but observer does not always imply event_emitter.",
  controllerRouteHandler:
    "Class-based HTTP endpoints can be both controllers and route handlers, especially when method decorators bind methods to routes.",
} as const;

export interface DefinitionUseAssignment {
  definedBy: string;
  dependsOn: string[];
  dependencyIds?: string[];
  location: { filePath: string; line: number; column: number };
}

export interface DefinitionUseRecord {
  id: string;
  name: string;
  owner: string;
  ownerId?: string;
  kind: "variable" | "parameter" | "property";
  declaredAt?: { filePath: string; line: number; column: number };
  initializer?: {
    definedBy: string;
    dependsOn: string[];
    dependencyIds?: string[];
  };
  assignments: DefinitionUseAssignment[];
  reads: string[];
  readSites?: Array<{
    text: string;
    filePath: string;
    line: number;
    column: number;
    ownerId?: string;
  }>;
}

export type DefinitionUseGraph = Map<string, DefinitionUseRecord>;

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

export type GraphEvidence = {
  recordId: string;
  recordName: string;
  relation:
  | "initialized_from"
  | "assigned_from"
  | "depends_on"
  | "read_by"
  | "stored_as_property"
  | "passed_as_parameter"
  | "used_by_owner"
  | "shared_dependency"
  | "boundary_flow"
  | "registered_in_container"
  | "registered_in_pipeline"
  | "scheduled_execution"
  | "bounded_flow";
  distance: number;
  filePath?: string;
  line?: number;
  column?: number;
  description: string;
};

export type CallGraphEvidence = {
  callerId: string;
  callerName: string;
  calleeId: string;
  calleeName: string;
  relation:
  | "calls"
  | "called_by"
  | "delegates_to"
  | "orchestrates"
  | "wraps_call"
  | "pipeline_continuation"
  | "factory_invocation"
  | "transactional_call"
  | "registered_callback"
  | "scheduled_callback"
  | "guarded_call"
  | "retry_wrapped_call"
  | "breaker_protected_call"
  | "queue_handler_call"
  | "boundary_entry_call"
  | "bounded_call_path";
  distance: number;
  description: string;
};

export type PatternDetection<K extends PatternKey = PatternKey> = {
  pattern: K;
  detected: boolean;
  confidence: PatternConfidence;
  mode: DetectionMode;
  score: number;
  filePath: string;
  nodeKind: string;
  nodeName: string;
  startLine: number;
  endLine: number;
  evidence: string[];
  matchedRules: string[];
  graphEvidence: GraphEvidence[];
  callGraphEvidence: CallGraphEvidence[];
  intersectingPatterns: PatternKey[];
  intersectionEvidence: string[];
};

export type NodePatternDetections<K extends PatternKey = PatternKey> = {
  nodeName: string;
  filePath: string;
  nodeKind: string;
  startLine: number;
  endLine: number;
  patterns: PatternLabel<K>[];
};

export function classifyDetectionMode(
  confidence: PatternConfidence,
): DetectionMode {
  if (confidence === "high") return "primary";
  if (confidence === "medium") return "secondary";
  return "supporting";
}

export function detectionNodeKey(
  detection: Pick<
    PatternDetection,
    "filePath" | "nodeKind" | "nodeName" | "startLine" | "endLine"
  >,
): string {
  return [
    detection.filePath,
    detection.nodeKind,
    detection.nodeName,
    detection.startLine,
    detection.endLine,
  ].join("::");
}

export function patternsIntersect(
  left: PatternKey,
  right: PatternKey,
): boolean {
  return (
    left === right ||
    commonPatternIntersections[left]?.includes(right) ||
    commonPatternIntersections[right]?.includes(left)
  );
}

export function annotatePatternIntersections<T extends PatternDetection>(
  detections: T[],
): T[] {
  const byNode = new Map<string, T[]>();
  for (const detection of detections) {
    const key = detectionNodeKey(detection);
    const group = byNode.get(key) ?? [];
    group.push(detection);
    byNode.set(key, group);
  }

  return detections.map((detection) => {
    const group = byNode.get(detectionNodeKey(detection)) ?? [];
    const intersectingPatterns = group
      .map((other) => other.pattern)
      .filter(
        (pattern) =>
          pattern !== detection.pattern &&
          patternsIntersect(detection.pattern, pattern),
      );
    const uniqueIntersections = [...new Set(intersectingPatterns)];
    return {
      ...detection,
      intersectingPatterns: uniqueIntersections,
      intersectionEvidence: uniqueIntersections.map(
        (pattern) =>
          `${detection.pattern} intersects with ${pattern} on the same AST node.`,
      ),
    };
  });
}

export function groupDetectionsByNode<K extends PatternKey = PatternKey>(
  detections: PatternDetection<K>[],
): NodePatternDetections<K>[] {
  const byNode = new Map<string, PatternDetection<K>[]>();
  for (const detection of detections) {
    const key = detectionNodeKey(detection);
    const group = byNode.get(key) ?? [];
    group.push(detection);
    byNode.set(key, group);
  }
  return [...byNode.values()].map((group) => {
    const first = group[0];
    return {
      nodeName: first.nodeName,
      filePath: first.filePath,
      nodeKind: first.nodeKind,
      startLine: first.startLine,
      endLine: first.endLine,
      patterns: group
        .slice()
        .sort((a, b) => b.score - a.score || a.pattern.localeCompare(b.pattern))
        .map((detection) => ({
          pattern: detection.pattern,
          mode: detection.mode,
        })),
    };
  });
}

export type PatternDetectorConfig = {
  graphMaxDepth: number;
  graphMaxRecordsPerTraversal: number;
  graphScoreCapPerPattern: number;
  callGraphMaxDepth: number;
  callGraphMaxCallsPerTraversal: number;
  callGraphScoreCapPerPattern: number;
  includeTestFiles: boolean;
  includeDeclarationFiles: boolean;
  confidenceThresholds: { low: number; medium: number; high: number };
};

export const defaultPatternDetectorConfig: PatternDetectorConfig = {
  graphMaxDepth: 2,
  graphMaxRecordsPerTraversal: 50,
  graphScoreCapPerPattern: 5,
  callGraphMaxDepth: 2,
  callGraphMaxCallsPerTraversal: 50,
  callGraphScoreCapPerPattern: 4,
  includeTestFiles: false,
  includeDeclarationFiles: false,
  confidenceThresholds: { low: 1, medium: 4, high: 7 },
};

export type PatternDetectorContext = {
  project: Project;
  checker: TypeChecker;
  definitionUseGraph: DefinitionUseGraph;
  callGraph: CallGraph;
  config?: Partial<PatternDetectorConfig>;
};

export function mergePatternDetectorConfig(
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
    nodes.map((node) => [
      node.id,
      { id: node.id, name: node.name, calls: new Set(node.calls) },
    ]),
  );
}
