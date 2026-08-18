import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import fg from "fast-glob";

// jspath does not reliably ship first-class TypeScript types.
// This keeps the public API typed while isolating the untyped dependency.
const JSPath = require("jspath") as {
  apply: (expression: string, json: unknown) => unknown[] | unknown;
};

// stream-json also commonly needs isolated typing in TS projects.
const { parser } = require("stream-json") as {
  parser: () => NodeJS.ReadWriteStream;
};

const { streamArray } = require("stream-json/streamers/stream-array.js") as {
  streamArray: () => NodeJS.ReadWriteStream;
};

export interface ApplyJSPathToFilesStreamOptions
  extends ApplyJSPathToFilesOptions {
  onError?: (error: FileProcessingError) => void | Promise<void>;
}

export interface ForEachJSPathInFilesOptions
  extends ApplyJSPathToFilesOptions {}

export interface ForEachJSPathInFilesResult {
  count: number;
  errors: FileProcessingError[];
}

export interface ApplyJSPathOptions {
  first?: boolean;
}

export interface FindJsonFilesOptions {
  cwd?: string;
  absolute?: boolean;
}

export interface ApplyJSPathToFilesOptions {
  cwd?: string;
  absolute?: boolean;
  withFile?: boolean;
  first?: boolean;
  continueOnError?: boolean;
}

export interface FileResult<T = unknown> {
  file: string;
  value: T;
}

export interface FileProcessingError {
  file: string;
  error: Error;
}

export interface ApplyJSPathToFilesResult<T = unknown> {
  results: Array<T | FileResult<T>>;
  errors: FileProcessingError[];
}

/**
 * Reads and parses a JSON file.
 *
 * This is still appropriate for reasonably sized JSON objects.
 * Very large top-level arrays are handled separately by streamJsonArrayFile().
 */
export async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, "utf8");

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

/**
 * Applies a JSPath expression to an already-loaded JavaScript object.
 */
export function applyJSPath<T = unknown>(
  json: unknown,
  expression: string,
  options: ApplyJSPathOptions = {}
): T[] {
  const { first = false } = options;

  const rawMatches = JSPath.apply(expression, json);
  const matches = Array.isArray(rawMatches) ? rawMatches : [rawMatches];

  if (first) {
    return matches.length > 0 ? [matches[0] as T] : [];
  }

  return matches as T[];
}

/**
 * Streams JSPath matches from all JSON files matched by a glob pattern.
 *
 * This avoids accumulating all matches in memory.
 *
 * Error behavior:
 * - continueOnError=false: throws on the first file error.
 * - continueOnError=true: calls onError, skips that file, continues.
 */
export async function* applyJSPathToFilesStream<T = unknown>(
  patterns: string | string[],
  expression: string,
  options: ApplyJSPathToFilesStreamOptions = {}
): AsyncGenerator<T | FileResult<T>, void, void> {
  const {
    cwd = process.cwd(),
    absolute = false,
    withFile = false,
    first = false,
    continueOnError = false,
    onError
  } = options;

  const files = await findJsonFiles(patterns, { cwd, absolute });

  for (const file of files) {
    const filePath = absolute ? file : path.resolve(cwd, file);

    try {
      for await (const match of streamJSPathFromFile<T>(filePath, expression, {
        first
      })) {
        if (withFile) {
          yield {
            file: path.normalize(file),
            value: match
          };
        } else {
          yield match;
        }
      }
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));

      const fileError: FileProcessingError = {
        file,
        error: normalizedError
      };

      if (continueOnError) {
        await onError?.(fileError);
        continue;
      }

      throw normalizedError;
    }
  }
}

/**
 * Applies a callback to each JSPath match without accumulating matches.
 */
export async function forEachJSPathInFiles<T = unknown>(
  patterns: string | string[],
  expression: string,
  onMatch: (match: T | FileResult<T>) => void | Promise<void>,
  options: ForEachJSPathInFilesOptions = {}
): Promise<ForEachJSPathInFilesResult> {
  const errors: FileProcessingError[] = [];
  let count = 0;

  for await (const match of applyJSPathToFilesStream<T>(
    patterns,
    expression,
    {
      ...options,
      onError: error => {
        errors.push(error);
      }
    }
  )) {
    await onMatch(match);
    count += 1;
  }

  return {
    count,
    errors
  };
}

/**
 * Finds JSON files using a glob pattern.
 */
export async function findJsonFiles(
  patterns: string | string[],
  options: FindJsonFilesOptions = {}
): Promise<string[]> {
  const { cwd = process.cwd(), absolute = false } = options;

  return fg(patterns, {
    cwd,
    absolute,
    onlyFiles: true,
    unique: true
  });
}

/**
 * Reads enough of the file to determine the first non-whitespace JSON token.
 */
async function getFirstNonWhitespaceChar(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;

    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );

      if (bytesRead === 0) {
        return null;
      }

      for (let i = 0; i < bytesRead; i += 1) {
        const char = String.fromCharCode(buffer[i]);

        if (!/\s/.test(char)) {
          return char;
        }
      }

      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/**
 * True when the file is a top-level JSON array.
 *
 * This avoids loading huge array files into memory.
 */
async function isTopLevelJsonArray(filePath: string): Promise<boolean> {
  return (await getFirstNonWhitespaceChar(filePath)) === "[";
}

/**
 * Streams JSPath matches from a top-level JSON array file.
 *
 * The JSPath expression is applied to each array element independently.
 */
async function* streamJSPathFromLargeArrayFile<T = unknown>(
  filePath: string,
  expression: string,
  options: ApplyJSPathOptions = {}
): AsyncGenerator<T, void, void> {
  const { first = false } = options;

  const source = createReadStream(filePath, { encoding: "utf8" });
  const jsonPipeline = source.pipe(parser()).pipe(streamArray());

  try {
    for await (const chunk of jsonPipeline as AsyncIterable<{ value: unknown }>) {
      const matches = applyJSPath<T>(chunk.value, expression, {
        first: false
      });

      for (const match of matches) {
        yield match;

        if (first) {
          source.destroy();
          //@ts-ignore
          jsonPipeline.destroy();
          return;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

/**
 * Streams JSPath matches from any supported JSON file.
 *
 * - Top-level arrays are streamed item-by-item.
 * - Other JSON documents are parsed normally.
 */
export async function* streamJSPathFromFile<T = unknown>(
  filePath: string,
  expression: string,
  options: ApplyJSPathOptions = {}
): AsyncGenerator<T, void, void> {
  if (await isTopLevelJsonArray(filePath)) {
    yield* streamJSPathFromLargeArrayFile<T>(filePath, expression, options);
    return;
  }

  const json = await readJsonFile(filePath);
  const matches = applyJSPath<T>(json, expression, options);

  for (const match of matches) {
    yield match;
  }
}

/**
 * Non-streaming helper retained for the existing API.
 */
async function applyJSPathToFile<T = unknown>(
  filePath: string,
  expression: string,
  options: ApplyJSPathOptions = {}
): Promise<T[]> {
  const results: T[] = [];

  for await (const match of streamJSPathFromFile<T>(
    filePath,
    expression,
    options
  )) {
    results.push(match);
  }

  return results;
}

/**
 * Applies a JSPath expression to all JSON files matched by a glob pattern.
 */
export async function applyJSPathToFiles<T = unknown>(
  patterns: string | string[],
  expression: string,
  options: ApplyJSPathToFilesOptions = {}
): Promise<ApplyJSPathToFilesResult<T>> {
  const {
    cwd = process.cwd(),
    absolute = false,
    withFile = false,
    first = false,
    continueOnError = false
  } = options;

  const files = await findJsonFiles(patterns, { cwd, absolute });
  const results: Array<T | FileResult<T>> = [];
  const errors: FileProcessingError[] = [];

  for (const file of files) {
    const filePath = absolute ? file : path.resolve(cwd, file);

    try {
      const matches = await applyJSPathToFile<T>(filePath, expression, {
        first
      });

      for (const match of matches) {
        if (withFile) {
          results.push({
            file: path.normalize(file),
            value: match
          });
        } else {
          results.push(match);
        }
      }
    } catch (error) {
      const normalizedError =
        error instanceof Error ? error : new Error(String(error));

      errors.push({
        file,
        error: normalizedError
      });

      if (!continueOnError) {
        throw normalizedError;
      }
    }
  }

  return {
    results,
    errors
  };
}