import { GENERATOR_RULES } from "./generators";
import type { EffectConversionRule } from "../contracts/rule";
import { FIRST_EFFECT_RULES } from "./effect-compositions";
import { RULE_EXPANSION_RULES } from "./rule-expansion";
import { PREDICATE_FILTER_EXPANSION_RULES } from "./predicate-filter-expansion";
import { COLLECTION_FOLDING_EXPANSION_RULES } from "./collection-folding-expansion";
import { COLLECTING_EXPANSION_RULES } from "./collecting-expansion";
import { CONDITIONAL_EXPANSION_RULES } from "./conditional-expansion";
import { EFFECTFUL_FILTER_MAPPING_EXPANSION_RULES } from "./effectful-filter-mapping-expansion";
import { REMAINING_EXPANSION_RULES } from "./remaining-expansion";
import { orElseFailFromMapErrorRule } from "./error-replacement";

/** Complete production rule set for every requested Effect v3 target. */
const rules: readonly EffectConversionRule[] = [
  ...FIRST_EFFECT_RULES,
  ...RULE_EXPANSION_RULES,
  ...PREDICATE_FILTER_EXPANSION_RULES,
  ...COLLECTION_FOLDING_EXPANSION_RULES,
  ...COLLECTING_EXPANSION_RULES,
  ...CONDITIONAL_EXPANSION_RULES,
  ...EFFECTFUL_FILTER_MAPPING_EXPANSION_RULES,
  ...REMAINING_EXPANSION_RULES,
  orElseFailFromMapErrorRule,
  ...GENERATOR_RULES,
];

/** Structural prefilters only; every selected candidate still needs semantic proof. */
export const PRODUCTION_RULES: readonly EffectConversionRule[] = rules.map((rule) => {
  const sourceCalls = new Set(["allSuccesses", "exists", "every", "filterMap", "filter", "reduceWhile", "takeWhile", "dropWhile", "takeUntil", "dropUntil", "whenRef", "whenFiberRef", "liftPredicate"]);
  const conditional = new Set(["filterOrFail", "filterOrDie", "filterOrDieMessage", "filterOrElse", "whenEffect", "unlessEffect"]);
  const calls = new Set(["map", "mapError", "asSome", "asSomeError", "mapErrorCause", "head", "filterEffectOrElse", "filterEffectOrFail"]);
  return { ...rule, selectors: rule.selectors.map((selector) => {
    if (rule.id.includes("from-generator-guard")) return { ...selector, generatorShape: "guard" as const };
    if (rule.id.includes("from-generator-yield-return")) return { ...selector, generatorShape: "yield-return" as const };
    if (rule.id.includes("from-generator-dense-loop")) return { ...selector, generatorShape: "dense-loop" as const };
    return { ...selector,
      ...(sourceCalls.has(rule.target) ? { requiresSource: true, requiresSourceCall: true } : {}),
      ...(["whenEffect", "unlessEffect"].includes(rule.target) ? { requiresSource: true } : {}),
      ...(conditional.has(rule.target) ? { callbackShape: "conditional" as const, callbackParameters: 1 } : {}),
      ...(calls.has(rule.target) ? { callbackShape: "call" as const } : {}),
      ...(["asSome", "asSomeError", "mapErrorCause"].includes(rule.target) ? { callbackParameters: 1 } : {}),
      ...(rule.target === "as" ? { callbackShape: "literal" as const } : {}),
      ...(rule.target === "asVoid" ? { callbackShape: "void" as const } : {}),
      ...(rule.target === "negate" ? { callbackShape: "not" as const } : {}),
    };
  }) };
});
