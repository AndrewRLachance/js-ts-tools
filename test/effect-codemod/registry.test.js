const test = require("node:test");
const assert = require("node:assert/strict");
const { RuleRegistry } = require("../../dist/tools/effect-codemod/core/registry");
const { probeMapRule } = require("../../dist/tools/effect-codemod/rules/probe-map");
test("registry filters by target", () => {
    const registry = new RuleRegistry([probeMapRule]);
    assert.equal(registry.forTargets(["map"]).length, 1);
    assert.equal(registry.forTargets(["filter"]).length, 0);
});
test("registry rejects duplicate ids", () => {
    assert.throws(() => new RuleRegistry([probeMapRule, probeMapRule]), /Duplicate rule id/);
});
const { ALL_EFFECT_TARGETS } = require("../../dist/tools/effect-codemod/contracts/effect-target");
const { PRODUCTION_RULES } = require("../../dist/tools/effect-codemod/rules/production");
test("production registry covers every requested Effect target", () => {
    const covered = new Set(PRODUCTION_RULES.map((rule) => rule.target));
    const missing = ALL_EFFECT_TARGETS.filter((target) => !covered.has(target));
    assert.deepEqual(missing, []);
});
