import * as ts from "typescript";
import { resolve } from "node:path";
import fg from "fast-glob";
import { match } from "@phenomnomnominal/tsquery";
import type { AnalysisSession, CodemodDependencies } from "../core/pipeline";
import type { ProjectRequest, SourcePort } from "../contracts/services";
import type { DiscoverySelector } from "../contracts/rule";
import type { SyntaxCandidate } from "../contracts/source";
import type { PlannedFile } from "../contracts/rewrite";
import type { SemanticSnapshot } from "../contracts/semantics";
import { JsTsToolsEditPort, JsTsToolsSemanticPort } from "./js-ts-tools";
import { newDiagnostics } from "../core/diagnostics";
import { StaleSourceError } from "../core/transaction";
import { planImportInsertion } from "../core/import-planner";
import { CompilerSyntaxAnalysis, unwrap } from "../core/compiler-analysis";
import { isPrimitiveLiteralExpression, isVoidProducingArrowBody, unwrapParentheses } from "../core/ts-syntax";

/** One immutable set of selected inputs, with a new compiler view for each overlay. */
export class TypeScriptAnalysisSession implements AnalysisSession {
  readonly originals: ReadonlyMap<string, string>;
  readonly texts: Map<string, string>;
  private program!: ts.Program;
  private analysis!: CompilerSyntaxAnalysis;
  private snapshotCache = new Map<string, SemanticSnapshot>();
  private readonly semantics = new JsTsToolsSemanticPort();
  private readonly config: ts.ParsedCommandLine;
  private readonly selected: Set<string>;

  constructor(private readonly request: ProjectRequest, private readonly disk: SourcePort) {
    const configPath = resolve(request.cwd, request.tsconfig);
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    this.config = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve(configPath, ".."), undefined, configPath);
    if (this.config.errors.length) throw new Error(this.config.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
    const paths = fg.sync([...request.sources], { cwd: request.cwd, absolute: true, onlyFiles: true, unique: true })
      .map((file) => resolve(file)).filter((file) => !/\.d\.[cm]?ts$/.test(file) && !request.excludes.some((part) => file.includes(part))).sort();
    this.selected = new Set(paths);
    this.texts = new Map(paths.map((file) => [file, disk.read(file)]));
    this.originals = new Map(this.texts);
    this.refresh();
  }

  get dependencies(): CodemodDependencies {
    return {
      analysis: this.analysis,
      discovery: { discover: (_request, selectors) => this.discover(selectors) },
      semantics: { snapshot: () => this.snapshot(this.texts) },
      astPatterns: { match: (_request, requirements) => {
        if (requirements.length) throw new Error("AST-XPath requirements are not supported by the overlay session");
        return [];
      } },
      source: { read: (file) => this.texts.get(file) ?? this.disk.read(file), write: () => { throw new Error("Analysis sessions cannot write source files"); } },
      edits: new JsTsToolsEditPort(),
      imports: { plan: (_request, filePath, sourceText, requirements) => {
        const sf = this.program.getSourceFile(filePath)!;
        const existing = sf.statements.filter(ts.isImportDeclaration).map((node) => ({ startOffset: node.getStart(sf), endOffset: node.end, text: node.getText(sf) }));
        return planImportInsertion(filePath, sourceText, requirements, existing);
      } },
      validation: { validate: (_request, files, baseline) => {
        this.assertFresh();
        const proposed = new Map(this.texts);
        for (const file of files) proposed.set(file.filePath, file.editedText);
        const result = files.length ? this.snapshot(proposed) : baseline;
        this.assertFresh();
        const added = newDiagnostics(baseline.diagnostics, result.diagnostics);
        return { ok: !added.length, baselineDiagnostics: baseline.diagnostics, resultingDiagnostics: result.diagnostics, newDiagnostics: added };
      } },
    };
  }

  advance(files: readonly PlannedFile[]): void {
    for (const file of files) this.texts.set(file.filePath, file.editedText);
    this.refresh();
  }

  assertFresh(): void {
    for (const [file, original] of this.originals) if (this.disk.read(file) !== original) throw new StaleSourceError(file);
  }

  private snapshot(texts: ReadonlyMap<string, string>): SemanticSnapshot {
    const key = JSON.stringify([...texts]);
    const cached = this.snapshotCache.get(key);
    if (cached) return cached;
    const result = this.semantics.snapshotWithOverrides(this.request, texts);
    // Retain the current and next semantic view, not every compiler graph in a run.
    if (this.snapshotCache.size >= 2) this.snapshotCache.delete(this.snapshotCache.keys().next().value!);
    this.snapshotCache.set(key, result);
    return result;
  }

  private refresh(): void {
    const host = ts.createCompilerHost(this.config.options, true);
    const read = host.readFile.bind(host);
    host.readFile = (file) => this.texts.get(resolve(file)) ?? read(file);
    this.program = ts.createProgram({ rootNames: [...new Set([...this.config.fileNames, ...this.selected])], options: this.config.options, host });
    this.analysis = new CompilerSyntaxAnalysis(this.program.getTypeChecker(), this.selected, (file, start, end, text, imports) => this.checkRewrite(file, start, end, text, imports));
  }

  private checkRewrite(file: string, start: number, end: number, text: string, imports: readonly import("../contracts/rewrite").ImportRequirement[]): readonly string[] {
    const original = this.texts.get(file)!;
    const prefix = imports.map((item) => `import { ${item.importedName} as ${item.localName ?? item.importedName} } from ${JSON.stringify(item.moduleSpecifier)};\n`).join("");
    const edited = prefix + original.slice(0, start) + text + original.slice(end);
    const host = ts.createCompilerHost(this.config.options, true);
    const read = host.readFile.bind(host);
    host.readFile = (name) => resolve(name) === file ? edited : this.texts.get(resolve(name)) ?? read(name);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
      const cached = this.program.getSourceFile(name) as (ts.SourceFile & { redirectInfo?: unknown }) | undefined;
      // TypeScript marks duplicate-package files as redirects; those are owned
      // by their program and must never be returned by another compiler host.
      return resolve(name) !== file && cached && !cached.redirectInfo ? cached : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
    };
    const program = ts.createProgram({ rootNames: this.program.getRootFileNames(), options: this.config.options, host, oldProgram: this.program });
    const key = (diagnostic: ts.Diagnostic) => `${diagnostic.code}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    const baseline = this.program.getSemanticDiagnostics(this.program.getSourceFile(file)).map(key);
    return newDiagnostics(baseline, program.getSemanticDiagnostics(program.getSourceFile(file)).map(key)) as string[];
  }

  private discover(selectors: readonly DiscoverySelector[]): SyntaxCandidate[] {
    const result: SyntaxCandidate[] = [];
    for (const file of this.selected) {
      const sf = this.program.getSourceFile(file)!;
      const calls: ts.CallExpression[] = [];
      const visit = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); };
      visit(sf);
      for (const selector of selectors) {
        const name = /CallExpression\[expression\.expression\.text="Effect"\]\[expression\.name\.text="([^"]+)"\]/.exec(selector.tsquery)?.[1];
        const nodes: readonly ts.Node[] = name
          ? calls.filter((node) => this.analysis.normalize(node)?.operator === name)
          : selector.id === "effect.allWith.from-arrow-all.arrow"
            ? match(sf, "ArrowFunction").filter((node) => ts.isArrowFunction(node) && this.analysis.operator(unwrap(node.body)) === "all")
            : match(sf, selector.tsquery);
        for (const node of nodes) {
          if (!this.matchesShape(node, selector)) continue;
          const start = node.getStart(sf), end = node.getEnd();
          const a = sf.getLineAndCharacterOfPosition(start), b = sf.getLineAndCharacterOfPosition(end);
          result.push({ id: `${selector.id}:${file}:${start}:${end}`, selectorId: selector.id, filePath: file, kind: ts.SyntaxKind[node.kind], text: sf.text.slice(start, end), startOffset: start, endOffset: end, start: { line: a.line + 1, column: a.character + 1 }, end: { line: b.line + 1, column: b.character + 1 }, nativeNode: node });
        }
      }
    }
    return result;
  }

  private matchesShape(node: ts.Node, selector: DiscoverySelector): boolean {
    if (selector.generatorShape === "guard") {
      if (!ts.isIfStatement(node) || node.elseStatement || !ts.isBlock(node.parent)) return false;
      const previous = node.parent.statements[node.parent.statements.indexOf(node) - 1];
      if (!previous || !ts.isVariableStatement(previous) || previous.declarationList.declarations.length !== 1 || !previous.declarationList.declarations[0]!.initializer || !ts.isYieldExpression(previous.declarationList.declarations[0]!.initializer!)) return false;
    }
    if (selector.generatorShape === "dense-loop" && (!ts.isForOfStatement(node) || !ts.isArrayLiteralExpression(node.expression))) return false;
    if (selector.generatorShape && selector.generatorShape !== "yield-return") {
      let owner: ts.Node | undefined = node.parent;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (!owner || !ts.isFunctionExpression(owner) || !owner.asteriskToken || !ts.isCallExpression(owner.parent) || this.analysis.operator(owner.parent) !== "gen") return false;
    }
    if (!ts.isCallExpression(node)) return true;
    if (selector.generatorShape === "yield-return") {
      const fn = node.arguments[0];
      return node.arguments.length === 1 && Boolean(fn && ts.isFunctionExpression(fn) && fn.asteriskToken && fn.body.statements.length === 2);
    }
    const normalized = this.analysis.normalize(node);
    if (!normalized) return true; // Native collection rules retain their own semantic gate.
    if (selector.requiresSource && normalized.dataLast) return false;
    if (selector.requiresSourceCall && (!normalized.call.arguments[0] || !ts.isCallExpression(normalized.call.arguments[0] as ts.Node))) return false;
    // A local operator rewrite also works in a pipe/application. Prefer its
    // original call rather than reporting the enclosing expression a second time.
    if (!selector.requiresSource && !this.analysis.operator(node)) return false;
    if (selector.callbackShape || selector.callbackParameters !== undefined) {
      const callback = normalized.call.arguments[normalized.dataLast ? 0 : 1] as ts.Node | undefined;
      if (!callback || !ts.isArrowFunction(callback)) return false;
      if (selector.callbackParameters !== undefined && callback.parameters.length !== selector.callbackParameters) return false;
      const body = unwrapParentheses(callback.body, node.getSourceFile().text) as ts.Node;
      switch (selector.callbackShape) {
        case "call": return ts.isCallExpression(body);
        case "conditional": return ts.isConditionalExpression(body);
        case "not": return ts.isPrefixUnaryExpression(body) && body.operator === ts.SyntaxKind.ExclamationToken;
        case "literal": return isPrimitiveLiteralExpression(body, node.getSourceFile().text);
        case "void": return isVoidProducingArrowBody(body, node.getSourceFile().text);
        case "identity": return ts.isIdentifier(body);
      }
    }
    return true;
  }
}
