import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  evaluateXPathToNodes,
} from "fontoxpath";
import {
  Node as MorphNode,
  Project,
  SourceFile,
  ts,
} from "ts-morph";
import { globToRegExp } from "./tsquery-cli";

// slimdom publishes a CommonJS runtime entry but ESM-only TypeScript metadata.
// Keep the compatibility boundary local while the public API remains plain data.
const slimdom = require("slimdom") as any;
type SlimDocument = any;
type SlimElement = any;

export const AST_XPATH_PATTERN_SCHEMA_VERSION = 2 as const;
export const AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION = 1 as const;
export const AST_XPATH_XML_SCHEMA_VERSION = 1 as const;
export const AST_XPATH_VERSION = "3.1" as const;

export type AstXPathStrictness = "exact" | "shape";
export type AstXPathSemanticMode = "strict" | "structural";

export interface AstXPathLocation {
  line: number;
  column: number;
}

export interface AstXPathRange {
  startOffset: number;
  endOffset: number;
  start: AstXPathLocation;
  end: AstXPathLocation;
}

export interface AstXPathIgnoredRange extends AstXPathRange {
  marker: "single" | "paired";
}

export interface AstXPathDiagnostic {
  code: "unresolved-symbol" | "unresolved-signature" | "unportable-type" | "unportable-symbol" | "unportable-signature";
  message: string;
  kind: string;
  range: AstXPathRange;
}

interface AstXPathPatternBase {
  xmlSchemaVersion: typeof AST_XPATH_XML_SCHEMA_VERSION;
  xpathVersion: typeof AST_XPATH_VERSION;
  strictness: AstXPathStrictness;
  project: {
    tsconfigPath: string;
    tsconfigSha256: string;
    compilerOptionsSha256: string;
    typescriptVersion: string;
  };
  example: {
    filePath: string;
    sourceSha256: string;
    root: AstXPathRange & { kind: string };
  };
  ignored: AstXPathIgnoredRange[];
  xpath: string;
  diagnostics: AstXPathDiagnostic[];
}

export interface AstXPathPatternV1 extends AstXPathPatternBase {
  schemaVersion: typeof AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION;
  semanticPolicy: {
    automatic: true;
    mode: "binding-aware-exact";
    typeRelation: "mutually-assignable";
  };
}

export interface AstXPathTemplateGap {
  kind: "gap";
}

export interface AstXPathTemplateNode {
  kind: "node";
  id: string;
  syntaxKind: string;
  value?: string;
  fields: AstXPathTemplateField[];
}

export interface AstXPathTemplateField {
  name: string;
  collection: boolean;
  unconstrained?: true;
  children: Array<AstXPathTemplateNode | AstXPathTemplateGap>;
}

export interface AstXPathSymbolIdentity {
  scope: "package" | "project" | "typescript-lib";
  module: string;
  declarationPath: string;
  declarationKind: string;
}

export interface AstXPathBindingFact {
  kind: "internal" | "external";
  group?: string;
  identities?: AstXPathSymbolIdentity[];
}

export interface AstXPathSignatureFact {
  target: AstXPathBindingFact;
  overloadIndex: number;
  parameters?: AstXPathSignatureParameterFact[];
  returnTypeText?: string;
}

export interface AstXPathSignatureParameterFact {
  typeText: string;
  optional: boolean;
  rest: boolean;
}

export interface AstXPathSemanticFact {
  binding?: AstXPathBindingFact;
  typeText?: string;
  signature?: AstXPathSignatureFact;
}

export interface AstXPathPatternV2 extends AstXPathPatternBase {
  schemaVersion: typeof AST_XPATH_PATTERN_SCHEMA_VERSION;
  template: AstXPathTemplateNode;
  semantics: Record<string, AstXPathSemanticFact>;
  semanticPolicy: {
    automatic: true;
    mode: "portable-binding-aware";
    typeRelation: "mutually-assignable";
    unavailable: "structural";
  };
}

export type AstXPathPattern = AstXPathPatternV1 | AstXPathPatternV2;

export interface GenerateAstXPathPatternOptions {
  exampleFilePath: string;
  tsConfigFilePath?: string;
  cwd?: string;
  strictness?: AstXPathStrictness;
}

export interface GeneratedAstXPathPattern {
  pattern: AstXPathPatternV2;
  xml: string;
}

export interface MatchAstXPathPatternOptions {
  pattern: AstXPathPattern;
  cwd?: string;
  targetTsConfigFilePath?: string;
  semanticMode?: AstXPathSemanticMode;
  sourceGlobs?: string[];
  excludePathIncludes?: string[];
  includeDeclarations?: boolean;
}

export interface RunAstXPathOptions
  extends Omit<GenerateAstXPathPatternOptions, "cwd">,
    Omit<MatchAstXPathPatternOptions, "pattern" | "cwd"> {
  cwd?: string;
}

export interface AstXPathMatch {
  filePath: string;
  kind: string;
  start: AstXPathLocation;
  end: AstXPathLocation;
  startOffset: number;
  endOffset: number;
  text: string;
}

export interface AstXPathMatchSummary {
  filesScanned: number;
  xpathCandidates: number;
  semanticRejected: number;
  matches: number;
}

export interface AstXPathMatchReport {
  pattern: AstXPathPattern;
  matches: AstXPathMatch[];
  summary: AstXPathMatchSummary;
}

interface AstFieldModel {
  name: string;
  collection: boolean;
  nodes: AstNodeModel[];
}

interface AstNodeModel {
  id: string;
  kind: string;
  start: number;
  end: number;
  value?: string;
  fields: AstFieldModel[];
  compilerNode: ts.Node;
  parent?: AstNodeModel;
  parentField?: AstFieldModel;
}

interface AstDocumentModel {
  filePath: string;
  root: AstNodeModel;
  byId: Map<string, AstNodeModel>;
  byCompilerNode: Map<ts.Node, AstNodeModel>;
}

interface AstXmlDocument {
  document: SlimDocument;
  xml: string;
  model: AstDocumentModel;
}

interface Marker {
  type: "root" | "ignore" | "ignore-start" | "ignore-end";
  start: number;
  end: number;
}

interface ResolvedExample {
  project: Project;
  sourceFile: SourceFile;
  model: AstDocumentModel;
  xml: AstXmlDocument;
  root: AstNodeModel;
  ignoredNodes: Set<AstNodeModel>;
  ignoredRanges: AstXPathIgnoredRange[];
}

const MARKERS = new Map<string, Marker["type"]>([
  ["/* ast-xpath-root */", "root"],
  ["/* ast-xpath-ignore */", "ignore"],
  ["/* ast-xpath-ignore-start */", "ignore-start"],
  ["/* ast-xpath-ignore-end */", "ignore-end"],
]);

const IGNORED_COMPILER_PROPERTIES = new Set([
  "parent",
  "symbol",
  "localSymbol",
  "locals",
  "nextContainer",
  "flowNode",
  "emitNode",
  "jsDoc",
]);

export function serializeAstToXml(node: MorphNode): string {
  return createXmlDocument(
    node.compilerNode,
    node.getSourceFile().getFilePath(),
  ).xml;
}

export function generateAstXPathPattern(
  options: GenerateAstXPathPatternOptions,
): GeneratedAstXPathPattern {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, options.tsConfigFilePath ?? "tsconfig.json");
  const strictness = options.strictness ?? "exact";
  const resolved = resolveExample(cwd, configPath, options.exampleFilePath);
  const xpath = `//node[${nodePredicate(resolved.root, resolved.ignoredNodes, strictness)}]`;
  const selected = evaluateXPathToNodes<SlimElement>(xpath, resolved.xml.document);
  if (!selected.some((element) => element.getAttribute("id") === resolved.root.id)) {
    throw new Error("generated XPath did not select the marked example root");
  }

  const exampleBytes = fs.readFileSync(resolved.sourceFile.getFilePath());
  const portable = buildPortablePatternData(resolved, configPath, strictness);
  const pattern: AstXPathPatternV2 = {
    schemaVersion: AST_XPATH_PATTERN_SCHEMA_VERSION,
    xmlSchemaVersion: AST_XPATH_XML_SCHEMA_VERSION,
    xpathVersion: AST_XPATH_VERSION,
    strictness,
    project: {
      tsconfigPath: relativePath(cwd, configPath),
      tsconfigSha256: sha256(fs.readFileSync(configPath)),
      compilerOptionsSha256: sha256(stableJson(resolved.project.getCompilerOptions())),
      typescriptVersion: ts.version,
    },
    example: {
      filePath: relativePath(cwd, resolved.sourceFile.getFilePath()),
      sourceSha256: sha256(exampleBytes),
      root: {
        kind: resolved.root.kind,
        ...rangeForNode(resolved.sourceFile.compilerNode, resolved.root.compilerNode),
      },
    },
    ignored: resolved.ignoredRanges,
    xpath,
    template: portable.template,
    semantics: portable.semantics,
    semanticPolicy: {
      automatic: true,
      mode: "portable-binding-aware",
      typeRelation: "mutually-assignable",
      unavailable: "structural",
    },
    diagnostics: portable.diagnostics,
  };
  return { pattern, xml: resolved.xml.xml };
}

export function matchAstXPathPattern(
  options: MatchAstXPathPatternOptions,
): AstXPathMatchReport {
  validatePattern(options.pattern);
  if (options.semanticMode !== undefined && options.semanticMode !== "strict" && options.semanticMode !== "structural") {
    throw new Error(`invalid AST XPath semantic mode: ${String(options.semanticMode)}`);
  }
  if (options.pattern.schemaVersion === AST_XPATH_PATTERN_SCHEMA_VERSION) {
    return matchPortableAstXPathPattern(options.pattern, options);
  }
  return matchLegacyAstXPathPattern(options.pattern, options);
}

function matchLegacyAstXPathPattern(
  pattern: AstXPathPatternV1,
  options: MatchAstXPathPatternOptions,
): AstXPathMatchReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.resolve(cwd, pattern.project.tsconfigPath);
  if (options.targetTsConfigFilePath && path.resolve(cwd, options.targetTsConfigFilePath) !== configPath) {
    throw new Error("version 1 AST XPath patterns are project-anchored; regenerate the pattern as version 2 for cross-project matching");
  }
  validateAnchors(pattern, cwd, configPath);
  const resolved = resolveExample(cwd, configPath, pattern.example.filePath);
  validateResolvedPattern(pattern, resolved);
  const checker = resolved.project.getTypeChecker().compilerObject;
  const sourceFiles = selectSourceFiles(resolved.project, cwd, options);
  const matches: AstXPathMatch[] = [];
  let xpathCandidates = 0;
  let semanticRejected = 0;

  for (const sourceFile of sourceFiles) {
    const xml = createXmlDocument(sourceFile.compilerNode, sourceFile.getFilePath());
    const selected = evaluateXPathToNodes<SlimElement>(pattern.xpath, xml.document);
    const seen = new Set<string>();
    for (const element of selected) {
      const id = element.getAttribute("id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const candidate = xml.model.byId.get(id);
      if (!candidate) continue;
      xpathCandidates += 1;
      const alignment = alignNode(
        resolved.root,
        candidate,
        resolved.ignoredNodes,
        pattern.strictness,
        new Map(),
      );
      if (!alignment || (options.semanticMode !== "structural" && !semanticallyEquivalent(
          resolved.root,
          alignment,
          checker,
          cwd,
          pattern.strictness,
        ))) {
        semanticRejected += 1;
        continue;
      }
      matches.push(matchRecord(sourceFile.compilerNode, candidate.compilerNode, cwd));
    }
  }

  matches.sort((left, right) =>
    left.filePath.localeCompare(right.filePath) || left.startOffset - right.startOffset
  );
  return {
    pattern,
    matches,
    summary: {
      filesScanned: sourceFiles.length,
      xpathCandidates,
      semanticRejected,
      matches: matches.length,
    },
  };
}

export function runAstXPath(options: RunAstXPathOptions): AstXPathMatchReport & { xml: string } {
  const {
    sourceGlobs,
    excludePathIncludes,
    includeDeclarations,
    targetTsConfigFilePath,
    semanticMode,
    ...generateOptions
  } = options;
  const generated = generateAstXPathPattern(generateOptions);
  const report = matchAstXPathPattern({
    pattern: generated.pattern,
    cwd: options.cwd,
    targetTsConfigFilePath: targetTsConfigFilePath ?? options.tsConfigFilePath,
    semanticMode,
    sourceGlobs,
    excludePathIncludes,
    includeDeclarations,
  });
  return { ...report, xml: generated.xml };
}

export function readAstXPathPattern(filePath: string): AstXPathPattern {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  validatePattern(value);
  return value;
}

interface PortablePatternData {
  template: AstXPathTemplateNode;
  semantics: Record<string, AstXPathSemanticFact>;
  diagnostics: AstXPathDiagnostic[];
}

function buildPortablePatternData(
  resolved: ResolvedExample,
  configPath: string,
  strictness: AstXPathStrictness,
): PortablePatternData {
  const projectRoot = path.dirname(configPath);
  let nextTemplateId = 1;
  const templateIds = new Map<ts.Node, string>();
  const nodesByTemplateId = new Map<string, ts.Node>();
  const buildNode = (node: AstNodeModel): AstXPathTemplateNode => {
    const id = `t${nextTemplateId++}`;
    templateIds.set(node.compilerNode, id);
    nodesByTemplateId.set(id, node.compilerNode);
    return {
      kind: "node",
      id,
      syntaxKind: node.kind,
      ...(strictness === "exact" && node.value !== undefined ? { value: node.value } : {}),
      fields: node.fields.map((field) => buildTemplateField(field, resolved.ignoredNodes, buildNode)),
    };
  };
  const template = buildNode(resolved.root);
  const checker = resolved.project.getTypeChecker().compilerObject;
  const semantics: Record<string, AstXPathSemanticFact> = {};
  const diagnostics = collectSemanticDiagnostics(
    resolved.project,
    resolved.sourceFile,
    resolved.root,
    resolved.ignoredNodes,
  );
  const internalGroups = new Map<ts.Symbol, string>();
  const portableTypeCache = new Map<ts.Type, string | undefined>();

  for (const [compilerNode, id] of templateIds) {
    const fact: AstXPathSemanticFact = {};
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(compilerNode), checker);
    if (symbol) {
      const binding = bindingFactForSymbol(
        symbol,
        resolved.root.compilerNode,
        checker,
        projectRoot,
        internalGroups,
      );
      if (binding) fact.binding = binding;
      else diagnostics.push(portabilityDiagnostic("unportable-symbol", resolved.sourceFile.compilerNode, compilerNode,
        "The resolved symbol has no portable declaration identity."));
    }

    if (isTypeEligible(compilerNode)) {
      try {
        let type = checker.getTypeAtLocation(compilerNode);
        if (strictness === "shape") type = checker.getBaseTypeOfLiteralType(type);
        let typeText = portableTypeCache.get(type);
        if (!portableTypeCache.has(type)) {
          typeText = portableTypeText(type, compilerNode, checker, projectRoot);
          portableTypeCache.set(type, typeText);
        }
        if (typeText) fact.typeText = typeText;
        else diagnostics.push(portabilityDiagnostic("unportable-type", resolved.sourceFile.compilerNode, compilerNode,
          "The resolved type depends on declarations that cannot be represented portably."));
      } catch {
        diagnostics.push(portabilityDiagnostic("unportable-type", resolved.sourceFile.compilerNode, compilerNode,
          "The resolved type could not be converted into a portable type probe."));
      }
    }

    if (isCallLike(compilerNode)) {
      const resolvedSignature = checker.getResolvedSignature(compilerNode);
      const declaration = resolvedSignature?.declaration;
      if (declaration) {
        const signatureSymbol = symbolForDeclaration(declaration, checker);
        const target = signatureSymbol && bindingFactForSymbol(
          signatureSymbol,
          resolved.root.compilerNode,
          checker,
          projectRoot,
          internalGroups,
        );
        if (target) {
          const probe = portableSignatureProbe(resolvedSignature!, declaration, checker, projectRoot);
          fact.signature = {
            target,
            overloadIndex: overloadIndex(signatureSymbol!, declaration),
            ...(probe ?? {}),
          };
          if (!probe) diagnostics.push(portabilityDiagnostic(
            "unportable-signature",
            resolved.sourceFile.compilerNode,
            compilerNode,
            "The selected signature contains types that cannot be represented portably.",
          ));
        } else {
          diagnostics.push(portabilityDiagnostic("unportable-symbol", resolved.sourceFile.compilerNode, compilerNode,
            "The selected signature has no portable declaration identity."));
        }
      }
    }
    if (Object.keys(fact).length > 0) semantics[id] = fact;
  }
  const materialized = materializeSemanticTypes(semantics, resolved.project, configPath, template.id);
  for (const [id, fact] of Object.entries(semantics)) {
    const compilerNode = nodesByTemplateId.get(id)!;
    if (fact.typeText && !materialized.has(`type:${id}`)) {
      delete fact.typeText;
      diagnostics.push(portabilityDiagnostic("unportable-type", resolved.sourceFile.compilerNode, compilerNode,
        "The portable type probe could not be materialized in the example project."));
    }
    if (fact.signature?.parameters || fact.signature?.returnTypeText) {
      const parametersMaterialized = fact.signature.parameters?.every((_parameter, index) =>
        materialized.has(`signature:${id}:parameter:${index}`)
      ) ?? false;
      const returnMaterialized = Boolean(
        fact.signature.returnTypeText && materialized.has(`signature:${id}:return`),
      );
      if (!parametersMaterialized || !returnMaterialized) {
        delete fact.signature.parameters;
        delete fact.signature.returnTypeText;
        diagnostics.push(portabilityDiagnostic("unportable-signature", resolved.sourceFile.compilerNode, compilerNode,
          "The portable signature probe could not be materialized in the example project."));
      }
    }
  }
  return { template, semantics, diagnostics };
}

function buildTemplateField(
  field: AstFieldModel,
  ignored: Set<AstNodeModel>,
  buildNode: (node: AstNodeModel) => AstXPathTemplateNode,
): AstXPathTemplateField {
  if (!field.collection) {
    const child = field.nodes[0];
    return {
      name: field.name,
      collection: false,
      ...(child && ignored.has(child) ? { unconstrained: true as const } : {}),
      children: child && !ignored.has(child) ? [buildNode(child)] : [],
    };
  }
  const children: Array<AstXPathTemplateNode | AstXPathTemplateGap> = [];
  let gap = false;
  for (const child of field.nodes) {
    if (ignored.has(child)) {
      if (!gap) children.push({ kind: "gap" });
      gap = true;
    } else {
      children.push(buildNode(child));
      gap = false;
    }
  }
  return {
    name: field.name,
    collection: true,
    ...(field.nodes.length > 0 && field.nodes.every((node) => ignored.has(node))
      ? { unconstrained: true as const }
      : {}),
    children,
  };
}

function matchPortableAstXPathPattern(
  pattern: AstXPathPatternV2,
  options: MatchAstXPathPatternOptions,
): AstXPathMatchReport {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (pattern.project.typescriptVersion !== ts.version) {
    throw new Error(`TypeScript version drift: pattern uses ${pattern.project.typescriptVersion}, runtime uses ${ts.version}`);
  }
  const configPath = path.resolve(cwd, options.targetTsConfigFilePath ?? "tsconfig.json");
  if (!fs.existsSync(configPath)) throw new Error(`target tsconfig not found: ${relativePath(cwd, configPath)}`);
  const project = new Project({ tsConfigFilePath: configPath });
  const sourceFiles = selectSourceFiles(project, cwd, options);
  const expectedTypes = options.semanticMode === "structural"
    ? new Map<string, ts.Type>()
    : materializePortableTypes(pattern, project, configPath);
  const checker = project.getTypeChecker().compilerObject;
  const matches: AstXPathMatch[] = [];
  let xpathCandidates = 0;
  let semanticRejected = 0;

  for (const sourceFile of sourceFiles) {
    const xml = createXmlDocument(sourceFile.compilerNode, sourceFile.getFilePath());
    const selected = evaluateXPathToNodes<SlimElement>(pattern.xpath, xml.document);
    const seen = new Set<string>();
    for (const element of selected) {
      const id = element.getAttribute("id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const candidate = xml.model.byId.get(id);
      if (!candidate) continue;
      xpathCandidates += 1;
      const alignment = alignTemplateNode(pattern.template, candidate, pattern.strictness, new Map());
      const semanticMatch = alignment && (
        options.semanticMode === "structural" ||
        portableSemanticallyEquivalent(pattern, alignment, candidate.compilerNode, checker, path.dirname(configPath), expectedTypes)
      );
      if (!semanticMatch) {
        semanticRejected += 1;
        continue;
      }
      matches.push(matchRecord(sourceFile.compilerNode, candidate.compilerNode, cwd));
    }
  }
  matches.sort((left, right) =>
    left.filePath.localeCompare(right.filePath) || left.startOffset - right.startOffset
  );
  return {
    pattern,
    matches,
    summary: {
      filesScanned: sourceFiles.length,
      xpathCandidates,
      semanticRejected,
      matches: matches.length,
    },
  };
}

function alignTemplateNode(
  expected: AstXPathTemplateNode,
  candidate: AstNodeModel,
  strictness: AstXPathStrictness,
  seed: Map<string, ts.Node>,
): Map<string, ts.Node> | undefined {
  if (expected.syntaxKind !== candidate.kind) return undefined;
  if (strictness === "exact" && expected.value !== candidate.value) return undefined;
  const result = new Map(seed);
  result.set(expected.id, candidate.compilerNode);
  const expectedNames = new Set(expected.fields.map((field) => field.name));
  if (candidate.fields.some((field) => !expectedNames.has(field.name))) return undefined;
  const candidateFields = new Map(candidate.fields.map((field) => [field.name, field]));
  for (const field of expected.fields) {
    const actual = candidateFields.get(field.name);
    if (field.unconstrained) continue;
    if (!field.collection) {
      if (field.children.length === 0) {
        if (actual?.nodes.length) return undefined;
        continue;
      }
      if (!actual || actual.collection || actual.nodes.length !== 1) return undefined;
      const nested = alignTemplateNode(field.children[0] as AstXPathTemplateNode, actual.nodes[0], strictness, result);
      if (!nested) return undefined;
      replaceStringMap(result, nested);
      continue;
    }
    if (!actual?.collection) return undefined;
    const nested = alignTemplateCollection(field.children, actual.nodes, strictness, result);
    if (!nested) return undefined;
    replaceStringMap(result, nested);
  }
  return result;
}

function alignTemplateCollection(
  expected: Array<AstXPathTemplateNode | AstXPathTemplateGap>,
  candidate: AstNodeModel[],
  strictness: AstXPathStrictness,
  seed: Map<string, ts.Node>,
): Map<string, ts.Node> | undefined {
  const walk = (
    expectedIndex: number,
    candidateIndex: number,
    mapping: Map<string, ts.Node>,
  ): Map<string, ts.Node> | undefined => {
    if (expectedIndex >= expected.length) return candidateIndex === candidate.length ? mapping : undefined;
    const item = expected[expectedIndex];
    if (item.kind === "gap") {
      if (expectedIndex === expected.length - 1) return mapping;
      for (let index = candidateIndex; index <= candidate.length; index += 1) {
        const completed = walk(expectedIndex + 1, index, new Map(mapping));
        if (completed) return completed;
      }
      return undefined;
    }
    if (candidateIndex >= candidate.length) return undefined;
    const nested = alignTemplateNode(item, candidate[candidateIndex], strictness, mapping);
    return nested ? walk(expectedIndex + 1, candidateIndex + 1, nested) : undefined;
  };
  return walk(0, 0, new Map(seed));
}

function portableSemanticallyEquivalent(
  pattern: AstXPathPatternV2,
  mapping: Map<string, ts.Node>,
  candidateRoot: ts.Node,
  checker: ts.TypeChecker,
  projectRoot: string,
  expectedTypes: Map<string, ts.Type>,
): boolean {
  const groups = new Map<string, ts.Symbol>();
  const reverseGroups = new Map<ts.Symbol, string>();
  for (const [id, fact] of Object.entries(pattern.semantics)) {
    const actual = mapping.get(id);
    if (!actual) return false;
    if (!fact.binding) continue;
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(actual), checker);
    if (!symbol || !bindingMatches(fact.binding, symbol, candidateRoot, checker, projectRoot, groups, reverseGroups)) return false;
  }

  for (const [id, fact] of Object.entries(pattern.semantics)) {
    const actual = mapping.get(id);
    if (!actual) return false;
    if (fact.typeText) {
      const expectedType = expectedTypes.get(`type:${id}`);
      if (!expectedType) return false;
      try {
        let actualType = checker.getTypeAtLocation(actual);
        if (pattern.strictness === "shape") actualType = checker.getBaseTypeOfLiteralType(actualType);
        if (!checker.isTypeAssignableTo(expectedType, actualType) ||
            !checker.isTypeAssignableTo(actualType, expectedType)) return false;
      } catch {
        return false;
      }
    }
    if (fact.signature) {
      if (!isCallLike(actual)) return false;
      const declaration = checker.getResolvedSignature(actual)?.declaration;
      if (!declaration) return false;
      const symbol = symbolForDeclaration(declaration, checker);
      if (!symbol || !bindingMatches(fact.signature.target, symbol, candidateRoot, checker, projectRoot, groups, reverseGroups)) {
        return false;
      }
      if (overloadIndex(symbol, declaration) !== fact.signature.overloadIndex) return false;
      if (fact.signature.parameters || fact.signature.returnTypeText) {
        const signature = checker.getResolvedSignature(actual);
        if (!signature || !signatureProbeMatches(id, fact.signature, signature, checker, expectedTypes)) return false;
      }
    }
  }
  return true;
}

function bindingMatches(
  expected: AstXPathBindingFact,
  actual: ts.Symbol,
  candidateRoot: ts.Node,
  checker: ts.TypeChecker,
  projectRoot: string,
  groups: Map<string, ts.Symbol>,
  reverseGroups: Map<ts.Symbol, string>,
): boolean {
  actual = resolvedSymbol(actual, checker)!;
  if (expected.kind === "internal") {
    if (!expected.group) return false;
    if (!(actual.declarations ?? []).some((declaration) => nodeWithinCompilerNode(declaration, candidateRoot))) {
      return false;
    }
    const existing = groups.get(expected.group);
    if (existing && existing !== actual) return false;
    const otherGroup = reverseGroups.get(actual);
    if (otherGroup && otherGroup !== expected.group) return false;
    groups.set(expected.group, actual);
    reverseGroups.set(actual, expected.group);
    return true;
  }
  const actualIdentities = canonicalSymbolIdentities(actual, projectRoot);
  return identitiesEqual(expected.identities ?? [], actualIdentities);
}

function materializePortableTypes(
  pattern: AstXPathPatternV2,
  project: Project,
  configPath: string,
): Map<string, ts.Type> {
  return materializeSemanticTypes(pattern.semantics, project, configPath, pattern.xpath);
}

function materializeSemanticTypes(
  semantics: Record<string, AstXPathSemanticFact>,
  project: Project,
  configPath: string,
  probeKey: string,
): Map<string, ts.Type> {
  const entries: Array<{ key: string; typeText: string }> = [];
  for (const [id, fact] of Object.entries(semantics)) {
    if (fact.typeText) entries.push({ key: `type:${id}`, typeText: fact.typeText });
    fact.signature?.parameters?.forEach((parameter, index) => {
      entries.push({ key: `signature:${id}:parameter:${index}`, typeText: parameter.typeText });
    });
    if (fact.signature?.returnTypeText) {
      entries.push({ key: `signature:${id}:return`, typeText: fact.signature.returnTypeText });
    }
  }
  const result = new Map<string, ts.Type>();
  if (entries.length === 0) return result;
  const aliases = entries.map((entry, index) => ({ ...entry, name: `__AstXPathExpected${index}` }));
  const sourceText = aliases.map(({ name, typeText }) => `type ${name} = ${typeText};`).join("\n");
  const probePath = path.join(
    path.dirname(configPath),
    `.ast-xpath-portable-${sha256(probeKey).slice(0, 12)}.d.ts`,
  );
  const existing = project.getSourceFile(probePath);
  if (existing) project.removeSourceFile(existing);
  const sourceFile = project.createSourceFile(probePath, sourceText, { overwrite: true });
  for (const { key, name } of aliases) {
    const alias = sourceFile.getTypeAlias(name);
    if (!alias) continue;
    const type = alias.getType().compilerType;
    if ((type.flags & ts.TypeFlags.Any) === 0 || alias.getTypeNode()?.getText() === "any") {
      result.set(key, type);
    }
  }
  return result;
}

function bindingFactForSymbol(
  symbol: ts.Symbol,
  root: ts.Node,
  checker: ts.TypeChecker,
  projectRoot: string,
  internalGroups: Map<ts.Symbol, string>,
): AstXPathBindingFact | undefined {
  symbol = resolvedSymbol(symbol, checker)!;
  const declarations = symbol.declarations ?? [];
  if (declarations.some((declaration) => nodeWithinCompilerNode(declaration, root))) {
    let group = internalGroups.get(symbol);
    if (!group) {
      group = `b${internalGroups.size + 1}`;
      internalGroups.set(symbol, group);
    }
    return { kind: "internal", group };
  }
  const identities = canonicalSymbolIdentities(symbol, projectRoot);
  return identities.length > 0 ? { kind: "external", identities } : undefined;
}

function canonicalSymbolIdentities(symbol: ts.Symbol, projectRoot: string): AstXPathSymbolIdentity[] {
  return (symbol.declarations ?? [])
    .map((declaration) => canonicalDeclarationIdentity(declaration, symbol.getName(), projectRoot))
    .filter((identity): identity is AstXPathSymbolIdentity => identity !== undefined)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
    .filter((identity, index, values) => index === 0 || stableJson(identity) !== stableJson(values[index - 1]));
}

function canonicalDeclarationIdentity(
  declaration: ts.Declaration,
  symbolName: string,
  projectRoot: string,
): AstXPathSymbolIdentity | undefined {
  const filePath = normalizePath(path.resolve(declaration.getSourceFile().fileName));
  const kind = syntaxKindName(declaration.kind);
  const namedPath = [...declarationNamePath(declaration), symbolName].filter(Boolean).join(".");
  const libMatch = filePath.match(/\/typescript\/lib\/(lib\.[^/]+\.d\.ts)$/);
  if (libMatch) {
    return { scope: "typescript-lib", module: libMatch[1], declarationPath: namedPath, declarationKind: kind };
  }
  const nodeModules = filePath.lastIndexOf("/node_modules/");
  if (nodeModules >= 0) {
    const remainder = filePath.slice(nodeModules + "/node_modules/".length);
    const parts = remainder.split("/");
    const packageName = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const packageParts = packageName.split("/").length;
    const modulePath = stripModuleExtension(parts.slice(packageParts).join("/"));
    return {
      scope: "package",
      module: modulePath && modulePath !== "index" ? `${packageName}/${modulePath.replace(/\/index$/, "")}` : packageName,
      declarationPath: namedPath,
      declarationKind: kind,
    };
  }
  const absoluteRoot = path.resolve(projectRoot);
  if (filePath !== normalizePath(absoluteRoot) && !filePath.startsWith(`${normalizePath(absoluteRoot)}/`)) return undefined;
  const owner = nearestPackage(filePath, absoluteRoot);
  const base = owner?.root ?? absoluteRoot;
  return {
    scope: "project",
    module: owner?.name ?? ".",
    declarationPath: `${stripModuleExtension(relativePath(base, filePath))}#${namedPath}`,
    declarationKind: kind,
  };
}

function declarationNamePath(declaration: ts.Declaration): string[] {
  const result: string[] = [];
  let current: ts.Node | undefined = declaration;
  while (current && !ts.isSourceFile(current)) {
    const name = (current as ts.NamedDeclaration).name;
    if (name && ts.isIdentifier(name)) result.unshift(name.text);
    current = current.parent;
  }
  return result;
}

function nearestPackage(filePath: string, projectRoot: string): { root: string; name?: string } | undefined {
  let directory = path.dirname(filePath);
  const boundary = path.resolve(projectRoot);
  while (directory === boundary || directory.startsWith(`${boundary}${path.sep}`)) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const value = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown };
        return { root: directory, ...(typeof value.name === "string" ? { name: value.name } : {}) };
      } catch {
        return { root: directory };
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function symbolForDeclaration(declaration: ts.Declaration, checker: ts.TypeChecker): ts.Symbol | undefined {
  const name = (declaration as ts.NamedDeclaration).name;
  return resolvedSymbol(checker.getSymbolAtLocation(name ?? declaration), checker);
}

function overloadIndex(symbol: ts.Symbol, declaration: ts.Declaration): number {
  const declarations = (symbol.declarations ?? []).filter((candidate) => candidate.kind === declaration.kind);
  const index = declarations.indexOf(declaration);
  return index < 0 ? 0 : index;
}

function identitiesEqual(left: AstXPathSymbolIdentity[], right: AstXPathSymbolIdentity[]): boolean {
  return stableJson(left) === stableJson(right);
}

function portableTypeText(
  type: ts.Type,
  enclosingNode: ts.Node,
  checker: ts.TypeChecker,
  projectRoot: string,
): string | undefined {
  const node = checker.typeToTypeNode(
    type,
    enclosingNode,
    ts.NodeBuilderFlags.NoTruncation |
      ts.NodeBuilderFlags.UseFullyQualifiedType |
      ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
  );
  if (!node) return undefined;
  const printer = ts.createPrinter({ removeComments: true });
  const raw = printer.printNode(ts.EmitHint.Unspecified, node, enclosingNode.getSourceFile());
  const normalized = normalizePortableImports(raw, projectRoot);
  return isSelfContainedTypeText(normalized) ? normalized : undefined;
}

function portableSignatureProbe(
  signature: ts.Signature,
  declaration: ts.SignatureDeclaration | ts.JSDocSignature,
  checker: ts.TypeChecker,
  projectRoot: string,
): Pick<AstXPathSignatureFact, "parameters" | "returnTypeText"> | undefined {
  const parameters: AstXPathSignatureParameterFact[] = [];
  for (const [index, parameter] of signature.parameters.entries()) {
    const parameterDeclaration = declaration.parameters[index] ?? parameter.valueDeclaration ?? declaration;
    const type = checker.getTypeOfSymbolAtLocation(parameter, parameterDeclaration);
    const typeText = portableTypeText(type, parameterDeclaration, checker, projectRoot);
    if (!typeText) return undefined;
    const declaredParameter = declaration.parameters[index];
    const syntaxParameter = declaredParameter && ts.isParameter(declaredParameter) ? declaredParameter : undefined;
    parameters.push({
      typeText,
      optional: Boolean(syntaxParameter?.questionToken || syntaxParameter?.initializer),
      rest: Boolean(syntaxParameter?.dotDotDotToken),
    });
  }
  const returnTypeText = portableTypeText(checker.getReturnTypeOfSignature(signature), declaration, checker, projectRoot);
  return returnTypeText ? { parameters, returnTypeText } : undefined;
}

function signatureProbeMatches(
  id: string,
  expected: AstXPathSignatureFact,
  actual: ts.Signature,
  checker: ts.TypeChecker,
  expectedTypes: Map<string, ts.Type>,
): boolean {
  if (!expected.parameters || !expected.returnTypeText || actual.parameters.length !== expected.parameters.length) {
    return false;
  }
  for (const [index, expectedParameter] of expected.parameters.entries()) {
    const actualParameter = actual.parameters[index];
    const declaration = actual.getDeclaration()?.parameters[index] ?? actualParameter.valueDeclaration ?? actual.getDeclaration();
    if (!declaration) return false;
    const actualType = checker.getTypeOfSymbolAtLocation(actualParameter, declaration);
    const expectedType = expectedTypes.get(`signature:${id}:parameter:${index}`);
    if (!expectedType || !checker.isTypeAssignableTo(expectedType, actualType) ||
        !checker.isTypeAssignableTo(actualType, expectedType)) return false;
    const actualParameterDeclaration = actual.getDeclaration()?.parameters[index];
    const actualSyntaxParameter = actualParameterDeclaration && ts.isParameter(actualParameterDeclaration)
      ? actualParameterDeclaration
      : undefined;
    if (Boolean(actualSyntaxParameter?.questionToken || actualSyntaxParameter?.initializer) !== expectedParameter.optional ||
        Boolean(actualSyntaxParameter?.dotDotDotToken) !== expectedParameter.rest) return false;
  }
  const expectedReturn = expectedTypes.get(`signature:${id}:return`);
  const actualReturn = checker.getReturnTypeOfSignature(actual);
  return Boolean(expectedReturn && checker.isTypeAssignableTo(expectedReturn, actualReturn) &&
    checker.isTypeAssignableTo(actualReturn, expectedReturn));
}

function normalizePortableImports(text: string, projectRoot: string): string {
  return text.replace(/import\((['"])([^'"]+)\1\)/g, (_whole, _quote: string, specifier: string) => {
    if (!path.isAbsolute(specifier)) return `import(${JSON.stringify(normalizePath(specifier))})`;
    const normalized = normalizePath(specifier);
    const nodeModules = normalized.lastIndexOf("/node_modules/");
    if (nodeModules >= 0) {
      const remainder = normalized.slice(nodeModules + "/node_modules/".length);
      const parts = remainder.split("/");
      const packageName = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      const packageParts = packageName.split("/").length;
      const nested = stripModuleExtension(parts.slice(packageParts).join("/")).replace(/\/index$/, "");
      return `import(${JSON.stringify(nested ? `${packageName}/${nested}` : packageName)})`;
    }
    const root = normalizePath(path.resolve(projectRoot));
    if (normalized.startsWith(`${root}/`)) {
      return `import(${JSON.stringify(`./${stripModuleExtension(normalized.slice(root.length + 1))}`)})`;
    }
    return `import(${JSON.stringify(normalized)})`;
  });
}

const PORTABLE_GLOBAL_TYPES = new Set([
  "Array", "ReadonlyArray", "Promise", "PromiseLike", "Record", "Partial", "Required", "Readonly",
  "Pick", "Omit", "Exclude", "Extract", "NonNullable", "Parameters", "ConstructorParameters",
  "ReturnType", "InstanceType", "ThisParameterType", "OmitThisParameter", "ThisType", "Awaited",
  "Uppercase", "Lowercase", "Capitalize", "Uncapitalize", "Date", "RegExp", "Error", "Map",
  "ReadonlyMap", "Set", "ReadonlySet", "WeakMap", "WeakSet", "Iterable", "Iterator", "Generator",
]);

function isSelfContainedTypeText(text: string): boolean {
  if (/import\(["']\//.test(text) || /\btypeof\s+[A-Za-z_$]/.test(text)) return false;
  const source = ts.createSourceFile("portable-type.ts", `type __Portable = ${text};`, ts.ScriptTarget.Latest, true);
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if ((parseDiagnostics?.length ?? 0) > 0) return false;
  const localTypeParameters = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isTypeParameterDeclaration(node)) localTypeParameters.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  let portable = true;
  const inspect = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) &&
        !PORTABLE_GLOBAL_TYPES.has(node.typeName.text) && !localTypeParameters.has(node.typeName.text)) {
      portable = false;
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return portable;
}

function stripModuleExtension(value: string): string {
  return value.replace(/(?:\.d)?\.[cm]?[jt]sx?$/i, "");
}

function portabilityDiagnostic(
  code: "unportable-type" | "unportable-symbol" | "unportable-signature",
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string,
): AstXPathDiagnostic {
  return { code, message, kind: syntaxKindName(node.kind), range: rangeForNode(sourceFile, node) };
}

function replaceStringMap(target: Map<string, ts.Node>, source: Map<string, ts.Node>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function resolveExample(cwd: string, configPath: string, exampleFilePath: string): ResolvedExample {
  if (!fs.existsSync(configPath)) throw new Error(`tsconfig not found: ${relativePath(cwd, configPath)}`);
  const project = new Project({ tsConfigFilePath: configPath });
  const absoluteExample = path.resolve(cwd, exampleFilePath);
  let sourceFile = project.getSourceFile(absoluteExample);
  if (!sourceFile) {
    if (!fs.existsSync(absoluteExample)) throw new Error(`example file not found: ${exampleFilePath}`);
    sourceFile = project.addSourceFileAtPath(absoluteExample);
  }
  const xml = createXmlDocument(sourceFile.compilerNode, sourceFile.getFilePath());
  const markers = scanMarkers(sourceFile.compilerNode);
  const roots = markers.filter((marker) => marker.type === "root");
  if (roots.length !== 1) {
    throw new Error(`expected exactly one /* ast-xpath-root */ marker, found ${roots.length}`);
  }
  const root = findNextNode(xml.model, roots[0], undefined);
  if (!root) throw markerError(sourceFile.compilerNode, roots[0], "root marker is not followed by an AST node");
  const { ignoredNodes, ignoredRanges } = resolveIgnoredMarkers(
    sourceFile.compilerNode,
    xml.model,
    root,
    markers,
  );
  return { project, sourceFile, model: xml.model, xml, root, ignoredNodes, ignoredRanges };
}

function createXmlDocument(sourceNode: ts.Node, filePath: string): AstXmlDocument {
  const model = buildDocumentModel(sourceNode, filePath);
  const document = new slimdom.Document();
  const ast = document.createElement("ast");
  ast.setAttribute("schemaVersion", String(AST_XPATH_XML_SCHEMA_VERSION));
  ast.setAttribute("typescriptVersion", ts.version);
  document.appendChild(ast);
  const file = document.createElement("file");
  file.setAttribute("path", normalizePath(filePath));
  ast.appendChild(file);
  appendNodeXml(document, file, model.root);
  return {
    document,
    xml: new slimdom.XMLSerializer().serializeToString(document),
    model,
  };
}

function buildDocumentModel(sourceNode: ts.Node, filePath: string): AstDocumentModel {
  let nextId = 1;
  const byId = new Map<string, AstNodeModel>();
  const byCompilerNode = new Map<ts.Node, AstNodeModel>();
  const visit = (compilerNode: ts.Node, parent?: AstNodeModel): AstNodeModel => {
    const model: AstNodeModel = {
      id: `n${nextId++}`,
      kind: syntaxKindName(compilerNode.kind),
      start: safeStart(compilerNode),
      end: compilerNode.end,
      value: stableNodeValue(compilerNode),
      fields: [],
      compilerNode,
      parent,
    };
    byId.set(model.id, model);
    byCompilerNode.set(compilerNode, model);
    for (const rawField of syntaxFields(compilerNode)) {
      const field: AstFieldModel = {
        name: rawField.name,
        collection: rawField.collection,
        nodes: [],
      };
      for (const child of rawField.nodes) {
        const childModel = visit(child, model);
        childModel.parentField = field;
        field.nodes.push(childModel);
      }
      model.fields.push(field);
    }
    return model;
  };
  return {
    filePath,
    root: visit(sourceNode),
    byId,
    byCompilerNode,
  };
}

function syntaxFields(node: ts.Node): Array<{ name: string; collection: boolean; nodes: ts.Node[] }> {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    if (!isJSDocNode(child)) children.push(child);
  });
  const arrays: ts.NodeArray<ts.Node>[] = [];
  ts.forEachChild(node, () => undefined, (nodes) => {
    arrays.push(nodes);
    return undefined;
  });
  const entries = Object.entries(node as unknown as Record<string, unknown>)
    .filter(([name]) => !IGNORED_COMPILER_PROPERTIES.has(name));
  const result = new Map<string, { name: string; collection: boolean; nodes: ts.Node[] }>();
  for (const array of arrays) {
    const name = entries.find(([, value]) => value === array)?.[0];
    if (!name || name === "jsDoc") continue;
    result.set(name, { name, collection: true, nodes: [...array].filter((child) => !isJSDocNode(child)) });
  }
  for (const child of children) {
    const entry = entries.find(([, value]) =>
      value === child || (Array.isArray(value) && value.includes(child))
    );
    if (!entry) continue;
    const [name, value] = entry;
    if (name === "jsDoc") continue;
    const current = result.get(name);
    if (current) {
      if (!current.nodes.includes(child)) current.nodes.push(child);
    } else {
      result.set(name, { name, collection: Array.isArray(value), nodes: [child] });
    }
  }
  return [...result.values()];
}

function appendNodeXml(document: SlimDocument, parent: SlimElement, node: AstNodeModel): void {
  const element = document.createElement("node");
  element.setAttribute("id", node.id);
  element.setAttribute("kind", node.kind);
  element.setAttribute("start", String(node.start));
  element.setAttribute("end", String(node.end));
  if (node.value !== undefined) element.setAttribute("value", node.value);
  parent.appendChild(element);
  for (const field of node.fields) {
    const fieldElement = document.createElement("field");
    fieldElement.setAttribute("name", field.name);
    fieldElement.setAttribute("collection", field.collection ? "true" : "false");
    element.appendChild(fieldElement);
    field.nodes.forEach((child, index) => {
      const before = fieldElement.childNodes.length;
      appendNodeXml(document, fieldElement, child);
      const childElement = fieldElement.childNodes[before] as SlimElement;
      if (field.collection) childElement.setAttribute("index", String(index + 1));
    });
  }
}

function scanMarkers(sourceFile: ts.SourceFile): Marker[] {
  const literalRanges: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (isTextLiteralNode(node)) {
      literalRanges.push({ start: node.getStart(sourceFile, false), end: node.end });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const markers: Marker[] = [];
  for (const [text, type] of MARKERS) {
    for (let start = sourceFile.text.indexOf(text); start >= 0; start = sourceFile.text.indexOf(text, start + text.length)) {
      const end = start + text.length;
      if (literalRanges.some((range) => start >= range.start && end <= range.end)) continue;
      markers.push({ type, start, end });
    }
  }
  return markers.sort((left, right) => left.start - right.start);
}

function isTextLiteralNode(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) ||
    node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail ||
    node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
}

function containsOnlyBoundaryTrivia(text: string, allowSeparators: boolean): boolean {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.WhitespaceTrivia || token === ts.SyntaxKind.NewLineTrivia ||
        token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    if (allowSeparators && (token === ts.SyntaxKind.CommaToken || token === ts.SyntaxKind.SemicolonToken)) {
      continue;
    }
    return false;
  }
  return true;
}

function findNextNode(
  model: AstDocumentModel,
  marker: Marker,
  within: AstNodeModel | undefined,
): AstNodeModel | undefined {
  const candidates = [...model.byId.values()].filter((node) =>
    node !== model.root &&
    node.start >= marker.end &&
    (!within || isWithin(node, within))
  );
  const firstStart = Math.min(...candidates.map((node) => node.start));
  if (!Number.isFinite(firstStart)) return undefined;
  const between = model.root.compilerNode.getSourceFile().text.slice(marker.end, firstStart);
  if (!containsOnlyBoundaryTrivia(between, false)) return undefined;
  return candidates
    .filter((node) => node.start === firstStart)
    .sort((left, right) => right.end - left.end)[0];
}

function resolveIgnoredMarkers(
  sourceFile: ts.SourceFile,
  model: AstDocumentModel,
  root: AstNodeModel,
  markers: Marker[],
): { ignoredNodes: Set<AstNodeModel>; ignoredRanges: AstXPathIgnoredRange[] } {
  const ignoredNodes = new Set<AstNodeModel>();
  const ignoredRanges: AstXPathIgnoredRange[] = [];
  const activeStarts: Marker[] = [];
  for (const marker of markers) {
    if (marker.type === "root") continue;
    if (marker.start < root.start || marker.end > root.end) {
      throw markerError(sourceFile, marker, "ignore marker must be inside the selected root");
    }
    if (marker.type === "ignore") {
      if (activeStarts.length > 0) throw markerError(sourceFile, marker, "ignore markers may not be nested");
      const node = findNextNode(model, marker, root);
      if (!node) throw markerError(sourceFile, marker, "ignore marker is not followed by an AST node");
      addIgnoredNode(ignoredNodes, node, sourceFile, marker);
      ignoredRanges.push({ marker: "single", ...rangeForOffsets(sourceFile, node.start, node.end) });
      continue;
    }
    if (marker.type === "ignore-start") {
      if (activeStarts.length > 0) throw markerError(sourceFile, marker, "ignore spans may not be nested");
      activeStarts.push(marker);
      continue;
    }
    const start = activeStarts.pop();
    if (!start) throw markerError(sourceFile, marker, "ignore-end marker has no matching ignore-start");
    const contained = maximalContainedNodes(model, root, start.end, marker.start);
    if (contained.length === 0) throw markerError(sourceFile, start, "ignore span contains no complete AST node");
    validateContiguousNodes(contained, sourceFile, start);
    const contentStart = contained[0].start;
    const contentEnd = contained.at(-1)!.end;
    if (!containsOnlyBoundaryTrivia(sourceFile.text.slice(start.end, contentStart), true) ||
        !containsOnlyBoundaryTrivia(sourceFile.text.slice(contentEnd, marker.start), true)) {
      throw markerError(sourceFile, start, "ignore span cuts through an AST node");
    }
    for (const node of contained) addIgnoredNode(ignoredNodes, node, sourceFile, start);
    ignoredRanges.push({ marker: "paired", ...rangeForOffsets(sourceFile, contentStart, contentEnd) });
  }
  if (activeStarts.length > 0) {
    throw markerError(sourceFile, activeStarts[0], "ignore-start marker has no matching ignore-end");
  }
  return { ignoredNodes, ignoredRanges };
}

function maximalContainedNodes(
  model: AstDocumentModel,
  root: AstNodeModel,
  start: number,
  end: number,
): AstNodeModel[] {
  return [...model.byId.values()]
    .filter((node) =>
      node !== root && isWithin(node, root) &&
      node.start >= start && node.end <= end &&
      (!node.parent || node.parent.start < start || node.parent.end > end)
    )
    .sort((left, right) => left.start - right.start || right.end - left.end);
}

function validateContiguousNodes(nodes: AstNodeModel[], sourceFile: ts.SourceFile, marker: Marker): void {
  if (nodes.length <= 1) return;
  const parent = nodes[0].parent;
  const field = nodes[0].parentField;
  if (!parent || !field?.collection || nodes.some((node) => node.parent !== parent || node.parentField !== field)) {
    throw markerError(sourceFile, marker, "ignore span must contain one subtree or contiguous siblings in one collection");
  }
  const indices = nodes.map((node) => field.nodes.indexOf(node));
  if (indices.some((index, offset) => offset > 0 && index !== indices[offset - 1] + 1)) {
    throw markerError(sourceFile, marker, "ignore span siblings are not contiguous");
  }
}

function addIgnoredNode(
  ignored: Set<AstNodeModel>,
  node: AstNodeModel,
  sourceFile: ts.SourceFile,
  marker: Marker,
): void {
  if ([...ignored].some((existing) => isWithin(node, existing) || isWithin(existing, node))) {
    throw markerError(sourceFile, marker, "ignored regions may not overlap");
  }
  ignored.add(node);
}

function nodePredicate(node: AstNodeModel, ignored: Set<AstNodeModel>, strictness: AstXPathStrictness): string {
  const predicates = [`@kind = ${xpathLiteral(node.kind)}`];
  if (strictness === "exact" && node.value !== undefined) {
    predicates.push(`@value = ${xpathLiteral(node.value)}`);
  }
  const allowedFields = node.fields.map((field) => field.name);
  if (allowedFields.length === 0) {
    predicates.push("not(field)");
  } else {
    predicates.push(`not(field[not(${allowedFields.map((name) => `@name = ${xpathLiteral(name)}`).join(" or ")})])`);
  }
  for (const field of node.fields) {
    const fieldPredicate = fieldConstraint(field, ignored, strictness);
    if (fieldPredicate) predicates.push(fieldPredicate);
  }
  return predicates.join(" and ");
}

function fieldConstraint(
  field: AstFieldModel,
  ignored: Set<AstNodeModel>,
  strictness: AstXPathStrictness,
): string | undefined {
  const prefix = `field[@name = ${xpathLiteral(field.name)} and @collection = ${xpathLiteral(String(field.collection))}`;
  if (!field.collection) {
    const child = field.nodes[0];
    if (!child || ignored.has(child)) return undefined;
    return `${prefix} and count(node) = 1 and node[1][${nodePredicate(child, ignored, strictness)}]]`;
  }
  if (field.nodes.length === 0) return `${prefix} and count(node) = 0]`;
  if (!field.nodes.some((node) => ignored.has(node))) {
    const positions = field.nodes.map((node, index) =>
      `node[${index + 1}][${nodePredicate(node, ignored, strictness)}]`
    );
    return `${prefix} and count(node) = ${field.nodes.length} and ${positions.join(" and ")}]`;
  }
  const retained = field.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => !ignored.has(node));
  if (retained.length === 0) return undefined;
  const leadingGap = retained[0].index > 0;
  const trailingGap = retained.at(-1)!.index < field.nodes.length - 1;
  const chain = collectionChain(retained, 0, ignored, strictness, trailingGap);
  return `${prefix} and ${leadingGap ? "node" : "node[1]"}[${chain}]]`;
}

function collectionChain(
  retained: Array<{ node: AstNodeModel; index: number }>,
  offset: number,
  ignored: Set<AstNodeModel>,
  strictness: AstXPathStrictness,
  trailingGap: boolean,
): string {
  const current = retained[offset];
  const parts = [nodePredicate(current.node, ignored, strictness)];
  const next = retained[offset + 1];
  if (!next) {
    if (!trailingGap) parts.push("not(following-sibling::node)");
    return parts.join(" and ");
  }
  const hasGap = next.index > current.index + 1;
  const axis = hasGap ? "following-sibling::node" : "following-sibling::node[1]";
  parts.push(`${axis}[${collectionChain(retained, offset + 1, ignored, strictness, trailingGap)}]`);
  return parts.join(" and ");
}

function alignNode(
  pattern: AstNodeModel,
  candidate: AstNodeModel,
  ignored: Set<AstNodeModel>,
  strictness: AstXPathStrictness,
  seed: Map<ts.Node, ts.Node>,
): Map<ts.Node, ts.Node> | undefined {
  if (pattern.kind !== candidate.kind) return undefined;
  if (strictness === "exact" && pattern.value !== candidate.value) return undefined;
  const result = new Map(seed);
  result.set(pattern.compilerNode, candidate.compilerNode);
  const candidateFields = new Map(candidate.fields.map((field) => [field.name, field]));
  if (candidate.fields.some((field) => !pattern.fields.some((expected) => expected.name === field.name))) {
    return undefined;
  }
  for (const field of pattern.fields) {
    const actual = candidateFields.get(field.name);
    if (!field.collection) {
      const child = field.nodes[0];
      if (!child || ignored.has(child)) continue;
      if (!actual || actual.collection || actual.nodes.length !== 1) return undefined;
      const nested = alignNode(child, actual.nodes[0], ignored, strictness, result);
      if (!nested) return undefined;
      replaceMap(result, nested);
      continue;
    }
    if (field.nodes.length === 0) {
      if (!actual || !actual.collection || actual.nodes.length !== 0) return undefined;
      continue;
    }
    if (field.nodes.every((node) => ignored.has(node))) continue;
    if (!actual?.collection) return undefined;
    const nested = alignCollection(field.nodes, actual.nodes, ignored, strictness, result);
    if (!nested) return undefined;
    replaceMap(result, nested);
  }
  return result;
}

function alignCollection(
  pattern: AstNodeModel[],
  candidate: AstNodeModel[],
  ignored: Set<AstNodeModel>,
  strictness: AstXPathStrictness,
  seed: Map<ts.Node, ts.Node>,
): Map<ts.Node, ts.Node> | undefined {
  const walk = (
    patternIndex: number,
    candidateIndex: number,
    mapping: Map<ts.Node, ts.Node>,
  ): Map<ts.Node, ts.Node> | undefined => {
    if (patternIndex >= pattern.length) {
      return candidateIndex === candidate.length ? mapping : undefined;
    }
    if (ignored.has(pattern[patternIndex])) {
      while (patternIndex < pattern.length && ignored.has(pattern[patternIndex])) patternIndex += 1;
      if (patternIndex >= pattern.length) return mapping;
      for (let index = candidateIndex; index < candidate.length; index += 1) {
        const matched = alignNode(pattern[patternIndex], candidate[index], ignored, strictness, mapping);
        if (!matched) continue;
        const completed = walk(patternIndex + 1, index + 1, matched);
        if (completed) return completed;
      }
      return undefined;
    }
    if (candidateIndex >= candidate.length) return undefined;
    const matched = alignNode(pattern[patternIndex], candidate[candidateIndex], ignored, strictness, mapping);
    return matched ? walk(patternIndex + 1, candidateIndex + 1, matched) : undefined;
  };
  return walk(0, 0, new Map(seed));
}

function semanticallyEquivalent(
  root: AstNodeModel,
  mapping: Map<ts.Node, ts.Node>,
  checker: ts.TypeChecker,
  cwd: string,
  strictness: AstXPathStrictness,
): boolean {
  for (const [expected, actual] of mapping) {
    if (!symbolsEquivalent(expected, actual, root.compilerNode, mapping, checker, cwd)) return false;
    if (!typesEquivalent(expected, actual, checker, strictness)) return false;
    if (!signaturesEquivalent(expected, actual, root.compilerNode, mapping, checker, cwd)) return false;
  }
  return true;
}

function symbolsEquivalent(
  expected: ts.Node,
  actual: ts.Node,
  root: ts.Node,
  mapping: Map<ts.Node, ts.Node>,
  checker: ts.TypeChecker,
  cwd: string,
): boolean {
  const expectedSymbol = resolvedSymbol(checker.getSymbolAtLocation(expected), checker);
  if (!expectedSymbol) return true;
  const actualSymbol = resolvedSymbol(checker.getSymbolAtLocation(actual), checker);
  if (!actualSymbol) return false;
  const expectedDeclarations = expectedSymbol.declarations ?? [];
  const internal = expectedDeclarations.filter((declaration) => nodeWithinCompilerNode(declaration, root));
  if (internal.length > 0) {
    return internal.some((declaration) => {
      const mapped = mapping.get(declaration);
      return mapped !== undefined && (actualSymbol.declarations ?? []).includes(mapped as ts.Declaration);
    });
  }
  return declarationKeys(expectedDeclarations, cwd).join("|") ===
    declarationKeys(actualSymbol.declarations ?? [], cwd).join("|");
}

function typesEquivalent(
  expected: ts.Node,
  actual: ts.Node,
  checker: ts.TypeChecker,
  strictness: AstXPathStrictness,
): boolean {
  if (!isTypeEligible(expected) || !isTypeEligible(actual)) return true;
  try {
    let expectedType = checker.getTypeAtLocation(expected);
    let actualType = checker.getTypeAtLocation(actual);
    if (strictness === "shape") {
      expectedType = checker.getBaseTypeOfLiteralType(expectedType);
      actualType = checker.getBaseTypeOfLiteralType(actualType);
    }
    return checker.isTypeAssignableTo(expectedType, actualType) &&
      checker.isTypeAssignableTo(actualType, expectedType);
  } catch {
    return true;
  }
}

function signaturesEquivalent(
  expected: ts.Node,
  actual: ts.Node,
  root: ts.Node,
  mapping: Map<ts.Node, ts.Node>,
  checker: ts.TypeChecker,
  cwd: string,
): boolean {
  if (!isCallLike(expected) || !isCallLike(actual)) return true;
  const expectedDeclaration = checker.getResolvedSignature(expected)?.declaration;
  if (!expectedDeclaration) return true;
  const actualDeclaration = checker.getResolvedSignature(actual)?.declaration;
  if (!actualDeclaration) return false;
  if (nodeWithinCompilerNode(expectedDeclaration, root)) {
    return mapping.get(expectedDeclaration) === actualDeclaration;
  }
  return declarationKey(expectedDeclaration, cwd) === declarationKey(actualDeclaration, cwd);
}

function collectSemanticDiagnostics(
  project: Project,
  sourceFile: SourceFile,
  root: AstNodeModel,
  ignored: Set<AstNodeModel>,
): AstXPathDiagnostic[] {
  const checker = project.getTypeChecker().compilerObject;
  const diagnostics: AstXPathDiagnostic[] = [];
  const visit = (node: AstNodeModel): void => {
    if (ignored.has(node)) return;
    if (ts.isIdentifier(node.compilerNode) && !checker.getSymbolAtLocation(node.compilerNode)) {
      diagnostics.push({
        code: "unresolved-symbol",
        message: `No symbol resolved for ${node.compilerNode.getText(sourceFile.compilerNode)}.`,
        kind: node.kind,
        range: rangeForNode(sourceFile.compilerNode, node.compilerNode),
      });
    }
    if (isCallLike(node.compilerNode) && !checker.getResolvedSignature(node.compilerNode)) {
      diagnostics.push({
        code: "unresolved-signature",
        message: "No call signature resolved for this node.",
        kind: node.kind,
        range: rangeForNode(sourceFile.compilerNode, node.compilerNode),
      });
    }
    for (const field of node.fields) for (const child of field.nodes) visit(child);
  };
  visit(root);
  return diagnostics;
}

function selectSourceFiles(
  project: Project,
  cwd: string,
  options: MatchAstXPathPatternOptions,
): SourceFile[] {
  const globs = options.sourceGlobs ?? [];
  const excludes = options.excludePathIncludes ?? [];
  return project.getSourceFiles().filter((sourceFile) => {
    const absolute = normalizePath(sourceFile.getFilePath());
    const relative = relativePath(cwd, absolute);
    if (absolute.includes("/node_modules/")) return false;
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(absolute)) return false;
    if (!options.includeDeclarations && sourceFile.isDeclarationFile()) return false;
    if (excludes.some((part) => absolute.includes(part) || relative.includes(part))) return false;
    return globs.length === 0 || globs.some((glob) => {
      const target = path.isAbsolute(glob) ? absolute : relative;
      return globToRegExp(normalizePath(glob)).test(target);
    });
  });
}

function validatePattern(value: unknown): asserts value is AstXPathPattern {
  if (!value || typeof value !== "object") throw new Error("invalid AST XPath pattern: expected an object");
  const pattern = value as Record<string, unknown>;
  if ((pattern.schemaVersion !== AST_XPATH_PATTERN_SCHEMA_VERSION &&
       pattern.schemaVersion !== AST_XPATH_LEGACY_PATTERN_SCHEMA_VERSION) ||
      pattern.xmlSchemaVersion !== AST_XPATH_XML_SCHEMA_VERSION || pattern.xpathVersion !== AST_XPATH_VERSION) {
    throw new Error("unsupported AST XPath pattern or XML schema version");
  }
  if (pattern.strictness !== "exact" && pattern.strictness !== "shape") {
    throw new Error("invalid AST XPath pattern strictness");
  }
  if (!pattern.project || !pattern.example || typeof pattern.xpath !== "string" || !Array.isArray(pattern.ignored)) {
    throw new Error("invalid AST XPath pattern: missing required fields");
  }
  try {
    const document = new slimdom.Document();
    document.appendChild(document.createElement("ast"));
    evaluateXPathToNodes(pattern.xpath, document);
  } catch (error) {
    throw new Error(`invalid AST XPath expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (pattern.schemaVersion === AST_XPATH_PATTERN_SCHEMA_VERSION) {
    const ids = new Set<string>();
    validateTemplateNode(pattern.template, ids);
    if (!pattern.semantics || typeof pattern.semantics !== "object" || Array.isArray(pattern.semantics)) {
      throw new Error("invalid AST XPath pattern: missing portable semantic manifest");
    }
    const policy = pattern.semanticPolicy as Record<string, unknown> | undefined;
    if (!policy || policy.mode !== "portable-binding-aware" || policy.typeRelation !== "mutually-assignable" ||
        policy.unavailable !== "structural") {
      throw new Error("invalid AST XPath pattern: unsupported portable semantic policy");
    }
    for (const [id, fact] of Object.entries(pattern.semantics as Record<string, unknown>)) {
      if (!ids.has(id) || !fact || typeof fact !== "object" || Array.isArray(fact)) {
        throw new Error(`invalid AST XPath semantic fact: ${id}`);
      }
      const semantic = fact as Record<string, unknown>;
      if (semantic.typeText !== undefined && typeof semantic.typeText !== "string") {
        throw new Error(`invalid AST XPath semantic type fact: ${id}`);
      }
      if (semantic.binding !== undefined) validateBindingFact(semantic.binding, id);
      if (semantic.signature !== undefined) {
        if (!semantic.signature || typeof semantic.signature !== "object" || Array.isArray(semantic.signature)) {
          throw new Error(`invalid AST XPath signature fact: ${id}`);
        }
        const signature = semantic.signature as Record<string, unknown>;
        if (!Number.isInteger(signature.overloadIndex) || (signature.overloadIndex as number) < 0) {
          throw new Error(`invalid AST XPath signature fact: ${id}`);
        }
        validateBindingFact(signature.target, id);
        if (signature.parameters !== undefined) {
          if (!Array.isArray(signature.parameters)) throw new Error(`invalid AST XPath signature fact: ${id}`);
          for (const parameter of signature.parameters) {
            if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
              throw new Error(`invalid AST XPath signature parameter: ${id}`);
            }
            const record = parameter as Record<string, unknown>;
            if (typeof record.typeText !== "string" || typeof record.optional !== "boolean" ||
                typeof record.rest !== "boolean") {
              throw new Error(`invalid AST XPath signature parameter: ${id}`);
            }
          }
        }
        if (signature.returnTypeText !== undefined && typeof signature.returnTypeText !== "string") {
          throw new Error(`invalid AST XPath signature fact: ${id}`);
        }
      }
    }
  }
}

function validateBindingFact(value: unknown, id: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid AST XPath binding fact: ${id}`);
  }
  const binding = value as Record<string, unknown>;
  if (binding.kind === "internal") {
    if (typeof binding.group !== "string" || !binding.group) {
      throw new Error(`invalid AST XPath binding fact: ${id}`);
    }
    return;
  }
  if (binding.kind !== "external" || !Array.isArray(binding.identities) || binding.identities.length === 0) {
    throw new Error(`invalid AST XPath binding fact: ${id}`);
  }
  for (const identity of binding.identities) {
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
      throw new Error(`invalid AST XPath symbol identity: ${id}`);
    }
    const record = identity as Record<string, unknown>;
    if ((record.scope !== "package" && record.scope !== "project" && record.scope !== "typescript-lib") ||
        typeof record.module !== "string" || typeof record.declarationPath !== "string" ||
        typeof record.declarationKind !== "string") {
      throw new Error(`invalid AST XPath symbol identity: ${id}`);
    }
  }
}

function validateTemplateNode(value: unknown, ids: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid AST XPath pattern: malformed portable template node");
  }
  const node = value as Record<string, unknown>;
  if (node.kind !== "node" || typeof node.id !== "string" || !node.id || ids.has(node.id) ||
      typeof node.syntaxKind !== "string" || !Array.isArray(node.fields)) {
    throw new Error("invalid AST XPath pattern: malformed portable template node");
  }
  ids.add(node.id);
  for (const rawField of node.fields) {
    if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) {
      throw new Error(`invalid AST XPath template field on ${node.id}`);
    }
    const field = rawField as Record<string, unknown>;
    if (typeof field.name !== "string" || typeof field.collection !== "boolean" || !Array.isArray(field.children)) {
      throw new Error(`invalid AST XPath template field on ${node.id}`);
    }
    for (const child of field.children) {
      if (child && typeof child === "object" && !Array.isArray(child) &&
          (child as Record<string, unknown>).kind === "gap") {
        if (!field.collection) throw new Error(`invalid AST XPath gap in fixed field ${field.name}`);
      } else {
        validateTemplateNode(child, ids);
      }
    }
  }
}

function validateAnchors(pattern: AstXPathPatternV1, cwd: string, configPath: string): void {
  if (pattern.project.typescriptVersion !== ts.version) {
    throw new Error(`TypeScript version drift: pattern uses ${pattern.project.typescriptVersion}, runtime uses ${ts.version}`);
  }
  if (!fs.existsSync(configPath) || sha256(fs.readFileSync(configPath)) !== pattern.project.tsconfigSha256) {
    throw new Error(`tsconfig hash mismatch: ${relativePath(cwd, configPath)}`);
  }
  const examplePath = path.resolve(cwd, pattern.example.filePath);
  if (!fs.existsSync(examplePath) || sha256(fs.readFileSync(examplePath)) !== pattern.example.sourceSha256) {
    throw new Error(`example source hash mismatch: ${pattern.example.filePath}`);
  }
}

function validateResolvedPattern(pattern: AstXPathPatternV1, resolved: ResolvedExample): void {
  if (sha256(stableJson(resolved.project.getCompilerOptions())) !== pattern.project.compilerOptionsSha256) {
    throw new Error("resolved compiler options hash mismatch");
  }
  if (resolved.root.kind !== pattern.example.root.kind ||
      resolved.root.start !== pattern.example.root.startOffset ||
      resolved.root.end !== pattern.example.root.endOffset) {
    throw new Error("example root no longer matches the generated pattern");
  }
  const actual = resolved.ignoredRanges.map(({ marker, startOffset, endOffset }) => ({ marker, startOffset, endOffset }));
  const expected = pattern.ignored.map(({ marker, startOffset, endOffset }) => ({ marker, startOffset, endOffset }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("example ignore markers no longer match the generated pattern");
  }
}

function matchRecord(sourceFile: ts.SourceFile, node: ts.Node, cwd: string): AstXPathMatch {
  const startOffset = node.getStart(sourceFile, false);
  const endOffset = node.end;
  return {
    filePath: relativePath(cwd, sourceFile.fileName),
    kind: syntaxKindName(node.kind),
    start: location(sourceFile, startOffset),
    end: location(sourceFile, endOffset),
    startOffset,
    endOffset,
    text: sourceFile.text.slice(startOffset, endOffset),
  };
}

function rangeForNode(sourceFile: ts.SourceFile, node: ts.Node): AstXPathRange {
  return rangeForOffsets(sourceFile, node.getStart(sourceFile, false), node.end);
}

function rangeForOffsets(sourceFile: ts.SourceFile, startOffset: number, endOffset: number): AstXPathRange {
  return {
    startOffset,
    endOffset,
    start: location(sourceFile, startOffset),
    end: location(sourceFile, endOffset),
  };
}

function location(sourceFile: ts.SourceFile, offset: number): AstXPathLocation {
  const point = sourceFile.getLineAndCharacterOfPosition(offset);
  return { line: point.line + 1, column: point.character + 1 };
}

function markerError(sourceFile: ts.SourceFile, marker: Marker, message: string): Error {
  const point = location(sourceFile, marker.start);
  return new Error(`${sourceFile.fileName}:${point.line}:${point.column}: ${message}`);
}

function stableNodeValue(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  const name = syntaxKindName(node.kind);
  const text = (node as ts.Node & { text?: unknown }).text;
  if (typeof text === "string" && /(?:Literal|Template|JsxText)/.test(name)) return text;
  return undefined;
}

function isJSDocNode(node: ts.Node): boolean {
  return syntaxKindName(node.kind).startsWith("JSDoc");
}

function isTokenNode(node: ts.Node): boolean {
  return node.kind >= ts.SyntaxKind.FirstToken && node.kind <= ts.SyntaxKind.LastToken;
}

function safeStart(node: ts.Node): number {
  try {
    return node.getStart(node.getSourceFile(), false);
  } catch {
    return node.pos;
  }
}

function syntaxKindName(kind: ts.SyntaxKind): string {
  const debug = (ts as typeof ts & {
    Debug?: { formatSyntaxKind?: (value: ts.SyntaxKind) => string };
  }).Debug;
  return debug?.formatSyntaxKind?.(kind) ?? ts.SyntaxKind[kind] ?? String(kind);
}

function isWithin(node: AstNodeModel, parent: AstNodeModel): boolean {
  return node.start >= parent.start && node.end <= parent.end;
}

function nodeWithinCompilerNode(node: ts.Node, parent: ts.Node): boolean {
  return node.getSourceFile() === parent.getSourceFile() && node.pos >= parent.pos && node.end <= parent.end;
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function declarationKeys(declarations: readonly ts.Declaration[], cwd: string): string[] {
  return declarations.map((declaration) => declarationKey(declaration, cwd)).sort();
}

function declarationKey(declaration: ts.Declaration, cwd: string): string {
  return `${relativePath(cwd, declaration.getSourceFile().fileName)}:${declaration.pos}:${declaration.end}:${syntaxKindName(declaration.kind)}`;
}

function isTypeEligible(node: ts.Node): boolean {
  return ts.isExpression(node) || ts.isIdentifier(node) || ts.isTypeNode(node);
}

function isCallLike(node: ts.Node): node is ts.CallLikeExpression {
  return ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) ||
    ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node);
}

function replaceMap(target: Map<ts.Node, ts.Node>, source: Map<ts.Node, ts.Node>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  const parts = value.split("'");
  return `concat(${parts.map((part, index) =>
    `${index > 0 ? `"'", ` : ""}'${part}'`
  ).join(", ")})`;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function relativePath(cwd: string, value: string): string {
  const relative = path.relative(cwd, value);
  return normalizePath(relative || path.basename(value));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
