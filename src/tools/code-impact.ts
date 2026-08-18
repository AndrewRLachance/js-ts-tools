import path from "node:path";
import {
  asArray,
  createCodeAnalysisWorkspace,
  resolveAnalysisTargets,
  targetIdsFor,
  traverseCodeAnalysis,
  uniqueLogicalTargets,
} from "./code-analysis";

export type ImpactDirection = "incoming" | "outgoing" | "both";
export type ImpactRelation =
  | "calls"
  | "references"
  | "initializes_from"
  | "assigned_from"
  | "reads";

export interface AnalyzeCodeImpactOptions {
  sourceGlob: string | string[];
  testSourceGlob?: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  symbol?: string;
  filePath?: string;
  direction?: ImpactDirection;
  maxDepth?: number;
  maxNodes?: number;
  cwd?: string;
}

export interface ImpactNode {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath?: string;
  line?: number;
  column?: number;
  external: boolean;
  test: boolean;
}

export interface ImpactPathStep {
  fromId: string;
  toId: string;
  relation: ImpactRelation;
  direction: Exclude<ImpactDirection, "both">;
  evidence?: string;
  location?: {
    filePath: string;
    line: number;
    column: number;
  };
}

export interface ImpactPath {
  direction: Exclude<ImpactDirection, "both">;
  distance: number;
  steps: ImpactPathStep[];
}

export interface ImpactedNode extends ImpactNode {
  distance: number;
  directions: Array<Exclude<ImpactDirection, "both">>;
  relations: ImpactRelation[];
  paths: ImpactPath[];
}

export interface ImpactReport {
  query: {
    sourceGlob: string[];
    testSourceGlob: string[];
    tsConfigFilePath: string;
    excludePathIncludes: string[];
    symbol?: string;
    filePath?: string;
    direction: ImpactDirection;
    maxDepth: number;
    maxNodes: number;
  };
  targets: ImpactNode[];
  impacted: ImpactedNode[];
  impactedTests: ImpactedNode[];
  summary: {
    targetCount: number;
    impactedCount: number;
    impactedTestCount: number;
    externalCount: number;
    truncated: boolean;
  };
}

export function analyzeCodeImpact(
  options: AnalyzeCodeImpactOptions,
): ImpactReport {
  validateOptions(options);
  const direction = options.direction ?? "both";
  const maxDepth = options.maxDepth ?? 3;
  const maxNodes = options.maxNodes ?? 200;
  const workspace = createCodeAnalysisWorkspace(options);
  const targets = resolveAnalysisTargets(workspace, options.symbol, options.filePath);
  const targetIds = targetIdsFor(workspace, targets);
  const { impacted, truncated } = traverseCodeAnalysis(workspace, {
    targetIds,
    direction,
    maxDepth,
    maxNodes,
  });
  const targetNodes = uniqueLogicalTargets(targets);
  const impactedTests = impacted.filter((item) => item.test);
  return {
    query: {
      sourceGlob: workspace.sourceGlobs,
      testSourceGlob: workspace.testGlobs,
      tsConfigFilePath: workspace.tsConfigFilePath,
      excludePathIncludes: workspace.exclusions,
      symbol: options.symbol,
      filePath: options.filePath ? path.resolve(workspace.cwd, options.filePath) : undefined,
      direction,
      maxDepth,
      maxNodes,
    },
    targets: targetNodes,
    impacted,
    impactedTests,
    summary: {
      targetCount: targetNodes.length,
      impactedCount: impacted.length,
      impactedTestCount: impactedTests.length,
      externalCount: impacted.filter((item) => item.external).length,
      truncated,
    },
  };
}

function validateOptions(options: AnalyzeCodeImpactOptions): void {
  if (asArray(options.sourceGlob).length === 0) {
    throw new Error("At least one source glob is required.");
  }
  if (!options.symbol && !options.filePath) {
    throw new Error("Specify --symbol, --file, or both.");
  }
  if (options.direction && !["incoming", "outgoing", "both"].includes(options.direction)) {
    throw new Error(`Invalid impact direction: ${options.direction}`);
  }
  validateBound("maxDepth", options.maxDepth);
  validateBound("maxNodes", options.maxNodes);
}

function validateBound(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
}
