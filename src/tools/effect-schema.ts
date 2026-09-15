import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { createTwoFilesPatch } from "diff";
import type ts from "typescript";
import { completeStructuralSchemaEdits } from "./effect-schema/complete-edits";
import { applyTextEdits } from "./tsquery-cli";
import { commitSchemaFiles, SchemaProjectSnapshot } from "./effect-schema/project";
import { SchemaTsServer } from "./effect-schema/tsserver";
import type {
  EffectSchemaSessionOptions, EffectSchemaSession, EffectSchemaCandidate, EffectSchemaCandidateQuery,
  EffectSchemaPreview, EffectSchemaFileChange, EffectSchemaLocation,
} from "./effect-schema/contracts";
export type * from "./effect-schema/contracts";

const pluginName = "@effect/language-service";
const structuralRefactor = `${pluginName}/refactors/structuralTypeToSchema`;

/** Load the target project's dependencies; the package's own TypeScript is never a fallback. */
export async function createEffectSchemaSession(options: EffectSchemaSessionOptions = {}): Promise<EffectSchemaSession> {
  const cwd = fs.realpathSync(path.resolve(options.cwd ?? process.cwd()));
  const configPath = path.resolve(cwd, options.tsconfig ?? "tsconfig.json");
  if (!fs.statSync(configPath, { throwIfNoEntry: false })?.isFile()) throw new Error(`Cannot find tsconfig: ${configPath}`);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("timeoutMs must be a positive 32-bit integer.");
  const projectRequire = createRequire(configPath);
  const resolve = (name: string): string => {
    try { return projectRequire.resolve(name); }
    catch { throw new Error(`Cannot resolve ${name} from ${path.dirname(configPath)}. Install TypeScript and ${pluginName} in the target project.`); }
  };
  const compilerPath = resolve("typescript");
  const serverPath = resolve("typescript/lib/tsserver.js");
  const tsPackagePath = resolve("typescript/package.json");
  const pluginPackagePath = resolve(`${pluginName}/package.json`);
  // Some published plugin versions declare index.cjs but ship index.js. Let Node resolve it.
  const pluginPath = resolve(pluginName);
  const compiler: typeof ts = projectRequire(compilerPath);
  const major = Number(compiler.versionMajorMinor.split(".")[0]);
  if (major < 5 || major >= 7) throw new Error(`TypeScript ${compiler.version} is unsupported. This adapter requires TypeScript 5 or 6 with tsserver.`);
  const pluginVersion: string = JSON.parse(fs.readFileSync(pluginPackagePath, "utf8")).version;
  const extraFiles = [compilerPath, serverPath, tsPackagePath, pluginPath, pluginPackagePath];
  const session = new Session(compiler, configPath, serverPath, extraFiles, timeoutMs,
    { cwd, tsconfig: configPath, typescriptVersion: compiler.version, pluginVersion });
  try { await session.initialize(); return session; }
  catch (error) { await session.close(); throw error; }
}

class Session implements EffectSchemaSession {
  private snapshot?: SchemaProjectSnapshot;
  private server?: SchemaTsServer;
  private candidates = new Map<string, EffectSchemaCandidate>();
  private previews = new Map<string, EffectSchemaPreview>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private readonly serverProject: string;

  constructor(
    private readonly compiler: typeof ts,
    private readonly configPath: string,
    private readonly serverPath: string,
    private readonly extraFiles: string[],
    private readonly timeoutMs: number,
    readonly project: EffectSchemaSession["project"],
  ) {
    Object.freeze(project);
    this.serverProject = `${configPath}.effect-schema-${randomUUID()}`;
  }

  async initialize(): Promise<void> { await this.refresh(); }

  listCandidates(query: EffectSchemaCandidateQuery = {}): Promise<EffectSchemaCandidate[]> {
    return this.exclusive(async () => {
      try { this.snapshot?.assertFresh(); }
      catch { await this.refresh(); }
      if (!this.snapshot) await this.refresh();
      const filePath = query.filePath ? path.resolve(this.project.cwd, query.filePath) : undefined;
      const search = query.search?.toLocaleLowerCase();
      return structuredClone([...this.candidates.values()].filter((candidate) =>
        (!filePath || candidate.filePath === filePath) &&
        (!search || `${candidate.qualifiedName} ${candidate.filePath}`.toLocaleLowerCase().includes(search))));
    });
  }

  preview(candidateId: string): Promise<EffectSchemaPreview> {
    return this.exclusive(async () => {
      const candidate = this.candidates.get(candidateId);
      if (!candidate || !this.snapshot || !this.server) throw new Error("Unknown or expired candidate. List candidates again.");
      this.snapshot.assertFresh();
      const args = { file: candidate.filePath, projectFileName: this.serverProject,
        line: candidate.line, offset: candidate.column, triggerReason: "invoked" };
      const refactors = await this.server.request<ts.ApplicableRefactorInfo[]>("getApplicableRefactors", args);
      const refactor = refactors.find((r) => r.name === structuralRefactor || r.actions.some((a) => a.kind === "refactor.rewrite.effect.structuralTypeToSchema"));
      const action = refactor?.actions.find((a) => !a.notApplicableReason);
      const preview: EffectSchemaPreview = {
        id: randomUUID(), candidate, available: false, files: [], diff: "", validation: null,
      };
      if (!refactor || !action) {
        preview.reason = refactor?.actions[0]?.notApplicableReason ?? (candidate.generic
          ? "The installed Effect plugin does not offer Structural Type to Schema for this generic declaration."
          : "The installed Effect plugin does not offer Structural Type to Schema at this declaration.");
      } else {
        const edits = await this.server.request<ts.server.protocol.RefactorEditInfo>("getEditsForRefactor", {
          ...args, refactor: refactor.name, action: action.name,
        });
        this.snapshot.assertFresh();
        preview.refactorName = refactor.name;
        preview.actionName = action.name;
        preview.files = completeStructuralSchemaEdits(this.compiler, this.snapshot.program, candidate, this.convertEdits(edits.edits));
        preview.available = preview.files.length > 0;
        if (!preview.available) preview.reason = edits.notApplicableReason ?? "The refactor produced no changes.";
        else {
          preview.diff = preview.files.map((file) => {
            const relative = path.relative(this.project.cwd, file.filePath).split(path.sep).join("/");
            return createTwoFilesPatch(`a/${relative}`, `b/${relative}`, file.originalText, file.editedText);
          }).join("\n");
          preview.validation = this.snapshot.validate(preview.files);
        }
      }
      this.snapshot.assertFresh();
      // A preview is an opaque session handle. Mutating the returned data cannot change what is applied.
      this.previews.clear();
      this.previews.set(preview.id, preview);
      return structuredClone(preview);
    });
  }

  apply(previewId: string): Promise<{ written: boolean; filePaths: string[] }> {
    return this.exclusive(async () => {
      const preview = this.previews.get(previewId);
      if (!preview || !this.snapshot) throw new Error("Unknown or expired preview. Preview the declaration again.");
      this.snapshot.assertFresh();
      if (!preview.available || !preview.validation?.ok) throw new Error("Cannot apply: refactor unavailable or validation found new compiler errors.");
      commitSchemaFiles(preview.files);
      const filePaths = preview.files.map((file) => file.filePath);
      this.previews.clear();
      this.candidates.clear();
      this.snapshot = undefined;
      // Rebuild lazily on the next discovery, after the caller receives the successful write result.
      return { written: filePaths.length > 0, filePaths };
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.previews.clear();
    this.candidates.clear();
    this.closing = (async () => { await this.server?.close(); await this.queue.catch(() => {}); this.snapshot = undefined; })();
    return this.closing;
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed) throw new Error("Effect schema session closed.");
      return action();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async refresh(): Promise<void> {
    await this.server?.close();
    if (this.closed) throw new Error("Effect schema session closed.");
    this.previews.clear();
    this.candidates.clear();
    this.snapshot = new SchemaProjectSnapshot(this.compiler, this.configPath, this.extraFiles);
    const snapshot = this.snapshot;
    const ts = this.compiler;
    for (const rootName of snapshot.parsed.fileNames) {
      const source = snapshot.program.getSourceFile(rootName);
      if (!source || source.isDeclarationFile || /(?:^|[/\\])node_modules[/\\]/.test(rootName)) continue;
      const hash = createHash("sha256").update(source.text).digest("hex").slice(0, 16);
      const location = (position: number): EffectSchemaLocation => {
        const value = source.getLineAndCharacterOfPosition(position);
        return { line: value.line + 1, column: value.character + 1 };
      };
      const visit = (node: ts.Node, scope: string[]) => {
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
          const start = node.name.getStart(source);
          const filePath = path.resolve(source.fileName);
          const id = `${filePath}:${start}:${hash}`;
          this.candidates.set(id, {
            id, filePath, name: node.name.text, qualifiedName: [...scope, node.name.text].join("."),
            kind: ts.isInterfaceDeclaration(node) ? "interface" : "type", generic: !!node.typeParameters?.length,
            ...location(start), range: { start: location(node.getStart(source)), end: location(node.end) },
          });
        }
        const named = node as ts.NamedDeclaration;
        const nextScope = named.name && (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name))
          ? [...scope, named.name.text] : scope;
        ts.forEachChild(node, (child) => visit(child, nextScope));
      };
      visit(source, []);
    }
    const { configFile: _configFile, plugins: configuredPlugins, ...compilerOptions } = snapshot.parsed.options;
    const plugins = configuredPlugins as ts.PluginImport[] | undefined;
    const probeLocation = path.dirname(this.configPath);
    this.server = new SchemaTsServer(this.serverPath, probeLocation, probeLocation, this.timeoutMs);
    await this.server.request("configure", {
      hostInfo: "js-ts-tools/effect-schema", formatOptions: { indentSize: 2, tabSize: 2, convertTabsToSpaces: true },
    });
    await this.server.request("configurePlugin", {
      pluginName, configuration: { ...plugins?.find((p) => p.name === pluginName), name: pluginName },
    });
    await this.server.request("openExternalProject", {
      projectFileName: this.serverProject,
      rootFiles: snapshot.parsed.fileNames.map((fileName) => ({ fileName })),
      options: compilerOptions, typeAcquisition: { enable: false },
    });
    this.server.assertPluginLoaded();
    snapshot.assertFresh();
  }

  private convertEdits(changes: ts.server.protocol.FileCodeEdits[]): EffectSchemaFileChange[] {
    const snapshot = this.snapshot!;
    const allowed = new Set([...this.candidates.values()].map((candidate) => candidate.filePath));
    // All source roots are editable, even when an import-only file has no declarations.
    for (const file of snapshot.parsed.fileNames) {
      const source = snapshot.program.getSourceFile(file);
      if (source && !source.isDeclarationFile && !/(?:^|[/\\])node_modules[/\\]/.test(file)) allowed.add(path.resolve(file));
    }
    const grouped = new Map<string, ts.server.protocol.CodeEdit[]>();
    for (const change of changes) {
      const filePath = path.resolve(change.fileName);
      if (!allowed.has(filePath)) throw new Error(`Refactor edits a file outside the selected project's editable source files: ${filePath}`);
      grouped.set(filePath, [...grouped.get(filePath) ?? [], ...change.textChanges]);
    }
    return [...grouped].map(([filePath, changes]) => {
      const source = snapshot.program.getSourceFile(filePath)!;
      const starts = source.getLineStarts();
      const offset = (location: ts.server.protocol.Location): number => {
        const line = location.line - 1;
        const column = location.offset - 1;
        const start = starts[line];
        const end = starts[line + 1] ?? source.text.length;
        if (!Number.isInteger(line) || !Number.isInteger(column) || start === undefined || column < 0 || start + column > end) {
          throw new Error(`Invalid refactor edit position in ${filePath}`);
        }
        return start + column;
      };
      const edits = changes.map((change) => ({ start: offset(change.start), end: offset(change.end), replacement: change.newText }))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i];
        if (edit.end < edit.start || (i > 0 && (edits[i - 1].end > edit.start || edits[i - 1].start === edit.start))) {
          throw new Error(`Invalid or overlapping refactor edits in ${filePath}`);
        }
      }
      const originalText = source.text;
      return { filePath, originalText, edits, editedText: applyTextEdits(originalText, edits) };
    }).filter((file) => file.originalText !== file.editedText);
  }
}
