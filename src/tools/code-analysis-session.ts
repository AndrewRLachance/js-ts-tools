import path from "node:path";
import { Node, Project, type CompilerOptions } from "ts-morph";
import { createCodeAnalysisWorkspaceFromProject } from "./code-analysis";
import { createCodeSliceFromWorkspace, type CodeSliceReport } from "./code-slice";
import { detectPatterns } from "../patterns/pattern-detector";
import type { PatternDetection } from "../patterns/pattern-core";
import { extractTypeModelFromProject, type TypeModelV2 } from "./type-model";

export interface AnalysisRange { filePath: string; start: number; end: number; sourceFile?: boolean }
export interface CodeAnalysisSessionOptions {
  root: string;
  sources: readonly { filePath: string; text: string }[];
  compilerOptions?: CompilerOptions;
}

/** A caller-owned, read-only analysis session. Only supplied sources and bundled TS libs resolve. */
export function createCodeAnalysisSession(options: CodeAnalysisSessionOptions) {
  const root = path.resolve(options.root);
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: {
    ...options.compilerOptions, noEmit: true, types: [], plugins: [],
  }});
  const sources = [...options.sources].sort((a,b) => a.filePath.localeCompare(b.filePath)).map(source => {
    const filePath = path.resolve(root, source.filePath);
    const relative = path.relative(root, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Source escapes session root");
    // ts-morph strips a leading BOM. Preserve its UTF-16 slot as inert trivia.
    return project.createSourceFile(filePath, source.text.replace(/^\uFEFF/, " "));
  });
  let workspace: ReturnType<typeof createCodeAnalysisWorkspaceFromProject> | undefined;
  let patterns: PatternDetection[] | undefined;
  const slices = new Map<string, CodeSliceReport>();
  const stats = { projects: 1, graphBuilds: 0, patternRuns: 0 };
  const getWorkspace = () => {
    if (!workspace) {
      stats.graphBuilds++;
      workspace = createCodeAnalysisWorkspaceFromProject(project, sources, {
        cwd: root, tsConfigFilePath: path.join(root, "tsconfig.json"),
      });
    }
    return workspace;
  };
  const nodeAt = (range: AnalysisRange): Node => {
    const file = project.getSourceFileOrThrow(path.resolve(root, range.filePath));
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > file.getFullText().length)
      throw new Error("Invalid analysis range");
    if (range.sourceFile) return file;
    let node = file.getDescendantAtPos(range.start) ?? file;
    while (node.getEnd() < range.end && node.getParent()) node = node.getParentOrThrow();
    return node;
  };
  const targets = (range: AnalysisRange) => {
    nodeAt(range);
    const entries = getWorkspace().index.filter(e => e.node.filePath === path.resolve(root, range.filePath));
    if (range.sourceFile) return entries.filter(e =>
      e.declaration.getStart() < range.end && e.declaration.getEnd() > range.start &&
      !entries.some(parent => parent !== e && parent.declaration.getStart() <= e.declaration.getStart() && parent.declaration.getEnd() >= e.declaration.getEnd() && parent.declaration.getWidth() > e.declaration.getWidth()));
    return entries.filter(e => e.declaration.getStart() <= range.start && e.declaration.getEnd() >= range.end)
      .sort((a,b) => a.declaration.getWidth() - b.declaration.getWidth() || a.node.id.localeCompare(b.node.id)).slice(0,1);
  };
  return {
    stats,
    nodeAt,
    declaration(id: string) { return getWorkspace().index.find(e => e.node.id === id)?.declaration; },
    slice(range: AnalysisRange, limits: { maxDepth?: number; maxNodes?: number } = {}): CodeSliceReport | undefined {
      const maxNodes = limits.maxNodes ?? 50;
      if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(limits.maxDepth ?? 2) || (limits.maxDepth ?? 2) < 0) throw new Error("Invalid slice limits");
      const selected = targets(range);
      if (!selected.length) return undefined;
      const key = JSON.stringify([selected.map(e => e.node.id), limits.maxDepth ?? 2, maxNodes]);
      const cached = slices.get(key); if (cached) return cached;
      const report = createCodeSliceFromWorkspace(getWorkspace(), selected.slice(0,maxNodes), { direction: "both", ...limits });
      // The older slicing API budgets support nodes separately from target nodes.
      if (report.selections.length > maxNodes || selected.length > maxNodes) {
        report.selections = report.selections.slice(0,maxNodes);
        report.summary.truncated = true;
      }
      slices.set(key, report);
      return report;
    },
    graphs(ids: Iterable<string>) {
      const selected = new Set(ids);
      const ws = getWorkspace();
      return { nodes: [...ws.nodes.values()].filter(n => selected.has(n.id)),
        edges: ws.edges.filter(e => selected.has(e.fromId) && selected.has(e.toId)) };
    },
    patterns(ids: Iterable<string>): PatternDetection[] {
      const selected = new Set(ids), ws = getWorkspace();
      if (!patterns) {
        stats.patternRuns++;
        patterns = detectPatterns({ project, checker: project.getTypeChecker(), callGraph: ws.callGraph,
          definitionUseGraph: ws.definitionUseGraph, config: { includeTestFiles: true } });
      }
      const declarations = ws.index.filter(e => selected.has(e.node.id));
      return patterns.filter(p => p.detected && declarations.some(e => e.node.filePath === p.filePath &&
        e.declaration.getStartLineNumber() <= p.startLine && e.declaration.getEndLineNumber() >= p.endLine));
    },
    types(nodes: Node[]): TypeModelV2 {
      return extractTypeModelFromProject(project, sources, { sourceGlob: sources.map(s => s.getFilePath()), cwd: root, scope: "all", includeDeclarationBundles: false }, nodes) as TypeModelV2;
    },
    diagnostics() { return project.getPreEmitDiagnostics(); },
  };
}
export type CodeAnalysisSession = ReturnType<typeof createCodeAnalysisSession>;
