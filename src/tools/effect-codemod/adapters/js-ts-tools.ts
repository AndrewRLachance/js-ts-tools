import { dirname, resolve } from "node:path";
import { applyTextEdits, collectMatches, type CliOptions } from "../../tsquery-cli";
import { extractTypeModel } from "../../type-model";
import { matchAstXPathPattern } from "../../ast-xpath";
import type { AstPatternRequirement, DiscoverySelector } from "../contracts/rule";
import type { ImportRequirement, TextReplacement } from "../contracts/rewrite";
import type {
  AstPatternMatch,
  AstPatternPort,
  DiscoveryPort,
  EditPort,
  ImportPort,
  ProjectRequest,
  OverlaySemanticPort,
} from "../contracts/services";
import type { SemanticSnapshot } from "../contracts/semantics";
import type { SyntaxCandidate } from "../contracts/source";
import { planImportInsertion, type ExistingImport } from "../core/import-planner";
import { TypedTypeModelIndex, type TypeModelCallSiteBridge } from "./type-model-bridge";

export class JsTsToolsDiscoveryPort implements DiscoveryPort {
  discover(request: ProjectRequest, selectors: readonly DiscoverySelector[]): readonly SyntaxCandidate[] {
    const matchesByQuery = new Map<string, ReturnType<typeof collectMatches>>();
    return selectors.flatMap((selector) => {
      const options: CliOptions = {
        selector: selector.tsquery,
        tsconfig: request.tsconfig,
        sources: [...request.sources],
        excludes: [...request.excludes],
        includeDeclarations: false,
        format: "json",
        pretty: false,
        failEmpty: false,
        write: false,
      };
      let matches = matchesByQuery.get(selector.tsquery);
      if (!matches) {
        matches = collectMatches(options, request.cwd);
        matchesByQuery.set(selector.tsquery, matches);
      }
      return matches.map(({ node, record }, index) => {
        const r = record;
        return {
          id: `${selector.id}:${r.filePath}:${r.startOffset}:${index}`,
          selectorId: selector.id,
          filePath: resolve(request.cwd, r.filePath),
          kind: r.kind,
          text: r.text,
          startOffset: r.startOffset,
          endOffset: r.endOffset,
          start: r.start,
          end: r.end,
          nativeNode: node,
        } satisfies SyntaxCandidate;
      });
    });
  }
}

export class JsTsToolsSemanticPort implements OverlaySemanticPort {
  readonly #callSites: TypeModelCallSiteBridge | undefined;

  constructor(callSites?: TypeModelCallSiteBridge) {
    this.#callSites = callSites;
  }

  snapshot(request: ProjectRequest): SemanticSnapshot {
    return this.snapshotWithOverrides(request, new Map());
  }

  snapshotWithOverrides(request: ProjectRequest, overrides: ReadonlyMap<string, string>): SemanticSnapshot {
    const rawTypeModel = extractTypeModel({
      sourceGlob: [...request.sources],
      tsConfigFilePath: request.tsconfig,
      excludePathIncludes: [...request.excludes],
      scope: "all",
      includeCallSites: true,
      includeDeclarationBundles: false,
      sourceTextOverrides: overrides,
      cwd: request.cwd,
    });

    // TypeModel serializes locations relative to the config directory, while
    // TSQuery reports them relative to cwd. Keep filesystem candidates absolute.
    const projectRoot = dirname(resolve(request.cwd, request.tsconfig));
    const model = new TypedTypeModelIndex(rawTypeModel, projectRoot);
    return {
      rawTypeModel,
      diagnostics: rawTypeModel.diagnostics,
      callSites: (this.#callSites?.extract(rawTypeModel) ?? model.allCallSites()).map((callSite) => ({
        ...callSite,
        location: { ...callSite.location, filePath: resolve(projectRoot, callSite.location.filePath) },
      })),
      model,
    };
  }
}

export class JsTsToolsAstPatternPort implements AstPatternPort {
  match(request: ProjectRequest, requirements: readonly AstPatternRequirement[]): readonly AstPatternMatch[] {
    return requirements.flatMap((requirement) => {
      const report = matchAstXPathPattern({
        pattern: requirement.pattern,
        cwd: request.cwd,
        targetTsConfigFilePath: request.tsconfig,
        sourceGlobs: [...request.sources],
        excludePathIncludes: [...request.excludes],
        includeDeclarations: false,
        semanticMode: requirement.semanticMode ?? "strict",
      });

      return report.matches.map((match) => ({
        requirementId: requirement.id,
        filePath: resolve(request.cwd, match.filePath),
        startOffset: match.startOffset,
        endOffset: match.endOffset,
        text: match.text,
      }));
    });
  }
}

export class JsTsToolsEditPort implements EditPort {
  apply(sourceText: string, replacements: readonly TextReplacement[]): string {
    const edits = replacements.map(({ start, end, replacement }) => ({ start, end, replacement }));
    return applyTextEdits(sourceText, edits);
  }
}

/**
 * Uses TSQuery to locate real ImportDeclaration nodes, then delegates rendering
 * to the deterministic core import planner. Existing imports are never mutated.
 */
export class JsTsToolsImportPort implements ImportPort {
  plan(
    request: ProjectRequest,
    filePath: string,
    sourceText: string,
    requirements: readonly ImportRequirement[],
  ): readonly TextReplacement[] {
    if (requirements.length === 0) return [];

    const options: CliOptions = {
      selector: "ImportDeclaration",
      tsconfig: request.tsconfig,
      sources: [filePath],
      excludes: [...request.excludes],
      includeDeclarations: false,
      format: "json",
      pretty: false,
      failEmpty: false,
      write: false,
    };

    const imports: ExistingImport[] = collectMatches(options, request.cwd)
      .map(({ record }) => record)
      .filter((record) => resolve(request.cwd, record.filePath) === resolve(request.cwd, filePath))
      .map((record) => ({
        startOffset: record.startOffset,
        endOffset: record.endOffset,
        text: record.text,
      }));

    return planImportInsertion(filePath, sourceText, requirements, imports);
  }
}
