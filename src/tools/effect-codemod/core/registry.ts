import type { EffectTarget } from "../contracts/effect-target";
import type { EffectConversionRule } from "../contracts/rule";

export class RuleRegistry {
  readonly #rules = new Map<string, EffectConversionRule>();

  constructor(rules: readonly EffectConversionRule[] = []) {
    for (const rule of rules) this.register(rule);
  }

  register(rule: EffectConversionRule): this {
    if (this.#rules.has(rule.id)) throw new Error(`Duplicate rule id: ${rule.id}`);
    this.#rules.set(rule.id, rule);
    return this;
  }

  all(): readonly EffectConversionRule[] {
    return [...this.#rules.values()];
  }

  forTargets(targets?: readonly EffectTarget[]): readonly EffectConversionRule[] {
    if (!targets?.length) return this.all();
    const selected = new Set(targets);
    return this.all().filter((rule) => selected.has(rule.target));
  }
}
