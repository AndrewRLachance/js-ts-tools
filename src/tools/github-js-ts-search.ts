import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ts } from "ts-morph";

const API = "https://api.github.com";
const API_ORIGIN = new URL(API).origin;
const API_VERSION = "2026-03-10";
const EXTENSIONS = [
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
] as const;
const PER_PAGE = 100;
const MAX_SEARCH_PAGES = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_LENGTH = 1_000;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const REPOSITORY_FULL_NAME =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const BLOB_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

type SearchHit = {
  path: string;
  sha: string;
  gitUrl: string;
  repository: string;
};

type SearchResponse = {
  totalCount: number;
  incompleteResults: boolean;
  items: SearchHit[];
};

export type PackageReferenceKind =
  | "import"
  | "import-type"
  | "import-equals"
  | "require";

export interface PackageReference {
  packageName: string;
  specifier: string;
  kind: PackageReferenceKind;
}

export interface SearchGitHubPackageImportsOptions {
  packages: readonly string[];
  token: string;
  outputDirectory?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  /** Maximum pages per package/extension query; defaults to 10. */
  maxSearchPages?: number;
  /** Maximum distinct repository/path/blob candidates selected before download. */
  maxCandidates?: number;
}

export interface GitHubPackageImportQueryStatus {
  packageName: string;
  extension: string;
  totalCount: number;
  fetchedCount: number;
  truncated: boolean;
  incomplete: boolean;
}

export interface GitHubPackageImportMatch {
  repository: string;
  path: string;
  sha: string;
  outputPath: string;
  references: PackageReference[];
}

export interface GitHubPackageImportSearchReport {
  schemaVersion: 1;
  githubApiVersion: string;
  completedAt: string;
  packages: string[];
  outputDirectory: string;
  manifestPath: string;
  candidateCount: number;
  selection?: {
    maxSearchPages: number;
    maxCandidates?: number;
    selectedCandidateCount: number;
    omittedCandidateCount: number;
    candidateLimitReached: boolean;
  };
  savedFileCount: number;
  hasIncompleteQueries: boolean;
  queries: GitHubPackageImportQueryStatus[];
  matches: GitHubPackageImportMatch[];
}

type RequestOptions = {
  token: string;
  signal?: AbortSignal;
  maxAttempts: number;
  requestTimeoutMs: number;
  accept?: string;
};

type GitHubResponse = {
  response: Response;
  body: string;
};

function normalizePackages(packages: readonly string[]): string[] {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error("At least one package name is required.");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of packages) {
    if (typeof value !== "string") {
      throw new Error("Package names must be strings.");
    }
    const packageName = value.trim();
    if (
      packageName.length === 0 ||
      packageName.length > 214 ||
      !PACKAGE_NAME.test(packageName)
    ) {
      throw new Error(`Invalid npm package name: ${JSON.stringify(value)}`);
    }
    if (!seen.has(packageName)) {
      seen.add(packageName);
      normalized.push(packageName);
    }
  }

  return normalized;
}

function matchingPackages(
  specifier: string,
  packages: readonly string[],
): string[] {
  return packages.filter(
    (packageName) =>
      specifier === packageName || specifier.startsWith(`${packageName}/`),
  );
}

function scriptKind(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lower.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    lower.endsWith(".js") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (
    clause.name ||
    !clause.namedBindings ||
    !ts.isNamedImports(clause.namedBindings)
  ) {
    return false;
  }
  return (
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function bindSourceFile(sourceFile: ts.SourceFile): ts.TypeChecker {
  const compilerHost: ts.CompilerHost = {
    fileExists: (fileName) => fileName === sourceFile.fileName,
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => "",
    getDefaultLibFileName: () => "lib.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (fileName) =>
      fileName === sourceFile.fileName ? sourceFile : undefined,
    readFile: (fileName) =>
      fileName === sourceFile.fileName ? sourceFile.text : undefined,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };
  return ts
    .createProgram(
      [sourceFile.fileName],
      {
        allowJs: true,
        checkJs: true,
        noLib: true,
        noResolve: true,
        skipLibCheck: true,
      },
      compilerHost,
    )
    .getTypeChecker();
}

export function findPackageReferences(
  source: string,
  packages: readonly string[],
  fileName = "source.ts",
): PackageReference[] {
  const normalizedPackages = normalizePackages(packages);
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const checker = bindSourceFile(sourceFile);
  const references: PackageReference[] = [];
  const seen = new Set<string>();

  const addReference = (
    specifier: string,
    kind: PackageReferenceKind,
  ): void => {
    for (const packageName of matchingPackages(specifier, normalizedPackages)) {
      const key = `${packageName}\0${specifier}\0${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({ packageName, specifier, kind });
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      addReference(
        node.moduleSpecifier.text,
        isTypeOnlyImport(node) ? "import-type" : "import",
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      addReference(node.moduleReference.expression.text, "import-equals");
    } else if (
      ts.isCallExpression(node) &&
      !node.questionDotToken &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      checker.getSymbolAtLocation(node.expression) === undefined &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      addReference(node.arguments[0].text, "require");
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return references;
}

export function importsAnyPackage(
  source: string,
  packages: readonly string[],
  fileName?: string,
): boolean {
  return findPackageReferences(source, packages, fileName).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validateRepositoryPath(path: string): string[] {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    throw new Error(
      `GitHub returned an unsafe repository path: ${JSON.stringify(path)}`,
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `GitHub returned an unsafe repository path: ${JSON.stringify(path)}`,
    );
  }
  return segments;
}

function parseSearchResponse(value: unknown): SearchResponse {
  if (
    !isRecord(value) ||
    typeof value.total_count !== "number" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0 ||
    typeof value.incomplete_results !== "boolean" ||
    !Array.isArray(value.items)
  ) {
    throw new Error("GitHub returned an invalid code search response.");
  }

  const items = value.items.map((item): SearchHit => {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      typeof item.sha !== "string" ||
      typeof item.git_url !== "string" ||
      !isRecord(item.repository) ||
      typeof item.repository.full_name !== "string"
    ) {
      throw new Error("GitHub returned an invalid code search item.");
    }
    if (!REPOSITORY_FULL_NAME.test(item.repository.full_name)) {
      throw new Error(
        `GitHub returned an invalid repository name: ${JSON.stringify(item.repository.full_name)}`,
      );
    }
    validateRepositoryPath(item.path);
    if (!BLOB_SHA.test(item.sha)) {
      throw new Error(
        `GitHub returned an invalid blob SHA: ${JSON.stringify(item.sha)}`,
      );
    }
    assertGitHubUrl(item.git_url);

    return {
      path: item.path,
      sha: item.sha,
      gitUrl: item.git_url,
      repository: item.repository.full_name,
    };
  });

  return {
    totalCount: value.total_count,
    incompleteResults: value.incomplete_results,
    items,
  };
}

function assertGitHubUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GitHub returned an invalid URL: ${JSON.stringify(value)}`);
  }
  if (url.origin !== API_ORIGIN) {
    throw new Error(`Refusing to send GitHub credentials to ${url.origin}.`);
  }
  return url;
}

function headers(token: string, accept: string): Record<string, string> {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "github-js-ts-search",
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("GitHub search was aborted.");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolveSleep, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("GitHub search was aborted."),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    if (!signal) return;
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMilliseconds(response: Response): number | undefined {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(1_000, reset * 1_000 - Date.now() + 1_000);
    }
  }

  return undefined;
}

function boundedBackoff(
  base: number,
  attempt: number,
  maximum: number,
): number {
  return Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
}

function requestError(
  url: string,
  attempt: number,
  response: Response,
  body: string,
): Error {
  const requestId = response.headers.get("x-github-request-id");
  const details = body.slice(0, MAX_ERROR_BODY_LENGTH).trim();
  return new Error(
    [
      `GitHub request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}:`,
      `${response.status} ${response.statusText}`,
      url,
      requestId ? `(request ${requestId})` : "",
      details ? `- ${details}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

async function githubFetch(
  urlValue: string,
  options: RequestOptions,
): Promise<GitHubResponse> {
  const url = assertGitHubUrl(urlValue).toString();
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    throwIfAborted(options.signal);
    const requestController = new AbortController();
    const timeout = setTimeout(
      () =>
        requestController.abort(
          new Error(
            `GitHub request timed out after ${options.requestTimeoutMs}ms.`,
          ),
        ),
      options.requestTimeoutMs,
    );
    const onAbort = (): void => requestController.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) requestController.abort(options.signal.reason);

    try {
      const response = await fetch(url, {
        headers: headers(
          options.token,
          options.accept ?? "application/vnd.github+json",
        ),
        signal: requestController.signal,
      });
      const body = await response.text();
      if (response.ok) return { response, body };

      const canRetry = attempt < options.maxAttempts;
      let retryDelay: number | undefined;

      const headerDelay = retryAfterMilliseconds(response);
      const isSecondaryLimit = /secondary rate limit|abuse detection/i.test(
        body,
      );
      if (
        response.status === 429 ||
        (response.status === 403 &&
          (headerDelay !== undefined || isSecondaryLimit))
      ) {
        retryDelay = headerDelay;
        if (retryDelay === undefined) {
          retryDelay = boundedBackoff(60_000, attempt, 300_000);
        }
      } else if (response.status >= 500 && response.status <= 599) {
        retryDelay = headerDelay ?? boundedBackoff(1_000, attempt, 30_000);
      }

      if (!canRetry || retryDelay === undefined) {
        throw requestError(url, attempt, response, body);
      }
      await sleep(retryDelay, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throwIfAborted(options.signal);
      if (
        error instanceof Error &&
        error.message.startsWith("GitHub request failed")
      ) {
        throw error;
      }
      lastError = error;
      if (attempt >= options.maxAttempts) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `GitHub request failed after ${attempt} attempts: ${url} - ${message}`,
          { cause: error },
        );
      }
      await sleep(boundedBackoff(1_000, attempt, 30_000), options.signal);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  throw new Error(`GitHub request failed: ${url}`, { cause: lastError });
}

function nextLink(response: Response): string | undefined {
  const link = response.headers.get("link");
  if (!link) return undefined;

  for (const part of link.split(",")) {
    const match = part.match(/^\s*<([^>]+)>\s*;.*\brel="next"/);
    if (match) return assertGitHubUrl(match[1]).toString();
  }
  return undefined;
}

function hitKey(hit: SearchHit): string {
  return `${hit.repository}\0${hit.path}\0${hit.sha}`;
}

async function searchQuery(
  packageName: string,
  extension: string,
  requestOptions: RequestOptions,
  maxSearchPages: number,
): Promise<{ status: GitHubPackageImportQueryStatus; hits: SearchHit[] }> {
  const query = `"${packageName}" extension:${extension}`;
  const initialUrl = new URL(`${API}/search/code`);
  initialUrl.searchParams.set("q", query);
  initialUrl.searchParams.set("per_page", String(PER_PAGE));

  const hits = new Map<string, SearchHit>();
  let currentUrl: string | undefined = initialUrl.toString();
  let totalCount = 0;
  let fetchedCount = 0;
  let incomplete = false;
  let page = 0;
  let hasNextPage = false;

  while (currentUrl && page < maxSearchPages) {
    page += 1;
    const githubResponse = await githubFetch(currentUrl, requestOptions);
    let parsed: unknown;
    try {
      parsed = JSON.parse(githubResponse.body);
    } catch (error) {
      throw new Error(
        "GitHub returned invalid JSON for a code search response.",
        {
          cause: error,
        },
      );
    }
    const result = parseSearchResponse(parsed);
    totalCount = Math.max(totalCount, result.totalCount);
    fetchedCount += result.items.length;
    incomplete ||= result.incompleteResults;
    for (const hit of result.items) hits.set(hitKey(hit), hit);
    currentUrl = nextLink(githubResponse.response);
    hasNextPage = currentUrl !== undefined;
  }

  return {
    status: {
      packageName,
      extension,
      totalCount,
      fetchedCount,
      truncated: totalCount > PER_PAGE * maxSearchPages || hasNextPage,
      incomplete,
    },
    hits: [...hits.values()],
  };
}

function compareHits(left: SearchHit, right: SearchHit): number {
  return (
    left.repository.localeCompare(right.repository) ||
    left.path.localeCompare(right.path) ||
    left.sha.localeCompare(right.sha)
  );
}

function safeOutputPath(
  outputDirectory: string,
  hit: SearchHit,
): { absolute: string; relative: string } {
  const repositoryParts = hit.repository.split("/");
  const pathParts = validateRepositoryPath(hit.path);
  const filesRoot = resolve(outputDirectory, "files");
  const absolute = resolve(
    filesRoot,
    ...repositoryParts,
    hit.sha,
    ...pathParts,
  );
  const relativeToRoot = relative(filesRoot, absolute);
  if (
    relativeToRoot === "" ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${sep}`) ||
    isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Refusing to write outside ${filesRoot}: ${hit.path}`);
  }
  return {
    absolute,
    relative: ["files", ...repositoryParts, hit.sha, ...pathParts].join("/"),
  };
}

async function writeFileAtomically(
  path: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${path.slice(path.lastIndexOf(sep) + 1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum?: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved <= 0 ||
    (maximum !== undefined && resolved > maximum)
  ) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive integer.`
        : `${name} must be an integer between 1 and ${maximum}.`,
    );
  }
  return resolved;
}

export async function searchGitHubPackageImports(
  options: SearchGitHubPackageImportsOptions,
): Promise<GitHubPackageImportSearchReport> {
  const packages = normalizePackages(options.packages);
  const token = options.token?.trim();
  if (!token) throw new Error("A GitHub access token is required.");
  if (
    options.outputDirectory !== undefined &&
    options.outputDirectory.trim() === ""
  ) {
    throw new Error("outputDirectory must not be empty.");
  }

  const maxSearchPages = positiveInteger(
    options.maxSearchPages,
    MAX_SEARCH_PAGES,
    "maxSearchPages",
    MAX_SEARCH_PAGES,
  );
  const maxCandidates =
    options.maxCandidates === undefined
      ? undefined
      : positiveInteger(
          options.maxCandidates,
          1,
          "maxCandidates",
          Number.MAX_SAFE_INTEGER,
        );
  const outputDirectory = resolve(options.outputDirectory ?? "downloads");
  const requestOptions: RequestOptions = {
    token,
    signal: options.signal,
    maxAttempts: positiveInteger(
      options.maxAttempts,
      DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
      DEFAULT_MAX_ATTEMPTS,
    ),
    requestTimeoutMs: positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    ),
  };
  const candidates = new Map<string, SearchHit>();
  const queries: GitHubPackageImportQueryStatus[] = [];
  const queues: { key: string; hits: SearchHit[]; index: number }[] = [];

  for (const packageName of packages) {
    for (const extension of EXTENSIONS) {
      const result = await searchQuery(
        packageName,
        extension,
        requestOptions,
        maxSearchPages,
      );
      queries.push(result.status);
      queues.push({
        key: `${packageName}\0${extension}`,
        hits: result.hits.sort(compareHits),
        index: 0,
      });
      for (const hit of result.hits) candidates.set(hitKey(hit), hit);
    }
  }

  let selected = [...candidates.values()];
  if (maxCandidates !== undefined) {
    const chosen = new Map<string, SearchHit>();
    queues.sort((a, b) => a.key.localeCompare(b.key));
    let progress = true;
    while (chosen.size < maxCandidates && progress) {
      progress = false;
      for (const queue of queues) {
        while (
          queue.index < queue.hits.length &&
          chosen.has(hitKey(queue.hits[queue.index]))
        )
          queue.index++;
        if (queue.index < queue.hits.length) {
          const hit = queue.hits[queue.index++];
          chosen.set(hitKey(hit), hit);
          progress = true;
          if (chosen.size === maxCandidates) break;
        }
      }
    }
    selected = [...chosen.values()];
  }
  const omittedCandidateCount = candidates.size - selected.length;
  const selection =
    options.maxCandidates === undefined && options.maxSearchPages === undefined
      ? undefined
      : {
          maxSearchPages,
          ...(maxCandidates === undefined ? {} : { maxCandidates }),
          selectedCandidateCount: selected.length,
          omittedCandidateCount,
          candidateLimitReached: omittedCandidateCount > 0,
        };

  const sourceBySha = new Map<string, string>();
  const matches: GitHubPackageImportMatch[] = [];

  for (const hit of selected.sort(compareHits)) {
    throwIfAborted(options.signal);
    let source = sourceBySha.get(hit.sha);
    if (source === undefined) {
      const response = await githubFetch(hit.gitUrl, {
        ...requestOptions,
        accept: "application/vnd.github.raw+json",
      });
      source = response.body;
      sourceBySha.set(hit.sha, source);
    }

    const references = findPackageReferences(source, packages, hit.path);
    if (references.length === 0) continue;

    const output = safeOutputPath(outputDirectory, hit);
    await writeFileAtomically(output.absolute, source);
    matches.push({
      repository: hit.repository,
      path: hit.path,
      sha: hit.sha,
      outputPath: output.relative,
      references,
    });
  }

  const manifestPath = resolve(outputDirectory, "manifest.json");
  const report: GitHubPackageImportSearchReport = {
    schemaVersion: 1,
    githubApiVersion: API_VERSION,
    completedAt: new Date().toISOString(),
    packages,
    outputDirectory,
    manifestPath,
    candidateCount: candidates.size,
    ...(selection ? { selection } : {}),
    savedFileCount: matches.length,
    hasIncompleteQueries:
      omittedCandidateCount > 0 ||
      queries.some((query) => query.incomplete || query.truncated),
    queries,
    matches,
  };

  await writeFileAtomically(
    manifestPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  return report;
}
