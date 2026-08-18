import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_IGNORE = ["node_modules", ".git", ".DS_Store"] as const;

export type ProjectStructure = {
  [name: string]: ProjectStructureValue;
};

export type ProjectStructureValue =
  | ProjectStructure
  | string
  | number
  | boolean
  | null;

export interface ExtractStructureOptions {
  ignore?: readonly string[] | Set<string>;
}

export interface CreateStructureOptions {
  overwriteFiles?: boolean;
}

export interface CreateFromJsonFileResult {
  outputDir: string;
  structure: ProjectStructure;
}

export interface WriteStructureFileResult {
  outputPath: string;
  structure: ProjectStructure;
  json: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertValidName(name: string): void {
  if (!name || name.includes("\0") || name === "." || name === "..") {
    throw new Error(`Invalid file or directory name: ${name}`);
  }
}

function assertInsideBase(baseDir: string, targetPath: string, name: string): void {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe path detected: ${name}`);
  }
}

function normalizeIgnore(ignore?: readonly string[] | Set<string>): Set<string> {
  if (ignore === undefined) {
    return new Set(DEFAULT_IGNORE);
  }

  if (ignore instanceof Set) {
    return ignore;
  }

  if (Array.isArray(ignore)) {
    return new Set(ignore);
  }

  throw new Error("ignore option must be an array or Set.");
}

function assertProjectStructure(value: unknown): asserts value is ProjectStructure {
  if (!isPlainObject(value)) {
    throw new Error("Project structure must be a JSON object.");
  }
}

export function extractStructure(
  projectDir: string,
  options: ExtractStructureOptions = {},
): ProjectStructure {
  const ignore = normalizeIgnore(options.ignore);
  const resolvedProjectDir = path.resolve(projectDir);

  if (!fs.existsSync(resolvedProjectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  const stat = fs.statSync(resolvedProjectDir);

  if (!stat.isDirectory()) {
    throw new Error(`Path is not a directory: ${projectDir}`);
  }

  function walk(currentDir: string): ProjectStructure {
    const structure: ProjectStructure = {};

    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true,
    });

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (ignore.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        structure[entry.name] = walk(fullPath);
      } else if (entry.isFile()) {
        structure[entry.name] = "";
      }
    }

    return structure;
  }

  return walk(resolvedProjectDir);
}

export function createStructure(
  structure: ProjectStructure,
  baseDir: string,
  options: CreateStructureOptions = {},
): void {
  const { overwriteFiles = false } = options;

  assertProjectStructure(structure);

  const resolvedBaseDir = path.resolve(baseDir);

  fs.mkdirSync(resolvedBaseDir, { recursive: true });

  for (const [name, value] of Object.entries(structure)) {
    assertValidName(name);

    const targetPath = path.join(resolvedBaseDir, name);

    assertInsideBase(resolvedBaseDir, targetPath, name);

    if (isPlainObject(value)) {
      fs.mkdirSync(targetPath, { recursive: true });
      createStructure(value as ProjectStructure, targetPath, options);
    } else {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      if (!fs.existsSync(targetPath) || overwriteFiles) {
        fs.writeFileSync(targetPath, "");
      }
    }
  }
}

export function readStructureFile(jsonPath: string): ProjectStructure {
  const resolvedJsonPath = path.resolve(jsonPath);
  const jsonText = fs.readFileSync(resolvedJsonPath, "utf8");
  const parsed: unknown = JSON.parse(jsonText);

  assertProjectStructure(parsed);

  return parsed;
}

export function createFromJsonFile(
  jsonPath: string,
  outputDir: string = process.cwd(),
  options: CreateStructureOptions = {},
): CreateFromJsonFileResult {
  const structure = readStructureFile(jsonPath);

  createStructure(structure, outputDir, options);

  return {
    outputDir: path.resolve(outputDir),
    structure,
  };
}

export function structureToJson(structure: ProjectStructure): string {
  return `${JSON.stringify(structure, null, 2)}\n`;
}

export function writeStructureFile(
  projectDir: string,
  outputJsonPath: string,
  options: ExtractStructureOptions = {},
): WriteStructureFileResult {
  const structure = extractStructure(projectDir, options);
  const json = structureToJson(structure);

  fs.writeFileSync(outputJsonPath, json);

  return {
    outputPath: path.resolve(outputJsonPath),
    structure,
    json,
  };
}