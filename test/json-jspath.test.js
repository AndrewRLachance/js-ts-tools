"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  streamJSPathFromFile,
} = require("../dist/tools/json-jspath");

test("json-jspath streams matches from a top-level JSON array", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "json-jspath-"));
  const filePath = path.join(directory, "records.json");
  fs.writeFileSync(filePath, JSON.stringify([
    { drs: "first", nested: { drs: "nested" } },
    { drs: "second" },
  ]));

  const matches = [];
  for await (const match of streamJSPathFromFile(filePath, "..drs")) {
    matches.push(match);
  }

  assert.deepEqual(matches, ["first", "nested", "second"]);
});
