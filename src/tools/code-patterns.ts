import { Project } from "ts-morph";
import { buildCallGraph } from "../graphs/call-graph";
import { buildDefinitionUseGraph } from "../graphs/definition-use-graph";
import {
  commonPatternIntersections,
  type PatternConfidence,
  type PatternDetection,
  type PatternDetectorConfig,
  type PatternKey,
} from "../patterns/pattern-core";
import { detectPatterns } from "../patterns/pattern-detector";

export interface DetectPatternsFromSourcesOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  patterns?: PatternKey[];
  minConfidence?: PatternConfidence;
  config?: Partial<PatternDetectorConfig>;
}

export const patternKeys = Object.freeze(
  Object.keys(commonPatternIntersections) as PatternKey[],
);

const CONFIDENCE_RANK: Record<PatternConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function detectPatternsFromSources(
  options: DetectPatternsFromSourcesOptions,
): PatternDetection[] {
  const tsConfigFilePath = options.tsConfigFilePath ?? "tsconfig.json";
  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
  });

  const excludePathIncludes = options.excludePathIncludes ?? [];
  const selectedSourceFiles = project
    .addSourceFilesAtPaths(options.sourceGlob)
    .filter((sourceFile) =>
      !excludePathIncludes.some((fragment) =>
        sourceFile.getFilePath().includes(fragment),
      ),
    );

  if (selectedSourceFiles.length === 0) {
    throw new Error("No source files matched the requested source globs.");
  }

  const selectedPaths = new Set(
    selectedSourceFiles.map((sourceFile) => sourceFile.getFilePath()),
  );
  for (const sourceFile of project.getSourceFiles()) {
    if (!selectedPaths.has(sourceFile.getFilePath())) {
      project.removeSourceFile(sourceFile);
    }
  }

  const graphOptions = {
    sourceGlob: options.sourceGlob,
    tsConfigFilePath,
    excludePathIncludes,
  };
  const callGraph = buildCallGraph(graphOptions);
  const definitionUseGraph = buildDefinitionUseGraph(graphOptions);
  const detections = detectPatterns({
    project,
    checker: project.getTypeChecker(),
    callGraph,
    definitionUseGraph,
    config: options.config,
  });

  const requestedPatterns = options.patterns
    ? new Set(options.patterns)
    : undefined;
  const minimumRank = CONFIDENCE_RANK[options.minConfidence ?? "low"];

  return detections.filter(
    (detection) =>
      (!requestedPatterns || requestedPatterns.has(detection.pattern)) &&
      CONFIDENCE_RANK[detection.confidence] >= minimumRank,
  );
}
