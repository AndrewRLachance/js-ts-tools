"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildGraphs } = require("../dist/tools/graph-api");

const sourceOptions = {
  sourceGlob: "missing-source/**/*.ts",
};

test("buildGraphs accepts the canonical graph-selection options", () => {
  const result = buildGraphs(sourceOptions, {
    includeOwnerReferenceGraph: true,
    toJson: true,
  });

  assert.deepEqual(result.ownerReferenceGraph, []);
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(result))),
    ["ownerReferenceGraph"],
  );
});

test("buildGraphs retains legacy graph-selection options", () => {
  const result = buildGraphs(sourceOptions, {
    ownerUseGraphHuh: true,
    toJson: true,
  });

  assert.deepEqual(result.ownerReferenceGraph, []);
});
