import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type WriteMode = "skip" | "overwrite" | "error";

export interface ProjectCatalog {
  typescriptProjectStructures: ArchitectureDefinition[];
}

export interface ArchitectureDefinition {
  id: number;
  name: string;
  commonLibraries: string[];
  ruleOfThumb: string;
  structure: ArchitectureStructure;
}

export interface ArchitectureStructure {
  repositoryPattern?: string;
  exampleRepositories?: string[];
  serviceTemplate?: ProjectSkeleton;
  rootFiles?: string[];
  directories?: string[];
}

export interface ProjectSkeleton {
  rootFiles?: string[];
  directories?: string[];
}

export interface GenerateProjectOptions {
  /** Display/project folder name. */
  projectName: string;
  /** Destination folder that will contain the generated project folder. Defaults to process.cwd(). */
  targetDir?: string;
  /** Defaults to pnpm. */
  packageManager?: PackageManager;
  /** Defaults to skip, so existing files are not overwritten. */
  writeMode?: WriteMode;
  /** When true, returns planned files/directories without writing to disk. */
  dryRun?: boolean;
  /** Replaces wildcard entries such as service path placeholders. */
  serviceNames?: string[];
  /** Adds .gitkeep to empty scaffold directories. Defaults to true. */
  includeGitkeep?: boolean;
}

export interface GenerateProjectResult {
  architectureId: number;
  architectureName: string;
  rootDir: string;
  createdDirectories: string[];
  createdFiles: string[];
  skippedFiles: string[];
}

export async function loadProjectCatalog(catalogPath: string): Promise<ProjectCatalog> {
  const raw = await readFile(catalogPath, "utf8");
  const parsed = JSON.parse(raw) as ProjectCatalog;

  if (!Array.isArray(parsed.typescriptProjectStructures)) {
    throw new Error("Invalid catalog: expected typescriptProjectStructures array.");
  }

  return parsed;
}

export function findArchitecture(
  catalog: ProjectCatalog,
  selector: number | string,
): ArchitectureDefinition {
  const normalizedSelector = String(selector).trim().toLowerCase();

  const architecture = catalog.typescriptProjectStructures.find((item) => {
    return (
      String(item.id) === normalizedSelector ||
      item.name.toLowerCase() === normalizedSelector ||
      slugify(item.name) === normalizedSelector
    );
  });

  if (!architecture) {
    throw new Error(`Architecture not found: ${selector}`);
  }

  return architecture;
}

export async function generateProjectFromCatalog(
  catalog: ProjectCatalog,
  selector: number | string,
  options: GenerateProjectOptions,
): Promise<GenerateProjectResult> {
  const architecture = findArchitecture(catalog, selector);
  return generateProjectForArchitecture(architecture, options);
}

export async function generateAllProjects(
  catalog: ProjectCatalog,
  options: Omit<GenerateProjectOptions, "projectName"> & { projectNamePrefix?: string } = {},
): Promise<GenerateProjectResult[]> {
  const prefix = options.projectNamePrefix ?? "typescript";

  const results: GenerateProjectResult[] = [];
  for (const architecture of catalog.typescriptProjectStructures) {
    results.push(
      await generateProjectForArchitecture(architecture, {
        ...options,
        projectName: `${prefix}-${architecture.id}-${slugify(architecture.name)}`,
      }),
    );
  }

  return results;
}

export async function generateProjectForArchitecture(
  architecture: ArchitectureDefinition,
  options: GenerateProjectOptions,
): Promise<GenerateProjectResult> {
  if (!options.projectName?.trim()) {
    throw new Error("projectName is required.");
  }

  const packageManager = options.packageManager ?? "pnpm";
  const writeMode = options.writeMode ?? "skip";
  const includeGitkeep = options.includeGitkeep ?? true;
  const rootDir = resolve(options.targetDir ?? process.cwd(), slugify(options.projectName));

  const result: GenerateProjectResult = {
    architectureId: architecture.id,
    architectureName: architecture.name,
    rootDir,
    createdDirectories: [],
    createdFiles: [],
    skippedFiles: [],
  };

  if (isPolyrepo(architecture)) {
    const repositories = architecture.structure.exampleRepositories?.length
      ? architecture.structure.exampleRepositories
      : ["api-service"];

    for (const repositoryName of repositories) {
      const repositoryRoot = join(rootDir, repositoryName);
      await writeSkeleton({
        architecture,
        skeleton: architecture.structure.serviceTemplate ?? {},
        rootDir: repositoryRoot,
        projectName: repositoryName,
        packageManager,
        writeMode,
        dryRun: options.dryRun ?? false,
        includeGitkeep,
        serviceNames: options.serviceNames,
        result,
      });
    }

    return result;
  }

  await writeSkeleton({
    architecture,
    skeleton: architecture.structure,
    rootDir,
    projectName: options.projectName,
    packageManager,
    writeMode,
    dryRun: options.dryRun ?? false,
    includeGitkeep,
    serviceNames: options.serviceNames,
    result,
  });

  return result;
}

interface WriteSkeletonOptions {
  architecture: ArchitectureDefinition;
  skeleton: ProjectSkeleton;
  rootDir: string;
  projectName: string;
  packageManager: PackageManager;
  writeMode: WriteMode;
  dryRun: boolean;
  includeGitkeep: boolean;
  serviceNames?: string[];
  result: GenerateProjectResult;
}

async function writeSkeleton(options: WriteSkeletonOptions): Promise<void> {
  const rootFiles = options.skeleton.rootFiles ?? [];
  const entries = expandWildcardEntries(
    options.skeleton.directories ?? [],
    options.serviceNames ?? defaultServiceNames(options.architecture),
  );

  const directories = new Set<string>();
  const files = new Set<string>();

  for (const rootFile of rootFiles) {
    files.add(normalizeRelativePath(rootFile));
  }

  for (const entry of entries) {
    const normalized = normalizeRelativePath(entry);

    if (looksLikeFile(normalized)) {
      files.add(normalized);
      directories.add(dirname(normalized));
    } else {
      directories.add(normalized);
    }
  }

  directories.add(".");

  for (const directory of [...directories].sort()) {
    const absoluteDirectory = join(options.rootDir, directory);
    await createDirectory(absoluteDirectory, options.dryRun, options.result);

    if (options.includeGitkeep && directory !== ".") {
      const hasDirectFile = [...files].some((file) => dirname(file) === directory);
      if (!hasDirectFile) {
        await writeScaffoldFile({
          absolutePath: join(absoluteDirectory, ".gitkeep"),
          relativePath: relative(options.result.rootDir, join(absoluteDirectory, ".gitkeep")),
          content: "",
          writeMode: options.writeMode,
          dryRun: options.dryRun,
          result: options.result,
        });
      }
    }
  }

  for (const file of [...files].sort()) {
    const absolutePath = join(options.rootDir, file);
    const content = contentForFile(file, {
      architecture: options.architecture,
      projectName: options.projectName,
      packageManager: options.packageManager,
    });

    await writeScaffoldFile({
      absolutePath,
      relativePath: relative(options.result.rootDir, absolutePath),
      content,
      writeMode: options.writeMode,
      dryRun: options.dryRun,
      result: options.result,
    });
  }
}

interface ContentContext {
  architecture: ArchitectureDefinition;
  projectName: string;
  packageManager: PackageManager;
}

function contentForFile(filePath: string, context: ContentContext): string {
  const fileName = filePath.split("/").at(-1) ?? filePath;

  switch (fileName) {
    case "package.json":
      return JSON.stringify(packageJsonFor(context), null, 2) + "\n";
    case "tsconfig.json":
    case "tsconfig.base.json":
      return JSON.stringify(tsconfigFor(fileName), null, 2) + "\n";
    case "pnpm-workspace.yaml":
      return [
        "packages:",
        "  - apps/*",
        "  - services/*",
        "  - packages/*",
        "  - tooling/*",
        "",
      ].join("\n");
    case "turbo.json":
      return JSON.stringify(turboConfig(), null, 2) + "\n";
    case "nx.json":
      return JSON.stringify(nxConfig(), null, 2) + "\n";
    case "vitest.config.ts":
      return [
        "import { defineConfig } from 'vitest/config';",
        "",
        "export default defineConfig({",
        "  test: {",
        "    globals: true,",
        "    environment: 'node',",
        "    include: ['**/*.{test,spec}.ts'],",
        "  },",
        "});",
        "",
      ].join("\n");
    case "vite.config.ts":
      return [
        "import { defineConfig } from 'vite';",
        "",
        "export default defineConfig({",
        "  build: {",
        "    sourcemap: true,",
        "  },",
        "});",
        "",
      ].join("\n");
    case "tsup.config.ts":
      return [
        "import { defineConfig } from 'tsup';",
        "",
        "export default defineConfig({",
        "  entry: ['src/index.ts'],",
        "  format: ['esm'],",
        "  dts: true,",
        "  sourcemap: true,",
        "  clean: true,",
        "});",
        "",
      ].join("\n");
    case "Dockerfile":
      return dockerfileFor(context);
    case "docker-compose.yml":
      return dockerComposeFor(context);
    case ".env.example":
      return [
        "NODE_ENV=development",
        "PORT=3000",
        "DATABASE_URL=postgres://postgres:postgres@localhost:5432/app",
        "REDIS_URL=redis://localhost:6379",
        "",
      ].join("\n");
    case "README.md":
      return readmeFor(context);
    case "openapi.yaml":
      return openApiYaml(context);
    case "asyncapi.yaml":
      return asyncApiYaml(context);
    case "buf.yaml":
      return ["version: v2", "modules:", "  - path: contracts/proto", ""].join("\n");
    case "codegen.ts":
      return [
        "// Add OpenAPI, GraphQL, AsyncAPI, or protobuf code generation here.",
        "export default {};",
        "",
      ].join("\n");
    case "api-extractor.json":
      return JSON.stringify(apiExtractorConfig(), null, 2) + "\n";
    case "playwright.config.ts":
      return [
        "import { defineConfig } from '@playwright/test';",
        "",
        "export default defineConfig({",
        "  testDir: './tests/e2e',",
        "});",
        "",
      ].join("\n");
    case "storybook.config.ts":
      return [
        "// Storybook config placeholder. Move to .storybook/main.ts if using standard Storybook layout.",
        "export default {};",
        "",
      ].join("\n");
    case "tailwind.config.ts":
      return [
        "import type { Config } from 'tailwindcss';",
        "",
        "export default {",
        "  content: ['./src/**/*.{ts,tsx,vue,svelte,html}'],",
        "  theme: { extend: {} },",
        "  plugins: [],",
        "} satisfies Config;",
        "",
      ].join("\n");
    default:
      return defaultFileContent(filePath, context);
  }
}

function defaultFileContent(filePath: string, context: ContentContext): string {
  const fileName = filePath.split("/").at(-1) ?? filePath;

  if (fileName.endsWith(".ts") || fileName.endsWith(".tsx")) {
    if (fileName === "main.ts" || fileName === "index.ts") {
      return [
        `/** Entry point for ${context.architecture.name}. */`,
        "export async function main(): Promise<void> {",
        `  console.log('${context.projectName}');`,
        "}",
        "",
        "if (import.meta.url === `file://${process.argv[1]}`) {",
        "  void main();",
        "}",
        "",
      ].join("\n");
    }

    if (fileName.endsWith("test.ts") || fileName.endsWith(".spec.ts")) {
      return [
        "import { describe, expect, it } from 'vitest';",
        "",
        `describe('${withoutExtension(fileName)}', () => {`,
        "  it('has a scaffolded test placeholder', () => {",
        "    expect(true).toBe(true);",
        "  });",
        "});",
        "",
      ].join("\n");
    }

    return [
      `/** Scaffold placeholder for ${filePath}. */`,
      "export {};",
      "",
    ].join("\n");
  }

  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) {
    return "# Scaffold placeholder\n";
  }

  if (fileName.endsWith(".md")) {
    return `# ${titleCase(withoutExtension(fileName))}\n\nScaffold placeholder.\n`;
  }

  return "";
}

function packageJsonFor(context: ContentContext): Record<string, unknown> {
  const isLibrary = context.architecture.name.toLowerCase().includes("library");
  const isCli = context.architecture.name.toLowerCase().includes("cli");
  const isWorkspace = [
    "monorepo",
    "service-oriented monorepo",
    "full-stack app structure",
    "api gateway + backend services",
    "event-driven microservices",
  ].includes(context.architecture.name.toLowerCase());

  const scripts: Record<string, string> = {
    build: "tsc -p tsconfig.json",
    dev: "tsx src/index.ts",
    test: "vitest run",
    "test:watch": "vitest",
    lint: "tsc --noEmit",
  };

  if (isWorkspace) {
    scripts.build = "turbo run build";
    scripts.test = "turbo run test";
    scripts.lint = "turbo run lint";
  }

  const packageJson: Record<string, unknown> = {
    name: slugify(context.projectName),
    version: "0.1.0",
    private: !isLibrary,
    type: "module",
    scripts,
    dependencies: {},
    devDependencies: {
      "@types/node": "latest",
      tsx: "latest",
      typescript: "latest",
      vitest: "latest",
    },
  };

  if (isCli) {
    packageJson.bin = {
      [slugify(context.projectName)]: "./bin/cli.js",
    };
  }

  if (isLibrary) {
    packageJson.main = "./dist/index.js";
    packageJson.types = "./dist/index.d.ts";
    packageJson.exports = {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    };
  }

  return packageJson;
}

function tsconfigFor(fileName: string): Record<string, unknown> {
  const base = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      outDir: "dist",
    },
  };

  if (fileName === "tsconfig.base.json") {
    return base;
  }

  return {
    ...base,
    include: ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"],
  };
}

function turboConfig(): Record<string, unknown> {
  return {
    tasks: {
      build: {
        dependsOn: ["^build"],
        outputs: ["dist/**", ".next/**", "!.next/cache/**"],
      },
      test: {
        dependsOn: ["^build"],
      },
      lint: {},
      dev: {
        cache: false,
        persistent: true,
      },
    },
  };
}

function nxConfig(): Record<string, unknown> {
  return {
    $schema: "./node_modules/nx/schemas/nx-schema.json",
    affected: {
      defaultBase: "main",
    },
    targetDefaults: {
      build: {
        dependsOn: ["^build"],
      },
      test: {
        dependsOn: ["^build"],
      },
    },
  };
}

function apiExtractorConfig(): Record<string, unknown> {
  return {
    $schema: "https://developer.microsoft.com/json-schemas/api-extractor/v7/api-extractor.schema.json",
    mainEntryPointFilePath: "./dist/index.d.ts",
    apiReport: { enabled: true, reportFolder: "./etc" },
    docModel: { enabled: true },
    dtsRollup: { enabled: true, untrimmedFilePath: "./dist/index.d.ts" },
  };
}

function dockerfileFor(context: ContentContext): string {
  const installCommand =
    context.packageManager === "pnpm"
      ? "corepack enable && pnpm install --frozen-lockfile"
      : `${context.packageManager} install`;

  return [
    "FROM node:22-alpine AS base",
    "WORKDIR /app",
    "COPY package*.json pnpm-lock.yaml* yarn.lock* bun.lockb* ./",
    `RUN ${installCommand}`,
    "COPY . .",
    "RUN npm run build",
    "CMD [\"node\", \"dist/index.js\"]",
    "",
  ].join("\n");
}

function dockerComposeFor(context: ContentContext): string {
  return [
    "services:",
    `  ${slugify(context.projectName)}:`,
    "    build: .",
    "    ports:",
    "      - \"3000:3000\"",
    "    env_file:",
    "      - .env.example",
    "  postgres:",
    "    image: postgres:16-alpine",
    "    environment:",
    "      POSTGRES_USER: postgres",
    "      POSTGRES_PASSWORD: postgres",
    "      POSTGRES_DB: app",
    "    ports:",
    "      - \"5432:5432\"",
    "  redis:",
    "    image: redis:7-alpine",
    "    ports:",
    "      - \"6379:6379\"",
    "",
  ].join("\n");
}

function readmeFor(context: ContentContext): string {
  return [
    `# ${context.projectName}`,
    "",
    `Architecture: **${context.architecture.name}**`,
    "",
    context.architecture.ruleOfThumb,
    "",
    "## Common libraries / frameworks",
    "",
    ...context.architecture.commonLibraries.map((library) => `- ${library}`),
    "",
    "## Commands",
    "",
    "```bash",
    `${context.packageManager} install`,
    `${context.packageManager} run dev`,
    `${context.packageManager} run test`,
    "```",
    "",
  ].join("\n");
}

function openApiYaml(context: ContentContext): string {
  return [
    "openapi: 3.1.0",
    "info:",
    `  title: ${context.projectName} API`,
    "  version: 0.1.0",
    "paths: {}",
    "",
  ].join("\n");
}

function asyncApiYaml(context: ContentContext): string {
  return [
    "asyncapi: 3.0.0",
    "info:",
    `  title: ${context.projectName} Events`,
    "  version: 0.1.0",
    "channels: {}",
    "operations: {}",
    "components:",
    "  messages: {}",
    "",
  ].join("\n");
}

async function createDirectory(
  absolutePath: string,
  dryRun: boolean,
  result: GenerateProjectResult,
): Promise<void> {
  const relativePath = relative(result.rootDir, absolutePath) || ".";

  if (!dryRun) {
    await mkdir(absolutePath, { recursive: true });
  }

  result.createdDirectories.push(toPosix(relativePath));
}

async function writeScaffoldFile(args: {
  absolutePath: string;
  relativePath: string;
  content: string;
  writeMode: WriteMode;
  dryRun: boolean;
  result: GenerateProjectResult;
}): Promise<void> {
  const relativePath = toPosix(args.relativePath);

  if (!isInside(args.result.rootDir, args.absolutePath)) {
    throw new Error(`Refusing to write outside rootDir: ${args.absolutePath}`);
  }

  if (args.dryRun) {
    args.result.createdFiles.push(relativePath);
    return;
  }

  await mkdir(dirname(args.absolutePath), { recursive: true });

  try {
    await writeFile(args.absolutePath, args.content, {
      encoding: "utf8",
      flag: args.writeMode === "overwrite" ? "w" : "wx",
    });
    args.result.createdFiles.push(relativePath);
  } catch (error) {
    if (isFileExistsError(error)) {
      if (args.writeMode === "skip") {
        args.result.skippedFiles.push(relativePath);
        return;
      }

      if (args.writeMode === "error") {
        throw new Error(`File already exists: ${args.absolutePath}`);
      }
    }

    throw error;
  }
}

function expandWildcardEntries(entries: string[], replacements: string[]): string[] {
  return entries.flatMap((entry) => {
    if (!entry.includes("*")) return [entry];
    return replacements.map((replacement) => entry.replaceAll("*", replacement));
  });
}

function defaultServiceNames(architecture: ArchitectureDefinition): string[] {
  if (architecture.structure.exampleRepositories?.length) {
    return architecture.structure.exampleRepositories;
  }

  return ["api-gateway", "users", "orders", "billing"];
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\//, "").trim();

  if (!normalized || normalized === ".") return ".";
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Unsafe scaffold path: ${input}`);
  }

  return normalized;
}

function looksLikeFile(pathValue: string): boolean {
  const lastSegment = pathValue.split("/").at(-1) ?? "";
  return extname(lastSegment).length > 0 || lastSegment.startsWith(".");
}

function isPolyrepo(architecture: ArchitectureDefinition): boolean {
  return architecture.name.toLowerCase() === "polyrepo";
}

function isInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(sep));
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST",
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function withoutExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function toPosix(value: string): string {
  return value.replaceAll(sep, "/");
}

// Example usage:
//
// const catalog = await loadProjectCatalog('./typescript_project_structures.json');
// await generateProjectFromCatalog(catalog, 12, {
//   projectName: 'acme-platform',
//   targetDir: './generated',
//   packageManager: 'pnpm',
// });
//
// await generateAllProjects(catalog, {
//   targetDir: './generated-all',
//   projectNamePrefix: 'example',
//   dryRun: false,
// });
