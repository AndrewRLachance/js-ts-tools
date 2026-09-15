import type { EffectConversionRule } from "../contracts/rule";

/**
 * A non-converting probe. It proves discovery and reporting without asserting that
 * arbitrary `.map(...)` calls are semantically equivalent to Effect.map.
 */
export const probeMapRule: EffectConversionRule = {
  id: "probe.map-call",
  target: "map",
  description: "Discover .map(...) calls; do not convert until semantic rules exist.",
  selectors: [
    {
      id: "probe.map-call.call",
      tsquery: 'CallExpression[expression.expression.text="Effect"][expression.name.text="map"]',
    },
  ],
  analyze(candidate, context) {
    return {
      kind: "skip",
      reason: "Probe only: receiver/callback Effect semantics have not been proven.",
      evidence: context.semantics.factsFor(candidate.id),
    };
  },
  rewrite() {
    return { replacements: [], imports: [] };
  },
};
