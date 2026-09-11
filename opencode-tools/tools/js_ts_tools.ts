/// <reference path="../types/opencode-plugin.d.ts" />

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const CONFIG_REQUIRE_PATH = "/home/ai-developer/.config/opencode/tools/js_ts_tools.ts";
const DEFAULT_JS_TS_TOOLS_ROOT = "/home/ai-developer/development/automated-development/js-ts-tools";
const requireFromConfig = createRequire(CONFIG_REQUIRE_PATH);
const z = tool.schema;

type ToolContext = {
  directory: string;
  worktree: string;
};

type JsTsToolsModule = Record<string, any>;

const stringArray = z.array(z.string());
const stringOrArray = z.union([z.string(), stringArray]);
const directionSchema = z.enum(["incoming", "outgoing", "both"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);
const jsonMarkdownSchema = z.enum(["json", "markdown"]);
const jsonTextSchema = z.enum(["json", "text"]);

const sourceArgs = {
  sourceGlob: stringOrArray.describe("Source glob or globs, equivalent to repeatable --source."),
  tsConfigFilePath: z.string().optional().describe("TypeScript config path. Defaults to tsconfig.json."),
  excludePathIncludes: stringArray.optional().describe("Path substrings to exclude, equivalent to repeatable --exclude."),
  cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
};

function cwdFor(args: { cwd?: string }, context: ToolContext): string {
  return path.resolve(context.directory ?? context.worktree, args.cwd ?? ".");
}

async function loadBuiltPackage(): Promise<JsTsToolsModule> {
  try {
    return requireFromConfig("js-ts-tools") as JsTsToolsModule;
  } catch (error) {
    const packageRoot = process.env.JS_TS_TOOLS_ROOT ?? DEFAULT_JS_TS_TOOLS_ROOT;
    const modulePath = path.join(packageRoot, "dist/index.js");
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Unable to load js-ts-tools from package dependencies or ${modulePath}. Run npm run build in ${packageRoot}, install js-ts-tools in ~/.config/opencode/package.json, or set JS_TS_TOOLS_ROOT. ${message}`);
    }
  }
}

async function loadJsonJspath(): Promise<JsTsToolsModule> {
  try {
    return requireFromConfig("js-ts-tools/dist/tools/json-jspath") as JsTsToolsModule;
  } catch (error) {
    const packageRoot = process.env.JS_TS_TOOLS_ROOT ?? DEFAULT_JS_TS_TOOLS_ROOT;
    const modulePath = path.join(packageRoot, "dist/tools/json-jspath.js");
    try {
      return await import(pathToFileURL(modulePath).href);
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`Unable to load json-jspath from package dependencies or ${modulePath}. Rebuild or reinstall js-ts-tools, or set JS_TS_TOOLS_ROOT. ${message}`);
    }
  }
}

function json(value: unknown, pretty?: boolean): string {
  return `${JSON.stringify(value, null, pretty === false ? undefined : 2)}\n`;
}

function resolveFrom(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function resolveGlob(cwd: string, glob: string): string {
  const negative = glob.startsWith("!");
  const pattern = negative ? glob.slice(1) : glob;
  const resolved = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern);
  return `${negative ? "!" : ""}${resolved.replace(/\\/g, "/")}`;
}

function resolveGlobInput(cwd: string, input: string | string[]): string | string[] {
  return Array.isArray(input)
    ? input.map((glob) => resolveGlob(cwd, glob))
    : resolveGlob(cwd, input);
}

async function writeOutput(cwd: string, outputFilePath: string | undefined, text: string): Promise<string | undefined> {
  if (!outputFilePath) return undefined;
  const absolutePath = resolveFrom(cwd, outputFilePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, text, "utf8");
  return absolutePath;
}

function normalizePatterns(patterns?: string[]): string[] | undefined {
  return patterns?.map((pattern) => pattern.startsWith("pattern.") ? pattern : `pattern.${pattern}`);
}

function definedObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function compactTypeModel(model: any): object {
  return {
    schemaVersion: model.schemaVersion,
    project: model.project,
    moduleCount: model.modules?.length ?? 0,
    rootCount: model.roots?.length ?? 0,
    symbolCount: Object.keys(model.symbols ?? {}).length,
    typeCount: Object.keys(model.types ?? {}).length,
    signatureCount: Object.keys(model.signatures ?? {}).length,
    callSiteCount: Object.keys(model.callSites ?? {}).length,
    diagnosticCount: model.diagnostics?.length ?? 0,
  };
}

function formatTsQueryText(records: any[]): string {
  return records
    .map((record) => {
      const oneLine = String(record.text ?? "").replace(/\r?\n/g, "\\n");
      return `${record.filePath}:${record.start.line}:${record.start.column}\t${record.kind}\t${oneLine}`;
    })
    .join("\n") + (records.length > 0 ? "\n" : "");
}

export const context_pack = tool({
  description: "Build a task-focused context pack from js-ts-tools sources. Use for LLM context assembly around symbols, files, or locations.",
  args: {
    ...sourceArgs,
    task: z.string().optional().describe("Inline task text. Required unless taskFilePath is supplied."),
    taskFilePath: z.string().optional().describe("UTF-8 task file to read before creating the context pack."),
    testSourceGlob: stringOrArray.optional().describe("Test source glob or globs."),
    seeds: z.array(z.union([
      z.object({ kind: z.literal("symbol"), symbol: z.string(), filePath: z.string().optional() }),
      z.object({ kind: z.literal("file"), filePath: z.string() }),
      z.object({ kind: z.literal("location"), location: z.object({ filePath: z.string(), line: z.number(), column: z.number().optional() }) }),
    ])).optional().describe("Explicit context seeds."),
    docGlobs: stringArray.optional().describe("Additional documentation globs."),
    configFilePaths: stringArray.optional().describe("Additional configuration files to include."),
    maxSeeds: z.number().optional().describe("Maximum automatic seeds. Defaults to 5."),
    direction: directionSchema.optional().describe("Graph traversal direction."),
    maxDepth: z.number().optional().describe("Maximum traversal depth. Defaults to 2."),
    maxNodes: z.number().optional().describe("Maximum traversed nodes. Defaults to 100."),
    maxTokens: z.number().optional().describe("Estimated output budget. Defaults to 12000."),
    format: jsonMarkdownSchema.optional().describe("Output format. Defaults to markdown."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the formatted context pack."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    if (args.task && args.taskFilePath) throw new Error("Provide either task or taskFilePath, not both.");
    const taskText = args.task ?? (args.taskFilePath ? await readFile(resolveFrom(cwd, args.taskFilePath), "utf8") : undefined);
    if (!taskText?.trim()) throw new Error("context_pack requires task or taskFilePath.");

    const api = await loadBuiltPackage();
    const report = api.createContextPack({
      sourceGlob: args.sourceGlob,
      testSourceGlob: args.testSourceGlob,
      tsConfigFilePath: args.tsConfigFilePath,
      excludePathIncludes: args.excludePathIncludes,
      task: taskText,
      taskFilePath: args.taskFilePath,
      seeds: args.seeds,
      docGlobs: args.docGlobs,
      configFilePaths: args.configFilePaths,
      maxSeeds: args.maxSeeds,
      direction: args.direction,
      maxDepth: args.maxDepth,
      maxNodes: args.maxNodes,
      maxTokens: args.maxTokens,
      cwd,
    });
    const text = api.formatContextPack(report, { format: args.format ?? "markdown", pretty: args.pretty });
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    if (outputFilePath) return json({ outputFilePath, summary: report.summary, query: report.query }, args.pretty);
    return text;
  },
});

export const code_impact = tool({
  description: "Analyze transitive impact for a symbol or file with js-ts-tools code-impact.",
  args: {
    ...sourceArgs,
    testSourceGlob: stringOrArray.optional().describe("Test source glob or globs."),
    symbol: z.string().optional().describe("Simple or qualified symbol target."),
    filePath: z.string().optional().describe("File target or symbol disambiguator."),
    direction: directionSchema.optional().describe("Impact traversal direction. Defaults to both."),
    maxDepth: z.number().optional().describe("Maximum traversal depth. Defaults to 3."),
    maxNodes: z.number().optional().describe("Maximum traversed nodes. Defaults to 200."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the JSON report."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    if (!args.symbol && !args.filePath) throw new Error("code_impact requires symbol, filePath, or both.");
    const api = await loadBuiltPackage();
    const report = api.analyzeCodeImpact({ ...args, cwd });
    const text = json(report, args.pretty);
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    return outputFilePath ? json({ outputFilePath, summary: report.summary, query: report.query }, args.pretty) : text;
  },
});

export const code_slice = tool({
  description: "Create a dependency-aware code slice around a symbol, file, or location with js-ts-tools code-slice.",
  args: {
    ...sourceArgs,
    testSourceGlob: stringOrArray.optional().describe("Test source glob or globs."),
    symbol: z.string().optional().describe("Simple or qualified symbol target."),
    filePath: z.string().optional().describe("File target or symbol disambiguator."),
    at: z.object({ filePath: z.string(), line: z.number(), column: z.number().optional() }).optional().describe("Location target using 1-based line and optional column."),
    direction: directionSchema.optional().describe("Slice traversal direction. Defaults to both."),
    maxDepth: z.number().optional().describe("Maximum traversal depth. Defaults to 2."),
    maxNodes: z.number().optional().describe("Maximum traversed nodes. Defaults to 50."),
    format: jsonMarkdownSchema.optional().describe("Output format. Defaults to json."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the formatted slice."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    if (!args.at && !args.symbol && !args.filePath) throw new Error("code_slice requires at, symbol, filePath, or symbol plus filePath.");
    const api = await loadBuiltPackage();
    const report = api.createCodeSlice({ ...args, cwd });
    const text = api.formatCodeSlice(report, { format: args.format ?? "json", pretty: args.pretty });
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    return outputFilePath ? json({ outputFilePath, summary: report.summary, query: report.query }, args.pretty) : text;
  },
});

export const code_patterns = tool({
  description: "Detect architectural and design patterns with js-ts-tools code-patterns.",
  args: {
    ...sourceArgs,
    patterns: stringArray.optional().describe("Pattern keys with or without the pattern. prefix."),
    minConfidence: confidenceSchema.optional().describe("Minimum confidence. Defaults to low."),
    includeTestFiles: z.boolean().optional().describe("Include tests and mocks."),
    includeDeclarationFiles: z.boolean().optional().describe("Include declaration files."),
    graphMaxDepth: z.number().optional().describe("Definition-use graph traversal depth."),
    graphMaxRecordsPerTraversal: z.number().optional().describe("Definition-use records per traversal."),
    graphScoreCapPerPattern: z.number().optional().describe("Maximum definition-use score contribution per pattern."),
    callGraphMaxDepth: z.number().optional().describe("Call graph traversal depth."),
    callGraphMaxCallsPerTraversal: z.number().optional().describe("Call graph calls per traversal."),
    callGraphScoreCapPerPattern: z.number().optional().describe("Maximum call graph score contribution per pattern."),
    confidenceLow: z.number().optional().describe("Low-confidence score threshold."),
    confidenceMedium: z.number().optional().describe("Medium-confidence score threshold."),
    confidenceHigh: z.number().optional().describe("High-confidence score threshold."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the JSON detections."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    const confidenceThresholds = definedObject([
      ["low", args.confidenceLow],
      ["medium", args.confidenceMedium],
      ["high", args.confidenceHigh],
    ]);
    const config = definedObject([
      ["includeTestFiles", args.includeTestFiles],
      ["includeDeclarationFiles", args.includeDeclarationFiles],
      ["graphMaxDepth", args.graphMaxDepth],
      ["graphMaxRecordsPerTraversal", args.graphMaxRecordsPerTraversal],
      ["graphScoreCapPerPattern", args.graphScoreCapPerPattern],
      ["callGraphMaxDepth", args.callGraphMaxDepth],
      ["callGraphMaxCallsPerTraversal", args.callGraphMaxCallsPerTraversal],
      ["callGraphScoreCapPerPattern", args.callGraphScoreCapPerPattern],
      ["confidenceThresholds", Object.keys(confidenceThresholds).length > 0 ? confidenceThresholds : undefined],
    ]);
    const detections = api.detectPatternsFromSources({
      sourceGlob: resolveGlobInput(cwd, args.sourceGlob),
      tsConfigFilePath: args.tsConfigFilePath ? resolveFrom(cwd, args.tsConfigFilePath) : undefined,
      excludePathIncludes: args.excludePathIncludes,
      patterns: normalizePatterns(args.patterns),
      minConfidence: args.minConfidence,
      config,
    });
    const text = json(detections, args.pretty);
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    return outputFilePath ? json({ outputFilePath, detectionCount: detections.length }, args.pretty) : text;
  },
});

export const type_model = tool({
  description: "Extract a normalized TypeScript semantic model and optionally generate declarations with js-ts-tools type-model.",
  args: {
    ...sourceArgs,
    scope: z.enum(["exports", "all"]).optional().describe("Root scope. Defaults to exports."),
    includeCallSites: z.boolean().optional().describe("Include resolved call-like expressions."),
    includeDeclarationBundles: z.boolean().optional().describe("Include schema v3 declaration bundles."),
    outputFilePath: z.string().optional().describe("Optional file path to write the full JSON model."),
    includeModelInResponse: z.boolean().optional().describe("Include the full model in the tool response. Defaults to false when outputFilePath is set."),
    generateDeclarations: z.boolean().optional().describe("Generate declarations from the model."),
    declarationOutputFilePath: z.string().optional().describe("Optional file path to write generated declarations."),
    module: z.string().optional().describe("Module id or file path for declaration generation in multi-module models."),
    banner: z.string().optional().describe("Optional declaration banner."),
    omitDeclarationBanner: z.boolean().optional().describe("Omit the default declaration banner."),
    allowStructuralFallback: z.boolean().optional().describe("Allow lossy schema-v2 structural declaration output."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    const model = api.extractTypeModel({
      sourceGlob: args.sourceGlob,
      tsConfigFilePath: args.tsConfigFilePath,
      excludePathIncludes: args.excludePathIncludes,
      scope: args.scope,
      includeCallSites: args.includeCallSites,
      includeDeclarationBundles: args.includeDeclarationBundles,
      cwd,
    });
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, json(model, args.pretty));
    const declarationOptions = {
      module: args.module,
      banner: args.omitDeclarationBanner ? false : args.banner,
      structuralFallback: args.allowStructuralFallback ? "allow" : undefined,
    };
    let declarations: any;
    if (args.generateDeclarations || args.declarationOutputFilePath) {
      if (args.declarationOutputFilePath) {
        declarations = await api.saveTypeDeclarationsFromModel(
          model,
          resolveFrom(cwd, args.declarationOutputFilePath),
          declarationOptions,
        );
      } else {
        declarations = api.generateTypeDeclarationsFromModel(model, declarationOptions);
      }
    }
    const includeModel = args.includeModelInResponse ?? !outputFilePath;
    return json({
      ...compactTypeModel(model),
      outputFilePath,
      declarations,
      model: includeModel ? model : undefined,
    }, args.pretty);
  },
});

export const collect_types = tool({
  description: "Collect a dependency-first declaration closure for named TypeScript types with js-ts-tools collect-types.",
  args: {
    names: stringArray.describe("Root declaration names."),
    sourceFilePath: z.string().describe("File or barrel declaring/exporting the roots."),
    tsConfigFilePath: z.string().optional().describe("TypeScript config path. Defaults to tsconfig.json."),
    includeNodeModules: z.boolean().optional().describe("Include declarations from node_modules. Defaults to true."),
    includeTypeScriptLibs: z.boolean().optional().describe("Include TypeScript lib declarations. Defaults to false."),
    outputFilePath: z.string().optional().describe("Optional file path to write the generated declaration closure."),
    banner: z.string().optional().describe("Generated-file banner. Defaults to the CLI banner."),
    cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    const result = api.collectAssociatedTypes({
      names: args.names,
      sourceFilePath: resolveFrom(cwd, args.sourceFilePath),
      tsConfigFilePath: resolveFrom(cwd, args.tsConfigFilePath ?? "tsconfig.json"),
      includeNodeModules: args.includeNodeModules,
      includeTypeScriptLibs: args.includeTypeScriptLibs,
    });
    const formatOptions = { banner: args.banner ?? "/* Generated associated type closure. */" };
    if (args.outputFilePath) {
      const outputFilePath = await api.saveAssociatedTypes(result, resolveFrom(cwd, args.outputFilePath), formatOptions);
      return json({ outputFilePath, rootCount: result.roots.length, declarationCount: result.declarations.length });
    }
    return api.formatAssociatedTypes(result, formatOptions);
  },
});

export const create_project = tool({
  description: "Create a blank project structure or extract one with js-ts-tools create-project.",
  args: {
    mode: z.enum(["create", "extract"]).describe("Use create to materialize a structure or extract to inspect a directory."),
    structureJson: z.string().optional().describe("Project structure JSON object for create mode."),
    structureFilePath: z.string().optional().describe("Project structure JSON file for create mode."),
    outputDir: z.string().optional().describe("Output directory for create mode. Defaults to cwd."),
    overwriteFiles: z.boolean().optional().describe("Overwrite existing files in create mode."),
    projectDir: z.string().optional().describe("Project directory for extract mode."),
    outputJsonPath: z.string().optional().describe("Optional JSON file path for extract mode."),
    ignore: stringArray.optional().describe("Names to ignore in extract mode. Overrides the default ignore set."),
    cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    if (args.mode === "create") {
      const outputDir = resolveFrom(cwd, args.outputDir ?? ".");
      if (args.structureJson && args.structureFilePath) throw new Error("Provide either structureJson or structureFilePath, not both.");
      if (args.structureJson) {
        const structure = JSON.parse(args.structureJson);
        api.createStructure(structure, outputDir, { overwriteFiles: args.overwriteFiles });
        return json({ outputDir, structure });
      }
      if (args.structureFilePath) {
        const result = api.createFromJsonFile(resolveFrom(cwd, args.structureFilePath), outputDir, { overwriteFiles: args.overwriteFiles });
        return json(result);
      }
      throw new Error("create mode requires structureJson or structureFilePath.");
    }

    if (!args.projectDir) throw new Error("extract mode requires projectDir.");
    const projectDir = resolveFrom(cwd, args.projectDir);
    const structure = api.extractStructure(projectDir, { ignore: args.ignore });
    const structureJson = api.structureToJson(structure);
    const outputJsonPath = await writeOutput(cwd, args.outputJsonPath, structureJson);
    return outputJsonPath ? json({ outputJsonPath, structure }) : structureJson;
  },
});

export const code_graph = tool({
  description: "Build structural, call, owner-reference, and definition-use graphs with js-ts-tools code-graph.",
  args: {
    ...sourceArgs,
    includeStructureForest: z.boolean().optional().describe("Include the structure forest."),
    includeCallGraph: z.boolean().optional().describe("Include the call graph."),
    includeOwnerReferenceGraph: z.boolean().optional().describe("Include the owner-reference graph."),
    includeDefinitionUseGraph: z.boolean().optional().describe("Include the definition-use graph."),
    all: z.boolean().optional().describe("Include all graph types."),
    toJson: z.boolean().optional().describe("Return JSON-safe graph data. Defaults to true."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the graph JSON."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const includeAll = args.all === true;
    if (!includeAll && !args.includeStructureForest && !args.includeCallGraph && !args.includeOwnerReferenceGraph && !args.includeDefinitionUseGraph) {
      throw new Error("code_graph requires at least one graph flag or all: true.");
    }
    const api = await loadBuiltPackage();
    const graphs = api.buildGraphs(
      {
        sourceGlob: resolveGlobInput(cwd, args.sourceGlob),
        tsConfigFilePath: args.tsConfigFilePath ? resolveFrom(cwd, args.tsConfigFilePath) : undefined,
        excludePathIncludes: args.excludePathIncludes,
      },
      {
        includeStructureForest: includeAll || args.includeStructureForest,
        includeCallGraph: includeAll || args.includeCallGraph,
        includeOwnerReferenceGraph: includeAll || args.includeOwnerReferenceGraph,
        includeDefinitionUseGraph: includeAll || args.includeDefinitionUseGraph,
        toJson: args.toJson ?? true,
      },
    );
    const text = json(graphs, args.pretty);
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    return outputFilePath ? json({ outputFilePath }) : text;
  },
});

export const json_jspath = tool({
  description: "Apply a JSPath expression to JSON files with js-ts-tools json-jspath helpers.",
  args: {
    patterns: stringOrArray.describe("JSON file path or glob patterns."),
    expression: z.string().describe("JSPath expression to apply."),
    cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
    absolute: z.boolean().optional().describe("Return absolute matched file paths."),
    withFile: z.boolean().optional().describe("Wrap each result with its file path."),
    first: z.boolean().optional().describe("Return only the first match per file."),
    continueOnError: z.boolean().optional().describe("Continue after malformed or unreadable files."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the JSON result."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadJsonJspath();
    const result = await api.applyJSPathToFiles(args.patterns, args.expression, {
      cwd,
      absolute: args.absolute,
      withFile: args.withFile,
      first: args.first,
      continueOnError: args.continueOnError,
    });
    const text = json(result, args.pretty);
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    return outputFilePath ? json({ outputFilePath, count: result.results.length, errorCount: result.errors.length }) : text;
  },
});

export const github_js_ts_search = tool({
  description: "Find package imports in local JS/TS source or search GitHub for JS/TS files importing npm packages.",
  args: {
    mode: z.enum(["parse", "search"]).optional().describe("parse checks local source; search queries GitHub. Defaults to parse when source is supplied, otherwise search."),
    packages: stringArray.describe("npm package names to match."),
    source: z.string().optional().describe("Source text for parse mode."),
    sourceFilePath: z.string().optional().describe("Source file to read for parse mode."),
    fileName: z.string().optional().describe("Filename used for parser mode. Defaults to sourceFilePath or source.ts."),
    outputDirectory: z.string().optional().describe("Directory for GitHub search output. Defaults to downloads."),
    tokenEnv: z.string().optional().describe("Environment variable containing the GitHub token. Defaults to GITHUB_TOKEN."),
    maxAttempts: z.number().optional().describe("Maximum GitHub request attempts."),
    requestTimeoutMs: z.number().optional().describe("GitHub request timeout in milliseconds."),
    cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    const mode = args.mode ?? (args.source || args.sourceFilePath ? "parse" : "search");
    if (mode === "parse") {
      if (args.source && args.sourceFilePath) throw new Error("parse mode accepts either source or sourceFilePath, not both.");
      const source = args.source ?? (args.sourceFilePath ? await readFile(resolveFrom(cwd, args.sourceFilePath), "utf8") : undefined);
      if (source === undefined) throw new Error("parse mode requires source or sourceFilePath.");
      const fileName = args.fileName ?? args.sourceFilePath ?? "source.ts";
      const references = api.findPackageReferences(source, args.packages, fileName);
      return json({ importsAnyPackage: references.length > 0, references }, args.pretty);
    }

    const tokenEnv = args.tokenEnv ?? "GITHUB_TOKEN";
    const token = process.env[tokenEnv] ?? "";
    if (!token.trim()) throw new Error(`GitHub token not found in ${tokenEnv}.`);
    const report = await api.searchGitHubPackageImports({
      packages: args.packages,
      token,
      outputDirectory: args.outputDirectory ? resolveFrom(cwd, args.outputDirectory) : undefined,
      maxAttempts: args.maxAttempts,
      requestTimeoutMs: args.requestTimeoutMs,
    });
    return json(report, args.pretty);
  },
});

export const ast_xpath = tool({
  description: "Generate or match portable AST XPath patterns with js-ts-tools ast-xpath.",
  args: {
    mode: z.enum(["generate", "match", "run"]).describe("generate creates a pattern, match applies a pattern, run does both."),
    exampleFilePath: z.string().optional().describe("Marked example file for generate or run mode."),
    tsConfigFilePath: z.string().optional().describe("Example TypeScript config. Defaults to tsconfig.json."),
    targetTsConfigFilePath: z.string().optional().describe("Target TypeScript config for match or run mode."),
    strictness: z.enum(["exact", "shape"]).optional().describe("Generation strictness. Defaults to exact."),
    semanticMode: z.enum(["strict", "structural"]).optional().describe("Matching semantic mode. Defaults to strict."),
    patternFilePath: z.string().optional().describe("Pattern JSON file for match mode."),
    patternJson: z.string().optional().describe("Inline pattern JSON for match mode."),
    sourceGlobs: stringArray.optional().describe("Target source globs for matching."),
    excludePathIncludes: stringArray.optional().describe("Target path substrings to exclude."),
    includeDeclarations: z.boolean().optional().describe("Include declaration files when matching."),
    outputFilePath: z.string().optional().describe("Optional primary JSON output file path."),
    patternOutputPath: z.string().optional().describe("Optional generated pattern JSON output path for generate or run mode."),
    xmlOutputPath: z.string().optional().describe("Optional generated XML output path for generate or run mode."),
    includeXmlInResponse: z.boolean().optional().describe("Include generated XML in the response. Defaults to false when xmlOutputPath is set."),
    cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    if (args.mode === "generate") {
      if (!args.exampleFilePath) throw new Error("generate mode requires exampleFilePath.");
      const generated = api.generateAstXPathPattern({
        exampleFilePath: args.exampleFilePath,
        tsConfigFilePath: args.tsConfigFilePath,
        strictness: args.strictness,
        cwd,
      });
      const patternOutputPath = await writeOutput(cwd, args.patternOutputPath ?? args.outputFilePath, json(generated.pattern, args.pretty));
      const xmlOutputPath = await writeOutput(cwd, args.xmlOutputPath, generated.xml);
      return json({
        patternOutputPath,
        xmlOutputPath,
        pattern: generated.pattern,
        xml: (args.includeXmlInResponse ?? !xmlOutputPath) ? generated.xml : undefined,
      }, args.pretty);
    }

    if (args.mode === "match") {
      if (args.patternJson && args.patternFilePath) throw new Error("match mode accepts either patternJson or patternFilePath, not both.");
      const pattern = args.patternJson
        ? JSON.parse(args.patternJson)
        : args.patternFilePath
          ? api.readAstXPathPattern(resolveFrom(cwd, args.patternFilePath))
          : undefined;
      if (!pattern) throw new Error("match mode requires patternJson or patternFilePath.");
      const report = api.matchAstXPathPattern({
        pattern,
        cwd,
        targetTsConfigFilePath: args.targetTsConfigFilePath,
        semanticMode: args.semanticMode,
        sourceGlobs: args.sourceGlobs,
        excludePathIncludes: args.excludePathIncludes,
        includeDeclarations: args.includeDeclarations,
      });
      const text = json(report, args.pretty);
      const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
      return outputFilePath ? json({ outputFilePath, summary: report.summary }) : text;
    }

    if (!args.exampleFilePath) throw new Error("run mode requires exampleFilePath.");
    const report = api.runAstXPath({
      exampleFilePath: args.exampleFilePath,
      tsConfigFilePath: args.tsConfigFilePath,
      targetTsConfigFilePath: args.targetTsConfigFilePath,
      strictness: args.strictness,
      semanticMode: args.semanticMode,
      sourceGlobs: args.sourceGlobs,
      excludePathIncludes: args.excludePathIncludes,
      includeDeclarations: args.includeDeclarations,
      cwd,
    });
    const { xml, ...matchReport } = report;
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, json(matchReport, args.pretty));
    const patternOutputPath = await writeOutput(cwd, args.patternOutputPath, json(report.pattern, args.pretty));
    const xmlOutputPath = await writeOutput(cwd, args.xmlOutputPath, xml);
    return json({
      outputFilePath,
      patternOutputPath,
      xmlOutputPath,
      ...matchReport,
      xml: (args.includeXmlInResponse ?? !xmlOutputPath) ? xml : undefined,
    }, args.pretty);
  },
});

export const tsquery = tool({
  description: "Query or mutate a TypeScript project with TSQuery selectors using the js-ts-tools tsquery API.",
  args: {
    selector: z.string().describe("TSQuery selector."),
    tsconfig: z.string().optional().describe("TypeScript config path. Defaults to tsconfig.json."),
    sources: stringArray.optional().describe("Source globs to query."),
    excludes: stringArray.optional().describe("Path substrings to exclude."),
    includeDeclarations: z.boolean().optional().describe("Include declaration files."),
    format: jsonTextSchema.optional().describe("Output format. Defaults to json."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    failEmpty: z.boolean().optional().describe("Return status 2 when there are no matches."),
    mutationKind: z.enum(["delete", "insert-before", "insert-after"]).optional().describe("Optional mutation to preview or apply."),
    insertText: z.string().optional().describe("Insertion text for insert-before or insert-after mutations."),
    write: z.boolean().optional().describe("Apply mutation. Defaults to false."),
    outputFilePath: z.string().optional().describe("Optional file path for CLI-style mutation/query output."),
    cwd: z.string().optional().describe("Directory used to resolve relative paths. Defaults to the current OpenCode session directory."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    const mutation = args.mutationKind
      ? args.mutationKind === "delete"
        ? { kind: "delete" }
        : { kind: args.mutationKind, text: args.insertText ?? "" }
      : undefined;
    if (mutation && mutation.kind !== "delete" && mutation.text.length === 0) {
      throw new Error("insert-before and insert-after require insertText.");
    }
    const options = {
      selector: args.selector,
      tsconfig: args.tsconfig ?? "tsconfig.json",
      sources: args.sources ?? [],
      excludes: args.excludes ?? [],
      includeDeclarations: args.includeDeclarations ?? false,
      format: args.format ?? "json",
      pretty: args.pretty ?? false,
      failEmpty: args.failEmpty ?? false,
      write: args.write ?? false,
      mutation,
    };

    if (!mutation) {
      const records = api.collectMatches(options, cwd).map((match: any) => match.record);
      const status = records.length === 0 && options.failEmpty ? 2 : 0;
      const text = options.format === "text" ? formatTsQueryText(records) : json(records, args.pretty);
      const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
      return outputFilePath ? json({ status, outputFilePath, matchCount: records.length }) : text;
    }

    const explicitOutput = args.outputFilePath !== undefined;
    const outputPath = args.outputFilePath ?? path.join(".opencode", "tool-output", `tsquery-${Date.now()}-${randomUUID()}.json`);
    const status = api.run({ ...options, out: outputPath }, cwd);
    const absoluteOutputPath = resolveFrom(cwd, outputPath);
    const text = await readFile(absoluteOutputPath, "utf8");
    if (!explicitOutput) await unlink(absoluteOutputPath).catch(() => undefined);
    return explicitOutput ? json({ status, outputFilePath: absoluteOutputPath, output: text }) : text;
  },
});

export const convert_ts_pattern = tool({
  description: "Preview or apply safe conversions from conditionals to ts-pattern with js-ts-tools convert-ts-pattern.",
  args: {
    ...sourceArgs,
    write: z.boolean().optional().describe("Apply validated conversions. Defaults to false."),
    maxContinuationBytes: z.number().optional().describe("Maximum duplicated continuation bytes per file. Defaults to 16384."),
    pretty: z.boolean().optional().describe("Pretty-print JSON output."),
    outputFilePath: z.string().optional().describe("Optional file path to write the JSON report."),
  },
  async execute(args: any, context: ToolContext) {
    const cwd = cwdFor(args, context);
    const api = await loadBuiltPackage();
    const report = api.convertTsPattern({
      sourceGlob: args.sourceGlob,
      tsConfigFilePath: args.tsConfigFilePath,
      excludePathIncludes: args.excludePathIncludes,
      cwd,
      write: args.write ?? false,
      maxContinuationBytes: args.maxContinuationBytes,
    });
    const text = json(report, args.pretty);
    const outputFilePath = await writeOutput(cwd, args.outputFilePath, text);
    return outputFilePath ? json({ outputFilePath, summary: report.summary, written: report.written }) : text;
  },
});
