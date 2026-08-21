"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseArgs,
  run,
} = require("../bin/github-js-ts-search-cli");

function outputStream(lines) {
  return { write: (text) => lines.push(text) };
}

function report(outputDirectory, overrides = {}) {
  return {
    schemaVersion: 1,
    githubApiVersion: "2026-03-10",
    completedAt: "2026-08-21T00:00:00.000Z",
    packages: ["pkg"],
    outputDirectory,
    manifestPath: `${outputDirectory}/manifest.json`,
    candidateCount: 1,
    savedFileCount: 1,
    hasIncompleteQueries: false,
    queries: [],
    matches: [{
      repository: "example/project",
      path: "src/example.ts",
      sha: "a".repeat(40),
      outputPath: `files/example/project/${"a".repeat(40)}/src/example.ts`,
      references: [{ packageName: "pkg", specifier: "pkg", kind: "import" }],
    }],
    ...overrides,
  };
}

test("github-js-ts-search parses packages and output options", () => {
  assert.deepEqual(parseArgs(["pkg", "@scope/other", "--out", "corpus"]), {
    packages: ["pkg", "@scope/other"],
    outputDirectory: "corpus",
  });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
  assert.throws(() => parseArgs([]), /At least one package/);
  assert.throws(() => parseArgs(["pkg", "--out"]), /Expected a directory/);
  assert.throws(() => parseArgs(["pkg", "--out", "one", "--out", "two"]), /only be specified once/);
  assert.throws(() => parseArgs(["pkg", "--unknown"]), /Unknown option/);
});

test("github-js-ts-search help does not require authentication", async () => {
  const stdout = [];
  await run(["--help"], {
    env: {},
    stdout: outputStream(stdout),
    stderr: outputStream([]),
    search: async () => {
      throw new Error("search should not run");
    },
  });
  assert.match(stdout.join(""), /Usage:\n  github-js-ts-search/);
});

test("github-js-ts-search requires GITHUB_TOKEN", async () => {
  await assert.rejects(
    run(["pkg"], {
      env: {},
      stdout: outputStream([]),
      stderr: outputStream([]),
    }),
    /Set GITHUB_TOKEN/,
  );
});

test("github-js-ts-search applies output precedence and reports saved paths and limitations", async () => {
  const stdout = [];
  const stderr = [];
  let receivedOptions;
  const search = async (options) => {
    receivedOptions = options;
    return report("/absolute/flag-output", {
      hasIncompleteQueries: true,
      queries: [{
        packageName: "pkg",
        extension: "ts",
        totalCount: 1_001,
        fetchedCount: 1_000,
        truncated: true,
        incomplete: true,
      }],
    });
  };

  await run(["pkg", "--out", "flag-output"], {
    env: { GITHUB_TOKEN: "token", OUT_DIR: "environment-output" },
    stdout: outputStream(stdout),
    stderr: outputStream(stderr),
    search,
  });

  assert.deepEqual(receivedOptions, {
    packages: ["pkg"],
    token: "token",
    outputDirectory: "flag-output",
  });
  assert.match(stdout.join(""), new RegExp(`${"a".repeat(40)}[/\\\\]src[/\\\\]example\\.ts`));
  assert.match(stderr.join(""), /Searching GitHub for pkg/);
  assert.match(stderr.join(""), /truncated.*reported incomplete/);
  assert.match(stderr.join(""), /Saved 1 matching file/);

  await run(["pkg"], {
    env: { GITHUB_TOKEN: "token", OUT_DIR: "environment-output" },
    stdout: outputStream([]),
    stderr: outputStream([]),
    search: async (options) => {
      assert.equal(options.outputDirectory, "environment-output");
      return report("/absolute/environment-output", {
        savedFileCount: 0,
        matches: [],
      });
    },
  });
});
