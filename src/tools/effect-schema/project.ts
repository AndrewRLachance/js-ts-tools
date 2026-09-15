import * as fs from "node:fs";
import * as path from "node:path";
import type ts from "typescript";
import type { EffectSchemaDiagnostic, EffectSchemaFileChange, EffectSchemaValidation } from "./contracts";

/** Records both successful reads and failed resolution probes, including config extends. */
export class SchemaProjectSnapshot {
  readonly parsed: ts.ParsedCommandLine;
  readonly program: ts.Program;
  private readonly reads = new Map<string, string | undefined>();
  private readonly existence = new Map<string, boolean>();
  private readonly directories = new Map<string, boolean>();
  private readonly listings: { args: Parameters<typeof ts.sys.readDirectory>; result: string[] }[] = [];
  readonly system: ts.System;

  constructor(readonly compiler: typeof ts, readonly configPath: string, extraFiles: readonly string[]) {
    const original = compiler.sys;
    this.system = {
      ...original,
      readFile: (file) => {
        const key = path.resolve(file);
        if (!this.reads.has(key)) this.reads.set(key, original.readFile(key));
        return this.reads.get(key);
      },
      fileExists: (file) => {
        const key = path.resolve(file);
        if (!this.existence.has(key)) this.existence.set(key, original.fileExists(key));
        return this.existence.get(key)!;
      },
      directoryExists: (directory) => {
        const key = path.resolve(directory);
        if (!this.directories.has(key)) this.directories.set(key, original.directoryExists(key));
        return this.directories.get(key)!;
      },
      readDirectory: (...args) => {
        const result = original.readDirectory(...args);
        this.listings.push({ args, result });
        return result;
      },
    };
    for (const file of extraFiles) this.system.readFile(file);
    const config = compiler.readConfigFile(configPath, this.system.readFile);
    if (config.error) throw new Error(compiler.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    this.parsed = compiler.parseJsonConfigFileContent(config.config, this.system, path.dirname(configPath), undefined, configPath);
    if (this.parsed.errors.length) {
      throw new Error(this.parsed.errors.map((d) => compiler.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    }
    if (this.parsed.projectReferences?.length) {
      throw new Error("effect-schema currently supports a single project without project references. Select a leaf tsconfig with --tsconfig.");
    }
    this.program = this.createProgram();
  }

  createProgram(overlays = new Map<string, string>()): ts.Program {
    const ts = this.compiler;
    const host = ts.createCompilerHost(this.parsed.options, true);
    host.readFile = (file) => overlays.get(path.resolve(file)) ?? this.system.readFile(file);
    host.fileExists = (file) => overlays.has(path.resolve(file)) || this.system.fileExists(file);
    host.directoryExists = this.system.directoryExists;
    host.readDirectory = this.system.readDirectory;
    host.getCurrentDirectory = () => path.dirname(this.configPath);
    host.getSourceFile = (fileName, languageVersion, onError) => {
      const text = host.readFile(fileName);
      if (text === undefined) { onError?.(`Cannot read ${fileName}`); return undefined; }
      return ts.createSourceFile(fileName, text, languageVersion, true);
    };
    return ts.createProgram({ rootNames: this.parsed.fileNames, options: this.parsed.options, host });
  }

  assertFresh(): void {
    const stale = (file: string): never => { throw new Error(`Project changed since discovery or preview: ${file}. List candidates and preview again.`); };
    for (const [file, text] of this.reads) if (this.compiler.sys.readFile(file) !== text) stale(file);
    for (const [file, exists] of this.existence) if (this.compiler.sys.fileExists(file) !== exists) stale(file);
    for (const [directory, exists] of this.directories) if (this.compiler.sys.directoryExists(directory) !== exists) stale(directory);
    for (const { args, result } of this.listings) {
      const current = this.compiler.sys.readDirectory(...args);
      if (JSON.stringify(current.slice().sort()) !== JSON.stringify(result.slice().sort())) stale(args[0]);
    }
  }

  validate(files: EffectSchemaFileChange[]): EffectSchemaValidation {
    const ts = this.compiler;
    const convert = (diagnostic: ts.Diagnostic): EffectSchemaDiagnostic => {
      const location = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
      return {
        code: diagnostic.code,
        category: (["warning", "error", "suggestion", "message"] as const)[diagnostic.category],
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ...(diagnostic.file ? { filePath: path.resolve(diagnostic.file.fileName) } : {}),
        ...(diagnostic.start !== undefined ? { start: diagnostic.start, length: diagnostic.length } : {}),
        ...(location ? { line: location.line + 1, column: location.character + 1 } : {}),
      };
    };
    const baselineDiagnostics = ts.getPreEmitDiagnostics(this.program).map(convert);
    const after = this.createProgram(new Map(files.map((file) => [file.filePath, file.editedText])));
    const resultingDiagnostics = ts.getPreEmitDiagnostics(after).map(convert);
    const key = (diagnostic: EffectSchemaDiagnostic, remap: boolean): string => {
      let start: number | string | undefined = diagnostic.start;
      if (remap && typeof start === "number") {
        const originalStart = start;
        for (const edit of files.find((file) => file.filePath === diagnostic.filePath)?.edits ?? []) {
          if (edit.end <= originalStart) start = (start as number) + edit.replacement.length - (edit.end - edit.start);
          else if (edit.start < originalStart + (diagnostic.length ?? 0)) { start = "changed-span"; break; }
        }
      }
      return JSON.stringify([diagnostic.filePath, diagnostic.code, diagnostic.message, start, diagnostic.length]);
    };
    const baseline = new Map<string, number>();
    for (const diagnostic of baselineDiagnostics.filter((d) => d.category === "error")) {
      const id = key(diagnostic, true);
      baseline.set(id, (baseline.get(id) ?? 0) + 1);
    }
    const newErrors = resultingDiagnostics.filter((diagnostic) => {
      if (diagnostic.category !== "error") return false;
      const id = key(diagnostic, false);
      const count = baseline.get(id) ?? 0;
      if (count) { baseline.set(id, count - 1); return false; }
      return true;
    });
    this.assertFresh();
    return { ok: newErrors.length === 0, baselineDiagnostics, resultingDiagnostics, newErrors };
  }
}

/** Stage complete replacements and use per-file rename; a multi-file commit is not crash-atomic. */
export function commitSchemaFiles(files: readonly EffectSchemaFileChange[]): void {
  const staged: { file: EffectSchemaFileChange; temporary: string }[] = [];
  const written: EffectSchemaFileChange[] = [];
  const assertOriginal = (file: EffectSchemaFileChange) => {
    if (fs.lstatSync(file.filePath).isSymbolicLink()) throw new Error(`Cannot replace a symbolic link: ${file.filePath}`);
    if (fs.readFileSync(file.filePath, "utf8") !== file.originalText) throw new Error(`Source changed since preview: ${file.filePath}`);
  };
  try {
    for (const file of files) {
      assertOriginal(file);
      const directory = fs.mkdtempSync(path.join(path.dirname(file.filePath), ".effect-schema-"));
      const temporary = path.join(directory, "replacement");
      staged.push({ file, temporary });
      fs.writeFileSync(temporary, file.editedText, { flag: "wx", mode: fs.statSync(file.filePath).mode & 0o777 });
    }
    for (const { file, temporary } of staged) {
      assertOriginal(file);
      fs.renameSync(temporary, file.filePath);
      written.push(file);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const file of written.reverse()) {
      try {
        if (fs.readFileSync(file.filePath, "utf8") !== file.editedText) {
          throw new Error(`Concurrent edit prevents rollback: ${file.filePath}`);
        }
        fs.writeFileSync(file.filePath, file.originalText);
      } catch (restoreError) { failures.push(restoreError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Apply failed and rollback was incomplete.");
    throw error;
  } finally {
    for (const { temporary } of staged) fs.rmSync(path.dirname(temporary), { recursive: true, force: true });
  }
}
