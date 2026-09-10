import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TypeModel,
  TypeModelDiagnostic,
  TypeModelModule,
  TypeModelParameter,
  TypeModelResolvedType,
  TypeModelSignature,
  TypeModelSymbol,
  TypeModelSymbolRef,
  TypeModelTypeParameter,
  TypeModelTypeRef,
} from "./type-model";

export interface GenerateTypeDeclarationsOptions {
  /** Exact module id or modeled file path. Required for multi-module models. */
  module?: string;
  /** Defaults to a generated-file banner. Set false to omit it. */
  banner?: string | false;
  /**
   * Permit the lossy schema-v2 structural renderer when no authenticated
   * declaration bundle is available. Exact bundle-backed generation is the
   * default in v2.0.
   */
  structuralFallback?: "allow";
}

/** Raised when exact declaration bytes are unavailable for the selected module. */
export class ExactDeclarationUnavailableError extends Error {
  readonly code = "exact-declaration-unavailable";
  constructor(
    readonly moduleId: string,
    readonly schemaVersion: TypeModel["schemaVersion"],
    readonly bundleStatus: "absent" | "failed",
  ) {
    super(
      `Exact declarations are unavailable for ${moduleId}: type-model schema ${schemaVersion} has bundle status ${bundleStatus}. `
      + `Re-extract with includeDeclarationBundles: true or explicitly set structuralFallback: "allow".`,
    );
    this.name = "ExactDeclarationUnavailableError";
  }
}

export interface TypeModelDeclarationDiagnostic {
  category: "warning";
  code: string;
  message: string;
  symbolId?: TypeModelSymbolRef;
  typeId?: TypeModelTypeRef;
}

export interface GeneratedTypeDeclarations {
  text: string;
  moduleId: string;
  moduleFilePath: string;
  mode: "bundled" | "structural-fallback";
  diagnostics: TypeModelDeclarationDiagnostic[];
}

export interface SavedTypeDeclarations extends GeneratedTypeDeclarations {
  outputFilePath: string;
}

interface DeclarationParts {
  symbolId: TypeModelSymbolRef;
  type?: string;
  value?: string;
}

interface ExternalImport {
  importedName: string;
  localName: string;
}

interface RenderContext {
  model: TypeModel;
  module: TypeModelModule;
  diagnostics: TypeModelDeclarationDiagnostic[];
  queuedSymbols: TypeModelSymbolRef[];
  queuedSymbolIds: Set<TypeModelSymbolRef>;
  localNames: Map<TypeModelSymbolRef, string>;
  usedNames: Set<string>;
  externalImports: Map<string, Map<string, ExternalImport>>;
  rendering: Set<TypeModelTypeRef>;
}

const DEFAULT_BANNER = "/* Generated from type-model. */";
const UNPRINTABLE_TYPE_TEXT = new Set(["<unresolved>", "<unprintable>", ""]);

export function generateTypeDeclarationsFromModel(
  model: TypeModel,
  options: GenerateTypeDeclarationsOptions = {},
): GeneratedTypeDeclarations {
  const module = selectModule(model, options.module);
  const bundled = model.schemaVersion === "3" ? module.declarationBundle : undefined;

  if (bundled?.status === "generated") {
    return {
      text: withBanner(bundled.text, options.banner),
      moduleId: module.id,
      moduleFilePath: module.filePath,
      mode: "bundled",
      diagnostics: [],
    };
  }

  if (options.structuralFallback !== "allow") {
    throw new ExactDeclarationUnavailableError(
      module.id,
      model.schemaVersion,
      bundled?.status === "failed" ? "failed" : "absent",
    );
  }

  const generated = generateStructuralDeclarations(model, module);
  if (moduleUsesExplicitAnnotations(model, module)) {
    generated.diagnostics.unshift({
      category: "warning",
      code: "structural-annotation-fidelity-not-guaranteed",
      message: `Structural declaration generation for ${module.filePath} cannot guarantee preservation of explicit source annotations.`,
    });
  }
  if (bundled?.status === "failed") {
    const extractionDiagnostic = findBundleDiagnostic(model.diagnostics, module.filePath);
    generated.diagnostics.unshift({
      category: "warning",
      code: bundled.diagnosticCode,
      message: extractionDiagnostic?.message ??
        `The stored declaration bundle for ${module.filePath} failed; structural fallback was used.`,
    });
  }

  return {
    text: withBanner(generated.text, options.banner),
    moduleId: module.id,
    moduleFilePath: module.filePath,
    mode: "structural-fallback",
    diagnostics: generated.diagnostics,
  };
}

function moduleUsesExplicitAnnotations(model: TypeModel, _module: TypeModelModule): boolean {
  // Re-exported symbols are rendered as part of the selected module even when
  // their declarations live in another project-local source file. Treat the
  // model conservatively: structural rendering cannot prove that any explicit
  // annotation reachable through those exports retained its source spelling.
  return Object.values(model.signatures).some((signature) =>
    signature.returnAnnotation === "explicit"
      || signature.parameters.some((parameter) => parameter.annotation === "explicit")
      || signature.thisParameter?.annotation === "explicit"
  );
}

export async function saveTypeDeclarationsFromModel(
  model: TypeModel,
  outputFilePath: string,
  options: GenerateTypeDeclarationsOptions = {},
): Promise<SavedTypeDeclarations> {
  const generated = generateTypeDeclarationsFromModel(model, options);
  const absoluteOutputPath = path.resolve(outputFilePath);
  await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
  await writeFile(absoluteOutputPath, generated.text, "utf8");
  return { ...generated, outputFilePath: absoluteOutputPath };
}

function selectModule(model: TypeModel, requested?: string): TypeModelModule {
  if (!requested) {
    if (model.modules.length === 1) return model.modules[0];
    const available = model.modules
      .map((module) => `${module.id} (${module.filePath})`)
      .join(", ");
    throw new Error(
      `Type model contains ${model.modules.length} modules; select one by id or file path. Available modules: ${available}`,
    );
  }

  const matches = model.modules.filter((module) =>
    module.id === requested || module.filePath === requested
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Module selector is ambiguous: ${requested}`);
  }
  const available = model.modules.map((module) => module.filePath).join(", ");
  throw new Error(`Module not found: ${requested}. Available modules: ${available}`);
}

function withBanner(text: string, banner: string | false | undefined): string {
  const normalized = normalizeText(text);
  const selectedBanner = banner === undefined ? DEFAULT_BANNER : banner;
  if (selectedBanner === false || !selectedBanner.trim()) return normalized;
  return `${selectedBanner.trim()}\n\n${normalized}`;
}

function normalizeText(text: string): string {
  return `${text.replace(/\r\n?/g, "\n").trim()}\n`;
}

function findBundleDiagnostic(
  diagnostics: readonly TypeModelDiagnostic[],
  filePath: string,
): TypeModelDiagnostic | undefined {
  return diagnostics.find((diagnostic) =>
    diagnostic.code === "declaration-bundle-failed" && diagnostic.location?.filePath === filePath
  );
}

function generateStructuralDeclarations(
  model: TypeModel,
  module: TypeModelModule,
): { text: string; diagnostics: TypeModelDeclarationDiagnostic[] } {
  const context: RenderContext = {
    model,
    module,
    diagnostics: [],
    queuedSymbols: [],
    queuedSymbolIds: new Set(),
    localNames: new Map(),
    usedNames: new Set(),
    externalImports: new Map(),
    rendering: new Set(),
  };

  const localExports = module.exports
    .map((entry) => ({ entry, target: model.symbols[entry.targetSymbolId] }))
    .filter((item): item is { entry: typeof item.entry; target: TypeModelSymbol } => Boolean(item.target));

  for (const { target } of localExports) {
    if (!target.external) queueSymbol(context, target.id);
  }

  const declarations = new Map<TypeModelSymbolRef, DeclarationParts>();
  for (let index = 0; index < context.queuedSymbols.length; index += 1) {
    const symbolId = context.queuedSymbols[index];
    const symbol = model.symbols[symbolId];
    if (!symbol || symbol.external) continue;
    declarations.set(symbolId, renderSymbolDeclaration(context, symbol));
  }

  const directTypeExports = new Set<TypeModelSymbolRef>();
  const directValueExports = new Set<TypeModelSymbolRef>();
  for (const { entry, target } of localExports) {
    if (target.external) continue;
    const localName = nameForSymbol(context, target.id);
    if (entry.name === localName && entry.name !== "default") {
      if (target.declaredType) directTypeExports.add(target.id);
      if (target.valueType) directValueExports.add(target.id);
    }
  }

  const importLines = renderExternalImports(context);
  const declarationLines = [...declarations.values()]
    .sort((left, right) => nameForSymbol(context, left.symbolId).localeCompare(nameForSymbol(context, right.symbolId)))
    .flatMap((parts) => {
      const lines: string[] = [];
      if (parts.type) lines.push(prefixExport(parts.type, directTypeExports.has(parts.symbolId)));
      if (parts.value) lines.push(prefixExport(parts.value, directValueExports.has(parts.symbolId)));
      return lines;
    });
  const exportLines = renderExports(context, localExports, directTypeExports, directValueExports);
  const sections = [importLines, declarationLines, exportLines].filter((section) => section.length > 0);

  return {
    text: normalizeText(sections.map((section) => section.join("\n\n")).join("\n\n")),
    diagnostics: context.diagnostics,
  };
}

function renderSymbolDeclaration(context: RenderContext, symbol: TypeModelSymbol): DeclarationParts {
  const name = nameForSymbol(context, symbol.id);
  const result: DeclarationParts = { symbolId: symbol.id };
  if (symbol.declaredType) {
    const parameters = collectRootTypeParameters(context, symbol.declaredType, symbol.id);
    result.type = `type ${name}${renderTypeParameters(context, parameters)} = ${renderType(context, symbol.declaredType, symbol.id, true)};`;
  }
  if (symbol.valueType) {
    result.value = `declare const ${name}: ${renderType(context, symbol.valueType, symbol.id, true)};`;
  }
  if (!result.type && !result.value) {
    warn(context, "unemittable-symbol", `Symbol ${symbol.name} has neither a declared type nor a value type.`, {
      symbolId: symbol.id,
    });
  }
  return result;
}

function prefixExport(declaration: string, exported: boolean): string {
  return exported ? `export ${declaration}` : declaration;
}

function renderExports(
  context: RenderContext,
  exports: Array<{ entry: TypeModelModule["exports"][number]; target: TypeModelSymbol }>,
  directTypeExports: ReadonlySet<TypeModelSymbolRef>,
  directValueExports: ReadonlySet<TypeModelSymbolRef>,
): string[] {
  const lines: string[] = [];
  for (const { entry, target } of exports) {
    if (target.external) {
      const moduleName = externalPackageName(target.id);
      if (!moduleName || isAmbientExternalPackage(moduleName)) {
        warn(context, "external-export-unresolved", `Could not safely re-export external symbol ${target.name}.`, {
          symbolId: target.id,
        });
        continue;
      }
      const imported = exportName(target.name);
      const exported = exportName(entry.name);
      const specifier = imported === exported ? imported : `${imported} as ${exported}`;
      if (hasValueSide(target)) lines.push(`export { ${specifier} } from ${JSON.stringify(moduleName)};`);
      else if (hasTypeSide(target)) lines.push(`export type { ${specifier} } from ${JSON.stringify(moduleName)};`);
      continue;
    }

    const localName = nameForSymbol(context, target.id);
    const exportedName = exportName(entry.name);
    const specifier = localName === exportedName ? localName : `${localName} as ${exportedName}`;
    const isDirectExport = entry.name === localName && entry.name !== "default";
    if (target.valueType && !(isDirectExport && directValueExports.has(target.id))) {
      lines.push(`export { ${specifier} };`);
    } else if (target.declaredType && !(isDirectExport && directTypeExports.has(target.id))) {
      lines.push(`export type { ${specifier} };`);
    }
  }
  return [...new Set(lines)].sort();
}

function hasTypeSide(symbol: TypeModelSymbol): boolean {
  return symbol.flags.some((flag) => ["Class", "Interface", "TypeAlias", "Enum", "RegularEnum", "ConstEnum"].includes(flag));
}

function hasValueSide(symbol: TypeModelSymbol): boolean {
  return symbol.flags.some((flag) => [
    "Class", "Function", "Variable", "Enum", "RegularEnum", "ConstEnum", "ValueModule", "NamespaceModule",
  ].includes(flag));
}

function renderType(
  context: RenderContext,
  typeId: TypeModelTypeRef,
  rootSymbolId?: TypeModelSymbolRef,
  expandRootReference = false,
  inferredTypeIds: ReadonlySet<TypeModelTypeRef> = new Set(),
): string {
  const type = context.model.types[typeId];
  if (!type) {
    warn(context, "missing-type", `Type reference ${typeId} is missing from the model.`, { typeId });
    return "unknown";
  }

  if (context.rendering.has(typeId)) {
    const recursiveName = type.aliasSymbolId
      ? nameForReferencedSymbol(context, type.aliasSymbolId, type.displayText)
      : printableDisplayText(type);
    if (recursiveName) return recursiveName;
    warn(context, "anonymous-type-cycle", `Anonymous recursive type ${typeId} was replaced with unknown.`, { typeId });
    return "unknown";
  }

  if (type.aliasSymbolId && type.aliasSymbolId !== rootSymbolId) {
    const aliasName = nameForReferencedSymbol(context, type.aliasSymbolId, type.displayText);
    const argumentsText = type.aliasTypeArguments?.length
      ? `<${type.aliasTypeArguments.map((argument) => renderType(context, argument)).join(", ")}>`
      : "";
    return `${aliasName}${argumentsText}`;
  }

  context.rendering.add(typeId);
  try {
    return renderTypeValue(context, type, rootSymbolId, expandRootReference, inferredTypeIds);
  } finally {
    context.rendering.delete(typeId);
  }
}

function renderTypeValue(
  context: RenderContext,
  type: TypeModelResolvedType,
  rootSymbolId: TypeModelSymbolRef | undefined,
  expandRootReference: boolean,
  inferredTypeIds: ReadonlySet<TypeModelTypeRef>,
): string {
  const nested = (typeId: TypeModelTypeRef): string =>
    renderType(context, typeId, rootSymbolId, false, inferredTypeIds);
  switch (type.kind) {
    case "intrinsic":
      return type.name;
    case "literal":
      if (type.valueKind === "string") return JSON.stringify(type.value);
      if (type.valueKind === "bigint") return `${String(type.value)}n`;
      return String(type.value);
    case "union":
      return `(${type.types.map(nested).join(" | ")})`;
    case "intersection":
      return `(${type.types.map(nested).join(" & ")})`;
    case "typeParameter":
      return inferredTypeIds.has(type.id) || inferredTypeIds.has(`name:${type.name}`)
        ? `infer ${safeIdentifier(type.name)}`
        : safeIdentifier(type.name);
    case "array":
      return type.readonly ? `ReadonlyArray<${nested(type.elementType)}>` : `Array<${nested(type.elementType)}>`;
    case "tuple": {
      const elements = type.elements.map((element) => {
        const rendered = nested(element.type);
        if (element.label) {
          return `${element.rest ? "..." : ""}${safeIdentifier(element.label)}${element.optional ? "?" : ""}: ${rendered}`;
        }
        if (element.rest) return `...${rendered}`;
        return element.optional ? `${rendered}?` : rendered;
      });
      return `${type.readonly ? "readonly " : ""}[${elements.join(", ")}]`;
    }
    case "reference":
      if (expandRootReference && type.symbolId === rootSymbolId) {
        return renderType(context, type.target, rootSymbolId, false, inferredTypeIds);
      }
      return `${nameForReferencedSymbol(context, type.symbolId, type.displayText)}${renderTypeArguments(context, type.typeArguments)}`;
    case "external":
      return `${nameForReferencedSymbol(context, type.symbolId, type.displayText)}${renderTypeArguments(context, type.typeArguments)}`;
    case "conditional": {
      const inferred = new Set<TypeModelTypeRef>([...inferredTypeIds, ...type.inferTypeParameters]);
      for (const inferredId of type.inferTypeParameters) {
        const inferredType = context.model.types[inferredId];
        if (inferredType?.kind === "typeParameter") inferred.add(`name:${inferredType.name}`);
      }
      const checkNames = collectTypeParameterNames(context.model, type.checkType);
      const trueNames = collectTypeParameterNames(context.model, type.trueType);
      for (const name of collectTypeParameterNames(context.model, type.extendsType)) {
        if (trueNames.has(name) && !checkNames.has(name)) inferred.add(`name:${name}`);
      }
      return `(${renderType(context, type.checkType, rootSymbolId, false, inferredTypeIds)} extends ${renderType(context, type.extendsType, rootSymbolId, false, inferred)} ? ${renderType(context, type.trueType, rootSymbolId, false, inferredTypeIds)} : ${renderType(context, type.falseType, rootSymbolId, false, inferredTypeIds)})`;
    }
    case "mapped": {
      const readonly = type.readonlyModifier === "add" ? "readonly "
        : type.readonlyModifier === "remove" ? "-readonly " : "";
      const optional = type.optionalModifier === "add" ? "?"
        : type.optionalModifier === "remove" ? "-?" : "";
      const parameter = safeIdentifier(type.typeParameter.name);
      const nameType = type.nameType ? ` as ${nested(type.nameType)}` : "";
      return `{ ${readonly}[${parameter} in ${nested(type.constraint)}${nameType}]${optional}: ${nested(type.valueType)} }`;
    }
    case "indexedAccess":
      return `${nested(type.objectType)}[${nested(type.indexType)}]`;
    case "keyof":
      return `keyof ${nested(type.type)}`;
    case "templateLiteral": {
      let result = escapeTemplateText(type.texts[0] ?? "");
      for (let index = 0; index < type.types.length; index += 1) {
        result += `\${${nested(type.types[index])}}${escapeTemplateText(type.texts[index + 1] ?? "")}`;
      }
      return `\`${result}\``;
    }
    case "stringMapping":
      return `${safeIdentifier(type.operation)}<${nested(type.type)}>`;
    case "substitution":
      return `(${nested(type.baseType)} & ${nested(type.constraint)})`;
    case "object":
      return renderObjectType(context, type, rootSymbolId, inferredTypeIds);
    case "unsupported":
      return fallbackDisplayText(context, type);
  }
}

function renderObjectType(
  context: RenderContext,
  type: Extract<TypeModelResolvedType, { kind: "object" }>,
  rootSymbolId?: TypeModelSymbolRef,
  inferredTypeIds: ReadonlySet<TypeModelTypeRef> = new Set(),
): string {
  const members: string[] = [];
  for (const signatureId of type.callSignatures) {
    const signature = context.model.signatures[signatureId];
    if (signature) members.push(`${renderSignature(context, signature, false, rootSymbolId, inferredTypeIds)};`);
  }
  for (const signatureId of type.constructSignatures) {
    const signature = context.model.signatures[signatureId];
    if (signature) members.push(`${renderSignature(context, signature, true, rootSymbolId, inferredTypeIds)};`);
  }
  for (const property of type.properties) {
    const docs = property.jsDoc?.map((item) => item.text.trim()).join("\n") ?? "";
    const declaration = `${property.readonly ? "readonly " : ""}${propertyName(property.name)}${property.optional ? "?" : ""}: ${renderType(context, property.type, rootSymbolId, false, inferredTypeIds)};`;
    members.push(docs ? `${docs}\n${declaration}` : declaration);
  }
  if (type.stringIndexType) members.push(`[key: string]: ${renderType(context, type.stringIndexType, rootSymbolId, false, inferredTypeIds)};`);
  if (type.numberIndexType) members.push(`[key: number]: ${renderType(context, type.numberIndexType, rootSymbolId, false, inferredTypeIds)};`);
  return members.length === 0 ? "{}" : `{\n${members.map((member) => indent(member)).join("\n")}\n}`;
}

function renderSignature(
  context: RenderContext,
  signature: TypeModelSignature,
  construct: boolean,
  rootSymbolId?: TypeModelSymbolRef,
  inferredTypeIds: ReadonlySet<TypeModelTypeRef> = new Set(),
): string {
  const parameters = [
    ...(signature.thisParameter ? [signature.thisParameter] : []),
    ...signature.parameters,
  ].map((parameter) => renderParameter(context, parameter, rootSymbolId, inferredTypeIds)).join(", ");
  return `${construct ? "new " : ""}${renderTypeParameters(context, signature.typeParameters)}(${parameters}): ${renderType(context, signature.returnType, rootSymbolId, false, inferredTypeIds)}`;
}

function renderParameter(
  context: RenderContext,
  parameter: TypeModelParameter,
  rootSymbolId?: TypeModelSymbolRef,
  inferredTypeIds: ReadonlySet<TypeModelTypeRef> = new Set(),
): string {
  return `${parameter.rest ? "..." : ""}${safeIdentifier(parameter.name)}${parameter.optional ? "?" : ""}: ${renderType(context, parameter.type, rootSymbolId, false, inferredTypeIds)}`;
}

function renderTypeParameters(
  context: RenderContext,
  parameters: readonly TypeModelTypeParameter[],
): string {
  if (parameters.length === 0) return "";
  return `<${parameters.map((parameter) => {
    const constraint = parameter.constraint ? ` extends ${renderType(context, parameter.constraint)}` : "";
    const defaultType = parameter.default ? ` = ${renderType(context, parameter.default)}` : "";
    return `${safeIdentifier(parameter.name)}${constraint}${defaultType}`;
  }).join(", ")}>`;
}

function collectRootTypeParameters(
  context: RenderContext,
  typeId: TypeModelTypeRef,
  rootSymbolId: TypeModelSymbolRef,
): TypeModelTypeParameter[] {
  const result = new Map<string, TypeModelTypeParameter>();
  const visiting = new Set<TypeModelTypeRef>();
  const visit = (currentId: TypeModelTypeRef, bound: ReadonlySet<TypeModelTypeRef>, expandRoot = false): void => {
    if (visiting.has(currentId)) return;
    const type = context.model.types[currentId];
    if (!type) return;
    if (type.kind === "typeParameter") {
      if (!bound.has(type.id)) {
        if (!result.has(type.name)) {
          result.set(type.name, {
            name: type.name,
            type: type.id,
            ...(type.constraint ? { constraint: type.constraint } : {}),
            ...(type.default ? { default: type.default } : {}),
          });
        }
      }
      return;
    }
    if (type.aliasSymbolId && type.aliasSymbolId !== rootSymbolId) return;
    if (type.kind === "reference" && (!expandRoot || type.symbolId !== rootSymbolId)) return;
    visiting.add(currentId);
    try {
      if (type.kind === "reference") {
        type.typeArguments.forEach((argument) => visit(argument, bound));
        visit(type.target, bound);
      } else if (type.kind === "external") type.typeArguments.forEach((argument) => visit(argument, bound));
      else if (type.kind === "union" || type.kind === "intersection") type.types.forEach((id) => visit(id, bound));
      else if (type.kind === "array") visit(type.elementType, bound);
      else if (type.kind === "tuple") type.elements.forEach((element) => visit(element.type, bound));
      else if (type.kind === "conditional") {
        visit(type.checkType, bound);
        const nextBound = new Set([...bound, ...type.inferTypeParameters]);
        visit(type.extendsType, nextBound);
        visit(type.trueType, nextBound);
        visit(type.falseType, bound);
      } else if (type.kind === "mapped") {
        const nextBound = new Set([...bound, type.typeParameter.type]);
        visit(type.constraint, bound);
        if (type.nameType) visit(type.nameType, nextBound);
        visit(type.valueType, nextBound);
      } else if (type.kind === "indexedAccess") {
        visit(type.objectType, bound);
        visit(type.indexType, bound);
      } else if (type.kind === "keyof" || type.kind === "stringMapping") visit(type.type, bound);
      else if (type.kind === "templateLiteral") type.types.forEach((id) => visit(id, bound));
      else if (type.kind === "substitution") {
        visit(type.baseType, bound);
        visit(type.constraint, bound);
      } else if (type.kind === "object") {
        type.properties.forEach((property) => visit(property.type, bound));
        if (type.stringIndexType) visit(type.stringIndexType, bound);
        if (type.numberIndexType) visit(type.numberIndexType, bound);
        [...type.callSignatures, ...type.constructSignatures].forEach((signatureId) => {
          const signature = context.model.signatures[signatureId];
          if (!signature) return;
          const signatureBound = new Set([...bound, ...signature.typeParameters.map((parameter) => parameter.type)]);
          signature.parameters.forEach((parameter) => visit(parameter.type, signatureBound));
          visit(signature.returnType, signatureBound);
        });
      }
    } finally {
      visiting.delete(currentId);
    }
  };
  visit(typeId, new Set(), true);
  return [...result.values()];
}

function collectTypeParameterNames(
  model: TypeModel,
  rootTypeId: TypeModelTypeRef,
): Set<string> {
  const names = new Set<string>();
  const visited = new Set<TypeModelTypeRef>();
  const visit = (typeId: TypeModelTypeRef): void => {
    if (visited.has(typeId)) return;
    visited.add(typeId);
    const type = model.types[typeId];
    if (!type) return;
    if (type.kind === "typeParameter") {
      names.add(type.name);
      return;
    }
    if (type.kind === "union" || type.kind === "intersection") type.types.forEach(visit);
    else if (type.kind === "array") visit(type.elementType);
    else if (type.kind === "tuple") type.elements.forEach((element) => visit(element.type));
    else if (type.kind === "reference") {
      type.typeArguments.forEach(visit);
      visit(type.target);
    } else if (type.kind === "external") type.typeArguments.forEach(visit);
    else if (type.kind === "conditional") {
      visit(type.checkType);
      visit(type.extendsType);
      visit(type.trueType);
      visit(type.falseType);
    } else if (type.kind === "mapped") {
      visit(type.typeParameter.type);
      visit(type.constraint);
      if (type.nameType) visit(type.nameType);
      visit(type.valueType);
    } else if (type.kind === "indexedAccess") {
      visit(type.objectType);
      visit(type.indexType);
    } else if (type.kind === "keyof" || type.kind === "stringMapping") visit(type.type);
    else if (type.kind === "templateLiteral") type.types.forEach(visit);
    else if (type.kind === "substitution") {
      visit(type.baseType);
      visit(type.constraint);
    } else if (type.kind === "object") {
      type.properties.forEach((property) => visit(property.type));
      if (type.stringIndexType) visit(type.stringIndexType);
      if (type.numberIndexType) visit(type.numberIndexType);
      [...type.callSignatures, ...type.constructSignatures].forEach((signatureId) => {
        const signature = model.signatures[signatureId];
        if (!signature) return;
        signature.typeParameters.forEach((parameter) => visit(parameter.type));
        signature.parameters.forEach((parameter) => visit(parameter.type));
        visit(signature.returnType);
      });
    }
  };
  visit(rootTypeId);
  return names;
}

function renderTypeArguments(context: RenderContext, typeArguments: readonly TypeModelTypeRef[]): string {
  return typeArguments.length === 0
    ? ""
    : `<${typeArguments.map((argument) => renderType(context, argument)).join(", ")}>`;
}

function queueSymbol(context: RenderContext, symbolId: TypeModelSymbolRef): void {
  const symbol = context.model.symbols[symbolId];
  if (!symbol || symbol.external || context.queuedSymbolIds.has(symbolId)) return;
  context.queuedSymbolIds.add(symbolId);
  context.queuedSymbols.push(symbolId);
  nameForSymbol(context, symbolId);
}

function nameForReferencedSymbol(
  context: RenderContext,
  symbolId: TypeModelSymbolRef,
  displayText?: string,
): string {
  const symbol = context.model.symbols[symbolId];
  if (!symbol) {
    warn(context, "missing-symbol", `Symbol reference ${symbolId} is missing from the model.`, { symbolId });
    return "unknown";
  }
  if (!symbol.external) {
    queueSymbol(context, symbolId);
    return nameForSymbol(context, symbolId);
  }
  const packageName = externalPackageName(symbol.id);
  const qualifiedPath = qualifiedExternalReferencePath(displayText, symbol.name);
  if (!packageName || isAmbientExternalPackage(packageName)) {
    return qualifiedPath?.join(".") ?? symbol.name;
  }
  if (qualifiedPath) {
    const [importedRoot, ...members] = qualifiedPath;
    const localRoot = registerExternalImport(context, packageName, importedRoot);
    return [localRoot, ...members].join(".");
  }
  if (!isIdentifier(symbol.name) || symbol.name === "default") {
    warn(context, "external-import-unresolved", `Could not infer a named type import for external symbol ${symbol.name}.`, {
      symbolId,
    });
    return printableDisplayTextForSymbol(symbol);
  }
  const localName = registerExternalImport(context, packageName, symbol.name);
  context.localNames.set(symbolId, localName);
  return localName;
}

function registerExternalImport(
  context: RenderContext,
  packageName: string,
  importedName: string,
): string {
  const imports = context.externalImports.get(packageName) ?? new Map<string, ExternalImport>();
  const existing = imports.get(importedName);
  if (existing) return existing.localName;

  let localName = importedName;
  let suffix = 2;
  while (context.usedNames.has(localName)) localName = `${importedName}_${suffix++}`;
  context.usedNames.add(localName);
  imports.set(importedName, { importedName, localName });
  context.externalImports.set(packageName, imports);
  return localName;
}

function qualifiedExternalReferencePath(
  displayText: string | undefined,
  symbolName: string,
): string[] | undefined {
  if (!displayText) return undefined;
  const match = displayText.trim().match(
    /^([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)(?=\s*(?:<|\[|$))/,
  );
  if (!match) return undefined;
  const parts = match[1].split(".");
  return parts.at(-1) === symbolName ? parts : undefined;
}

function renderExternalImports(context: RenderContext): string[] {
  return [...context.externalImports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleName, imports]) => {
      const specifiers = [...imports.values()]
        .sort((left, right) => left.localName.localeCompare(right.localName))
        .map((item) => item.importedName === item.localName
          ? item.importedName
          : `${item.importedName} as ${item.localName}`);
      return `import type { ${specifiers.join(", ")} } from ${JSON.stringify(moduleName)};`;
    });
}

function nameForSymbol(context: RenderContext, symbolId: TypeModelSymbolRef): string {
  const existing = context.localNames.get(symbolId);
  if (existing) return existing;
  const symbol = context.model.symbols[symbolId];
  const base = safeIdentifier(symbol?.name ?? "Anonymous");
  let candidate = base;
  let suffix = 2;
  while (context.usedNames.has(candidate)) candidate = `${base}_${suffix++}`;
  context.usedNames.add(candidate);
  context.localNames.set(symbolId, candidate);
  return candidate;
}

function externalPackageName(symbolId: string): string | undefined {
  const prefix = "external:package:";
  if (!symbolId.startsWith(prefix)) return undefined;
  const remainder = symbolId.slice(prefix.length);
  const separator = remainder.indexOf(":");
  return separator < 0 ? undefined : remainder.slice(0, separator);
}

function isAmbientExternalPackage(packageName: string): boolean {
  return packageName === "typescript" || packageName.startsWith("@types/");
}

function fallbackDisplayText(context: RenderContext, type: TypeModelResolvedType): string {
  const printable = printableDisplayText(type);
  warn(context, "display-text-fallback", `Type ${type.id} used displayText because ${type.kind} cannot be rendered structurally.`, {
    typeId: type.id,
  });
  return printable ?? "unknown";
}

function printableDisplayText(type: TypeModelResolvedType): string | undefined {
  return UNPRINTABLE_TYPE_TEXT.has(type.displayText) ? undefined : type.displayText;
}

function printableDisplayTextForSymbol(symbol: TypeModelSymbol): string {
  return isIdentifier(symbol.name) ? symbol.name : "unknown";
}

function warn(
  context: RenderContext,
  code: string,
  message: string,
  references: Pick<TypeModelDeclarationDiagnostic, "symbolId" | "typeId"> = {},
): void {
  const key = `${code}:${references.symbolId ?? ""}:${references.typeId ?? ""}:${message}`;
  if (context.diagnostics.some((diagnostic) =>
    `${diagnostic.code}:${diagnostic.symbolId ?? ""}:${diagnostic.typeId ?? ""}:${diagnostic.message}` === key
  )) return;
  context.diagnostics.push({ category: "warning", code, message, ...references });
}

function safeIdentifier(name: string): string {
  if (isIdentifier(name) && name !== "default") return name;
  const normalized = name.replace(/[^A-Za-z0-9_$]/g, "_");
  const prefixed = /^[A-Za-z_$]/.test(normalized) ? normalized : `_${normalized}`;
  return prefixed && prefixed !== "default" ? prefixed : "_default";
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyName(name: string): string {
  return isIdentifier(name) || /^(?:0|[1-9]\d*)$/.test(name) ? name : JSON.stringify(name);
}

function exportName(name: string): string {
  return isIdentifier(name) || name === "default" ? name : JSON.stringify(name);
}

function escapeTemplateText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
