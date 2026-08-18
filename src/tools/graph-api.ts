import { buildCallGraph, callGraphToJson } from "../graphs/call-graph";
import {
  buildDefinitionUseGraph,
  definitionUseGraphToJson,
} from "../graphs/definition-use-graph";
import {
  buildOwnerReferenceGraph,
  referenceGraphToJson,
} from "../graphs/owner-reference-graph";
import {
  buildStructureTree,
  structureTreeToJson,
} from "../graphs/structure-forest";

export interface TargetOptions {
  includeStructureForest?: boolean;
  includeCallGraph?: boolean;
  includeOwnerReferenceGraph?: boolean;
  includeDefinitionUseGraph?: boolean;
  toJson?: boolean;

  /** @deprecated Use includeStructureForest. */
  structureForestHuh?: boolean;
  /** @deprecated Use includeCallGraph. */
  callGraphHuh?: boolean;
  /** @deprecated Use includeOwnerReferenceGraph. */
  ownerUseGraphHuh?: boolean;
  /** @deprecated Use includeDefinitionUseGraph. */
  definitionUseGraphHuh?: boolean;
}

export interface SourceOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
}

export function buildGraphs(
  sourceOptions: SourceOptions,
  options: TargetOptions,
) {
  const includeStructureForest =
    options.includeStructureForest ?? options.structureForestHuh;
  const includeCallGraph =
    options.includeCallGraph ?? options.callGraphHuh;
  const includeOwnerReferenceGraph =
    options.includeOwnerReferenceGraph ?? options.ownerUseGraphHuh;
  const includeDefinitionUseGraph =
    options.includeDefinitionUseGraph ?? options.definitionUseGraphHuh;

  const structureForest =
    includeStructureForest && buildStructureTree(sourceOptions);

  const callGraph =
    includeCallGraph && buildCallGraph(sourceOptions);

  const ownerReferenceGraph =
    includeOwnerReferenceGraph && buildOwnerReferenceGraph(sourceOptions);

  const definitionUseGraph =
    includeDefinitionUseGraph && buildDefinitionUseGraph(sourceOptions);

  if (options.toJson) {
    return {
      structureForest:
        includeStructureForest &&
        structureForest &&
        structureTreeToJson(structureForest),

      callGraph:
        callGraph &&
        callGraphToJson(callGraph),

      ownerReferenceGraph:
        ownerReferenceGraph &&
        referenceGraphToJson(ownerReferenceGraph),

      definitionUseGraph:
        definitionUseGraph &&
        definitionUseGraphToJson(definitionUseGraph),
    };
  }

  return {
    callGraph,
    ownerReferenceGraph,
    definitionUseGraph,
    structureForest,
  };
}
