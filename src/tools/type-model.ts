import path from "node:path";
import { generateDtsBundle } from "dts-bundle-generator";
import {
  Node,
  Project,
  Symbol as MorphSymbol,
  SyntaxKind,
  type Diagnostic,
  type SourceFile,
  ts,
} from "ts-morph";

export type TypeModelScope = "exports" | "all";
export type TypeModelTypeRef = string;
export type TypeModelSymbolRef = string;
export type TypeModelSignatureRef = string;
export type TypeModelCallSiteRef = string;
export type TypeModelCallSiteKind =
  | "call"
  | "new"
  | "taggedTemplate"
  | "decorator"
  | "jsx"
  | "instanceof";

export interface ExtractTypeModelOptions {
  sourceGlob: string | string[];
  tsConfigFilePath?: string;
  excludePathIncludes?: string[];
  scope?: TypeModelScope;
  includeCallSites?: boolean;
  /**
   * Include a standalone declaration bundle for every selected source module.
   * This is opt-in because declaration bundling can substantially increase
   * extraction time and serialized model size.
   */
  includeDeclarationBundles?: boolean;
  cwd?: string;
}

export interface TypeModelLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface TypeModelJSDocComment {
  location: TypeModelLocation;
  text: string;
}

export interface TypeModelDiagnostic {
  source: "typescript" | "type-model";
  category: "error" | "warning" | "suggestion" | "message";
  code: string | number;
  message: string;
  location?: TypeModelLocation;
  typeId?: TypeModelTypeRef;
  callSiteId?: TypeModelCallSiteRef;
}

export interface TypeModelExport {
  name: string;
  symbolId: TypeModelSymbolRef;
  targetSymbolId: TypeModelSymbolRef;
}

export interface TypeModelModuleBase {
  id: string;
  filePath: string;
  roots: TypeModelSymbolRef[];
  exports: TypeModelExport[];
  callSites: TypeModelCallSiteRef[];
}

export type TypeModelDeclarationBundle =
  | {
      format: "d.ts";
      status: "generated";
      text: string;
    }
  | {
      format: "d.ts";
      status: "failed";
      diagnosticCode: "declaration-bundle-failed";
    };

export interface TypeModelModuleV2 extends TypeModelModuleBase {
  declarationBundle?: never;
}

export interface TypeModelModuleV3 extends TypeModelModuleBase {
  declarationBundle: TypeModelDeclarationBundle;
}

export type TypeModelModule = TypeModelModuleV2 | TypeModelModuleV3;

export interface TypeModelSymbol {
  id: TypeModelSymbolRef;
  name: string;
  qualifiedName: string;
  kind: string;
  flags: string[];
  external: boolean;
  declarations: TypeModelLocation[];
  jsDoc?: TypeModelJSDocComment[];
  aliasTarget?: TypeModelSymbolRef;
  declaredType?: TypeModelTypeRef;
  valueType?: TypeModelTypeRef;
}

export interface TypeModelTypeParameter {
  name: string;
  type: TypeModelTypeRef;
  constraint?: TypeModelTypeRef;
  default?: TypeModelTypeRef;
}

export interface TypeModelParameter {
  name: string;
  type: TypeModelTypeRef;
  optional: boolean;
  rest: boolean;
  annotation: "explicit" | "inferred";
  location?: TypeModelLocation;
}

export interface TypeModelSignature {
  id: TypeModelSignatureRef;
  kind: "call" | "construct";
  declaration?: TypeModelLocation;
  jsDoc?: TypeModelJSDocComment[];
  typeParameters: TypeModelTypeParameter[];
  thisParameter?: TypeModelParameter;
  parameters: TypeModelParameter[];
  returnType: TypeModelTypeRef;
  returnAnnotation: "explicit" | "inferred";
}

export interface TypeModelProperty {
  name: string;
  type: TypeModelTypeRef;
  optional: boolean;
  readonly: boolean;
  declarations: TypeModelLocation[];
  jsDoc?: TypeModelJSDocComment[];
}

export interface TypeModelTupleElement {
  type: TypeModelTypeRef;
  label?: string;
  optional: boolean;
  rest: boolean;
}

export type TypeModelMappedModifier = "add" | "remove" | "preserve";

export interface TypeModelGenericBinding {
  parameterName: string;
  parameterType: TypeModelTypeRef;
  type: TypeModelTypeRef;
  source: "explicit" | "inferred";
}

export interface TypeModelGenericInstantiation {
  complete: boolean;
  bindings: TypeModelGenericBinding[];
}

export interface TypeModelCallSite {
  id: TypeModelCallSiteRef;
  kind: TypeModelCallSiteKind;
  location: TypeModelLocation;
  resolution: "resolved" | "unresolved";
  resultType: TypeModelTypeRef;
  calleeSymbolId?: TypeModelSymbolRef;
  declarationSignatureId?: TypeModelSignatureRef;
  resolvedSignatureId?: TypeModelSignatureRef;
  genericInstantiation?: TypeModelGenericInstantiation;
}

export interface TypeModelTypeBase {
  id: TypeModelTypeRef;
  displayText: string;
  flags: string[];
  aliasSymbolId?: TypeModelSymbolRef;
  aliasTypeArguments?: TypeModelTypeRef[];
}

export interface TypeModelConditionalType extends TypeModelTypeBase {
  kind: "conditional";
  checkType: TypeModelTypeRef;
  extendsType: TypeModelTypeRef;
  trueType: TypeModelTypeRef;
  falseType: TypeModelTypeRef;
  distributive: boolean;
  inferTypeParameters: TypeModelTypeRef[];
}

export interface TypeModelMappedType extends TypeModelTypeBase {
  kind: "mapped";
  typeParameter: TypeModelTypeParameter;
  constraint: TypeModelTypeRef;
  nameType?: TypeModelTypeRef;
  valueType: TypeModelTypeRef;
  readonlyModifier: TypeModelMappedModifier;
  optionalModifier: TypeModelMappedModifier;
}

export interface TypeModelIndexedAccessType extends TypeModelTypeBase {
  kind: "indexedAccess";
  objectType: TypeModelTypeRef;
  indexType: TypeModelTypeRef;
}

export interface TypeModelKeyofType extends TypeModelTypeBase {
  kind: "keyof";
  type: TypeModelTypeRef;
}

export interface TypeModelTemplateLiteralType extends TypeModelTypeBase {
  kind: "templateLiteral";
  texts: string[];
  types: TypeModelTypeRef[];
}

export interface TypeModelStringMappingType extends TypeModelTypeBase {
  kind: "stringMapping";
  operation: string;
  type: TypeModelTypeRef;
}

export interface TypeModelSubstitutionType extends TypeModelTypeBase {
  kind: "substitution";
  baseType: TypeModelTypeRef;
  constraint: TypeModelTypeRef;
}

export type TypeModelResolvedType =
  | (TypeModelTypeBase & { kind: "intrinsic"; name: string })
  | (TypeModelTypeBase & {
      kind: "literal";
      value: string | number | boolean;
      valueKind: "string" | "number" | "bigint" | "boolean";
    })
  | (TypeModelTypeBase & { kind: "union" | "intersection"; types: TypeModelTypeRef[] })
  | (TypeModelTypeBase & {
      kind: "typeParameter";
      name: string;
      constraint?: TypeModelTypeRef;
      default?: TypeModelTypeRef;
    })
  | (TypeModelTypeBase & {
      kind: "array";
      elementType: TypeModelTypeRef;
      readonly: boolean;
    })
  | (TypeModelTypeBase & {
      kind: "tuple";
      elements: TypeModelTupleElement[];
      readonly: boolean;
    })
  | (TypeModelTypeBase & {
      kind: "reference";
      symbolId: TypeModelSymbolRef;
      typeArguments: TypeModelTypeRef[];
      target: TypeModelTypeRef;
    })
  | (TypeModelTypeBase & {
      kind: "external";
      symbolId: TypeModelSymbolRef;
      typeArguments: TypeModelTypeRef[];
    })
  | TypeModelConditionalType
  | TypeModelMappedType
  | TypeModelIndexedAccessType
  | TypeModelKeyofType
  | TypeModelTemplateLiteralType
  | TypeModelStringMappingType
  | TypeModelSubstitutionType
  | (TypeModelTypeBase & {
      kind: "object";
      symbolId?: TypeModelSymbolRef;
      properties: TypeModelProperty[];
      callSignatures: TypeModelSignatureRef[];
      constructSignatures: TypeModelSignatureRef[];
      stringIndexType?: TypeModelTypeRef;
      numberIndexType?: TypeModelTypeRef;
    })
  | (TypeModelTypeBase & { kind: "unsupported"; reason: string });

export interface TypeModelProject {
  typescriptVersion: string;
  tsconfigPath: string;
  scope: TypeModelScope;
  includeCallSites: boolean;
  sourceGlobs: string[];
  selectedFiles: string[];
}

interface TypeModelTables {
  roots: TypeModelSymbolRef[];
  symbols: Record<TypeModelSymbolRef, TypeModelSymbol>;
  types: Record<TypeModelTypeRef, TypeModelResolvedType>;
  signatures: Record<TypeModelSignatureRef, TypeModelSignature>;
  callSites: Record<TypeModelCallSiteRef, TypeModelCallSite>;
  diagnostics: TypeModelDiagnostic[];
}

export interface TypeModelV2 extends TypeModelTables {
  schemaVersion: "2";
  project: TypeModelProject;
  modules: TypeModelModuleV2[];
}

export interface TypeModelV3 extends TypeModelTables {
  schemaVersion: "3";
  project: TypeModelProject & { includeDeclarationBundles: true };
  modules: TypeModelModuleV3[];
}

export type TypeModel = TypeModelV2 | TypeModelV3;

type SignatureKind = TypeModelSignature["kind"];
type SerializationMode = "normal" | "shape";

interface InternalTypeParameter extends ts.TypeParameter {
  constraint?: ts.Type;
  default?: ts.Type;
}

interface InternalSignature extends ts.Signature {
  target?: InternalSignature;
  mapper?: InternalTypeMapper;
}

interface InternalTypeMapper {
  kind: number;
  source?: ts.Type;
  target?: ts.Type;
  sources?: readonly ts.Type[];
  targets?: readonly (ts.Type | (() => ts.Type))[];
  func?: (type: ts.Type) => ts.Type;
  mapper1?: InternalTypeMapper;
  mapper2?: InternalTypeMapper;
}

interface MutableContext {
  projectRoot: string;
  tsConfigFilePath: string;
  sourceGlobs: string[];
  scope: TypeModelScope;
  includeCallSites: boolean;
  project: Project;
  checker: ts.TypeChecker;
  symbols: Map<string, TypeModelSymbol>;
  types: Map<string, TypeModelResolvedType>;
  signatures: Map<string, TypeModelSignature>;
  callSites: Map<string, TypeModelCallSite>;
  diagnostics: TypeModelDiagnostic[];
  symbolIds: WeakMap<object, string>;
  normalTypeIds: WeakMap<object, string>;
  shapeTypeIds: WeakMap<object, string>;
  callSignatureIds: WeakMap<object, string>;
  constructSignatureIds: WeakMap<object, string>;
  nextTypeId: number;
  nextSignatureId: number;
}

const NAMED_TYPE_FLAGS =
  ts.SymbolFlags.Class |
  ts.SymbolFlags.Interface |
  ts.SymbolFlags.TypeAlias |
  ts.SymbolFlags.Enum |
  ts.SymbolFlags.RegularEnum |
  ts.SymbolFlags.ConstEnum;

const TYPE_FORMAT_FLAGS =
  ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.WriteArrowStyleSignature;

export function extractTypeModel(
  options: ExtractTypeModelOptions & { includeDeclarationBundles: true },
): TypeModelV3;
export function extractTypeModel(
  options: ExtractTypeModelOptions & { includeDeclarationBundles?: false },
): TypeModelV2;
export function extractTypeModel(options: ExtractTypeModelOptions): TypeModel;
export function extractTypeModel(options: ExtractTypeModelOptions): TypeModel {
  const sourceGlobs = asArray(options.sourceGlob);
  if (sourceGlobs.length === 0) throw new Error("At least one source glob is required.");
  const scope = options.scope ?? "exports";
  if (scope !== "exports" && scope !== "all") {
    throw new Error(`Invalid type-model scope: ${scope}`);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const tsConfigFilePath = path.resolve(cwd, options.tsConfigFilePath ?? "tsconfig.json");
  const projectRoot = path.dirname(tsConfigFilePath);
  const project = new Project({ tsConfigFilePath });
  const selectedFiles = selectSourceFiles(project, cwd, sourceGlobs, options.excludePathIncludes ?? []);
  const context: MutableContext = {
    projectRoot,
    tsConfigFilePath,
    sourceGlobs,
    scope,
    includeCallSites: options.includeCallSites ?? false,
    project,
    checker: project.getTypeChecker().compilerObject,
    symbols: new Map(),
    types: new Map(),
    signatures: new Map(),
    callSites: new Map(),
    diagnostics: project.getPreEmitDiagnostics().map((diagnostic) =>
      serializeCompilerDiagnostic(diagnostic, projectRoot)
    ),
    symbolIds: new WeakMap(),
    normalTypeIds: new WeakMap(),
    shapeTypeIds: new WeakMap(),
    callSignatureIds: new WeakMap(),
    constructSignatureIds: new WeakMap(),
    nextTypeId: 1,
    nextSignatureId: 1,
  };

  const modules = selectedFiles.map((sourceFile) => serializeModule(context, sourceFile));
  if (context.includeCallSites) {
    for (let index = 0; index < selectedFiles.length; index += 1) {
      modules[index].callSites = serializeSourceFileCallSites(context, selectedFiles[index]);
    }
  }
  const roots = [...new Set(modules.flatMap((module) => module.roots))].sort();

  const projectModel: TypeModelProject = {
    typescriptVersion: ts.version,
    tsconfigPath: normalizePath(path.relative(projectRoot, tsConfigFilePath) || path.basename(tsConfigFilePath)),
    scope,
    includeCallSites: context.includeCallSites,
    sourceGlobs: sourceGlobs.map((glob) => sanitizeText(glob, projectRoot)).sort(),
    selectedFiles: selectedFiles.map((sourceFile) => projectPath(context, sourceFile.getFilePath())),
  };
  const tables: TypeModelTables = {
    roots,
    symbols: sortedRecord(context.symbols),
    types: sortedRecord(context.types),
    signatures: sortedRecord(context.signatures),
    callSites: sortedRecord(context.callSites),
    diagnostics: context.diagnostics.sort(compareDiagnostics),
  };

  if (options.includeDeclarationBundles) {
    const bundledModules = modules.map((module, index): TypeModelModuleV3 => ({
      ...module,
      declarationBundle: createDeclarationBundle(context, selectedFiles[index]),
    }));
    tables.diagnostics.sort(compareDiagnostics);
    return {
      schemaVersion: "3",
      project: { ...projectModel, includeDeclarationBundles: true },
      modules: bundledModules.sort((left, right) => left.filePath.localeCompare(right.filePath)),
      ...tables,
    };
  }

  return {
    schemaVersion: "2",
    project: projectModel,
    modules: modules.sort((left, right) => left.filePath.localeCompare(right.filePath)),
    ...tables,
  };
}

function createDeclarationBundle(
  context: MutableContext,
  sourceFile: SourceFile,
): TypeModelDeclarationBundle {
  try {
    const [text] = generateDtsBundle([
      {
        filePath: sourceFile.getFilePath(),
        output: {
          exportReferencedTypes: false,
          noBanner: true,
          sortNodes: true,
        },
      },
    ], {
      preferredConfigPath: context.tsConfigFilePath,
    });
    if (!text?.trim()) {
      throw new Error("Declaration bundler returned empty output");
    }
    return {
      format: "d.ts",
      status: "generated",
      text: normalizeGeneratedText(text),
    };
  } catch (error) {
    context.diagnostics.push({
      source: "type-model",
      category: "warning",
      code: "declaration-bundle-failed",
      message: `Could not generate declaration bundle for ${projectPath(context, sourceFile.getFilePath())}: ${sanitizeText(errorMessage(error), context.projectRoot)}`,
      location: {
        filePath: projectPath(context, sourceFile.getFilePath()),
        line: 1,
        column: 1,
      },
    });
    return {
      format: "d.ts",
      status: "failed",
      diagnosticCode: "declaration-bundle-failed",
    };
  }
}

function normalizeGeneratedText(text: string): string {
  return `${text.replace(/\r\n?/g, "\n").trim()}\n`;
}

function selectSourceFiles(project: Project, cwd: string, globs: string[], exclusions: string[]): SourceFile[] {
  const selected = new Map<string, SourceFile>();
  for (const glob of globs) {
    const pattern = path.isAbsolute(glob) ? glob : path.resolve(cwd, glob);
    const matches = project.addSourceFilesAtPaths(pattern).filter((sourceFile) =>
      !exclusions.some((fragment) => sourceFile.getFilePath().includes(fragment))
    );
    if (matches.length === 0) throw new Error(`No source files matched source glob: ${glob}`);
    for (const sourceFile of matches) selected.set(sourceFile.getFilePath(), sourceFile);
  }
  return [...selected.values()].sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));
}

function serializeModule(context: MutableContext, sourceFile: SourceFile): TypeModelModuleV2 {
  const filePath = projectPath(context, sourceFile.getFilePath());
  const exportSymbols = sourceFile.getExportSymbols().map((symbol) => symbol.compilerSymbol)
    .sort(compareCompilerSymbols);
  const exports = exportSymbols.map((symbol): TypeModelExport => {
    const target = resolveAliasedSymbol(context, symbol);
    return {
      name: symbol.getName(),
      symbolId: serializeSymbol(context, symbol),
      targetSymbolId: serializeSymbol(context, target),
    };
  }).sort((left, right) => left.name.localeCompare(right.name) || left.symbolId.localeCompare(right.symbolId));

  const rootSymbols = context.scope === "exports" ? exportSymbols : getAllRootSymbols(sourceFile);
  const roots = [...new Set(rootSymbols.map((symbol) => serializeSymbol(context, symbol)))].sort();
  return { id: `module:${filePath}`, filePath, roots, exports, callSites: [] };
}

function getAllRootSymbols(sourceFile: SourceFile): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];
  const add = (symbol: MorphSymbol | undefined): void => {
    if (symbol) symbols.push(symbol.compilerSymbol);
  };
  for (const declaration of [
    ...sourceFile.getFunctions(), ...sourceFile.getClasses(), ...sourceFile.getInterfaces(),
    ...sourceFile.getTypeAliases(), ...sourceFile.getEnums(), ...sourceFile.getModules(),
  ]) add(declaration.getSymbol());
  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      add(declaration.getSymbol());
      for (const binding of declaration.getDescendantsOfKind(SyntaxKind.BindingElement)) add(binding.getSymbol());
    }
  }
  add(sourceFile.getDefaultExportSymbol());
  return dedupeCompilerSymbols(symbols).sort(compareCompilerSymbols);
}

function serializeSymbol(context: MutableContext, symbol: ts.Symbol): string {
  const existing = context.symbolIds.get(symbol);
  if (existing) return existing;

  const declarations = sortCompilerDeclarations(symbol.declarations ?? []);
  const external = isExternalSymbol(context, symbol);
  const id = createSymbolId(context, symbol, declarations, external);
  context.symbolIds.set(symbol, id);
  const jsDoc = rawJsDoc(context, declarations);
  const model: TypeModelSymbol = {
    id,
    name: symbol.getName(),
    qualifiedName: sanitizeText(safeQualifiedName(context, symbol), context.projectRoot),
    kind: primarySymbolKind(symbol),
    flags: enumFlagNames(ts.SymbolFlags, symbol.flags),
    external,
    declarations: declarations.map((declaration) => locationFor(context, declaration)),
    ...(jsDoc.length > 0 ? { jsDoc } : {}),
  };
  context.symbols.set(id, model);

  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const target = resolveAliasedSymbol(context, symbol);
    if (target !== symbol) model.aliasTarget = serializeSymbol(context, target);
    return id;
  }
  if (external) return id;

  if ((symbol.flags & NAMED_TYPE_FLAGS) !== 0) {
    try {
      model.declaredType = serializeType(context, context.checker.getDeclaredTypeOfSymbol(symbol), declarations[0]);
    } catch (error) {
      addExtractionDiagnostic(context, `Could not resolve declared type for ${symbol.getName()}: ${errorMessage(error)}`, declarations[0]);
    }
  }
  if ((symbol.flags & ts.SymbolFlags.Value) !== 0) {
    const location = symbol.valueDeclaration ?? declarations[0];
    if (location) {
      try {
        model.valueType = serializeType(context, context.checker.getTypeOfSymbolAtLocation(symbol, location), location);
      } catch (error) {
        addExtractionDiagnostic(context, `Could not resolve value type for ${symbol.getName()}: ${errorMessage(error)}`, location);
      }
    }
  }
  return id;
}

function serializeType(
  context: MutableContext,
  type: ts.Type,
  enclosingNode?: ts.Node,
  mode: SerializationMode = "normal",
): string {
  const ids = mode === "normal" ? context.normalTypeIds : context.shapeTypeIds;
  const existing = ids.get(type);
  if (existing) return existing;

  const id = `type:${String(context.nextTypeId++).padStart(6, "0")}`;
  ids.set(type, id);
  const displayText = safeTypeText(context, type, enclosingNode);
  const flags = enumFlagNames(ts.TypeFlags, type.flags);
  context.types.set(id, { id, kind: "unsupported", displayText, flags, reason: "pending" });

  const alias = type.aliasSymbol;
  const aliasSymbolId = alias ? serializeSymbol(context, alias) : undefined;
  const aliasArguments = type.aliasTypeArguments ?? [];
  const base: TypeModelTypeBase = {
    id,
    displayText,
    flags,
    ...(aliasSymbolId ? { aliasSymbolId } : {}),
    ...(aliasArguments.length > 0
      ? { aliasTypeArguments: aliasArguments.map((argument) => serializeType(context, argument, enclosingNode)) }
      : {}),
  };

  const namedSymbol = getNamedTypeSymbol(type);
  const underlyingSymbol = type.getSymbol();
  const externalNamedSymbol = mode === "shape" && underlyingSymbol &&
      (underlyingSymbol.flags & NAMED_TYPE_FLAGS) !== 0 &&
      isExternalSymbol(context, underlyingSymbol)
    ? underlyingSymbol
    : namedSymbol && isExternalSymbol(context, namedSymbol)
    ? namedSymbol
    : undefined;
  if (externalNamedSymbol && (type.flags & ts.TypeFlags.StringMapping) === 0) {
    const model: TypeModelResolvedType = {
      ...base,
      kind: "external",
      symbolId: serializeSymbol(context, externalNamedSymbol),
      typeArguments: getTypeArguments(context, type).map((argument) => serializeType(context, argument, enclosingNode)),
    };
    context.types.set(id, model);
    return id;
  }

  let model: TypeModelResolvedType;
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) {
    model = { ...base, kind: "literal", valueKind: "string", value: (type as ts.StringLiteralType).value };
  } else if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) {
    model = { ...base, kind: "literal", valueKind: "number", value: (type as ts.NumberLiteralType).value };
  } else if ((type.flags & ts.TypeFlags.BigIntLiteral) !== 0) {
    model = { ...base, kind: "literal", valueKind: "bigint", value: displayText.replace(/n$/, "") };
  } else if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    model = { ...base, kind: "literal", valueKind: "boolean", value: displayText === "true" };
  } else if (isIntrinsicType(type)) {
    model = { ...base, kind: "intrinsic", name: intrinsicName(type, displayText) };
  } else if ((type.flags & ts.TypeFlags.Union) !== 0) {
    model = {
      ...base,
      kind: "union",
      types: sortTypes(context, (type as ts.UnionType).types, enclosingNode)
        .map((member) => serializeType(context, member, enclosingNode)),
    };
  } else if ((type.flags & ts.TypeFlags.Intersection) !== 0) {
    model = {
      ...base,
      kind: "intersection",
      types: sortTypes(context, (type as ts.IntersectionType).types, enclosingNode)
        .map((member) => serializeType(context, member, enclosingNode)),
    };
  } else if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const parameter = serializeTypeParameter(context, type as ts.TypeParameter, enclosingNode);
    model = {
      ...base,
      kind: "typeParameter",
      name: parameter.name,
      ...(parameter.constraint ? { constraint: parameter.constraint } : {}),
      ...(parameter.default ? { default: parameter.default } : {}),
    };
  } else if (context.checker.isTupleType(type)) {
    model = serializeTupleType(context, type as ts.TupleTypeReference, enclosingNode, base);
  } else if (isArrayType(context, type)) {
    const element = getArrayElementType(context, type);
    model = element
      ? { ...base, kind: "array", elementType: serializeType(context, element, enclosingNode), readonly: isReadonlyArrayType(type) }
      : unsupportedType(context, base, "Array element type was unavailable", enclosingNode);
  } else if ((type.flags & ts.TypeFlags.Conditional) !== 0) {
    model = serializeConditionalType(context, type as ts.ConditionalType, enclosingNode, base);
  } else if ((type.flags & ts.TypeFlags.IndexedAccess) !== 0) {
    const indexed = type as ts.IndexedAccessType;
    model = {
      ...base,
      kind: "indexedAccess",
      objectType: serializeType(context, indexed.objectType, enclosingNode),
      indexType: serializeType(context, indexed.indexType, enclosingNode),
    };
  } else if ((type.flags & ts.TypeFlags.Index) !== 0) {
    model = { ...base, kind: "keyof", type: serializeType(context, (type as ts.IndexType).type, enclosingNode) };
  } else if ((type.flags & ts.TypeFlags.TemplateLiteral) !== 0) {
    const template = type as ts.TemplateLiteralType;
    model = {
      ...base,
      kind: "templateLiteral",
      texts: [...template.texts],
      types: template.types.map((member) => serializeType(context, member, enclosingNode)),
    };
  } else if ((type.flags & ts.TypeFlags.StringMapping) !== 0) {
    const mapping = type as ts.StringMappingType;
    model = { ...base, kind: "stringMapping", operation: mapping.symbol.getName(), type: serializeType(context, mapping.type, enclosingNode) };
  } else if ((type.flags & ts.TypeFlags.Substitution) !== 0) {
    const substitution = type as ts.SubstitutionType;
    model = {
      ...base,
      kind: "substitution",
      baseType: serializeType(context, substitution.baseType, enclosingNode),
      constraint: serializeType(context, substitution.constraint, enclosingNode),
    };
  } else if ((type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0) {
    model = serializeMappedType(context, type as ts.ObjectType, enclosingNode, base);
  } else if (mode === "normal" && namedSymbol) {
    model = {
      ...base,
      kind: "reference",
      symbolId: serializeSymbol(context, namedSymbol),
      typeArguments: getTypeArguments(context, type).map((argument) => serializeType(context, argument, enclosingNode)),
      target: serializeType(context, type, enclosingNode, "shape"),
    };
  } else if ((type.flags & ts.TypeFlags.Object) !== 0) {
    model = serializeObjectType(context, type, enclosingNode, base);
  } else {
    model = unsupportedType(context, base, "Type form is not structurally supported by schema version 2", enclosingNode);
  }

  context.types.set(id, model);
  return id;
}

function serializeConditionalType(
  context: MutableContext,
  type: ts.ConditionalType,
  enclosingNode: ts.Node | undefined,
  base: TypeModelTypeBase,
): TypeModelResolvedType {
  const root = type.root;
  return {
    ...base,
    kind: "conditional",
    checkType: serializeType(context, type.checkType, enclosingNode),
    extendsType: serializeType(context, type.extendsType, enclosingNode),
    trueType: serializeType(context, context.checker.getTypeFromTypeNode(root.node.trueType), root.node.trueType),
    falseType: serializeType(context, context.checker.getTypeFromTypeNode(root.node.falseType), root.node.falseType),
    distributive: root.isDistributive,
    inferTypeParameters: (root.inferTypeParameters ?? []).map((parameter) => serializeType(context, parameter, enclosingNode)),
  };
}

function serializeMappedType(
  context: MutableContext,
  type: ts.ObjectType,
  enclosingNode: ts.Node | undefined,
  base: TypeModelTypeBase,
): TypeModelResolvedType {
  const mapped = type as ts.ObjectType & { declaration?: ts.MappedTypeNode; typeParameter?: ts.TypeParameter };
  const declaration = mapped.declaration;
  if (!declaration || !ts.isMappedTypeNode(declaration)) {
    return unsupportedType(context, base, "Mapped type declaration was unavailable", enclosingNode);
  }
  const parameterType = mapped.typeParameter ?? context.checker.getTypeAtLocation(declaration.typeParameter.name);
  const constraint = declaration.typeParameter.constraint
    ? context.checker.getTypeFromTypeNode(declaration.typeParameter.constraint)
    : undefined;
  if (!constraint) return unsupportedType(context, base, "Mapped type constraint was unavailable", declaration);
  const valueType = declaration.type ? context.checker.getTypeFromTypeNode(declaration.type) : undefined;
  if (!valueType) return unsupportedType(context, base, "Mapped type value was unavailable", declaration);
  return {
    ...base,
    kind: "mapped",
    typeParameter: serializeTypeParameter(context, parameterType, declaration.typeParameter),
    constraint: serializeType(context, constraint, declaration.typeParameter.constraint),
    ...(declaration.nameType
      ? { nameType: serializeType(context, context.checker.getTypeFromTypeNode(declaration.nameType), declaration.nameType) }
      : {}),
    valueType: serializeType(context, valueType, declaration.type),
    readonlyModifier: mappedModifier(declaration.readonlyToken),
    optionalModifier: mappedModifier(declaration.questionToken),
  };
}

function mappedModifier(token: ts.MappedTypeNode["readonlyToken"] | ts.MappedTypeNode["questionToken"]): TypeModelMappedModifier {
  if (!token) return "preserve";
  return token.kind === ts.SyntaxKind.MinusToken ? "remove" : "add";
}

function serializeTupleType(
  context: MutableContext,
  type: ts.TupleTypeReference,
  enclosingNode: ts.Node | undefined,
  base: TypeModelTypeBase,
): TypeModelResolvedType {
  const target = type.target;
  const elementFlags = target.elementFlags ?? [];
  const labels = target.labeledElementDeclarations ?? [];
  const elements = context.checker.getTypeArguments(type);
  return {
    ...base,
    kind: "tuple",
    readonly: Boolean(target.readonly),
    elements: elements.map((element, index) => {
      const flag = elementFlags[index] ?? ts.ElementFlags.Required;
      const labelNode = labels[index]?.name;
      return {
        type: serializeType(context, element, enclosingNode),
        ...(labelNode ? { label: labelNode.getText() } : {}),
        optional: (flag & ts.ElementFlags.Optional) !== 0,
        rest: (flag & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
      };
    }),
  };
}

function serializeObjectType(
  context: MutableContext,
  type: ts.Type,
  enclosingNode: ts.Node | undefined,
  base: TypeModelTypeBase,
): TypeModelResolvedType {
  const symbol = type.getSymbol();
  const properties = context.checker.getPropertiesOfType(type).sort(compareCompilerSymbols)
    .map((property): TypeModelProperty => {
      const declarations = sortCompilerDeclarations(property.declarations ?? []);
      const location = property.valueDeclaration ?? declarations[0] ?? enclosingNode;
      const jsDoc = rawJsDoc(context, declarations);
      const propertyType = location
        ? serializeType(context, context.checker.getTypeOfSymbolAtLocation(property, location), location)
        : createUnsupportedSyntheticType(context, `Property ${property.getName()} has no resolvable declaration`);
      return {
        name: property.getName(),
        type: propertyType,
        optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
        readonly: declarations.some(isReadonlyDeclaration),
        declarations: declarations.map((declaration) => locationFor(context, declaration)),
        ...(jsDoc.length > 0 ? { jsDoc } : {}),
      };
    });
  const calls = sortSignatures(context, context.checker.getSignaturesOfType(type, ts.SignatureKind.Call))
    .map((signature) => serializeSignature(context, signature, "call", enclosingNode));
  const constructs = sortSignatures(context, context.checker.getSignaturesOfType(type, ts.SignatureKind.Construct))
    .map((signature) => serializeSignature(context, signature, "construct", enclosingNode));
  const stringIndex = context.checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const numberIndex = context.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  return {
    ...base,
    kind: "object",
    ...(symbol ? { symbolId: serializeSymbol(context, symbol) } : {}),
    properties,
    callSignatures: calls,
    constructSignatures: constructs,
    ...(stringIndex ? { stringIndexType: serializeType(context, stringIndex, enclosingNode) } : {}),
    ...(numberIndex ? { numberIndexType: serializeType(context, numberIndex, enclosingNode) } : {}),
  };
}

function serializeSignature(
  context: MutableContext,
  signature: ts.Signature,
  kind: SignatureKind,
  fallbackNode?: ts.Node,
): string {
  const ids = kind === "call" ? context.callSignatureIds : context.constructSignatureIds;
  const existing = ids.get(signature);
  if (existing) return existing;
  const id = `signature:${String(context.nextSignatureId++).padStart(6, "0")}`;
  ids.set(signature, id);

  const declaration = signature.declaration;
  context.signatures.set(id, {
    id,
    kind,
    ...(declaration ? { declaration: locationFor(context, declaration) } : {}),
    typeParameters: [],
    parameters: [],
    returnType: "",
    returnAnnotation: hasReturnTypeAnnotation(declaration) ? "explicit" : "inferred",
  });

  const jsDoc = declaration ? rawJsDoc(context, [declaration]) : [];
  const model: TypeModelSignature = {
    id,
    kind,
    ...(declaration ? { declaration: locationFor(context, declaration) } : {}),
    ...(jsDoc.length > 0 ? { jsDoc } : {}),
    typeParameters: (signature.typeParameters ?? []).map((parameter) =>
      serializeTypeParameter(context, parameter, declaration ?? fallbackNode)
    ),
    ...(signature.thisParameter
      ? { thisParameter: serializeParameter(context, signature.thisParameter, declaration ?? fallbackNode) }
      : {}),
    parameters: signature.parameters.map((parameter) => serializeParameter(context, parameter, declaration ?? fallbackNode)),
    returnType: serializeType(context, context.checker.getReturnTypeOfSignature(signature), declaration ?? fallbackNode),
    returnAnnotation: hasReturnTypeAnnotation(declaration) ? "explicit" : "inferred",
  };
  context.signatures.set(id, model);
  return id;
}

function serializeParameter(
  context: MutableContext,
  parameter: ts.Symbol,
  fallbackNode?: ts.Node,
): TypeModelParameter {
  const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
  const location = declaration ?? fallbackNode;
  const type = location
    ? context.checker.getTypeOfSymbolAtLocation(parameter, location)
    : context.checker.getAnyType();
  const parameterDeclaration = declaration && ts.isParameter(declaration) ? declaration : undefined;
  return {
    name: parameter.getName(),
    type: serializeType(context, type, location),
    optional: (parameter.flags & ts.SymbolFlags.Optional) !== 0 ||
      Boolean(parameterDeclaration?.questionToken || parameterDeclaration?.initializer),
    rest: Boolean(parameterDeclaration?.dotDotDotToken),
    annotation: parameterDeclaration?.type ? "explicit" : "inferred",
    ...(declaration ? { location: locationFor(context, declaration) } : {}),
  };
}

function serializeTypeParameter(
  context: MutableContext,
  typeParameter: ts.TypeParameter,
  enclosingNode?: ts.Node,
): TypeModelTypeParameter {
  const declaration = typeParameter.symbol?.declarations?.find(ts.isTypeParameterDeclaration);
  const internal = typeParameter as InternalTypeParameter;
  const constraint = internal.constraint ?? (declaration?.constraint
    ? context.checker.getTypeFromTypeNode(declaration.constraint)
    : undefined);
  const defaultType = internal.default ?? (declaration?.default
    ? context.checker.getTypeFromTypeNode(declaration.default)
    : undefined);
  return {
    name: typeParameter.symbol?.getName() ?? safeTypeText(context, typeParameter, enclosingNode),
    type: serializeType(context, typeParameter, enclosingNode),
    ...(constraint ? { constraint: serializeType(context, constraint, declaration?.constraint ?? enclosingNode) } : {}),
    ...(defaultType ? { default: serializeType(context, defaultType, declaration?.default ?? enclosingNode) } : {}),
  };
}

function serializeSourceFileCallSites(context: MutableContext, sourceFile: SourceFile): TypeModelCallSiteRef[] {
  const nodes = sourceFile.getDescendants().map((node) => node.compilerNode)
    .filter(isCallLikeNode)
    .sort((left, right) => left.getStart() - right.getStart() ||
      callSiteKind(left).localeCompare(callSiteKind(right)) || left.kind - right.kind ||
      left.end - right.end);
  return nodes.map((node) => serializeCallSite(context, node));
}

function serializeCallSite(context: MutableContext, node: ts.CallLikeExpression): string {
  const kind = callSiteKind(node);
  const location = locationFor(context, node);
  const id = `callsite:${location.filePath}:${location.line}:${location.column}:${kind}`;
  const resultType = serializeType(context, context.checker.getTypeAtLocation(node), node);
  let resolved: ts.Signature | undefined;
  try {
    resolved = context.checker.getResolvedSignature(node);
  } catch (error) {
    addCallSiteDiagnostic(context, id, `Could not resolve call site: ${errorMessage(error)}`, node);
  }
  const calleeSymbol = getCallSiteSymbol(context, node, resolved);
  if (!resolved || !hasSignatureDeclaration(resolved)) {
    if (!context.diagnostics.some((diagnostic) => diagnostic.callSiteId === id)) {
      addCallSiteDiagnostic(context, id, "TypeScript did not return a resolved signature", node);
    }
    context.callSites.set(id, {
      id,
      kind,
      location,
      resolution: "unresolved",
      resultType,
      ...(calleeSymbol ? { calleeSymbolId: serializeSymbol(context, calleeSymbol) } : {}),
    });
    return id;
  }

  const signatureKind: SignatureKind = kind === "new" ? "construct" : "call";
  const declarationSignature = getDeclarationSignature(context, resolved);
  const declarationSignatureId = serializeSignature(context, declarationSignature, signatureKind, node);
  const resolvedSignatureId = serializeSignature(context, resolved, signatureKind, node);
  const genericInstantiation = serializeGenericInstantiation(
    context, id, node, resolved as InternalSignature, declarationSignature,
  );
  context.callSites.set(id, {
    id,
    kind,
    location,
    resolution: "resolved",
    resultType,
    ...(calleeSymbol ? { calleeSymbolId: serializeSymbol(context, calleeSymbol) } : {}),
    declarationSignatureId,
    resolvedSignatureId,
    ...(genericInstantiation ? { genericInstantiation } : {}),
  });
  return id;
}

function hasSignatureDeclaration(signature: ts.Signature): boolean {
  const internal = signature as InternalSignature;
  return Boolean(signature.declaration || internal.target?.declaration);
}

function serializeGenericInstantiation(
  context: MutableContext,
  callSiteId: string,
  node: ts.CallLikeExpression,
  resolved: InternalSignature,
  declarationSignature: ts.Signature,
): TypeModelGenericInstantiation | undefined {
  const target = resolved.target ?? declarationSignature as InternalSignature;
  const typeParameters = target.typeParameters ?? declarationSignature.typeParameters ?? [];
  if (typeParameters.length === 0) return undefined;
  const explicitArguments = getExplicitTypeArgumentNodes(node);
  const bindings: TypeModelGenericBinding[] = [];
  let complete = true;

  for (let index = 0; index < typeParameters.length; index += 1) {
    const parameter = typeParameters[index];
    const mapped = mapTypeParameter(parameter, resolved.mapper);
    const explicitNode = explicitArguments[index];
    const resolvedType = mapped ?? (explicitNode ? context.checker.getTypeFromTypeNode(explicitNode) : undefined);
    if (!resolvedType) {
      complete = false;
      continue;
    }
    bindings.push({
      parameterName: parameter.symbol?.getName() ?? safeTypeText(context, parameter, node),
      parameterType: serializeType(context, parameter, node),
      type: serializeType(context, resolvedType, explicitNode ?? node),
      source: explicitNode ? "explicit" : "inferred",
    });
  }

  if (!complete) {
    context.diagnostics.push({
      source: "type-model",
      category: "warning",
      code: "incomplete-generic-instantiation",
      message: "Could not recover every generic type argument from TypeScript's resolved signature mapper",
      location: locationFor(context, node),
      callSiteId,
    });
  }
  return { complete, bindings };
}

function mapTypeParameter(type: ts.Type, mapper: InternalTypeMapper | undefined): ts.Type | undefined {
  if (!mapper) return undefined;
  switch (mapper.kind) {
    case 0:
      return mapper.source === type ? mapper.target : undefined;
    case 1:
    case 2: {
      const index = mapper.sources?.indexOf(type) ?? -1;
      if (index < 0) return undefined;
      const target = mapper.targets?.[index];
      return typeof target === "function" ? target() : target;
    }
    case 3:
      return mapper.func?.(type);
    case 4: {
      const first = mapTypeParameter(type, mapper.mapper1);
      if (!first) return undefined;
      return mapTypeParameter(first, mapper.mapper2) ?? first;
    }
    case 5:
      return mapTypeParameter(type, mapper.mapper1) ?? mapTypeParameter(type, mapper.mapper2);
    default:
      return undefined;
  }
}

function getDeclarationSignature(context: MutableContext, signature: ts.Signature): ts.Signature {
  const target = (signature as InternalSignature).target ?? signature;
  const declaration = target.declaration;
  if (!declaration) return target;
  try {
    return context.checker.getSignatureFromDeclaration(declaration as ts.SignatureDeclaration) ?? target;
  } catch {
    return target;
  }
}

function getExplicitTypeArgumentNodes(node: ts.CallLikeExpression): readonly ts.TypeNode[] {
  return (node as ts.CallLikeExpression & { typeArguments?: readonly ts.TypeNode[] }).typeArguments ?? [];
}

function isCallLikeNode(node: ts.Node): node is ts.CallLikeExpression {
  return ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) ||
    ts.isDecorator(node) || ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ||
    ts.isJsxOpeningFragment(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword);
}

function callSiteKind(node: ts.CallLikeExpression): TypeModelCallSiteKind {
  if (ts.isNewExpression(node)) return "new";
  if (ts.isTaggedTemplateExpression(node)) return "taggedTemplate";
  if (ts.isDecorator(node)) return "decorator";
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningFragment(node)) return "jsx";
  if (ts.isBinaryExpression(node)) return "instanceof";
  return "call";
}

function getCallSiteSymbol(
  context: MutableContext,
  node: ts.CallLikeExpression,
  signature: ts.Signature | undefined,
): ts.Symbol | undefined {
  const expression = callSiteCalleeNode(node);
  const direct = expression ? context.checker.getSymbolAtLocation(expression) : undefined;
  if (direct) return direct;
  const declaration = signature?.declaration;
  const name = declaration && "name" in declaration ? declaration.name : undefined;
  return name && typeof name.kind === "number"
    ? context.checker.getSymbolAtLocation(name)
    : undefined;
}

function callSiteCalleeNode(node: ts.CallLikeExpression): ts.Node | undefined {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return node.expression;
  if (ts.isTaggedTemplateExpression(node)) return node.tag;
  if (ts.isDecorator(node)) return ts.isCallExpression(node.expression) ? node.expression.expression : node.expression;
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return node.tagName;
  if (ts.isBinaryExpression(node)) return node.right;
  return undefined;
}

function unsupportedType(
  context: MutableContext,
  base: TypeModelTypeBase,
  reason: string,
  node?: ts.Node,
): TypeModelResolvedType {
  context.diagnostics.push({
    source: "type-model",
    category: "warning",
    code: "unsupported-type",
    message: `${reason}: ${base.displayText}`,
    ...(node ? { location: locationFor(context, node) } : {}),
    typeId: base.id,
  });
  return { ...base, kind: "unsupported", reason };
}

function createUnsupportedSyntheticType(context: MutableContext, reason: string): string {
  const id = `type:${String(context.nextTypeId++).padStart(6, "0")}`;
  context.types.set(id, { id, kind: "unsupported", displayText: "<unresolved>", flags: [], reason });
  context.diagnostics.push({ source: "type-model", category: "warning", code: "unresolved-type", message: reason, typeId: id });
  return id;
}

function getNamedTypeSymbol(type: ts.Type): ts.Symbol | undefined {
  const alias = type.aliasSymbol;
  if (alias && (alias.flags & NAMED_TYPE_FLAGS) !== 0) return alias;
  const symbol = type.getSymbol();
  return symbol && (symbol.flags & NAMED_TYPE_FLAGS) !== 0 ? symbol : undefined;
}

function getTypeArguments(context: MutableContext, type: ts.Type): readonly ts.Type[] {
  if (type.aliasTypeArguments && type.aliasTypeArguments.length > 0) return type.aliasTypeArguments;
  if ((type.flags & ts.TypeFlags.Object) !== 0 && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) {
    return context.checker.getTypeArguments(type as ts.TypeReference);
  }
  return [];
}

function isIntrinsicType(type: ts.Type): boolean {
  return (type.flags & (
    ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void |
    ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.String | ts.TypeFlags.Number |
    ts.TypeFlags.Boolean | ts.TypeFlags.BigInt | ts.TypeFlags.ESSymbol |
    ts.TypeFlags.UniqueESSymbol | ts.TypeFlags.NonPrimitive
  )) !== 0;
}

function intrinsicName(type: ts.Type, displayText: string): string {
  return (type as ts.Type & { intrinsicName?: string }).intrinsicName ?? displayText;
}

function isArrayType(context: MutableContext, type: ts.Type): boolean {
  return context.checker.isArrayType(type) || isReadonlyArrayType(type);
}

function isReadonlyArrayType(type: ts.Type): boolean {
  if ((type.flags & ts.TypeFlags.Object) === 0) return false;
  const reference = type as ts.TypeReference;
  return (reference.target?.symbol ?? type.getSymbol())?.getName() === "ReadonlyArray";
}

function getArrayElementType(context: MutableContext, type: ts.Type): ts.Type | undefined {
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
  return context.checker.getTypeArguments(type as ts.TypeReference)[0];
}

function isReadonlyDeclaration(node: ts.Node): boolean {
  if (!ts.isPropertyDeclaration(node) && !ts.isPropertySignature(node) && !ts.isParameter(node) &&
    !ts.isMethodDeclaration(node) && !ts.isMethodSignature(node)) return false;
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Readonly) !== 0;
}

function hasReturnTypeAnnotation(node: ts.SignatureDeclaration | ts.JSDocSignature | undefined): boolean {
  return Boolean(node && "type" in node && node.type);
}

function rawJsDoc(context: MutableContext, declarations: readonly ts.Node[]): TypeModelJSDocComment[] {
  const comments = new Map<string, TypeModelJSDocComment>();
  for (const declaration of declarations) {
    const host = jsDocHost(declaration);
    const docs = (host as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? [];
    for (const doc of docs) {
      const sourceFile = doc.getSourceFile();
      const start = doc.getStart(sourceFile);
      const text = sourceFile.text.slice(start, doc.end);
      const item = { location: locationFor(context, doc), text };
      comments.set(`${item.location.filePath}:${start}:${doc.end}`, item);
    }
  }
  return [...comments.values()].sort((left, right) =>
    left.location.filePath.localeCompare(right.location.filePath) || left.location.line - right.location.line ||
    left.location.column - right.location.column || left.text.localeCompare(right.text)
  );
}

function jsDocHost(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isBindingElement(current) || ts.isVariableDeclaration(current) || ts.isVariableDeclarationList(current)) {
    current = current.parent;
  }
  return current;
}

function resolveAliasedSymbol(context: MutableContext, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    return context.checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function isExternalSymbol(context: MutableContext, symbol: ts.Symbol): boolean {
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0) return true;
  return !declarations.some((declaration) => isProjectLocalPath(context, declaration.getSourceFile().fileName));
}

function isProjectLocalPath(context: MutableContext, filePath: string): boolean {
  const normalized = path.resolve(filePath);
  const relative = path.relative(context.projectRoot, normalized);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative) && !normalized.includes(`${path.sep}node_modules${path.sep}`) &&
    !isTypeScriptLibraryPath(normalized);
}

function isTypeScriptLibraryPath(filePath: string): boolean {
  return /[\\/]node_modules[\\/]typescript[\\/]lib[\\/]lib\..*\.d\.ts$/i.test(filePath);
}

function createSymbolId(
  context: MutableContext,
  symbol: ts.Symbol,
  declarations: readonly ts.Declaration[],
  external: boolean,
): string {
  const declaration = declarations[0];
  const name = encodeIdPart(symbol.getName());
  if (!declaration) return `external:global:${name}`;
  const filePath = declaration.getSourceFile().fileName;
  const start = declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart());
  if (!external) return `symbol:${projectPath(context, filePath)}:${start.line + 1}:${start.character + 1}:${name}`;
  return `external:${externalOrigin(filePath)}:${name}`;
}

function externalOrigin(filePath: string): string {
  const normalized = normalizePath(filePath);
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) {
    const remainder = normalized.slice(index + marker.length);
    const parts = remainder.split("/");
    const packageLength = parts[0]?.startsWith("@") ? 2 : 1;
    const packageName = parts.slice(0, packageLength).join("/") || "unknown";
    const packagePath = parts.slice(packageLength).join("/") || "index.d.ts";
    return `package:${packageName}:${packagePath}`;
  }
  return `file:${path.basename(filePath)}`;
}

function locationFor(context: MutableContext, node: ts.Node): TypeModelLocation {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { filePath: projectPath(context, sourceFile.fileName), line: start.line + 1, column: start.character + 1 };
}

function projectPath(context: MutableContext, filePath: string): string {
  return normalizePath(path.relative(context.projectRoot, filePath) || path.basename(filePath));
}

function safeQualifiedName(context: MutableContext, symbol: ts.Symbol): string {
  try {
    return context.checker.getFullyQualifiedName(symbol);
  } catch {
    return symbol.getName();
  }
}

function safeTypeText(context: MutableContext, type: ts.Type, node?: ts.Node): string {
  try {
    return sanitizeText(context.checker.typeToString(type, node, TYPE_FORMAT_FLAGS), context.projectRoot);
  } catch {
    return "<unprintable>";
  }
}

function serializeCompilerDiagnostic(diagnostic: Diagnostic, projectRoot: string): TypeModelDiagnostic {
  const sourceFile = diagnostic.getSourceFile();
  const start = diagnostic.getStart();
  let location: TypeModelLocation | undefined;
  if (sourceFile && start !== undefined) {
    const lineAndColumn = sourceFile.getLineAndColumnAtPos(start);
    location = {
      filePath: normalizePath(path.relative(projectRoot, sourceFile.getFilePath())),
      line: lineAndColumn.line,
      column: lineAndColumn.column,
    };
  }
  return {
    source: "typescript",
    category: diagnosticCategory(diagnostic.getCategory()),
    code: diagnostic.getCode(),
    message: sanitizeText(ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, "\n"), projectRoot),
    ...(location ? { location } : {}),
  };
}

function addExtractionDiagnostic(context: MutableContext, message: string, node?: ts.Node): void {
  context.diagnostics.push({
    source: "type-model",
    category: "warning",
    code: "resolution-failed",
    message: sanitizeText(message, context.projectRoot),
    ...(node ? { location: locationFor(context, node) } : {}),
  });
}

function addCallSiteDiagnostic(context: MutableContext, callSiteId: string, message: string, node: ts.Node): void {
  context.diagnostics.push({
    source: "type-model",
    category: "warning",
    code: "unresolved-call-site",
    message: sanitizeText(message, context.projectRoot),
    location: locationFor(context, node),
    callSiteId,
  });
}

function diagnosticCategory(category: ts.DiagnosticCategory): TypeModelDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error: return "error";
    case ts.DiagnosticCategory.Warning: return "warning";
    case ts.DiagnosticCategory.Suggestion: return "suggestion";
    default: return "message";
  }
}

function primarySymbolKind(symbol: ts.Symbol): string {
  const choices: Array<[ts.SymbolFlags, string]> = [
    [ts.SymbolFlags.Alias, "alias"], [ts.SymbolFlags.Class, "class"],
    [ts.SymbolFlags.Interface, "interface"], [ts.SymbolFlags.TypeAlias, "typeAlias"],
    [ts.SymbolFlags.Function, "function"], [ts.SymbolFlags.Method, "method"],
    [ts.SymbolFlags.Variable, "variable"], [ts.SymbolFlags.Property, "property"],
    [ts.SymbolFlags.Enum, "enum"], [ts.SymbolFlags.Namespace, "namespace"],
  ];
  return choices.find(([flag]) => (symbol.flags & flag) !== 0)?.[1] ?? "symbol";
}

function enumFlagNames(enumObject: Record<string, string | number>, flags: number): string[] {
  return Object.entries(enumObject)
    .filter(([, value]) => typeof value === "number" && value > 0 && isPowerOfTwo(value) && (flags & value) !== 0)
    .map(([name]) => name)
    .sort();
}

function isPowerOfTwo(value: number): boolean {
  return (value & (value - 1)) === 0;
}

function sortCompilerDeclarations(declarations: readonly ts.Declaration[]): ts.Declaration[] {
  return [...declarations].sort((left, right) =>
    left.getSourceFile().fileName.localeCompare(right.getSourceFile().fileName) || left.getStart() - right.getStart()
  );
}

function sortTypes(context: MutableContext, types: readonly ts.Type[], enclosingNode?: ts.Node): ts.Type[] {
  return [...types].sort((left, right) =>
    safeTypeText(context, left, enclosingNode).localeCompare(safeTypeText(context, right, enclosingNode))
  );
}

function sortSignatures(context: MutableContext, signatures: readonly ts.Signature[]): ts.Signature[] {
  return [...signatures].sort((left, right) => {
    const leftDeclaration = left.declaration;
    const rightDeclaration = right.declaration;
    if (!leftDeclaration || !rightDeclaration) {
      return safeSignatureText(context, left).localeCompare(safeSignatureText(context, right));
    }
    return leftDeclaration.getSourceFile().fileName.localeCompare(rightDeclaration.getSourceFile().fileName) ||
      leftDeclaration.getStart() - rightDeclaration.getStart();
  });
}

function safeSignatureText(context: MutableContext, signature: ts.Signature): string {
  try {
    return context.checker.signatureToString(signature, signature.declaration, TYPE_FORMAT_FLAGS);
  } catch {
    return "";
  }
}

function compareCompilerSymbols(left: ts.Symbol, right: ts.Symbol): number {
  return left.getName().localeCompare(right.getName()) ||
    firstCompilerDeclarationKey(left).localeCompare(firstCompilerDeclarationKey(right));
}

function firstCompilerDeclarationKey(symbol: ts.Symbol): string {
  const declaration = sortCompilerDeclarations(symbol.declarations ?? [])[0];
  return declaration
    ? `${declaration.getSourceFile().fileName}:${String(declaration.getStart()).padStart(10, "0")}`
    : symbol.getName();
}

function dedupeCompilerSymbols(symbols: ts.Symbol[]): ts.Symbol[] {
  return [...new Set(symbols)];
}

function compareDiagnostics(left: TypeModelDiagnostic, right: TypeModelDiagnostic): number {
  return left.source.localeCompare(right.source) || String(left.code).localeCompare(String(right.code)) ||
    (left.location?.filePath ?? "").localeCompare(right.location?.filePath ?? "") ||
    (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
    (left.location?.column ?? 0) - (right.location?.column ?? 0) || left.message.localeCompare(right.message);
}

function sortedRecord<T>(values: Map<string, T>): Record<string, T> {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function sanitizeText(value: string, projectRoot: string): string {
  const normalizedRoot = normalizePath(projectRoot).replace(/\/$/, "");
  return normalizePath(value).split(normalizedRoot).join(".");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function encodeIdPart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "~");
}

function asArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
