"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  findPackageReferences,
  importsAnyPackage,
  searchGitHubPackageImports,
} = require("../dist/tools/github-js-ts-search");

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function hit({
  path: repositoryPath = "src/example.ts",
  repository = "example/project",
  sha = SHA_A,
  gitUrl = `https://api.github.com/repositories/1/git/blobs/${sha}`,
} = {}) {
  return {
    path: repositoryPath,
    sha,
    git_url: gitUrl,
    repository: { full_name: repository },
  };
}

function searchResponse(items = [], options = {}) {
  return new Response(JSON.stringify({
    total_count: options.totalCount ?? items.length,
    incomplete_results: options.incomplete ?? false,
    items,
  }), {
    status: options.status ?? 200,
    headers: options.headers,
  });
}

async function withFetch(mockFetch, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("findPackageReferences recognizes supported static module references", () => {
  const source = `
    import defaultValue from "pkg";
    import { value } from "pkg/subpath";
    import type { Type } from "pkg/types";
    import { type OtherType } from "pkg/other-types";
    import "pkg/register";
    import legacy = require("pkg/legacy");
    const common = require("pkg/common");
  `;

  assert.deepEqual(findPackageReferences(source, ["pkg"], "fixture.ts"), [
    { packageName: "pkg", specifier: "pkg", kind: "import" },
    { packageName: "pkg", specifier: "pkg/subpath", kind: "import" },
    { packageName: "pkg", specifier: "pkg/types", kind: "import-type" },
    { packageName: "pkg", specifier: "pkg/other-types", kind: "import-type" },
    { packageName: "pkg", specifier: "pkg/register", kind: "import" },
    { packageName: "pkg", specifier: "pkg/legacy", kind: "import-equals" },
    { packageName: "pkg", specifier: "pkg/common", kind: "require" },
  ]);
  assert.equal(importsAnyPackage(source, ["pkg"], "fixture.ts"), true);
  assert.equal(importsAnyPackage(source, ["other"], "fixture.ts"), false);
});

test("findPackageReferences ignores textual, dynamic, re-exported, and shadowed references", () => {
  const source = `
    // import value from "pkg";
    /* require("pkg"); */
    const text = 'require("pkg")';
    const template = \`import value from "pkg";\`;
    loader.require("pkg");
    require(packageName);
    require?.("pkg");
    import("pkg");
    export { value } from "pkg";
    function nested(require: (name: string) => unknown) {
      return require("pkg");
    }
  `;

  assert.deepEqual(findPackageReferences(source, ["pkg"], "fixture.ts"), []);
  assert.deepEqual(
    findPackageReferences("const broken = {; // require('pkg')", ["pkg"], "broken.ts"),
    [],
  );
});

test("findPackageReferences validates, trims, deduplicates, and bounds package names", () => {
  assert.deepEqual(
    findPackageReferences('import value from "@scope/pkg/subpath"', [
      " @scope/pkg ",
      "@scope/pkg",
    ]),
    [{
      packageName: "@scope/pkg",
      specifier: "@scope/pkg/subpath",
      kind: "import",
    }],
  );
  assert.throws(() => findPackageReferences("", []), /At least one package/);
  assert.throws(() => findPackageReferences("", ["Pkg"]), /Invalid npm package/);
  assert.throws(() => findPackageReferences("", ['pkg" org:github']), /Invalid npm package/);
});

test("searchGitHubPackageImports validates request and retry options before fetching", async () => {
  await assert.rejects(
    searchGitHubPackageImports({ packages: ["pkg"], token: "" }),
    /access token is required/,
  );
  await assert.rejects(
    searchGitHubPackageImports({ packages: ["pkg"], token: "token", maxAttempts: 6 }),
    /between 1 and 5/,
  );
  await assert.rejects(
    searchGitHubPackageImports({ packages: ["pkg"], token: "token", requestTimeoutMs: 0 }),
    /positive integer/,
  );
});

test("searchGitHubPackageImports follows pagination and writes deterministic SHA snapshots", async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "github-search-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const seenRequests = [];

  await withFetch(async (input, init) => {
    const url = new URL(input);
    seenRequests.push({ url: url.toString(), headers: init.headers });
    if (url.pathname === "/search/code") {
      const query = url.searchParams.get("q");
      const page = url.searchParams.get("page") ?? "1";
      if (!query.endsWith("extension:ts")) return searchResponse();

      if (page === "1") {
        const next = new URL(url);
        next.searchParams.set("page", "2");
        return searchResponse([hit({ sha: SHA_B })], {
          totalCount: 1_001,
          headers: { Link: `<${next}>; rel="next"` },
        });
      }
      return searchResponse([
        hit({ sha: SHA_A }),
        hit({ sha: SHA_B }),
      ], { totalCount: 1_001, incomplete: true });
    }

    if (url.pathname.endsWith(SHA_A)) {
      return new Response('import value from "pkg/subpath";');
    }
    if (url.pathname.endsWith(SHA_B)) {
      return new Response('const value = require("pkg");');
    }
    throw new Error(`Unexpected request: ${url}`);
  }, async () => {
    const report = await searchGitHubPackageImports({
      packages: ["pkg", "pkg"],
      token: "secret-token",
      outputDirectory,
    });

    assert.equal(report.candidateCount, 2);
    assert.equal(report.savedFileCount, 2);
    assert.equal(report.hasIncompleteQueries, true);
    assert.equal(report.queries.length, 8);
    const tsQuery = report.queries.find((query) => query.extension === "ts");
    assert.deepEqual(tsQuery, {
      packageName: "pkg",
      extension: "ts",
      totalCount: 1_001,
      fetchedCount: 3,
      truncated: true,
      incomplete: true,
    });
    assert.deepEqual(report.matches.map((match) => match.sha), [SHA_A, SHA_B]);
    assert.ok(fs.existsSync(path.join(
      outputDirectory,
      "files/example/project",
      SHA_A,
      "src/example.ts",
    )));
    assert.ok(fs.existsSync(path.join(
      outputDirectory,
      "files/example/project",
      SHA_B,
      "src/example.ts",
    )));

    const manifest = JSON.parse(fs.readFileSync(report.manifestPath, "utf8"));
    assert.deepEqual(manifest, report);
    assert.equal(seenRequests[0].headers.Authorization, "Bearer secret-token");
    assert.equal(seenRequests[0].headers["X-GitHub-Api-Version"], "2026-03-10");
  });
});

test("searchGitHubPackageImports caches identical blobs while saving each repository path", async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "github-search-cache-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  let blobRequests = 0;

  await withFetch(async (input) => {
    const url = new URL(input);
    if (url.pathname === "/search/code") {
      const query = url.searchParams.get("q");
      if (!query.endsWith("extension:js")) return searchResponse();
      return searchResponse([
        hit({ repository: "example/one", repositoryPath: "one.js" }),
        hit({ repository: "example/two", repositoryPath: "two.js" }),
      ]);
    }
    blobRequests += 1;
    return new Response('require("pkg");');
  }, async () => {
    const report = await searchGitHubPackageImports({
      packages: ["pkg"],
      token: "token",
      outputDirectory,
    });
    assert.equal(report.savedFileCount, 2);
    assert.equal(blobRequests, 1);
  });
});

test("searchGitHubPackageImports retries transient responses and fails after the configured bound", async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "github-search-retry-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  let attempts = 0;

  await withFetch(async () => {
    attempts += 1;
    if (attempts < 3) {
      return new Response("temporarily unavailable", {
        status: 503,
        headers: { "retry-after": "0.001" },
      });
    }
    return searchResponse();
  }, async () => {
    const report = await searchGitHubPackageImports({
      packages: ["pkg"],
      token: "token",
      outputDirectory,
      maxAttempts: 3,
    });
    assert.equal(attempts, 10);
    assert.equal(report.savedFileCount, 0);
  });

  attempts = 0;
  await withFetch(async () => {
    attempts += 1;
    return new Response("still unavailable", {
      status: 503,
      headers: {
        "retry-after": "0.001",
        "x-github-request-id": "request-123",
      },
    });
  }, async () => {
    await assert.rejects(
      searchGitHubPackageImports({
        packages: ["pkg"],
        token: "token",
        outputDirectory,
        maxAttempts: 2,
      }),
      /after 2 attempts.*request-123.*still unavailable/,
    );
    assert.equal(attempts, 2);
  });
});

test("searchGitHubPackageImports retries network errors and rate-limit responses", async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "github-search-rate-limit-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  let attempts = 0;

  await withFetch(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("connection reset");
    if (attempts === 2) {
      return new Response("secondary rate limit", {
        status: 429,
        headers: { "retry-after": "0.001" },
      });
    }
    return searchResponse();
  }, async () => {
    const report = await searchGitHubPackageImports({
      packages: ["pkg"],
      token: "token",
      outputDirectory,
      maxAttempts: 3,
    });
    assert.equal(attempts, 10);
    assert.equal(report.savedFileCount, 0);
  });
});

test("searchGitHubPackageImports enforces timeout and external abort", async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "github-search-timeout-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));

  await withFetch((_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }), async () => {
    await assert.rejects(
      searchGitHubPackageImports({
        packages: ["pkg"],
        token: "token",
        outputDirectory,
        maxAttempts: 1,
        requestTimeoutMs: 5,
      }),
      /timed out after 5ms/,
    );
  });

  const controller = new AbortController();
  controller.abort(new Error("stop now"));
  await withFetch(async () => {
    throw new Error("fetch should not be called");
  }, async () => {
    await assert.rejects(
      searchGitHubPackageImports({
        packages: ["pkg"],
        token: "token",
        outputDirectory,
        signal: controller.signal,
      }),
      /stop now/,
    );
  });
});

test("searchGitHubPackageImports validates API data before sending credentials or writing a manifest", async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "github-search-safety-"));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  let nonGitHubRequest = false;

  await withFetch(async (input) => {
    const url = new URL(input);
    if (url.origin !== "https://api.github.com") nonGitHubRequest = true;
    return searchResponse([
      hit({ gitUrl: `https://credentials.example/blobs/${SHA_A}` }),
    ]);
  }, async () => {
    await assert.rejects(
      searchGitHubPackageImports({
        packages: ["pkg"],
        token: "token",
        outputDirectory,
        maxAttempts: 1,
      }),
      /Refusing to send GitHub credentials/,
    );
  });

  assert.equal(nonGitHubRequest, false);
  assert.equal(fs.existsSync(path.join(outputDirectory, "manifest.json")), false);

  const manifestPath = path.join(outputDirectory, "manifest.json");
  fs.writeFileSync(manifestPath, "previous successful manifest", "utf8");
  await withFetch(async () => new Response(JSON.stringify({ items: [] })), async () => {
    await assert.rejects(
      searchGitHubPackageImports({
        packages: ["pkg"],
        token: "token",
        outputDirectory,
        maxAttempts: 1,
      }),
      /invalid code search response/,
    );
  });
  assert.equal(fs.readFileSync(manifestPath, "utf8"), "previous successful manifest");
});
