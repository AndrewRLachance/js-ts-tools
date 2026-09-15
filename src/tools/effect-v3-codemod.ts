import { EffectCodemod } from "./effect-codemod/core/pipeline";
import { RuleRegistry } from "./effect-codemod/core/registry";
import {
  JsTsToolsAstPatternPort,
  JsTsToolsDiscoveryPort,
  JsTsToolsEditPort,
  JsTsToolsImportPort,
  JsTsToolsSemanticPort,
} from "./effect-codemod/adapters/js-ts-tools";
import { NodeSourcePort } from "./effect-codemod/adapters/node-source";
import { InMemoryValidationPort } from "./effect-codemod/core/in-memory-validation";
import { PRODUCTION_RULES } from "./effect-codemod/rules/production";
import { ALL_EFFECT_TARGETS } from "./effect-codemod/contracts/effect-target";
import type { CodemodOptions } from "./effect-codemod/contracts/config";
import type { CodemodReport } from "./effect-codemod/contracts/report";
import { TypeScriptAnalysisSession } from "./effect-codemod/adapters/analysis-session";

export type { CodemodOptions as EffectCodemodOptions } from "./effect-codemod/contracts/config";
export type { CodemodReport as EffectCodemodReport } from "./effect-codemod/contracts/report";

/** Run production rules with the repository's real discovery and semantic adapters. */
export function runEffectCodemod(options: CodemodOptions = {}): CodemodReport {
  for (const target of options.targets ?? []) {
    if (!ALL_EFFECT_TARGETS.includes(target)) throw new Error(`Unknown Effect target: ${target}`);
  }
  if (options.sources?.length === 0) throw new Error("At least one source glob is required.");
  if (options.evidence !== undefined && options.evidence !== "compact" && options.evidence !== "full") {
    throw new Error("evidence must be compact or full");
  }
  const source = new NodeSourcePort();
  const semantics = new JsTsToolsSemanticPort();
  return new EffectCodemod(new RuleRegistry(PRODUCTION_RULES), {
    analysisSession: (request) => new TypeScriptAnalysisSession(request, source),
    discovery: new JsTsToolsDiscoveryPort(),
    semantics,
    astPatterns: new JsTsToolsAstPatternPort(),
    source,
    edits: new JsTsToolsEditPort(),
    imports: new JsTsToolsImportPort(),
    validation: new InMemoryValidationPort(source, semantics),
  }).run({ ...options, maxPasses: options.maxPasses ?? 3 });
}
